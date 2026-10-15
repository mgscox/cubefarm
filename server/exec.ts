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

/** Prefer stderr; silent failures need a cause instead of Node's repeated command line. */
export function failureDetail(err: { message: string; code?: unknown; killed?: boolean; signal?: string | null }, stderr: string, timeoutMs: number): string {
  const text = stderr.trim();
  if (text) return text;
  if (typeof err.code === 'string') return err.message.trim(); // Spawn and maxBuffer errors have useful diagnostics.
  if (err.killed) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (err.signal) return `stopped by ${err.signal}`;
  if (typeof err.code === 'number') return `exited with code ${err.code} and no error output`;
  return err.message.trim();
}

/** Run a CLI (gh, git) without a shell and return trimmed stdout. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...(opts.env ?? process.env), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = failureDetail(err, stderr?.toString() ?? '', timeoutMs);
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
