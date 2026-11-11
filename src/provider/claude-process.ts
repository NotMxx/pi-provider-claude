// One warm `claude -p` process: the pinned binary, signed in with the owner's own login in the extension's own Claude
// Code folder, with everything of Claude Code's own switched off (its built-in tools too). It is only the transport to
// the subscription.
//
// pi's tools reach it as an in-process ("sdk") MCP server, the mechanism the Agent SDK uses: Claude Code sends each MCP
// message to the extension as a control request on its stdout, and the extension answers on its stdin. A tool call is
// answered only when pi's own agent loop has run the tool, so the call waits as long as that takes. No extra process,
// socket, proxy or secret.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { canonical, userBlocks, type ImagePart, type TextPart } from './history.ts';

export type McpTool = { name: string; description: string; inputSchema: unknown };
export type ToolResult = { content: string | Array<TextPart | ImagePart>; isError?: boolean };

export interface ClaudeLaunch {
  claudePath: string;
  /** The whole environment of the process (see `claudeEnv`): nothing else of pi's reaches it. */
  env: Record<string, string>;
  model: string;
  systemPrompt: string;
  /** Keep Claude Code's own system prompt and add `systemPrompt` to it, instead of replacing it. */
  claudeCodeContext?: boolean;
  tools: McpTool[];
  /** `low` … `max`, or undefined for no thinking. */
  effort?: string;
  /** A Claude Code session file to resume from, or undefined for an empty conversation. */
  session?: string;
  /** The working folder: empty, and the same for one conversation, because Claude Code's context depends on it. */
  cwd: string;
  /** Where the private folder for the session file goes. */
  runDir: string;
}

export const SERVER = 'pi';
type Held = { name: string; args: unknown; reply: (result: { content: unknown[]; isError: boolean }) => void };

export class ClaudeProcess {
  readonly child: ChildProcess;
  /** Fingerprints of every message this process has seen or produced, in order. */
  seen: string[] = [];
  /** Tool calls from the last assistant message that pi has not answered yet, in order. */
  awaiting: Array<{ id: string; name: string; args: unknown }> = [];
  busy = false;
  exited: Promise<number | null>;
  lastUsed = Date.now();
  model: string;
  effort?: string;
  /** How long `stop` waits for Claude Code to exit on its own before a kill. */
  graceMs = 10_000;
  readonly ready: Promise<void>;

  private tools: McpTool[];
  private dir?: string;
  private events: any[] = [];
  private wake?: () => void;
  private closed = false;
  private calls: Held[] = [];
  private results = new Map<string, ToolResult>();
  private requests = new Map<string, (response: any) => void>();
  private nextRequest = 0;

  constructor(launch: ClaudeLaunch) {
    this.tools = launch.tools;
    this.model = launch.model;
    this.effort = launch.effort;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
      '--mcp-config', JSON.stringify({ mcpServers: { [SERVER]: { type: 'sdk', name: SERVER } } }),
      // Every tool of pi's server, including ones added later in the conversation.
      '--allowedTools', `mcp__${SERVER}`,
      '--model', launch.model, '--system-prompt-snapshot', 'off'];
    if (launch.effort) args.push('--effort', launch.effort, '--thinking-display', 'summarized');
    else args.push('--thinking=disabled');
    if (launch.session !== undefined) {
      mkdirSync(launch.runDir, { recursive: true, mode: 0o700 });
      this.dir = mkdtempSync(join(launch.runDir, 'session-')); // mode 0700
      const file = join(this.dir, 'session.jsonl');
      writeFileSync(file, launch.session, { mode: 0o600 });
      args.push('--resume', file);
    }

    this.child = spawn(launch.claudePath, args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    this.child.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    this.child.stdin!.on('error', () => { /* reported through the exit */ });
    // `exit`, not `close`: anything the binary left behind may hold the inherited pipes open. A binary that cannot be
    // started (missing, not executable) emits `error` instead, and may or may not emit `exit` after it; the first ends
    // the process, so that request fails and pi keeps running.
    this.exited = new Promise((resolve) => {
      let finished = false;
      const finish = (code: number | null, reason: string | null) => {
        if (finished) return;
        finished = true;
        setImmediate(() => {
          const why = code || reason;
          if (why) this.events.push({ type: 'exit', code: why, stderr });
          this.closed = true;
          for (const r of this.requests.values()) r({ subtype: 'error', error: why ? `claude exited with ${why}` : 'claude exited' });
          this.requests.clear();
          this.wake?.();
          if (this.dir) rmSync(this.dir, { recursive: true, force: true });
          resolve(code);
        });
      };
      this.child.on('exit', (code, sig) => finish(code, sig));
      this.child.on('error', (error: NodeJS.ErrnoException) => {
        // An error after a start (a failed kill) leaves the process running; only a failed start ends it.
        if (this.child.pid === undefined) finish(null, error.code ?? error.message);
      });
    });
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      if (!line.trim()) return;
      let e: any;
      try { e = JSON.parse(line); } catch { e = { type: 'unparsed', line }; }
      if (e?.type === 'control_response') {
        const resolve = this.requests.get(e.response?.request_id);
        this.requests.delete(e.response?.request_id);
        resolve?.(e.response);
      } else if (e?.type === 'control_request') {
        this.answerControl(e);
      } else {
        this.events.push(e);
        this.wake?.();
      }
    });
    const prompt = launch.claudeCodeContext ? { appendSystemPrompt: launch.systemPrompt } : { systemPrompt: [launch.systemPrompt] };
    this.ready = this.request({ subtype: 'initialize', sdkMcpServers: [SERVER], ...prompt }).then((r) => {
      if (r.subtype !== 'success') throw new Error(`claude refused to start: ${r.error}`);
    });
    this.ready.catch(() => {});
  }

  private write(o: unknown) {
    if (!this.closed) this.child.stdin!.write(JSON.stringify(o) + '\n');
  }

  /** A control request to Claude Code, resolved with its control response. */
  request(request: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.resolve({ subtype: 'error', error: 'claude exited' });
    const id = `pi-${++this.nextRequest}`;
    return new Promise((resolve) => {
      this.requests.set(id, resolve);
      this.write({ type: 'control_request', request_id: id, request });
    });
  }

  /** Claude Code asking the extension something: only messages for pi's MCP server are answered. */
  private answerControl(e: any) {
    const respond = (response: unknown) => this.write({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response } });
    if (e.request?.subtype !== 'mcp_message' || e.request.server_name !== SERVER) {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: e.request_id, error: `pi does not handle ${e.request?.subtype}` } });
      return;
    }
    const m = e.request.message ?? {};
    if (m.method === 'initialize') {
      respond({ mcp_response: { jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: SERVER, version: '1' },
      } } });
    } else if (m.method === 'tools/list') {
      respond({ mcp_response: { jsonrpc: '2.0', id: m.id, result: { tools: this.tools } } });
    } else if (m.method === 'tools/call') {
      this.calls.push({ name: m.params?.name, args: m.params?.arguments ?? {}, reply: (r) => respond({ mcp_response: { jsonrpc: '2.0', id: m.id, result: r } }) });
      this.answer();
    } else {
      respond({ mcp_response: { jsonrpc: '2.0', id: m.id ?? 0, result: {} } });
    }
  }

  /** Writes one stream-json user message; empty content is the trigger that continues a resumed conversation. */
  send(content: unknown[]) {
    this.write({ type: 'user', message: { role: 'user', content } });
  }

  /** Changes the model, the effort or the tool set without a new process; Claude Code keeps the conversation. */
  async update(next: { model: string; effort?: string; tools: McpTool[] }) {
    if (next.model !== this.model) {
      const r = await this.request({ subtype: 'set_model', model: next.model });
      if (r.subtype !== 'success') throw new Error(`could not switch model: ${r.error}`);
      this.model = next.model;
    }
    if (next.effort !== this.effort) {
      const r = await this.request({ subtype: 'apply_flag_settings', settings: { effortLevel: next.effort } });
      if (r.subtype !== 'success') throw new Error(`could not change effort: ${r.error}`);
      this.effort = next.effort;
    }
    if (JSON.stringify(next.tools) !== JSON.stringify(this.tools)) {
      this.tools = next.tools;
      const r = await this.request({ subtype: 'mcp_message', server_name: SERVER, message: { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } });
      if (r.subtype !== 'success') throw new Error(`could not update tools: ${r.error}`);
    }
  }

  /** pi ran the tools; their results answer the held calls in the order Claude asked for them. */
  deliver(results: Map<string, ToolResult>) {
    for (const [id, r] of results) this.results.set(id, r);
    this.answer();
  }

  /**
   * Answers each held call with the result of the tool call it is: same name and arguments, the first such one in
   * Claude's order. Claude Code calls them one at a time, in order, today; matching does not depend on it.
   */
  private answer() {
    for (let i = 0; i < this.calls.length;) {
      const call = this.calls[i];
      const index = this.awaiting.findIndex((a) => a.name === call.name && canonical(a.args) === canonical(call.args));
      // A call can arrive before the provider has recorded what it waits for; it is held until then.
      if (index < 0 && !this.awaiting.length) { i++; continue; }
      if (index < 0) {
        this.calls.splice(i, 1);
        call.reply({ content: [{ type: 'text', text: `pi has no pending call ${call.name} with these arguments` }], isError: true });
        continue;
      }
      const expected = this.awaiting[index];
      if (!this.results.has(expected.id)) { i++; continue; }
      this.calls.splice(i, 1);
      this.awaiting.splice(index, 1);
      const result = this.results.get(expected.id)!;
      this.results.delete(expected.id);
      // MCP content: text as it is, an image as base64 with its type.
      const content = userBlocks(result.content).map((b: any) => b.type === 'text' ? b : { type: 'image', data: b.source.data, mimeType: b.source.media_type });
      call.reply({ content, isError: result.isError === true });
    }
  }

  /** The next stream-json event, or undefined once the process is gone. */
  async next(signal?: AbortSignal): Promise<any> {
    for (;;) {
      if (this.events.length) return this.events.shift();
      if (this.closed) return undefined;
      signal?.throwIfAborted();
      const onAbort = () => this.wake?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await new Promise<void>((resolve) => { this.wake = resolve; });
      } finally {
        signal?.removeEventListener('abort', onAbort);
        this.wake = undefined;
      }
    }
  }

  /** Asks Claude Code to stop the turn and exit; it gets time to clean up after itself before a kill. */
  async stop() {
    if (this.closed) return;
    void this.request({ subtype: 'interrupt' });
    this.child.stdin!.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), this.graceMs);
    await this.exited;
    clearTimeout(timer);
  }

  kill() {
    if (!this.closed) this.child.kill('SIGKILL');
  }

  get alive() {
    return !this.closed;
  }
}
