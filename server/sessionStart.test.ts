import { describe, expect, it } from 'vitest';
import { startTimeouts, stuckStarting } from './sessionStart.ts';

describe('session startup liveness', () => {
  const now = 30 * 60_000;
  const agent = { status: 'working' as const, startedAt: 0, sessionId: null, endedAt: null };

  it('uses separate configurable quiet thresholds with safe defaults', () => {
    expect(startTimeouts({})).toEqual({ preparing: 900_000, working: 600_000 });
    expect(startTimeouts({ SWARM_DESK_START_TIMEOUT_MS: '120', SWARM_CLI_START_TIMEOUT_MS: '90' })).toEqual({ preparing: 120, working: 90 });
    expect(startTimeouts({ SWARM_DESK_START_TIMEOUT_MS: '-1', SWARM_CLI_START_TIMEOUT_MS: 'oops' })).toEqual(startTimeouts({}));
    expect(stuckStarting(agent, [], now)).toEqual({ quietMs: now, phase: 'CLI launch' });
    expect(stuckStarting({ ...agent, status: 'preparing' }, [], now)).toEqual({ quietMs: now, phase: 'desk preparation' });
  });

  it('leaves running sessions, recent output, new launches and completed turns alone', () => {
    expect(stuckStarting({ ...agent, sessionId: 'thread' }, [], now)).toBeNull();
    expect(stuckStarting(agent, [{ t: now - 1 }], now)).toBeNull();
    expect(stuckStarting(agent, [], now, now - 1)).toBeNull();
    expect(stuckStarting({ ...agent, endedAt: now - 1 }, [], now)).toBeNull();
    expect(stuckStarting({ ...agent, status: 'idle' }, [], now)).toBeNull();
  });
});
