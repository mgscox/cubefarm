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
        Checks unavailable; automatic merging is blocked for affected PRs. Fine-grained PATs cannot access GitHub’s Checks API. Use GitHub CLI browser login (<code>gh auth login --web</code>) with OAuth, or a classic PAT where allowed. If a PAT is set in <code>GH_TOKEN</code> or <code>GITHUB_TOKEN</code>, it overrides stored login.{' '}
        <a href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations" target="_blank" rel="noreferrer">GitHub documentation</a>
      </div>}
      {details && <details><summary>GitHub refresh diagnostics</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>{details}</pre></details>}
    </div>
  );
}
