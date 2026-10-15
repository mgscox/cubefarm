// After a fix session that ended well: did it push anything? A QA fix or a conflict resolution that left the PR's head
// where it was fixed nothing, so it counts like a crashed fix session: QA doesn't re-test the same commit, another
// developer gets a go, and then the manager hears "nothing was pushed". A checks fix may rightly push nothing (it can
// re-run a flaky check).
import type { FixReason } from './fixPlan.ts';

/** The parts of a QA record a finished fix reads. */
export interface FixRecord {
  prNumber: number;
  round: number;
  testedSha: string | null;
  passedSha: string | null;
  fixReason: FixReason | null;
  fixCrashes: string[];
}

export type FixPatch = Partial<{ status: 'queued' | 'passed' | 'failed' | 'needs-human'; round: number; fixCrashes: string[]; mergeNote: string | null }>;

export interface FixOutcome {
  set: FixPatch;
  log: { kind: 'done' | 'error'; text: string };
  pushed: boolean;
}

/**
 * A fix that crashed (or pushed nothing) goes to the manager once two developers have failed on it, or twice on a floor
 * with a single developer; until then it waits for a developer who hasn't failed on it.
 */
export function fixNeedsHuman(crashes: string[], devs: number): boolean {
  return new Set(crashes).size >= 2 || (devs <= 1 && crashes.length >= 2);
}

/**
 * What a fix session that ended well did to its PR. head: the PR's head commit now (null: GitHub couldn't be asked, so
 * the session is taken at its word). agentId: the developer. devs: developers on the floor. counts: false while
 * Claude's usage limit is hit, which isn't the PR's fault.
 */
export function fixOutcome(rec: FixRecord, head: string | null, minutes: number, fixer: { agentId: string; devs: number; counts?: boolean }): FixOutcome {
  const pr = rec.prNumber;
  // The commit the fix started from: the one QA failed, or the one QA passed (and auto-merge kept) for a conflict.
  const before = rec.fixReason === 'conflict' ? (rec.passedSha ?? rec.testedSha) : rec.testedSha;
  if (rec.fixReason !== 'checks' && head && before && head === before) {
    const fixCrashes = fixer.counts === false ? rec.fixCrashes : [...rec.fixCrashes, fixer.agentId];
    return {
      set: fixNeedsHuman(fixCrashes, fixer.devs)
        ? { status: 'needs-human', fixCrashes, mergeNote: rec.fixReason === 'conflict' ? 'the conflict was never resolved' : 'the fix was never pushed' }
        : { status: 'failed', fixCrashes },
      log: { kind: 'error', text: `✗ No new commits were pushed for PR #${pr}` },
      pushed: false,
    };
  }
  if (rec.passedSha && (rec.fixReason === 'checks' || rec.fixReason === 'conflict')) {
    // Back in line to merge: new commits go through QA again first, a re-run of flaky checks doesn't.
    return { set: { status: 'passed', mergeNote: 'waiting for fresh checks', fixCrashes: [] }, log: { kind: 'done', text: `✔ PR #${pr} fixed in ${minutes}m. Back in line to merge.` }, pushed: true };
  }
  return { set: { status: 'queued', round: rec.round + 1, fixCrashes: [] }, log: { kind: 'done', text: `✔ Fix pushed for PR #${pr} in ${minutes}m. Back to QA.` }, pushed: true };
}
