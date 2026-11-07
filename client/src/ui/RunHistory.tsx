// A floor's attempts from the office's run history (docs/run-history.md), read when opened and exportable as JSON.
import { useState } from 'react';
import type { RunHistoryExport } from '../../../shared/types';
import { api } from '../api';
import { cost, duration, outcomeLabel, runtimeLabel, workLabel } from '../runHistory';

export function RunHistory({ repoId }: { repoId: string }) {
  const [data, setData] = useState<RunHistoryExport | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    api.runHistory(repoId).then(setData, () => undefined).finally(() => setLoading(false));
  };
  return (
    <details className="run-history" onToggle={(e) => { if (e.currentTarget.open && !data && !loading) load(); }}>
      <summary>Run history</summary>
      <div className="run-history-bar">
        <button className="btn" onClick={load} disabled={loading}>⟳ Refresh</button>
        <a className="btn" href={`/api/run-history?repoId=${encodeURIComponent(repoId)}&download=1`} download>⬇ Export JSON</a>
        <span className="muted small">{loading ? 'Loading…' : data ? `${data.attempts.length} attempts, newest first` : ''}</span>
      </div>
      {data?.attempts.length === 0 && <p className="muted small">No attempts recorded yet.</p>}
      {!!data?.attempts.length && (
        <div className="run-history-table">
          <table>
            <thead>
              <tr>
                <th>Attempt</th><th>Work</th><th>Task</th><th>Agent</th><th>Why</th><th>Outcome</th>
                <th>Queue</th><th>Run</th><th>Cost</th><th>Runtime</th><th>Worker</th>
              </tr>
            </thead>
            <tbody>
              {data.attempts.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code title={x.id}>{x.id.slice(0, 8)}</code>
                    {x.parentId && <span className="muted"> ← <code title={`Parent attempt ${x.parentId}`}>{x.parentId.slice(0, 8)}</code></span>}
                  </td>
                  <td>{workLabel(x)}</td>
                  <td>{x.task}</td>
                  <td>{x.agent.name}</td>
                  <td>{x.assignment.reason}</td>
                  <td title={x.outcome?.excerpt}>{outcomeLabel(x)}</td>
                  <td>{duration(x.queueMs)}</td>
                  <td>{duration(x.runMs)}</td>
                  <td>{cost(x.usage.costUsd)}</td>
                  <td>{runtimeLabel(x)}</td>
                  <td>{x.worker.name}{x.worker.healthAtEnd ? ` · ${x.worker.healthAtEnd.status}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
