import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { startSession, type SessionCallbacks, type SessionOptions } from './agentRunner.ts';
import { startCliSession } from './cliRunner.ts';
import { spawnPty } from './ptyClient.ts';
import type { AgentTerminal } from './terminal.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(() => (async function* () {})()) }));
// Skill staging has its own worktree tests. These fixtures stub session filesystem writes.
vi.mock('./repoSkills.ts', () => ({
  ACTIVE_REPO_SKILLS: { release: 'fixture', skills: [], files: [] },
  stageCodexSkills: vi.fn(),
  writeSessionSkills: vi.fn(),
}));
vi.mock('./clis.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./clis.ts')>(),
  commandFor: vi.fn(() => ({ file: 'fake-agent', args: [] })),
}));
// Skill staging needs a real Git desk and filesystem. repoSkills.test.ts exercises it separately.
vi.mock('./repoSkills.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./repoSkills.ts')>(),
  stageCodexSkills: vi.fn(),
}));
vi.mock('./ptyClient.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ptyClient.ts')>(),
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

it('preapproves only office MCP namespaces in Claude session settings when hooks are unreachable', () => {
  const terminal = { cols: 120, rows: 32, note: vi.fn(), bind: vi.fn() } as unknown as AgentTerminal;
  const session = startCliSession({ ...opts, cli: 'claude', terminal }, callbacks);
  try {
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(([file]) => String(file).endsWith('settings.json'))!;
    const settings = JSON.parse(String(call[1]));
    expect(settings.permissions.allow).toEqual(['mcp__playwright__*', 'mcp__office__*']);
    expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'http', timeout: 30 });
  } finally {
    session.stop();
  }
});

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

it('preserves subscription auth for SDK and CLI while stripping key, proxy and parent session overrides', () => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-subscription-token');
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/dummy/config');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDECODE']) vi.stubEnv(key, 'dummy-forbidden');
  const sdk = startSession(opts, callbacks);
  const terminal = { cols: 120, rows: 32, note: vi.fn(), bind: vi.fn() } as unknown as AgentTerminal;
  const cli = startCliSession({ ...opts, cli: 'claude', terminal }, callbacks);
  try {
    for (const env of [vi.mocked(query).mock.calls[0][0].options?.env, vi.mocked(spawnPty).mock.calls[0][2].env]) {
      expect(env?.CLAUDE_CODE_OAUTH_TOKEN === 'dummy-subscription-token').toBe(true);
      expect(env?.CLAUDE_CONFIG_DIR).toBe('/dummy/config');
      expect(Object.entries(env!).some(([key, value]) => /^(ANTHROPIC_|CLAUDE)/i.test(key) && !['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_AGENT_SDK_CLIENT_APP'].includes(key) && value !== undefined)).toBe(false);
    }
  } finally { sdk.stop(); cli.stop(); }
});

it.each(['codex', 'opencode'] as const)('does not hand the Claude subscription token to %s', (cli) => {
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'dummy-claude-only');
  const terminal = { cols: 120, rows: 32, note: vi.fn(), bind: vi.fn() } as unknown as AgentTerminal;
  const session = startCliSession({ ...opts, cli, terminal }, callbacks);
  try { expect(vi.mocked(spawnPty).mock.calls[0][2].env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); }
  finally { session.stop(); }
});
