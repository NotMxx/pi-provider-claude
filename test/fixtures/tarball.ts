// Builds a fake platform package (.tgz) by hand: ustar headers, 512-byte blocks, gzip, and its SRI sha512.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export const FAKE_CLAUDE = new URL('./fake-claude-bin.mjs', import.meta.url);

/** The fake binary's source, reporting `version`. */
export function fakeClaudeSource(version = '2.1.311'): string {
  return readFileSync(FAKE_CLAUDE, 'utf8').replace("const VERSION = '2.1.311'", `const VERSION = '${version}'`);
}

export interface Entry { name: string; body: string | Buffer; type?: string; prefix?: string }

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, 'utf8');
  block.write('0000755\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('00000000000\0', 136);
  block.write(entry.type ?? '0', 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  if (entry.prefix) block.write(entry.prefix, 345, 155, 'utf8');
  block.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}

/** A tar archive of `entries`, ending with two zero blocks. */
export function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body);
    parts.push(header(entry, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** A gzipped package holding `package/claude` (the fake, reporting `version`) unless other entries are given. */
export function fakePackage(options: { version?: string; entries?: Entry[] } = {}): { tgz: Buffer; integrity: string } {
  const entries = options.entries ?? [
    { name: 'package/package.json', body: '{"name":"@anthropic-ai/claude-code-linux-x64"}\n' },
    { name: 'package/claude', body: fakeClaudeSource(options.version) },
  ];
  const tgz = gzipSync(tar(entries));
  return { tgz, integrity: sri(tgz) };
}
