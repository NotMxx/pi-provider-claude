# pi-provider-claude

A [pi](https://github.com/earendil-works/pi) extension that serves your own Claude subscription to pi as a model provider, `claude-subscription`, through the unmodified Claude Code binary.

- It runs one warm Claude Code process per conversation, kept across tool rounds and prompts, so the prompt cache keeps working. A reviewer or compaction call that resends the conversation, or another session with the same opening, never takes or closes it.
- pi runs every tool: Claude Code's own tools are off, and pi's tools reach Claude through an in-process MCP bridge. pi's approvals, extensions and subagents apply. Parallel tool calls, images both ways, thinking, abort and several conversations at once work.
- It uses a pinned Claude Code release (2.1.311) from the npm registry, checked against a pinned hash. It downloads it only when you run `/claude-login` and say yes.
- You sign in through Claude Code's own login, in a folder of the extension's own, separate from your `~/.claude`.

Status: early (0.1.0). Linux x64 and arm64, where Claude Code's pinned binary is published.

## Install

Supported: pi 0.99.1 or later. Recommended: the newest pi it was tested with, 1.5.2. Checked to load and run a turn with a tool call on 0.99.1, 1.0.0, 1.0.4, 1.1.0, 1.2.0, 1.3.0, 1.4.0 and 1.5.2; CI checks the oldest and the newest on every change (`test/e2e/pi.test.ts`).

From a local checkout or a git URL:

```sh
pi install ./pi-provider-claude
pi install git:github.com/NotMxx/pi-provider-claude
```

Then, in pi:

1. Run `/claude-login`. It asks before downloading Claude Code (about 127 MB, 280 MB on disk), then runs Claude Code's sign-in: open the URL it shows, and paste the code from the browser.
2. Pick a model of the `claude-subscription` provider, such as `claude-opus-5-5`.

Until you sign in, a turn on these models ends with an error that tells you to run `/claude-login`. Nothing downloads on its own.

When no model is set, pi takes the first one, `claude-opus-5-5`.

## Gentle Shell

Checked with Gentle Shell 4.7.0 on pi 1.5.2 and with its main branch (2026-11-11, pi 1.4.0): subagents, judges, reviewers, routing, compaction and fallback included.

- Install it as a package, so subagents load it too: `gentle-shell install git:github.com/NotMxx/pi-provider-claude`. An extension passed with `-e` is not passed to subagents.
- Run `/claude-login` once inside Gentle Shell. It keeps its data in `~/.gentle-shell/agent/pi-provider-claude`, separate from pi's.
- Subagents with no model route use Opus 5.5. Set a default model, or a subagent `default_model`, to use another.
- A reached plan limit says "usage limit", which Gentle Shell reads as quota and may answer with its fallback model. The 5-hour and weekly limits cover every model of the subscription, so point fallback chains at another provider; only a per-model limit (such as the weekly Opus one) is worth a fallback within `claude-subscription`.
- A subagent has no UI, so it cannot answer the Extra Usage question. In `ask` mode a subagent turn billed to Extra Usage fails (Gentle Shell treats it as quota and may fall back), unless the parent has a UI or the mode is `allow`. Once a session declines, its later turns stop before reaching Claude Code, on any model, so a fallback is not billed again; `/claude-extra-usage allow-session` or a new mode clears it.

## Commands

| Command | What it does |
|---|---|
| `/claude-login` | Downloads the pinned Claude Code after you say yes, then signs you in to your Claude subscription |
| `/claude-logout` | Signs out and removes the extension's Claude Code login |
| `/claude-status` | Shows Claude Code's version, whether you are signed in, the settings and the data folder |
| `/claude-context [on\|off]` | Shows or sets the Claude Code context switch (default off) |
| `/claude-extra-usage [strict\|ask\|allow\|allow-session]` | Shows or sets what a turn billed to Extra Usage does (default ask) |

Settings apply from the next Claude turn.

## The Claude Code context switch

Off (the default), pi's system prompt replaces Claude Code's. On (`/claude-context on`), Claude Code keeps its own system prompt and pi's is added after it.

## System prompt changes and the cache

The system prompt is the start of every request, so changing it loses the prompt cache. When pi or an extension changes the prompt mid-conversation (added instructions, or a named section replaced or removed), the warm Claude Code process keeps the prompt it started with, and the change goes in with your next message as one `<system-reminder>` block, the convention Claude Code itself uses for context that changes while its system prompt stays fixed. A new process with the whole current prompt starts only when the base prompt itself changes, or after 32,000 characters of such reminders to one process.

## The Extra Usage brake

Anthropic can bill a request to Extra Usage (usage credits) instead of your plan: when a plan window is used up and Extra Usage is on, or when it classifies the request as third-party app usage. Claude Code reports this on each response, and the extension acts on it by the `extraUsage` mode:

- `ask` (default): pi warns you and asks whether to continue on Extra Usage. A yes holds for that pi session only, kept in memory: a new session or a restart asks again. A no, or no way to ask (print mode), stops the turn; `/claude-extra-usage allow-session` then accepts it for the current session.
- `strict`: the turn stops with an error, every time.
- `allow`: the turn goes on, with a warning notification every time.

A request Anthropic refuses as "out of extra usage" without a plan limit having been reached was classified as Extra Usage. The error says so; the wording of the system prompt can cause it, and `/claude-context on` may help. A reached plan limit ends the turn with its window and when it resets.

## Where data lives

Everything goes in `~/.pi/agent/pi-provider-claude/` (under `$PI_CODING_AGENT_DIR` when set; `$PI_PROVIDER_CLAUDE_DATA` overrides it):

- `bin/<version>/claude`: the pinned binary.
- `claude-code/`: Claude Code's config and your login for this extension (`CLAUDE_CONFIG_DIR`).
- `work/`: an empty working folder per conversation.
- `run/`: private session files while a process runs.
- `settings.json`: `claudeCodeContext` and `extraUsage`.

## Terms

This is an unofficial extension, not made or endorsed by Anthropic or by pi's authors. Use it only with your own Claude subscription, for your own work.

- Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says it does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", and that plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK". It also says Anthropic may enforce its restrictions "without prior notice". Read it before you use this extension, and check it again from time to time: the rules have changed several times in 2026.
- Do not use it to serve other people through your subscription, or to share or resell access to it.
- The binary is Anthropic's own Claude Code, unmodified, downloaded from the npm registry and checked against the integrity pinned in `src/binary.ts`.
- You sign in through Claude Code's own login flow. The extension never reads, copies or forwards your credentials: it only checks whether the login file holds a token, to say whether you are signed in.
- There is no proxy: Claude Code talks to Anthropic itself. Claude Code gets only a minimal environment (path, home, locale, proxy variables) and never other credentials from yours.
- Because Claude Code builds and sends each request itself, an extension's `before_provider_request` replacement payload cannot apply here: the extension calls the hook but ignores what it returns.

## Tests

`npm test` runs the tests against fake Claude Code binaries and a fake npm registry. Nothing signs in or downloads the real binary. `npm run typecheck` checks the types.

## License

MIT. See `LICENSE`.
