// Closed work: which running sessions hold an issue or PR that has since closed, and whether work is still open to
// start. Pure, so the sync and the start paths share one rule (and a later watchdog can add its own checks here).
import type { AgentView, PullInfo } from '../shared/types.ts';
import { PUBLICATION_HOLD } from '../shared/issues.ts';
import type { TrackedIssue } from './github.ts';

export interface ClosedWork {
  kind: 'issue' | 'pr';
  number: number;
}

type Holder = Pick<AgentView, 'id' | 'role' | 'task' | 'status' | 'issueNumber' | 'prNumber'>;

export interface FloorWork {
  pulls: Pick<PullInfo, 'number' | 'state'>[];
  /** Open issue numbers from this sync; null when the issue list could not be read. */
  openIssues: Set<number> | null;
  /** PRs the CEO parked (park_pr): their branch and issue are kept on purpose. */
  parkedPrs: Set<number>;
}

/**
 * The work a busy agent holds that is closed: its PR closed without merging, or (for an issue task) its issue gone
 * from the open list. The open list is capped, so an issue result is only a candidate: confirm it with issueClosed.
 * The PR list holds only open and recently merged PRs, so a known PR missing from it is a candidate too: read its
 * state and ask again with it listed. Merged PRs are left to the merge flow.
 */
export function closedWork(a: Holder, floor: FloorWork): ClosedWork | null {
  if ((a.status !== 'preparing' && a.status !== 'working') || a.role === 'ceo') return null;
  if (a.prNumber != null) {
    if (floor.parkedPrs.has(a.prNumber)) return null;
    const state = floor.pulls.find((p) => p.number === a.prNumber)?.state;
    if (state === 'CLOSED' || state == null) return { kind: 'pr', number: a.prNumber };
    if (state === 'MERGED') return null;
  }
  if (a.task === 'issue' && a.issueNumber != null && floor.openIssues && !floor.openIssues.has(a.issueNumber)) {
    return { kind: 'issue', number: a.issueNumber };
  }
  return null;
}

/** A read issue is closed work: closed, and not an Ideas issue held for publication (the publisher owns those). */
export function issueClosed(issue: Pick<TrackedIssue, 'state' | 'labels'> | null): boolean {
  return issue?.state === 'CLOSED' && !issue.labels.includes(PUBLICATION_HOLD);
}

export function closedWorkText(work: ClosedWork): string {
  return work.kind === 'issue' ? `issue #${work.number} was closed` : `PR #${work.number} was closed without merging`;
}
