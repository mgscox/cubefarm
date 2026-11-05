import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

// Reproduce both the original eager import and the lazy CommonJS load failing.
const missing = vi.hoisted(() => vi.fn(() => { throw new Error('private native dependency missing'); }));
vi.mock('@lydell/node-pty', () => missing());
vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>();
  return { ...actual, createRequire: (file: string | URL) => {
    const real = actual.createRequire(file);
    return Object.assign((id: string) => id === '@lydell/node-pty' ? missing() : real(id), real);
  } };
});

it('loads office auth without native PTY; demo, manual tokens and SDK environment remain usable', async () => {
  const imported = import('./claudeAuth.ts');
  await expect(imported).resolves.toHaveProperty('ClaudeAuthentication');
  const { ClaudeAuthentication } = await imported;
  const { claudeEnv } = await import('../bin/claudeAuth.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-missing-native-'));
  const auth = new ClaudeAuthentication({ home, env: { CLAUDE_CODE_OAUTH_TOKEN: 'dummy-startup' } });
  const demo = new ClaudeAuthentication({ home, demo: true });
  try {
    expect(missing).not.toHaveBeenCalled();
    expect(auth.view()).toMatchObject({ phase: 'idle', source: 'startup' });
    expect(claudeEnv({ SWARM_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'dummy-startup' }).CLAUDE_CODE_OAUTH_TOKEN).toBe('dummy-startup');
    expect(demo.start()).toMatchObject({ phase: 'awaiting-code' });
    expect(missing).not.toHaveBeenCalled();
    expect(auth.start()).toMatchObject({ phase: 'failed', flowId: null });
    await vi.waitFor(() => expect(missing).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(auth.view())).not.toContain('private native');
    // Wait for failed-flow cleanup before starting the independent fallback.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const manual = auth.start('manual-token');
    expect(manual).toMatchObject({ phase: 'pending' });
    const token = 'sk-ant-oat01-' + 'n'.repeat(80);
    expect(await auth.complete(manual!.flowId!, token)).toMatchObject({ phase: 'complete', source: 'saved' });
    expect(claudeEnv({ SWARM_HOME: home }).CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(missing).toHaveBeenCalledTimes(1);
  } finally {
    await auth.close(); await demo.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
