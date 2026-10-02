import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { startSession, type SessionCallbacks, type SessionOptions } from './agentRunner.ts';
import { startCliSession } from './cliRunner.ts';
import { spawnPty } from './ptyClient.ts';
import type { AgentTerminal } from './terminal.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(() => (async function* () {})()) }));
vi.mock('./clis.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./clis.ts')>(),
  commandFor: vi.fn(() => ({ file: 'fake-agent', args: [] })),
}));
vi.mock('./ptyClient.ts', () => ({
  terminalsAvailable: true,
  hooksReady: false,
  keeperHookUrl: () => null,
  spawnPty: vi.fn(() => ({
    pid: 123,
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(), setMeta: vi.fn(), onData: vi.fn(), onExit: vi.fn(),
  })),
}));

const opts: SessionOptions = {
  cwd: process.cwd(), prompt: 'Test environment', systemAppend: '', model: '', effort: 'medium',
  browserTesting: false, additionalDirectories: [], role: 'dev',
};
const callbacks: SessionCallbacks = {
  log: vi.fn(), tool: vi.fn(), sessionId: vi.fn(), browserUrl: vi.fn(), screenshot: vi.fn(), finished: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  // Session files and helper scripts are irrelevant to env handoff; never touch office state.
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'rm').mockImplementation((_path, _options, cb) => cb(null));
  vi.stubEnv('npm_config_registry', 'https://registry.npmjs.org/');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function expectProjectEnv(env: NodeJS.ProcessEnv | undefined) {
  expect(env).toBeDefined();
  expect(Object.keys(env!).some((key) => key.toLowerCase() === 'npm_config_allow_scripts')).toBe(false);
  expect(env!.npm_config_registry).toBe('https://registry.npmjs.org/');
}

describe.each(['npm_config_allow_scripts', 'NPM_CONFIG_ALLOW_SCRIPTS', 'Npm_Config_Allow_Scripts'])('%s', (key) => {
  beforeEach(() => vi.stubEnv(key, 'esbuild,acorn'));

  it.each(['codex', 'claude', 'opencode'] as const)('filters the environment handed to the %s CLI', (cli) => {
    const terminal = { cols: 120, rows: 32, note: vi.fn(), bind: vi.fn() } as unknown as AgentTerminal;
    const session = startCliSession({ ...opts, cli, terminal }, callbacks);
    try {
      expect(spawnPty).toHaveBeenCalledOnce();
      expectProjectEnv(vi.mocked(spawnPty).mock.calls[0][2].env);
    } finally {
      session.stop();
    }
  });

  it('filters the environment handed to the Claude SDK', async () => {
    const session = startSession(opts, callbacks);
    try {
      expect(query).toHaveBeenCalledOnce();
      expectProjectEnv(vi.mocked(query).mock.calls[0][0].options?.env);
      await Promise.resolve();
    } finally {
      session.stop();
    }
  });
});
