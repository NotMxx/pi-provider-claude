import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { binaryPath, DownloadDeclined, claudePlatform, ensureBinary, installedBinary, PINNED } from '../src/binary.ts';
import { CLAUDE_CODE_VERSION, dataPaths } from '../src/env.ts';
import { fakeClaudeSource, fakePackage, tar } from './fixtures/tarball.ts';
import { gzipSync } from 'node:zlib';
import { scratch as tempDir } from './fixtures/scratch.ts';

const URL_X64 = `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz`;

function scratch() {
  return dataPaths(tempDir('ppc-binary-'));
}

/** A fetch that answers `body` and records every URL it was asked for. */
function stubFetch(body: Buffer | (() => Response)) {
  const urls: string[] = [];
  const fetch = (async (url: string | URL) => {
    urls.push(String(url));
    await new Promise((r) => setTimeout(r, 20));
    return typeof body === 'function' ? body() : new Response(new Uint8Array(body));
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

const pinned = (integrity: string) => ({ 'linux-x64': { integrity } });

test('PINNED holds the npm integrity of both Linux packages of Claude Code 2.1.311', () => {
  assert.equal(CLAUDE_CODE_VERSION, '2.1.311');
  assert.equal(PINNED['linux-x64']!.integrity, 'sha512-dk1lVMt7n+NlYucKM7dLp/PfrK32pa/4oKQkacfazlSj8rG+hkH67wnDnaFG9Gs2al3OjK8PTVHgZ2WGHXoWUg==');
  assert.equal(PINNED['linux-arm64']!.integrity, 'sha512-yZwDmtXmoZcFcCjCaoznOKqjrjjdQyc6PVuh6brANqQcaKpP+WZGuFlgUjgQh86u8HBybHZBB60WWOumKpO6uQ==');
  assert.deepEqual(Object.keys(PINNED).sort(), ['linux-arm64', 'linux-x64']);
  for (const pin of Object.values(PINNED)) assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
});

test('claudePlatform names x64 and arm64 Linux and refuses anything else', () => {
  assert.equal(claudePlatform('linux', 'x64', false), 'linux-x64');
  assert.equal(claudePlatform('linux', 'arm64', false), 'linux-arm64');
  assert.throws(() => claudePlatform('darwin', 'arm64', false), /darwin-arm64.*linux-x64, linux-arm64/);
  assert.throws(() => claudePlatform('linux', 'x64', true), /musl.*linux-x64, linux-arm64/);
});

test('binaryPath is the pinned version folder under binDir', () => {
  const paths = dataPaths('/data');
  assert.equal(binaryPath(paths), `/data/bin/${CLAUDE_CODE_VERSION}/claude`);
});

test('ensureBinary downloads, checks and installs the pinned binary, removing other versions', async () => {
  const paths = scratch();
  mkdirSync(join(paths.binDir, '2.1.200'), { recursive: true });
  writeFileSync(join(paths.binDir, '2.1.200', 'claude'), 'old');
  const pkg = fakePackage();
  const { fetch, urls } = stubFetch(pkg.tgz);
  const said: string[] = [];
  const bin = await ensureBinary(paths, { fetch, platform: 'linux-x64', pinned: pinned(pkg.integrity), say: (t) => said.push(t) });
  assert.equal(bin, binaryPath(paths));
  assert.deepEqual(urls, [URL_X64]);
  assert.equal(statSync(bin).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(paths.binDir), [CLAUDE_CODE_VERSION]);
  assert.deepEqual(readdirSync(join(paths.binDir, CLAUDE_CODE_VERSION)), ['claude']);
  assert.deepEqual(said, [`Downloading Claude Code ${CLAUDE_CODE_VERSION} (linux-x64)…`, `Claude Code ${CLAUDE_CODE_VERSION} is ready.`]);
});

test('an install removes a crashed download\'s temp file, but not one another process may still be writing', async () => {
  const paths = scratch();
  mkdirSync(paths.binDir, { recursive: true });
  const stale = join(paths.binDir, '.claude-1-dead');
  const fresh = join(paths.binDir, '.claude-2-busy');
  writeFileSync(stale, 'partial');
  writeFileSync(fresh, 'partial');
  const hourAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(stale, hourAgo, hourAgo);
  const pkg = fakePackage();
  await ensureBinary(paths, { fetch: stubFetch(pkg.tgz).fetch, platform: 'linux-x64', pinned: pinned(pkg.integrity) });
  assert.deepEqual(readdirSync(paths.binDir).sort(), ['.claude-2-busy', CLAUDE_CODE_VERSION]);
});

test('ensureBinary gives up on a download that stalls', async () => {
  const paths = scratch();
  const pkg = fakePackage();
  // A body that never ends, unless the request is cancelled.
  const stalled = (async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
    start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason)); },
  }))) as typeof fetch;
  await assert.rejects(ensureBinary(paths, { fetch: stalled, platform: 'linux-x64', pinned: pinned(pkg.integrity), downloadTimeoutMs: 50 }),
    { message: 'The Claude Code download took longer than 0 minutes; try again' });
  assert.equal(existsSync(binaryPath(paths)), false);
});

test('a binary that already answered with the pinned version is not run again until it changes', async () => {
  const paths = scratch();
  mkdirSync(join(paths.binDir, CLAUDE_CODE_VERSION), { recursive: true });
  const runs = join(paths.data, 'runs');
  writeFileSync(binaryPath(paths), `#!/bin/sh\necho x >> '${runs}'\necho "${CLAUDE_CODE_VERSION} (Claude Code)"\n`, { mode: 0o700 });
  for (let i = 0; i < 3; i++) await ensureBinary(paths, { fetch: stubFetch(Buffer.alloc(0)).fetch, platform: 'linux-x64' });
  assert.equal(readFileSync(runs, 'utf8'), 'x\n');
});

test('ensureBinary keeps a good binary without fetching', async () => {
  const paths = scratch();
  mkdirSync(join(paths.binDir, CLAUDE_CODE_VERSION), { recursive: true });
  writeFileSync(binaryPath(paths), fakeClaudeSource(), { mode: 0o700 });
  const fetch = (async () => { throw new Error('no fetch expected'); }) as typeof globalThis.fetch;
  const said: string[] = [];
  assert.equal(await ensureBinary(paths, { fetch, platform: 'linux-x64', say: (t) => said.push(t) }), binaryPath(paths));
  assert.deepEqual(said, []);
});

test('ensureBinary replaces a binary at the pin that reports another version', async () => {
  const paths = scratch();
  mkdirSync(join(paths.binDir, CLAUDE_CODE_VERSION), { recursive: true });
  writeFileSync(binaryPath(paths), fakeClaudeSource('2.1.1'), { mode: 0o700 });
  const pkg = fakePackage();
  const { fetch, urls } = stubFetch(pkg.tgz);
  await ensureBinary(paths, { fetch, platform: 'linux-x64', pinned: pinned(pkg.integrity) });
  assert.equal(urls.length, 1);
});

test('concurrent ensures share one download', async () => {
  const paths = scratch();
  const pkg = fakePackage();
  const { fetch, urls } = stubFetch(pkg.tgz);
  const options = { fetch, platform: 'linux-x64', pinned: pinned(pkg.integrity) };
  const [a, b, c] = await Promise.all([ensureBinary(paths, options), ensureBinary(paths, options), ensureBinary(paths, options)]);
  assert.equal(urls.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.ok(existsSync(a));
});

/** Asserts that a failed ensure left nothing in binDir. */
async function refuses(paths: ReturnType<typeof scratch>, options: Parameters<typeof ensureBinary>[1], message: RegExp) {
  await assert.rejects(ensureBinary(paths, options), message);
  assert.deepEqual(existsSync(paths.binDir) ? readdirSync(paths.binDir) : [], []);
}

test('ensureBinary refuses bytes that do not match the pin, naming both hashes', async () => {
  const paths = scratch();
  const pkg = fakePackage();
  const { fetch } = stubFetch(pkg.tgz);
  const expected = PINNED['linux-x64']!.integrity;
  const message = new RegExp(`expected ${expected.replace(/[+/]/g, '\\$&')}.*got ${pkg.integrity.replace(/[+/]/g, '\\$&')}`);
  await refuses(paths, { fetch, platform: 'linux-x64' }, message);
});

test('ensureBinary refuses a body over the limit, by its length or as it streams', async () => {
  const paths = scratch();
  const big = stubFetch(() => new Response('x', { headers: { 'content-length': String(401 * 1024 * 1024) } }));
  await refuses(paths, { fetch: big.fetch, platform: 'linux-x64' }, /larger than 400 MB/);
  const stream = stubFetch(() => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024)); },
  })));
  await refuses(paths, { fetch: stream.fetch, platform: 'linux-x64', maxBytes: 64 * 1024 }, /larger than 0 MB/);
});

test('ensureBinary refuses a failed download', async () => {
  const paths = scratch();
  const { fetch } = stubFetch(() => new Response('nope', { status: 404, statusText: 'Not Found' }));
  await refuses(paths, { fetch, platform: 'linux-x64' }, /404/);
});

test('ensureBinary refuses a package without package/claude', async () => {
  const paths = scratch();
  const pkg = fakePackage({ entries: [{ name: 'package/package.json', body: '{}' }] });
  const { fetch } = stubFetch(pkg.tgz);
  await refuses(paths, { fetch, platform: 'linux-x64', pinned: pinned(pkg.integrity) }, /no package\/claude/);
});

test('ensureBinary refuses a truncated archive', async () => {
  const paths = scratch();
  const whole = tar([{ name: 'package/claude', body: fakeClaudeSource() }]);
  const tgz = gzipSync(whole.subarray(0, 700));
  const { sri } = await import('./fixtures/tarball.ts');
  const { fetch } = stubFetch(tgz);
  await refuses(paths, { fetch, platform: 'linux-x64', pinned: pinned(sri(tgz)) }, /truncated/);
});

test('ensureBinary finds the binary under a ustar prefix', async () => {
  const paths = scratch();
  const { sri } = await import('./fixtures/tarball.ts');
  const tgz = gzipSync(tar([{ prefix: 'package', name: 'claude', body: fakeClaudeSource() }]));
  const { fetch } = stubFetch(tgz);
  assert.ok(existsSync(await ensureBinary(paths, { fetch, platform: 'linux-x64', pinned: pinned(sri(tgz)) })));
});

test('ensureBinary refuses a binary that reports another version', async () => {
  const paths = scratch();
  const pkg = fakePackage({ version: '2.1.299' });
  const { fetch } = stubFetch(pkg.tgz);
  await refuses(paths, { fetch, platform: 'linux-x64', pinned: pinned(pkg.integrity) }, /reports 2\.1\.299, expected 2\.1\.311/);
});

test('ensureBinary refuses a platform without a pin', async () => {
  const paths = scratch();
  const { fetch, urls } = stubFetch(Buffer.alloc(0));
  await refuses(paths, { fetch, platform: 'linux-x64', pinned: {} }, /no pinned Claude Code for linux-x64/);
  assert.deepEqual(urls, []);
});

test('ensureBinary asks before a download, with its size, and downloads nothing on a no', async () => {
  const paths = scratch();
  const pkg = fakePackage();
  const { fetch, urls } = stubFetch(pkg.tgz);
  const asked: string[] = [];
  const pins = { 'linux-x64': { integrity: pkg.integrity, bytes: 129_023_077, unpacked: 285_810_498 } };
  await assert.rejects(ensureBinary(paths, { fetch, platform: 'linux-x64', pinned: pins, confirm: async (q) => { asked.push(q); return false; } }), DownloadDeclined);
  assert.deepEqual(asked, [`Claude Code ${CLAUDE_CODE_VERSION} needs a one-time download of about 123 MB (273 MB on disk). Download it now? (y/n)`]);
  assert.deepEqual(urls, []);
  assert.equal(existsSync(binaryPath(paths)), false);

  // A yes downloads it; once it is in place, nothing asks again.
  await ensureBinary(paths, { fetch, platform: 'linux-x64', pinned: pins, confirm: async (q) => { asked.push(q); return true; } });
  assert.deepEqual(urls, [URL_X64]);
  await ensureBinary(paths, { fetch, platform: 'linux-x64', pinned: pins, confirm: async (q) => { asked.push(q); return true; } });
  assert.equal(asked.length, 2);
});

test('PINNED holds the download and unpacked sizes of both Linux packages', () => {
  assert.deepEqual(PINNED['linux-x64']!.bytes, 132_803_556);
  assert.deepEqual(PINNED['linux-arm64']!.bytes, 133_363_615);
  assert.deepEqual(PINNED['linux-x64']!.unpacked, 293_777_338);
  assert.deepEqual(PINNED['linux-arm64']!.unpacked, 293_659_402);
});

test('installedBinary finds the pinned binary without downloading, and nothing for a missing or other-version binary', async () => {
  const paths = scratch();
  assert.equal(await installedBinary(paths), undefined);
  assert.equal(existsSync(paths.binDir), false, 'looking creates nothing');
  mkdirSync(join(paths.binDir, CLAUDE_CODE_VERSION), { recursive: true });
  writeFileSync(binaryPath(paths), fakeClaudeSource('2.1.1'), { mode: 0o700 });
  assert.equal(await installedBinary(paths), undefined);
  writeFileSync(binaryPath(paths) + '.new', fakeClaudeSource(), { mode: 0o700 });
  const { renameSync } = await import('node:fs');
  renameSync(binaryPath(paths) + '.new', binaryPath(paths));
  assert.equal(await installedBinary(paths), binaryPath(paths));
});
