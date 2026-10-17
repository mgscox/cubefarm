import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { agentBox, boxCommand, boxDeskDir, boxMainDir, loginShell, notPosix, redialDelay, retryForm, startPlace, validDestination } from './fleet.ts';

describe('agentBox', () => {
  it("is the agent's own box, else the floor's, else the office's machine", () => {
    expect(agentBox('box-a', 'box-b')).toBe('box-a');
    expect(agentBox('', 'box-b')).toBe(''); // their own choice of the office's machine overrides the floor
    expect(agentBox(null, 'box-b')).toBe('box-b');
    expect(agentBox(undefined, undefined)).toBe('');
  });
});

describe('startPlace', () => {
  const boxes: Record<string, boolean> = { up: true, down: false };
  const online = (id: string) => boxes[id] ?? null;

  it("starts a new task on the agent's box, and anything inside a task on its desk's box", () => {
    expect(startPlace('new', 'up', 'down', online)).toEqual({ box: 'up' });
    expect(startPlace('within', 'up', '', online)).toEqual({ box: '' });
    expect(startPlace('within', '', 'up', online)).toEqual({ box: 'up' });
  });

  it('waits for a box that is offline', () => {
    expect(startPlace('new', 'down', '', online)).toEqual({ wait: 'down' });
    expect(startPlace('within', '', 'down', online)).toEqual({ wait: 'down' });
  });

  it("falls back to the office's machine from a removed box", () => {
    expect(startPlace('new', 'gone', '', online)).toEqual({ box: '', fellBack: 'gone' });
    expect(startPlace('within', 'up', 'gone', online)).toEqual({ box: '', fellBack: 'gone' });
  });

  it("needs no box for the office's machine", () => {
    expect(startPlace('new', '', 'down', () => null)).toEqual({ box: '' });
  });
});

describe('validDestination', () => {
  it('takes what ssh takes as a host', () => {
    for (const d of ['ada@192.168.1.20', 'buildbox', 'ada@build-box.tail1234.ts.net', 'ada@[fe80::1%en0]', 'box_2.local']) expect(validDestination(d)).toBe(true);
  });

  it('refuses options, spaces and shell characters', () => {
    for (const d of ['', '-oProxyCommand=evil', 'ada@host; rm -rf ~', 'two words', 'host\n', 'a$(b)', 'x'.repeat(300)]) expect(validDestination(d)).toBe(false);
  });
});

describe('boxCommand', () => {
  it("runs the office's own version of the box host over ssh, which never prompts", () => {
    const { file, args } = boxCommand('ada@buildbox', '0.4.0', 'f00d', '');
    expect(file).toBe('ssh');
    expect(args).toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['--', 'ada@buildbox', loginShell('npx -y cubefarm@0.4.0 box --stdio --office f00d')]);
  });

  it('can run a checkout on the box instead', () => {
    expect(boxCommand('buildbox', '0.4.0', 'f00d', 'node ~/cubefarm/bin/cubefarm.js box').args.at(-1)).toBe(loginShell('node ~/cubefarm/bin/cubefarm.js box --stdio --office f00d'));
  });

  it('sends a Windows box the command as it is', () => {
    expect(boxCommand('winbox', '0.4.0', 'f00d', '', true).args.at(-1)).toBe('npx -y cubefarm@0.4.0 box --stdio --office f00d');
  });

  it('refuses a destination ssh would read as an option', () => {
    expect(() => boxCommand('-oProxyCommand=x', '0.4.0', 'f00d', '')).toThrow(/destination/);
  });
});

describe('box paths', () => {
  it("are built the box's way, whatever the office runs on", () => {
    const win = { workspaces: 'C:\\Users\\ada\\.cubefarm-box\\f00d\\workspaces', sep: '\\' as const };
    expect(boxDeskDir(win, 'demo-co/pixel-todo', 'ada-1234')).toBe('C:\\Users\\ada\\.cubefarm-box\\f00d\\workspaces\\demo-co__pixel-todo\\desks\\ada-1234');
    const unix = { workspaces: '/home/ada/.cubefarm-box/f00d/workspaces', sep: '/' as const };
    expect(boxMainDir(unix, 'demo-co/pixel-todo')).toBe('/home/ada/.cubefarm-box/f00d/workspaces/demo-co__pixel-todo/main');
  });
});

describe('redialDelay', () => {
  it('backs off to once a minute', () => {
    expect(redialDelay(0)).toBe(2_000);
    expect(redialDelay(3)).toBe(30_000);
    expect(redialDelay(40)).toBe(60_000);
  });
});

describe('startPlace and the coding agents a box has', () => {
  const online = () => true;
  const lacksCodex = (id: string) => (id === 'claude-only' ? 'Codex' : null);

  it("waits with a new task for a box without the agent's coding agent", () => {
    expect(startPlace('new', 'claude-only', '', online, lacksCodex)).toEqual({ wait: 'claude-only', lacks: 'Codex' });
    expect(startPlace('new', 'both', '', online, lacksCodex)).toEqual({ box: 'both' });
  });

  it('keeps a task already on the box there: it runs the CLI it started with', () => {
    expect(startPlace('within', 'both', 'claude-only', online, lacksCodex)).toEqual({ box: 'claude-only' });
  });

  it('says a box is offline before asking what it has', () => {
    expect(startPlace('new', 'claude-only', '', () => false, lacksCodex)).toEqual({ wait: 'claude-only' });
  });
});

describe('loginShell', () => {
  // The box's own shell runs it: here, sh with /bin/sh as the login shell.
  it.skipIf(process.platform === 'win32')("runs the command in the user's login shell, quotes and all", () => {
    const out = execFileSync('sh', ['-c', loginShell(`printf '%s|%s' "it's" "$0"`)], { encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } });
    expect(out).toBe("it's|/bin/sh");
  });
});

describe('notPosix', () => {
  it("knows Windows' shells saying they have no such program", () => {
    expect(notPosix("'sh' is not recognized as an internal or external command,\noperable program or batch file.")).toBe(true);
    expect(notPosix('zsh:1: command not found: npx')).toBe(false);
  });
});

describe('retryForm', () => {
  it('tries the plain form at once when cmd plainly says it has no sh', () => {
    expect(retryForm(false, "'sh' is not recognized as an internal or external command,")).toEqual({ plain: true, now: true });
  });

  it("alternates forms whatever the box said, as Windows says it in the box's own language", () => {
    expect(retryForm(false, "Der Befehl \"sh\" ist entweder falsch geschrieben oder konnte nicht gefunden werden.")).toEqual({ plain: true, now: false });
    expect(retryForm(true, 'zsh:1: command not found: npx')).toEqual({ plain: false, now: false });
  });
});
