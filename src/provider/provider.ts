// The owner's Claude subscription as pi's `streamSimple`. To pi it is a model like any other: text, thinking and tool
// calls as pi-ai's events, usage and a stop reason in the final message. Underneath, each conversation is a warm
// `claude` process (see claude-process.ts); a tool call Claude makes is handed to pi's own agent loop, and its result,
// which arrives with the next `streamSimple`, goes back into the same process, so the prompt cache keeps working turn
// after turn. Model, effort and tools change inside the warm process; only a new leading system prompt, thinking
// switched on or off, a new output limit or the Claude Code context switch needs a new one.
//
// The system prompt is the start of every request, so a warm process keeps the one it started with. A change pi makes
// later in the conversation (a system message adding instructions, or replacing or removing a named section) goes in
// with the next user input as one `<system-reminder>` block, as Claude Code itself brings in changing context, so the
// cached prefix stays valid. Past `maxReminderChars` of reminders, a new process starts from the whole current prompt.
//
// pi-ai's request hooks on a process-backed provider: Claude Code builds and sends the HTTP request itself, so
// `onPayload` is called once per turn with what goes to Claude Code (model, prompt, tools, effort, the resumed history
// and the live input) for inspection only, and a replacement it returns is ignored; `onResponse` does not apply (no
// HTTP response reaches the extension) and is never called; `onProviderStreamEvent` is awaited for every stream-json
// event Claude Code prints, before it is normalized. The abort signal stops the turn, and only the proxy variables of
// `options.env` reach Claude Code (see `claudeEnv`).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  calculateCost, createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, parseStreamingJson,
  type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TextContent, type ThinkingContent,
  type ToolCall, type TranscriptContext,
} from '@earendil-works/pi-ai';
import { claudeEnv, PROVIDER_ID, type DataPaths } from '../env.ts';
import { readClaudeSettings, type ClaudeSettings } from '../settings.ts';
import { ClaudeProcess, type McpTool, type ToolResult } from './claude-process.ts';
import { TOOL_PREFIX, fingerprint, sessionFile, systemKey, systemReminder, toAnthropic, toolId, type Message } from './history.ts';

export interface ServiceOptions {
  paths: DataPaths;
  /** The pinned binary's path; it throws, with what the owner should do, when the binary cannot be used. */
  binary: () => Promise<string>;
  /** The extension's settings, read again for every turn (default: the settings file in `paths.data`). */
  settings?: () => ClaudeSettings;
  /** At most this many warm processes; the least recently used one is closed first (default 8). */
  maxProcesses?: number;
  /** A warm process with nothing to do is closed after this long (default 10 minutes). */
  idleMs?: number;
  /**
   * The same for a process started with no tools, a one-shot call such as a reviewer or a compaction (default 30
   * seconds). A full pool evicts these first, so they never push out a conversation's warm process.
   */
  oneShotIdleMs?: number;
  /** How the owner is warned about, and asked to accept, a turn billed to Extra Usage (see `ExtraUsageHooks`). */
  extraUsage?: ExtraUsageHooks;
  /**
   * The most characters of `<system-reminder>` blocks one warm process is sent for system prompt changes; past it, a new
   * process starts with the whole current prompt as its baseline (default 32,000).
   */
  maxReminderChars?: number;
}

/**
 * The owner's side of the usage-credit guard. `ask` returns whether the owner accepts Extra Usage for the session (false
 * when no one can be asked); `warn` shows a turn billed to Extra Usage; `allowed` holds the sessions the owner accepted
 * it for, in memory only, so a new session or a restart asks again.
 */
export interface ExtraUsageHooks {
  ask?: (session: string, message: string, signal?: AbortSignal) => Promise<boolean>;
  warn?: (message: string) => void;
  allowed?: Set<string>;
  /**
   * The sessions whose owner said no (or could not be asked): their next turns stop before anything reaches Claude
   * Code, so a host retrying on another model (Gentle Shell's fallback) is not billed again. Cleared by allow-session.
   */
  declined?: Set<string>;
}

/**
 * A tool call's arguments from Claude's JSON text: an object is kept, empty text is `{}`, and anything else is `{}`
 * with the reason. pi-ai has `parseToolCallArguments` for this, but pi 1.2.0 does not give it to extensions.
 */
export function toolArguments(json: string | undefined): { arguments: ToolCall['arguments']; argumentsError?: string } {
  if (!json?.trim()) return { arguments: {} };
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Tool arguments must be a JSON object');
    return { arguments: parsed as ToolCall['arguments'] };
  } catch (error) {
    return { arguments: {}, argumentsError: error instanceof SyntaxError ? `Tool arguments are not valid JSON: ${error.message}` : (error as Error).message };
  }
}

export interface ClaudeService {
  streamSimple(model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream;
  close(): Promise<void>;
}

/** How Claude Code names its limit windows (`rateLimitType`), as the owner reads them. */
const WINDOWS: Record<string, string> = {
  five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly', overage: 'extra usage',
};

type RateLimitInfo = { status?: string; rateLimitType?: string; resetsAt?: number; isUsingOverage?: boolean; overageInUse?: boolean };

/**
 * The error a turn ends with when the plan limit is reached: the window, and when it resets in local time. It says
 * "usage limit", which Gentle Shell's subagents read as quota and answer with their fallback model.
 */
function limitMessage(info: RateLimitInfo): string {
  const window = info.rateLimitType ? WINDOWS[info.rateLimitType] : undefined;
  let text = `Claude subscription usage limit reached${window ? ` (${window} window)` : ''}`;
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    // Seconds since the epoch; a value already in milliseconds is taken as it is.
    const at = new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    text += `; it resets at ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }
  return `${text}.`;
}

// The usage-credit guard. Claude Code's `isUsingOverage` is set only when a plan window is used up and overage is
// allowed; Anthropic's third-party Extra Usage billing shows only as `overageInUse` (the
// `anthropic-ratelimit-unified-overage-in-use` header, with `rateLimitType: "overage"`), so any of them counts. The
// `extraUsage` setting decides what happens (strict, ask, allow). Every message says "billing", which pi does not retry.
const billedToExtraUsage = (info: RateLimitInfo) =>
  info.overageInUse === true || info.isUsingOverage === true || (info.rateLimitType === 'overage' && info.status !== 'rejected');

const BILLED = 'Claude Code billing: this request was billed to Extra Usage (usage credits), not your Claude plan.';
export const EXTRA_USAGE_WARNING = 'Claude Code billing: this turn is billed to Extra Usage (usage credits), not your Claude plan.';
const strictMessage = () =>
  `${BILLED} The turn was stopped so no more requests are billed (extra usage: strict). Turn Extra Usage off at ` +
  'claude.ai/settings/usage, or change the mode with /claude-extra-usage ask or /claude-extra-usage allow.';
const declinedMessage = () =>
  `${BILLED} The turn was stopped: Extra Usage was not accepted for this session (extra usage: ask). To accept it for this ` +
  'session only, run /claude-extra-usage allow-session and try again.';
export const ASK_QUESTION = `${BILLED} Continue this pi session on Extra Usage? A yes holds for this session only.`;

/** Anthropic's refusal to bill a request it classified as Extra Usage. */
const EXTRA_USAGE_REJECTION = /out of extra usage|third-party apps now draw from your extra usage|draws? from your usage credits/i;

const classifiedMessage = (original: string) =>
  'Claude Code billing: Anthropic classified this request as Extra Usage (not plan usage) and refused it, since Extra Usage is ' +
  'off or used up. The wording of the system prompt can cause this; try /claude-context on (keep Claude Code\'s own system ' +
  `prompt) or change pi's system prompt. Original error: ${original}`;

/** pi's thinking level as Claude Code's effort, through the model's thinking-level map; none is no thinking. */
function effortOf(model: Model<string>, level?: string): string | undefined {
  if (!model.reasoning || !level || level === 'off') return undefined;
  const mapped = model.thinkingLevelMap?.[level as keyof NonNullable<Model<string>['thinkingLevelMap']>];
  if (typeof mapped === 'string') return mapped;
  return level === 'minimal' ? 'low' : level;
}

const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * A pooled process: its settings, the pi session it serves, whether it started with no tools (a one-shot call), the
 * system messages it has been given (its prompt, then those sent as reminders; `systemKey` each) and the characters of
 * reminders sent to it.
 */
type Pooled = ClaudeProcess & { configKey: string; session?: string; oneShot: boolean; system: string[]; reminded: number };
type SystemState = { messages: Message[]; keys: string[] };
type Want = { model: string; effort?: string; tools: McpTool[] };

export function openClaudeService(options: ServiceOptions): ClaudeService {
  const { paths } = options;
  const settings = options.settings ?? (() => readClaudeSettings(paths.data));
  // This pi's session files; another pi on the same data folder keeps its own.
  const runDir = join(paths.runDir, String(process.pid));
  const madeWork = new Set<string>();
  let closed = false;
  let started = false;
  const idleMs = options.idleMs ?? 10 * 60_000;
  const oneShotIdleMs = options.oneShotIdleMs ?? 30_000;
  const maxProcesses = options.maxProcesses ?? 8;
  const maxReminderChars = options.maxReminderChars ?? 32_000;
  const pool = new Set<Pooled>();
  let reap: NodeJS.Timeout | undefined;

  /** Background work starts with the first turn, never when the extension loads. */
  function start() {
    if (started) return;
    started = true;
    // Session files a dead pi left behind; a live one's are its own.
    try {
      for (const name of readdirSync(paths.runDir)) {
        const pid = /^\d+$/.test(name) ? Number(name) : undefined;
        if (pid === undefined || (pid !== process.pid && !isAlive(pid))) rmSync(join(paths.runDir, name), { recursive: true, force: true });
      }
    } catch { /* no run folder yet */ }
    // A process waiting for one of pi's tools is kept as long as the tool may take; an idle one for idleMs, or
    // oneShotIdleMs when it started with no tools.
    const expired = (p: Pooled) => Date.now() - p.lastUsed > (p.awaiting.length ? 24 * 3600_000 : p.oneShot ? oneShotIdleMs : idleMs);
    reap = setInterval(() => {
      for (const p of pool) if (!p.busy && expired(p)) { pool.delete(p); void p.stop(); }
    }, Math.min(idleMs, oneShotIdleMs, 60_000));
    reap.unref();
  }

  function streamSimple(model: Model<string>, context: TranscriptContext, opts: SimpleStreamOptions = {}): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'pending', timestamp: Date.now(),
    };
    void run(model, context, opts, stream, output);
    return stream;
  }

  async function run(model: Model<string>, context: TranscriptContext, opts: SimpleStreamOptions, stream: AssistantMessageEventStream, output: AssistantMessage) {
    const signal = opts.signal;
    let proc: Pooled | undefined;
    try {
      if (closed) throw new Error(`${PROVIDER_ID} provider is closed`);
      if (model.provider !== PROVIDER_ID) throw new Error(`this extension serves ${PROVIDER_ID}, not ${model.provider}`);
      signal?.throwIfAborted();
      start();
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      // The JSON round trip drops what is not part of a tool's schema on the wire (TypeBox's symbol keys).
      const tools: McpTool[] = getCurrentTools(context.messages).map((t) => ({ name: t.name, description: t.description, inputSchema: JSON.parse(JSON.stringify(t.parameters ?? {})) }));
      const conversation = context.messages.filter((m) => m.role !== 'system') as unknown as Message[];
      const effort = effortOf(model, opts.reasoning);
      const maxTokens = opts.maxTokens;
      const want: Want = { model: model.id, effort, tools };
      const current = settings();
      // The system prompt is not part of it: a warm process takes later system messages as reminders.
      const configKey = createHash('sha256').update(JSON.stringify([Boolean(effort), maxTokens, current.claudeCodeContext])).digest('hex');
      const systemMessages = context.messages.filter((m) => m.role === 'system') as unknown as Message[];
      const system: SystemState = { messages: systemMessages, keys: systemMessages.map(systemKey) };
      const fps = conversation.map(fingerprint);
      // A session that declined Extra Usage is not sent again (on any model) until it is accepted for the session.
      const sessionKey = opts.sessionId ?? `conversation:${fps[0] ?? 'empty'}`;
      const hooks = options.extraUsage ?? {};
      if (current.extraUsage === 'ask' && hooks.declined?.has(sessionKey) && !hooks.allowed?.has(sessionKey)) throw new Error(declinedMessage());
      const payload = (input: unknown, history?: unknown) => opts.onPayload?.({
        model: model.id, systemPrompt, claudeCodeContext: current.claudeCodeContext, effort, maxTokens, tools, ...(history ? { history } : {}), input,
      }, model);

      proc = await continueWarm(configKey, want, system, conversation, fps, payload);
      if (!proc) {
        const claudePath = await options.binary();
        if (closed) throw new Error(`${PROVIDER_ID} provider is closed`);
        signal?.throwIfAborted();
        // A new process gets the conversation as a native session file, in a working folder kept per conversation.
        const cwd = join(paths.workDir, createHash('sha256').update(opts.sessionId ?? fps[0] ?? 'empty').digest('hex').slice(0, 16));
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
        madeWork.add(cwd);
        // The newest user message goes in live, as in a warm process; a history that ends in tool results is
        // continued with an empty trigger, the only way Claude Code takes them.
        const last = conversation.at(-1);
        const history = toAnthropic(last?.role === 'user' ? conversation.slice(0, -1) : conversation, { thinkingModel: effort ? model.id : undefined });
        const live = last?.role === 'user' ? toAnthropic([last])[0]?.content ?? [] : [];
        await payload(live, history);
        proc = Object.assign(new ClaudeProcess({
          claudePath, env: claudeEnv(paths, maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) } : {}, { ...process.env, ...opts.env }),
          model: model.id, systemPrompt, claudeCodeContext: current.claudeCodeContext, tools, effort, cwd, runDir,
          session: history.length ? sessionFile(history, cwd, model.id) : undefined,
        }), { configKey, session: opts.sessionId, oneShot: tools.length === 0, system: system.keys, reminded: 0 });
        const spawned = proc;
        void spawned.exited.then(() => pool.delete(spawned));
        // This session's conversation went somewhere its idle processes cannot follow (a compaction, a branch): they
        // would never be continued. Only those with the same settings and leading prompt: a reviewer or compaction call
        // of the same session has its own system prompt and must not end the conversation's warm process.
        if (opts.sessionId !== undefined) {
          for (const p of pool) {
            if (p.session === opts.sessionId && p.configKey === configKey && p.system[0] === spawned.system[0]
              && !p.busy && !p.awaiting.length) { pool.delete(p); void p.stop(); }
          }
        }
        if (pool.size >= maxProcesses) {
          // One-shot processes first, then the least recently used, and one that waits for a tool only when nothing
          // else can go.
          const idle = [...pool].filter((p) => !p.busy).sort((a, b) => Number(a.awaiting.length > 0) - Number(b.awaiting.length > 0)
            || Number(b.oneShot) - Number(a.oneShot) || a.lastUsed - b.lastUsed)[0];
          if (idle) { pool.delete(idle); void idle.stop(); }
        }
        pool.add(proc);
        proc.busy = true;
        await proc.ready;
        proc.send(live);
      }
      proc.seen = fps;
      // The request is set up: Claude Code has the input.
      stream.push({ type: 'start', partial: output });
      await consume(proc, model, output, stream, opts, current, sessionKey);
      proc.seen.push(fingerprint(output as unknown as Message));
      proc.awaiting = output.stopReason === 'toolUse'
        ? output.content.flatMap((c) => c.type === 'toolCall' ? [{ id: toolId(c.id), name: c.name, args: c.arguments }] : []) : [];
      proc.busy = false;
      proc.lastUsed = Date.now();
      stream.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output });
      stream.end();
    } catch (e) {
      // An abort lets Claude Code exit on its own; anything else is not trusted to.
      if (proc) { pool.delete(proc); if (signal?.aborted) void proc.stop(); else proc.kill(); }
      output.stopReason = signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = signal?.aborted ? 'Request was aborted' : e instanceof Error ? e.message : String(e);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  }

  /**
   * A warm process that has seen everything but the newest input, and is in a state to take it. Its system messages
   * must be the first of the current ones; the others go in with the next user input as a reminder (after tool results,
   * which reach Claude Code as answers to its calls, they wait for that input).
   */
  async function continueWarm(configKey: string, want: Want, system: SystemState, conversation: Message[], fps: string[], payload: (input: unknown) => unknown) {
    for (const p of pool) {
      if (!p.alive) { pool.delete(p); continue; }
      if (p.busy || p.seen.length >= fps.length) continue;
      if (!p.seen.every((f, i) => f === fps[i])) continue;
      const rest = conversation.slice(p.seen.length);
      const fits = p.configKey === configKey && p.system.length <= system.keys.length && p.system.every((k, i) => k === system.keys[i]);
      if (fits && p.awaiting.length && rest.every((m) => m?.role === 'toolResult')) {
        const results = new Map<string, ToolResult>(rest.map((m: any) => [toolId(m.toolCallId), m as ToolResult]));
        if (p.awaiting.every((a) => results.has(a.id))) {
          p.busy = true;
          await updateOrRetire(p, want);
          await payload(rest.map((m: any) => ({ type: 'tool_result', tool_use_id: toolId(m.toolCallId) })));
          p.deliver(results);
          return p;
        }
      }
      // New user messages, one or several at once (pi can add a note or a background agent's wake beside the prompt):
      // they go in as one input, in order, as the history conversion merges consecutive user messages.
      // A system prompt change since its last input goes first, as a reminder, while the reminders stay within the cap.
      const reminder = fits ? systemReminder(system.messages.slice(p.system.length)) : '';
      if (fits && !p.awaiting.length && rest.length && rest.every((m) => m?.role === 'user') && p.reminded + reminder.length <= maxReminderChars) {
        p.busy = true;
        await updateOrRetire(p, want);
        const input = [...(reminder ? [{ type: 'text', text: reminder }] : []), ...(toAnthropic(rest)[0]?.content ?? [])];
        await payload(input);
        p.send(input);
        p.system = system.keys;
        p.reminded += reminder.length;
        return p;
      }
      // The conversation went on past what this process can take (a message pi added after the tool results, a new
      // leading prompt or setting, too many reminders): a new process resumes it, and this one would never be continued.
      pool.delete(p);
      void p.stop();
    }
    return undefined;
  }

  /** A refused hot change (a model not on the plan, a dead process) retires the process instead of leaving it busy. */
  async function updateOrRetire(p: Pooled, want: Want) {
    try {
      await p.update(want);
    } catch (e) {
      pool.delete(p);
      void p.stop();
      throw e;
    }
  }

  /** Reads one API response from the process and streams it into `output` as pi-ai's events. */
  /** What the `extraUsage` setting says for a turn billed to Extra Usage: go on (with a warning) or throw. */
  async function guardExtraUsage(current: ClaudeSettings, session: string, signal?: AbortSignal) {
    const hooks = options.extraUsage ?? {};
    if (current.extraUsage === 'strict') throw new Error(strictMessage());
    if (current.extraUsage === 'ask' && !hooks.allowed?.has(session)) {
      // Claude Code keeps streaming while the owner decides; its events wait in the queue.
      const yes = await (hooks.ask?.(session, ASK_QUESTION, signal) ?? Promise.resolve(false)).catch(() => false);
      // A turn aborted while the owner decided ends aborted, and a late yes allows nothing.
      signal?.throwIfAborted();
      if (!yes) { hooks.declined?.add(session); throw new Error(declinedMessage()); }
      hooks.allowed?.add(session);
    }
    hooks.warn?.(EXTRA_USAGE_WARNING);
  }

  async function consume(proc: ClaudeProcess, model: Model<string>, output: AssistantMessage, stream: AssistantMessageEventStream,
    opts: SimpleStreamOptions, current: ClaudeSettings, session: string): Promise<void> {
    const signal = opts.signal;
    // Anthropic block index → the block in `output.content`; a tool call keeps its arguments' JSON text.
    const open = new Map<number, { index: number; json?: string }>();
    // A rejected rate-limit notice comes just before the error result that ends a turn over the plan limit.
    let limit: RateLimitInfo | undefined;
    const usage = output.usage;
    const total = () => {
      usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      // The models cost 0 (a subscription), so this stays 0 unless the owner gives them a price in models.json.
      calculateCost(model, usage);
    };
    const onAbort = () => { void proc.stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const e = await proc.next(signal);
        if (e === undefined) throw new Error('the claude process ended before the response finished');
        if (e.type === 'exit') throw new Error(`claude exited with ${e.code}: ${String(e.stderr).trim().slice(-500)}`);
        await opts.onProviderStreamEvent?.(e, model);
        // Claude Code keeps streaming into the queue while a hook or the guard is awaited, so an abort meanwhile must
        // end the turn here: the queued events would otherwise finish it as done.
        signal?.throwIfAborted();
        if (e.type === 'result' && e.is_error) {
          if (limit) throw new Error(limitMessage(limit));
          const text = String(e.result ?? ((e.errors ?? []).join('; ') || e.subtype));
          if (EXTRA_USAGE_REJECTION.test(text)) throw new Error(classifiedMessage(text));
          throw new Error(`claude: ${text}`);
        }
        if (e.type === 'rate_limit_event') {
          const info: RateLimitInfo = e.rate_limit_info ?? {};
          if (billedToExtraUsage(info)) {
            await guardExtraUsage(current, session, signal);
            signal?.throwIfAborted();
          }
          limit = info.status === 'rejected' ? info : undefined;
          continue;
        }
        if (e.type !== 'stream_event') continue;
        const ev = e.event ?? {};
        if (ev.type === 'message_start') {
          if (ev.message?.id) output.responseId = String(ev.message.id);
          if (ev.message?.model && ev.message.model !== model.id) output.responseModel = String(ev.message.model);
          applyUsage(usage, ev.message?.usage);
          total();
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block ?? {};
          const index = output.content.length;
          if (b.type === 'text') {
            output.content.push({ type: 'text', text: '' });
            open.set(ev.index, { index });
            stream.push({ type: 'text_start', contentIndex: index, partial: output });
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            output.content.push(b.type === 'thinking' ? { type: 'thinking', thinking: '', thinkingSignature: String(b.signature ?? '') }
              : { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: String(b.data ?? ''), redacted: true });
            open.set(ev.index, { index });
            stream.push({ type: 'thinking_start', contentIndex: index, partial: output });
          } else if (b.type === 'tool_use') {
            const name = String(b.name).startsWith(TOOL_PREFIX) ? String(b.name).slice(TOOL_PREFIX.length) : String(b.name);
            output.content.push({ type: 'toolCall', id: String(b.id), name, arguments: {} });
            open.set(ev.index, { index, json: '' });
            stream.push({ type: 'toolcall_start', contentIndex: index, partial: output });
          }
        } else if (ev.type === 'content_block_delta') {
          const at = open.get(ev.index);
          if (!at) continue;
          const block = output.content[at.index]!;
          const d = ev.delta ?? {};
          if (block.type === 'text' && d.type === 'text_delta' && typeof d.text === 'string') {
            (block as TextContent).text += d.text;
            stream.push({ type: 'text_delta', contentIndex: at.index, delta: d.text, partial: output });
          } else if (block.type === 'thinking' && d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            (block as ThinkingContent).thinking += d.thinking;
            stream.push({ type: 'thinking_delta', contentIndex: at.index, delta: d.thinking, partial: output });
          } else if (block.type === 'thinking' && d.type === 'signature_delta') {
            (block as ThinkingContent).thinkingSignature = ((block as ThinkingContent).thinkingSignature ?? '') + String(d.signature ?? '');
          } else if (block.type === 'toolCall' && d.type === 'input_json_delta') {
            const piece = String(d.partial_json ?? '');
            at.json += piece;
            (block as ToolCall).arguments = parseStreamingJson(at.json) as ToolCall['arguments'];
            stream.push({ type: 'toolcall_delta', contentIndex: at.index, delta: piece, partial: output });
          }
        } else if (ev.type === 'content_block_stop') {
          const at = open.get(ev.index);
          open.delete(ev.index);
          if (!at) continue;
          const block = output.content[at.index]!;
          if (block.type === 'text') stream.push({ type: 'text_end', contentIndex: at.index, content: block.text, partial: output });
          else if (block.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: at.index, content: block.thinking, partial: output });
          else {
            // Valid parsed arguments by toolcall_end; text that is not a JSON object leaves `{}` and says why.
            const parsed = toolArguments(at.json);
            block.arguments = parsed.arguments;
            if (parsed.argumentsError) block.argumentsError = parsed.argumentsError;
            stream.push({ type: 'toolcall_end', contentIndex: at.index, toolCall: block, partial: output });
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) output.rawStopReason = String(ev.delta.stop_reason);
          applyUsage(usage, ev.usage);
          total();
        } else if (ev.type === 'message_stop') {
          // As pi-ai's Anthropic provider maps them; a refusal or an unknown reason is an error, and the process goes.
          const raw = output.rawStopReason;
          if (raw === 'refusal') throw new Error('The model refused to complete the request');
          if (raw === 'sensitive') throw new Error('Provider stopped with: sensitive');
          if (!['end_turn', 'pause_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(String(raw))) throw new Error(`Unhandled stop reason: ${raw}`);
          output.stopReason = raw === 'tool_use' ? 'toolUse' : raw === 'max_tokens' ? 'length' : 'stop';
          return;
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    streamSimple,
    async close() {
      closed = true;
      if (reap) clearInterval(reap);
      await Promise.all([...pool].map((p) => p.stop()));
      pool.clear();
      // The empty working folders this pi made; a later service recreates the same ones, so the prompt (and its cache)
      // is unchanged.
      for (const dir of madeWork) rmSync(dir, { recursive: true, force: true });
      madeWork.clear();
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

/** Anthropic's usage counters, as pi-ai counts them; Claude Code reports cumulative values on each event. */
function applyUsage(usage: AssistantMessage['usage'], u: any) {
  if (!u) return;
  if (u.input_tokens != null) usage.input = u.input_tokens;
  if (u.output_tokens != null) usage.output = u.output_tokens;
  if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
  if (u.cache_creation?.ephemeral_1h_input_tokens != null) usage.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens;
  if (u.output_tokens_details?.thinking_tokens != null) usage.reasoning = u.output_tokens_details.thinking_tokens;
}
