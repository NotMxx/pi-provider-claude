// The conversion of pi's transcript to the Anthropic messages a cold Claude Code process resumes from.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_ID } from '../../src/env.ts';
import { fingerprint, sessionFile, toAnthropic, TOOL_PREFIX } from '../../src/provider/history.ts';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: any[], extra: Record<string, unknown> = {}): any =>
  ({ role: 'assistant', api: 'claude-code-process', provider: PROVIDER_ID, model: 'claude-opus-5-5', usage, stopReason: 'toolUse', timestamp: 1, content, ...extra });

test('the tool prefix names pi\'s in-process MCP server', () => {
  assert.equal(TOOL_PREFIX, 'mcp__pi__');
});

test('thinking with its signature is kept for a process that thinks with the model that wrote it; without a signature, from another provider or model, or for a process that does not think, it is left out', () => {
  const ours = assistant([
    { type: 'thinking', thinking: 'look it up', thinkingSignature: 'sig-1' },
    { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'opaque', redacted: true },
    { type: 'text', text: 'Checking.' },
    { type: 'toolCall', id: 'call|1', name: 'read', arguments: { path: 'a' } },
  ]);
  const unsigned = assistant([{ type: 'thinking', thinking: 'no sig' }, { type: 'text', text: 'Hi.' }], { stopReason: 'stop' });
  const foreign = assistant([{ type: 'thinking', thinking: 'theirs', thinkingSignature: 'x' }, { type: 'text', text: 'Yo.' }], { provider: 'anthropic', stopReason: 'stop' });
  const messages: any[] = [
    { role: 'system', content: 'You are pi.', timestamp: 1 },
    { role: 'user', content: 'go', timestamp: 1 },
    ours,
    { role: 'toolResult', toolCallId: 'call|1', toolName: 'read', content: [{ type: 'text', text: 'A' }], isError: false, timestamp: 1 },
    unsigned,
    { role: 'user', content: 'again', timestamp: 1 },
    foreign,
  ];
  assert.deepEqual(toAnthropic(messages, { thinkingModel: 'claude-opus-5-5' }), [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'look it up', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'mcp__pi__read', input: { path: 'a' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'A' }], is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Yo.' }] },
  ]);
  const plain = toAnthropic(messages, {});
  const otherModel = toAnthropic(messages, { thinkingModel: 'claude-sonnet-5-5' });
  assert.deepEqual(otherModel, plain, 'a signature is valid only for the model that produced it');
  assert.ok(plain.every((m) => m.content.every((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')));
});

test('a failed or aborted answer is not part of the history, and the session file chains its entries', () => {
  const messages: any[] = [
    { role: 'user', content: 'a', timestamp: 1 },
    assistant([{ type: 'text', text: 'half' }], { stopReason: 'error' }),
    assistant([{ type: 'text', text: 'cut' }], { stopReason: 'aborted' }),
    { role: 'user', content: 'b', timestamp: 1 },
  ];
  const history = toAnthropic(messages, {});
  assert.deepEqual(history, [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
  const lines = sessionFile([...history, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], '/w', 'm').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].parentUuid, null);
  assert.equal(lines[1].parentUuid, lines[0].uuid);
  assert.equal(lines[1].message.stop_reason, 'end_turn');
});

test('a fingerprint ignores what pi adds around a message: signatures, usage, timestamps', () => {
  const a = assistant([{ type: 'thinking', thinking: 'x', thinkingSignature: 's1' }, { type: 'text', text: 'y' }]);
  const b = { ...assistant([{ type: 'thinking', thinking: 'x', thinkingSignature: 's2' }, { type: 'text', text: 'y' }]), timestamp: 99, usage: { ...usage, input: 5 } };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(assistant([{ type: 'text', text: 'y' }])));
});
