import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import * as clis from './clis.ts';
import { writeCliSession } from './cliFiles.ts';
import { BOOTSTRAP, upstashConfig } from './upstashProvider.ts';
import { VERSION } from './config.ts';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['claude', 'codex', 'opencode'] as const)('rehearses %s install, authentication and terminal launch inside the emulator', async (cli) => {
  const keys = { ANTHROPIC_API_KEY: 'anthropic-emulator', OPENAI_API_KEY: 'platform-emulator', OPENROUTER_API_KEY: 'router-emulator', UPSTASH_BOX_API_KEY: 'provider-emulator' };
  const config = upstashConfig(keys, cli, 'worker-task', 'github-emulator');
  const workerEnv = { ...config.env!, PATH: '/usr/bin' };
  const commands: { file: string; args: string[]; opts?: { input?: string } }[] = [];
  // Run the actual bootstrap against an emulated Box filesystem and installed programs.
  await vm.runInNewContext(BOOTSTRAP, {
    require: (name: string) => name === 'node:fs' ? { mkdirSync() {}, writeFileSync() {} } : {
      execFileSync(file: string, args: string[], opts?: { input?: string }) { commands.push({ file, args, opts }); },
    },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    Buffer,
    process: { env: workerEnv, arch: 'x64', argv: ['node', VERSION, '1.64.1', '^2.9.1'], exit() { throw new Error('bootstrap failed'); } },
  });
  const packages = commands[0];
  expect(packages).toMatchObject({ file: 'npm', args: ['install', '--prefix', '/workspace/home/.cubefarm-runtime', `cubefarm@${VERSION}`, 'playwright@1.64.1', 'yaml@^2.9.1', ...(cli === 'codex' ? ['@openai/codex'] : cli === 'opencode' ? ['opencode-ai'] : [])] });
  expect(commands.some((c) => c.file === 'gh' && c.args.join(' ') === 'auth setup-git')).toBe(true);
  if (cli === 'codex') expect(commands.find((c) => c.file === 'codex')).toMatchObject({ args: ['login', '--with-api-key'], opts: { input: 'platform-emulator' } });

  for (const [key, value] of Object.entries(config.env!)) vi.stubEnv(key, value);
  vi.stubEnv('UPSTASH_BOX_API_KEY', 'provider-must-stay-on-host');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'subscription-must-not-win');
  vi.spyOn(clis, 'commandFor').mockReturnValue({ file: process.execPath, args: [] });
  const dir = await fs.mkdtemp(path.join(process.env.CUBEFARM_JOB_SCRATCH || os.tmpdir(), 'upstash-cli-'));
  let session: ReturnType<typeof writeCliSession> | undefined;
  try {
    execFileSync('git', ['init', dir], { windowsHide: true, stdio: 'ignore' });
    session = writeCliSession({ cli, cwd: dir, token: crypto.randomUUID(), sessionId: crypto.randomUUID(), prompt: 'Implement the task', systemAppend: 'Use the assigned branch', model: cli === 'opencode' ? 'anthropic/claude-sonnet-4.6' : '', effort: 'high', name: 'Ada', role: 'dev', additionalDirectories: [], browserTesting: false, officeUrl: 'http://127.0.0.1:5324', officeTools: false }, { url: 'http://127.0.0.1:12345', held: true });
    expect(session.env.UPSTASH_BOX_API_KEY).toBeUndefined();
    expect(session.cwd).toBe(dir);
    if (cli === 'claude') {
      expect(session.env.ANTHROPIC_API_KEY).toBe('anthropic-emulator');
      expect(session.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(session.args).toContain('bypassPermissions');
    } else if (cli === 'codex') {
      expect(session.env.OPENAI_API_KEY).toBe('platform-emulator');
      expect(session.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    } else {
      expect(session.env.OPENROUTER_API_KEY).toBe('router-emulator');
      expect(JSON.parse(session.env.OPENCODE_CONFIG_CONTENT).model).toBe('openrouter/anthropic/claude-sonnet-4.6');
      expect(session.args).toContain('--standalone');
    }
  } finally {
    if (session) await fs.rm(session.dir, { recursive: true, force: true, maxRetries: 5 });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
