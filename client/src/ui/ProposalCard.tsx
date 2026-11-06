import { PromptTextarea } from './PromptTextarea';
// The manager's approval card: one decision on the exact PRD + Issue Plan pair it displays.
import { useState } from 'react';
import type { IdeaView, ProposalAction, ProposalView } from '../../../shared/types';
import { api } from '../api';
import { newerDraftNote, reviewSummary, targetFloors, unresolvedFindings } from '../proposals';
import { useStore } from '../store';
import { Markdown } from './Markdown';

export const prdLink = (p: ProposalView) => `#idea/${p.ideaId}/prd/${p.id}`;
const when = (at: number) => new Date(at).toLocaleString();

/** The exact PRD revision a Proposal pairs with its Issue Plan, even when newer drafts exist. */
export function PrdView({ proposal }: { proposal: ProposalView }) {
  return (
    <article className="card proposal-prd" aria-label="PRD revision">
      <div className="row wrap">
        <h3>{proposal.prd.title}</h3>
        <span className="chip">PRD v{proposal.prd.revision}</span>
        <span className="small muted">paired with Issue Plan v{proposal.plan.revision}</span>
        <span className="spacer" />
        <a href={`#idea/${proposal.ideaId}`}>Back to the card</a>
      </div>
      <Markdown text={proposal.prd.body} />
    </article>
  );
}

function Issues({ proposal }: { proposal: ProposalView }) {
  const title = (key: string) => proposal.plan.issues.find((i) => i.key === key)?.title ?? key;
  return (
    <ul className="proposal-issues">
      {proposal.plan.issues.map((issue) => (
        <li key={issue.key}>
          <details>
            <summary>
              {issue.existing ? <span className="chip chip-good">Existing #{issue.existing.number}</span> : <span className="chip">{issue.tracking ? 'Tracking Parent' : 'New'}</span>}
              {' '}<b>{issue.title}</b>
              <span className="small muted"> · {issue.repo} · {issue.blockedBy.length ? `waits for ${issue.blockedBy.map(title).join(', ')}` : 'independent'}</span>
            </summary>
            <div className="proposal-brief">
              {issue.parent && <div className="small muted">Grouped under {title(issue.parent)}</div>}
              {issue.requirement && <div className="small muted">Implements {issue.requirement}</div>}
              {issue.existing && <div><a href={issue.existing.url} target="_blank" rel="noreferrer">{issue.repo}#{issue.existing.number}</a> stays as it is.</div>}
              <Markdown text={issue.brief} />
              {issue.criteria.length > 0 && <><b className="small">Acceptance criteria</b><ul>{issue.criteria.map((c) => <li key={c}>{c}</li>)}</ul></>}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function Reviews({ proposal }: { proposal: ProposalView }) {
  const rounds = [...new Set(proposal.reviews.map((r) => r.round))].sort((a, b) => a - b);
  return (
    <>
      {rounds.map((round) => (
        <div key={round}>
          <b className="small">Round {round}</b>
          <ul>
            {proposal.reviews.filter((r) => r.round === round).map((r) => (
              <li key={`${r.reviewer}:${r.focus}`}>
                {r.reviewer} ({r.focus}, PRD v{r.prdRevision}{r.planRevision ? ` · Issue Plan v${r.planRevision}` : ''}): {r.endorsed ? 'endorsed' : 'not endorsed'}
                {r.findings.length > 0 && <ul>{r.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function History({ proposal, earlier }: { proposal: ProposalView; earlier: ProposalView[] }) {
  return (
    <details className="proposal-history">
      <summary>Review history ({proposal.reviews.length} review{proposal.reviews.length === 1 ? '' : 's'}{earlier.length ? `, ${earlier.length} earlier proposal${earlier.length === 1 ? '' : 's'}` : ''})</summary>
      <Reviews proposal={proposal} />
      {earlier.map((p) => (
        <details key={p.id}>
          <summary>Earlier Proposal: PRD v{p.prd.revision} · Issue Plan v{p.plan.revision}</summary>
          <section aria-label={`Earlier Proposal PRD v${p.prd.revision} · Issue Plan v${p.plan.revision}`}>
            <a href={prdLink(p)}>View PRD v{p.prd.revision}</a>
            <div className="small muted">{reviewSummary(p)}</div>
            <Issues proposal={p} />
            <Reviews proposal={p} />
            {p.decision && <Decision proposal={p} />}
          </section>
        </details>
      ))}
    </details>
  );
}

function Decision({ proposal, onLinkedIdea }: { proposal: ProposalView; onLinkedIdea?: () => void }) {
  const d = proposal.decision!;
  if (d.action === 'approve') {
    const pub = d.publication;
    return (
      <p role="status" className="proposal-decision">
        Approved {when(d.at)}. {pub?.status === 'accepted' ? <>Handed to publication. <span className="muted">{pub.note}</span></> : 'Queued for publication.'}
      </p>
    );
  }
  if (d.action === 'refine') {
    return (
      <p role="status" className="proposal-decision">
        Sent back {when(d.at)}. {d.wordingOnly ? 'Wording changes return straight to you.' : 'The revision goes through a fresh review cycle first.'}
        <span className="proposal-quote">“{d.feedback}”</span>
      </p>
    );
  }
  return (
    <div role="status" className="proposal-decision">
      <p>Rejected {when(d.at)}. The Idea is archived with its history; no issues were created.
        {d.feedback && <span className="proposal-quote">“{d.feedback}”</span>}</p>
      {onLinkedIdea && <button className="btn btn-small" onClick={onLinkedIdea}>Start a linked Idea</button>}
    </div>
  );
}

export function ProposalCard({ idea, proposal, earlier, onLinkedIdea }: {
  idea: IdeaView; proposal: ProposalView; earlier: ProposalView[]; onLinkedIdea: () => void;
}) {
  const connected = useStore((s) => s.connected);
  const [mode, setMode] = useState<'refine' | 'reject' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [wording, setWording] = useState(false);
  const [busy, setBusy] = useState(false);
  const findings = unresolvedFindings(proposal);
  const newer = newerDraftNote(proposal);
  const open = !proposal.decision && idea.status !== 'archived';
  const decide = (action: ProposalAction) => {
    if (busy) return;
    setBusy(true);
    // The card sends the pair it displayed; the server refuses a stale one.
    void api.decideProposal(proposal.id, {
      action, prdRevision: proposal.prd.revision, planRevision: proposal.plan.revision,
      ...(action === 'approve' ? {} : { feedback }), ...(action === 'refine' ? { wordingOnly: wording } : {}),
    }).then(() => { setMode(null); setFeedback(''); }).catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <section className="card proposal-card" aria-label="Approval card">
      <div className="row wrap">
        <h3>{open ? 'Proposal for your decision' : 'Proposal'}</h3>
        <span className="chip">PRD v{proposal.prd.revision} · Issue Plan v{proposal.plan.revision}</span>
        <span className="spacer" />
        <a href={prdLink(proposal)}>View PRD</a>
      </div>
      <div className="small muted">{reviewSummary(proposal)}</div>
      {newer && <p className="proposal-newer" role="note">{newer}</p>}
      <div className="row wrap"><b className="small">Target floors</b>{targetFloors(proposal).map((f) => <span className="chip" key={f}>{f}</span>)}</div>
      <Issues proposal={proposal} />
      <b className="small">Unresolved findings</b>
      {findings.length ? (
        <ul className="proposal-findings">{findings.map((f) => <li key={`${f.reviewer}:${f.text}`}><b>{f.reviewer}</b> ({f.focus}): {f.text}</li>)}</ul>
      ) : <p className="small muted">None.</p>}
      <History proposal={proposal} earlier={earlier} />
      {proposal.decision ? <Decision proposal={proposal} onLinkedIdea={onLinkedIdea} /> : open && (
        mode ? (
          <form className="proposal-feedback" onSubmit={(e) => { e.preventDefault(); decide(mode); }}>
            <label className="field">{mode === 'refine' ? 'What should change?' : 'Why reject it? (optional)'}
              <PromptTextarea rows={3} maxLength={5000} value={feedback} onValueChange={setFeedback} required={mode === 'refine'} />
            </label>
            {mode === 'refine' && (
              <label className="toggle"><input type="checkbox" checked={wording} onChange={(e) => setWording(e.target.checked)} />Wording only (skip a fresh review)</label>
            )}
            <div className="row wrap">
              <button className={`btn ${mode === 'reject' ? 'btn-bad' : ''}`} disabled={busy || !connected || (mode === 'refine' && !feedback.trim())}>
                {mode === 'refine' ? 'Send for refinement' : 'Reject and archive'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="row wrap proposal-actions">
            <button className="btn btn-good" disabled={busy || !connected} onClick={() => decide('approve')}>Approve</button>
            <button className="btn btn-ghost btn-small" disabled={busy || !connected} onClick={() => setMode('refine')}>Request refinement</button>
            <button className="btn btn-ghost btn-small" disabled={busy || !connected} onClick={() => setMode('reject')}>Reject</button>
          </div>
        )
      )}
    </section>
  );
}
