import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { bootNotice, claudeConversation, claudeTurn, claudeWorking, cliExit, readClaudeTurn, CODEX_HOOK_EVENTS, codexHookCommand, codexTurnThread, CROSS_TURN_TOOLS, hookReviewKey, idlePromptWatch, interruptions, launchArgs, lostConversation, menuOnScreen, menuWatch, NOTIFY_SOURCE, oneAtATime, resumableSession, STUCK_MS, trustKey, unwrapCmdShim, type LaunchContext } from './clis.ts';
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

describe('the stuck-at-a-menu watchdog', () => {
  const picker = ['Working directory · resume', '› 1. Use session directory (/w/desks/dennis-5cfb)', '  2. Use current directory (/w/desks/barbara-8528)', '', 'Press enter to continue'].join('\n');

  it("spots a numbered menu waiting for a choice, not a CLI's prompt or its output", () => {
    expect(menuOnScreen(picker)).toBe('Use session directory (/w/desks/dennis-5cfb)');
    expect(menuOnScreen(['Do you want to proceed?', '❯ 1. Yes', '  2. No'].join('\n'))).toBe('Yes');
    expect(menuOnScreen(['  Sign in with ChatGPT to use Codex', '> 1. Sign in with ChatGPT', '     Usage included with Plus', '  2. Sign in with Device Code'].join('\n'))).toBe('Sign in with ChatGPT');
    expect(menuOnScreen('› Ask Codex to do anything')).toBeNull();
    expect(menuOnScreen(['● Plan:', '  1. Read the issue', '  2. Fix it', '❯ '].join('\n'))).toBeNull();
    expect(menuOnScreen('› 1. Only option')).toBeNull();
  });

  it('gives up on a menu that sat unchanged, with no hooks or keys, for the whole limit', () => {
    const watch = menuWatch(STUCK_MS, 0);
    expect(watch.look(picker, 1000)).toBeNull();
    expect(watch.look(picker, STUCK_MS - 1)).toBeNull();
    expect(watch.look(picker, STUCK_MS + 1000)).toBe('Use session directory (/w/desks/dennis-5cfb)');
  });

  it('starts over when the screen changes, a hook arrives or the manager types', () => {
    const watch = menuWatch(STUCK_MS, 0);
    watch.look(picker, 0);
    watch.stir(STUCK_MS - 1000); // a hook, or a key pressed in the terminal
    expect(watch.look(picker, STUCK_MS + 1000)).toBeNull();
    watch.look(`${picker}\n`, 2 * STUCK_MS); // redrawn
    expect(watch.look(`${picker}\n`, 3 * STUCK_MS - 1)).toBeNull();
    expect(watch.look(`${picker}\n`, 3 * STUCK_MS)).not.toBeNull();
  });

  it("never fires on a long tool call: no menu, and the spinner's clock keeps changing the screen", () => {
    expect(STUCK_MS).toBeGreaterThanOrEqual(10 * 60_000); // longer than a CLI's own foreground-command timeout
    const watch = menuWatch(STUCK_MS, 0);
    for (let t = 0; t <= 3 * STUCK_MS; t += 30_000) expect(watch.look(`• Running npm run test:e2e\n◦ Working (${t / 1000}s • esc to interrupt)`, t)).toBeNull();
    const quiet = menuWatch(STUCK_MS, 0);
    expect(quiet.look('• Running npm run test:e2e', 3 * STUCK_MS)).toBeNull();
  });
});

describe('the idle Codex watchdog', () => {
  const prompt = '› Ask Codex to do anything';
  const refusal = `ⓘ This content can't be shown\n  1 background terminal running · /ps to view · /stop to close\n${prompt}`;

  it.each([refusal, '  We take extra care with some cybersecurity requests.'])('detects a safety refusal only after the full quiet interval', (screen) => {
    const watch = idlePromptWatch(STUCK_MS, 0);
    expect(watch.look(screen, true, 0)).toBeNull();
    expect(watch.look(screen, true, STUCK_MS - 1)).toBeNull();
    expect(watch.look(screen, true, STUCK_MS)).toBe('refusal');
  });

  it('starts the quiet interval over after a hook or keystroke', () => {
    const watch = idlePromptWatch(STUCK_MS, 0);
    watch.look(refusal, true, 0);
    watch.stir(STUCK_MS - 1000);
    expect(watch.look(refusal, true, STUCK_MS)).toBeNull();
    expect(watch.look(refusal, true, 2 * STUCK_MS - 1000)).toBe('refusal');
  });

  it('detects a missed turn ending at a plain prompt, but leaves a reported turn end alone', () => {
    const watch = idlePromptWatch(STUCK_MS, 0);
    watch.look(prompt, true, 0);
    expect(watch.look(prompt, true, STUCK_MS)).toBe('idle');
    expect(watch.look(prompt, false, STUCK_MS)).toBeNull(); // the end hook arrived
    expect(watch.look(prompt, false, 3 * STUCK_MS)).toBeNull();
    expect(watch.look(prompt, true, 3 * STUCK_MS)).toBeNull(); // a new turn gets its own interval
  });

  it('leaves static spinners, long tool calls and changing screens alone', () => {
    for (const screen of [`${refusal}\n◦ Working (esc to interrupt)`, '• Running npm test', '› 1. Only option']) {
      const watch = idlePromptWatch(STUCK_MS, 0);
      watch.look(screen, true, 0);
      expect(watch.look(screen, true, 2 * STUCK_MS)).toBeNull();
    }
    const watch = idlePromptWatch(STUCK_MS, 0);
    for (let at = 0; at <= 3 * STUCK_MS; at += 30_000) {
      expect(watch.look(`${refusal}\nTool output ${at}`, true, at)).toBeNull();
    }
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
    cwd: path.join('desks', 'ada-1'),
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
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS, 'Bash', 'PowerShell', 'NotebookEdit']);
  });

  it('keeps tools that wait across turns away from Claude Code, but not background shells', () => {
    const { args } = launchArgs('claude', ctx());
    expect(CROSS_TURN_TOOLS).toEqual(['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']);
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS]);
    for (const cli of ['codex', 'opencode'] as const) expect(launchArgs(cli, ctx()).args.some((a) => a.includes('Monitor') || a.includes('ScheduleWakeup'))).toBe(false);
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

  it("resumes a Codex thread in the agent's own desk, so a thread from another desk can't stop at Codex's folder picker", () => {
    // Ken fixes Barbara's PR: her thread was recorded in her desk, his CLI runs in his.
    const ken = path.join('desks', 'ken-cfe2');
    const resumed = launchArgs('codex', ctx({ resumeId: 'barbaras-thread', cwd: ken })).args;
    expect(resumed.slice(resumed.indexOf('--cd'), resumed.indexOf('--cd') + 2)).toEqual(['--cd', ken]);
    expect(resumed.indexOf('--cd')).toBeLessThan(resumed.indexOf('barbaras-thread'));
    expect(resumed.slice(-2)).toEqual(['barbaras-thread', '--looks like a flag']);
    // The same developer resuming in their own desk gets the same folder they'd have had anyway.
    const own = launchArgs('codex', ctx({ resumeId: 'adas-thread' })).args;
    expect(own.slice(own.indexOf('--cd'), own.indexOf('--cd') + 2)).toEqual(['--cd', path.join('desks', 'ada-1')]);
    // A new session starts in its terminal's folder, as before.
    expect(launchArgs('codex', ctx()).args).not.toContain('--cd');
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

describe('cliExit', () => {
  const MIN = 60_000;

  it("doesn't finish a Codex session whose CLI was stopped by SIGTERM mid-task (node-pty reports code 0)", () => {
    // The live office, 2 Oct: 53 minutes in, hooks untrusted so no turn had ended, "✔ Finished · 0 turns · no PR found".
    const killed = { code: 0, signal: 15, working: true, lastText: '', ranMs: 53 * MIN };
    expect(cliExit('codex', killed)).toEqual({ ok: false, error: 'Codex was stopped (SIGTERM) before finishing.' });
    // A keeper from before this change doesn't pass the signal on: still mid-task, so still not finished.
    expect(cliExit('codex', { ...killed, signal: undefined })).toEqual({ ok: false, error: 'Codex exited in the middle of its task.' });
    expect(cliExit('claude', { ...killed, code: 143, signal: undefined, lastText: 'Earlier turn' }).ok).toBe(false);
  });

  it('finishes a CLI that quits cleanly once its turn has ended', () => {
    expect(cliExit('claude', { code: 0, working: false, lastText: 'Done: https://github.com/o/r/pull/3', ranMs: MIN })).toEqual({ ok: true, error: null });
    expect(cliExit('codex', { code: 0, working: false, lastText: '', ranMs: MIN })).toEqual({ ok: true, error: null });
  });

  it("fails one that couldn't start or crashed", () => {
    expect(cliExit('codex', { code: 0, working: false, lastText: '', ranMs: 5_000 })).toEqual({ ok: false, error: 'Codex exited before finishing.' });
    expect(cliExit('opencode', { code: 1, working: true, lastText: '', ranMs: 2_000 }).error).toBe('OpenCode exited with code 1 before finishing.');
  });
});

describe("Claude Code's conversation", () => {
  const onDisk = (files: string[]) => (file: string) => files.includes(file);
  const hook = { hook_event_name: 'PreToolUse', session_id: 'new', transcript_path: 'new.jsonl' };
  const MISSING = '\n No conversation found with session ID: 6cc74c7e-0c81-4bff-a140-cc8307c1d11b\n';
  /** A session as the runtimes drive it: hooks while it runs, then lost() if it quit before it began. */
  const run = (resumeId: string | null, hooks: Record<string, unknown>[], files: string[], exitScreen?: string) => {
    const saved: (string | null)[] = [];
    const c = claudeConversation(resumeId, (id) => saved.push(id));
    for (const b of hooks) {
      const id = resumableSession(b, onDisk(files));
      if (id) c.found(id);
    }
    const lost = exitScreen === undefined ? false : c.lost(exitScreen);
    return { saved, lost };
  };

  it("saves nothing when a new session's launch fails before its conversation is written", () => {
    expect(run(null, [], [], 'Error: something went wrong\n')).toEqual({ saved: [], lost: false });
    const early = [{ ...hook, hook_event_name: 'SessionStart' }, { ...hook, hook_event_name: 'UserPromptSubmit' }];
    expect(run(null, early, [], '')).toEqual({ saved: [], lost: false });
  });

  it('saves a new session once a hook reports its transcript on disk, and only once', () => {
    const turn = [{ ...hook, hook_event_name: 'UserPromptSubmit' }, hook, { ...hook, hook_event_name: 'Stop' }];
    expect(run(null, turn, ['new.jsonl']).saved).toEqual(['new']);
    // Written during the first turn: the hooks before it don't count, the next one does.
    const saved: string[] = [];
    const c = claudeConversation(null, (id) => saved.push(id!));
    const files: string[] = [];
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const id = resumableSession({ ...hook, hook_event_name: event }, onDisk(files));
      if (id) c.found(id);
    }
    expect(saved).toEqual([]);
    files.push('new.jsonl');
    const id = resumableSession(hook, onDisk(files));
    if (id) c.found(id);
    expect(saved).toEqual(['new']);
  });

  it("ignores subagents and calls with no transcript path (the status line) or no session", () => {
    expect(resumableSession({ ...hook, agent_id: 'sub-1' }, () => true)).toBeNull();
    expect(resumableSession({ hook_event_name: 'StatusLine', session_id: 'new' }, () => true)).toBeNull();
    expect(resumableSession({ hook_event_name: 'Stop', transcript_path: 'new.jsonl' }, () => true)).toBeNull();
  });

  it('keeps a resumed conversation that is there', () => {
    const resumed = [{ ...hook, session_id: 'old', transcript_path: 'old.jsonl' }];
    expect(run('old', resumed, ['old.jsonl'], 'Claude Code v2.1.280\n❯ ')).toEqual({ saved: [], lost: false });
  });

  it('forgets a resumed conversation Claude Code can\'t find, so the next session starts a new one', () => {
    expect(run('old', [], [], MISSING)).toEqual({ saved: [null], lost: true });
    // Nothing to forget for a new session, or once a conversation was found after all.
    expect(run(null, [], [], MISSING)).toEqual({ saved: [], lost: false });
    expect(run('old', [{ ...hook, session_id: 'other' }], ['new.jsonl'], MISSING)).toEqual({ saved: ['other'], lost: false });
  });

  it("spots Claude Code's message for a resume with nothing to resume (also in the SDK's error)", () => {
    expect(lostConversation(MISSING)).toBe(true);
    expect(lostConversation(`Claude Code process exited with code 1${MISSING}`)).toBe(true);
    expect(lostConversation('Claude Code v2.1.280\n❯ ')).toBe(false);
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

describe('claudeWorking / bootNotice', () => {
  const idle = ['╭───────────────────────────╮', '│ ✻ Welcome to Claude Code! │', '╰───────────────────────────╯', '', '> Try "fix lint errors"', '  ? for shortcuts'].join('\n');
  const trust = 'Do you trust the files in this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit';
  const spinner = '> Fix #12\n\n✻ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)';
  const tool = '● Bash(npm test)\n  ⎿  Running…';

  it('tells a working screen from a startup one', () => {
    expect(claudeWorking(spinner)).toBe(true);
    expect(claudeWorking(tool)).toBe(true);
    expect(claudeWorking('⏺ playwright - Navigate to a URL (MCP)(url: "http://localhost:5816")')).toBe(true);
    expect(claudeWorking(idle)).toBe(false);
    expect(claudeWorking(trust)).toBe(false);
    expect(claudeWorking('')).toBe(false);
  });

  it('says hooks are out of reach when it works, and that it has not started when it is idle', () => {
    expect(bootNotice('Claude Code', spinner, 'http://127.0.0.1:5000/api/hooks')).toEqual({
      boot: 'no-hooks',
      text: expect.stringMatching(/^⚠ Claude Code is working but the office isn't receiving its hooks.*check it can reach http:\/\/127\.0\.0\.1:5000\/api\/hooks; otherwise type \/hooks in the terminal and press t\. Meanwhile the office follows its transcript to see when it's done\.$/),
    });
    expect(bootNotice('Claude Code', idle, 'u')).toEqual({ boot: 'waiting', text: "⚠ Claude Code hasn't started on the task yet. Open the terminal to see what it's waiting for." });
    expect(bootNotice('Claude Code', idle, 'u', true).boot).toBe('no-hooks'); // its transcript moved
  });
});

describe('claudeTurn', () => {
  const line = (e: Record<string, unknown>) => JSON.stringify(e);
  const assistant = (id: string, content: unknown[], stop: string | null, extra = {}) => line({ type: 'assistant', uuid: `u-${id}`, message: { id, content, stop_reason: stop }, ...extra });
  const prompt = line({ type: 'user', message: { role: 'user', content: 'Fix #12' } });
  const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });

  it('follows a turn through its tool calls to its end', () => {
    const working = [prompt, assistant('m1', [{ type: 'thinking' }], 'tool_use'), assistant('m1', [{ type: 'tool_use', name: 'Bash' }], 'tool_use'), result].join('\n');
    expect(claudeTurn(working, 10)).toEqual({ bytes: 10, ended: false, mark: '', text: '' });
    const done = [working, assistant('m2', [{ type: 'text', text: 'Opened PR #7.' }], 'end_turn'), line({ type: 'system', subtype: 'turn_duration' })].join('\n');
    expect(claudeTurn(done, 20)).toEqual({ bytes: 20, ended: true, mark: 'm2', text: 'Opened PR #7.' });
  });

  it("ends on the turn's duration when the last message has no stop reason, and starts again on a new prompt", () => {
    const text = [prompt, assistant('m3', [{ type: 'text', text: 'Part one' }], null), assistant('m3', [{ type: 'text', text: 'part two' }], null)];
    expect(claudeTurn(text.join('\n'), 1).ended).toBe(false);
    text.push(line({ type: 'system', subtype: 'turn_duration', uuid: 's1' }));
    expect(claudeTurn(text.join('\n'), 1)).toMatchObject({ ended: true, mark: 'm3', text: 'Part one\npart two' });
    text.push(prompt);
    expect(claudeTurn(text.join('\n'), 1).ended).toBe(false);
  });

  it("skips a cut first line, other entries and subagents' messages", () => {
    const tail = ['{"type":"assis', line({ type: 'attachment' }), assistant('m4', [{ type: 'text', text: 'Mine' }], 'end_turn'), assistant('m5', [{ type: 'text', text: 'A subagent' }], 'end_turn', { isSidechain: true }), line({ type: 'user', isMeta: true, message: { content: 'caveat' } })].join('\n');
    expect(claudeTurn(tail, 1)).toMatchObject({ ended: true, mark: 'm4', text: 'Mine' });
  });

  it("reads a session's transcript from Claude Code's projects folder", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-claude-'));
    const cwd = path.join(home, 'desks', 'ada_1');
    const dir = path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const body = `${assistant('m6', [{ type: 'text', text: 'Done' }], 'end_turn')}\n`;
    fs.writeFileSync(path.join(dir, 'abc-123.jsonl'), body);
    expect(readClaudeTurn(cwd, 'abc-123', home)).toEqual({ bytes: Buffer.byteLength(body), ended: true, mark: 'm6', text: 'Done' });
    expect(readClaudeTurn(path.join(home, 'elsewhere'), 'abc-123', home)?.mark).toBe('m6'); // found in another project's folder
    expect(readClaudeTurn(cwd, 'missing', home)).toBeNull();
    expect(readClaudeTurn(cwd, '../abc-123', home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
