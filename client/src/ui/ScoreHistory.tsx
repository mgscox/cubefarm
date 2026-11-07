// Why a developer's Authorship or Repair score moved: the floor's score ledger, newest first, with corrections.
import type { ScoreEventView } from '../../../shared/types';
import { useStore } from '../store';
import { scoreEventLine } from './FeedbackScore';

export function ScoreHistory({ repoId }: { repoId: string }) {
  const all = useStore((s) => s.scoreEvents);
  const events = all.filter((e) => e.repoId === repoId);
  if (!events.length) return null;
  const voided = new Map<string, ScoreEventView>();
  for (const e of events) if (e.corrects) e.corrects.active ? voided.delete(e.corrects.eventId) : voided.set(e.corrects.eventId, e);
  return <details className="small" style={{ overflowWrap: 'anywhere' }}>
    <summary>Score events ({events.length})</summary>
    {[...events].reverse().map((e) => <details key={e.id}>
      <summary>{scoreEventLine(e, voided.get(e.id))}</summary>
      <p>Event {e.id} · {new Date(e.at).toLocaleString()}<br />
        {e.evidence.outcomeId && <>QA outcome {e.evidence.outcomeId}<br /></>}
        {e.evidence.findingId && <>Finding {e.evidence.findingId}<br /></>}
        {e.evidence.attemptId && <>Repair attempt {e.evidence.attemptId}<br /></>}
        {e.evidence.correctionId && <>Finding correction {e.evidence.correctionId}<br /></>}
        Revision <code>{e.evidence.sha ?? 'Unknown'}</code></p>
      {e.corrects && <p>Corrects {e.corrects.eventId}</p>}
    </details>)}
  </details>;
}
