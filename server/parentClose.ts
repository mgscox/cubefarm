// When the office closes a parent issue by itself: every sub-issue done, nothing else working on it, once per count.
import { hasLabel, KEEP_OPEN, PUBLICATION_HOLD } from '../shared/issues.ts';
import type { IssueInfo } from '../shared/types.ts';

/** The sub-issue counts a parent was closed at. A reopened parent closes again only once they change. */
export interface ParentClose {
  issueNumber: number;
  total: number;
  completed: number;
}

/** Whether an open issue is a finished parent the office should close as completed. ready-for-human doesn't matter. */
export function parentReadyToClose(
  issue: Pick<IssueInfo, 'number' | 'labels' | 'subIssues'>,
  ctx: { openPr: boolean; working: boolean; closed: ParentClose[] },
): boolean {
  const sub = issue.subIssues;
  if (!sub || sub.total === 0 || sub.completed !== sub.total) return false; // not loaded, unsupported, not a parent or unfinished
  if (ctx.openPr || ctx.working || hasLabel(issue.labels, KEEP_OPEN) || hasLabel(issue.labels, PUBLICATION_HOLD)) return false;
  return !ctx.closed.some((c) => c.issueNumber === issue.number && c.total === sub.total && c.completed === sub.completed);
}

/** Forget a close once its reopened parent's sub-issue counts change; keep it while the counts are unread or it is closed. */
export function retainParentCloses(closed: ParentClose[], open: Pick<IssueInfo, 'number' | 'subIssues'>[]): ParentClose[] {
  return closed.filter((c) => {
    const sub = open.find((i) => i.number === c.issueNumber)?.subIssues;
    return !sub || (sub.total === c.total && sub.completed === c.completed);
  });
}
