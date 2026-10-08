// QA tallies for the HUD and the lobby console. Only records whose PR is open in the floor's PR list count, so a
// leftover record for a merged or closed PR can't inflate them.
import type { PullInfo, QaView } from '../../shared/types';

export interface QaCounts {
  inQa: number;
  readyToMerge: number;
  /** Passed but still a draft: auto-merge skips drafts, so these wait on the manager. */
  passedDrafts: number;
}

/** Count QA records against the open PRs of their floors (`pullsByRepo`: repo id → its PR list). */
export function qaCounts(qa: Iterable<QaView>, pullsByRepo: ReadonlyMap<string, readonly PullInfo[]>): QaCounts {
  const counts: QaCounts = { inQa: 0, readyToMerge: 0, passedDrafts: 0 };
  for (const q of qa) {
    const pr = pullsByRepo.get(q.repoId)?.find((p) => p.number === q.prNumber);
    if (!pr || pr.state !== 'OPEN') continue;
    if (q.status !== 'passed') counts.inQa++;
    else if (pr.isDraft) counts.passedDrafts++;
    else counts.readyToMerge++;
  }
  return counts;
}
