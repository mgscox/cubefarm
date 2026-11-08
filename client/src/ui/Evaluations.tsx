// Saved pinned comparisons and comparable live cohorts, reviewed before a manager adopts guidance.
import { useState } from 'react';
import { EVALUATION_METRICS } from '../../../shared/evaluations';
import { approvedVersion } from '../../../shared/lessons';
import type { EvaluationMetric, EvaluationObservation, PlaybookEvaluation } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';

const LABEL: Record<EvaluationMetric, string> = { firstPassQa: 'First-pass QA', verifiedRepair: 'Verified repair', workerBlocked: 'Worker blocked' };
const runtime = (x: EvaluationObservation['runtime']) => `${x.cli ?? 'unknown CLI'} · ${x.model ?? 'CLI default (effective model unknown)'} · ${x.effort ?? 'unknown effort'} · office ${x.office}`;

const health = (h: EvaluationObservation['worker']['healthAtStart']) => h ? `${h.status} (${h.constraints.join(', ') || 'no known constraints'})` : 'unknown health';

function EvaluationForm({ repoId }: { repoId: string }) {
  const lessons = useStore((s) => s.lessons).filter((l) => l.repoId === repoId).map(approvedVersion).filter((l) => !!l);
  const attempts = useStore((s) => s.runAttempts);
  const [lessonId, setLesson] = useState('');
  const [base, setBase] = useState('');
  const [candidate, setCandidate] = useState('');
  const [id, setId] = useState('');
  const [behavior, setBehavior] = useState('');
  const [metric, setMetric] = useState<EvaluationMetric>('firstPassQa');
  const [expected, setExpected] = useState(true);
  const [busy, setBusy] = useState(false);
  const lesson = lessons.find((l) => l.id === lessonId);
  const eligible = attempts.filter((x) => x.repoId === repoId && x.runtime.playbook && (!lesson?.specialty || x.specialty === lesson.specialty));
  const options = eligible.map((x) => <option key={x.id} value={x.id}>{x.id.slice(0, 8)} · {x.task} · PR {x.prNumber ?? 'none'} · {x.runtime.playbook}</option>);
  return <form className="issue-form" onSubmit={async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.evaluatePlaybook(repoId, { lessonId, basePlaybook: eligible.find((x) => x.id === base)?.runtime.playbook,
        candidatePlaybook: eligible.find((x) => x.id === candidate)?.runtime.playbook,
        cases: [{ id, expectedBehavior: behavior, metric, expected, baseAttemptId: base, candidateAttemptId: candidate }] });
    } catch { /* toasted */ } finally { setBusy(false); }
  }}>
    <label className="field">Reviewed lesson<select required value={lessonId} onChange={(e) => setLesson(e.target.value)}>
      <option value="">Choose an approved lesson</option>{lessons.map((l) => <option key={l.id} value={l.id}>{l.title} · v{l.version}</option>)}
    </select></label>
    <label className="field">Pinned case ID<input required maxLength={120} value={id} onChange={(e) => setId(e.target.value)} /></label>
    <label className="field">Expected behavior<input required maxLength={240} value={behavior} onChange={(e) => setBehavior(e.target.value)} /></label>
    <label className="field">Base attempt<select required value={base} onChange={(e) => setBase(e.target.value)}><option value="">Choose recorded run</option>{options}</select></label>
    <label className="field">Candidate attempt<select required value={candidate} onChange={(e) => setCandidate(e.target.value)}><option value="">Choose recorded replay of the case</option>{options}</select></label>
    <label className="field">Expected metric<select value={metric} onChange={(e) => setMetric(e.target.value as EvaluationMetric)}>{EVALUATION_METRICS.map((m) => <option key={m} value={m}>{LABEL[m]}</option>)}</select></label>
    <label className="field">Expected value<select value={String(expected)} onChange={(e) => setExpected(e.target.value === 'true')}><option value="true">Yes</option><option value="false">No</option></select></label>
    <button className="btn btn-small" disabled={busy}>Save evaluation</button>
  </form>;
}

function Observation({ label, observation: x }: { label: string; observation: EvaluationObservation }) {
  return <div><b>{label}</b>: {x.attemptId} · observed {x.result ?? 'pending'} ({x.cause ?? 'unknown cause'}) · {runtime(x.runtime)}
    <p className="small">Worker {x.worker.name} ({x.worker.box || 'office'}) · start {health(x.worker.healthAtStart)} / end {health(x.worker.healthAtEnd)} · revision {x.revisions.start ?? 'unknown'} → {x.revisions.submitted ?? 'unknown'}</p>
    {!x.evidence.length && <p className="small">No QA evidence available.</p>}
    {x.evidence.map((e) => <p className="small" key={e.outcomeId}>{e.outcomeId} · {e.sha ?? 'unknown revision'} ({e.revision}, {e.verdict}) · QA worker {e.worker.box ?? 'unknown'} / {health(e.worker.health)}: {e.summary} · {e.url ? <a href={e.url} target="_blank" rel="noreferrer">Evidence (availability unchecked)</a> : 'Artifact link missing; structured result retained'}</p>)}
  </div>;
}

function Evaluation({ evaluation: e }: { evaluation: PlaybookEvaluation }) {
  return <article className="kcard">
    <h4>{e.lesson.title} · lesson v{e.lesson.version}</h4>
    <p className="small">Saved {new Date(e.at).toLocaleString()} · {e.id}</p>
    <p>{e.report.basePlaybook} → {e.report.candidatePlaybook}</p>
    {e.cases.map((c) => <details key={c.id} open>
      <summary>{c.id}: base {c.baseResult} → candidate {c.candidateResult}{!c.comparable && ' · context differs; comparison confounded'}</summary>
      <p>Expected: {c.expectedBehavior} ({LABEL[c.metric]}: {c.expected ? 'yes' : 'no'})</p>
      <Observation label="Base" observation={c.base} /><Observation label="Candidate" observation={c.candidate} />
    </details>)}
    <div className="run-history-table"><table>
      <caption>Comparable runs at evaluation time · counts / known denominators</caption>
      <thead><tr><th>Cohort</th><th>Attempts</th>{EVALUATION_METRICS.map((m) => <th key={m}>{LABEL[m]}</th>)}</tr></thead>
      <tbody>{e.report.cohorts.map((c, i) => <tr key={i}>
        <td>{c.context.repoId} · {c.context.specialty ?? 'unknown specialty'} · {c.context.task}<br />{c.context.runtime.playbook}<br />{runtime(c.context.runtime)}<br />Worker {c.context.worker.name} ({c.context.worker.box || 'office'}) · start {health(c.context.worker.healthAtStart)} / end {health(c.context.worker.healthAtEnd)}</td>
        <td>{c.attempts}{c.smallSample && ' · small sample (<5)'}</td>
        {EVALUATION_METRICS.map((m) => { const n = c.metrics[m]; return <td key={m}>{n.numerator}/{n.denominator}{n.denominator < 5 && ' · small sample'}<br />{n.incomplete} incomplete · {n.unknown} unknown · {n['not-applicable']} not applicable</td>; })}
      </tr>)}</tbody>
    </table></div>
  </article>;
}

export function Evaluations({ repoId }: { repoId: string }) {
  const evaluations = useStore((s) => s.evaluations).filter((e) => e.repoId === repoId);
  const demo = useStore((s) => s.demo);
  const [busy, setBusy] = useState(false);
  return <details className="run-history evaluations">
    <summary>Playbook evaluations ({evaluations.length})</summary>
    <p className="small">Pinned replays and live cohorts are inputs to a manager's adoption decision. Runtime settings are requested values. Worker blocks do not prove code defects. Small samples cannot establish improvement.</p>
    <a className="btn btn-small" href={`/api/evaluations?repoId=${encodeURIComponent(repoId)}&download=1`} download>Export evaluations JSON</a>
    {demo && <button className="btn btn-small" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await api.demoPlaybookEvaluation(repoId); } catch { /* toasted */ } finally { setBusy(false); }
    }}>Run pinned demo evaluation</button>}
    <details><summary>Compare recorded runs</summary><EvaluationForm repoId={repoId} /></details>
    {!evaluations.length && <p>No evaluations recorded yet.</p>}
    {evaluations.map((e) => <Evaluation key={e.id} evaluation={e} />)}
  </details>;
}
