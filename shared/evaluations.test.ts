import { describe, expect, it } from 'vitest';
import type { QaOutcomeView, RunAttemptView } from './types.ts';
import { evaluationReport, observeAttempt } from './evaluations.ts';

export const run = (id: string, patch: Partial<RunAttemptView> = {}): RunAttemptView => ({
  id, parentId: null, repoId: 'demo/app', repo: 'demo/app', task: 'issue', specialty: 'frontend', issueNumber: 1, prNumber: 10,
  agent: { id: 'dev', name: 'Dev', role: 'dev', specialty: 'frontend' }, assignment: { reason: 'manager', factors: {} },
  runtime: { cli: 'codex', model: null, effort: 'high', playbook: 'dev@111111111111', office: 'test' },
  worker: { box: '', name: 'office', healthAtStart: null, healthAtEnd: null }, revisions: { start: 'base', submitted: 'head' },
  sessionIds: [], review: null, times: { assignedAt: 10, startedAt: 11, endedAt: 20 }, usage: { sessions: 1, costUsd: null, turns: null }, events: [],
  outcome: { result: 'delivered', cause: 'agent' }, ...patch,
});
export const qa = (patch: Partial<QaOutcomeView> = {}): QaOutcomeView => ({
  id: 'qa-1', repoId: 'demo/app', prNumber: 10, reviewId: 'review-1', round: 1, attemptId: 'qa-attempt', reviewer: { agentId: 'qa', name: 'QA' },
  startedAt: 30, finishedAt: 40, baseSha: 'base', headSha: 'head', revision: 'exact', classification: 'pass', observed: null,
  verdict: 'pass', summary: 'Verified at head.', checks: [], commands: [], findings: [], worker: { boxId: null, from: null, to: null, telemetry: null },
  terminalReason: null, ci: null, commentUrl: null, corrections: [], ...patch,
});
const defect: QaOutcomeView['findings'][number] = { id: 'f', key: 'overflow', check: '375px', classification: 'code', confirmed: true, evidence: 'Overflows.', attributableTo: null };

describe('playbook evaluation observations', () => {
  it('requires exact first-round QA and keeps a missing artifact separate from its structured result', () => {
    const x = run('issue');
    expect(observeAttempt(x, [qa()])).toMatchObject({ metrics: { firstPassQa: 'yes' }, evidence: [{ outcomeId: 'qa-1', url: null, summary: 'Verified at head.' }] });
    expect(observeAttempt(x, [qa({ revision: 'stale' })]).metrics.firstPassQa).toBe('unknown');
    expect(observeAttempt(x, [qa({ round: 2 })]).metrics.firstPassQa).toBe('unknown');
    expect(observeAttempt(x, [qa({ headSha: 'other' })]).metrics.firstPassQa).toBe('unknown');
  });
  it('separates mixed worker and confirmed code evidence, and ignores pressure alone', () => {
    const worker = { ...defect, id: 'w', key: 'oom', classification: 'worker' as const };
    const x = run('qa-attempt', { task: 'qa', outcome: { result: 'qa-failed', cause: 'agent' } });
    const mixed = qa({ verdict: 'fail', findings: [defect, worker] });
    expect(observeAttempt(x, [mixed]).metrics.workerBlocked).toBe('yes');
    expect(observeAttempt(run('issue'), [mixed]).metrics.firstPassQa).toBe('no');
    expect(observeAttempt(run('issue'), [qa({ findings: [worker] })]).metrics).toMatchObject({ firstPassQa: 'incomplete', workerBlocked: 'yes' });
    expect(observeAttempt(run('pressure', { worker: { ...x.worker, healthAtStart: { status: 'constrained', constraints: ['memory'], cpuPercent: 95 } } }), []).metrics.workerBlocked).toBe('no');
  });
  it('requires independent verification of an inherited defect rather than a pushed repair', () => {
    const x = run('fix', { task: 'fix', revisions: { start: 'broken', submitted: 'fixed' }, times: { assignedAt: 50, startedAt: 51, endedAt: 60 }, outcome: { result: 'repaired', cause: 'agent' } });
    const before = qa({ headSha: 'broken', verdict: 'fail', findings: [defect] });
    const after = qa({ id: 'qa-2', headSha: 'fixed', startedAt: 70, finishedAt: 80, round: 2 });
    expect(observeAttempt(x, [before]).metrics.verifiedRepair).toBe('unknown');
    expect(observeAttempt(x, [before, after]).metrics.verifiedRepair).toBe('yes');
    const worker = { ...defect, id: 'w', key: 'oom', classification: 'worker' as const };
    expect(observeAttempt(x, [{ ...before, findings: [defect, worker] }, after]).metrics).toMatchObject({ verifiedRepair: 'yes', workerBlocked: 'no' });
    expect(observeAttempt(x, [before, { ...after, findings: [worker] }]).metrics).toMatchObject({ verifiedRepair: 'incomplete', workerBlocked: 'yes' });
    expect(observeAttempt(x, [before, { ...after, id: 'worker', findings: [worker] }, { ...after, startedAt: 90 }]).metrics).toMatchObject({ verifiedRepair: 'yes', workerBlocked: 'yes' });
    expect(observeAttempt(x, [before, { ...before, id: 'already-fixed', verdict: 'pass', findings: [], finishedAt: 49 } , after]).metrics.verifiedRepair).toBe('unknown');
    expect(observeAttempt(x, [before, { ...after, reviewer: { agentId: 'dev', name: 'Dev' } }]).metrics.verifiedRepair).toBe('unknown');
    expect(observeAttempt(x, [before, { ...after, verdict: 'fail', findings: [defect] }]).metrics.verifiedRepair).toBe('no');
  });
  it('reports denominators and small samples without merging different runtime, specialty or worker cohorts', () => {
    const base = run('base');
    const attempts = [base, run('pending', { outcome: null }), run('unknown', { revisions: { start: null, submitted: null } }),
      run('candidate', { runtime: { ...base.runtime, playbook: 'dev@222222222222' } }),
      run('other-worker', { worker: { ...base.worker, box: 'box-2' } }),
      run('other-model', { runtime: { ...base.runtime, model: 'explicit' } }),
      run('other-specialty', { specialty: 'server' }), run('other-repo', { repoId: 'other/app' }),
      run('other-playbook', { runtime: { ...base.runtime, playbook: null } })];
    const report = evaluationReport(attempts, [qa({ verdict: 'fail', findings: [defect] })], { repoId: base.repoId, specialty: null, basePlaybook: base.runtime.playbook!, candidatePlaybook: 'dev@222222222222' }, 100);
    expect(report.observations).toHaveLength(7);
    expect(report.cohorts).toHaveLength(5);
    expect(report.cohorts.find((c) => c.attempts === 3)).toMatchObject({ smallSample: true, metrics: { firstPassQa: { numerator: 0, denominator: 2, no: 2, unknown: 1 }, workerBlocked: { numerator: 0, denominator: 2, incomplete: 1 } } });
  });
});
