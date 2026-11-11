// The pi commands: `/claude-login`, `/claude-logout`, `/claude-status`, `/claude-context [on|off]` and
// `/claude-extra-usage [strict|ask|allow|allow-session]`.
// Everything the owner sees goes through `owner.print` and every answer comes from `owner.ask` or
// `owner.confirm` (pi's `ctx.ui`), so the extension never drives the terminal: Claude Code's sign-in runs with piped
// stdio, its output is cleaned and forwarded, and its code prompt becomes a question.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { signedIn } from './account.ts';
import { binaryPath, DownloadDeclined, ensureBinary as nodeEnsureBinary } from './binary.ts';
import { CLAUDE_CODE_VERSION, claudeEnv, type DataPaths } from './env.ts';
import { EXTRA_USAGE_MODES, readClaudeSettings, writeClaudeSettings, type ClaudeSettings, type ExtraUsageMode } from './settings.ts';

export interface Owner {
  print(text: string): Promise<void>;
  /** A free-text answer, or null when the owner cancels or cannot be asked. */
  ask(question: string): Promise<string | null>;
  /** A yes or no; false when the owner cannot be asked. */
  confirm(question: string): Promise<boolean>;
}

export interface CommandDeps {
  ensureBinary?: typeof nodeEnsureBinary;
  spawn?: typeof nodeSpawn;
  /** Accepts Extra Usage for one pi session (`/claude-extra-usage allow-session`), in memory only. */
  allowSession?: (session: string) => void;
  /** The Extra Usage mode was changed: past declines no longer hold. */
  extraUsageChanged?: () => void;
}

/** The commands with what they take, as pi lists them. */
export const COMMANDS = {
  'claude-login': { args: '', text: 'Download the pinned Claude Code (asks first) and sign in to your Claude subscription' },
  'claude-logout': { args: '', text: 'Sign out and forget the Claude Code login' },
  'claude-status': { args: '', text: 'Show Claude Code\'s version, whether you are signed in, and the settings' },
  'claude-context': { args: '[on|off]', text: 'Keep Claude Code\'s own system prompt under pi\'s, or not (default off)' },
  'claude-extra-usage': { args: '[strict|ask|allow|allow-session]', text: 'What a turn billed to Extra Usage does (default ask)' },
} as const;
export type CommandName = keyof typeof COMMANDS;

const PRINT_MAX = 8000;
const PROMPT = /Paste code here if prompted\s*>\s*$/;
const CONTEXT = {
  on: 'on (Claude Code keeps its own system prompt and pi\'s is added to it)',
  off: 'off (pi\'s system prompt replaces Claude Code\'s)',
};
const EXTRA_USAGE: Record<ExtraUsageMode, string> = {
  strict: 'strict (a turn billed to Extra Usage is stopped, never let through)',
  ask: 'ask (you are warned and asked; a yes holds for that pi session only)',
  allow: 'allow (a turn billed to Extra Usage goes on, with a warning every time)',
};

// Terminal escape sequences (CSI, OSC, then any other ESC pair), and control or invisible characters besides new lines
// and tabs.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** `text` as `owner.print` takes it: no escapes or unsafe characters, in parts of at most 8000 characters. */
export function printable(text: string): string[] {
  let clean = text.replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(UNSAFE, '').replace(/\n+$/, '');
  const parts: string[] = [];
  while (clean.length > PRINT_MAX) {
    let cut = clean.lastIndexOf('\n', PRINT_MAX);
    if (cut <= 0) cut = /[\ud800-\udbff]/.test(clean[PRINT_MAX - 1]!) ? PRINT_MAX - 1 : PRINT_MAX;
    parts.push(clean.slice(0, cut));
    clean = clean.slice(clean[cut] === '\n' ? cut + 1 : cut);
  }
  if (clean.trim()) parts.push(clean);
  return parts;
}

/** Prints and questions in order; a refused print does not stop the command. */
function speaker(owner: Owner) {
  let queue: Promise<unknown> = Promise.resolve();
  const then = <T>(step: () => Promise<T>): Promise<T> => {
    const next = queue.then(step);
    queue = next.catch(() => {});
    return next;
  };
  const oneLine = (question: string) => question.replace(/[\r\n]+/g, ' ').slice(0, 200);
  return {
    say: (text: string) => { for (const part of printable(text)) void then(() => owner.print(part)).catch(() => {}); },
    ask: (question: string) => then(() => owner.ask(oneLine(question))),
    confirm: (question: string) => then(() => owner.confirm(question)),
    drained: () => queue,
  };
}

/** Runs the binary with piped stdio, forwarding its output line by line; the code prompt calls `onPrompt`. */
function runClaude(bin: string, args: string[], paths: DataPaths, out: ReturnType<typeof speaker>, spawn: typeof nodeSpawn,
  onPrompt?: (child: ReturnType<typeof nodeSpawn>) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: claudeEnv(paths), stdio: 'pipe', cwd: paths.configDir });
    child.stdin?.on('error', () => {}); // a child that already left
    const flushers: (() => void)[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let partial = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        partial += chunk;
        const end = partial.lastIndexOf('\n');
        if (end >= 0) {
          for (const line of partial.slice(0, end).split('\n')) out.say(line);
          partial = partial.slice(end + 1);
        }
        if (onPrompt && PROMPT.test(partial)) {
          partial = '';
          onPrompt(child);
        }
      });
      flushers.push(() => { out.say(partial); partial = ''; });
    }
    child.on('error', (error) => { out.say(`Could not run Claude Code: ${error.message}`); resolve(null); });
    child.on('close', (code) => {
      for (const flush of flushers) flush();
      resolve(code);
    });
  });
}

async function login(paths: DataPaths, out: ReturnType<typeof speaker>, deps: CommandDeps): Promise<number> {
  let bin: string;
  try {
    // The download is large, so the owner says yes to it first.
    bin = await (deps.ensureBinary ?? nodeEnsureBinary)(paths, { say: out.say, confirm: out.confirm });
  } catch (error) {
    out.say(error instanceof DownloadDeclined ? 'Sign-in cancelled; nothing was downloaded.' : (error as Error).message);
    return 1;
  }
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  let cancelled = false;
  const code = await runClaude(bin, ['auth', 'login'], paths, out, deps.spawn ?? nodeSpawn, (child) => {
    void out.ask('Paste the code from the browser:').then((answer) => {
      if (answer === null) {
        cancelled = true;
        child.kill();
      } else {
        child.stdin?.write(`${answer.replace(/[\r\n]+/g, '')}\n`);
      }
    }, () => { cancelled = true; child.kill(); });
  });
  await out.drained();
  if (cancelled) {
    out.say('Sign-in cancelled.');
    return 1;
  }
  return code ?? 1;
}

async function logout(paths: DataPaths, out: ReturnType<typeof speaker>, deps: CommandDeps): Promise<number> {
  const bin = binaryPath(paths);
  if (existsSync(bin)) await runClaude(bin, ['auth', 'logout'], paths, out, deps.spawn ?? nodeSpawn);
  const had = existsSync(paths.configDir);
  await rm(paths.configDir, { recursive: true, force: true });
  out.say(had ? 'Signed out; the Claude Code login is removed.' : 'Not signed in; there was no login to remove.');
  return 0;
}

async function save(paths: DataPaths, change: Partial<ClaudeSettings>) {
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  writeClaudeSettings(paths.data, { ...readClaudeSettings(paths.data), ...change });
}

function usage(name: CommandName): string {
  const { args, text } = COMMANDS[name];
  return `Usage: /${name}${args ? ` ${args}` : ''}  ${text}`;
}

/**
 * Runs one command with its argument text (what follows the command name), answering with its exit code. `session`
 * is the pi session the command runs in (for `/claude-extra-usage allow-session`).
 */
export async function runCommand(name: CommandName, argText: string, owner: Owner, paths: DataPaths, deps: CommandDeps = {}, session?: string): Promise<number> {
  const out = speaker(owner);
  const args = argText.trim().split(/\s+/).filter(Boolean);
  let exit: number;
  if (name === 'claude-login' && args.length === 0) exit = await login(paths, out, deps);
  else if (name === 'claude-logout' && args.length === 0) exit = await logout(paths, out, deps);
  else if (name === 'claude-status' && args.length === 0) {
    const downloaded = existsSync(binaryPath(paths));
    const settings = readClaudeSettings(paths.data);
    out.say(`Claude Code ${CLAUDE_CODE_VERSION}: ${downloaded ? 'downloaded' : 'not downloaded yet'}\nSigned in: ${signedIn(paths) ? 'yes' : 'no'}\n` +
      `Claude Code context: ${settings.claudeCodeContext ? CONTEXT.on : CONTEXT.off}\nExtra usage: ${EXTRA_USAGE[settings.extraUsage]}\nData: ${paths.data}`);
    exit = 0;
  } else if (name === 'claude-context' && args.length === 0) {
    out.say(`Claude Code context: ${readClaudeSettings(paths.data).claudeCodeContext ? CONTEXT.on : CONTEXT.off}`);
    exit = 0;
  } else if (name === 'claude-context' && args.length === 1 && (args[0] === 'on' || args[0] === 'off')) {
    await save(paths, { claudeCodeContext: args[0] === 'on' });
    out.say(`Claude Code context: ${CONTEXT[args[0]]}; it applies from the next Claude turn.`);
    exit = 0;
  } else if (name === 'claude-extra-usage' && args.length === 0) {
    const mode = readClaudeSettings(paths.data).extraUsage;
    out.say(`Extra usage: ${EXTRA_USAGE[mode]}\n\nModes:\n${EXTRA_USAGE_MODES.map((m) => `  ${EXTRA_USAGE[m]}`).join('\n')}\n` +
      '  allow-session accepts Extra Usage for this pi session only (with the ask mode)');
    exit = 0;
  } else if (name === 'claude-extra-usage' && args.length === 1 && (EXTRA_USAGE_MODES as readonly string[]).includes(args[0]!)) {
    const mode = args[0] as ExtraUsageMode;
    await save(paths, { extraUsage: mode });
    deps.extraUsageChanged?.();
    out.say(`Extra usage: ${EXTRA_USAGE[mode]}; it applies from the next Claude turn.`);
    exit = 0;
  } else if (name === 'claude-extra-usage' && args.length === 1 && args[0] === 'allow-session' && session && deps.allowSession) {
    deps.allowSession(session);
    const mode = readClaudeSettings(paths.data).extraUsage;
    out.say(`Extra Usage is accepted for this pi session only, from the next Claude turn.${mode === 'ask' ? '' : ` The mode is ${mode}, so it ${mode === 'strict' ? 'still stops every such turn' : 'already lets them through'}.`}`);
    exit = 0;
  } else {
    out.say(usage(name));
    exit = 2;
  }
  await out.drained();
  return exit;
}
