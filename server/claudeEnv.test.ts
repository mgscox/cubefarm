import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeEnv } from '../bin/claudeAuth.js';

describe('doctor and interactive login environment', () => {
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
  it('doctor keeps a subscription token; interactive login strips it to avoid short circuit', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-env-test-'));
    homes.push(home);
    const input = {
      SWARM_HOME: home,
      PATH: '/dummy', CLAUDE_CONFIG_DIR: '/dummy/config', CLAUDE_CODE_OAUTH_TOKEN: 'dummy-subscription',
      ANTHROPIC_API_KEY: 'dummy-key', ANTHROPIC_BASE_URL: 'dummy-proxy', ANTHROPIC_AUTH_TOKEN: 'dummy-bearer',
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'dummy-session', CLAUDE_CODE_USE_VERTEX: '1',
    };
    const doctor = claudeEnv(input);
    expect(doctor.CLAUDE_CODE_OAUTH_TOKEN === input.CLAUDE_CODE_OAUTH_TOKEN).toBe(true);
    delete doctor.CLAUDE_CODE_OAUTH_TOKEN;
    expect(doctor).toEqual({ SWARM_HOME: home, PATH: '/dummy', CLAUDE_CONFIG_DIR: '/dummy/config' });
    expect(claudeEnv(input, { login: true })).toEqual(doctor);
  });
});

it('privately persists a replacement across new sessions/reloads with precedence over startup; demo never reads or writes it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const auth = await import('../bin/claudeAuth.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-test-'));
  const startup = { SWARM_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'dummy-original' };
  const replacement = 'sk-ant-oat01-' + 'd'.repeat(80);
  try {
    const active = auth.claudeEnv(startup);
    await auth.saveClaudeToken(home, replacement);
    expect(auth.claudeEnv(startup).CLAUDE_CODE_OAUTH_TOKEN === replacement).toBe(true);
    expect(auth.claudeEnv({ SWARM_HOME: home }).CLAUDE_CODE_OAUTH_TOKEN === replacement).toBe(true);
    expect(active.CLAUDE_CODE_OAUTH_TOKEN === 'dummy-original').toBe(true);
    expect(auth.claudeEnv(startup, { login: true }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(auth.claudeAuthMetadata(startup)).toEqual({ source: 'saved', expiresAt: null });
    const file = path.join(home, 'credentials', 'claude-subscription.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['claude-subscription.json']);
    expect(auth.claudeEnv(startup, { demo: true }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(auth.claudeAuthMetadata(startup, true)).toEqual({ source: 'demo', expiresAt: null });
    await expect(auth.saveClaudeToken(home, replacement, true)).rejects.toThrow('Demo');
    await expect(auth.saveClaudeToken(process.cwd(), replacement)).rejects.toThrow('outside');
    // Errors may contain only fixed text, never credentials or filesystem contents.
    fs.writeFileSync(file, replacement);
    expect(() => auth.claudeEnv(startup)).toThrow('Could not read Claude credential');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
