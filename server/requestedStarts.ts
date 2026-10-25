// Pure decisions for retaining explicit issue starts and selecting a desk after a restart.
import type { IssueInfo, PullInfo, RequestedStart } from '../shared/types.ts';
import { forHuman, issueReadinessReason, RESEARCH_BRANCH } from '../shared/issues.ts';

export function retainRequestedStarts(requests: RequestedStart[], issues: IssueInfo[] | null, pulls: PullInfo[] | null): RequestedStart[] {
  return requests.filter((request) => {
    const issue = issues?.find((i) => i.number === request.issueNumber);
    if (issues && (!issue || forHuman(issue.labels) || issueReadinessReason(issue))) return false;
    return !pulls?.some((p) => p.closesIssues.includes(request.issueNumber) || p.headRefName.startsWith(`swarm/issue-${request.issueNumber}-`) || p.headRefName.startsWith(`${RESEARCH_BRANCH}${request.issueNumber}-`));
  });
}

/** `fits`: whether a free agent may take that issue (researchers take only research issues). */
export function pickRequestedStart<T extends { id: string }>(requests: RequestedStart[], free: T[], taken: (number: number) => boolean, fits: (agent: T, issue: number) => boolean = () => true) {
  for (const request of requests) {
    if (!request.restartPending || taken(request.issueNumber)) continue;
    const able = free.filter((a) => fits(a, request.issueNumber));
    if (able.length) return { request, agent: able.find((a) => a.id === request.preferredAgentId) ?? able[0] };
  }
  return null;
}
