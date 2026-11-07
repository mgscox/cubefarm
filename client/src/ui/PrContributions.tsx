// PR history stays inspectable after the QA card and its desks have gone.
import type { PrContributionView } from '../../../shared/types';

export function PrContributions({ history }: { history?: PrContributionView }) {
  return (
    <details className="small" style={{ overflowWrap: 'anywhere' }}>
      <summary>Contribution history</summary>
      <p>
        Original author: {history?.original ? `${history.original.name} (${history.original.agentId})` : 'Unknown'}
        {history?.original && <> · submitted <code title={history.original.submittedSha}>{history.original.submittedSha}</code></>}
      </p>
      {history?.repairs.map((r) => (
        <div key={r.id}>
          <p>Repair: {r.name} ({r.agentId}) · {r.reason} · {new Date(r.startedAt).toLocaleString()}</p>
          <p>Starting SHA: <code>{r.startingSha ?? 'Unknown'}</code><br />
            Submitted SHA: <code>{r.submittedSha ?? 'Unknown'}</code></p>
          <p>Review {r.reviewId}, round {r.round}{r.commentUrl && <> · <a href={r.commentUrl} target="_blank" rel="noreferrer">Findings ↗</a></>}</p>
          {r.findings && <p>{r.findings}</p>}
        </div>
      ))}
      {!history?.repairs.length && <p>No recorded repairs.</p>}
    </details>
  );
}
