// A floor's reviewed lessons (docs/lessons.md): recurring findings to draft from, drafts to review, approved lessons.
import { useMemo, useState } from 'react';
import type { LessonVersion, LessonView } from '../../../shared/types';
import { approvedVersion, canRevise, lessonExport, lessonRetired, lessonStatus, recurringFindings, sourceHeld, versionStatus, type LessonSuggestion } from '../../../shared/lessons';
import { api, type LessonInput } from '../api';
import { kindLabel, sourceLabel, STATUS_LABEL, suggestionInput, verificationOptions, versionInput } from '../lessons';
import { useStore } from '../store';

function LessonForm({ repoId, initial, lessonId, onDone }: { repoId: string; initial: LessonInput; lessonId?: string; onDone: () => void }) {
  const [title, setTitle] = useState(initial.title);
  const [guidance, setGuidance] = useState(initial.guidance);
  const [specialty, setSpecialty] = useState(initial.specialty ?? '');
  const [verification, setVerification] = useState(initial.verification.kind);
  const [test, setTest] = useState(initial.verification.test ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const outcomes = useStore((s) => s.qaOutcomes);
  const attempts = useStore((s) => s.runAttempts);
  const options = useMemo(() => verificationOptions(repoId, outcomes, attempts), [repoId, outcomes, attempts]);
  const { qaOutcomeId, attemptId } = initial.verification;
  const [evidence, setEvidence] = useState(qaOutcomeId ? `qa:${qaOutcomeId}` : attemptId ? `attempt:${attemptId}` : '');
  const known = !evidence || options.some((o) => o.value === evidence);
  return (
    <form className="issue-form lesson-form" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const input: LessonInput = { ...initial, title, guidance, specialty: specialty.trim() || null,
        verification: {
          kind: verification, ...(verification === 'regression-test' && { test }),
          ...(evidence.startsWith('qa:') ? { qaOutcomeId: evidence.slice(3) } : { attemptId: evidence.slice(8) }),
        } };
      try {
        if (lessonId) await api.reviseLesson(lessonId, { ...input, reason });
        else await api.draftLesson(repoId, input);
        onDone();
      } catch {
        // toasted
      } finally {
        setBusy(false);
      }
    }}>
      <p className="small">{kindLabel(initial.kind)} · {initial.sources.length} source{initial.sources.length === 1 ? '' : 's'}</p>
      <label className="field">Lesson title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus /></label>
      <label className="field">Checklist or playbook guidance
        <textarea value={guidance} onChange={(e) => setGuidance(e.target.value)} maxLength={2000} rows={3} required placeholder="Before handing off, check the toolbar at 375px wide." />
      </label>
      <div className="row">
        <label className="field">Specialty<input value={specialty} onChange={(e) => setSpecialty(e.target.value)} maxLength={40} placeholder="Every specialty" /></label>
        <label className="field">Verified by
          <select value={verification} onChange={(e) => setVerification(e.target.value as typeof verification)}>
            <option value="fix">Fix that passed QA</option>
            <option value="regression-test">Regression test</option>
          </select>
        </label>
        {verification === 'regression-test' && <label className="field">Test<input value={test} onChange={(e) => setTest(e.target.value)} maxLength={200} required placeholder="e2e/toolbar.spec.ts" /></label>}
      </div>
      <label className="field">Verifying evidence
        <select value={evidence} onChange={(e) => setEvidence(e.target.value)} required>
          <option value="">Choose the passing review or attempt</option>
          {!known && <option value={evidence}>Kept from the earlier version</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {lessonId && <label className="field">What changed<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></label>}
      <div className="row">
        <button type="button" className="btn btn-small" disabled={busy} onClick={onDone}>Cancel</button>
        <button className="btn btn-small btn-good" disabled={busy || !evidence || !title.trim() || !guidance.trim()}>{lessonId ? 'Save new version' : 'Save draft'}</button>
      </div>
    </form>
  );
}

function Decision({ lesson }: { lesson: LessonView }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revising, setRevising] = useState(false);
  const status = lessonStatus(lesson);
  const current = approvedVersion(lesson);
  const decide = async (action: Parameters<typeof api.reviewLesson>[1]) => {
    setBusy(true);
    try { await api.reviewLesson(lesson.id, action, reason); setReason(''); }
    catch { /* toasted */ }
    finally { setBusy(false); }
  };
  if (revising) return <LessonForm repoId={lesson.repoId} lessonId={lesson.id} initial={versionInput(lesson.versions.at(-1)!)} onDone={() => setRevising(false)} />;
  const pending = status === 'draft' || status === 'needs-revision';
  return (
    <div className="row lesson-actions">
      <input aria-label="Review reason" placeholder="Reason" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      {status === 'draft' && !lessonRetired(lesson) && <button className="btn btn-small btn-good" disabled={busy} onClick={() => decide('approve')}>Approve</button>}
      {status === 'draft' && <button className="btn btn-small" disabled={busy || !reason.trim()} onClick={() => decide('request-revision')}>Send back</button>}
      {pending && <button className="btn btn-small btn-bad" disabled={busy || !reason.trim()} onClick={() => decide('reject')}>Reject</button>}
      {canRevise(lesson) && <button className="btn btn-small" disabled={busy} onClick={() => setRevising(true)}>Revise…</button>}
      {current && !pending && <button className="btn btn-small" disabled={busy || !reason.trim()} onClick={() => decide('supersede')}>Supersede</button>}
    </div>
  );
}

function LessonCard({ lesson, version }: { lesson: LessonView; version: LessonVersion }) {
  const outcomes = useStore((s) => s.qaOutcomes);
  const attempts = useStore((s) => s.runAttempts);
  const status = versionStatus(lesson, version.version);
  const e = version.verification.evidence;
  return (
    <div className={`kcard lesson ${status === 'approved' ? 'kcard-good' : ''}`}>
      <div className="kcard-title"><b>{version.title}</b></div>
      <p className="small muted">
        {kindLabel(version.kind)} · {version.specialty ?? 'every specialty'} · version {version.version} · {STATUS_LABEL[status]}
        {lessonStatus(lesson) !== status && ` · version ${lesson.versions.at(-1)!.version} ${STATUS_LABEL[lessonStatus(lesson)].toLowerCase()}`}
      </p>
      <p className="lesson-guidance">{version.guidance}</p>
      <p className="small"><b>Evidence</b></p>
      <ul className="small lesson-sources">
        {version.sources.map((s) => (
          <li key={`${s.kind}:${s.ref}`}>
            {sourceLabel(s)}: {s.summary}
            {s.url && <> <a href={s.url} target="_blank" rel="noreferrer">link ↗</a></>}
            {!sourceHeld(s, outcomes, attempts) && <span className="muted"> (record pruned; summary kept)</span>}
          </li>
        ))}
      </ul>
      <p className="small">
        <b>Verified by</b> {version.verification.kind === 'regression-test' ? <>regression test <code>{version.verification.test}</code></> : 'a fix that passed QA'}
        {' · '}{sourceLabel(e)}: {e.summary}{!sourceHeld(e, outcomes, attempts) && <span className="muted"> (record pruned; summary kept)</span>}
      </p>
      <details className="small">
        <summary>Review history ({lesson.reviews.length})</summary>
        <ul>
          {lesson.reviews.map((r) => (
            <li key={r.id}>v{r.version} {r.action} by {r.actor} · {new Date(r.at).toLocaleString()}{r.reason && ` · ${r.reason}`}{r.supersededBy && ` · by lesson ${r.supersededBy.slice(0, 8)}`}</li>
          ))}
        </ul>
        <p>Revisions: {version.revisions.map((sha) => <code key={sha}>{sha.slice(0, 7)} </code>)}</p>
      </details>
      <Decision lesson={lesson} />
    </div>
  );
}

function Suggestion({ s }: { s: LessonSuggestion }) {
  const attempts = useStore((st) => st.runAttempts);
  const [drafting, setDrafting] = useState(false);
  const prs = [...new Set(s.findings.map((f) => f.prNumber))];
  return (
    <div className="kcard">
      <div className="kcard-title"><b>{s.check}</b> · {kindLabel(s.kind)}</div>
      <p className="small muted">Seen on {prs.map((n) => `PR #${n}`).join(', ')} · {s.fix ? `fix passed QA on PR #${s.fix.prNumber}` : 'no fix has passed QA yet'}</p>
      {drafting
        ? <LessonForm repoId={s.repoId} initial={suggestionInput(s, attempts)} onDone={() => setDrafting(false)} />
        : <button className="btn btn-small" onClick={() => setDrafting(true)}>Draft lesson…</button>}
    </div>
  );
}

export function Lessons({ repoId }: { repoId: string }) {
  const all = useStore((s) => s.lessons);
  const outcomes = useStore((s) => s.qaOutcomes);
  const [specialty, setSpecialty] = useState('');
  const lessons = all.filter((l) => l.repoId === repoId);
  const approved = lessonExport(lessons, { repoId, specialty }, 0).lessons;
  const approvedCount = lessons.filter((l) => approvedVersion(l)).length;
  const toReview = lessons.filter((l) => lessonStatus(l) === 'draft' || lessonStatus(l) === 'needs-revision');
  const suggestions = useMemo(() => recurringFindings(outcomes.filter((o) => o.repoId === repoId), all), [outcomes, all, repoId]);
  const specialties = [...new Set(lessons.flatMap((l) => l.versions.map((v) => v.specialty)).filter((x): x is string => !!x))].sort();
  const exportUrl = `/api/lessons?repoId=${encodeURIComponent(repoId)}${specialty ? `&specialty=${encodeURIComponent(specialty)}` : ''}&download=1`;
  return (
    <details className="lessons">
      <summary>Lessons ({approvedCount}{toReview.length ? `, ${toReview.length} to review` : ''})</summary>
      <div className="run-history-bar">
        <select aria-label="Lesson specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
          <option value="">All specialties</option>
          {specialties.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <a className="btn" href={exportUrl} download>⬇ Export JSON</a>
        <span className="muted small">Approved lessons only</span>
      </div>
      {approved.length === 0 && <p className="muted small">No approved lessons{specialty && ` for ${specialty}`} yet.</p>}
      {approved.map((v) => <LessonCard key={v.id} lesson={lessons.find((l) => l.id === v.id)!} version={v} />)}
      {!!toReview.length && <h4>To review</h4>}
      {toReview.map((l) => <LessonCard key={l.id} lesson={l} version={l.versions.at(-1)!} />)}
      {!!suggestions.length && <h4>Recurring findings</h4>}
      {suggestions.map((s) => <Suggestion key={`${s.kind}:${s.key}`} s={s} />)}
    </details>
  );
}
