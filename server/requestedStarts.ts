// Pure decisions for retaining explicit issue starts and selecting a desk after a restart.
import type { IssueInfo, PullInfo, RequestedStart } from '../shared/types.ts';
import { forHuman } from '../shared/issues.ts';

export function retainRequestedStarts(requests: RequestedStart[], issues: IssueInfo[] | null, pulls: PullInfo[] | null): RequestedStart[] {
  return requests.filter((request) => {
    const issue = issues?.find((i) => i.number === request.issueNumber);
    if (issues && (!issue || forHuman(issue.labels))) return false;
    return !pulls?.some((p) => p.closesIssues.includes(request.issueNumber) || p.headRefName.startsWith(`swarm/issue-${request.issueNumber}-`));
  });
}

export function pickRequestedStart<T extends { id: string }>(requests: RequestedStart[], free: T[], taken: (number: number) => boolean) {
  if (!free.length) return null;
  const request = requests.find((r) => r.restartPending && !taken(r.issueNumber));
  if (!request) return null;
  return { request, agent: free.find((a) => a.id === request.preferredAgentId) ?? free[0] };
}
