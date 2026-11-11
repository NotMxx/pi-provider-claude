// The extension in a real pi (S1, S5): `PI_CLI` names a pi CLI (its dist/bundle/cli.js), and the test loads the
// extension there with -e, lists its models and runs a turn whose answer calls pi's `read` tool, against the fake
// Claude Code in a throwaway home. Skipped without `PI_CLI`; CI runs it on the oldest and newest pi it supports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CLAUDE_CODE_VERSION } from '../../src/env.ts';

const run = promisify(execFile);
const cli = process.env.PI_CLI;
const root = join(import.meta.dirname, '..', '..');

test('a real pi loads the extension, lists its models and runs a turn with a tool call', { skip: !cli && 'PI_CLI is not set', timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ppc-e2e-'));
  try {
    const data = join(home, 'data');
    const bin = join(data, 'bin', CLAUDE_CODE_VERSION);
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(data, 'claude-code'), { recursive: true });
    // The pinned binary's place holds the fake: it answers --version like Claude Code and runs the scripted turn.
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLAUDE_CODE_VERSION} (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${join(root, 'test', 'fixtures', 'fake-claude.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'claude'), 0o700);
    writeFileSync(join(data, 'claude-code', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-not-real' } }), { mode: 0o600 });
    writeFileSync(join(data, 'claude-code', 'script.json'), JSON.stringify([{ steps: [{ toolCalls: [{ name: 'read', args: { path: 'package.json' } }] }, { text: 'TOOL-TURN-OK' }] }]));
    const env = { ...process.env, HOME: home, TMPDIR: home, PI_PROVIDER_CLAUDE_DATA: data };
    // stdin is closed at once: in print mode pi reads piped input before it answers.
    const pi = (...args: string[]) => {
      const running = run(process.execPath, [cli!, '-ne', '-e', './src/extension.ts', ...args], { cwd: root, env, timeout: 90_000 });
      running.child.stdin?.end();
      return running;
    };

    const models = (await pi('--list-models')).stdout;
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.match(models, new RegExp(`claude-subscription\\s+${id}\\b`));

    const turn = await pi('--model', 'claude-subscription/claude-opus-5-5', '-p', 'read package.json');
    assert.match(turn.stdout, /TOOL-TURN-OK/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
