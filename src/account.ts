// Whether the owner is signed in to the extension's own Claude Code folder. Read-only: it never runs
// `claude auth status`, which writes `.claude.json` and `backups/` into the config folder.
import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataPaths } from './env.ts';

/**
 * Whether Claude Code's folder holds a sign-in, read from the file it keeps it in on Linux (`.credentials.json`, its
 * `claudeAiOauth` entry). Only whether a token is present is read; a link is never followed, and nothing of the file
 * is kept or logged.
 */
export function signedIn(paths: DataPaths): boolean {
  return signInState(paths) === true;
}

/** The sign-in, or `unknown` when the file is there but cannot be read or understood. */
export function signInState(paths: DataPaths): boolean | 'unknown' {
  let text: string;
  try {
    const fd = openSync(join(paths.configDir, '.credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { text = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unknown';
  }
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth;
    return nonEmpty(oauth?.accessToken) || nonEmpty(oauth?.refreshToken);
  } catch {
    return 'unknown';
  }
}

const nonEmpty = (value: unknown) => typeof value === 'string' && value !== '';
