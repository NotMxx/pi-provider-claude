import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { signedIn, signInState } from '../src/account.ts';
import { claudeEnv, dataDir, dataPaths } from '../src/env.ts';
import { scratch as tempDir } from './fixtures/scratch.ts';

function scratch() {
  return dataPaths(tempDir('ppc-account-'));
}

function credentials(paths: ReturnType<typeof scratch>, value: unknown) {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, '.credentials.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('the data folder is under pi\'s agent folder, follows PI_CODING_AGENT_DIR, and PI_PROVIDER_CLAUDE_DATA overrides it', () => {
  assert.equal(dataDir({}), join(homedir(), '.pi', 'agent', 'pi-provider-claude'));
  assert.equal(dataDir({ PI_CODING_AGENT_DIR: '/agent' }), '/agent/pi-provider-claude');
  assert.equal(dataDir({ PI_CODING_AGENT_DIR: '~/elsewhere' }), join(homedir(), 'elsewhere', 'pi-provider-claude'));
  assert.equal(dataDir({ PI_CODING_AGENT_DIR: '/agent', PI_PROVIDER_CLAUDE_DATA: '/tmp/x' }), '/tmp/x');
  assert.deepEqual(dataPaths('/d'), {
    data: '/d', binDir: '/d/bin', configDir: '/d/claude-code', workDir: '/d/work', runDir: '/d/run', tmpDir: '/d/tmp',
  });
});

test('claudeEnv passes only the minimal passthrough, the switches and the extension\'s own config folder', () => {
  const env = claudeEnv(dataPaths('/d'), { EXTRA: '1' }, {
    PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://p', ANTHROPIC_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 's', CLAUDE_CONFIG_DIR: '/home/me/.claude',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal(env.HTTPS_PROXY, 'http://p');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'no other credentials');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/d/claude-code', 'never the owner\'s ~/.claude');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.DISABLE_AUTO_COMPACT, '1');
  assert.equal(env.EXTRA, '1');
});

test('signedIn reads a non-empty access or refresh token, and nothing else', () => {
  const paths = scratch();
  assert.equal(signedIn(paths), false);
  assert.equal(signInState(paths), false);
  credentials(paths, { claudeAiOauth: { accessToken: 'a' } });
  assert.equal(signedIn(paths), true);
  credentials(paths, { claudeAiOauth: { accessToken: '', refreshToken: 'r' } });
  assert.equal(signedIn(paths), true);
  credentials(paths, { claudeAiOauth: { accessToken: '', refreshToken: 7 } });
  assert.equal(signedIn(paths), false);
  credentials(paths, { other: { accessToken: 'a' } });
  assert.equal(signedIn(paths), false);
  credentials(paths, 'not json');
  assert.equal(signedIn(paths), false);
  assert.equal(signInState(paths), 'unknown', 'a file that cannot be understood is unknown, not signed out');
});

test('signedIn does not follow a symbolic link', () => {
  const paths = scratch();
  const elsewhere = join(paths.data, 'elsewhere.json');
  writeFileSync(elsewhere, JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
  mkdirSync(paths.configDir, { recursive: true });
  symlinkSync(elsewhere, join(paths.configDir, '.credentials.json'));
  assert.equal(signedIn(paths), false);
});
