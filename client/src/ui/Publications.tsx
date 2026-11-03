// Approved proposals on their way to GitHub: publishing, held with the cause, or published with the issue links.
// The Ideas view will show the same records on each Idea; the demo can seed an approved proposal here.
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { PublicationView, PublishedStep } from '../../../shared/types';

const STATUS: Record<PublicationView['status'], string> = { publishing: '⏳ Publishing', blocked: '⛔ Held', complete: '✅ Published' };
const STEP: Record<PublishedStep, string> = {
  pending: 'not created yet',
  creating: 'being created (held)',
  created: 'created held, checking it',
  verified: 'verified, releasing',
  released: 'released to the floor',
};
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function PublicationsCard() {
  const publications = useStore((s) => s.publications);
  const demo = useStore((s) => s.demo);
  const [busy, setBusy] = useState(false);
  if (!demo && publications.length === 0) return null;
  const seed = (fault: '' | 'lost-create' | 'refused') => {
    setBusy(true);
    void api.demoPublication(fault).catch(() => undefined).finally(() => setBusy(false));
  };
  return (
    <div className="card">
      <h3>💡 Published from Ideas</h3>
      {demo && (
        <>
          <p className="muted small">Demo: publish a seeded, already-approved proposal to floor 1, optionally with a fault at the fake GitHub.</p>
          <div className="row wrap">
            <button className="btn btn-small" disabled={busy} onClick={() => seed('')}>Publish sample</button>
            <button className="btn btn-small" disabled={busy} onClick={() => seed('lost-create')}>…lose the create response</button>
            <button className="btn btn-small" disabled={busy} onClick={() => seed('refused')}>…refuse writes for 20 s</button>
          </div>
        </>
      )}
      <div className="repo-list">
        {publications.length === 0 && <div className="muted small">No approved proposals yet.</div>}
        {[...publications].reverse().map((p) => (
          <div key={p.proposalId} className="repo-row">
            <div>
              <strong>{STATUS[p.status]}</strong> {p.snapshot.issues.map((i) => i.title).join(', ')}
              <div className="muted small">
                PRD v{p.snapshot.approval.prdRevision} · Issue Plan v{p.snapshot.approval.planRevision} · approved {time(p.snapshot.approval.decidedAt)}
              </div>
              {p.issues.map((i) => (
                <div key={i.entryId} className="small">
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noreferrer">
                      {i.repo}#{i.number}
                    </a>
                  ) : (
                    i.repo
                  )}{' '}
                  · {STEP[i.step]}
                </div>
              ))}
              {p.note && <div className="muted small">{p.needsManager ? '⚠ ' : ''}{p.note}</div>}
              {p.retryAt && p.status !== 'complete' && <div className="muted small">Next attempt at {time(p.retryAt)}</div>}
            </div>
            {p.status !== 'complete' && (
              <button className="btn btn-small" onClick={() => void api.retryPublication(p.proposalId).catch(() => undefined)}>
                Retry now
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
