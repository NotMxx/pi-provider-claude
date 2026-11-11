// The extension's own settings, in its data folder. They are read again on every new Claude process and every turn, so
// a change applies from the next Claude turn.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeSettings {
  /** Keep Claude Code's own system prompt and add pi's to it, instead of replacing it (default false: pi's replaces it). */
  claudeCodeContext: boolean;
  /**
   * What a turn does when Claude Code reports it is billed to Extra Usage (usage credits) instead of the plan:
   * `strict` stops it; `ask` (default) asks the owner, and a yes allows it for that pi session only; `allow` lets it
   * through with a warning every time.
   */
  extraUsage: ExtraUsageMode;
}

export const EXTRA_USAGE_MODES = ['strict', 'ask', 'allow'] as const;
export type ExtraUsageMode = (typeof EXTRA_USAGE_MODES)[number];

const mode = (value: unknown): ExtraUsageMode => (EXTRA_USAGE_MODES as readonly unknown[]).includes(value) ? value as ExtraUsageMode : 'ask';

const FILE = 'settings.json';

/** The settings in `dataDir`; missing or unreadable settings are the defaults. */
export function readClaudeSettings(dataDir: string): ClaudeSettings {
  try {
    const saved = JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'));
    return { claudeCodeContext: saved?.claudeCodeContext === true, extraUsage: mode(saved?.extraUsage) };
  } catch {
    return { claudeCodeContext: false, extraUsage: 'ask' };
  }
}

/** Saves the settings in `dataDir` (which must exist), readable by the owner only. */
export function writeClaudeSettings(dataDir: string, settings: ClaudeSettings): void {
  const temp = join(dataDir, `.${FILE}.${process.pid}`);
  writeFileSync(temp, JSON.stringify({ claudeCodeContext: settings.claudeCodeContext, extraUsage: settings.extraUsage }) + '\n', { mode: 0o600 });
  renameSync(temp, join(dataDir, FILE));
}
