import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CODEX_HOOK_EVENTS, codexHookCommand, codexTurnThread, hookReviewKey, interruptions, launchArgs, NOTIFY_SOURCE, oneAtATime, trustKey, unwrapCmdShim, type LaunchContext } from './clis.ts';
import { describeTool, playwrightAction, newScreenshots, screenshotFile, summariseResult } from './agentRunner.ts';

const dir = path.join(os.tmpdir(), 'npm-global');

describe('unwrapCmdShim', () => {
  it('runs node on the script a node shim points at, keeping its node flags', () => {
    const shim = [
      '@ECHO off',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings=DEP0040 "%dp0%\\node_modules\\@acme\\cli\\bin\\cli.js" %*',
    ].join('\r\n');
    expect(unwrapCmdShim(path.join(dir, 'cli.cmd'), shim)).toEqual({ file: process.execPath, args: ['--no-warnings=DEP0040', path.join(dir, 'node_modules\\@acme\\cli\\bin\\cli.js')] });
  });

  it('runs the executable an exe shim points at', () => {
    const shim = '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
    expect(unwrapCmdShim(path.join(dir, 'opencode.cmd'), shim)).toEqual({ file: path.join(dir, 'node_modules\\opencode-ai\\bin\\opencode.exe'), args: [] });
  });

  it('gives up on shims it does not recognise', () => {
    expect(unwrapCmdShim(path.join(dir, 'x.cmd'), '@echo off\r\necho hi\r\n')).toBeNull();
  });
});

describe('trustKey', () => {
  it("moves Claude Code's trust question off its default \"No, exit\", then confirms \"Yes\"", () => {
    const question = (selected: 'no' | 'yes') =>
      [
        'Accessing workspace:',
        'C:\\Users\\me\\.cubefarm\\workspaces\\me__app\\desks\\ada-01df',
        'Quick safety check: Is this a project you created or one you trust?',
        "Claude Code'll be able to read, edit, and execute files here.",
        selected === 'no' ? '❯ No, exit' : '  No, exit',
        selected === 'yes' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder',
        'Enter to confirm · Esc to cancel',
      ].join('\n');
    expect(trustKey(question('no'))).toBe('down');
    expect(trustKey(question('yes'))).toBe('enter');
  });

  it("confirms Codex's trust question, whose first option is yes", () => {
    const screen = ['> You are in C:\\desk', '  Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit'].join('\n');
    expect(trustKey(screen)).toBe('enter');
  });

  it('leaves every other screen alone', () => {
    expect(trustKey('❯ Try "refactor <filepath>"')).toBeNull();
  });
});

describe('hookReviewKey', () => {
  const review = (selected: 1 | 3) =>
    ['  Hooks need review', '  5 hooks are new or changed.', `${selected === 1 ? '›' : ' '} 1. Review hooks`, '  2. Trust all and continue', `${selected === 3 ? '›' : ' '} 3. Continue without trusting (hooks won't run)`].join('\n');

  it("goes on without the office's hooks, leaving trust to the manager", () => {
    expect(hookReviewKey(review(1))).toBe('down');
    expect(hookReviewKey(review(3))).toBe('enter');
    expect(hookReviewKey('› Ask Codex to do anything')).toBeNull();
  });
});

describe('interruptions', () => {
  it('counts the lines where a CLI says it interrupted a turn', () => {
    expect(interruptions(['● Bash(sleep 4)', '  ⎿  Interrupted · What should Claude do instead?', '❯ '].join('\n'))).toBe(1);
    expect(interruptions('■ Conversation interrupted - tell the model what to do differently.\n› ')).toBe(1);
    expect(interruptions('● done\n❯ ')).toBe(0);
  });
});

describe('launchArgs', () => {
  const ctx = (patch: Partial<LaunchContext> = {}): LaunchContext => ({
    prompt: '--looks like a flag',
    systemAppend: 'You are Ada.',
    model: '',
    effort: 'medium',
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: 'Ada · #1',
    role: 'dev',
    additionalDirectories: [],
    files: { settings: 'settings.json', mcp: null, system: 'instructions.md' },
    notify: { script: 'notify.cjs', url: 'http://127.0.0.1:1/api/hooks/t' },
    codexHook: 'codex-hook.cjs',
    plugin: 'file:///plugin.mjs',
    browser: null,
    ...patch,
  });
  it('starts Claude Code on a chosen session id, with the prompt after --', () => {
    const { args } = launchArgs('claude', ctx());
    expect(args.slice(0, 2)).toEqual(['--session-id', '11111111-1111-1111-1111-111111111111']);
    expect(args.slice(-2)).toEqual(['--', '--looks like a flag']);
    // the manager's own setup loads: no limiting its setting sources or MCP servers
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it("resumes Claude Code sessions and keeps the CEO's hands off the shell", () => {
    const { args } = launchArgs('claude', ctx({ resumeId: 'abc', role: 'ceo', files: { settings: 's', mcp: 'mcp.json', system: 'i' } }));
    expect(args.slice(0, 2)).toEqual(['--resume', 'abc']);
    expect(args).toContain('--mcp-config');
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Bash', 'PowerShell', 'NotebookEdit']);
  });

  it("runs Codex without its sandbox or approvals, and resumes Codex's thread", () => {
    const fresh = launchArgs('codex', ctx()).args;
    expect(fresh).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(fresh).not.toContain('--sandbox');
    expect(fresh.slice(-2)).toEqual(['--', '--looks like a flag']);
    const resumed = launchArgs('codex', ctx({ resumeId: 'thread-1' })).args;
    expect(resumed[0]).toBe('resume');
    expect(resumed.slice(-2)).toEqual(['thread-1', '--looks like a flag']);
    expect(resumed).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it.each([undefined, 'thread-1'])('passes the lowercase Codex model ID (resume %s)', (resumeId) => {
    const { args } = launchArgs('codex', ctx({ model: 'GPT-6-Astra', resumeId }));
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-6-astra']);
  });

  it.each([undefined, 'thread-1'])('preserves custom Codex model IDs (resume %s)', (resumeId) => {
    const { args } = launchArgs('codex', ctx({ model: 'MyProvider/Astra', resumeId }));
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'MyProvider/Astra']);
  });

  it('preserves the model name for Claude Code', () => {
    const { args } = launchArgs('claude', ctx({ model: 'GPT-6-Astra' }));
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'GPT-6-Astra']);
  });

  it.each([undefined, 'thread-1'])("keeps Codex's office browser separate from an inherited playwright server (resume %s)", (resumeId) => {
    const browser = { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--output-dir', 'browser output'] };
    const { args } = launchArgs('codex', ctx({ browser, resumeId }));
    const servers = args.filter((arg) => arg.startsWith('mcp_servers.'));
    // Codex merges server tables: command/args under the user's HTTP `playwright` would retain its URL.
    expect(servers).toEqual([
      'mcp_servers.cubefarm_playwright={command="npx",args=["-y","@playwright/mcp@latest","--output-dir","browser output"]}',
    ]);
    expect(launchArgs('codex', ctx({ resumeId })).args.some((arg) => arg.startsWith('mcp_servers.'))).toBe(false);
  });

  it.each(['playwright', 'cubefarm_playwright'])('describes browser tools from the %s server', (server) => {
    expect(describeTool('/repo', `mcp__${server}__browser_navigate`, { url: 'http://localhost:5200' })).toBe('🌐 navigate http://localhost:5200');
    expect(describeTool('/repo', `mcp__${server}__browser_snapshot`, {})).toBe('🌐 snapshot');
    expect(playwrightAction(`mcp__${server}__browser_navigate`)).toBe('navigate');
    expect(playwrightAction(`mcp__${server}__browser_take_screenshot`)).toBe('take_screenshot');
    expect(playwrightAction('mcp__other__browser_navigate')).toBeNull();
  });

  it("gives Codex the office's hooks, with the office's address in its environment", () => {
    const { args, env } = launchArgs('codex', ctx());
    const hooks = args.filter((a) => a.startsWith('hooks.'));
    expect(hooks.map((h) => h.slice(6, h.indexOf('=')))).toEqual(CODEX_HOOK_EVENTS);
    expect(hooks[0]).toContain('type="command"');
    expect(env.CUBEFARM_HOOK_URL).toBe('http://127.0.0.1:1/api/hooks/t');
  });

  it('runs the hook program with a command that never starts with a quote on Windows', () => {
    expect(codexHookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\A B\\.cubefarm\\bin\\codex-hook.cjs', true)).toBe('node "C:\\Users\\A B\\.cubefarm\\bin\\codex-hook.cjs"');
    expect(codexHookCommand('/usr/bin/node', "/home/o'neil/.cubefarm/bin/codex-hook.cjs", false)).toBe(`'/usr/bin/node' '/home/o'"'"'neil/.cubefarm/bin/codex-hook.cjs'`);
  });

  it("lets OpenCode run without stopping to ask, and without updating itself", () => {
    const config = (patch: Partial<LaunchContext>) => JSON.parse(launchArgs('opencode', ctx(patch)).env.OPENCODE_CONFIG_CONTENT);
    for (const role of ['dev', 'qa'] as const) expect(config({ role }).permission).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' });
    expect(config({}).autoupdate).toBe(false);
  });
});

describe('codexTurnThread', () => {
  const prompt = 'Please QA pull request #9: Add the whiteboard\nURL: https://github.com/o/r/pull/9';
  type Turn = { thread: string; input: string; text: string; subagent?: boolean };
  /** The turn endings a Codex session acts on, as the runner folds them: main thread, and its text so far. */
  const session = (turns: Turn[], main: string | null = null) => {
    let lastText = '';
    const ended: string[] = [];
    for (const t of turns) {
      const next = codexTurnThread(main, t, [prompt]);
      if (next === null) continue;
      main = next;
      lastText = t.text || lastText;
      ended.push(t.thread);
    }
    return { main, ended, lastText };
  };

  it("ignores a subagent that finishes first, though it's a fork given the same prompt", () => {
    const sub = { thread: 'sub-1', input: prompt, text: 'Spec review: all good', subagent: true };
    expect(session([sub])).toEqual({ main: null, ended: [], lastText: '' });
    const report = '{"verdict":"pass"}';
    expect(session([sub, { thread: 'main', input: prompt, text: report }])).toEqual({ main: 'main', ended: ['main'], lastText: report });
  });

  it('ignores every other thread once the hooks pinned the main one', () => {
    const r = session([{ thread: 'sub-1', input: prompt, text: 'Spec review: all good' }, { thread: 'main', input: prompt, text: 'report' }], 'main');
    expect(r).toEqual({ main: 'main', ended: ['main'], lastText: 'report' });
  });

  it('ignores the side thread that titles the task, and later turns of other threads', () => {
    const r = session([
      { thread: 'title', input: `Write a title for: ${prompt}`, text: 'QA PR #9' },
      { thread: 'main', input: prompt, text: 'report' },
      { thread: 'other', input: prompt, text: 'not me' },
    ]);
    expect(r).toEqual({ main: 'main', ended: ['main'], lastText: 'report' });
  });

  it("keeps the main thread's last words when a turn ends without any", () => {
    const r = session([{ thread: 'main', input: prompt, text: 'report' }, { thread: 'main', input: 'Carry on', text: '' }]);
    expect(r).toEqual({ main: 'main', ended: ['main', 'main'], lastText: 'report' });
  });
});

describe("Codex's notify program", () => {
  /** A UUIDv7 thread id, born at ms. */
  const threadId = (ms: number, n: number) => {
    const t = ms.toString(16).padStart(12, '0');
    return `${t.slice(0, 8)}-${t.slice(8)}-7${String(n).padStart(3, '0')}-8000-000000000000`;
  };

  it('tells the office which turn endings come from a subagent, from the session Codex saved', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-codex-'));
    const born = Date.now();
    const d = new Date(born);
    const day = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    fs.mkdirSync(day, { recursive: true });
    const main = threadId(born, 1);
    const sub = threadId(born + 1000, 2);
    const save = (id: string, meta: object) =>
      fs.writeFileSync(path.join(day, `rollout-2026-10-02T09-21-12-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, ...meta, base_instructions: { text: 'x'.repeat(100_000) } } })}\n{"type":"event_msg"}\n`);
    save(main, { session_id: main, source: 'cli', thread_source: 'user' });
    save(sub, { session_id: main, parent_thread_id: main, source: { subagent: { thread_spawn: { parent_thread_id: main } } }, thread_source: 'subagent' });
    const script = path.join(home, 'notify.cjs');
    fs.writeFileSync(script, NOTIFY_SOURCE);

    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/hooks/t`;
    const notify = (thread: string) =>
      promisify(execFile)(process.execPath, [script, url, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': thread, 'input-messages': ['Please QA'], 'last-assistant-message': 'done' })], {
        env: { ...process.env, CODEX_HOME: home },
      });
    try {
      for (const t of [sub, main, threadId(born, 3)]) await notify(t);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
    expect(bodies.map((b) => [b.session_id, b.subagent])).toEqual([
      [sub, true],
      [main, false],
      [threadId(born, 3), false], // not saved (yet): taken as it comes
    ]);
    expect(bodies[0]).toMatchObject({ hook_event_name: 'TurnComplete', last_assistant_message: 'done', input: 'Please QA' });
  });
});

describe('oneAtATime', () => {
  it("runs a thread's archive and unarchive in order, other threads alongside, past a step that fails", async () => {
    const steps = oneAtATime();
    const done: string[] = [];
    let release!: () => void;
    const exited = new Promise<void>((r) => (release = r));
    const archive = steps('a', async () => {
      await exited;
      done.push('archive a');
      throw new Error('already archived');
    });
    const unarchive = steps('a', async () => void done.push('unarchive a'));
    await steps('b', async () => void done.push('archive b'));
    expect(done).toEqual(['archive b']);
    release();
    await expect(archive).resolves.toBeUndefined();
    await unarchive;
    expect(done).toEqual(['archive b', 'archive a', 'unarchive a']);
  });
});

describe('screenshotFile', () => {
  it("reads a Playwright screenshot that was saved to a file instead of returned inline", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shot-'));
    fs.mkdirSync(path.join(cwd, '.playwright-mcp'));
    fs.writeFileSync(path.join(cwd, '.playwright-mcp', 'pr16-375.png'), 'png-bytes');
    const shot = screenshotFile(cwd, '### Result\n- [Screenshot of viewport](.playwright-mcp/pr16-375.png)');
    expect(shot?.mime).toBe('image/png');
    expect(shot?.data.toString()).toBe('png-bytes');
    expect(screenshotFile(cwd, '### Result\n- no link here')).toBeNull();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("Codex's file edits in the log", () => {
  it('names the files an apply_patch touches, and says when it worked', () => {
    const patch = '*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch';
    expect(describeTool(dir, 'apply_patch', { command: patch })).toBe('Edit add notes.txt, src/app.ts');
    expect(summariseResult(dir, 'apply_patch', 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA notes.txt')).toEqual([{ kind: 'result', text: '  ⎿ Updated' }]);
    expect(summariseResult(dir, 'apply_patch', 'error: patch did not apply')[0].text).toContain('patch did not apply');
  });
});

describe('newScreenshots', () => {
  it("picks up the images a browser saved, oldest first, once they're written and only once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-'));
    const later = Date.now() + 5000;
    for (const f of ['page-2026-09-29T10-00-02-000Z.jpeg', 'page-2026-09-29T10-00-01-000Z.png', 'page-2026-09-29T10-00-00-000Z.yml']) fs.writeFileSync(path.join(dir, f), 'x');
    const seen = new Set<string>();
    expect(newScreenshots(dir, seen)).toEqual([]); // just written: may still be in progress
    const found = newScreenshots(dir, seen, later);
    expect(found.map((s) => [s.name, s.mime])).toEqual([
      ['page-2026-09-29T10-00-01-000Z.png', 'image/png'],
      ['page-2026-09-29T10-00-02-000Z.jpeg', 'image/jpeg'],
    ]);
    seen.add(found[0].name);
    expect(newScreenshots(dir, seen, later).map((s) => s.name)).toEqual(['page-2026-09-29T10-00-02-000Z.jpeg']);
    expect(newScreenshots(path.join(dir, 'missing'), seen, later)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
