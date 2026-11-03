// Shared Idea intake and record presentation; workflow actions belong to their owning slices.
import { useEffect, useState } from 'react';
import { FOCUS_LABEL, REVIEW_FOCUSES } from '../../../shared/ideaReview';
import type { IdeaRecordView, IdeaReviewCycleView, IdeaView } from '../../../shared/types';
import { api } from '../api';
import { ideaStatusLabel, reviewProgress, verdictText } from '../ideas';
import { useStore } from '../store';
import { IssuePlanSection } from './IssuePlan';
import { Markdown } from './Markdown';

const ideaLink = (id: string) => `#idea/${id}`;

function IdeaReview({ cycle }: { cycle: IdeaReviewCycleView }) {
  const agents = useStore((s) => s.agents);
  const name = (id: string) => agents[id]?.name ?? id;
  const h = cycle.handoff;
  return (
    <section className="idea-review" aria-label="Proposal review">
      <h4>Review</h4>
      <p className="small muted">Lead: {name(cycle.author)} · {REVIEW_FOCUSES.map((f) => `${FOCUS_LABEL[f]}: ${name(cycle.reviewers[f])}`).join(' · ')}</p>
      <p>{reviewProgress(cycle, name)}</p>
      {h && (
        <div className={`idea-handoff ${h.endorsed ? 'idea-endorsed' : 'idea-open'}`} role="note" aria-label="Handoff">
          <b>For your decision: PRD r{h.prdRevision} with Issue Plan r{h.planRevision}</b>
          {h.unresolved.length > 0 && (
            <ul>{h.unresolved.map((f, i) => <li key={i}><b>{FOCUS_LABEL[f.focus]}</b> ({name(f.reviewer)}): {f.text}</li>)}</ul>
          )}
        </div>
      )}
      <ol className="idea-rounds">
        {[...cycle.rounds].reverse().map((round) => (
          <li key={round.round} aria-label={`Round ${round.round}`}>
            <div><b>Round {round.round}</b> <span className="small muted">PRD r{round.prdRevision} · Issue Plan r{round.planRevision}</span></div>
            {REVIEW_FOCUSES.map((focus) => {
              const review = round.reviews.find((r) => r.focus === focus);
              return (
                <div className="idea-verdict" key={focus}>
                  <span>{FOCUS_LABEL[focus]} · {name(cycle.reviewers[focus])}</span>
                  <span className={review ? (review.verdict === 'endorse' ? 'good' : 'warn') : 'muted'}>{verdictText(review)}</span>
                  {review && review.findings.length > 0 && <ul>{review.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                </div>
              );
            })}
          </li>
        ))}
      </ol>
    </section>
  );
}

function DemoReviewFixture({ ideaId }: { ideaId: string }) {
  const [busy, setBusy] = useState(false);
  const run = (fixture: 'agree' | 'disagree') => {
    setBusy(true);
    void api.demoIdeaReview(ideaId, fixture).catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <section className="idea-demo" aria-label="Demo review">
      <h4>Demo review</h4>
      <p className="small muted">Adds a fixture PRD and Issue Plan, then two agents review them.</p>
      <div className="row wrap">
        <button className="btn" disabled={busy} onClick={() => run('agree')}>Reviewers agree</button>
        <button className="btn" disabled={busy} onClick={() => run('disagree')}>Reviewers disagree</button>
      </div>
    </section>
  );
}

export function IdeaDetail({ idea, records }: { idea: IdeaView; records: IdeaRecordView[] }) {
  const cycle = useStore((s) => s.ideaReviews.find((r) => r.ideaId === idea.id));
  const demo = useStore((s) => s.demo);
  return (
    <article className="card idea-detail" aria-label="Idea detail">
      <div className="row wrap">
        <h3>Idea</h3>
        <span className="idea-status" role="status">{ideaStatusLabel(idea, cycle)}</span>
        <span className="spacer" />
        <a href={ideaLink(idea.id)}>Link to this Idea</a>
      </div>
      <p className="idea-prose">{idea.description}</p>
      <div className="small muted idea-identity">{idea.id} · {new Date(idea.createdAt).toLocaleString()}</div>
      <h4>Floor hints</h4>
      <p>{idea.floorHints.length ? idea.floorHints.join(', ') : 'No floor hints — affected repositories are open.'}</p>
      {idea.constraints && <><h4>Constraints</h4><p className="idea-prose">{idea.constraints}</p></>}
      {idea.links.length > 0 && <><h4>Links</h4><ul>{idea.links.map((link) => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></li>)}</ul></>}
      <IssuePlanSection ideaId={idea.id} />
      {cycle && <IdeaReview cycle={cycle} />}
      {!cycle && demo && idea.status === 'queued' && <DemoReviewFixture ideaId={idea.id} />}
      <h4>Research, reviews & proposals</h4>
      {records.length === 0 && <p className="muted">No records yet.</p>}
      {[...records].sort((a, b) => a.createdAt - b.createdAt).map((record) => (
        <section className="card" key={`${record.kind}:${record.id}`}>
          <div className="small muted">{record.kind} · {new Date(record.createdAt).toLocaleString()}</div>
          <h4>{record.title}</h4>
          <Markdown text={record.body} />
        </section>
      ))}
    </article>
  );
}

export function IdeasTab({ initialIdea }: { initialIdea?: string }) {
  const ideas = useStore((s) => s.ideas);
  const records = useStore((s) => s.ideaRecords);
  const reviews = useStore((s) => s.ideaReviews);
  const repos = useStore((s) => s.repos);
  const connected = useStore((s) => s.connected);
  const [selected, setSelected] = useState(initialIdea);
  const [description, setDescription] = useState('');
  const [constraints, setConstraints] = useState('');
  const [links, setLinks] = useState('');
  const [floorHints, setFloorHints] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelected(initialIdea), [initialIdea]);
  const idea = ideas.find((i) => i.id === selected);
  return (
    <div className="ideas">
      <div className="row wrap">
        <div className="grow"><h2>Ideas</h2><p className="muted">Start with a problem or desired outcome. Floor hints are optional.</p></div>
        {selected && <button className="btn" onClick={() => {
          setSelected(undefined);
          useStore.getState().openOverlay({ kind: 'manager', tab: 'ideas' });
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }}>New Idea</button>}
      </div>
      <div className="ideas-grid">
        <nav className="idea-list" aria-label="Idea queue">
          {ideas.length === 0 && <p className="muted">Your first Idea starts here.</p>}
          {[...ideas].sort((a, b) => b.createdAt - a.createdAt).map((item) => (
            <a className={`card idea-entry ${item.id === selected ? 'idea-selected' : ''}`} href={ideaLink(item.id)} key={item.id} onClick={() => setSelected(item.id)}>
              <b>{item.description}</b><span className="small">{ideaStatusLabel(item, reviews.find((r) => r.ideaId === item.id))}</span>
            </a>
          ))}
        </nav>
        {selected ? (
          idea ? <IdeaDetail idea={idea} records={records.filter((record) => record.ideaId === idea.id)} /> : <p role="status">Idea not found in this office.</p>
        ) : (
          <form className="card" onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            void api.submitIdea({ description, constraints, links: links.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), floorHints }).then((created) => {
              setDescription(''); setConstraints(''); setLinks(''); setFloorHints([]);
              setSelected(created.id);
              window.location.hash = ideaLink(created.id);
            }).catch(() => undefined).finally(() => setBusy(false));
          }}>
            <h3>Submit an Idea</h3>
            <label className="field">Short description <textarea required maxLength={2000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What would you like to improve?" /></label>
            <label className="field">Links (optional, one per line)<textarea rows={2} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://…" /></label>
            <label className="field">Constraints (optional)<textarea maxLength={10000} rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} /></label>
            <fieldset className="idea-hints"><legend>Floor hints (optional)</legend>
              {repos.length === 0 && <p className="muted">You can submit before configuring any floors.</p>}
              {repos.map((repo) => <label className="toggle" key={repo.id}><input type="checkbox" checked={floorHints.includes(repo.id)} onChange={(e) => setFloorHints(e.target.checked ? [...floorHints, repo.id] : floorHints.filter((id) => id !== repo.id))} />{repo.fullName}</label>)}
            </fieldset>
            <button className="btn btn-good" disabled={busy || !connected || !description.trim()}>{busy ? 'Queuing…' : 'Queue Idea'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
