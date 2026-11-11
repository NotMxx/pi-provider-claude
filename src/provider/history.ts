// pi's transcript in the shape Claude Code keeps its own sessions in: Anthropic messages, one per line, chained by
// uuid. A new `claude` process resumes from such a file, so it sees real tool_use and tool_result blocks rather than a
// text summary.
//
// Thinking: pi keeps `thinkingSignature` on the
// thinking blocks this provider streams, so a thinking block goes back in with its signature when the process that
// resumes thinks and runs the model that wrote it, as pi-ai's own Anthropic provider does: a signature is valid only for
// the model that produced it, and a process without thinking takes none. Anthropic requires the thinking of an
// unfinished tool-use turn when thinking is on, so a cold resume mid-tool now keeps it.
import { randomUUID } from 'node:crypto';
import { CLAUDE_CODE_VERSION, PROVIDER_ID } from '../env.ts';

/** Claude Code names an MCP tool `mcp__<server>__<tool>`; the bridge's server is `pi`. */
export const TOOL_PREFIX = 'mcp__pi__';

// The parts of pi-ai's messages this provider reads (pi-ai's `Message`, read defensively).
export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image'; data: string; mimeType: string };
export type ThinkingPart = { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean };
export type ToolCallPart = { type: 'toolCall'; id: string; name: string; arguments: unknown };
export type AssistantPart = TextPart | ThinkingPart | ToolCallPart;
export type Message =
  | { role: 'system'; content?: unknown; sections?: Record<string, string | null> }
  | { role: 'user'; content: string | Array<TextPart | ImagePart> }
  | { role: 'assistant'; content: AssistantPart[]; stopReason?: string; provider?: string; model?: string }
  | { role: 'toolResult'; toolCallId: string; content: string | Array<TextPart | ImagePart>; isError?: boolean };

type Block = Record<string, unknown>;
export type AnthropicMessage = { role: 'user' | 'assistant'; content: Block[] };

/** Anthropic accepts tool ids made of letters, digits, `_` and `-`; other providers' ids are mapped the same way every time. */
export const toolId = (id: string) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

/** An answer that failed or was aborted is not part of the conversation Claude continues. */
const failed = (m: Message) => m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted');

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);

export function userBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return list<any>(content).flatMap((c): Block[] => c?.type === 'text' ? [{ type: 'text', text: String(c.text) }]
    : c?.type === 'image' ? [{ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }] : []);
}

export interface HistoryOptions {
  /** The model of a process that thinks; its own signed thinking blocks go back in. Undefined: no thinking. */
  thinkingModel?: string;
}

function assistantBlocks(m: Extract<Message, { role: 'assistant' }>, options: HistoryOptions): Block[] {
  const keepThinking = options.thinkingModel !== undefined && m.provider === PROVIDER_ID && m.model === options.thinkingModel;
  return list<AssistantPart>(m.content).flatMap((c): Block[] => {
    if (c?.type === 'text') return c.text ? [{ type: 'text', text: c.text }] : [];
    if (c?.type === 'toolCall') return [{ type: 'tool_use', id: toolId(c.id), name: TOOL_PREFIX + c.name, input: c.arguments ?? {} }];
    if (c?.type === 'thinking' && keepThinking && c.thinkingSignature) {
      return [c.redacted ? { type: 'redacted_thinking', data: c.thinkingSignature } : { type: 'thinking', thinking: c.thinking, signature: c.thinkingSignature }];
    }
    return [];
  });
}

/** Converts pi's messages to alternating Anthropic messages; system messages are carried by the system prompt instead. */
export function toAnthropic(messages: Message[], options: HistoryOptions = {}): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m?.role === 'user') push('user', userBlocks(m.content));
    else if (m?.role === 'toolResult') {
      push('user', [{ type: 'tool_result', tool_use_id: toolId(m.toolCallId), content: userBlocks(m.content), is_error: m.isError === true }]);
    } else if (m?.role === 'assistant' && !failed(m)) push('assistant', assistantBlocks(m, options));
  }
  return out;
}

/** A Claude Code session file holding `messages`, for `claude --resume <path>`. */
export function sessionFile(messages: AnthropicMessage[], cwd: string, model: string): string {
  const sessionId = randomUUID();
  let parentUuid: string | null = null;
  return messages.map((message, i) => {
    const uuid = randomUUID();
    const entry = {
      parentUuid, isSidechain: false, userType: 'external', cwd, sessionId, version: CLAUDE_CODE_VERSION,
      type: message.role, uuid, timestamp: new Date(0).toISOString(),
      message: message.role === 'user' ? message : {
        id: `msg_pi_${i}`, type: 'message', role: 'assistant', model, content: message.content,
        stop_reason: message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    parentUuid = uuid;
    return JSON.stringify(entry);
  }).join('\n') + '\n';
}

/** JSON with object keys sorted, so two equal objects compare equal whatever their key order. */
export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/**
 * What a message says, without what pi adds around it (timestamps, usage, signatures). An answer is read as a run of
 * blocks: consecutive text or thinking makes one block, and empty ones are none. Two transcripts with the same
 * fingerprints are the same conversation, so a warm process that has seen one can continue the other.
 */
export function fingerprint(m: Message): string {
  if (m?.role === 'user') return canonical(['u', m.content]);
  if (m?.role === 'toolResult') return canonical(['r', m.toolCallId, m.content, m.isError === true]);
  if (m?.role === 'assistant') {
    const parts: unknown[][] = [];
    for (const c of list<any>(m.content)) {
      if (c?.type === 'toolCall') { parts.push(['c', c.id, c.name, c.arguments ?? {}]); continue; }
      const kind = c?.type === 'text' ? 't' : c?.type === 'thinking' ? 'k' : undefined;
      const text = String((kind === 't' ? c.text : c?.thinking) ?? '');
      if (!kind || !text) continue;
      const last = parts.at(-1);
      if (last?.[0] === kind) last[1] = String(last[1]) + text;
      else parts.push([kind, text]);
    }
    return canonical(['a', failed(m) ? 'failed' : '', parts]);
  }
  return canonical(['s', (m as { content?: unknown })?.content]);
}

/** What a system message says to the model (its text and sections); its tool changes reach Claude Code on their own. */
export const systemKey = (m: Message): string =>
  canonical(['s', (m as { content?: unknown }).content ?? '', (m as { sections?: unknown }).sections ?? {}]);

const contentText = (content: unknown) =>
  typeof content === 'string' ? content : list<any>(content).filter((c) => c?.type === 'text').map((c) => String(c.text)).join('\n');

/**
 * A later system message as pi-ai renders it for a model that takes system messages mid-conversation
 * (`renderSystemMessageUpdate`): its instructions, then each section it replaces or removes, named. A copy, so the
 * extension does not depend on pi-ai giving extensions that helper (pi 0.99.1 is the oldest pi supported).
 */
export function renderSystemUpdate(m: Message): string {
  const parts: string[] = [];
  const text = contentText((m as { content?: unknown }).content);
  if (text.length > 0) parts.push(text);
  for (const [name, value] of Object.entries((m as { sections?: Record<string, string | null> }).sections ?? {})) {
    parts.push(value === null ? `Removed system prompt section "${name}".` : `Updated system prompt section "${name}":\n\n${value}`);
  }
  return parts.join('\n\n');
}

/**
 * Later system messages as one `<system-reminder>` block, the way Claude Code itself brings changing context into a
 * conversation whose system prompt stays fixed; empty when they say nothing (tool changes only).
 */
export function systemReminder(messages: Message[]): string {
  const text = messages.map(renderSystemUpdate).filter((t) => t.length > 0).join('\n\n');
  return text ? `<system-reminder>\n${text}\n</system-reminder>` : '';
}
