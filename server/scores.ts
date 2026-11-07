// Authorship and Repair scores: events derived from a PR's contribution and QA histories, kept in an append-only ledger.
import { scoringFindings } from '../shared/qaEvidence.ts';
import type { DeveloperScoresView, PrContributionView, QaOutcomeView, ScoreEventView } from '../shared/types.ts';

export const SCORE_LEDGER_VERSION = 1;

/** `cutoverAt`: evidence recorded before the ledger existed is legacy and never scored. */
export interface ScoreLedger { version: number; cutoverAt: number; events: ScoreEventView[] }

export type DerivedScoreEvent = Omit<ScoreEventView, 'at'>;
type Repair = PrContributionView['repairs'][number];
type Finding = QaOutcomeView['findings'][number];

const short = (sha: string | null | undefined) => sha?.slice(0, 7) ?? 'unknown';
const classification = (o: QaOutcomeView, f: Finding) => o.corrections.findLast((c) => c.findingId === f.id)?.classification ?? f.classification;

/**
 * Every event the current evidence supports for one PR. Caps (one merge award and one original defect per PR, one fix
 * credit per agent, one regression per submitted repair) are applied here in time order, so a voided event lets the
 * next eligible one take its place.
 */
export function deriveScoreEvents(history: PrContributionView, allOutcomes: QaOutcomeView[], cutoverAt: number): DerivedScoreEvent[] {
  const { repoId, prNumber } = history;
  const pr = `${repoId}#${prNumber}`;
  const original = history.original && history.original.at >= cutoverAt ? history.original : null;
  const repairs = history.repairs.filter((r) => r.startedAt >= cutoverAt);
  const outcomes = allOutcomes.filter((o) => o.repoId === repoId && o.prNumber === prNumber && o.startedAt >= cutoverAt)
    .sort((a, b) => a.finishedAt - b.finishedAt);
  const events: DerivedScoreEvent[] = [];
  const add = (e: Omit<DerivedScoreEvent, 'repoId' | 'prNumber'>) => events.push({ repoId, prNumber, ...e });
  const submitted = (r: Repair) => r.finishedAt !== null && !!r.submittedSha && r.submittedSha !== r.startingSha;
  const selfRepair = (r: Repair) => r.agentId === original?.agentId;
  // A finding is attributable only to a recorded contribution that was submitted before the review began.
  const source = (o: QaOutcomeView, f: Finding): { repair: Repair | null } | null => {
    const t = f.attributableTo;
    if (!t) return null;
    if (original && t.agentId === original.agentId && t.submittedSha === original.submittedSha && original.at <= o.startedAt) return { repair: null };
    const repair = repairs.find((r) => submitted(r) && r.agentId === t.agentId && r.submittedSha === t.submittedSha && r.finishedAt! <= o.startedAt);
    return repair ? { repair } : null;
  };

  if (original && history.state === 'MERGED') {
    add({ id: `authorship:merge:${pr}`, agentId: original.agentId, name: original.name, score: 'authorship', points: 2, rule: 'merge',
      reason: `Merged; originally submitted at ${short(original.submittedSha)}`, evidence: { sha: original.submittedSha } });
  }

  let originalCharged = false;
  const regressionCharged = new Set<string>();
  for (const o of outcomes) {
    const eligible = scoringFindings(o);
    const notes: string[] = [];
    for (const f of eligible) {
      const src = source(o, f);
      if (!src) notes.push(`"${f.key}" names no verified contribution in this revision`);
      else if (!src.repair) {
        if (originalCharged) notes.push(`"${f.key}": the original implementation is charged at most once`);
        else {
          originalCharged = true;
          add({ id: `authorship:defect:${pr}:${f.id}`, agentId: original!.agentId, name: original!.name, score: 'authorship', points: -1,
            rule: 'original-defect', reason: `Confirmed defect "${f.key}" from the original implementation`,
            evidence: { outcomeId: o.id, findingId: f.id, sha: original!.submittedSha } });
        }
      } else {
        const r = src.repair;
        const repeated = outcomes.some((p) => p.finishedAt <= r.startedAt && p.findings.some((x) => x.key === f.key));
        if (selfRepair(r)) notes.push(`"${f.key}" came from the author's own repair`);
        else if (repeated) notes.push(`"${f.key}" was already reported before ${r.name}'s repair`);
        else if (regressionCharged.has(r.id)) notes.push(`"${f.key}": that repair is charged at most once`);
        else {
          regressionCharged.add(r.id);
          add({ id: `repair:regression:${pr}:${r.id}:${f.id}`, agentId: r.agentId, name: r.name, score: 'repair', points: -1,
            rule: 'repair-regression', reason: `Confirmed new defect "${f.key}" introduced by the repair at ${short(r.submittedSha)}`,
            evidence: { outcomeId: o.id, findingId: f.id, attemptId: r.id, sha: r.submittedSha } });
        }
      }
    }
    if (o.verdict === 'pass') continue;
    const ignored = o.findings.filter((f) => !eligible.includes(f));
    if (!ignored.length && !notes.length && o.findings.length) continue;
    const count = (c: string, label: string) => {
      const n = ignored.filter((f) => classification(o, f) === c).length;
      return n ? `${n} ${label}` : '';
    };
    const why = [
      o.verdict === 'incomplete' && !o.findings.length ? `no usable report${o.terminalReason ? ` (${o.terminalReason.split('\n')[0].slice(0, 120)})` : ''}` : '',
      o.revision !== 'exact' ? `${o.revision} revision` : '',
      count('worker', 'worker'), count('inconclusive', 'inconclusive'), count('code', 'unconfirmed or unattributed code'),
      ...notes,
    ].filter(Boolean).join('; ');
    const owner = original?.submittedSha === o.headSha ? original : repairs.findLast((r) => submitted(r) && r.submittedSha === o.headSha);
    add({ id: `neutral:qa:${o.id}`, agentId: owner?.agentId ?? null, name: owner?.name ?? null, score: null, points: 0, rule: 'neutral',
      reason: `QA ${o.verdict} at ${short(o.headSha)} scored nothing: ${why}`, evidence: { outcomeId: o.id, sha: o.headSha } });
  }

  const credited = new Set<string>();
  for (const r of repairs) {
    if (r.finishedAt === null) continue;
    const neutral = (why: string) => add({ id: `neutral:repair:${r.id}`, agentId: r.agentId, name: r.name, score: null, points: 0,
      rule: 'neutral', reason: `Repair (${r.reason}) ${why}`, evidence: { attemptId: r.id, sha: r.submittedSha } });
    if (!submitted(r) || !r.startingSha) {
      neutral(r.submittedSha && r.submittedSha === r.startingSha ? 'handed back without a new revision' : 'has no known starting or submitted revision');
      continue;
    }
    const inherited = outcomes.filter((o) => o.headSha === r.startingSha && o.finishedAt <= r.startedAt)
      .flatMap((o) => scoringFindings(o).filter((f) => source(o, f)));
    const theirs = inherited.filter((f) => f.attributableTo!.agentId !== r.agentId);
    if (!inherited.length) { neutral(r.reason === 'qa' ? 'had no confirmed, attributable defect to fix' : 'reconciled without a scored defect'); continue; }
    if (selfRepair(r) || !theirs.length) { neutral('fixed the author\'s own defect (self-repair)'); continue; }
    const keys = new Set(theirs.map((f) => f.key));
    const later = outcomes.filter((o) => o.headSha === r.submittedSha && o.startedAt >= r.finishedAt! && o.revision === 'exact' && o.reviewer.agentId !== r.agentId);
    const verified = later.find((o) => o.verdict !== 'incomplete' && !o.findings.some((f) => keys.has(f.key)) &&
      (o.verdict === 'pass' || o.findings.every((f) => classification(o, f) === 'code')));
    if (!verified) {
      if (later.some((o) => o.findings.some((f) => keys.has(f.key) && classification(o, f) === 'code'))) neutral('left the inherited defect unresolved');
      continue;
    }
    if (credited.has(r.agentId)) { neutral('was verified, but each agent earns repair credit once per PR'); continue; }
    credited.add(r.agentId);
    add({ id: `repair:fix:${pr}:${r.id}`, agentId: r.agentId, name: r.name, score: 'repair', points: 1, rule: 'repair-fix',
      reason: `Independently verified fix for inherited ${[...keys].map((k) => `"${k}"`).join(', ')} at ${short(r.submittedSha)}`,
      evidence: { attemptId: r.id, outcomeId: verified.id, sha: r.submittedSha } });
  }
  return events;
}

const activeState = (ledger: ScoreEventView[]) => {
  const active = new Map<string, boolean>();
  for (const e of ledger) if (e.corrects) active.set(e.corrects.eventId, e.corrects.active);
  return active;
};

/**
 * The entries to append so the ledger matches `derived` for one PR: new events, plus a correction for each event
 * whose support changed. Replaying the same evidence appends nothing.
 */
export function reconcileScores(
  ledger: ScoreEventView[], scope: { repoId: string; prNumber: number }, derived: DerivedScoreEvent[], outcomes: QaOutcomeView[], now: number,
): ScoreEventView[] {
  const known = new Set(ledger.map((e) => e.id));
  const added: ScoreEventView[] = derived.filter((d) => !known.has(d.id)).map((d) => ({ ...d, at: now }));
  const wanted = new Set(derived.map((d) => d.id));
  const active = activeState(ledger);
  for (const e of ledger) {
    if (e.corrects || e.repoId !== scope.repoId || e.prNumber !== scope.prNumber) continue;
    const was = active.get(e.id) ?? true;
    if (was === wanted.has(e.id)) continue;
    const outcome = outcomes.find((o) => o.id === e.evidence.outcomeId);
    const correction = outcome?.corrections.findLast((c) => !e.evidence.findingId || c.findingId === e.evidence.findingId);
    const reason = correction ? `Finding corrected to ${correction.classification} by ${correction.actor}: ${correction.reason}`
      : outcome && outcome.revision !== 'exact' ? `QA evidence is now ${outcome.revision}`
      : was ? 'Supporting evidence no longer qualifies' : 'Supporting evidence qualifies again';
    const n = ledger.filter((c) => c.corrects?.eventId === e.id).length + 1;
    added.push({ id: `correction:${e.id}:${n}`, repoId: e.repoId, prNumber: e.prNumber, agentId: e.agentId, name: e.name, score: e.score,
      points: was ? -e.points : e.points, rule: 'correction', reason: `${was ? 'Voided' : 'Restored'}: ${reason}`,
      evidence: { ...e.evidence, ...(correction && { correctionId: correction.id }) }, corrects: { eventId: e.id, active: !was }, at: now });
  }
  return added;
}

export const ZERO_SCORES: DeveloperScoresView = { authorship: { points: 0, events: 0 }, repair: { points: 0, events: 0 }, neutral: 0 };

/** Per-agent totals: points include corrections; sample counts are events that are still active. */
export function projectScores(ledger: ScoreEventView[]): Map<string, DeveloperScoresView> {
  const totals = new Map<string, DeveloperScoresView>();
  const active = activeState(ledger);
  for (const e of ledger) {
    if (!e.agentId) continue;
    let t = totals.get(e.agentId);
    if (!t) totals.set(e.agentId, t = structuredClone(ZERO_SCORES));
    if (!e.score) t.neutral += e.corrects ? 0 : active.get(e.id) !== false ? 1 : 0;
    else {
      t[e.score].points += e.points;
      if (!e.corrects && active.get(e.id) !== false) t[e.score].events++;
    }
  }
  return totals;
}
