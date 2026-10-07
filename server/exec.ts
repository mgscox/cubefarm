import { execFile } from 'node:child_process';

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null,
    public readonly stdout: string = '',
  ) {
    super(message);
  }
}

/** Run a CLI (gh, git) without a shell and return trimmed stdout. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).toString().trim();
          reject(new CommandError(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${detail}`, stderr?.toString() ?? '', (err as { code?: number }).code ?? null, stdout?.toString() ?? ''));
          return;
        }
        resolve(stdout.toString().trim());
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

export const gh = (args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string }) => run('gh', args, opts);
export const git = (args: string[], opts?: { cwd?: string; timeoutMs?: number }) => run('git', args, opts);

export async function ghJson<T>(args: string[], opts?: { cwd?: string; timeoutMs?: number }, command: typeof gh = gh): Promise<T> {
  const out = await command(args, opts);
  return (out ? JSON.parse(out) : null) as T;
}
