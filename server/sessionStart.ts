// Startup liveness: a session id or fresh output always wins over the watchdog.
import type { AgentStatus, LogLine } from '../shared/types.ts';

export function startTimeouts(env: NodeJS.ProcessEnv = process.env) {
  const ms = (key: string, fallback: number) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { preparing: ms('SWARM_DESK_START_TIMEOUT_MS', 15 * 60_000), working: ms('SWARM_CLI_START_TIMEOUT_MS', 10 * 60_000) };
}

export function stuckStarting(a: { status: AgentStatus; sessionId?: string | null; startedAt?: number | null; endedAt?: number | null },
  log: Pick<LogLine, 't'>[], now: number, since = a.startedAt, timeouts = startTimeouts()) {
  if ((a.status !== 'preparing' && a.status !== 'working') || a.sessionId || a.endedAt != null || since == null) return null;
  const quietMs = now - Math.max(since, log.at(-1)?.t ?? since);
  return quietMs >= timeouts[a.status] ? { quietMs, phase: a.status === 'preparing' ? 'desk preparation' : 'CLI launch' } : null;
}
