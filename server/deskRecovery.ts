// Pure recovery deadlines and migration of desks saved before stop provenance existed.
import type { AgentStatus, DeskRecovery } from '../shared/types.ts';

export const DESK_COOLDOWN_MS = 2 * 60_000;
const STARTUP_DELAYS = [DESK_COOLDOWN_MS, 10 * 60_000, 30 * 60_000];
export const MAX_TASK_FAILURES = 3;

export function loginFailure(cause: string): boolean {
  return /(?:sign[ -]?in|log[ -]?in|not logged in|not authenticated|authentication (?:failed|required)|invalid (?:api key|token)|expired (?:token|credentials)|unauthorized|\b401\b)/i.test(cause);
}

export function nextStartupRetry(cause: string, failures: number, cli: string, now: number): NonNullable<DeskRecovery['startupRetry']> {
  const login = loginFailure(cause);
  const delay = STARTUP_DELAYS[failures - 1];
  return { failures, retryAt: login || delay === undefined ? null : now + delay,
    action: login ? `Sign in to ${cli}, then Clear desk to retry.` : delay === undefined ? `Repair ${cli}'s startup, then Clear desk to retry.` : null };
}

export function deskRecoveryDue(a: DeskRecovery & { status: AgentStatus; startupFailed?: boolean; endedAt: number | null }, now: number): boolean {
  if (a.status === 'stopped' && a.stoppedBy === 'manager') return false;
  if (a.startupFailed) return a.startupRetry?.retryAt != null && now >= a.startupRetry.retryAt;
  return (a.status === 'error' || (a.status === 'stopped' && a.stoppedBy === 'office')) && now - (a.endedAt ?? 0) >= DESK_COOLDOWN_MS;
}

export function migrateDeskRecovery(a: DeskRecovery & { status: AgentStatus; startupFailed?: boolean; endedAt: number | null; lastError: string | null; logTail?: { kind: string; text: string }[] }, now: number, cli: string) {
  if (a.lastError) a.lastErrorAt ??= a.endedAt ?? now;
  if (a.status === 'stopped' && !a.stoppedBy) {
    const tail = a.logTail?.findLast((l) => (l.kind === 'manager' && /^[■▶]/.test(l.text)) ||
      (l.kind === 'system' && l.text.startsWith('━━━')));
    a.stoppedBy = /stopped by manager|interrupted in the terminal/i.test(a.lastError ?? '') ||
      (tail?.kind === 'manager' && /^■ (?:Manager stopped|Interrupted)/i.test(tail.text)) ? 'manager' : 'office';
    a.endedAt ??= now;
  }
  if (a.startupFailed && !a.startupRetry) {
    a.startupRetry = nextStartupRetry(a.lastError ?? 'CLI startup failed', 1, cli, a.endedAt ?? now);
    if (a.startupRetry.action) a.lastError = `${a.lastError ?? 'CLI startup failed'}. ${a.startupRetry.action}`;
  }
}

export function taskFailure(previous: DeskRecovery['taskFailures'], key: string): NonNullable<DeskRecovery['taskFailures']> {
  return { key, count: previous?.key === key ? previous.count + 1 : 1 };
}
