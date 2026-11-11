// The warm process wrapper on its own, against tiny stand-in binaries.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ClaudeProcess } from '../../src/provider/claude-process.ts';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'ppc-process-'));
  roots.push(root);
  return root;
}

function launch(script: string) {
  const root = scratch();
  const claudePath = join(root, 'claude');
  writeFileSync(claudePath, `#!/bin/sh\n${script}\n`);
  chmodSync(claudePath, 0o755);
  return new ClaudeProcess({ claudePath, env: { PATH: process.env.PATH ?? '' }, model: 'm', systemPrompt: 'p', tools: [], cwd: root, runDir: root });
}

test('each wait for the next event removes its abort listener once it resolves', { timeout: 10_000 }, async () => {
  const proc = launch(`for i in 1 2 3 4 5; do sleep 0.05; echo '{"type":"tick"}'; done; cat >/dev/null`);
  const controller = new AbortController();
  try {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await proc.next(controller.signal), { type: 'tick' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0, `no listener left after wait ${i + 1}`);
    }
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('an abort still ends a wait', { timeout: 10_000 }, async () => {
  const proc = launch('cat >/dev/null');
  const controller = new AbortController();
  try {
    const waiting = proc.next(controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await assert.rejects(waiting, /stop/);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('a binary that cannot be started ends the process with an exit event instead of an unhandled error', { timeout: 10_000 }, async () => {
  const root = scratch();
  const proc = new ClaudeProcess({ claudePath: join(root, 'missing'), env: {}, model: 'm', systemPrompt: 'p', tools: [], cwd: root, runDir: root });
  await assert.rejects(proc.ready, /claude refused to start/);
  await proc.exited;
  assert.equal(proc.alive, false);
  const event = await proc.next();
  assert.equal(event.type, 'exit');
  assert.equal(event.code, 'ENOENT');
  assert.equal(await proc.next(), undefined);
});

test('a process that ignores the interrupt is killed after the grace period', { timeout: 10_000 }, async () => {
  const proc = launch(`trap '' TERM; while true; do sleep 0.05; done`);
  proc.graceMs = 100;
  const started = Date.now();
  await proc.stop();
  assert.equal(proc.alive, false);
  assert.ok(Date.now() - started < 5_000, 'stopped within the grace period, not the default 10 s');
});
