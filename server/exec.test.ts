import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandError, failureDetail, ghJson, run } from './exec.ts';

afterEach(() => vi.unstubAllEnvs());

describe('command failure diagnostics', () => {
  const failed = { message: 'Command failed: gh pr list -R demo/repo' };

  it('prefers useful stderr, including when the process was killed', () => {
    expect(failureDetail({ ...failed, code: 1, killed: true }, '  HTTP 502: Bad Gateway\n', 60_000)).toBe('HTTP 502: Bad Gateway');
  });

  it('explains silent timeouts, signals and exit codes', () => {
    expect(failureDetail({ ...failed, killed: true, signal: 'SIGTERM' }, ' \n', 60_000)).toBe('timed out after 60 s');
    expect(failureDetail({ ...failed, signal: 'SIGKILL' }, '', 60_000)).toBe('stopped by SIGKILL');
    expect(failureDetail({ ...failed, code: 3 }, '', 60_000)).toBe('exited with code 3 and no error output');
    expect(failureDetail(failed, '', 60_000)).toBe(failed.message);
  });

  it('retains spawn and max-buffer diagnostics even when Node marks the process killed', () => {
    expect(failureDetail({ message: 'spawn gh ENOENT', code: 'ENOENT' }, '', 60_000)).toBe('spawn gh ENOENT');
    expect(failureDetail({ message: 'stdout maxBuffer length exceeded', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, '', 60_000))
      .toBe('stdout maxBuffer length exceeded');
  });

  it('reports a real silent command exit', async () => {
    await expect(run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(/failed: exited with code 3 and no error output$/);
  });

  it('reports a real command timeout', async () => {
    await expect(run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 1000 })).rejects.toThrow(/failed: timed out after 1 s$/);
  });
});

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
    expect((error as CommandError).message).toMatch(/failed: GraphQL: access denied$/);
  });

  it('parses successful command output', async () => {
    expect(await ghJson([], undefined, () => run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ ok: true }))']))).toEqual({ ok: true });
  });
});
