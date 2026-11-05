// Quiet-session remedies, shared by local and box sessions. Times are epoch milliseconds.
import type { SessionRemedies } from '../shared/types.ts';
export const WATCHDOG_QUIET_MS = 20 * 60_000;
export const WATCHDOG_GRACE_MS = 10 * 60_000;
export const WATCHDOG_PERIOD_MS = 60 * 60_000;

/** A nudge gets a grace period; activity after it cancels escalation. Each remedy has its own cooldown. */
export function silentSession(now: number, activityAt: number, remedies: SessionRemedies): 'nudge' | 'requeue' | null {
  if (now - activityAt < WATCHDOG_QUIET_MS) return null;
  if (remedies.nudgeAt != null && remedies.nudgeAt >= activityAt && (remedies.requeueAt == null || remedies.requeueAt < remedies.nudgeAt)) {
    if (now - remedies.nudgeAt >= WATCHDOG_GRACE_MS && (remedies.requeueAt == null || now - remedies.requeueAt >= WATCHDOG_PERIOD_MS)) return 'requeue';
    return null;
  }
  return remedies.nudgeAt == null || now - remedies.nudgeAt >= WATCHDOG_PERIOD_MS ? 'nudge' : null;
}
