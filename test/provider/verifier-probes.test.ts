// The independent verifier's probes (S4, S5, S6), kept as regression tests: the credential-free environment, every
// extra-usage signal, and an abort that arrives while an awaited step holds the stream.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as nodeTest } from 'node:test';
import { normalizeContext, type AssistantMessageEvent, type Message, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { dataPaths } from '../../src/env.ts';
import { claudeModel } from '../../src/models.ts';
import { writeClaudeSettings, type ExtraUsageMode } from '../../src/settings.ts';
import { openClaudeService, type ExtraUsageHooks } from '../../src/provider/provider.ts';

const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { timeout: 15_000 }, fn);
const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function setup(script: unknown[], mode: ExtraUsageMode, extraUsage?: ExtraUsageHooks) {
  const root = mkdtempSync(join(tmpdir(), 'ppc-verify-'));
  roots.push(root);
  const paths = dataPaths(join(root, 'data'));
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, 'script.json'), JSON.stringify(script));
  writeClaudeSettings(paths.data, { claudeCodeContext: false, extraUsage: mode });
  const service = openClaudeService({ paths, binary: async () => FAKE, extraUsage });
  const logFile = join(paths.configDir, 'log.jsonl');
  const log = (): any[] => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { paths, service, log };
}
const tools = [{ name: 'read_note', description: 'Read a note.', parameters: { type: 'object', properties: { name: { type: 'string' } } } }];
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: Date.now() });
const result = (id: string, text: string): Message =>
  ({ role: 'toolResult', toolCallId: id, toolName: 'read_note', content: [{ type: 'text', text }], isError: false, timestamp: Date.now() });

async function step(env: ReturnType<typeof setup>, messages: Message[], opts: SimpleStreamOptions = {}, onEvent?: (e: AssistantMessageEvent) => void) {
  const stream = env.service.streamSimple(claudeModel('claude-haiku-5-5')!, normalizeContext({ systemPrompt: 'You are pi.', messages, tools }), { sessionId: 's1', ...opts });
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) { events.push(e); onEvent?.(e); }
  return { msg: await stream.result(), events, terminals: events.filter((e) => e.type === 'done' || e.type === 'error').length };
}

test('V1 S6: rateLimitType "overage" alone counts as billed to Extra Usage (strict stops it)', async () => {
  const env = setup([{ steps: [{ overageTypeOnly: true, text: 'billed' }] }], 'strict');
  try {
    const r = await step(env, [user('Hi')]);
    assert.equal(r.msg.stopReason, 'error');
    assert.match(r.msg.errorMessage!, /extra usage: strict/);
    assert.equal(r.terminals, 1);
  } finally { await env.service.close(); }
});

test('V2 S6: strict also stops a billed continuation after tool results in the warm process', async () => {
  const env = setup([{ steps: [{ toolCalls: [{ name: 'read_note', args: { name: 'a' } }] }, { overageInUse: true, text: 'billed' }] }], 'strict');
  try {
    const messages: Message[] = [user('Hi')];
    const first = await step(env, messages);
    assert.equal(first.msg.stopReason, 'toolUse');
    messages.push(first.msg, result('toolu_fake_1_0', 'x'));
    const second = await step(env, messages);
    assert.equal(second.msg.stopReason, 'error');
    assert.match(second.msg.errorMessage!, /extra usage: strict/);
    assert.deepEqual(second.msg.content, []);
  } finally { await env.service.close(); }
});

test('V3 S6: allow warns on every billed response, tool rounds included', async () => {
  const warned: string[] = [];
  const env = setup([{ steps: [{ overageInUse: true, toolCalls: [{ name: 'read_note', args: { name: 'a' } }] }, { overageInUse: true, text: 'ok' }] }], 'allow', { warn: (m) => warned.push(m), allowed: new Set() });
  try {
    const messages: Message[] = [user('Hi')];
    const first = await step(env, messages);
    messages.push(first.msg, result('toolu_fake_1_0', 'x'));
    const second = await step(env, messages);
    assert.equal(second.msg.stopReason, 'stop');
    assert.equal(warned.length, 2);
  } finally { await env.service.close(); }
});

test('V4 S5: an abort after the whole answer was buffered still ends aborted, with one terminal event', async () => {
  const env = setup([{ steps: [{ text: 'short answer' }] }], 'ask');
  try {
    const c = new AbortController();
    const r = await step(env, [user('Hi')], { signal: c.signal }, (e) => { if (e.type === 'text_delta') c.abort(); });
    assert.equal(r.terminals, 1);
    assert.equal(r.msg.stopReason, 'aborted', `got ${r.msg.stopReason}: ${r.events.map((e) => e.type).join(',')}`);
    assert.equal(r.msg.errorMessage, 'Request was aborted');
  } finally { await env.service.close(); }
});

test('V5 S6: an abort while the ask dialog is open ends aborted; a late yes emits nothing more', async () => {
  let answer!: (v: boolean) => void;
  const env = setup([{ steps: [{ overageInUse: true, text: 'billed' }] }], 'ask', { ask: () => new Promise((r) => { answer = r; }), warn: () => {}, allowed: new Set() });
  try {
    const c = new AbortController();
    const stream = env.service.streamSimple(claudeModel('claude-haiku-5-5')!, normalizeContext({ systemPrompt: 'You are pi.', messages: [user('Hi')], tools }), { sessionId: 's1', signal: c.signal });
    const events: AssistantMessageEvent[] = [];
    const reading = (async () => { for await (const e of stream) events.push(e); })();
    for (let i = 0; i < 100 && !answer; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(answer, 'the owner was asked');
    c.abort();
    setTimeout(() => answer(true), 200);
    await reading;
    const msg = await stream.result();
    assert.equal(msg.stopReason, 'aborted');
    assert.equal(events.filter((e) => e.type === 'done' || e.type === 'error').length, 1);
  } finally { await env.service.close(); }
});

test('V6 S4: no credential variable from pi or options.env reaches Claude Code; proxies do', async () => {
  const secrets = { ANTHROPIC_API_KEY: 'k1', ANTHROPIC_AUTH_TOKEN: 'k2', CLAUDE_CODE_OAUTH_TOKEN: 'k3', AWS_SECRET_ACCESS_KEY: 'k4', GH_TOKEN: 'k5', ANTHROPIC_BASE_URL: 'http://evil' };
  Object.assign(process.env, secrets);
  const env = setup([{ steps: [{ text: 'Hi.' }] }], 'ask');
  try {
    const r = await step(env, [user('Hi')], { env: { ...secrets, OPENAI_API_KEY: 'k6', HTTPS_PROXY: 'http://proxy:3128' } });
    assert.equal(r.msg.stopReason, 'stop');
    const spawned = env.log().find((l) => l.kind === 'spawn');
    for (const k of [...Object.keys(secrets), 'OPENAI_API_KEY']) assert.equal(spawned.env[k], undefined, k);
    assert.equal(spawned.env.HTTPS_PROXY, 'http://proxy:3128');
  } finally { for (const k of Object.keys(secrets)) delete process.env[k]; await env.service.close(); }
});

test('V7 S5: an abort while events are already queued ends aborted (abort raised from onProviderStreamEvent after a pause)', async () => {
  const env = setup([{ steps: [{ text: 'a fairly short answer' }] }], 'ask');
  try {
    const c = new AbortController();
    let once = false;
    const r = await step(env, [user('Hi')], {
      signal: c.signal,
      onProviderStreamEvent: async (e: any) => {
        if (!once && e.type === 'stream_event' && e.event?.type === 'message_start') { once = true; await new Promise((res) => setTimeout(res, 150)); c.abort(); }
      },
    });
    assert.equal(r.terminals, 1);
    assert.equal(r.msg.stopReason, 'aborted', `got ${r.msg.stopReason}: ${r.events.map((e) => e.type).join(',')}`);
  } finally { await env.service.close(); }
});
