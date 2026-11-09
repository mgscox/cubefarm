import { describe, expect, it } from 'vitest';
import { CHECKS_ALERT_MS, CHECK_RERUN_GRACE_MS, MAX_MERGE_FIXES, mergeStep, securityBaseStep, type MergePull, type MergeRecord } from './mergeGate.ts';

const NOW = 1_800_000_000_000;
const base = { base: 'main' };

const pull = (p: Partial<MergePull> = {}): MergePull => ({
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  headSha: 'abc123',
  checks: 'passing',
  hasSuccessfulChecks: true,
  failedChecks: [],
  pendingChecks: [],
  ...p,
});

const record = (r: Partial<MergeRecord> = {}): MergeRecord => ({
  passedSha: 'abc123',
  mergeFixes: 0,
  pendingSince: null,
  mergeRetryAt: null,
  alerted: false,
  checkRerunSha: null,
  checkRerunAt: null,
  ...r,
});

describe('security base advances', () => {
  const docs = { aheadBy: 2, behindBy: 0, files: ['docs/research/billing.md'] };
  const changes = { aheadBy: 1, behindBy: 0, files: ['server/billing.ts'] };

  it('carries a pass across a disjoint docs-only advance', () => {
    expect(securityBaseStep(pull(), docs, changes)).toBe('carry');
  });

  it('requires reconciliation when any changed file overlaps', () => {
    expect(securityBaseStep(pull(), { ...docs, files: ['docs/research/billing.md', 'server/billing.ts'] }, changes)).toBe('base');
  });

  it.each([{ mergeable: 'CONFLICTING' }, { mergeState: 'DIRTY' }])('sends a conflicting advance to a developer: %j', (conflict) => {
    expect(securityBaseStep(pull(conflict), docs, changes)).toBe('conflict');
  });

  it.each([{ mergeable: 'UNKNOWN' }, { mergeState: 'UNKNOWN' }])('waits for fresh mergeability: %j', (unknown) => {
    expect(securityBaseStep(pull(unknown), docs, changes)).toBe('wait');
  });

  it('requires reconciliation for a behind branch, a rewritten base or an incomplete comparison', () => {
    expect(securityBaseStep(pull({ mergeState: 'BEHIND' }), docs, changes)).toBe('base');
    expect(securityBaseStep(pull(), { ...docs, behindBy: 1 }, changes)).toBe('base');
    expect(securityBaseStep(pull(), { ...docs, aheadBy: 0 }, changes)).toBe('base');
    expect(securityBaseStep(pull(), null, changes)).toBe('base');
    expect(securityBaseStep(pull(), docs, null)).toBe('base');
  });
});

describe('mergeStep', () => {
  describe('unavailable checks', () => {
    it.each(['CLEAN', 'BEHIND'])('waits without merging or updating when merge state is %s', (mergeState) => {
      expect(mergeStep(pull({ checks: 'unavailable', mergeState }), record(), NOW, base)).toMatchObject({ do: 'wait', note: expect.stringContaining('checks unavailable'), set: { pendingSince: null } });
    });

    it('still sends new commits back to QA, even when they also conflict', () => {
      expect(mergeStep(pull({ checks: 'unavailable', headSha: 'new456' }), record(), NOW, base)).toEqual({ do: 'requeue', set: {} });
      expect(mergeStep(pull({ checks: 'unavailable', headSha: 'new456', mergeable: 'CONFLICTING', mergeState: 'DIRTY' }), record(), NOW, base)).toEqual({ do: 'requeue', set: {} });
    });

    it.each([{ mergeable: 'CONFLICTING' }, { mergeState: 'DIRTY' }])('still sends conflicts back to a developer: %j', (conflict) => {
      expect(mergeStep(pull({ checks: 'unavailable', ...conflict }), record(), NOW, base)).toMatchObject({ do: 'send-back', reason: 'conflict', set: {} });
    });

    it('preserves the passed-commit backfill while clearing the pending-check clock', () => {
      expect(mergeStep(pull({ checks: 'unavailable' }), record({ passedSha: null, pendingSince: NOW - 5_000 }), NOW, base)).toMatchObject({ do: 'wait', set: { passedSha: 'abc123', pendingSince: null } });
    });

    it('fetches unknown mergeability, then waits if checks remain unavailable', () => {
      const pr = pull({ checks: 'unavailable', mergeState: 'UNKNOWN' });
      expect(mergeStep(pr, record(), NOW, base)).toEqual({ do: 'details', set: {} });
      expect(mergeStep(pr, record(), NOW, { ...base, detailed: true })).toMatchObject({ do: 'wait', note: expect.stringContaining('checks unavailable') });
    });
  });
  it('merges a clean, green PR at the commit QA passed', () => {
    expect(mergeStep(pull(), record(), NOW, base)).toEqual({ do: 'merge', set: { pendingSince: null } });
    expect(mergeStep(pull({ checks: 'none' }), record(), NOW, base).do).toBe('merge');
  });

  describe('environment-blocked local validation', () => {
    it.each([false, undefined])('requires successful check evidence when the rollup is passing (%s)', (hasSuccessfulChecks) => {
      expect(mergeStep(pull({ hasSuccessfulChecks }), record({ ciRequired: true }), NOW, base).do).toBe('wait');
      expect(mergeStep(pull({ hasSuccessfulChecks }), record(), NOW, base).do).toBe('merge');
    });
    it.each(['none', 'pending', 'unavailable'] as const)('waits when GitHub checks are %s', (checks) => {
      expect(mergeStep(pull({ checks }), record({ ciRequired: true }), NOW, base).do).toBe('wait');
    });

    it('merges only the reviewed commit with passing CI', () => {
      const rec = record({ ciRequired: true });
      expect(mergeStep(pull(), rec, NOW, base).do).toBe('merge');
      expect(mergeStep(pull({ headSha: 'unreviewed' }), rec, NOW, base).do).toBe('requeue');
      expect(mergeStep(pull({ checks: 'failing' }), rec, NOW, base)).toMatchObject({ do: 'send-back', reason: 'checks' });
      expect(mergeStep(pull({ mergeState: 'DIRTY' }), rec, NOW, base)).toMatchObject({ do: 'send-back', reason: 'conflict' });
    });
  });

  it('marks a QA-passed draft ready instead of waiting on it', () => {
    expect(mergeStep(pull({ isDraft: true }), record(), NOW, base)).toEqual({ do: 'ready', set: {} });
    expect(mergeStep(pull({ isDraft: true }), record({ passedSha: null }), NOW, base)).toEqual({ do: 'ready', set: { passedSha: pull().headSha } });
  });

  it('requeues a draft whose commits changed after QA instead of marking it ready', () => {
    expect(mergeStep(pull({ isDraft: true, headSha: 'other' }), record(), NOW, base).do).toBe('requeue');
  });

  describe('UNKNOWN mergeability', () => {
    it('asks GitHub about the PR first', () => {
      expect(mergeStep(pull({ mergeable: 'UNKNOWN' }), record(), NOW, base)).toEqual({ do: 'details', set: {} });
      expect(mergeStep(pull({ mergeState: 'UNKNOWN' }), record(), NOW, base)).toEqual({ do: 'details', set: {} });
    });

    it('waits when the details still say UNKNOWN', () => {
      expect(mergeStep(pull({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }), record(), NOW, { ...base, detailed: true })).toEqual({
        do: 'wait',
        note: 'GitHub is checking it can merge',
        set: { pendingSince: null },
      });
    });

    it('carries on with the details once GitHub knows', () => {
      expect(mergeStep(pull({ mergeState: 'UNKNOWN' }), record(), NOW, { ...base, detailed: true }).do).toBe('merge');
      expect(mergeStep(pull({ mergeable: 'CONFLICTING' }), record(), NOW, { ...base, detailed: true }).do).toBe('send-back');
    });
  });

  describe('head moved after QA', () => {
    it('sends the PR back to QA', () => {
      expect(mergeStep(pull({ headSha: 'new456' }), record(), NOW, base)).toEqual({ do: 'requeue', set: {} });
    });

    it('re-tests even when the new commit also conflicts or fails', () => {
      expect(mergeStep(pull({ headSha: 'new456', mergeable: 'CONFLICTING', checks: 'failing' }), record(), NOW, base).do).toBe('requeue');
    });

    it('adopts the head as the passed commit for records from before commits were tracked', () => {
      expect(mergeStep(pull({ headSha: 'def789' }), record({ passedSha: null }), NOW, base)).toEqual({
        do: 'merge',
        set: { passedSha: 'def789', pendingSince: null },
      });
    });
  });

  describe('conflicts', () => {
    for (const p of [{ mergeable: 'CONFLICTING' }, { mergeState: 'DIRTY' }]) {
      it(`sends back ${JSON.stringify(p)} to a developer`, () => {
        expect(mergeStep(pull(p), record({ mergeFixes: 1 }), NOW, { base: 'develop' })).toEqual({
          do: 'send-back',
          reason: 'conflict',
          instructions: 'It conflicts with develop.',
          needsHuman: false,
          set: {},
        });
      });
    }

    it('wins over failing and pending checks', () => {
      expect(mergeStep(pull({ mergeable: 'CONFLICTING', checks: 'failing' }), record(), NOW, base)).toMatchObject({ reason: 'conflict' });
      expect(mergeStep(pull({ mergeState: 'DIRTY', checks: 'pending' }), record(), NOW, base)).toMatchObject({ reason: 'conflict' });
    });
  });

  describe('failing checks', () => {
    it('reruns failed GitHub Actions jobs before spending a merge fix', () => {
      const pr = pull({ checks: 'failing', failedChecks: [{ name: 'test', url: 'https://github.com/o/r/actions/runs/42/job/9' }] });
      expect(mergeStep(pr, record(), NOW, base)).toMatchObject({ do: 'rerun', runIds: [42] });
    });

    it.each(['failing', 'passing', 'pending'] as const)('allows GitHub two minutes to refresh after a rerun even while checks say %s', (checks) => {
      expect(mergeStep(pull({ checks }), record({ checkRerunSha: 'abc123', checkRerunAt: NOW }), NOW + CHECK_RERUN_GRACE_MS - 1, base))
        .toMatchObject({ do: 'wait', note: expect.stringContaining('refresh') });
    });

    it('waits for a running retry beyond the grace, then merges when it passes', () => {
      const rec = record({ checkRerunSha: 'abc123', checkRerunAt: NOW - CHECK_RERUN_GRACE_MS });
      expect(mergeStep(pull({ checks: 'pending' }), rec, NOW, base).do).toBe('wait');
      expect(mergeStep(pull({ checks: 'passing' }), rec, NOW, base).do).toBe('merge');
    });

    it('retries once again only after a new head passes QA', () => {
      const pr = pull({ checks: 'failing', failedChecks: [{ name: 'test', url: 'https://github.com/o/r/actions/runs/42' }] });
      expect(mergeStep(pr, record({ checkRerunSha: 'old-head', checkRerunAt: NOW }), NOW, base)).toMatchObject({ do: 'rerun', runIds: [42] });
      expect(mergeStep(pr, record({ passedSha: 'old-head' }), NOW, base).do).toBe('requeue');
    });

    it('keeps unavailable checks and conflicts ahead of retry grace', () => {
      const rec = record({ checkRerunSha: 'abc123', checkRerunAt: NOW });
      expect(mergeStep(pull({ checks: 'unavailable' }), rec, NOW, base)).toMatchObject({ do: 'wait', note: expect.stringContaining('checks unavailable') });
      expect(mergeStep(pull({ mergeState: 'DIRTY' }), rec, NOW, base)).toMatchObject({ do: 'send-back', reason: 'conflict' });
    });

    it('sends external check failures back without a retryable run ID', () => {
      expect(mergeStep(pull({ checks: 'failing', failedChecks: [{ name: 'deploy', url: 'https://vercel.com/deploy/42' }] }), record(), NOW, base))
        .toMatchObject({ do: 'send-back', reason: 'checks' });
    });

    it('lists each failed check with its log URL when there is one', () => {
      const pr = pull({
        checks: 'failing',
        failedChecks: [
          { name: 'check (ubuntu-latest)', url: 'https://github.com/o/r/actions/runs/1/job/2' },
          { name: 'lint', url: null },
        ],
      });
      expect(mergeStep(pr, record({ checkRerunSha: pr.headSha, checkRerunAt: NOW - 120_000 }), NOW, base)).toEqual({
        do: 'send-back',
        reason: 'checks',
        instructions: '- check (ubuntu-latest): https://github.com/o/r/actions/runs/1/job/2\n- lint',
        needsHuman: false,
        set: {},
      });
    });
  });

  describe('fix budget', () => {
    it(`needs a human after ${MAX_MERGE_FIXES} fixes`, () => {
      expect(mergeStep(pull({ checks: 'failing' }), record({ mergeFixes: MAX_MERGE_FIXES - 1 }), NOW, base)).toMatchObject({ needsHuman: false });
      expect(mergeStep(pull({ checks: 'failing' }), record({ mergeFixes: MAX_MERGE_FIXES }), NOW, base)).toMatchObject({ do: 'send-back', needsHuman: true });
      expect(mergeStep(pull({ mergeable: 'CONFLICTING' }), record({ mergeFixes: MAX_MERGE_FIXES + 1 }), NOW, base)).toMatchObject({ reason: 'conflict', needsHuman: true });
    });
  });

  describe('pending checks', () => {
    it('starts the clock and names the running checks', () => {
      expect(mergeStep(pull({ checks: 'pending', pendingChecks: ['build', 'test'] }), record(), NOW, base)).toEqual({
        do: 'wait',
        note: 'waiting for checks: build, test',
        alert: false,
        set: { pendingSince: NOW },
      });
    });

    it('says "running" when GitHub names none', () => {
      expect(mergeStep(pull({ checks: 'pending' }), record(), NOW, base)).toMatchObject({ note: 'waiting for checks: running' });
    });

    it('keeps the clock it already started', () => {
      expect(mergeStep(pull({ checks: 'pending' }), record({ pendingSince: NOW - 60_000 }), NOW, base)).toMatchObject({ alert: false, set: {} });
    });

    it(`alerts the manager once after ${CHECKS_ALERT_MS / 60_000} minutes`, () => {
      const pr = pull({ checks: 'pending', pendingChecks: ['e2e'] });
      expect(mergeStep(pr, record({ pendingSince: NOW - CHECKS_ALERT_MS }), NOW, base)).toMatchObject({ alert: false, set: {} });
      expect(mergeStep(pr, record({ pendingSince: NOW - CHECKS_ALERT_MS - 1 }), NOW, base)).toEqual({
        do: 'wait',
        note: 'waiting for checks: e2e',
        alert: true,
        set: { alerted: true },
      });
      expect(mergeStep(pr, record({ pendingSince: NOW - CHECKS_ALERT_MS - 1, alerted: true }), NOW, base)).toMatchObject({ alert: false, set: {} });
    });

    it('stops the clock once checks finish', () => {
      expect(mergeStep(pull(), record({ pendingSince: NOW - 5_000 }), NOW, base).set).toEqual({ pendingSince: null });
    });
  });

  describe('BEHIND', () => {
    it('updates the branch instead of merging', () => {
      expect(mergeStep(pull({ mergeState: 'BEHIND' }), record(), NOW, base)).toEqual({ do: 'update-branch', set: { pendingSince: null } });
    });

    it('waits for checks before updating', () => {
      expect(mergeStep(pull({ mergeState: 'BEHIND', checks: 'pending' }), record(), NOW, base).do).toBe('wait');
    });
  });

  describe('merge retry window', () => {
    it('leaves the card alone until the retry time', () => {
      expect(mergeStep(pull(), record({ mergeRetryAt: NOW + 1 }), NOW, base)).toEqual({ do: 'wait', set: { pendingSince: null } });
    });

    it('tries again once it has passed', () => {
      expect(mergeStep(pull(), record({ mergeRetryAt: NOW }), NOW, base).do).toBe('merge');
      expect(mergeStep(pull(), record({ mergeRetryAt: NOW - 1 }), NOW, base).do).toBe('merge');
    });

    it('still updates a branch that fell behind while waiting', () => {
      expect(mergeStep(pull({ mergeState: 'BEHIND' }), record({ mergeRetryAt: NOW + 60_000 }), NOW, base).do).toBe('update-branch');
    });
  });
});
