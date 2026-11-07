// A floor's live attempts from the office's run history (docs/run-history.md), exportable as JSON.
import { useMemo } from 'react';
import { assignmentLabel, cost, duration, outcomeLabel, runtimeLabel, workLabel } from '../runHistory';
import { useStore } from '../store';

export function RunHistory({ repoId }: { repoId: string }) {
  const history = useStore((s) => s.runAttempts);
  const contributions = useStore((s) => s.prContributions);
  const repos = useStore((s) => s.repos);
  const attempts = useMemo(() => {
    const prStates = new Map(repos.find((r) => r.id === repoId)?.pulls.map((p) => [p.number, p.state]));
    for (const h of contributions) if (h.repoId === repoId) prStates.set(h.prNumber, h.state);
    return history.filter((x) => x.repoId === repoId).reverse()
      .sort((x, y) => y.times.assignedAt - x.times.assignedAt)
      .map((x) => ({
        ...x,
        prState: x.prNumber === null ? null : prStates.get(x.prNumber) ?? null,
        queueMs: x.times.startedAt === null ? null : x.times.startedAt - x.times.assignedAt,
        runMs: x.times.startedAt === null || x.times.endedAt === null ? null : x.times.endedAt - x.times.startedAt,
      }));
  }, [history, repoId, contributions, repos]);
  return (
    <details className="run-history">
      <summary>Run history</summary>
      <div className="run-history-bar">
        <a className="btn" href={`/api/run-history?repoId=${encodeURIComponent(repoId)}&download=1`} download>⬇ Export JSON</a>
        <span className="muted small">{attempts.length} attempts, newest first</span>
      </div>
      {attempts.length === 0 && <p className="muted small">No attempts recorded yet.</p>}
      {!!attempts.length && (
        <div className="run-history-table">
          <table>
            <thead>
              <tr>
                <th>Attempt</th><th>Work</th><th>Task</th><th>Agent</th><th>Why</th><th>Outcome</th>
                <th>Queue</th><th>Run</th><th>Cost</th><th>Runtime</th><th>Worker</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((x) => (
                <tr key={x.id}>
                  <td>
                    <code title={x.id}>{x.id.slice(0, 8)}</code>
                    {x.parentId && <span className="muted"> ← <code title={`Parent attempt ${x.parentId}`}>{x.parentId.slice(0, 8)}</code></span>}
                  </td>
                  <td>{workLabel(x)}</td>
                  <td>{x.task}</td>
                  <td>{x.agent.name}</td>
                  <td title={String(x.assignment.factors.policyVersion ?? '')}>{assignmentLabel(x)}</td>
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
