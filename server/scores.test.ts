import { describe, expect, it } from 'vitest';
import type { PrContributionView, QaOutcomeView, ScoreEventView } from '../shared/types.ts';
import { deriveScoreEvents, projectScores, reconcileScores } from './scores.ts';

const scope = { repoId: 'r1', prNumber: 7 };
const history = (patch: Partial<PrContributionView> = {}): PrContributionView => ({
  ...scope, title: 'Feature', url: '', state: 'OPEN',
  original: { agentId: 'ada', name: 'Ada', submittedSha: 'sha-1', at: 100 }, repairs: [], ...patch,
});
const repair = (patch: Partial<PrContributionView['repairs'][number]> = {}): PrContributionView['repairs'][number] => ({
  id: 'fix-1', agentId: 'bob', name: 'Bob', reason: 'qa', startingSha: 'sha-1', submittedSha: 'sha-2', reviewId: 'review-1', round: 1,
  commentUrl: null, findings: null, startedAt: 300, finishedAt: 400, ...patch,
});
type Finding = QaOutcomeView['findings'][number];
const defect = (patch: Partial<Finding> = {}): Finding => ({
  id: 'f-1', key: 'toolbar', check: 'Mobile', classification: 'code', evidence: 'Head fails; base passes.', confirmed: true,
  attributableTo: { agentId: 'ada', submittedSha: 'sha-1' }, ...patch,
});
const outcome = (patch: Partial<QaOutcomeView> = {}): QaOutcomeView => ({
  id: 'qa-1', ...scope, reviewId: 'review-1', round: 1, attemptId: 'qa-1', reviewer: { agentId: 'grace', name: 'Grace' },
  startedAt: 200, finishedAt: 250, baseSha: 'base', headSha: 'sha-1', revision: 'exact', classification: 'code', observed: null,
  verdict: 'fail', summary: '', checks: [], commands: [], findings: [defect()], worker: { boxId: null, from: null, to: null, telemetry: null },
  terminalReason: null, ci: null, commentUrl: null, corrections: [], ...patch,
});
const worker: Finding = { id: 'w-1', key: 'suite', check: 'Local suite', classification: 'worker', evidence: 'OOM', confirmed: false, attributableTo: null };

/** Applies one sync the way the office does, returning the appended entries. */
const sync = (ledger: ScoreEventView[], h: PrContributionView, outcomes: QaOutcomeView[], cutoverAt = 0) => {
  const added = reconcileScores(ledger, scope, deriveScoreEvents(h, outcomes, cutoverAt), outcomes, 1000);
  ledger.push(...added);
  return added;
};
const totals = (ledger: ScoreEventView[], agentId: string) => projectScores(ledger).get(agentId);

describe('score events', () => {
  it('worker-blocked unchanged-head merge: author earns +2, the worker outcome is neutral', () => {
    const ledger: ScoreEventView[] = [];
    const blocked = outcome({ classification: 'worker', findings: [worker] });
    sync(ledger, history(), [blocked]);
    sync(ledger, history({ state: 'MERGED' }), [blocked]);
    expect(totals(ledger, 'ada')).toEqual({ authorship: { points: 2, events: 1 }, repair: { points: 0, events: 0 }, neutral: 1 });
    expect(ledger.find((e) => e.rule === 'neutral')?.reason).toContain('1 worker');
    expect(sync(ledger, history({ state: 'MERGED' }), [blocked])).toEqual([]); // duplicate sync
  });

  it('inherited-defect repair handoff: the author keeps the merge and defect, the repairer earns verified repair credit', () => {
    const ledger: ScoreEventView[] = [];
    const sendBack = outcome();
    const recheck = outcome({ id: 'qa-2', round: 2, headSha: 'sha-2', startedAt: 500, finishedAt: 600, verdict: 'pass', classification: 'pass', findings: [] });
    const h = history({ state: 'MERGED', repairs: [repair()] });
    sync(ledger, h, [sendBack, recheck]);
    expect(totals(ledger, 'ada')).toMatchObject({ authorship: { points: 1, events: 2 } });
    expect(totals(ledger, 'bob')).toMatchObject({ authorship: { points: 0, events: 0 }, repair: { points: 1, events: 1 } });
    expect(ledger.map((e) => e.id)).toEqual(['authorship:merge:r1#7', 'authorship:defect:r1#7:f-1', 'repair:fix:r1#7:fix-1']);
  });

  it('charges the original implementation once per PR and treats repeats as neutral', () => {
    const ledger: ScoreEventView[] = [];
    const second = outcome({ id: 'qa-2', reviewId: 'review-2', findings: [defect({ id: 'f-2', key: 'other' })], startedAt: 260, finishedAt: 270 });
    sync(ledger, history(), [outcome(), outcome({ id: 'qa-1b', round: 2 }), second]);
    expect(totals(ledger, 'ada')?.authorship).toEqual({ points: -1, events: 1 });
    expect(ledger.find((e) => e.id === 'neutral:qa:qa-2')?.reason).toContain('charged at most once');
  });

  it('charges a confirmed new repair regression once per submitted repair, but not a repeated unresolved defect', () => {
    const ledger: ScoreEventView[] = [];
    const h = history({ repairs: [repair()] });
    const regression = outcome({ id: 'qa-2', headSha: 'sha-2', startedAt: 500, finishedAt: 600, findings: [
      defect({ id: 'f-2', key: 'crash', attributableTo: { agentId: 'bob', submittedSha: 'sha-2' } }),
      defect({ id: 'f-3', key: 'leak', attributableTo: { agentId: 'bob', submittedSha: 'sha-2' } }),
      defect({ id: 'f-4', key: 'toolbar', attributableTo: { agentId: 'bob', submittedSha: 'sha-2' } }),
    ] });
    sync(ledger, h, [outcome(), regression]);
    expect(totals(ledger, 'bob')?.repair).toEqual({ points: -1, events: 1 });
    const neutral = ledger.find((e) => e.id === 'neutral:qa:qa-2')!.reason;
    expect(neutral).toContain('"leak": that repair is charged at most once');
    expect(neutral).toContain('"toolbar" was already reported before Bob\'s repair');
    expect(ledger.find((e) => e.id === 'neutral:repair:fix-1')?.reason).toContain('unresolved');
  });

  it.each([
    ['self-repair', repair({ agentId: 'ada', name: 'Ada' }), 'self-repair'],
    ['no-op handoff', repair({ submittedSha: 'sha-1' }), 'without a new revision'],
    ['conflict reconciliation', repair({ reason: 'conflict', startingSha: 'sha-9' }), 'without a scored defect'],
  ])('%s is neutral', (_name, attempt, text) => {
    const ledger: ScoreEventView[] = [];
    const recheck = outcome({ id: 'qa-2', headSha: attempt.submittedSha, startedAt: 500, finishedAt: 600, verdict: 'pass', findings: [] });
    sync(ledger, history({ repairs: [attempt] }), [outcome(), recheck]);
    expect(totals(ledger, attempt.agentId)?.repair).toEqual({ points: 0, events: 0 });
    expect(ledger.find((e) => e.id === 'neutral:repair:fix-1')?.reason).toContain(text);
  });

  it('needs an independent, conclusive recheck at the submitted revision before repair credit', () => {
    const h = history({ repairs: [repair()] });
    const at = { id: 'qa-2', headSha: 'sha-2', startedAt: 500, finishedAt: 600, verdict: 'pass' as const, findings: [] };
    for (const recheck of [
      outcome({ ...at, reviewer: { agentId: 'bob', name: 'Bob' } }),
      outcome({ ...at, revision: 'stale' }),
      outcome({ ...at, headSha: 'sha-3' }),
      outcome({ ...at, verdict: 'fail', findings: [worker] }),
      outcome({ ...at, verdict: 'incomplete' }),
    ]) {
      const ledger: ScoreEventView[] = [];
      sync(ledger, h, [outcome(), recheck]);
      expect(totals(ledger, 'bob')?.repair.points ?? 0).toBe(0);
    }
  });

  it('gives repair credit once per agent per PR', () => {
    const ledger: ScoreEventView[] = [];
    const h = history({ repairs: [repair(), repair({ id: 'fix-2', startingSha: 'sha-3', submittedSha: 'sha-4', startedAt: 800, finishedAt: 900 })] });
    sync(ledger, h, [
      outcome(), outcome({ id: 'qa-2', headSha: 'sha-2', startedAt: 500, finishedAt: 600, verdict: 'pass', findings: [] }),
      outcome({ id: 'qa-3', headSha: 'sha-3', startedAt: 700, finishedAt: 750, findings: [defect({ id: 'f-9', key: 'late' })] }),
      outcome({ id: 'qa-4', headSha: 'sha-4', startedAt: 950, finishedAt: 990, verdict: 'pass', findings: [] }),
    ]);
    expect(totals(ledger, 'bob')?.repair).toEqual({ points: 1, events: 1 });
    expect(ledger.find((e) => e.id === 'neutral:repair:fix-2')?.reason).toContain('once per PR');
  });

  it('scores nothing for unknown attribution, unverified authorship or a contribution after the review began', () => {
    const ledger: ScoreEventView[] = [];
    sync(ledger, history({ original: null, state: 'MERGED' }), [outcome()]);
    sync(ledger, history({ original: { agentId: 'ada', name: 'Ada', submittedSha: 'sha-1', at: 900 } }), [outcome({ id: 'qa-2' })]);
    expect(ledger.every((e) => e.points === 0)).toBe(true);
    expect(ledger.find((e) => e.id === 'neutral:qa:qa-1')).toMatchObject({ agentId: null, reason: expect.stringContaining('names no verified contribution') });
  });

  it('does not reconstruct evidence from before the cutover', () => {
    const ledger: ScoreEventView[] = [];
    sync(ledger, history({ state: 'MERGED', repairs: [repair()] }), [outcome({ startedAt: 120 })], 150);
    expect(ledger.map((e) => e.id)).toEqual(['neutral:repair:fix-1']);
    expect(sync([], history({ state: 'MERGED', repairs: [repair()] }), [outcome()], 2000)).toEqual([]);
  });

  it('voids and restores an event through audited corrections, and replays to the same totals', () => {
    const ledger: ScoreEventView[] = [];
    const first = outcome();
    sync(ledger, history(), [first]);
    expect(totals(ledger, 'ada')?.authorship).toEqual({ points: -1, events: 1 });
    first.corrections.push({ id: 'c-1', findingId: 'f-1', previousCorrectionId: null, actor: 'manager', reason: 'Stable retry passed', classification: 'worker', at: 1 });
    const added = sync(ledger, history(), [first]);
    expect(added.map((e) => e.id)).toEqual(['neutral:qa:qa-1', 'correction:authorship:defect:r1#7:f-1:1']);
    expect(added[1]).toMatchObject({ id: 'correction:authorship:defect:r1#7:f-1:1', points: 1, corrects: { active: false },
      evidence: { correctionId: 'c-1' }, reason: 'Voided: Finding corrected to worker by manager: Stable retry passed' });
    expect(totals(ledger, 'ada')?.authorship).toEqual({ points: 0, events: 0 });
    first.corrections.push({ id: 'c-2', findingId: 'f-1', previousCorrectionId: 'c-1', actor: 'manager', reason: 'Reproduced again', classification: 'code', at: 2 });
    expect(sync(ledger, history(), [first]).map((e) => e.reason)).toEqual(['Restored: Finding corrected to code by manager: Reproduced again',
      'Voided: Finding corrected to code by manager: Reproduced again']);
    expect(totals(ledger, 'ada')).toEqual({ authorship: { points: -1, events: 1 }, repair: { points: 0, events: 0 }, neutral: 0 });
    expect(sync(ledger, history(), [first])).toEqual([]);
    expect(projectScores(JSON.parse(JSON.stringify(ledger)))).toEqual(projectScores(ledger));
  });

  it('lets the next eligible defect take a voided one\'s place, and voids stale evidence', () => {
    const ledger: ScoreEventView[] = [];
    const first = outcome();
    const later = outcome({ id: 'qa-2', startedAt: 260, finishedAt: 270, findings: [defect({ id: 'f-2', key: 'other' })] });
    sync(ledger, history(), [first, later]);
    first.revision = 'stale';
    const added = sync(ledger, history(), [first, later]);
    expect(added.map((e) => e.id)).toEqual(['neutral:qa:qa-1', 'authorship:defect:r1#7:f-2', 'correction:authorship:defect:r1#7:f-1:1', 'correction:neutral:qa:qa-2:1']);
    expect(added[0].reason).toContain('stale revision');
    expect(added[2].reason).toBe('Voided: QA evidence is now stale');
    expect(totals(ledger, 'ada')?.authorship).toEqual({ points: -1, events: 1 });
  });
});
