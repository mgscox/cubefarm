// Issue ownership shared by new work, PR fixes and resumed sessions.
import type { AgentRole, AgentStatus, AgentTask, PullInfo } from '../shared/types.ts';
import { prototypeIssueNumber, RESEARCH_BRANCH } from '../shared/issues.ts';

interface IssueClaim {
  id: string;
  repoId: string;
  role: AgentRole;
  task: AgentTask | null;
  status: AgentStatus;
  issueNumber: number | null;
  prNumber: number | null;
  startedAt: number | null;
  heldRetry?: unknown;
}

const worksIssue = (a: IssueClaim) => (a.role === 'dev' || a.role === 'researcher') && (a.task === 'issue' || a.task === 'fix');
const busy = (a: IssueClaim) => a.status === 'preparing' || a.status === 'working';
const holdsIssue = (a: IssueClaim) => a.issueNumber != null && worksIssue(a) && (busy(a) || !!a.heldRetry);

const RECENT_MERGE_MS = 6 * 60 * 60 * 1000;

/** A session or PR owns this issue, including the delay before GitHub closes merged work. */
export function issueTaken(agents: IssueClaim[], repoId: string, n: number, pulls: Pick<PullInfo, 'state' | 'mergedAt' | 'closesIssues' | 'headRefName'>[], now: number, prototype = false): boolean {
  if (agents.some((a) => a.repoId === repoId && (a.role === 'dev' || a.role === 'researcher') && a.task !== 'qa' && a.issueNumber === n && (a.heldRetry || (a.status !== 'idle' && a.status !== 'error')))) return true;
  return pulls.some((p) => {
    const experiment = prototypeIssueNumber(p.headRefName);
    if (experiment) return prototype && p.state === 'OPEN' && experiment === n;
    return (p.state === 'OPEN' || (p.state === 'MERGED' && p.mergedAt != null && now - Date.parse(p.mergedAt) < RECENT_MERGE_MS)) &&
      (p.closesIssues.includes(n) || p.headRefName.startsWith(`swarm/issue-${n}-`) || p.headRefName.startsWith(`${RESEARCH_BRANCH}${n}-`));
  });
}

export function issueHolder<T extends IssueClaim>(agents: T[], repoId: string, issueNumber: number | null, except: string): T | undefined {
  if (issueNumber == null) return undefined;
  return agents.find((a) => a.id !== except && a.repoId === repoId && a.issueNumber === issueNumber && holdsIssue(a));
}

/** Keep a running session before a held retry, then a linked PR or the oldest start. */
export function duplicateIssueSessions<T extends IssueClaim>(agents: T[]): { keep: T; stop: T }[] {
  const holders = new Map<string, T>();
  const duplicates: { keep: T; stop: T }[] = [];
  const ordered = agents.filter(holdsIssue)
    .sort((a, b) => Number(busy(b)) - Number(busy(a)) || Number(b.prNumber != null) - Number(a.prNumber != null) || (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  for (const a of ordered) {
    const key = `${a.repoId}#${a.issueNumber}`;
    const keep = holders.get(key);
    if (keep) duplicates.push({ keep, stop: a });
    else holders.set(key, a);
  }
  return duplicates;
}
