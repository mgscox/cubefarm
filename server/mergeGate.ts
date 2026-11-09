import type { PullInfo } from '../shared/types.ts';
import { failedRunIds } from './checkRuns.ts';
import type { CommitComparison } from './github.ts';

/** Only an ancestral, disjoint base advance with a fresh clean merge can carry a security pass. */
export function securityBaseStep(pr: Pick<MergePull, 'mergeable' | 'mergeState'>, base: CommitComparison | null, changes: CommitComparison | null): 'carry' | 'base' | 'conflict' | 'wait' {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'conflict';
  if (pr.mergeable === 'UNKNOWN' || pr.mergeState === 'UNKNOWN') return 'wait';
  if (pr.mergeable !== 'MERGEABLE' || pr.mergeState !== 'CLEAN') return 'base';
  if (!base || !changes || base.behindBy !== 0 || base.aheadBy <= 0) return 'base';
  const files = new Set(changes.files);
  return base.files.some((file) => files.has(file)) ? 'base' : 'carry';
}

// Auto-merge: fixes for failing checks or conflicts before a PR needs the manager, how long checks may run before
// the manager hears about it, and how long to wait before retrying a merge GitHub refused.
export const MAX_MERGE_FIXES = 3;
export const CHECKS_ALERT_MS = 30 * 60_000;
export const MERGE_RETRY_MS = 10 * 60_000;
export const CHECK_RERUN_GRACE_MS = 2 * 60_000;

/** The parts of a QA record the merge gate reads. */
export interface MergeRecord {
  /** Local validation was blocked by the worker, so absent CI checks cannot satisfy the merge gate. */
  ciRequired?: boolean;
  passedSha: string | null;
  mergeCandidate?: { headSha: string; approvedSha: string; baseSha: string; baseRef: string; expectedChecks: string[] };
  mergeFixes: number;
  pendingSince: number | null;
  mergeRetryAt: number | null;
  alerted: boolean;
  checkRerunSha: string | null;
  checkRerunAt: number | null;
}

/** Bookkeeping the caller writes onto the record as it is (it doesn't count as a change to the record). */
export type MergeBookkeeping = Partial<Pick<MergeRecord, 'passedSha' | 'pendingSince' | 'alerted'>>;

export type MergePull = Pick<PullInfo, 'isDraft' | 'mergeable' | 'mergeState' | 'headSha' | 'checks' | 'hasSuccessfulChecks' | 'successfulChecks' | 'failedChecks' | 'pendingChecks'>;

/** What auto-merge does next with a QA-passed PR. */
export type MergeStep = { set: MergeBookkeeping } & (
  | { do: 'wait'; note?: string; alert?: boolean } // no note: leave the card as it is; alert: tell the manager checks are slow
  | { do: 'details' } // GitHub hasn't worked out mergeability: ask about the PR itself, then decide again with `detailed`
  | { do: 'requeue' } // commits arrived after QA's sign-off: QA tests them too
  | { do: 'rerun'; runIds: number[] }
  | { do: 'send-back'; reason: 'checks' | 'conflict'; instructions: string; needsHuman: boolean } // needsHuman: the fix budget ran out
  | { do: 'update-branch' } // the repo only merges up-to-date branches
  | { do: 'ready' } // still a draft although QA passed it: mark it ready for review, then carry on
  | { do: 'merge' }
);

/**
 * Decide the next step toward merging a PR QA has passed. Pure: advanceMerge (swarm.ts) does the talking to GitHub
 * and the office. `detailed` means the PR's mergeability has already been asked for, so UNKNOWN is waited out.
 */
export function mergeStep(pr: MergePull, rec: MergeRecord, now: number, opts: { base: string; detailed?: boolean }): MergeStep {
  if (!opts.detailed && (pr.mergeable === 'UNKNOWN' || pr.mergeState === 'UNKNOWN')) return { do: 'details', set: {} };
  const set: MergeBookkeeping = {};
  if (rec.passedSha == null) set.passedSha = pr.headSha; // signed off before the office tracked commits
  const candidate = rec.mergeCandidate?.approvedSha === rec.passedSha ? rec.mergeCandidate : undefined;
  if (pr.headSha !== (candidate?.headSha ?? set.passedSha ?? rec.passedSha)) return { do: 'requeue', set };
  // Workers open drafts when they think something is left, often a hand check they can't run (another OS, real
  // devices). QA has passed this exact commit, so it's done: a draft would otherwise wait here forever.
  if (pr.isDraft) return { do: 'ready', set };
  const needsHuman = rec.mergeFixes >= MAX_MERGE_FIXES;
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') {
    return { do: 'send-back', reason: 'conflict', instructions: `It conflicts with ${opts.base}.`, needsHuman, set };
  }
  if (pr.checks === 'unavailable') {
    set.pendingSince = null;
    return { do: 'wait', note: 'checks unavailable: restore GitHub check access before merging', set };
  }
  if (rec.checkRerunSha === pr.headSha && rec.checkRerunAt != null && now - rec.checkRerunAt < CHECK_RERUN_GRACE_MS) {
    return { do: 'wait', note: 'waiting for re-run checks to refresh', set };
  }
  if (pr.checks === 'failing') {
    const runIds = failedRunIds(pr.failedChecks);
    if (rec.checkRerunSha !== pr.headSha && runIds.length) return { do: 'rerun', runIds, set };
    const instructions = pr.failedChecks.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`).join('\n');
    return { do: 'send-back', reason: 'checks', instructions, needsHuman, set };
  }
  const waitingForRebaseChecks = candidate && (pr.checks !== 'passing' || pr.hasSuccessfulChecks !== true ||
    candidate.expectedChecks.some((name) => !pr.successfulChecks?.includes(name)));
  if (pr.checks === 'pending' || waitingForRebaseChecks) {
    const since = rec.pendingSince ?? now;
    if (rec.pendingSince == null) set.pendingSince = since;
    const alert = now - since > CHECKS_ALERT_MS && !rec.alerted;
    if (alert) set.alerted = true;
    const note = waitingForRebaseChecks ? 'waiting for CI on the rebased head' : `waiting for checks: ${pr.pendingChecks.join(', ') || 'running'}`;
    return { do: 'wait', note, alert, set };
  }
  if (rec.ciRequired && (pr.checks !== 'passing' || pr.hasSuccessfulChecks !== true)) {
    return { do: 'wait', note: 'waiting for passing GitHub checks to cover environment-blocked local validation', set };
  }
  set.pendingSince = null;
  if (pr.mergeable === 'UNKNOWN') return { do: 'wait', note: 'GitHub is checking it can merge', set };
  if (pr.mergeState === 'BEHIND') return { do: 'update-branch', set };
  if (rec.mergeRetryAt && now < rec.mergeRetryAt) return { do: 'wait', set };
  return { do: 'merge', set };
}
