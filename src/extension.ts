// The pi extension: registers the `claude-subscription` provider and the `/claude-*` commands. Nothing starts when it
// loads: the warm Claude Code processes start with the first turn and close with the session, and the pinned binary is
// downloaded only from `/claude-login`, after the owner says yes.
import { createProvider, type Provider, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { signInState } from './account.ts';
import { installedBinary, PINNED } from './binary.ts';
import { COMMANDS, runCommand, type CommandName, type Owner } from './command.ts';
import { CLAUDE_CODE_VERSION, dataPaths, PROVIDER_ID, type DataPaths } from './env.ts';
import { MODELS } from './models.ts';
import { openClaudeService, type ClaudeService } from './provider/provider.ts';
import { EXTRA_USAGE_MODES } from './settings.ts';

export interface ExtensionOptions {
  /** The data folder's paths (default: `dataPaths()`, read when the extension loads). */
  paths?: DataPaths;
}

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
const largest = Math.max(...Object.values(PINNED).map((pin) => pin.bytes ?? 0));

/** What a turn says when the binary or the sign-in is missing: it never downloads on its own. */
async function usableBinary(paths: DataPaths): Promise<string> {
  const bin = await installedBinary(paths);
  if (!bin) {
    throw new Error(`Claude Code ${CLAUDE_CODE_VERSION} is not installed for pi-provider-claude. Run /claude-login: it asks before ` +
      `downloading it (about ${mb(largest)} MB) and then signs you in to your Claude subscription.`);
  }
  if (signInState(paths) === false) throw new Error('Not signed in to Claude for pi-provider-claude. Run /claude-login to sign in with your Claude subscription.');
  return bin;
}

/** pi's dialogs as the commands' owner; without a UI (print or JSON mode) output goes to stdout and nothing can be asked. */
function ownerOf(ctx: ExtensionContext): Owner {
  return {
    async print(text) { if (ctx.hasUI) ctx.ui.notify(text, 'info'); else process.stdout.write(`${text}\n`); },
    async ask(question) { return ctx.hasUI ? (await ctx.ui.input(question)) ?? null : null; },
    async confirm(question) { return ctx.hasUI ? ctx.ui.confirm('Claude Code download', question.replace(/\s*\(y\/n\)$/, '')) : false; },
  };
}

export function createExtension(options: ExtensionOptions = {}) {
  return function piProviderClaude(pi: ExtensionAPI): void {
    const paths = options.paths ?? dataPaths();
    // Sessions whose owner accepted Extra Usage (the `ask` mode), in memory only: a new session or a restart asks again.
    const allowed = new Set<string>();
    // Sessions whose owner declined it: not sent again on any model until allow-session.
    const declined = new Set<string>();
    // The newest context pi handed the extension, so a turn can warn and ask through pi's UI.
    let latest: ExtensionContext | undefined;
    const remember = (_event: unknown, ctx: ExtensionContext) => { latest = ctx; };
    pi.on('session_start', remember);
    pi.on('agent_start', remember);

    let service: ClaudeService | undefined;
    const open = () => service ??= openClaudeService({
      paths,
      binary: () => usableBinary(paths),
      extraUsage: {
        allowed,
        declined,
        async ask(_session, message, signal) {
          try {
            // The dialog closes when the turn is aborted.
            return latest?.hasUI ? await latest.ui.confirm('Claude Extra Usage', message, signal ? { signal } : undefined) : false;
          } catch {
            return false; // a context of a session that was replaced
          }
        },
        warn(message) {
          // A warning notification in pi's UI; stderr without one (print mode), where pi shows no notifications.
          try {
            if (latest?.hasUI) { latest.ui.notify(message, 'warning'); return; }
          } catch { /* a replaced session's context */ }
          process.stderr.write(`${message}\n`);
        },
      },
    });
    pi.on('session_shutdown', async () => {
      const closing = service;
      service = undefined;
      await closing?.close();
    });

    const streamSimple = (model: Parameters<ClaudeService['streamSimple']>[0], context: Parameters<ClaudeService['streamSimple']>[1], opts?: SimpleStreamOptions) =>
      open().streamSimple(model, context, opts);
    const provider: Provider = createProvider({
      id: PROVIDER_ID,
      name: 'Claude (subscription, through Claude Code)',
      // The sign-in is Claude Code's own, in its own folder; pi holds no key. Always configured, so a turn without the
      // binary or the sign-in can say to run /claude-login.
      auth: { apiKey: { name: 'Claude Code sign-in (/claude-login)', resolve: async () => ({ auth: {}, source: 'Claude Code login (/claude-login)' }) } },
      models: MODELS,
      api: { stream: streamSimple, streamSimple },
    });
    pi.registerProvider(provider);

    const completions: Partial<Record<CommandName, readonly string[]>> = {
      'claude-context': ['on', 'off'],
      'claude-extra-usage': [...EXTRA_USAGE_MODES, 'allow-session'],
    };
    for (const name of Object.keys(COMMANDS) as CommandName[]) {
      const choices = completions[name];
      pi.registerCommand(name, {
        description: COMMANDS[name].text,
        ...(choices ? { getArgumentCompletions: (prefix: string) => choices.filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c })) } : {}),
        handler: async (args, ctx) => {
          latest = ctx;
          await runCommand(name, args, ownerOf(ctx), paths, { allowSession: (session) => { allowed.add(session); declined.delete(session); }, extraUsageChanged: () => declined.clear() }, ctx.sessionManager.getSessionId());
        },
      });
    }
  };
}

export default createExtension();
