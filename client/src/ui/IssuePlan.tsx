// An Idea's Issue Plan revisions: proposed issues with their full briefs, what already exists on the tracker, Tracking
// Parents and dependencies. Read-only; drafting creates nothing on GitHub.
import { useState } from 'react';
import type { IssuePlanEntry, IssuePlanView } from '../../../shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Markdown } from './Markdown';

function PlanEntry({ entry, plan }: { entry: IssuePlanEntry; plan: IssuePlanView }) {
  const named = (key: string) => {
    const e = plan.entries.find((x) => x.key === key);
    return e ? (e.kind === 'existing' ? `${e.title} (#${e.issue?.number})` : e.title) : key;
  };
  const waits = plan.dependencies.filter((d) => d.issue === entry.key).map((d) => named(d.blockedBy));
  const unblocks = plan.dependencies.filter((d) => d.blockedBy === entry.key).map((d) => named(d.issue));
  const tag = entry.kind === 'existing' ? 'Exists' : entry.issue ? 'Remaining work' : 'New';
  return (
    <details className="plan-entry">
      <summary>
        <span className={`plan-tag plan-${entry.kind === 'existing' ? 'existing' : entry.issue ? 'overlap' : 'new'}`}>{tag}</span>{' '}
        <b>{entry.title}</b> <span className="small muted">{entry.repo}{entry.kind === 'existing' && ` #${entry.issue?.number}`}</span>
        <span className="small plan-waits">{waits.length ? `Waits for ${waits.join(', ')}` : 'Independent'}</span>
      </summary>
      <div className="plan-entry-body">
        <p className="small"><b>{entry.requirement.id}</b> {entry.requirement.text}</p>
        {entry.kind === 'existing' && entry.issue && (
          <p>Already on the tracker as <a href={entry.issue.url} target="_blank" rel="noreferrer">{entry.repo}#{entry.issue.number}</a>; it is referenced, never edited.</p>
        )}
        {entry.kind === 'new' && entry.issue && (
          <p className="small">
            Overlaps <a href={entry.issue.url} target="_blank" rel="noreferrer">#{entry.issue.number} {entry.issue.title}</a>, so this issue holds only the remaining work.
            {!!entry.covered?.length && <> Already covered there: {entry.covered.join('; ')}</>}
          </p>
        )}
        {entry.brief && <Markdown text={entry.brief} />}
        {entry.acceptance.length > 0 && <><h5>Acceptance criteria</h5><Markdown text={entry.acceptance.map((c) => `- ${c}`).join('\n')} /></>}
        {entry.specialty && <p className="small">Specialty: {entry.specialty}</p>}
        {unblocks.length > 0 && <p className="small">Unblocks {unblocks.join(', ')}</p>}
      </div>
    </details>
  );
}

export function IssuePlanSection({ ideaId, archived }: { ideaId: string; archived: boolean }) {
  const all = useStore((s) => s.issuePlans);
  const demo = useStore((s) => s.demo);
  const [picked, setPicked] = useState<number>();
  const [busy, setBusy] = useState(false);
  const plans = all.filter((p) => p.ideaId === ideaId).sort((a, b) => b.revision - a.revision);
  const plan = plans.find((p) => p.revision === picked) ?? plans[0];
  const draft = demo && !archived && (
    <button className="btn" disabled={busy} onClick={() => {
      setBusy(true);
      void api.draftDemoIssuePlan(ideaId).then((p) => setPicked(p.revision)).catch(() => undefined).finally(() => setBusy(false));
    }}>{busy ? 'Drafting…' : 'Draft demo Issue Plan'}</button>
  );
  if (!plan) return <><h4>Issue Plan</h4><div className="row wrap"><p className="muted grow">No Issue Plan yet.</p>{draft}</div></>;
  const flat = plan.entries.filter((e) => !e.parent);
  const reused = plan.entries.filter((e) => e.kind === 'existing').length;
  return (
    <section className="issue-plan" aria-label="Issue Plan">
      <div className="row wrap">
        <h4 className="grow">Issue Plan</h4>
        {plans.length > 1 && (
          <select aria-label="Issue Plan revision" value={plan.revision} onChange={(e) => setPicked(Number(e.target.value))}>
            {plans.map((p, i) => <option key={p.id} value={p.revision}>Revision {p.revision}{i === 0 ? ' (latest)' : ''}</option>)}
          </select>
        )}
        {draft}
      </div>
      <p className="small muted">
        Revision {plan.revision} · drafted from PRD revision {plan.prdRevision} · {new Date(plan.createdAt).toLocaleString()}.
        Drafting creates no GitHub issues, and existing issues stay untouched.
      </p>
      <p className="small">
        {plan.entries.length - reused} new · {reused} already on the tracker · {plan.dependencies.length} dependencies
        {plan.parents.length > 0 && ` · ${plan.parents.length} Tracking Parent${plan.parents.length > 1 ? 's' : ''}`}
      </p>
      {flat.map((e) => <PlanEntry key={e.key} entry={e} plan={plan} />)}
      {plan.parents.map((p) => (
        <div className="plan-parent" key={p.key}>
          <div><span className="plan-tag plan-parent-tag">Tracking Parent</span> <b>{p.title}</b> <span className="small muted">{p.repo}</span></div>
          {p.summary && <p className="small">{p.summary}</p>}
          {plan.entries.filter((e) => e.parent === p.key).map((e) => <PlanEntry key={e.key} entry={e} plan={plan} />)}
        </div>
      ))}
    </section>
  );
}
