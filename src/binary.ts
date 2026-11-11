// The pinned Claude Code binary, downloaded only when the owner says yes from `/claude-login`: the platform package's
// tarball from the npm registry, checked against the integrity pinned here, its one binary extracted with a minimal tar
// reader, checked to report the pin, then moved into place. Nothing half-written is ever left behind.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { CLAUDE_CODE_VERSION, claudeEnv, type DataPaths } from './env.ts';

const run = promisify(execFile);
const unzip = promisify(gunzip);

/**
 * npm's `dist.integrity` of `@anthropic-ai/claude-code-<platform>@2.1.311`, a hash of the .tgz bytes, with the size of
 * that .tgz (the registry's Content-Range) and npm's `dist.unpackedSize`, which the owner sees before the download.
 */
export const PINNED: Record<string, { integrity: string; bytes?: number; unpacked?: number }> = {
  'linux-x64': { integrity: 'sha512-dk1lVMt7n+NlYucKM7dLp/PfrK32pa/4oKQkacfazlSj8rG+hkH67wnDnaFG9Gs2al3OjK8PTVHgZ2WGHXoWUg==', bytes: 132_803_556, unpacked: 293_777_338 },
  'linux-arm64': { integrity: 'sha512-yZwDmtXmoZcFcCjCaoznOKqjrjjdQyc6PVuh6brANqQcaKpP+WZGuFlgUjgQh86u8HBybHZBB60WWOumKpO6uQ==', bytes: 133_363_615, unpacked: 293_659_402 },
};

const MAX_BYTES = 400 * 1024 * 1024;
// The unpacked package; the binary alone is under 300 MB.
const MAX_UNPACKED = 1024 * 1024 * 1024;
const ENTRY = 'package/claude';

/** Whether this Linux runs on musl: glibc builds of Node report the glibc version they run on. */
function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return !report.header?.glibcVersionRuntime;
}

/** The suffix of `@anthropic-ai/claude-code-<platform>`: x64 or arm64 Linux on glibc. */
export function claudePlatform(platform: string = process.platform, arch: string = process.arch, musl: boolean = isMusl()): string {
  const name = `${platform}-${arch}${musl ? '-musl' : ''}`;
  if (!musl && Object.hasOwn(PINNED, name)) return name;
  throw new Error(`Claude Code is not available for ${name}; this extension supports ${Object.keys(PINNED).join(', ')}`);
}

export function binaryPath(paths: DataPaths): string {
  return join(paths.binDir, CLAUDE_CODE_VERSION, 'claude');
}

export interface EnsureOptions {
  fetch?: typeof fetch;
  platform?: string;
  pinned?: typeof PINNED;
  say?: (text: string) => void;
  /** Asked before a download, with its size; false downloads nothing and throws `DownloadDeclined`. */
  confirm?: (question: string) => Promise<boolean>;
  /** The largest download accepted (default 400 MB); tests lower it. */
  maxBytes?: number;
  /** How long the download may take before it is given up (default 10 minutes). */
  downloadTimeoutMs?: number;
}

const DOWNLOAD_MS = 10 * 60_000;
// The version each binary file last answered with, so it is not run again for every cold start or status poll. Only a
// good answer is kept: a check that failed for a passing reason is tried again.
const answered = new Map<string, { file: string; version: string }>();

/** The version the binary at `bin` reports, run again only when the file changed or its last check failed. */
export async function checkedVersion(paths: DataPaths, bin: string): Promise<string | undefined> {
  const { ino, size, mtimeMs } = statSync(bin);
  const file = `${ino}:${size}:${mtimeMs}`;
  const last = answered.get(bin);
  if (last?.file === file) return last.version;
  const version = await reportedVersion(bin, paths);
  if (version !== undefined) answered.set(bin, { file, version });
  return version;
}

/** The version `bin` reports, or undefined when it does not run or answers something else. */
export async function reportedVersion(bin: string, paths: DataPaths): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await run(bin, ['--version'], { env: claudeEnv(paths), timeout: 15_000 });
      return /^(\S+) \(Claude Code\)/.exec(stdout.trim())?.[1];
    } catch (error) {
      // A file just written can be busy for a moment while another thread forks.
      if ((error as NodeJS.ErrnoException).code === 'ETXTBSY' && attempt < 5) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      return undefined;
    }
  }
}

/** The pinned binary's path when it is in place and reports the pin; never downloads (the model's turns use this). */
export async function installedBinary(paths: DataPaths): Promise<string | undefined> {
  const bin = binaryPath(paths);
  if (!existsSync(bin)) return undefined;
  return (await checkedVersion(paths, bin)) === CLAUDE_CODE_VERSION ? bin : undefined;
}

/** The owner said no to the download. */
export class DownloadDeclined extends Error {
  constructor() {
    super('The Claude Code download was declined');
  }
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** The question asked before a download: what it is and how large. */
function downloadQuestion(pin: { bytes?: number; unpacked?: number }): string {
  const size = pin.bytes ? ` of about ${mb(pin.bytes)} MB${pin.unpacked ? ` (${mb(pin.unpacked)} MB on disk)` : ''}` : '';
  return `Claude Code ${CLAUDE_CODE_VERSION} needs a one-time download${size}. Download it now? (y/n)`;
}

const inFlight = new Map<string, Promise<string>>();

/** The pinned binary's path, downloading it first when it is missing or reports another version. */
export function ensureBinary(paths: DataPaths, options: EnsureOptions = {}): Promise<string> {
  const bin = binaryPath(paths);
  let pending = inFlight.get(bin);
  if (!pending) {
    pending = ensure(paths, bin, options).finally(() => inFlight.delete(bin));
    inFlight.set(bin, pending);
  }
  return pending;
}

async function ensure(paths: DataPaths, bin: string, options: EnsureOptions): Promise<string> {
  if (existsSync(bin) && (await checkedVersion(paths, bin)) === CLAUDE_CODE_VERSION) return bin;
  const platform = options.platform ?? claudePlatform();
  const pin = (options.pinned ?? PINNED)[platform];
  if (!pin) throw new Error(`There is no pinned Claude Code for ${platform}`);
  if (options.confirm && !(await options.confirm(downloadQuestion(pin)))) throw new DownloadDeclined();
  const say = options.say ?? (() => {});
  say(`Downloading Claude Code ${CLAUDE_CODE_VERSION} (${platform})…`);
  const tgz = await download(packageUrl(platform), options.fetch ?? fetch, options.maxBytes ?? MAX_BYTES, options.downloadTimeoutMs ?? DOWNLOAD_MS);
  const actual = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  if (actual !== pin.integrity) throw new Error(`The Claude Code download does not match its pin: expected ${pin.integrity}, got ${actual}`);
  const binary = extract(await unzip(tgz, { maxOutputLength: MAX_UNPACKED }), ENTRY);
  await install(paths, bin, binary);
  say(`Claude Code ${CLAUDE_CODE_VERSION} is ready.`);
  return bin;
}

function packageUrl(platform: string): string {
  const name = `claude-code-${platform}`;
  return `https://registry.npmjs.org/@anthropic-ai/${name}/-/${name}-${CLAUDE_CODE_VERSION}.tgz`;
}

async function download(url: string, fetcher: typeof fetch, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  // A stalled registry or proxy would otherwise hold every turn that waits on this download.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchCapped(url, fetcher, maxBytes, signal);
  } catch (error) {
    if (signal.aborted) throw new Error(`The Claude Code download took longer than ${Math.round(timeoutMs / 60_000)} minutes; try again`);
    throw error;
  }
}

async function fetchCapped(url: string, fetcher: typeof fetch, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const tooLarge = () => new Error(`The Claude Code download is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`);
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error(`Could not download Claude Code from ${url}: ${response.status} ${response.statusText}`.trim());
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/** The bytes of regular file `wanted` in a tar archive: ustar headers in 512-byte blocks, pax paths honoured. */
export function extract(archive: Buffer, wanted: string): Buffer {
  let offset = 0;
  let paxPath: string | undefined;
  for (;;) {
    if (offset + 512 > archive.length) throw new Error('The Claude Code package is truncated');
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!);
    const start = offset + 512;
    if (start + size > archive.length) throw new Error('The Claude Code package is truncated');
    const body = archive.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
      continue;
    }
    const prefix = text(header.subarray(345, 500));
    const name = paxPath ?? (prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    paxPath = undefined;
    if (name === wanted && (type === '0' || type === '\0')) return body;
  }
  throw new Error(`The Claude Code package has no ${wanted}`);
}

function text(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

/** A size field: octal digits, or base-256 when its first byte has the high bit set. */
function octal(field: Buffer): number {
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const digits = text(field).trim();
  if (!/^[0-7]*$/.test(digits)) throw new Error('The Claude Code package has a malformed header');
  return digits ? parseInt(digits, 8) : 0;
}

/** How old a temp file must be before an install removes it as left behind by a crash. */
const STALE_MS = 3600_000;

/** Writes the binary beside its place, checks it, moves it in and removes every other version. */
async function install(paths: DataPaths, bin: string, binary: Buffer): Promise<void> {
  await mkdir(paths.binDir, { recursive: true, mode: 0o700 });
  const temp = join(paths.binDir, `.claude-${process.pid}-${randomBytes(4).toString('hex')}`);
  const folder = dirname(bin);
  let made = false;
  try {
    await writeFile(temp, binary, { mode: 0o700, flag: 'wx' });
    await chmod(temp, 0o700);
    const version = await reportedVersion(temp, paths);
    if (version !== CLAUDE_CODE_VERSION) throw new Error(`The downloaded Claude Code reports ${version ?? 'no version'}, expected ${CLAUDE_CODE_VERSION}`);
    made = !existsSync(folder);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await rename(temp, bin);
  } catch (error) {
    await rm(temp, { force: true });
    if (made) await rm(folder, { recursive: true, force: true });
    throw error;
  }
  for (const entry of await readdir(paths.binDir, { withFileTypes: true })) {
    const path = join(paths.binDir, entry.name);
    if (entry.isDirectory() && entry.name !== CLAUDE_CODE_VERSION) await rm(path, { recursive: true, force: true });
    // A download that crashed left its temp file; one younger than this may still be another process's.
    else if (entry.isFile() && entry.name.startsWith('.claude-') && Date.now() - (await stat(path)).mtimeMs > STALE_MS) await rm(path, { force: true });
  }
}
