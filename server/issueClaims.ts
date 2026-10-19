// Issue ownership shared by new work, PR fixes and resumed sessions.
import type { AgentRole, AgentStatus, AgentTask } from '../shared/types.ts';

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

export function issueHolder<T extends IssueClaim>(agents: T[], repoId: string, issueNumber: number | null, except: string): T | undefined {
  if (issueNumber == null) return undefined;
  return agents.find((a) => a.id !== except && a.repoId === repoId && a.issueNumber === issueNumber && worksIssue(a) && (busy(a) || !!a.heldRetry));
}

/** Keep a linked PR's session, otherwise the oldest start; ties retain the existing order. */
export function duplicateIssueSessions<T extends IssueClaim>(agents: T[]): { keep: T; stop: T }[] {
  const holders = new Map<string, T>();
  const duplicates: { keep: T; stop: T }[] = [];
  const ordered = agents.filter((a) => worksIssue(a) && busy(a) && a.issueNumber != null)
    .sort((a, b) => Number(b.prNumber != null) - Number(a.prNumber != null) || (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  for (const a of ordered) {
    const key = `${a.repoId}#${a.issueNumber}`;
    const keep = holders.get(key);
    if (keep) duplicates.push({ keep, stop: a });
    else holders.set(key, a);
  }
  return duplicates;
}
