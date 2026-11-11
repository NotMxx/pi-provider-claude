// The commands against the fake binary; nothing signs in or downloads the real Claude Code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { binaryPath, DownloadDeclined, ensureBinary } from '../src/binary.ts';
import { COMMANDS, printable, runCommand } from '../src/command.ts';
import { CLAUDE_CODE_VERSION, dataPaths, type DataPaths } from '../src/env.ts';
import { readClaudeSettings } from '../src/settings.ts';
import { fakeClaudeSource, fakePackage } from './fixtures/tarball.ts';
import { scratch as tempDir } from './fixtures/scratch.ts';

// No control or invisible characters but new lines and tabs, at most 8000 characters.
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

function scratch() {
  return dataPaths(tempDir('ppc-command-'));
}

function placeBinary(paths: DataPaths) {
  mkdirSync(join(paths.binDir, CLAUDE_CODE_VERSION), { recursive: true });
  writeFileSync(binaryPath(paths), fakeClaudeSource(), { mode: 0o700 });
}

function signIn(paths: DataPaths) {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
}

/** An owner that answers questions and confirmations from lists and records everything. */
function fakeOwner(answers: (string | null)[] = [], confirms: boolean[] = []) {
  const printed: string[] = [];
  const asked: string[] = [];
  const confirmed: string[] = [];
  return {
    printed,
    asked,
    confirmed,
    async print(text: string) {
      assert.ok(text.length <= 8000, 'print text too long');
      assert.doesNotMatch(text.replace(/\n/g, ''), UNSAFE);
      printed.push(text);
    },
    async ask(question: string) {
      assert.ok(question.length <= 200 && !question.includes('\n'));
      asked.push(question);
      return answers.shift() ?? null;
    },
    async confirm(question: string) {
      confirmed.push(question);
      return confirms.shift() ?? false;
    },
  };
}

/** Deps that place the fake binary instead of downloading, and record every process started. */
function fakeDeps(env: Record<string, string> = {}) {
  const spawned: { command: string; args: readonly string[]; options: any }[] = [];
  return {
    spawned,
    deps: {
      ensureBinary: (async (p: DataPaths, options?: { say?: (t: string) => void; confirm?: (q: string) => Promise<boolean> }) => {
        if (options?.confirm && !(await options.confirm('Download it now? (y/n)'))) throw new DownloadDeclined();
        options?.say?.(`Downloading Claude Code ${CLAUDE_CODE_VERSION} (linux-x64)…`);
        placeBinary(p);
        return binaryPath(p);
      }) as any,
      spawn: ((command: string, args: readonly string[], options: any) => {
        spawned.push({ command, args, options });
        return spawn(command, args, { ...options, env: { ...options.env, ...env } });
      }) as any,
    },
  };
}

test('login asks before the download, forwards the sign-in with its URL, asks for the code and returns its exit code', async () => {
  const paths = scratch();
  const owner = fakeOwner(['good-code'], [true]);
  const fake = fakeDeps();
  assert.equal(await runCommand('claude-login', '', owner, paths, fake.deps), 0);
  assert.deepEqual(owner.confirmed, ['Download it now? (y/n)']);
  assert.deepEqual(owner.asked, ['Paste the code from the browser:']);
  assert.deepEqual(owner.printed, [
    `Downloading Claude Code ${CLAUDE_CODE_VERSION} (linux-x64)…`,
    'Opening browser to sign in',
    "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true",
    'Login successful.',
  ]);
  assert.equal(fake.spawned.length, 1);
  const [call] = fake.spawned;
  assert.equal(call!.command, binaryPath(paths));
  assert.deepEqual(call!.args, ['auth', 'login']);
  assert.equal(call!.options.stdio, 'pipe');
  assert.equal(call!.options.env.CLAUDE_CONFIG_DIR, paths.configDir);
  assert.equal(statSync(paths.configDir).mode & 0o777, 0o700);
  assert.ok(existsSync(join(paths.configDir, '.credentials.json')));
});

test('login asks before downloading Claude Code with its size, and a no cancels it with nothing downloaded', async () => {
  const paths = scratch();
  const owner = fakeOwner([], [false]);
  const fake = fakeDeps();
  const pkg = fakePackage();
  const fetched: string[] = [];
  fake.deps.ensureBinary = ((p: DataPaths, options: object) => ensureBinary(p, {
    ...options, platform: 'linux-x64', pinned: { 'linux-x64': { integrity: pkg.integrity, bytes: 132_803_556, unpacked: 293_777_338 } },
    fetch: (async (url: string | URL) => { fetched.push(String(url)); return new Response(new Uint8Array(pkg.tgz)); }) as typeof fetch,
  })) as any;
  assert.equal(await runCommand('claude-login', '', owner, paths, fake.deps), 1);
  assert.deepEqual(owner.confirmed, [`Claude Code ${CLAUDE_CODE_VERSION} needs a one-time download of about 127 MB (280 MB on disk). Download it now? (y/n)`]);
  assert.deepEqual(owner.printed, ['Sign-in cancelled; nothing was downloaded.']);
  assert.deepEqual(fetched, []);
  assert.equal(existsSync(binaryPath(paths)), false);
  assert.equal(fake.spawned.length, 0);
});

test('login returns the failure of a wrong code', async () => {
  const paths = scratch();
  const owner = fakeOwner(['bad-code'], [true]);
  assert.equal(await runCommand('claude-login', '', owner, paths, fakeDeps().deps), 1);
  assert.equal(owner.printed.at(-1), 'Invalid code');
  assert.ok(!existsSync(join(paths.configDir, '.credentials.json')));
});

test('a cancelled login stops the sign-in and returns 1', async () => {
  const paths = scratch();
  const owner = fakeOwner([null], [true]);
  assert.equal(await runCommand('claude-login', '', owner, paths, fakeDeps({ FAKE_CLAUDE_LOGIN: 'hang' }).deps), 1);
  assert.deepEqual(owner.asked, ['Paste the code from the browser:']);
  assert.equal(owner.printed.at(-1), 'Sign-in cancelled.');
  assert.ok(!existsSync(join(paths.configDir, '.credentials.json')));
});

test('login reports a failed download and returns 1', async () => {
  const paths = scratch();
  const owner = fakeOwner();
  const fake = fakeDeps();
  fake.deps.ensureBinary = (async () => { throw new Error('The Claude Code download does not match its pin'); }) as any;
  assert.equal(await runCommand('claude-login', '', owner, paths, fake.deps), 1);
  assert.deepEqual(owner.printed, ['The Claude Code download does not match its pin']);
  assert.equal(fake.spawned.length, 0);
});

test('logout signs out and removes the config folder', async () => {
  const paths = scratch();
  placeBinary(paths);
  signIn(paths);
  const owner = fakeOwner();
  const fake = fakeDeps();
  assert.equal(await runCommand('claude-logout', '', owner, paths, fake.deps), 0);
  assert.deepEqual(fake.spawned.map((s) => s.args), [['auth', 'logout']]);
  assert.equal(fake.spawned[0]!.options.stdio, 'pipe');
  assert.ok(!existsSync(paths.configDir));
  assert.deepEqual(owner.printed, ['Successfully logged out from your Anthropic account.', 'Signed out; the Claude Code login is removed.']);
});

test('logout without the binary removes the config folder without running anything', async () => {
  const paths = scratch();
  signIn(paths);
  const owner = fakeOwner();
  const fake = fakeDeps();
  assert.equal(await runCommand('claude-logout', '', owner, paths, fake.deps), 0);
  assert.equal(fake.spawned.length, 0);
  assert.ok(!existsSync(paths.configDir));
  assert.deepEqual(owner.printed, ['Signed out; the Claude Code login is removed.']);
});

test('status shows the version, the sign-in, the settings (defaults: context off, extra usage ask) and the data folder', async () => {
  const paths = scratch();
  const owner = fakeOwner();
  const fake = fakeDeps();
  assert.equal(await runCommand('claude-status', '', owner, paths, fake.deps), 0);
  placeBinary(paths);
  signIn(paths);
  assert.equal(await runCommand('claude-status', '', owner, paths, fake.deps), 0);
  const settings = "Claude Code context: off (pi's system prompt replaces Claude Code's)\nExtra usage: ask (you are warned and asked; a yes holds for that pi session only)";
  assert.deepEqual(owner.printed, [
    `Claude Code ${CLAUDE_CODE_VERSION}: not downloaded yet\nSigned in: no\n${settings}\nData: ${paths.data}`,
    `Claude Code ${CLAUDE_CODE_VERSION}: downloaded\nSigned in: yes\n${settings}\nData: ${paths.data}`,
  ]);
  assert.equal(fake.spawned.length, 0);
});

test('context shows and switches the setting, off by default', async () => {
  const paths = dataPaths(join(tempDir('ppc-command-'), 'data'));
  const owner = fakeOwner();
  const fake = fakeDeps();
  assert.equal(await runCommand('claude-context', '', owner, paths, fake.deps), 0);
  assert.equal(await runCommand('claude-context', 'on', owner, paths, fake.deps), 0);
  assert.equal(readClaudeSettings(paths.data).claudeCodeContext, true);
  assert.equal(statSync(join(paths.data, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(await runCommand('claude-context', ' off ', owner, paths, fake.deps), 0);
  assert.equal(readClaudeSettings(paths.data).claudeCodeContext, false);
  assert.deepEqual(owner.printed, [
    'Claude Code context: off (pi\'s system prompt replaces Claude Code\'s)',
    'Claude Code context: on (Claude Code keeps its own system prompt and pi\'s is added to it); it applies from the next Claude turn.',
    'Claude Code context: off (pi\'s system prompt replaces Claude Code\'s); it applies from the next Claude turn.',
  ]);
});

test('extra-usage shows the mode (ask by default) and what each does, and sets strict, ask or allow without touching the context switch', async () => {
  const paths = dataPaths(join(tempDir('ppc-command-'), 'data'));
  const owner = fakeOwner();
  const fake = fakeDeps();
  assert.equal(readClaudeSettings(paths.data).extraUsage, 'ask', 'missing settings: ask');
  assert.equal(await runCommand('claude-extra-usage', '', owner, paths, fake.deps), 0);
  await runCommand('claude-context', 'on', owner, paths, fake.deps);
  assert.equal(await runCommand('claude-extra-usage', 'strict', owner, paths, fake.deps), 0);
  assert.deepEqual(readClaudeSettings(paths.data), { claudeCodeContext: true, extraUsage: 'strict' });
  assert.equal(await runCommand('claude-extra-usage', 'allow', owner, paths, fake.deps), 0);
  assert.equal(readClaudeSettings(paths.data).extraUsage, 'allow');
  writeFileSync(join(paths.data, 'settings.json'), '{"extraUsage":"sometimes"}');
  assert.equal(readClaudeSettings(paths.data).extraUsage, 'ask', 'an unknown mode reads as the default');
  assert.deepEqual(owner.printed.filter((t) => t.startsWith('Extra usage')), [
    'Extra usage: ask (you are warned and asked; a yes holds for that pi session only)\n\nModes:\n' +
    '  strict (a turn billed to Extra Usage is stopped, never let through)\n' +
    '  ask (you are warned and asked; a yes holds for that pi session only)\n' +
    '  allow (a turn billed to Extra Usage goes on, with a warning every time)\n' +
    '  allow-session accepts Extra Usage for this pi session only (with the ask mode)',
    'Extra usage: strict (a turn billed to Extra Usage is stopped, never let through); it applies from the next Claude turn.',
    'Extra usage: allow (a turn billed to Extra Usage goes on, with a warning every time); it applies from the next Claude turn.',
  ]);
});

test('extra-usage allow-session accepts Extra Usage for the current pi session only, in memory', async () => {
  const paths = dataPaths(join(tempDir('ppc-command-'), 'data'));
  const owner = fakeOwner();
  const allowed: string[] = [];
  const deps = { ...fakeDeps().deps, allowSession: (s: string) => allowed.push(s) };
  assert.equal(await runCommand('claude-extra-usage', 'allow-session', owner, paths, deps, 'session-1'), 0);
  assert.deepEqual(allowed, ['session-1']);
  assert.equal(existsSync(join(paths.data, 'settings.json')), false, 'nothing is saved');
  assert.deepEqual(owner.printed, ['Extra Usage is accepted for this pi session only, from the next Claude turn.']);
});

test('wrong arguments print the command\'s usage and return 2', async () => {
  for (const [name, args] of [['claude-context', 'maybe'], ['claude-login', 'now'], ['claude-extra-usage', 'sometimes'], ['claude-status', 'x']] as const) {
    const owner = fakeOwner();
    assert.equal(await runCommand(name, args, owner, scratch(), fakeDeps().deps), 2);
    const { args: usage, text } = COMMANDS[name];
    assert.deepEqual(owner.printed, [`Usage: /${name}${usage ? ` ${usage}` : ''}  ${text}`]);
  }
});

test('printable strips escapes and control characters and splits long text', () => {
  assert.deepEqual(printable('\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07ok​\tx\x00'), ['red\nok\tx']);
  const parts = printable('a'.repeat(20_000));
  assert.deepEqual(parts.map((p) => p.length), [8000, 8000, 4000]);
});
