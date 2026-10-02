import type { RepoView } from '../../../shared/types';

// GitHub refresh health is independent of the local checkout's Git status.
export function RepoRefreshStatus({ repo, onRefresh }: { repo: RepoView; onRefresh: () => void }) {
  const refresh = repo.refresh;
  const freshness = (source: 'issues' | 'pulls') => {
    const result = refresh?.[source];
    if (!result?.at) return 'not loaded';
    return `${result.error ? 'stale · last refreshed' : 'refreshed'} ${new Date(result.at).toLocaleString()}`;
  };
  const details = [repo.syncError || [refresh?.issues.error, refresh?.pulls.error].filter(Boolean).join('\n'), refresh?.checksError].filter(Boolean).join('\n\n');
  const status = refresh?.status === 'success' ? 'refreshed' : refresh?.status === 'partial' ? 'partially refreshed' : refresh?.status === 'failed' || repo.syncError ? 'refresh failed' : 'not refreshed';
  return (
    <div className="small">
      <div>GitHub: {repo.syncing ? 'refreshing…' : status}{' '}
        <button className="btn btn-small btn-ghost" disabled={repo.syncing} onClick={onRefresh}>Refresh GitHub</button>
      </div>
      <div className="muted">Issues: {refresh?.issues.at ? `${repo.issues.length} open` : 'unknown'} · {freshness('issues')}</div>
      <div className="muted">PRs: {refresh?.pulls.at ? `${repo.pulls.filter((p) => p.state === 'OPEN').length} open` : 'unknown'} · {freshness('pulls')}</div>
      {(refresh?.issues.error || refresh?.pulls.error) && <div role="alert">Some GitHub data could not be refreshed. Previous data is stale; see diagnostics.</div>}
      {refresh?.checksError && <div role="alert">
        {repo.pulls.some((p) => p.state === 'OPEN' && p.checks === 'unavailable')
          ? 'Some PR checks could not be read; automatic merging is blocked for those PRs. Check token access to GitHub Actions and see diagnostics.'
          : 'PR checks are read through GitHub Actions and commit statuses.'}
      </div>}
      {details && <details><summary>GitHub refresh diagnostics</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{details}</pre></details>}
    </div>
  );
}
