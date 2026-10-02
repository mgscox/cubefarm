import type { IssueInfo, PullInfo, PullRefresh, RepoRefresh } from '../shared/types.ts';

// Keep independent successes and the last successful timestamp for each GitHub resource.
export function applyRepoRefresh(
  previous: { issues: IssueInfo[]; pulls: PullInfo[]; lastSync: number | null; refresh?: RepoRefresh },
  issues: PromiseSettledResult<IssueInfo[]>,
  pulls: PromiseSettledResult<PullRefresh>,
  now: number,
) {
  const issueError = issues.status === 'rejected' ? String(issues.reason instanceof Error ? issues.reason.message : issues.reason) || 'Issue refresh failed' : undefined;
  const pullError = pulls.status === 'rejected' ? String(pulls.reason instanceof Error ? pulls.reason.message : pulls.reason) || 'PR refresh failed' : undefined;
  const checksError = pulls.status === 'fulfilled' ? pulls.value.checksError : previous.refresh?.checksError;
  const refresh: RepoRefresh = {
    status: issues.status === 'rejected' && pulls.status === 'rejected' ? 'failed' : issueError || pullError || checksError ? 'partial' : 'success',
    issues: { at: issues.status === 'fulfilled' ? now : previous.refresh?.issues.at ?? null, error: issueError },
    pulls: { at: pulls.status === 'fulfilled' ? now : previous.refresh?.pulls.at ?? null, error: pullError },
    checksError,
  };
  return {
    issues: issues.status === 'fulfilled' ? issues.value : previous.issues,
    pulls: pulls.status === 'fulfilled' ? pulls.value.pulls : previous.pulls,
    lastSync: issues.status === 'fulfilled' && pulls.status === 'fulfilled' ? now : previous.lastSync,
    syncError: [issueError, pullError].filter(Boolean).join('\n') || undefined,
    refresh,
  };
}
