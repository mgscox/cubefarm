import { describe, expect, it } from 'vitest';
import { CommandError, ghJson, run } from './exec.ts';

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
