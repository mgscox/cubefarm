import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { adoptPty, hooksReady, keeperHookUrl, keeperPid, leaveKeeper, spawnPty, startKeeper, terminalsAvailable } from './ptyClient.ts';
import { stopTestKeeper } from './test/keeper.ts';

// The terminal keeper for real: its own process, a real pseudo-terminal, and an office that restarts in between.
// (A short temp folder: macOS caps a Unix socket path at 104 characters.)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-keeper-'));
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

afterAll(async () => {
  leaveKeeper();
  if (fs.existsSync(path.join(home, 'pty.secret'))) await stopTestKeeper(home);
  await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 15_000);

describe.skipIf(!terminalsAvailable)('the terminal keeper', () => {
  it('approves PreToolUse while the office gives no answer, then forwards it after reconnect', { timeout: 15_000 }, async () => {
    await startKeeper(home, () => { throw new Error('office hook unavailable'); });
    const url = `${keeperHookUrl()}/api/hooks/missed-permission`;
    leaveKeeper();
    const body = { hook_event_name: 'PreToolUse', tool_name: 'mcp__playwright__browser_navigate' };
    // No office can answer: this must finish well before the keeper's old 110s empty-answer timeout.
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    expect(await response.json()).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    const forwarded: unknown[] = [];
    await startKeeper(home, (token, body) => { forwarded.push({ token, body }); return {}; });
    hooksReady();
    for (let i = 0; i < 100 && !forwarded.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(forwarded).toEqual([{ token: 'missed-permission', body }]);
    leaveKeeper();
  });

  it('keeps a CLI running through an office restart, with its output and the hook it sent meanwhile', { timeout: 60_000 }, async () => {
    expect(await startKeeper(home, () => ({ answeredBy: 'nobody yet' }))).toEqual([]);
    expect(keeperHookUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(keeperPid()).toBeGreaterThan(0);

    // A CLI stand-in: it starts, calls a hook while the office is away, prints the answer and exits.
    const hookUrl = `${keeperHookUrl()}/api/hooks/tok-1`;
    const script = [
      "console.log('started');",
      `setTimeout(async () => { const r = await fetch(${JSON.stringify(hookUrl)}, { method: 'POST', body: JSON.stringify({ hook_event_name: 'Stop' }) }); console.log('answer ' + (await r.text())); setTimeout(() => process.exit(3), 300); }, 1500);`,
    ].join(' ');
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const first = spawnPty(process.execPath, ['-e', script], { cols: 100, rows: 20, cwd: home, env }, { agentId: 'ada' });
    let seen = '';
    first.onData((d) => (seen += plain(d)));
    hooksReady();
    for (let i = 0; i < 100 && !seen.includes('started'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContain('started');

    // The office restarts: it leaves the keeper, and a new one connects and finds the CLI still running.
    leaveKeeper();
    await new Promise((r) => setTimeout(r, 300));
    const hooks: unknown[] = [];
    const held = await startKeeper(home, (token, body) => {
      hooks.push({ token, body });
      return { answeredBy: 'the office after its restart' };
    });
    expect(held.map((h) => [h.meta, h.exit])).toEqual([[{ agentId: 'ada' }, null]]);

    const again = adoptPty(held[0]);
    let after = '';
    again.onData((d) => (after += plain(d)));
    const code = new Promise<number>((resolve) => again.onExit(resolve));
    hooksReady();
    expect(await code).toBe(3);
    expect(hooks).toEqual([{ token: 'tok-1', body: { hook_event_name: 'Stop' } }]);
    expect(after).toContain('answer {"answeredBy":"the office after its restart"}');
  });
});
