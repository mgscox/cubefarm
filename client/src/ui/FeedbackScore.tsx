import type { AgentView, DeveloperScoresView, ScoreEventView } from '../../../shared/types';

// The same developer score chips in the team and terminal headers: Authorship, Repair and the legacy total.
const ZERO: DeveloperScoresView = { authorship: { points: 0, events: 0 }, repair: { points: 0, events: 0 }, neutral: 0 };
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const count = (n: number) => `${n} event${n === 1 ? '' : 's'}`;

export function FeedbackScore({ agent }: { agent: Pick<AgentView, 'role' | 'score' | 'scores'> }) {
  if (agent.role !== 'dev') return null;
  const { authorship, repair, neutral } = agent.scores ?? ZERO;
  const unscored = `${count(neutral)} recorded with no score change (worker, inconclusive, self-repair, no-op…)`;
  return (
    <>
      <span className="chip nowrap" title={`Authorship: +2 when a PR this developer originally submitted merges; -1 at most once per PR for a confirmed defect in that original implementation. ${unscored}.`}>
        Authorship {signed(authorship.points)} · {count(authorship.events)}
      </span>
      <span className="chip nowrap" title="Repair: +1 at most once per PR for an independently verified fix to another developer's defect; -1 for a confirmed new defect a repair introduced.">
        Repair {signed(repair.points)} · {count(repair.events)}
      </span>
      <span className="chip nowrap" style={{ opacity: 0.65 }} title="Legacy combined score (+2 per merged PR, -1 per eligible QA send-back) from before the split. Automatic assignment still ranks by it; Authorship and Repair started at zero.">
        Legacy {signed(agent.score)}
      </span>
    </>
  );
}

/** One line per ledger entry; a later correction marks the entry it voided. */
export function scoreEventLine(e: ScoreEventView, voidedBy?: ScoreEventView): string {
  const who = e.name ?? e.agentId ?? 'Unknown author';
  const what = e.score ? `${e.score === 'authorship' ? 'Authorship' : 'Repair'} ${signed(e.points)}` : 'No score change';
  return `PR #${e.prNumber} · ${who} · ${what} · ${e.reason}${voidedBy ? ' (voided)' : ''}`;
}
