// The extension as pi loads it, with a fake `pi` that records what is registered and a fake UI context. The binary is
// the scripted fake behind a wrapper that answers `--version` with the pin; nothing downloads or signs in for real.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { normalizeContext, type AssistantMessageEvent, type Message, type Provider } from '@earendil-works/pi-ai';
import { binaryPath } from '../src/binary.ts';
import { CLAUDE_CODE_VERSION, dataPaths, PROVIDER_ID, type DataPaths } from '../src/env.ts';
import { createExtension } from '../src/extension.ts';
import { EXTRA_USAGE_WARNING } from '../src/provider/provider.ts';
import { scratch } from './fixtures/scratch.ts';

const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { timeout: 15_000 }, fn);
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
// Opus 5.5 first: pi (and Gentle Shell's subagents without a route) takes the first model when none is set.
const PLUGIN_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'];

/** A fake pi API recording registrations, and a UI context recording what the extension shows and asks. */
function load(paths: DataPaths, ui: { confirm?: boolean[]; inputs?: (string | undefined)[] } = {}) {
  const providers: Provider[] = [];
  const commands = new Map<string, any>();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const shown: { notify: [string, string?][]; confirm: [string, string][]; input: string[] } = { notify: [], confirm: [], input: [] };
  const confirms = [...(ui.confirm ?? [])];
  const inputs = [...(ui.inputs ?? [])];
  let sessionId = 'session-1';
  const ctx: any = {
    hasUI: true,
    ui: {
      notify: (m: string, t?: string) => { shown.notify.push([m, t]); },
      confirm: async (title: string, message: string) => { shown.confirm.push([title, message]); return confirms.shift() ?? false; },
      input: async (title: string) => { shown.input.push(title); return inputs.shift(); },
    },
    sessionManager: { getSessionId: () => sessionId },
  };
  const pi: any = {
    registerProvider: (p: Provider) => providers.push(p),
    registerCommand: (name: string, options: unknown) => commands.set(name, options),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  createExtension({ paths })(pi);
  const emit = async (event: string) => { for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx); };
  return { providers, commands, handlers, shown, ctx, emit, setSession: (id: string) => { sessionId = id; } };
}

/** The scripted fake as the installed pinned binary, signed in, following `script`. */
function install(paths: DataPaths, script: unknown[]) {
  mkdirSync(join(paths.binDir, CLAUDE_CODE_VERSION), { recursive: true });
  writeFileSync(binaryPath(paths), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${CLAUDE_CODE_VERSION} (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o700 });
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
  writeFileSync(join(paths.configDir, 'script.json'), JSON.stringify(script));
}

async function turn(provider: Provider, messages: Message[], sessionId = 'session-1') {
  const model = provider.getModels().find((m) => m.id === 'claude-haiku-5-5')!;
  const stream = provider.streamSimple(model, normalizeContext({ systemPrompt: 'You are pi.', messages }), { sessionId });
  const kinds: string[] = [];
  for await (const e of stream as AsyncIterable<AssistantMessageEvent>) kinds.push(e.type);
  return { kinds, msg: await stream.result() };
}
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 });

test('the extension registers the claude-subscription provider with the plugin\'s models and the /claude-* commands, and starts nothing', () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  const pi = load(paths);
  assert.equal(pi.providers.length, 1);
  const [provider] = pi.providers;
  assert.equal(provider!.id, PROVIDER_ID);
  assert.deepEqual(provider!.getModels().map((m) => m.id), PLUGIN_MODELS);
  for (const m of provider!.getModels()) {
    assert.equal(m.provider, PROVIDER_ID);
    assert.deepEqual([m.contextWindow, m.maxTokens, m.reasoning, m.input], [1_000_000, 128_000, true, ['text', 'image']]);
    assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'a subscription, not per-token billing');
    assert.equal(m.promptCache, undefined, 'no cache warming requests on the plan');
  }
  assert.deepEqual([...pi.commands.keys()], ['claude-login', 'claude-logout', 'claude-status', 'claude-context', 'claude-extra-usage']);
  assert.deepEqual(pi.commands.get('claude-extra-usage').getArgumentCompletions('a').map((c: any) => c.value), ['ask', 'allow', 'allow-session']);
  assert.deepEqual([...pi.handlers.keys()].sort(), ['agent_start', 'session_shutdown', 'session_start']);
  assert.equal(existsSync(paths.data), false, 'loading writes nothing');
});

test('the provider is configured without any key, since the sign-in is Claude Code\'s own', async () => {
  const pi = load(dataPaths(join(scratch('ppc-ext-'), 'data')));
  const resolved = await pi.providers[0]!.auth.apiKey!.resolve({ ctx: {} as any, signal: new AbortController().signal });
  assert.deepEqual(resolved, { auth: {}, source: 'Claude Code login (/claude-login)' });
});

test('a turn without the binary ends with an error telling the owner to run /claude-login, and downloads nothing', async () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  const pi = load(paths);
  const r = await turn(pi.providers[0]!, [user('Hi')]);
  assert.deepEqual(r.kinds, ['error']);
  assert.equal(r.msg.stopReason, 'error');
  assert.equal(r.msg.errorMessage, `Claude Code ${CLAUDE_CODE_VERSION} is not installed for pi-provider-claude. Run /claude-login: it asks before downloading it (about 127 MB) and then signs you in to your Claude subscription.`);
  assert.equal(existsSync(paths.binDir), false);
});

test('a turn with the binary but no sign-in tells the owner to run /claude-login', async () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  install(paths, [{ steps: [{ text: 'never' }] }]);
  const { rmSync } = await import('node:fs');
  rmSync(join(paths.configDir, '.credentials.json'));
  const r = await turn(load(paths).providers[0]!, [user('Hi')]);
  assert.match(r.msg.errorMessage!, /^Not signed in to Claude for pi-provider-claude\. Run \/claude-login/);
});

test('a signed-in turn streams through the provider pi registered, and session_shutdown stops the warm process', async () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  install(paths, [{ steps: [{ text: 'Hello.' }] }]);
  const pi = load(paths);
  const r = await turn(pi.providers[0]!, [user('Hi')]);
  assert.deepEqual(r.kinds, ['start', 'text_start', 'text_delta', 'text_end', 'done']);
  assert.deepEqual(r.msg.content, [{ type: 'text', text: 'Hello.' }]);
  const log = readFileSync(join(paths.configDir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const pid = log.find((l) => l.kind === 'spawn').pid;
  assert.doesNotThrow(() => process.kill(pid, 0), 'warm after the turn');
  await pi.emit('session_shutdown');
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), 'stopped with the session');
});

test('extra usage, ask (default): pi\'s UI asks; a yes holds for this session, with a warning each billed turn; another session is asked again', async () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  install(paths, [{ steps: [{ overageInUse: true, text: 'one' }, { overageInUse: true, text: 'two' }, { overageInUse: true, text: 'three' }] }]);
  const pi = load(paths, { confirm: [true, false] });
  await pi.emit('session_start');
  const messages: Message[] = [user('Hi')];
  const first = await turn(pi.providers[0]!, messages);
  assert.deepEqual(first.msg.content, [{ type: 'text', text: 'one' }]);
  messages.push(first.msg, user('more'));
  assert.deepEqual((await turn(pi.providers[0]!, messages)).msg.content, [{ type: 'text', text: 'two' }]);
  assert.equal(pi.shown.confirm.length, 1, 'asked once for the session');
  assert.equal(pi.shown.confirm[0]![0], 'Claude Extra Usage');
  assert.deepEqual(pi.shown.notify, [[EXTRA_USAGE_WARNING, 'warning'], [EXTRA_USAGE_WARNING, 'warning']]);
  const other = await turn(pi.providers[0]!, [user('new')], 'session-2');
  assert.equal(pi.shown.confirm.length, 2);
  assert.match(other.msg.errorMessage!, /not accepted for this session/);
  await pi.emit('session_shutdown');
});

test('extra usage: /claude-extra-usage allow-session accepts it for the current session without asking', async () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  install(paths, [{ steps: [{ overageInUse: true, text: 'billed' }] }]);
  const pi = load(paths);
  pi.setSession('session-9');
  await pi.commands.get('claude-extra-usage').handler('allow-session', pi.ctx);
  assert.deepEqual(pi.shown.notify.at(-1), ['Extra Usage is accepted for this pi session only, from the next Claude turn.', 'info']);
  const r = await turn(pi.providers[0]!, [user('Hi')], 'session-9');
  assert.deepEqual(r.msg.content, [{ type: 'text', text: 'billed' }]);
  assert.equal(pi.shown.confirm.length, 0);
  await pi.emit('session_shutdown');
});

test('commands print through pi\'s notifications and ask through its dialogs; a declined download downloads nothing', async () => {
  const paths = dataPaths(join(scratch('ppc-ext-'), 'data'));
  const pi = load(paths, { confirm: [false] });
  await pi.commands.get('claude-context').handler('on', pi.ctx);
  assert.deepEqual(pi.shown.notify, [["Claude Code context: on (Claude Code keeps its own system prompt and pi's is added to it); it applies from the next Claude turn.", 'info']]);
  await pi.commands.get('claude-login').handler('', pi.ctx);
  assert.equal(pi.shown.confirm[0]![0], 'Claude Code download');
  assert.match(pi.shown.confirm[0]![1], /^Claude Code 2\.1\.311 needs a one-time download of about 127 MB \(280 MB on disk\)\. Download it now\?$/);
  assert.deepEqual(pi.shown.notify.at(-1), ['Sign-in cancelled; nothing was downloaded.', 'info']);
  assert.equal(existsSync(paths.binDir), false);
});
