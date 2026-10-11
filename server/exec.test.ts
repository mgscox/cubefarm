import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError, ghJson, run } from './exec.ts';

afterEach(() => vi.unstubAllEnvs());

describe('command environment', () => {
  const readEnv = ['-e', 'process.stdout.write(JSON.stringify({ policy: process.env.npm_config_allow_scripts, registry: process.env.npm_config_registry, custom: process.env.TEST_COMMAND_ENV, ghPrompt: process.env.GH_PROMPT_DISABLED, gitPrompt: process.env.GIT_TERMINAL_PROMPT, noColor: process.env.NO_COLOR }))'];

  it('keeps the inherited environment by default', async () => {
    vi.stubEnv('npm_config_allow_scripts', 'esbuild');
    vi.stubEnv('npm_config_registry', 'https://registry.npmjs.org/');
    expect(JSON.parse(await run(process.execPath, readEnv))).toMatchObject({
      policy: 'esbuild', registry: 'https://registry.npmjs.org/', ghPrompt: '1', gitPrompt: '0', noColor: '1',
    });
  });

  it('uses the supplied environment without restoring omitted inherited settings', async () => {
    vi.stubEnv('npm_config_allow_scripts', 'esbuild');
    const env = { TEST_COMMAND_ENV: 'custom', GH_PROMPT_DISABLED: '0', GIT_TERMINAL_PROMPT: '1', NO_COLOR: '0' };
    expect(JSON.parse(await run(process.execPath, readEnv, { env }))).toEqual({
      custom: 'custom', ghPrompt: '1', gitPrompt: '0', noColor: '1',
    });
    expect(env).toEqual({ TEST_COMMAND_ENV: 'custom', GH_PROMPT_DISABLED: '0', GIT_TERMINAL_PROMPT: '1', NO_COLOR: '0' });
  });
});

describe('command JSON boundary', () => {
  it('preserves stdout and stderr when a command emits JSON then fails', async () => {
    const stdout = '{"data":{"repository":null}}\n';
    const stderr = 'GraphQL: access denied\n';
    const command = () => run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`]);
    const error = await ghJson([], undefined, command).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ stdout, stderr, code: 1 });
  });

  it('parses successful command output', async () => {
    expect(await ghJson([], undefined, () => run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ ok: true }))']))).toEqual({ ok: true });
  });
});
