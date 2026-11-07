// Labels and draft inputs for the lessons panel (docs/lessons.md).
import type { LessonSource, LessonVersion, QaOutcomeView, RunAttemptView } from '../../shared/types';
import type { LessonStatus, LessonSuggestion } from '../../shared/lessons';
import type { LessonInput } from './api';

export const STATUS_LABEL: Record<LessonStatus, string> = {
  draft: 'Waiting for review', 'needs-revision': 'Sent back for revision', approved: 'Approved', rejected: 'Rejected', superseded: 'Superseded',
};

export function kindLabel(kind: LessonVersion['kind']): string {
  return kind === 'operational' ? 'Operational' : 'Agent guidance';
}

export function sourceLabel(s: LessonSource): string {
  const what = s.kind === 'finding' ? `${s.classification ?? 'unknown'} finding` : s.kind === 'attempt' ? s.qaOutcomeId ? 'QA review' : 'attempt' : 'link';
  return [what, s.prNumber === null ? '' : `PR #${s.prNumber}`, s.sha ? s.sha.slice(0, 7) : ''].filter(Boolean).join(' · ');
}

/** A draft for a recurring finding: its findings as sources and, if one passed since, the re-review that verified the fix. */
export function suggestionInput(s: LessonSuggestion, attempts: RunAttemptView[]): LessonInput {
  const prs = [...new Set(s.findings.map((f) => f.prNumber))];
  const specialty = attempts.find((x) => x.repoId === s.repoId && x.specialty && prs.includes(x.prNumber ?? -1))?.specialty ?? null;
  return {
    kind: s.kind,
    specialty,
    title: s.check,
    guidance: '',
    sources: s.findings.map((f) => ({ qaOutcomeId: f.qaOutcomeId, findingId: f.findingId })),
    verification: { kind: 'fix', ...(s.fix && { qaOutcomeId: s.fix.qaOutcomeId }) },
  };
}

/** A version back as the links it was drafted from, to revise it. */
export function versionInput(v: LessonVersion): LessonInput {
  const e = v.verification.evidence;
  return {
    kind: v.kind,
    specialty: v.specialty,
    title: v.title,
    guidance: v.guidance,
    sources: v.sources.map((s) => s.kind === 'finding' ? { qaOutcomeId: s.qaOutcomeId ?? '', findingId: s.ref } : s.kind === 'attempt' ? { attemptId: s.ref } : { url: s.ref, summary: s.summary }),
    verification: { kind: v.verification.kind, ...(v.verification.test && { test: v.verification.test }), ...(e.qaOutcomeId ? { qaOutcomeId: e.qaOutcomeId } : { attemptId: e.ref }) },
  };
}

/** What can verify a fix on this floor, newest first: passing QA reviews and attempts that passed QA, repaired or delivered. */
export function verificationOptions(repoId: string, outcomes: QaOutcomeView[], attempts: RunAttemptView[], limit = 30): { value: string; label: string; at: number }[] {
  const reviews = outcomes.filter((o) => o.repoId === repoId && o.verdict === 'pass')
    .map((o) => ({ value: `qa:${o.id}`, label: `PR #${o.prNumber} QA round ${o.round} passed${o.headSha ? ` at ${o.headSha.slice(0, 7)}` : ''}`, at: o.finishedAt }));
  // A passing QA review and its attempt are one run: list it once, as the review.
  const reviewed = new Set(outcomes.filter((o) => o.repoId === repoId && o.verdict === 'pass').map((o) => o.attemptId));
  const runs = attempts.filter((x) => x.repoId === repoId && x.outcome && ['qa-passed', 'repaired', 'delivered'].includes(x.outcome.result) && !reviewed.has(x.id))
    .map((x) => ({ value: `attempt:${x.id}`, label: `${x.task} ${x.prNumber === null ? `#${x.issueNumber}` : `PR #${x.prNumber}`} ${x.outcome!.result} (${x.agent.name})`, at: x.times.endedAt ?? x.times.assignedAt }));
  return [...reviews, ...runs].sort((x, y) => y.at - x.at).slice(0, limit);
}
