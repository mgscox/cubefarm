// Durable QA evidence remains available when active cards have been cleaned up.
import { useState } from 'react';
import type { QaClassification, QaOutcomeView } from '../../../shared/types';
import { scoringFindings } from '../../../shared/qaEvidence';
import { api } from '../api';
import { useStore } from '../store';

function Correction({ outcome, findingId }: { outcome: QaOutcomeView; findingId: string }) {
  const [classification, setClassification] = useState<QaClassification>('inconclusive');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  return <form onSubmit={async (e) => {
    e.preventDefault();
    setPending(true);
    try { await api.correctQaFinding(outcome.id, findingId, classification, reason); setReason(''); }
    catch { /* API errors are toasted. */ }
    finally { setPending(false); }
  }}>
    <select aria-label="Corrected classification" value={classification} onChange={(e) => setClassification(e.target.value as QaClassification)}>
      <option value="inconclusive">Inconclusive</option><option value="worker">Worker</option><option value="code">Code</option>
    </select>
    <input aria-label="Correction reason" placeholder="Reason for correction" required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
    <button disabled={pending || !reason.trim()}>Record correction</button>
  </form>;
}

export function QaHistory({ repoId }: { repoId: string }) {
  const outcomes = useStore((s) => s.qaOutcomes).filter((o) => o.repoId === repoId);
  if (!outcomes.length) return null;
  return <details className="small" style={{ overflowWrap: 'anywhere' }}>
    <summary>QA history ({outcomes.length})</summary>
    {[...outcomes].reverse().map((o) => <details key={o.id}>
      <summary>PR #{o.prNumber} · {o.verdict} · {o.classification} · {o.revision} revision · {o.reviewer.name}</summary>
      <p>Cycle {o.reviewId} · round {o.round} · attempt {o.attemptId}<br />
        {new Date(o.startedAt).toLocaleString()} – {new Date(o.finishedAt).toLocaleString()}</p>
      <p>Tested base: <code>{o.baseSha ?? 'Unknown'}</code><br />Tested head: <code>{o.headSha ?? 'Unknown'}</code></p>
      <p>{o.summary}</p>
      {o.commentUrl && <a href={o.commentUrl} target="_blank" rel="noreferrer">QA report ↗</a>}
      {o.checks.map((c, i) => <p key={i}>{c.name}: {c.result} · {c.details}</p>)}
      {o.findings.map((f) => <div key={f.id}>
        <p>Finding {f.id} ({f.key}): {f.classification} · {f.confirmed ? 'confirmed' : 'unconfirmed'}<br />
          Attribution: {f.attributableTo ? `${f.attributableTo.agentId} at ${f.attributableTo.submittedSha}` : 'Unknown'}<br />
          Score candidate: {scoringFindings(o).some((candidate) => candidate.id === f.id) ? 'yes' : 'no'}<br />{f.evidence}</p>
        {o.corrections.filter((c) => c.findingId === f.id).map((c) => <p key={c.id}>Correction {c.id} by {c.actor} at {new Date(c.at).toLocaleString()}: {c.classification} · {c.reason} · previous {c.previousCorrectionId ?? 'original'}</p>)}
        <Correction outcome={o} findingId={f.id} />
      </div>)}
      {o.commands.map((c, i) => <p key={i}><code>{c.command}</code>: {c.result}</p>)}
      <p>Worker: {o.worker.boxId ?? 'Office machine'} · {o.worker.telemetry?.summary ?? 'Unknown'}<br />
        Window: {o.worker.from === null ? 'Unknown' : new Date(o.worker.from).toLocaleString()} – {o.worker.to === null ? 'Unknown' : new Date(o.worker.to).toLocaleString()}<br />
        {o.worker.telemetry?.evidence}<br />Session ending: {o.terminalReason ?? 'No exit or timeout reason reported'}</p>
      <p>CI: {o.ci?.availability ?? 'Unknown'} · head <code>{o.ci?.headSha ?? 'Unknown'}</code></p>
      {o.ci?.checks.map((c, i) => <p key={i}>{c.name}: {c.conclusion ?? c.status ?? 'Unknown'} · check {c.id ?? 'Unknown'} · run {c.runId ?? 'Unknown'} {c.url && <a href={c.url} target="_blank" rel="noreferrer">CI ↗</a>}</p>)}
    </details>)}
  </details>;
}
