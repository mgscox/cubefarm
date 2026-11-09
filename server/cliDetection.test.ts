import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoxOps } from './boxOps.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandFor, detectClis } from './clis.ts';
import { writeCliSession } from './cliFiles.ts';
import { run } from './exec.ts';
import type { CliPlan } from './machine.ts';
import { saveClaudeToken } from '../bin/claudeAuth.js';

// Version probes are faked: no installed agent CLI is run by these tests.
vi.mock('./exec.ts', () => ({ run: vi.fn(async () => 'test version'), git: async () => '' }));
// Staging skills into a Codex desk needs git and a worktree; this file only checks the session files.
vi.mock('./repoSkills.ts', async (load) => ({ ...await load<typeof import('./repoSkills.ts')>(), stageCodexSkills: vi.fn() }));

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

  it('prepares a box-local v2 plugin package and posts to its keeper rather than the office', async () => {
    install(['.opencode', 'bin']);
    const box = createBoxOps({ hookUrl: () => 'http://127.0.0.1:45678', pids: () => [], root: home });
    const plan: CliPlan = {
      cli: 'opencode', token: 'box-plugin', sessionId: 'test', cwd: path.join(home, 'desk with spaces'), prompt: 'QA', systemAppend: '',
      model: '', effort: '', name: 'Nancy', role: 'qa', additionalDirectories: [], browserTesting: false, officeUrl: 'http://office.invalid', officeTools: false,
    };
    await box.rpc('prepare', [plan]);
    const launch = box.take(plan.token)!;
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toHaveLength(1);
    const folder = fileURLToPath(config.plugins[0]);
    expect(path.dirname(folder)).toBe(path.join(path.dirname(path.dirname(launch.dir)), 'bin'));
    expect(fs.statSync(folder).isDirectory()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'))).toMatchObject({ main: './index.js', type: 'module' });
    expect(fs.readFileSync(path.join(folder, 'index.js'), 'utf8')).toContain("id: 'cubefarm'");
    expect(launch.env.CUBEFARM_NOTIFY_URL).toBe('http://127.0.0.1:45678/api/hooks/box-plugin');
    fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('deletes a box job’s disposable files and preserves its session and desk', async () => {
    install(['.opencode', 'bin']);
    const box = createBoxOps({ hookUrl: () => 'http://127.0.0.1:45678', pids: () => [], root: home });
    const plan: CliPlan = {
      cli: 'opencode', token: 'box-job-scratch', sessionId: 'test', cwd: home, prompt: 'QA', systemAppend: '',
      model: '', effort: '', name: 'Nancy', role: 'qa', additionalDirectories: [], browserTesting: false,
      officeUrl: 'http://office.invalid', officeTools: false,
    };
    await box.rpc('prepare', [plan]);
    const launch = box.take(plan.token)!;
    const scratch = launch.env.CUBEFARM_JOB_SCRATCH;
    try {
      expect(fs.statSync(scratch).isDirectory()).toBe(true);
      fs.writeFileSync(path.join(home, 'uncommitted.txt'), 'keep');
      fs.mkdirSync(path.join(scratch, 'node_modules'));
      fs.writeFileSync(path.join(scratch, 'node_modules', 'package.txt'), 'discard');
      if (!win) fs.chmodSync(path.join(scratch, 'node_modules'), 0o500);
      fs.symlinkSync(home, path.join(scratch, 'desk-link'), win ? 'junction' : 'dir');
      const release = () => box.rpc('releaseDesk', ['demo-co/example', 'nancy', 0, launch.dir]);
      await release();
      await release();
      expect(fs.readdirSync(scratch)).toEqual([]);
      expect(fs.readFileSync(path.join(home, 'uncommitted.txt'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(launch.dir, 'instructions.md'), 'utf8')).toContain('CUBEFARM_JOB_SCRATCH');

      fs.rmdirSync(scratch);
      fs.symlinkSync(home, scratch, win ? 'junction' : 'dir');
      await expect(release()).rejects.toThrow('Invalid session scratch location');
      expect(fs.readFileSync(path.join(home, 'uncommitted.txt'), 'utf8')).toBe('keep');
    } finally {
      fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('uses the office credential only for the prepared Claude process', async () => {
    install(['.local', 'bin'], 'claude');
    vi.stubEnv('SWARM_HOME', home);
    const local = 'sk-ant-oat01-' + 'l'.repeat(36);
    const office = 'sk-ant-oat01-' + 'o'.repeat(36);
    await saveClaudeToken(home, local);
    const box = createBoxOps({ hookUrl: () => 'http://127.0.0.1:45678', pids: () => [], root: home });
    const plan: CliPlan = {
      cli: 'claude', token: 'box-auth', sessionId: 'test', cwd: home, prompt: 'Test', systemAppend: '',
      model: '', effort: '', name: 'Test', role: 'dev', additionalDirectories: [], browserTesting: false, officeUrl: 'http://office.invalid', officeTools: false,
    };
    await expect(box.rpc('prepare', [{ ...plan, cli: 'codex' }, [], office])).rejects.toThrow('Invalid office Claude credential');
    await expect(box.rpc('prepare', [plan, [], 'bad-format'])).rejects.toThrow('Invalid office Claude credential');
    for (const [credential, expected] of [[office, office], [undefined, local]] as const) {
      const reply = await box.rpc('prepare', [plan, [], credential]);
      const launch = box.take(plan.token)!;
      try {
        expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(expected);
        expect(JSON.stringify(reply)).not.toContain(office);
        expect(launch.args.join(' ')).not.toContain(office);
      } finally {
        fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5 });
      }
    }
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

describe('Codex command line', () => {
  it.each([undefined, 'thread-1'])('stays under 8,000 characters with long instructions and a long prompt (resume: %s)', (resumeId) => {
    install(['.local', 'bin'], 'codex');
    const systemAppend = `Floor rules.\n${'r'.repeat(40_000)}\nEnd of rules.`;
    const prompt = `Fix #310.\n${'p'.repeat(40_000)}\nEnd of task.`;
    const plan: CliPlan = {
      cli: 'codex', token: `codex-long-${resumeId ?? 'new'}`, sessionId: 'test', resumeId, cwd: home, prompt, systemAppend,
      model: 'gpt-6.1-sol', effort: 'high', name: 'Dennis', role: 'dev', additionalDirectories: [], browserTesting: false,
      officeUrl: 'http://127.0.0.1:0', officeTools: false,
    };
    const launch = writeCliSession(plan, { url: plan.officeUrl, held: false });
    try {
      expect([launch.file, ...launch.args].join(' ').length).toBeLessThan(8000);
      expect(launch.args.slice(-1)[0]).toBe(launch.prompt);
      const instructions = path.join(launch.dir, 'instructions.md');
      const task = path.join(launch.dir, 'task.md');
      expect(launch.args.find((a) => a.startsWith('developer_instructions='))).toContain(JSON.stringify(instructions).slice(1, -1));
      expect(launch.prompt).toContain(task);
      expect(fs.readFileSync(instructions, 'utf8').startsWith(systemAppend)).toBe(true); // plus the office's scratch note
      expect(fs.readFileSync(task, 'utf8')).toBe(prompt);
    } finally {
      fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe('Claude terminal permissions', () => {
  it.each([undefined, 'previous-session'])('prepares QA for unattended shell commands (resume: %s)', (resumeId) => {
    install(['.local', 'bin'], 'claude');
    const plan: CliPlan = {
      cli: 'claude', token: `qa-${resumeId ?? 'new'}`, sessionId: 'test', resumeId, cwd: home, prompt: 'QA', systemAppend: '',
      model: '', effort: '', name: 'Grace', role: 'qa', additionalDirectories: [], browserTesting: false, officeUrl: 'http://127.0.0.1:0', officeTools: false,
    };
    const launch = writeCliSession(plan, { url: plan.officeUrl, held: false });
    try {
      const { args } = launch;
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    } finally {
      fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
