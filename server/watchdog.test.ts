import { describe, expect, it } from 'vitest';
import { silentSession, WATCHDOG_GRACE_MS, WATCHDOG_PERIOD_MS, WATCHDOG_QUIET_MS } from './watchdog.ts';

describe('silent sessions', () => {
  const start = 1000;
  const quiet = start + WATCHDOG_QUIET_MS;

  it('nudges only after twenty minutes without hooks or terminal output', () => {
    expect(silentSession(quiet - 1, start, {})).toBeNull();
    expect(silentSession(quiet, start, {})).toBe('nudge');
  });

  it('allows ten minutes after the nudge, then requeues once', () => {
    expect(silentSession(quiet + WATCHDOG_GRACE_MS - 1, start, { nudgeAt: quiet })).toBeNull();
    expect(silentSession(quiet + WATCHDOG_GRACE_MS, start, { nudgeAt: quiet })).toBe('requeue');
    expect(silentSession(quiet + WATCHDOG_GRACE_MS + 1, start, { nudgeAt: quiet, requeueAt: quiet + WATCHDOG_GRACE_MS })).toBeNull();
  });

  it('activity after a nudge cancels that escalation', () => {
    expect(silentSession(quiet + WATCHDOG_GRACE_MS, quiet + 1, { nudgeAt: quiet })).toBeNull();
    expect(silentSession(quiet + WATCHDOG_PERIOD_MS, quiet + 1, { nudgeAt: quiet })).toBe('nudge');
  });

  it('does not repeat either remedy for the same item within an hour, including a new session', () => {
    const remedies = { nudgeAt: quiet, requeueAt: quiet + WATCHDOG_GRACE_MS };
    expect(silentSession(quiet + WATCHDOG_PERIOD_MS - 1, quiet + WATCHDOG_GRACE_MS + 1, remedies)).toBeNull();
    expect(silentSession(quiet + WATCHDOG_PERIOD_MS, quiet + WATCHDOG_GRACE_MS + 1, remedies)).toBe('nudge');
    expect(silentSession(quiet + WATCHDOG_PERIOD_MS + WATCHDOG_GRACE_MS, quiet + WATCHDOG_GRACE_MS + 1, { ...remedies, nudgeAt: quiet + WATCHDOG_PERIOD_MS })).toBe('requeue');
  });
});
