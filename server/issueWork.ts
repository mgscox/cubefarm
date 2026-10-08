// Persist consecutive empty sessions until the manager or repository owner changes the brief.
import type { IssueInfo, NoWorkEnding } from '../shared/types.ts';

export const STALLED = 'ended twice with no work';

export function unchangedWork(record: NoWorkEnding, issue: IssueInfo): boolean {
  return record.body === issue.body && JSON.stringify([...record.labels].sort()) === JSON.stringify([...issue.labels].sort()) &&
    (!issue.ownerCommentAt || issue.ownerCommentAt <= (record.ownerCommentAt ?? ''));
}

export function retainNoWork(records: NoWorkEnding[], issues: IssueInfo[]): NoWorkEnding[] {
  return records.filter((r) => {
    const issue = issues.find((i) => i.number === r.issueNumber);
    return issue && unchangedWork(r, issue);
  });
}

export function recordNoWork(records: NoWorkEnding[], issue: IssueInfo): NoWorkEnding[] {
  const previous = records.find((r) => r.issueNumber === issue.number);
  return [...records.filter((r) => r.issueNumber !== issue.number), {
    issueNumber: issue.number, count: previous && unchangedWork(previous, issue) ? previous.count + 1 : 1,
    body: issue.body, labels: [...issue.labels], ownerCommentAt: issue.ownerCommentAt,
  }];
}

/** A known session baseline takes precedence over commits inherited from earlier sessions. */
export function issueSessionWork(x: { startHead?: string | null; head: string | null; localAhead: number | null; remoteAhead: number | null }): 'none' | 'commits' | 'unknown' {
  if (x.head && x.startHead) return x.head === x.startHead ? 'none' : 'commits';
  if ((x.localAhead ?? 0) > 0 || (x.remoteAhead ?? 0) > 0) return 'commits';
  return x.localAhead === 0 && x.remoteAhead === 0 ? 'none' : 'unknown';
}
