import { describe, expect, it } from 'vitest';
import { checkMergePr, incompleteAuditOverride } from './mergePr.ts';

describe('CEO merge preflight', () => {
  const context = () => ({
    merging: false, syncing: false, parking: false, busy: false,
    qa: { status: 'needs-human' as const, testedSha: 'tested', failedSha: 'tested' },
    pull: { state: 'OPEN' as const, headSha: 'tested', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
  });

  it('allows a manager override of failed findings at the tested SHA', () => {
    expect(checkMergePr(13, 'owner/repo', context())).toBe('tested');
  });

  it('allows a completed passing report', () => {
    expect(checkMergePr(13, 'owner/repo', { ...context(), qa: { status: 'passed', testedSha: 'tested', passedSha: 'tested' } })).toBe('tested');
  });

  it.each(['queued', 'passed', 'needs-human'] as const)('rejects an attempted head without completed evidence even when %s', (status) => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: { status, testedSha: 'tested' } })).toThrow('no completed QA report');
  });

  describe('incomplete QA', () => {
    const incomplete = { status: 'needs-human' as const, testedSha: 'tested', failedSha: null };
    const posted = { headSha: 'tested', commentUrl: 'https://github.com/owner/repo/pull/13#issuecomment-1' };

    it('accepts a manager override of a posted incomplete report at the tested SHA', () => {
      expect(checkMergePr(13, 'owner/repo', { ...context(), qa: incomplete, outcome: posted })).toBe('tested');
    });

    it('refuses a session that crashed or posted no report', () => {
      expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: incomplete, outcome: { ...posted, commentUrl: null } }))
        .toThrow('no completed QA report');
      expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: incomplete, outcome: null })).toThrow('no completed QA report');
    });

    it('refuses a new attempted head after the report', () => {
      expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: { ...incomplete, testedSha: 'unseen' }, outcome: posted,
        pull: { ...context().pull, headSha: 'unseen' } })).toThrow('no completed QA report');
    });

    it('refuses new commits pushed after the report', () => {
      expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: incomplete, outcome: posted,
        pull: { ...context().pull, headSha: 'unseen' } })).toThrow('head moved');
    });

    it.each(['queued', 'testing', 'fixing', 'failed'] as const)('does not count the report once QA is %s', (status) => {
      expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: { ...incomplete, status }, outcome: posted })).toThrow();
    });

    it('refuses a conflicting PR', () => {
      expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: incomplete, outcome: posted,
        pull: { ...context().pull, mergeable: 'CONFLICTING' } })).toThrow('conflicting');
    });
  });

  it('rejects a new attempted head after an older failed report', () => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: { status: 'queued', testedSha: 'unseen', failedSha: 'tested' },
      pull: { ...context().pull, headSha: 'unseen' } })).toThrow('no completed QA report');
  });

  it('does not treat an auto-merge branch update as completed QA of its new head', () => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: { status: 'passed', testedSha: 'tested', passedSha: 'unseen' },
      pull: { ...context().pull, headSha: 'unseen' } })).toThrow('no completed QA report');
  });

  it.each(['queued', 'needs-human'] as const)('does not treat converged attempt/update SHAs as completed QA when %s', (status) => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), qa: { status, testedSha: 'unseen', passedSha: 'unseen' },
      pull: { ...context().pull, headSha: 'unseen' } })).toThrow('no completed QA report');
  });

  it.each([
    { qa: undefined },
    { qa: { status: 'passed' as const, testedSha: null } },
    { qa: { status: 'testing' as const, testedSha: 'tested' } },
    { qa: { status: 'fixing' as const, testedSha: 'tested' } },
    { pull: { ...context().pull, headSha: 'unseen' } },
    { pull: { ...context().pull, mergeable: 'CONFLICTING' } },
    { pull: { ...context().pull, mergeState: 'DIRTY' } },
    { merging: true }, { syncing: true }, { parking: true }, { busy: true },
  ])('refuses an unsafe override: %j', (patch) => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), ...patch })).toThrow();
  });

  it.each(['CLOSED', 'MERGED'] as const)('refuses %s PRs', (state) => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), pull: { ...context().pull, state } })).toThrow('not open');
  });

  describe('incomplete security audit override', () => {
    const qa = { status: 'needs-human' as const, failedSha: null, securityReview: { qaSha: 'tested', auditBaseSha: 'base' } };
    const outcome = { headSha: 'tested', baseSha: 'base', commentUrl: 'https://github.com/owner/repo/pull/13#issuecomment-1' };
    const pr = { headSha: 'tested', baseSha: 'base' };

    it('applies to a posted audit at exactly the current head and base', () => {
      expect(incompleteAuditOverride(qa, outcome, pr)).toBe(true);
    });

    it.each([
      ['a failed audit', { qa: { ...qa, failedSha: 'tested' } }],
      ['a crashed or unposted audit', { outcome: { ...outcome, commentUrl: null } }],
      ['no recorded outcome', { outcome: null }],
      ['an audit that never started', { qa: { ...qa, securityReview: { qaSha: 'tested' } } }],
      ['no security review', { qa: { status: 'needs-human' as const, failedSha: null } }],
      ['QA running again', { qa: { ...qa, status: 'testing' as const } }],
      ['a new head', { pr: { ...pr, headSha: 'unseen' } }],
      ['a new base', { pr: { ...pr, baseSha: 'moved' } }],
      ['a report on another revision', { outcome: { ...outcome, baseSha: 'older' } }],
    ])('does not apply to %s', (_name, patch: { qa?: Parameters<typeof incompleteAuditOverride>[0]; outcome?: Parameters<typeof incompleteAuditOverride>[1]; pr?: typeof pr }) => {
      expect(incompleteAuditOverride(patch.qa ?? qa, 'outcome' in patch ? patch.outcome : outcome, patch.pr ?? pr)).toBe(false);
    });
  });
});
