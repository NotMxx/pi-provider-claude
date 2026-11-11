#!/usr/bin/env node
// A fake `claude` for the extension's tests, never the real one. `--version` reports VERSION (tarball.ts rewrites it);
// `auth login` prints Claude Code's real prompts and writes a credentials file for the code "good-code";
// `auth logout` removes it. FAKE_CLAUDE_LOGIN=hang makes the login wait for its code without ever finishing.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = '2.1.311';
const args = process.argv.slice(2);
const config = process.env.CLAUDE_CONFIG_DIR;
if (config && process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, config }) + '\n');

if (args[0] === '--version') {
  console.log(`${VERSION} (Claude Code)`);
} else if (args[0] === 'auth' && args[1] === 'login') {
  // An escape sequence, as a real terminal program might print, which the extension must strip.
  process.stdout.write('\x1b[1mOpening browser to sign in\x1b[0m\n');
  process.stdout.write("If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true\n");
  process.stdout.write('Paste code here if prompted > ');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('\n') || process.env.FAKE_CLAUDE_LOGIN === 'hang') return;
    const code = input.trim();
    if (code !== 'good-code') {
      process.stdout.write('\nInvalid code\n');
      process.exit(1);
    }
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', refreshToken: 'fake-refresh' } }));
    process.stdout.write('\nLogin successful.\n');
    process.exit(0);
  });
} else if (args[0] === 'auth' && args[1] === 'logout') {
  rmSync(join(config, '.credentials.json'), { force: true });
  console.log('Successfully logged out from your Anthropic account.');
} else {
  process.exit(2);
}
