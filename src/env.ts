// Where the extension keeps its files, and the environment every Claude Code process gets. Everything the extension
// writes goes under one data folder in pi's agent folder, separate from the owner's own `~/.claude`.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The Claude Code release this extension is built and tested against (npm's `stable` tag on 2026-11-10). */
export const CLAUDE_CODE_VERSION = '2.1.311';

/** The provider id pi's model selection names. */
export const PROVIDER_ID = 'claude-subscription';

/** The model API id of this provider: a process-backed transport, not an HTTP API pi-ai knows. */
export const API_ID = 'claude-code-process';

export interface DataPaths {
  /** The extension's data folder. */
  data: string;
  /** The pinned binary, downloaded by `/claude-login`. */
  binDir: string;
  /** Claude Code's config and login (`CLAUDE_CONFIG_DIR`): the extension's own sign-in. */
  configDir: string;
  /** Empty working folders, one per conversation. */
  workDir: string;
  /** Private folders for session files. */
  runDir: string;
  /** Private folders for one-shot runs. */
  tmpDir: string;
}

const expandHome = (path: string) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/**
 * The data folder: `PI_PROVIDER_CLAUDE_DATA` when set (tests), otherwise `pi-provider-claude` in pi's agent folder,
 * which is `PI_CODING_AGENT_DIR` when set and `~/.pi/agent` otherwise, as pi's own `getAgentDir()` resolves it.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_PROVIDER_CLAUDE_DATA) return expandHome(env.PI_PROVIDER_CLAUDE_DATA);
  const agent = env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent');
  return join(agent, 'pi-provider-claude');
}

/** The paths under `data` (default: `dataDir()`). */
export function dataPaths(data = dataDir()): DataPaths {
  return {
    data,
    binDir: join(data, 'bin'),
    configDir: join(data, 'claude-code'),
    workDir: join(data, 'work'),
    runDir: join(data, 'run'),
    tmpDir: join(data, 'tmp'),
  };
}

/** Claude Code's own features that pi replaces, or that would add to the conversation or touch shared state. */
export const SWITCHES = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_AUTO_COMPACT: '1', // pi owns compaction
  DISABLE_COMPACT: '1',
  MCP_TOOL_TIMEOUT: String(24 * 3600_000), // a tool call waits as long as pi's tool takes
};

/** What a Claude Code process may see of pi's environment: the proxy, never other credentials. */
const PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY'];

/** The environment of a Claude Code process: the passthrough, the switches, and its config folder. */
export function claudeEnv(paths: DataPaths, extra: Record<string, string> = {}, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) if (from[key] !== undefined) env[key] = from[key]!;
  return { ...env, ...SWITCHES, CLAUDE_CONFIG_DIR: paths.configDir, ...extra };
}
