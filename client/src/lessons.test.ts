import { describe, expect, it } from 'vitest';
import type { LessonSource, LessonVersion, QaOutcomeView, RunAttemptView } from '../../shared/types';
import type { LessonSuggestion } from '../../shared/lessons';
import { sourceLabel, suggestionInput, verificationOptions, versionInput } from './lessons';

const finding: LessonSource = { kind: 'finding', ref: 'f1', qaOutcomeId: 'o1', prNumber: 11, sha: 'abcdef123456', classification: 'code', url: null, summary: 'Overflow.' };

describe('lesson drafts', () => {
  it('drafts a recurring finding with its findings, the specialty of its PRs and the re-review that passed', () => {
    const s: LessonSuggestion = {
      repoId: 'r', key: 'toolbar-overflow', check: 'Mobile layout (375px)', kind: 'agent',
      findings: [{ qaOutcomeId: 'o1', findingId: 'f1', prNumber: 11, sha: null }, { qaOutcomeId: 'o3', findingId: 'f3', prNumber: 12, sha: null }],
      fix: { qaOutcomeId: 'o4', prNumber: 12, sha: null },
    };
    const attempts = [{ repoId: 'r', prNumber: 12, specialty: 'frontend' }, { repoId: 'r', prNumber: 99, specialty: 'server' }] as RunAttemptView[];
    expect(suggestionInput(s, attempts)).toEqual({
      kind: 'agent', specialty: 'frontend', title: 'Mobile layout (375px)', guidance: '',
      sources: [{ qaOutcomeId: 'o1', findingId: 'f1' }, { qaOutcomeId: 'o3', findingId: 'f3' }],
      verification: { kind: 'fix', qaOutcomeId: 'o4' },
    });
    expect(suggestionInput({ ...s, fix: null }, []).verification).toEqual({ kind: 'fix' });
  });

  it('turns a version back into the links it was drafted from', () => {
    const v = {
      kind: 'operational', specialty: null, title: 'T', guidance: 'G',
      sources: [finding, { ...finding, kind: 'attempt', ref: 'a1', qaOutcomeId: null }, { ...finding, kind: 'link', ref: 'https://x.test/ci', summary: 'CI log' }],
      verification: { kind: 'regression-test', test: 'e2e/t.spec.ts', evidence: { ...finding, kind: 'attempt', ref: 'a2', qaOutcomeId: null } },
    } as LessonVersion;
    expect(versionInput(v)).toEqual({
      kind: 'operational', specialty: null, title: 'T', guidance: 'G',
      sources: [{ qaOutcomeId: 'o1', findingId: 'f1' }, { attemptId: 'a1' }, { url: 'https://x.test/ci', summary: 'CI log' }],
      verification: { kind: 'regression-test', test: 'e2e/t.spec.ts', attemptId: 'a2' },
    });
  });

  it('labels a source by what it is, its PR and short revision', () => {
    expect(sourceLabel(finding)).toBe('code finding · PR #11 · abcdef1');
    expect(sourceLabel({ ...finding, kind: 'link', prNumber: null, sha: null })).toBe('link');
    expect(sourceLabel({ ...finding, kind: 'attempt' })).toBe('QA review · PR #11 · abcdef1');
    expect(sourceLabel({ ...finding, kind: 'attempt', qaOutcomeId: null })).toBe('attempt · PR #11 · abcdef1');
  });
});

it('offers passing reviews and successful attempts on the floor as verification, newest first and once each', () => {
  const outcomes = [
    { id: 'q1', attemptId: 'q1', repoId: 'r', prNumber: 11, round: 2, verdict: 'pass', headSha: 'abcdef123', finishedAt: 50 },
    { id: 'q0', repoId: 'r', prNumber: 11, round: 1, verdict: 'fail', headSha: 'x', finishedAt: 40 },
    { id: 'q9', repoId: 'other', prNumber: 1, round: 1, verdict: 'pass', headSha: 'y', finishedAt: 90 },
  ] as QaOutcomeView[];
  const run = (id: string, result: string, endedAt: number) => ({ id, repoId: 'r', task: 'fix', prNumber: 12, issueNumber: 2, agent: { name: 'Ada' }, times: { endedAt, assignedAt: 0 }, outcome: { result } }) as unknown as RunAttemptView;
  expect(verificationOptions('r', outcomes, [run('a1', 'repaired', 60), run('a2', 'no-change', 70), run('q1', 'qa-passed', 50)]).map((o) => [o.value, o.label])).toEqual([
    ['attempt:a1', 'fix PR #12 repaired (Ada)'],
    ['qa:q1', 'PR #11 QA round 2 passed at abcdef1'],
  ]);
  // The review is matched to its run by attemptId, not by sharing an id.
  const reviewed = [{ ...outcomes[0], id: 'q2', attemptId: 'run7' }];
  expect(verificationOptions('r', reviewed, [run('run7', 'qa-passed', 50)]).map((o) => o.value)).toEqual(['qa:q2']);
});
