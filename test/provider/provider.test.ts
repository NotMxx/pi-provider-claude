// The provider against a scripted stand-in for the `claude` binary (test/fixtures/fake-claude.mjs), which drives the
// real MCP bridge. No network and no real Claude login are used. Requests go in as pi-ai hands them to a provider
// (a normalized TranscriptContext), and each answer is pi's own final AssistantMessage, which the next request's
// transcript carries, as pi's agent loop does.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { normalizeContext, type AssistantMessageEvent, type Message, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { CLAUDE_CODE_VERSION, dataPaths, PROVIDER_ID } from '../../src/env.ts';
import { claudeModel } from '../../src/models.ts';
import { writeClaudeSettings, type ClaudeSettings } from '../../src/settings.ts';
import { ASK_QUESTION, EXTRA_USAGE_WARNING, openClaudeService, type ExtraUsageHooks } from '../../src/provider/provider.ts';

/** Every case fails within 15 s instead of hanging the run. */
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { timeout: 15_000 }, fn);

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type Options = { binary?: string; settings?: () => ClaudeSettings; maxProcesses?: number; idleMs?: number; oneShotIdleMs?: number; extraUsage?: ExtraUsageHooks };

/** A service whose `claude` is the fake, following `script`; `log()` returns what the fake was given. */
function setup(script: unknown[], options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ppc-provider-'));
  roots.push(root);
  const paths = dataPaths(join(root, 'data'));
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, 'script.json'), JSON.stringify(script));
  const binary = options.binary ?? FAKE;
  const service = openClaudeService({ paths, binary: async () => binary, settings: options.settings, maxProcesses: options.maxProcesses, idleMs: options.idleMs, oneShotIdleMs: options.oneShotIdleMs, extraUsage: options.extraUsage });
  const logFile = join(paths.configDir, 'log.jsonl');
  const log = (): any[] => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { root, paths, service, log };
}
type Env = ReturnType<typeof setup>;

const tools = [
  { name: 'read_note', description: 'Read a note.', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'get_weather', description: 'Weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
];
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: Date.now() });
const result = (id: string, name: string, text: string): Message =>
  ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: Date.now() });

type Extra = { model?: string; systemPrompt?: string; tools?: typeof tools } & SimpleStreamOptions;

/** One streamSimple; returns pi's final message, the events, and their types in order. */
async function step(env: Env, messages: Message[], extra: Extra = {}) {
  const { model = 'claude-haiku-5-5', systemPrompt = 'You are pi.', tools: toolList = tools, ...options } = extra;
  const context = normalizeContext({ systemPrompt, messages, tools: toolList });
  const stream = env.service.streamSimple(claudeModel(model)!, context, { sessionId: 's1', ...options });
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  const msg = await stream.result();
  return { msg, events, kinds: events.map((e) => e.type), done: events.at(-1)! };
}

const toolCalls = (events: AssistantMessageEvent[]) => events.flatMap((e) => e.type === 'toolcall_end' ? [e.toolCall] : []);

test('a tool call is handed to pi, and its result goes back into the same warm process', async () => {
  const env = setup([{ steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'groceries' } }] }, { text: 'Mango.' }, { text: 'You are welcome.' }] }]);
  try {
    const messages: Message[] = [user('Fruit on my note?')];
    const first = await step(env, messages);
    assert.equal(first.msg.stopReason, 'toolUse');
    assert.deepEqual(first.kinds, ['start', 'toolcall_start', 'toolcall_delta', 'toolcall_delta', 'toolcall_end', 'done']);
    assert.deepEqual(toolCalls(first.events), [{ type: 'toolCall', id: 'toolu_fake_1_0', name: 'read_note', arguments: { name: 'groceries' } }],
      'one complete call, without the mcp__pi__ prefix');
    assert.deepEqual(first.msg.content, toolCalls(first.events));

    messages.push(first.msg, result('toolu_fake_1_0', 'read_note', 'eggs and a mango'));
    const second = await step(env, messages);
    assert.equal(second.msg.stopReason, 'stop');
    assert.deepEqual(second.msg.content, [{ type: 'text', text: 'Mango.' }]);

    messages.push(second.msg, user('Thanks'));
    const third = await step(env, messages);
    assert.deepEqual(third.msg.content, [{ type: 'text', text: 'You are welcome.' }]);

    const log = env.log();
    assert.equal(log.filter((l) => l.kind === 'spawn').length, 1, 'one process for the whole conversation');
    assert.deepEqual(log.filter((l) => l.kind === 'mcp-result').map((l) => l.result),
      [{ content: [{ type: 'text', text: 'eggs and a mango' }], isError: false }], 'the held call got pi\'s result');
    const stdin = log.filter((l) => l.kind === 'stdin' && l.msg.type === 'user').map((l) => l.msg.message.content);
    assert.deepEqual(stdin, [[{ type: 'text', text: 'Fruit on my note?' }], [{ type: 'text', text: 'Thanks' }]], 'each user message goes in live');
    assert.equal(log.find((l) => l.kind === 'spawn').resume, undefined, 'a new conversation needs no session file');
  } finally { await env.service.close(); }
});

test('text streams as balanced events in pi\'s order, with the partial message updated before each event', async () => {
  const env = setup([{ steps: [{ text: 'Hello there, friend.' }, { text: 'Again.' }] }]);
  try {
    const seen: string[] = [];
    const context = normalizeContext({ systemPrompt: 'You are pi.', messages: [user('Hi')], tools });
    const stream = env.service.streamSimple(claudeModel('claude-haiku-5-5')!, context, { sessionId: 's1' });
    // `partial` is pi's live response-so-far, so it is read the moment each event is pushed.
    const push = stream.push.bind(stream);
    stream.push = (e) => { if (e.type === 'text_delta') seen.push((e.partial.content[e.contentIndex] as { text: string }).text); push(e); };
    for await (const _ of stream) { /* drain */ }
    assert.deepEqual(seen, ['Hello th', 'Hello there, fri', 'Hello there, friend.'], 'each delta is already in the partial');
    const r = await step(env, [user('Hi'), await stream.result(), user('again')]);
    assert.deepEqual(r.kinds, ['start', 'text_start', 'text_delta', 'text_end', 'done']);
  } finally { await env.service.close(); }
});

test('two tool calls in one message: both reach pi, and the results answer the held calls in order', async () => {
  const env = setup([{ steps: [{ toolCalls: [{ name: 'get_weather', args: { city: 'Monterrey' } }, { name: 'get_weather', args: { city: 'Oaxaca' } }] }, { text: 'Both sunny.' }] }]);
  try {
    const messages: Message[] = [user('Weather in both?')];
    const first = await step(env, messages);
    const calls = toolCalls(first.events);
    assert.deepEqual(calls.map((c) => c.arguments.city), ['Monterrey', 'Oaxaca']);
    // pi may finish them in any order.
    messages.push(first.msg, result(calls[1]!.id, 'get_weather', 'Oaxaca 30 C'), result(calls[0]!.id, 'get_weather', 'Monterrey 27 C'));
    assert.deepEqual((await step(env, messages)).msg.content, [{ type: 'text', text: 'Both sunny.' }]);
    assert.deepEqual(env.log().filter((l) => l.kind === 'mcp-result').map((l) => [l.args.city, l.result.content[0].text]),
      [['Monterrey', 'Monterrey 27 C'], ['Oaxaca', 'Oaxaca 30 C']]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 1);
  } finally { await env.service.close(); }
});

test("the binary runs with all of Claude Code's own features off, pi's prompt replacing Claude Code's, pi's tools only, and no inherited secrets", async () => {
  process.env.PPC_SECRET_FOR_TEST = 'must-not-leak';
  const env = setup([{ steps: [{ text: 'Hi.' }] }]);
  try {
    const r = await step(env, [user('Hi')], { maxTokens: 9000 });
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'Hi.' }]);
    const spawned = env.log().find((l) => l.kind === 'spawn');
    const args: string[] = spawned.args;
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(flag('--tools'), '', 'Claude Code\'s built-in tools are off');
    assert.equal(flag('--setting-sources'), '');
    assert.equal(flag('--model'), 'claude-haiku-5-5');
    assert.equal(flag('--allowedTools'), 'mcp__pi', 'every tool of pi\'s server, also ones added later');
    assert.equal(flag('--system-prompt-snapshot'), 'off');
    assert.deepEqual(spawned.mcpConfig, { pi: { type: 'sdk', name: 'pi' } }, 'tools travel on the binary\'s own channel');
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome', '--thinking=disabled']) assert.ok(args.includes(f), f);
    assert.ok(!args.includes('--bare'), '--bare would switch off the subscription login');
    const init = env.log().find((l) => l.kind === 'initialize');
    assert.deepEqual([init.systemPrompt, init.appendSystemPrompt], [['You are pi.'], undefined], 'by default pi\'s prompt replaces Claude Code\'s');
    assert.equal(spawned.env.PPC_SECRET_FOR_TEST, undefined);
    assert.equal(spawned.env.CLAUDE_CONFIG_DIR, env.paths.configDir, 'the extension\'s own Claude Code folder');
    assert.equal(spawned.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(spawned.env.DISABLE_AUTO_COMPACT, '1');
    assert.equal(spawned.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '9000');
    assert.deepEqual(env.log().find((l) => l.kind === 'mcp-list').tools,
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })));
    assert.ok(spawned.cwd.startsWith(env.paths.workDir + '/'), 'a working folder of its own');
    assert.deepEqual(readdirSync(spawned.cwd), [], 'an empty working folder');
  } finally { delete process.env.PPC_SECRET_FOR_TEST; await env.service.close(); }
});

test('a new process (after a restart) gets the whole conversation as a native session, tool calls included, foreign or unsigned thinking left out', async () => {
  const env = setup([{ steps: [{ text: 'It was a mango.' }] }]);
  try {
    const prior: Message = { role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-haiku-5-5', stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'thinking', thinking: 'look it up', thinkingSignature: 'theirs' }, { type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'call|1', name: 'read_note', arguments: { name: 'groceries' } }], timestamp: 1 };
    const failed: Message = { ...prior, content: [{ type: 'text', text: 'half' }], stopReason: 'error' };
    const messages = [user('Fruit on my note?'), prior, result('call|1', 'read_note', 'eggs and a mango'), failed, user('Which fruit was it?')];
    const r = await step(env, messages, { reasoning: 'high' });
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'It was a mango.' }]);
    const spawned = env.log().find((l) => l.kind === 'spawn');
    const session = spawned.resume.trim().split('\n').map((l: string) => JSON.parse(l));
    assert.deepEqual(session.map((e: any) => e.message.content), [
      [{ type: 'text', text: 'Fruit on my note?' }],
      [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call_1', name: 'mcp__pi__read_note', input: { name: 'groceries' } }],
      [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'eggs and a mango' }], is_error: false }],
    ], 'another provider\'s signature is not sent, and a failed answer is left out');
    assert.equal(session[1].message.stop_reason, 'tool_use');
    assert.ok(session.every((e: any, i: number) => e.parentUuid === (i ? session[i - 1].uuid : null)), 'entries are chained');
    assert.ok(session.every((e: any) => e.version === CLAUDE_CODE_VERSION), 'the session names the pinned Claude Code version');
    assert.ok(spawned.args.includes('--resume'));
    assert.deepEqual(env.log().filter((l) => l.kind === 'stdin' && l.msg.type === 'user').map((l) => l.msg.message.content),
      [[{ type: 'text', text: 'Which fruit was it?' }]], 'the newest user message goes in live, as in a warm process');
  } finally { await env.service.close(); }
});

test('thinking this provider streamed keeps its signature, and a cold resume with the same model sends it back', async () => {
  const env = setup([{ steps: [{ thinking: { text: 'hmm', signature: 'sig-x' }, toolCalls: [{ name: 'read_note', args: { name: 'a' } }] }, { text: 'ok' }] }]);
  const env2 = setup([{ steps: [{ text: 'resumed' }] }]);
  try {
    const messages: Message[] = [user('Go')];
    const first = await step(env, messages, { reasoning: 'high' });
    assert.deepEqual(first.msg.content[0], { type: 'thinking', thinking: 'hmm', thinkingSignature: 'sig-x' });
    assert.deepEqual(first.kinds.slice(0, 4), ['start', 'thinking_start', 'thinking_delta', 'thinking_end']);
    messages.push(first.msg, result('toolu_fake_1_0', 'read_note', 'A'));
    // Another service (a restart) has no warm process: it resumes mid-tool from the session file.
    const r = await step(env2, messages, { reasoning: 'high' });
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'resumed' }]);
    const session = env2.log().find((l) => l.kind === 'spawn').resume.trim().split('\n').map((l: string) => JSON.parse(l));
    assert.deepEqual(session[1].message.content[0], { type: 'thinking', thinking: 'hmm', signature: 'sig-x' });
  } finally { await env.service.close(); await env2.service.close(); }
});

test('a history that ends in tool results (a restart mid-tool) continues with an empty trigger', async () => {
  const env = setup([{ steps: [{ text: 'It was a mango.' }] }]);
  try {
    const prior = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c1', name: 'read_note', arguments: { name: 'groceries' } }], timestamp: 1 } as unknown as Message;
    const r = await step(env, [user('Fruit?'), prior, result('c1', 'read_note', 'a mango')]);
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'It was a mango.' }]);
    const session = env.log().find((l) => l.kind === 'spawn').resume.trim().split('\n').map((l: string) => JSON.parse(l));
    assert.equal(session.at(-1).message.content[0].type, 'tool_result', 'the result is in the file');
    assert.deepEqual(env.log().filter((l) => l.kind === 'stdin' && l.msg.type === 'user').map((l) => l.msg.message.content), [[]]);
  } finally { await env.service.close(); }
});

test('a message pi adds after the tool results (steering) resumes in a new process and retires the old one', async () => {
  const env = setup([{ steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'a' } }] }, { text: 'Steered.' }] }]);
  try {
    const messages: Message[] = [user('Go')];
    const first = await step(env, messages);
    messages.push(first.msg, result('toolu_fake_1_0', 'read_note', 'A'), user('Actually, stop.'));
    const r = await step(env, messages);
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'Steered.' }]);
    const spawns = env.log().filter((l) => l.kind === 'spawn');
    assert.equal(spawns.length, 2);
    assert.match(spawns[1].resume, /tool_result/);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(spawns[0].pid, 0), 'the superseded process was stopped');
  } finally { await env.service.close(); }
});

test('images in user messages and tool results reach Claude Code as Anthropic image blocks', async () => {
  const env = setup([{ steps: [{ text: 'A cat.' }] }]);
  try {
    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };
    const prior = { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c1', name: 'read_note', arguments: {} }], timestamp: 1 } as unknown as Message;
    const shot: Message = { role: 'toolResult', toolCallId: 'c1', toolName: 'read_note', content: [image], isError: true, timestamp: 1 };
    await step(env, [user('look'), prior, shot, { role: 'user', content: [{ type: 'text', text: 'and this?' }, image], timestamp: 1 }]);
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } };
    const session = env.log().find((l) => l.kind === 'spawn').resume.trim().split('\n').map((l: string) => JSON.parse(l));
    assert.deepEqual(session.at(-1).message.content, [{ type: 'tool_result', tool_use_id: 'c1', content: [block], is_error: true }]);
    assert.deepEqual(env.log().filter((l) => l.kind === 'stdin' && l.msg.type === 'user').map((l) => l.msg.message.content),
      [[{ type: 'text', text: 'and this?' }, block]]);
  } finally { await env.service.close(); }
});

test('an image a warm tool call returns reaches Claude Code as MCP image content', async () => {
  const env = setup([{ steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'pic' } }] }, { text: 'Seen.' }] }]);
  try {
    const messages: Message[] = [user('Show')];
    const first = await step(env, messages);
    messages.push(first.msg, { role: 'toolResult', toolCallId: 'toolu_fake_1_0', toolName: 'read_note', content: [{ type: 'text', text: 'here' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }], isError: false, timestamp: 1 });
    await step(env, messages);
    assert.deepEqual(env.log().find((l) => l.kind === 'mcp-result').result,
      { content: [{ type: 'text', text: 'here' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }], isError: false });
  } finally { await env.service.close(); }
});

test('model, effort and tools change inside the warm process; only a new system prompt starts another', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }] }]);
  try {
    const messages: Message[] = [user('one')];
    messages.push((await step(env, messages, { reasoning: 'low' })).msg, user('two'));
    messages.push((await step(env, messages, { reasoning: 'high' })).msg, user('three'));
    messages.push((await step(env, messages, { reasoning: 'high', tools: tools.slice(0, 1) })).msg, user('four'));
    messages.push((await step(env, messages, { reasoning: 'high', tools: tools.slice(0, 1), model: 'claude-sonnet-5-5' })).msg, user('five'));
    await step(env, messages, { reasoning: 'high', tools: tools.slice(0, 1), model: 'claude-sonnet-5-5', systemPrompt: 'You are pi, now terser.' });
    const log = env.log();
    assert.equal(log.filter((l) => l.kind === 'spawn').length, 2, 'only the new system prompt needed a new process');
    const controls = log.filter((l) => l.kind === 'stdin' && l.msg.type === 'control_request').map((l) => l.msg.request);
    assert.deepEqual(controls.filter((r) => r.subtype === 'apply_flag_settings').map((r) => r.settings), [{ effortLevel: 'high' }]);
    assert.deepEqual(controls.filter((r) => r.subtype === 'set_model').map((r) => r.model), ['claude-sonnet-5-5']);
    assert.equal(controls.filter((r) => r.message?.method === 'notifications/tools/list_changed').length, 1);
    assert.deepEqual(log.filter((l) => l.kind === 'mcp-list').map((l) => l.tools.length), [2, 1, 1], 'the warm process re-read its tools');
    const second = log.filter((l) => l.kind === 'spawn')[1];
    assert.equal(second.args[second.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
    assert.ok(second.resume.includes('"four"'), 'the new process resumed the conversation');
  } finally { await env.service.close(); }
});

test("reasoning levels map to Claude Code efforts through the model's thinking-level map; none is no thinking", async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] }]);
  try {
    const efforts: unknown[] = [];
    for (const reasoning of ['minimal', 'xhigh', 'max', undefined] as const) {
      await step(env, [user(`go ${reasoning}`)], { reasoning, sessionId: String(reasoning), model: 'claude-haiku-5-5' });
      const spawned = env.log().filter((l) => l.kind === 'spawn').at(-1);
      efforts.push(spawned.args.includes('--effort') ? spawned.args[spawned.args.indexOf('--effort') + 1] : spawned.args.includes('--thinking=disabled') && 'disabled');
    }
    assert.deepEqual(efforts, ['low', 'xhigh', 'max', 'disabled']);
  } finally { await env.service.close(); }
});

test('usage, cache counters and thinking come through as pi reads them; a subscription costs nothing per token', async () => {
  const env = setup([{ steps: [{ thinking: { text: 'hmm', signature: 'sig-x' }, text: 'Done.',
    usage: { input_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200 }, output_tokens: 40 } }] }]);
  try {
    const r = await step(env, [user('Go')], { reasoning: 'high' });
    assert.deepEqual(r.kinds, ['start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done']);
    assert.equal(r.msg.stopReason, 'stop');
    assert.equal(r.msg.rawStopReason, 'end_turn');
    assert.equal(r.msg.responseId, 'msg_fake_1');
    assert.equal(r.msg.provider, PROVIDER_ID);
    assert.equal(r.msg.model, 'claude-haiku-5-5');
    assert.deepEqual(r.msg.usage, { input: 12, output: 40, cacheRead: 4000, cacheWrite: 300, cacheWrite1h: 200, totalTokens: 4352,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false } });
    const spawned = env.log().find((l) => l.kind === 'spawn');
    assert.equal(spawned.args[spawned.args.indexOf('--effort') + 1], 'high');
    assert.equal(spawned.args[spawned.args.indexOf('--thinking-display') + 1], 'summarized', 'thinking text reaches pi');
    assert.ok(!spawned.args.includes('--thinking=disabled'));
  } finally { await env.service.close(); }
});

test('a warm process continues after thinking', async () => {
  const env = setup([{ steps: [{ thinking: { text: 'hmm', signature: 'sig-x' }, toolCalls: [{ name: 'read_note', args: { name: 'a' } }] }, { text: 'ok' }] }]);
  try {
    const messages: Message[] = [user('Go')];
    const first = await step(env, messages, { reasoning: 'high' });
    assert.deepEqual(first.msg.content.map((c) => c.type), ['thinking', 'toolCall']);
    messages.push(first.msg, result('toolu_fake_1_0', 'read_note', 'A'));
    assert.deepEqual((await step(env, messages, { reasoning: 'high' })).msg.content, [{ type: 'text', text: 'ok' }]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 1);
  } finally { await env.service.close(); }
});

test('aborting mid-stream ends with an aborted result and stops the process; the next call starts a fresh one', async () => {
  const env = setup([{ steps: [{ text: 'x'.repeat(400), slowMs: 30 }, { text: 'Fresh.' }] }]);
  try {
    const controller = new AbortController();
    const context = normalizeContext({ systemPrompt: 'You are pi.', messages: [user('Long')], tools });
    const stream = env.service.streamSimple(claudeModel('claude-haiku-5-5')!, context, { signal: controller.signal });
    const events: AssistantMessageEvent[] = [];
    for await (const e of stream) { events.push(e); if (e.type === 'text_delta') controller.abort(); }
    const msg = await stream.result();
    assert.equal(msg.stopReason, 'aborted');
    assert.equal(msg.errorMessage, 'Request was aborted');
    assert.equal(events.at(-1)!.type, 'error');
    assert.equal(events.filter((e) => e.type === 'error' || e.type === 'done').length, 1, 'exactly one terminal event');
    assert.ok(events.length < 50, 'the stream stopped early');
    const r = await step(env, [user('Again')]);
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'Fresh.' }]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 2);
    assert.ok(env.log().some((l) => l.kind === 'stdin' && l.msg.request?.subtype === 'interrupt'), 'asked Claude Code to interrupt');
  } finally { await env.service.close(); }
});

test('a signal aborted before the call starts no process', async () => {
  const env = setup([{ steps: [{ text: 'never' }] }]);
  try {
    const controller = new AbortController();
    controller.abort();
    const r = await step(env, [user('Hi')], { signal: controller.signal });
    assert.equal(r.msg.stopReason, 'aborted');
    assert.deepEqual(r.kinds, ['error'], 'no start before setup succeeded');
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 0);
  } finally { await env.service.close(); }
});

test('a crash or an error result ends the stream with its reason, never a silent empty answer', async () => {
  const env = setup([{ steps: [{ crash: true }, { error: 'API Error: 529 overloaded' }] }]);
  try {
    const crash = await step(env, [user('Hi')]);
    assert.equal(crash.msg.stopReason, 'error');
    assert.match(crash.msg.errorMessage!, /exited with 3.*something broke/s);
    assert.deepEqual(crash.kinds, ['start', 'error']);
    const overloaded = await step(env, [user('Hi again')]);
    assert.match(overloaded.msg.errorMessage!, /529 overloaded/);
  } finally { await env.service.close(); }
});

test('a binary that is missing or cannot be executed fails that request with an error, and pi survives', async () => {
  for (const breakIt of [(path: string) => rmSync(path), (path: string) => chmodSync(path, 0o644)]) {
    const dir = mkdtempSync(join(tmpdir(), 'ppc-provider-bin-'));
    roots.push(dir);
    const binary = join(dir, 'claude');
    copyFileSync(FAKE, binary);
    breakIt(binary);
    const env = setup([{ steps: [{ text: 'never' }] }], { binary });
    try {
      const r = await step(env, [user('Hi')]);
      assert.equal(r.msg.stopReason, 'error');
      assert.match(r.msg.errorMessage!, /claude (exited with|refused to start).*(ENOENT|EACCES)/);
    } finally { await env.service.close(); }
  }
});

test('a binary that cannot be had (not installed) fails that request before start with its reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ppc-provider-'));
  roots.push(root);
  const service = openClaudeService({ paths: dataPaths(root), binary: async () => { throw new Error('Claude Code is not installed; run /claude-login'); } });
  try {
    const stream = service.streamSimple(claudeModel('claude-haiku-5-5')!, normalizeContext({ messages: [user('Hi')] }), {});
    const kinds: string[] = [];
    for await (const e of stream) kinds.push(e.type);
    assert.deepEqual(kinds, ['error']);
    assert.equal((await stream.result()).errorMessage, 'Claude Code is not installed; run /claude-login');
  } finally { await service.close(); }
});

test('a resumed history lives in a private folder only while its process runs, and no socket or helper process exists', async () => {
  const env = setup([{ steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'x' } }] }, { text: 'ok' }] }]);
  try {
    const noted = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'noted' }], timestamp: 1 } as unknown as Message;
    const first = await step(env, [user('earlier'), noted, user('go')]);
    assert.equal(first.msg.stopReason, 'toolUse');
    const mine = join(env.paths.runDir, String(process.pid));
    const [dir] = readdirSync(mine);
    assert.deepEqual(readdirSync(join(mine, dir!)), ['session.jsonl'], 'only the session file: no socket, no MCP config file');
    assert.equal(statSync(join(mine, dir!)).mode & 0o777, 0o700);
    assert.equal(statSync(join(mine, dir!, 'session.jsonl')).mode & 0o777, 0o600);
    await env.service.close();
    assert.equal(existsSync(mine), false, 'removed with its process');
    assert.deepEqual(readdirSync(env.paths.workDir), [], 'the empty working folders this pi made go on close');
  } finally { await env.service.close(); }
});

test('session files a dead pi left behind are removed when the service first streams; a live pi\'s are kept', async () => {
  const env = setup([{ steps: [{ text: 'a' }] }]);
  try {
    const dead = join(env.paths.runDir, '999999999', 'session-x');
    const live = join(env.paths.runDir, String(process.ppid), 'session-y');
    for (const d of [dead, live]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'session.jsonl'), 'secret'); }
    assert.ok(existsSync(dead), 'opening the service touches nothing');
    await step(env, [user('one')]);
    assert.equal(existsSync(join(env.paths.runDir, '999999999')), false);
    assert.ok(existsSync(live));
  } finally { await env.service.close(); }
});

test('two conversations at once get their own processes and never cross', async () => {
  const env = setup([
    { match: 'pi A', steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'a' } }] }, { text: 'A done.' }] },
    { match: 'pi B', steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'b' } }] }, { text: 'B done.' }] },
  ]);
  try {
    const run = async (name: string) => {
      const messages: Message[] = [user(`note ${name}`)];
      const opts = { systemPrompt: `You are pi ${name}.`, sessionId: name };
      const first = await step(env, messages, opts);
      const call = toolCalls(first.events)[0]!;
      messages.push(first.msg, result(call.id, 'read_note', `content of ${name}`));
      return (await step(env, messages, opts)).msg.content;
    };
    const [a, b] = await Promise.all([run('A'), run('B')]);
    assert.deepEqual([a, b], [[{ type: 'text', text: 'A done.' }], [{ type: 'text', text: 'B done.' }]]);
    const results = env.log().filter((l) => l.kind === 'mcp-result').map((l) => [l.args.name, l.result.content[0].text]).sort();
    assert.deepEqual(results, [['a', 'content of A'], ['b', 'content of B']]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 2);
  } finally { await env.service.close(); }
});

test('a refused hot change retires that process, so it is neither stuck nor counted, and the next call works', async () => {
  const env = setup([{ refuseModels: ['claude-sonnet-5-5'], steps: [{ text: 'a' }, { text: 'b' }] }], { idleMs: 60_000 });
  try {
    const messages: Message[] = [user('one')];
    messages.push((await step(env, messages)).msg, user('two'));
    const refused = await step(env, messages, { model: 'claude-sonnet-5-5' });
    assert.match(refused.msg.errorMessage!, /model not available/);
    assert.deepEqual(refused.kinds, ['error']);
    const firstPid = env.log().find((l) => l.kind === 'spawn').pid;
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(firstPid, 0), 'the refused process was stopped');
    assert.deepEqual((await step(env, messages)).msg.content, [{ type: 'text', text: 'b' }]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 2);
  } finally { await env.service.close(); }
});

test("stop reasons follow pi-ai's Anthropic provider: a refusal is an error, an unknown reason too", async () => {
  const env = setup([{ steps: [{ text: 'I cannot help.', stop: 'refusal' }, { text: 'x', stop: 'model_context_window_exceeded' }, { text: 'Long', stop: 'max_tokens' }, { text: 'p', stop: 'pause_turn' }] }]);
  try {
    assert.match((await step(env, [user('a')])).msg.errorMessage!, /The model refused to complete the request/);
    assert.match((await step(env, [user('b')])).msg.errorMessage!, /Unhandled stop reason: model_context_window_exceeded/);
    assert.equal((await step(env, [user('c')])).msg.stopReason, 'length');
    assert.equal((await step(env, [user('d')])).msg.stopReason, 'stop');
  } finally { await env.service.close(); }
});

test('a warm process that died while idle is not picked: the next turn starts fresh from the history', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }] }]);
  try {
    const messages: Message[] = [user('one')];
    messages.push((await step(env, messages)).msg, user('two'));
    process.kill(env.log().find((l) => l.kind === 'spawn').pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const r = await step(env, messages);
    assert.equal(r.msg.stopReason, 'stop');
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'b' }]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 2);
  } finally { await env.service.close(); }
});

test('the pool keeps at most maxProcesses: the least recently used idle process is stopped first', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }], { maxProcesses: 1 });
  try {
    await step(env, [user('one')], { sessionId: 'x' });
    await step(env, [user('two')], { sessionId: 'y' });
    const [first, second] = env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(first, 0), 'the older process was stopped');
    assert.doesNotThrow(() => process.kill(second, 0), 'the newer one stays warm');
  } finally { await env.service.close(); }
});

test('an idle process is stopped after idleMs; one awaiting a tool result is kept', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { toolCalls: [{ name: 'read_note', args: { name: 'n' } }] }] }], { idleMs: 100 });
  try {
    await step(env, [user('idle')], { systemPrompt: 'idle' });
    await step(env, [user('tool')], { systemPrompt: 'tool' });
    const [idle, awaiting] = env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid);
    await new Promise((r) => setTimeout(r, 600));
    assert.throws(() => process.kill(idle, 0), 'the idle process was stopped');
    assert.doesNotThrow(() => process.kill(awaiting, 0), 'the process awaiting a tool stays');
  } finally { await env.service.close(); }
});

test('several user messages pi adds at once (a subagent wake, a note) continue the warm process as one input, in order', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }] }]);
  try {
    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };
    const messages: Message[] = [user('one')];
    messages.push((await step(env, messages)).msg, user('Background agent finished.'),
      { role: 'user', content: [{ type: 'text', text: 'Reply in English.' }, image], timestamp: 1 });
    const r = await step(env, messages);
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'b' }]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 1, 'the warm process is reused');
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } };
    assert.deepEqual(env.log().filter((l) => l.kind === 'stdin' && l.msg.type === 'user').map((l) => l.msg.message.content),
      [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'Background agent finished.' }, { type: 'text', text: 'Reply in English.' }, block]]);
  } finally { await env.service.close(); }
});

test('a shorter history for the same session (after compaction) starts a new process and closes the old one', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }], { idleMs: 60_000 });
  try {
    const messages: Message[] = [user('one')];
    messages.push((await step(env, messages)).msg, user('two'));
    messages.push((await step(env, messages)).msg);
    const r = await step(env, [user('Summary of the conversation so far.'), user('three')]);
    assert.deepEqual(r.msg.content, [{ type: 'text', text: 'c' }]);
    const [old, fresh] = env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(old, 0), 'the process of the longer history was closed');
    assert.doesNotThrow(() => process.kill(fresh, 0), 'the new one stays warm');
  } finally { await env.service.close(); }
});

test('a new process of another session leaves this session\'s warm process alone', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }] }], { idleMs: 60_000 });
  try {
    await step(env, [user('one')], { sessionId: 'x' });
    await step(env, [user('two')], { sessionId: 'y' });
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid)) assert.doesNotThrow(() => process.kill(pid, 0));
  } finally { await env.service.close(); }
});

test('a process started with no tools (a reviewer, a compaction) is stopped after oneShotIdleMs; one with tools stays', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }] }], { idleMs: 60_000, oneShotIdleMs: 100 });
  try {
    await step(env, [user('review')], { systemPrompt: 'reviewer', tools: [], sessionId: 'r' });
    await step(env, [user('work')], { systemPrompt: 'main', sessionId: 'm' });
    const [oneShot, main] = env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid);
    await new Promise((r) => setTimeout(r, 600));
    assert.throws(() => process.kill(oneShot, 0), 'the one-shot process was stopped');
    assert.doesNotThrow(() => process.kill(main, 0), 'the conversation stays warm');
  } finally { await env.service.close(); }
});

test('a full pool evicts a process with no tools before an older conversation', async () => {
  const env = setup([{ steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }], { maxProcesses: 2, idleMs: 60_000 });
  try {
    await step(env, [user('work')], { systemPrompt: 'main', sessionId: 'm' });
    await step(env, [user('review')], { systemPrompt: 'reviewer', tools: [], sessionId: 'r' });
    await step(env, [user('other')], { systemPrompt: 'other', sessionId: 'o' });
    const [main, oneShot, other] = env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(oneShot, 0), 'the one-shot process went first');
    assert.doesNotThrow(() => process.kill(main, 0), 'the least recently used conversation stays');
    assert.doesNotThrow(() => process.kill(other, 0));
  } finally { await env.service.close(); }
});

test('after close() the service refuses new work instead of starting processes nobody reaps', async () => {
  const env = setup([{ steps: [{ text: 'a' }] }]);
  await env.service.close();
  assert.match((await step(env, [user('one')])).msg.errorMessage!, /closed/);
  assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 0);
});

test('a model of another provider is refused', async () => {
  const env = setup([{ steps: [{ text: 'a' }] }]);
  try {
    const stream = env.service.streamSimple({ ...claudeModel('claude-haiku-5-5')!, provider: 'other' }, normalizeContext({ messages: [user('one')] }), {});
    assert.match((await stream.result()).errorMessage!, /other/);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 0);
  } finally { await env.service.close(); }
});

// The Claude Code context switch: off (default) replaces its system prompt, on keeps it and appends pi's.
test("the Claude Code context switch, read from the extension's settings: off replaces, on appends, and a change starts a new process", async () => {
  const env = setup([{ steps: [{ text: 'One.' }, { text: 'Two.' }, { text: 'Three.' }] }]);
  try {
    const messages: Message[] = [user('Hi')];
    const first = await step(env, messages);
    writeClaudeSettings(env.paths.data, { claudeCodeContext: true, extraUsage: 'strict' });
    messages.push(first.msg, user('Again'));
    const second = await step(env, messages);
    writeClaudeSettings(env.paths.data, { claudeCodeContext: false, extraUsage: 'strict' });
    messages.push(second.msg, user('Once more'));
    await step(env, messages);
    const inits = env.log().filter((l) => l.kind === 'initialize');
    assert.deepEqual(inits.map((l) => [l.systemPrompt, l.appendSystemPrompt]), [
      [['You are pi.'], undefined],
      [undefined, 'You are pi.'],
      [['You are pi.'], undefined],
    ]);
    assert.equal(env.log().filter((l) => l.kind === 'spawn').length, 3, 'each change of the switch starts a new process');
  } finally { await env.service.close(); }
});

test('the settings can come from the caller instead of the settings file', async () => {
  const env = setup([{ steps: [{ text: 'One.' }] }], { settings: () => ({ claudeCodeContext: true, extraUsage: 'strict' }) });
  try {
    await step(env, [user('Hi')]);
    assert.equal(env.log().find((l) => l.kind === 'initialize').appendSystemPrompt, 'You are pi.');
  } finally { await env.service.close(); }
});

// The plan limit ends the turn with the window and when it resets, not Claude's raw text.
test('a reached plan limit names its window and when it resets', async () => {
  const resetsAt = Math.floor(new Date(2026, 9, 30, 18, 5).getTime() / 1000);
  const env = setup([{ steps: [{ limit: { rateLimitType: 'five_hour', resetsAt } }, { limit: { rateLimitType: 'seven_day' } }, { limit: {} }] }]);
  try {
    assert.equal((await step(env, [user('Hi')])).msg.errorMessage, 'Claude subscription usage limit reached (5-hour window); it resets at 2026-10-30 18:05.');
    assert.equal((await step(env, [user('Hi again')])).msg.errorMessage, 'Claude subscription usage limit reached (weekly window).');
    const last = (await step(env, [user('And again')])).msg.errorMessage!;
    assert.equal(last, 'Claude subscription usage limit reached.');
    // Gentle Shell's subagent error classifier (lib/agents-protocol.ts), which moves to its fallback model on a match.
    assert.match(last, /quota|billing|out of budget|usage.?limit|credit balance/i, 'Gentle Shell reads a plan limit as quota');
  } finally { await env.service.close(); }
});

// The usage-credit guard: a turn billed to Extra Usage (usage credits) instead of the plan, by the `extraUsage` mode.
const extraSettings = (env: Env, extraUsage: ClaudeSettings['extraUsage']) => writeClaudeSettings(env.paths.data, { claudeCodeContext: false, extraUsage });

test('strict: a turn Claude Code reports as billed to Extra Usage (overageInUse or isUsingOverage) stops with a clear error and its process goes', async () => {
  const warned: string[] = [];
  const env = setup([{ steps: [{ overageInUse: true, text: 'billed' }, { overage: true, text: 'billed too' }, { text: 'plan' }] }], { extraUsage: { warn: (t) => warned.push(t), ask: async () => true } });
  try {
    extraSettings(env, 'strict');
    const first = await step(env, [user('Hi')]);
    assert.equal(first.msg.stopReason, 'error');
    assert.match(first.msg.errorMessage!, /^Claude Code billing: this request was billed to Extra Usage \(usage credits\), not your Claude plan\. The turn was stopped so no more requests are billed \(extra usage: strict\)\./);
    assert.match(first.msg.errorMessage!, /\/claude-extra-usage ask or \/claude-extra-usage allow/);
    assert.deepEqual(first.msg.content, [], 'nothing of the billed answer is passed on');
    const second = await step(env, [user('Hi again')], { sessionId: 's2' });
    assert.match(second.msg.errorMessage!, /billed to Extra Usage/);
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of env.log().filter((l) => l.kind === 'spawn').map((l) => l.pid)) assert.throws(() => process.kill(pid, 0), 'the billed process was stopped');
    assert.deepEqual((await step(env, [user('third')])).msg.content, [{ type: 'text', text: 'plan' }]);
    assert.deepEqual(warned, [], 'strict never asks or lets it through');
  } finally { await env.service.close(); }
});

test('ask (the default when nothing is set): the owner is asked; a yes holds for that session only, and every billed turn warns', async () => {
  const asked: string[] = [];
  const warned: string[] = [];
  const allowed = new Set<string>();
  const answers = [true, false];
  const env = setup([{ steps: [{ overageInUse: true, text: 'one' }, { overageInUse: true, text: 'two' }, { overageInUse: true, text: 'other' }] }],
    { extraUsage: { allowed, warn: (t) => warned.push(t), ask: async (session, q) => { asked.push(`${session}: ${q}`); return answers.shift() ?? false; } } });
  try {
    // No settings file: the default mode asks.
    const messages: Message[] = [user('Hi')];
    const first = await step(env, messages, { sessionId: 'A' });
    assert.deepEqual(first.msg.content, [{ type: 'text', text: 'one' }]);
    messages.push(first.msg, user('more'));
    const second = await step(env, messages, { sessionId: 'A' });
    assert.deepEqual(second.msg.content, [{ type: 'text', text: 'two' }], 'accepted for session A: not asked again');
    assert.deepEqual([...allowed], ['A']);
    const other = await step(env, [user('elsewhere')], { sessionId: 'B' });
    assert.equal(other.msg.stopReason, 'error', 'another session is asked again, and a no stops it');
    assert.match(other.msg.errorMessage!, /Extra Usage was not accepted for this session \(extra usage: ask\)\. To accept it for this session only, run \/claude-extra-usage allow-session/);
    assert.deepEqual(asked, [`A: ${ASK_QUESTION}`, `B: ${ASK_QUESTION}`]);
    assert.deepEqual(warned, [EXTRA_USAGE_WARNING, EXTRA_USAGE_WARNING]);
  } finally { await env.service.close(); }
});

test('ask with no one to ask stops the turn like strict', async () => {
  const env = setup([{ steps: [{ overageInUse: true, text: 'billed' }] }]);
  try {
    extraSettings(env, 'ask');
    const r = await step(env, [user('Hi')]);
    assert.match(r.msg.errorMessage!, /not accepted for this session/);
  } finally { await env.service.close(); }
});

test('a declined session is not sent again on another model (a fallback), until allow-session accepts it', async () => {
  // Gentle Shell retries a quota error on the next model of its chain; a request would be billed before the guard saw it.
  const declined = new Set<string>();
  const allowed = new Set<string>();
  const env = setup([{ steps: [{ overageInUse: true, text: 'billed' }, { overageInUse: true, text: 'billed for s2' }, { text: 'after allow' }] }], { extraUsage: { ask: async () => false, declined, allowed } });
  try {
    extraSettings(env, 'ask');
    const first = await step(env, [user('Hi')]);
    assert.match(first.msg.errorMessage!, /not accepted for this session/);
    assert.deepEqual([...declined], ['s1']);
    const spawned = env.log().length;
    const fallback = await step(env, [user('Hi')], { model: 'claude-sonnet-5-5' });
    assert.match(fallback.msg.errorMessage!, /not accepted for this session/);
    assert.equal(env.log().length, spawned, 'nothing reached Claude Code for the declined session');
    // Another session is asked on its own.
    const other = await step(env, [user('Hi')], { sessionId: 's2' });
    assert.match(other.msg.errorMessage!, /not accepted for this session/);
    // allow-session clears the decline.
    allowed.add('s1'); declined.delete('s1');
    const after = await step(env, [user('Hi')], { model: 'claude-sonnet-5-5' });
    assert.equal(after.msg.stopReason, 'stop');
  } finally { await env.service.close(); }
});

test('allow: the turn goes on, with a warning every time it is billed to Extra Usage', async () => {
  const warned: string[] = [];
  const env = setup([{ steps: [{ overageInUse: true, text: 'billed' }, { text: 'plan' }, { overage: true, text: 'billed again' }] }], { extraUsage: { warn: (t) => warned.push(t) } });
  try {
    extraSettings(env, 'allow');
    const messages: Message[] = [user('Hi')];
    for (const expected of ['billed', 'plan', 'billed again']) {
      const r = await step(env, messages);
      assert.deepEqual(r.msg.content, [{ type: 'text', text: expected }]);
      messages.push(r.msg, user('next'));
    }
    assert.deepEqual(warned, [EXTRA_USAGE_WARNING, EXTRA_USAGE_WARNING], 'one warning per billed turn, none for a plan turn');
  } finally { await env.service.close(); }
});

test('"out of extra usage" without a plan-limit rejection says the request was classified as Extra Usage and points at the prompt and /claude-context', async () => {
  const env = setup([{ steps: [{ error: "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage" }, { limit: { rateLimitType: 'five_hour' } }] }]);
  try {
    const r = await step(env, [user('Hi')]);
    assert.equal(r.msg.stopReason, 'error');
    assert.match(r.msg.errorMessage!, /^Claude Code billing: Anthropic classified this request as Extra Usage \(not plan usage\)/);
    assert.match(r.msg.errorMessage!, /system prompt/);
    assert.match(r.msg.errorMessage!, /\/claude-context on/);
    assert.match(r.msg.errorMessage!, /You're out of extra usage/);
    assert.match((await step(env, [user('Hi again')])).msg.errorMessage!, /^Claude subscription usage limit reached \(5-hour window\)/, 'a plan rejection keeps the limit message');
  } finally { await env.service.close(); }
});

test('pi\'s request hooks: onPayload sees what goes to Claude Code, onProviderStreamEvent sees each event before it is normalized', async () => {
  const env = setup([{ steps: [{ text: 'Hi.' }] }]);
  try {
    const payloads: any[] = [];
    const raw: string[] = [];
    await step(env, [user('Hi')], {
      onPayload: (payload) => { payloads.push(payload); return undefined; },
      onProviderStreamEvent: async (data: any) => { raw.push(data.type === 'stream_event' ? data.event.type : data.type); },
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].model, 'claude-haiku-5-5');
    assert.equal(payloads[0].systemPrompt, 'You are pi.');
    assert.deepEqual(payloads[0].input, [{ type: 'text', text: 'Hi' }]);
    assert.deepEqual(raw.filter((t) => t !== 'system'), ['rate_limit_event', 'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  } finally { await env.service.close(); }
});
