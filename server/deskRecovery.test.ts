import { describe, expect, it } from 'vitest';
import { deskRecoveryDue, migrateDeskRecovery, nextStartupRetry, taskFailure } from './deskRecovery.ts';

describe('desk recovery policy', () => {
  it('uses two, ten and thirty minute startup delays, then one actionable hold', () => {
    expect([1, 2, 3, 4].map((n) => nextStartupRetry('CLI exited', n, 'Codex', 1000).retryAt)).toEqual([121000, 601000, 1801000, null]);
    expect(nextStartupRetry('CLI exited', 4, 'Codex', 0).action).toBe("Repair Codex's startup, then Clear desk to retry.");
  });
  it.each(['Please sign in', 'Not logged in', 'Not authenticated', 'Login required', 'Authentication failed', 'expired token'])('waits for a manager for %s', (cause) => {
    expect(nextStartupRetry(cause, 1, 'Codex', 0)).toMatchObject({ retryAt: null, action: 'Sign in to Codex, then Clear desk to retry.' });
  });
  it('recovers office stops and errors, but keeps manager stops and startup holds', () => {
    const desk = { status: 'stopped' as const, stoppedBy: 'office' as const, endedAt: 1000 };
    expect(deskRecoveryDue(desk, 120999)).toBe(false);
    expect(deskRecoveryDue(desk, 121000)).toBe(true);
    expect(deskRecoveryDue({ ...desk, stoppedBy: 'manager' }, 900000)).toBe(false);
    expect(deskRecoveryDue({ ...desk, status: 'error' }, 121000)).toBe(true);
    expect(deskRecoveryDue({ ...desk, startupFailed: true, startupRetry: { failures: 4, retryAt: null, action: 'Repair CLI' } }, 900000)).toBe(false);
  });
  it('migrates old office stops, preserves manual stops, and keeps persisted deadlines', () => {
    const office = { status: 'stopped' as const, endedAt: 1000, lastError: 'The swarm server restarted while this agent was working.' };
    const manager = { ...office, lastError: 'Stopped by manager' };
    const terminal = { ...office, lastError: 'Interrupted in the terminal' };
    const startup = { status: 'error' as const, endedAt: 1000, lastError: 'Box unavailable', startupFailed: true };
    for (const a of [office, manager, terminal, startup]) migrateDeskRecovery(a, 500000, 'Codex');
    expect(office).toMatchObject({ stoppedBy: 'office', lastErrorAt: 1000 });
    expect(manager).toMatchObject({ stoppedBy: 'manager' });
    expect(terminal).toMatchObject({ stoppedBy: 'manager' });
    expect(startup).toMatchObject({ startupRetry: { retryAt: 121000, failures: 1 } });
    migrateDeskRecovery(startup, 900000, 'Codex');
    expect(startup).toMatchObject({ startupRetry: { retryAt: 121000, failures: 1 } });
  });
  it('counts failures on the same task and starts a new streak for different work', () => {
    expect(taskFailure({ key: 'r:qa:13', count: 2 }, 'r:qa:13').count).toBe(3);
    expect(taskFailure({ key: 'r:qa:13', count: 2 }, 'r:issue:66').count).toBe(1);
  });
});
