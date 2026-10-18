import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandFor, detectClis } from './clis.ts';
import { writeCliSession } from './cliFiles.ts';
import { run } from './exec.ts';
import type { CliPlan } from './machine.ts';

// Version probes are faked: no installed agent CLI is run by these tests.
vi.mock('./exec.ts', () => ({ run: vi.fn(async () => 'test version') }));

let home: string;
const win = process.platform === 'win32';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli home '));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  for (const key of Object.keys(process.env).filter((k) => k.toUpperCase() === 'PATH')) vi.stubEnv(key, '');
  vi.stubEnv('PATH', '');
  vi.stubEnv('PATHEXT', '.EXE;.CMD;.BAT;.COM');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

function install(folder: string[], cli = 'opencode') {
  const dir = path.join(home, ...folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cli}${win ? '.exe' : ''}`);
  fs.writeFileSync(file, '', { mode: 0o755 });
  return file;
}

describe('CLI installer folders outside PATH', () => {
  it.each([['.opencode', 'bin'], ['.local', 'bin'], ['.bun', 'bin'], ['.npm-global', 'bin']])('detects and prepares OpenCode in ~/%s/%s', async (...folder) => {
    const file = install(folder);
    expect(commandFor('opencode')).toEqual({ file, args: [] });
    expect((await detectClis()).find((c) => c.id === 'opencode')).toMatchObject({ installed: true, version: 'test version' });
    expect(run).toHaveBeenCalledWith(file, ['--version'], { timeoutMs: 20_000 });

    const plan: CliPlan = {
      cli: 'opencode', token: `fallback-${folder[0]}`, sessionId: 'test', cwd: home, prompt: 'test', systemAppend: '',
      model: '', effort: '', name: 'Ada', role: 'dev', additionalDirectories: [], browserTesting: false, officeUrl: 'http://127.0.0.1:0', officeTools: false,
    };
    const launch = writeCliSession(plan, { url: plan.officeUrl, held: false });
    expect(launch.file).toBe(file);
    expect(launch.cwd).toBe(home);
    fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('prefers PATH over installer folders, and detects a common folder for Codex too', () => {
    const onPath = install(['custom']);
    install(['.opencode', 'bin']);
    vi.stubEnv('PATH', path.dirname(onPath));
    expect(commandFor('opencode')?.file).toBe(onPath);
    const codex = install(['.local', 'bin'], 'codex');
    expect(commandFor('codex')?.file).toBe(codex);
  });

  it('reports absent executables and names every fallback folder in the launch error', async () => {
    expect((await detectClis()).find((c) => c.id === 'opencode')?.installed).toBe(false);
    expect(() => writeCliSession({ cli: 'opencode' } as CliPlan, { url: '', held: false }))
      .toThrow('no "opencode" on PATH or in ~/.opencode/bin, ~/.local/bin, ~/.bun/bin, ~/.npm-global/bin');
  });

  it.skipIf(win)('ignores files without execute permissions', () => {
    const file = install(['.opencode', 'bin']);
    fs.chmodSync(file, 0o644);
    expect(commandFor('opencode')).toBeNull();
  });

  it.skipIf(!win)('unwraps a Windows npm shim found outside PATH', () => {
    const dir = path.join(home, '.local', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.cmd'), '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n');
    expect(commandFor('opencode')).toEqual({ file: path.join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'), args: [] });
  });
});
