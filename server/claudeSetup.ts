// Private setup-token PTY: no office terminal, inherited credentials, or raw output leaves this boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import type * as nodePty from '@lydell/node-pty';

const require = createRequire(import.meta.url);

interface Disposable { dispose(): void }
export interface AuthPty {
  write(value: string): void;
  onData(fn: (value: string) => void): Disposable;
  onExit(fn: (value: { exitCode: number }) => void): Disposable;
  stop(): Promise<void>;
}
export type AuthPtySpawner = (file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string }) => AuthPty;

/** Bound the owned taskkill helper too, so cancellation and office shutdown can always settle. */
export async function stopClaudeAuthPty(pty: Pick<nodePty.IPty, 'pid' | 'kill'>, platform = process.platform, spawn = spawnChild) {
  try {
    if (platform === 'win32') {
      await new Promise<void>((resolve) => {
        let done = false;
        let killer: ReturnType<typeof spawnChild>;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          try { killer?.kill('SIGKILL'); } catch { /* already exited */ }
          finish();
        }, 2000);
        timer.unref();
        try {
          killer = spawn('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', finish); killer.once('exit', finish);
        } catch { finish(); }
      });
    } else {
      try { process.kill(-pty.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  } finally {
    try { pty.kill(); } catch { /* already exited */ }
  }
}

const spawnPty: AuthPtySpawner = (file, args, options) => {
  // Native binaries are optional for office startup, SDK sessions and manual tokens.
  // Load only here; launchClaudeSetup catches load/spawn failures and removes its private dirs.
  const nativePty = require('@lydell/node-pty') as typeof nodePty;
  const pty = nativePty.spawn(file, args, options);
  return {
    write: (value) => pty.write(value), onData: (fn) => pty.onData(fn), onExit: (fn) => pty.onExit(fn),
    stop: () => stopClaudeAuthPty(pty),
  };
};

export function launchClaudeSetup(file: string, spawn: AuthPtySpawner = spawnPty) {
  const repo = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const tempRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(repo, tempRoot);
  if (!relative || !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('Claude sign-in requires private temporary storage.');
  const root = fs.mkdtempSync(path.join(tempRoot, 'cubefarm-claude-setup-'));
  const folder = (name: string) => { const dir = path.join(root, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
  try {
    fs.chmodSync(root, 0o700);
    const home = folder('home'), config = folder('config'), cwd = folder('cwd'), temp = folder('tmp');
    const browser = path.join(root, process.platform === 'win32' ? 'no-browser.cmd' : 'no-browser');
    fs.writeFileSync(browser, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const env: Record<string, string> = {
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: home, XDG_CACHE_HOME: temp, APPDATA: config, LOCALAPPDATA: config,
      TMPDIR: temp, TMP: temp, TEMP: temp, BROWSER: browser,
      PATH: process.platform === 'win32' ? `${systemRoot}\\System32;${systemRoot}` : '/usr/bin:/bin:/usr/sbin:/sbin',
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8', DISABLE_AUTOUPDATER: '1',
      ...(process.platform === 'win32' ? { SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe') } : {}),
    };
    const pty = spawn(file, ['setup-token'], { cwd, env, cols: 4096, rows: 40, name: 'xterm-256color' });
    let closing: Promise<void> | undefined;
    return {
      pty,
      close: () => closing ??= (async () => {
        try { await pty.stop(); }
        finally { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      })(),
    };
  } catch {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    throw new Error('Claude sign-in could not start.');
  }
}

/** Only the CLI's manual-code authorization URL may leave the private PTY. */
export function safeClaudeAuthorizationUrl(input: string): string | null {
  if (input.length > 4096 || !/^https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth)\/authorize\?[^\s]+$/.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.username || url.password || url.port || url.hash || !((url.hostname === 'claude.ai' && url.pathname === '/oauth/authorize') || (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize'))) return null;
    const rules: Record<string, (value: string) => boolean> = {
      code: (v) => v === 'true', response_type: (v) => v === 'code',
      client_id: (v) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v),
      redirect_uri: (v) => ['https://platform.claude.com/oauth/code/callback', 'https://console.anthropic.com/oauth/code/callback'].includes(v),
      scope: (v) => v.length <= 256 && v.split(' ').every((s) => ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'].includes(s)),
      code_challenge: (v) => /^[A-Za-z0-9_-]{43,128}$/.test(v), code_challenge_method: (v) => v === 'S256',
      state: (v) => /^[A-Za-z0-9_-]{16,256}$/.test(v),
    };
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (seen.has(key) || /sk-ant-/i.test(value) || !rules[key]?.(value)) return null;
      seen.add(key);
    }
    return Object.keys(rules).every((key) => seen.has(key)) ? url.href : null;
  } catch { return null; }
}

export const validClaudeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,256}(?:#[A-Za-z0-9_-]{8,256})?$/.test(value);
