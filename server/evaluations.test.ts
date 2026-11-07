import { describe, expect, it } from 'vitest';
import { demoEvaluation } from './demo.ts';
import { createEvaluation } from './evaluations.ts';

const fixture = () => {
  const f = demoEvaluation('demo/app', 1000);
  return { ...f, ev: { repoId: 'demo/app', lessons: [f.lesson], attempts: f.attempts, outcomes: f.outcomes } };
};

describe('saved pinned evaluations', () => {
  it('compares the pinned regression with its candidate and retains independently reviewable facts', () => {
    const f = fixture();
    const result = createEvaluation(f.input, f.ev, 1100);
    expect(result.cases[0]).toMatchObject({ id: 'toolbar-375px', baseResult: 'no', candidateResult: 'yes', comparable: true,
      candidate: { metrics: { firstPassQa: 'yes' }, evidence: [{ url: null }] } });
    expect(result.lesson).toMatchObject({ version: 1, approvedBy: 'demo reviewer' });
    expect(result.report.cohorts.find((c) => c.context.task === 'fix')).toMatchObject({ metrics: { verifiedRepair: { numerator: 1, denominator: 1 } } });
    const candidate = result.report.cohorts.find((c) => c.context.task === 'issue' && c.context.runtime.playbook === f.input.candidatePlaybook)!;
    expect(candidate).toMatchObject({ attempts: 4, smallSample: true, metrics: {
      firstPassQa: { numerator: 1, denominator: 1, unknown: 2, incomplete: 1 },
      workerBlocked: { numerator: 1, denominator: 2, unknown: 1, incomplete: 1 },
    } });
    f.outcomes[1].summary = 'Changed later.';
    f.lesson.versions[0].guidance = 'Changed later.';
    f.attempts[1].runtime.model = 'Changed later.';
    f.ev.attempts = [];
    f.ev.outcomes = [];
    expect(result.cases[0].candidate.evidence[0].summary).toBe('The toolbar buttons are reachable at 375px.');
    expect(result.lesson.guidance).toContain('Before handing off');
    expect(result.cases[0].candidate.runtime.model).toBeNull();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('flags incomparable workers and can pin the expectation that a worker block does not occur', () => {
    const f = fixture();
    f.attempts[1].worker.box = 'other-worker';
    const result = createEvaluation({ ...f.input, cases: [{ ...f.input.cases[0], metric: 'workerBlocked', expected: false }] }, f.ev, 1100);
    expect(result.cases[0]).toMatchObject({ comparable: false, baseResult: 'yes', candidateResult: 'yes', candidate: { metrics: { workerBlocked: 'no' } } });
  });
  it('rejects unapproved lessons, mismatched pins and ambiguous case identities', () => {
    const f = fixture();
    const evaluate = (input: unknown) => createEvaluation(input, f.ev, 1100);
    expect(() => evaluate({ ...f.input, candidatePlaybook: f.input.basePlaybook })).toThrow(/distinct/);
    expect(() => evaluate({ ...f.input, cases: [...f.input.cases, ...f.input.cases] })).toThrow(/unique/);
    expect(() => evaluate({ ...f.input, cases: [{ ...f.input.cases[0], baseAttemptId: f.attempts[1].id }] })).toThrow(/Pinned attempt/);
    expect(() => evaluate({ ...f.input, cases: [{ ...f.input.cases[0], metric: 'verifiedRepair' }] })).toThrow(/apply/);
    f.lesson.reviews.pop();
    expect(() => evaluate(f.input)).toThrow(/approved lesson/);
  });
  it('keeps only redacted summaries and safe links, without commands, transcripts or screenshots', () => {
    const f = fixture();
    f.outcomes[1].summary = 'token=private-value';
    f.outcomes[1].commands = [{ command: 'secret-command', result: 'secret-result' }];
    const result = createEvaluation(f.input, f.ev, 1100);
    expect(result.cases[0].candidate.evidence[0].summary).toBe('token=[redacted]');
    expect(JSON.stringify(result)).not.toContain('secret-command');
    f.outcomes[1].commentUrl = 'https://example.com/artifact?token=private-value';
    expect(() => createEvaluation(f.input, f.ev, 1100)).toThrow(/credentials/);
  });
});
