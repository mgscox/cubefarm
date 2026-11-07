import { describe, expect, it } from 'vitest';
import { assignmentLabel, cost, duration, outcomeLabel, runtimeLabel, workLabel } from './runHistory';

describe('run history labels', () => {
  it('tells unknown measurements from zero', () => {
    expect(cost(null)).toBe('unknown');
    expect(cost(0)).toBe('$0.00');
    expect(duration(null)).toBe('—');
    expect(duration(0)).toBe('<1s');
  });

  it('formats durations', () => {
    expect(duration(42_000)).toBe('42s');
    expect(duration(185_000)).toBe('3m 5s');
    expect(duration(2 * 3_600_000 + 7 * 60_000)).toBe('2h 7m');
  });

  it('names the work and its PR state', () => {
    expect(workLabel({ issueNumber: 12, prNumber: null, prState: null })).toBe('#12');
    expect(workLabel({ issueNumber: 12, prNumber: 30, prState: 'MERGED' })).toBe('#12 · PR #30 (merged)');
    expect(workLabel({ issueNumber: null, prNumber: 30, prState: 'OPEN' })).toBe('PR #30');
  });

  it('shows pending, running and ended attempts', () => {
    const times = { assignedAt: 1, startedAt: null, endedAt: null };
    expect(outcomeLabel({ outcome: null, times })).toBe('pending');
    expect(outcomeLabel({ outcome: null, times: { ...times, startedAt: 2 } })).toBe('running');
    expect(outcomeLabel({ outcome: { result: 'prepare-failed', cause: 'worker' }, times })).toBe('prepare-failed · worker');
  });

  it('explains specialty matches, fallbacks and the relevant score while keeping old attempts readable', () => {
    const label = (factors: Record<string, string | number | boolean | null>) => assignmentLabel({ assignment: { reason: 'auto', factors } });
    expect(label({ score: 100 })).toBe('auto');
    const factors = { policyVersion: 'specialty-first-v2', specialty: 'server', specialtyMatch: true, scoreKind: 'authorship', score: -1 };
    expect(label(factors)).toBe('auto · server match · Authorship -1');
    expect(label({ ...factors, specialtyMatch: false, scoreKind: 'repair', score: 2 })).toBe('auto · server fallback · Repair 2');
    expect(label({ ...factors, specialty: null })).toBe('auto · any specialty · Authorship -1');
    expect(label({ policyVersion: 'qa-workload-v1', specialty: 'qa', specialtyMatch: true, scoreKind: null, score: null })).toBe('auto · qa match');
  });

  it('describes the runtime the office asked for', () => {
    const runtime = { cli: null, model: null, effort: null, playbook: null, office: '1.0.0' };
    expect(runtimeLabel({ runtime })).toBe('not started');
    expect(runtimeLabel({ runtime: { ...runtime, cli: 'codex', effort: 'high' } })).toBe('codex · CLI default model · high');
  });
});
