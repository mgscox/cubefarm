// Reviewed lessons (docs/lessons.md): review status, what maintainers and evaluations may see, and recurring findings.
import type { LessonExport, LessonKind, LessonReviewAction, LessonSource, LessonVersion, LessonView, QaClassification, QaOutcomeView, RunAttemptView } from './types.ts';

export type LessonStatus = 'draft' | 'needs-revision' | 'approved' | 'rejected' | 'superseded';

const STATUS: Record<LessonReviewAction, LessonStatus> = {
  drafted: 'draft', revised: 'draft', approved: 'approved', 'revision-requested': 'needs-revision', rejected: 'rejected', superseded: 'superseded',
};

/** A version's status is its latest review. */
export function versionStatus(lesson: LessonView, version: number): LessonStatus {
  const last = lesson.reviews.findLast((r) => r.version === version);
  return last ? STATUS[last.action] : 'draft';
}

/** The lesson's status: its latest version's. */
export function lessonStatus(lesson: LessonView): LessonStatus {
  return versionStatus(lesson, lesson.versions.at(-1)?.version ?? 0);
}

/** The approved version that still applies, if any: approving a newer version supersedes it. */
export function approvedVersion(lesson: LessonView): LessonExport['lessons'][number] | null {
  for (let i = lesson.versions.length - 1; i >= 0; i--) {
    const v = lesson.versions[i];
    if (versionStatus(lesson, v.version) !== 'approved') continue;
    const review = lesson.reviews.findLast((r) => r.version === v.version && r.action === 'approved')!;
    return { ...v, id: lesson.id, repoId: lesson.repoId, approvedAt: review.at, approvedBy: review.actor };
  }
  return null;
}

/** Retired: its approved version was superseded with nothing approved since. A retired lesson doesn't come back. */
export function lessonRetired(lesson: LessonView): boolean {
  return !approvedVersion(lesson) && lesson.reviews.some((r) => r.action === 'superseded');
}

/** A new version can be drafted unless the lesson is retired or was rejected with no approved version to improve on. */
export function canRevise(lesson: LessonView): boolean {
  return !lessonRetired(lesson) && (lessonStatus(lesson) !== 'rejected' || !!approvedVersion(lesson));
}

/** Approved, applicable versions, newest approval first. A lesson for every specialty applies to each one. */
export function lessonExport(lessons: LessonView[], filter: { repoId?: string | null; specialty?: string | null }, now: number): LessonExport {
  const repoId = filter.repoId || null;
  const specialty = filter.specialty || null;
  return {
    format: 'cubefarm-lessons',
    version: 1,
    generatedAt: now,
    filter: { repoId, specialty },
    lessons: lessons
      .filter((l) => !repoId || l.repoId === repoId)
      .map(approvedVersion)
      .filter((v): v is NonNullable<typeof v> => !!v && (!specialty || v.specialty === null || v.specialty === specialty))
      .sort((x, y) => y.approvedAt - x.approvedAt),
  };
}

/** A finding's classification after its latest correction. */
export function findingClassification(outcome: QaOutcomeView, findingId: string): QaClassification | null {
  const finding = outcome.findings.find((f) => f.id === findingId);
  if (!finding) return null;
  return outcome.corrections.findLast((c) => c.findingId === findingId)?.classification ?? finding.classification;
}

/** Which kind of lesson a finding can support: confirmed code defects agent guidance, worker failures operational. */
export function findingSupports(outcome: QaOutcomeView, findingId: string): LessonKind | null {
  const finding = outcome.findings.find((f) => f.id === findingId);
  const classification = findingClassification(outcome, findingId);
  if (classification === 'worker') return 'operational';
  return classification === 'code' && finding?.confirmed ? 'agent' : null;
}

/** The same finding key on more than one PR, which no lesson cites yet, with the latest passing re-review as its fix. */
export interface LessonSuggestion {
  repoId: string;
  key: string;
  check: string;
  kind: LessonKind;
  findings: { qaOutcomeId: string; findingId: string; prNumber: number; sha: string | null }[];
  fix: { qaOutcomeId: string; prNumber: number; sha: string | null } | null;
}

export function recurringFindings(outcomes: QaOutcomeView[], lessons: LessonView[]): LessonSuggestion[] {
  const cited = new Set(lessons.flatMap((l) => l.versions.flatMap((v) => v.sources.filter((s) => s.kind === 'finding').map((s) => s.ref))));
  const groups = new Map<string, LessonSuggestion>();
  for (const o of outcomes) {
    for (const f of o.findings) {
      const kind = findingSupports(o, f.id);
      if (!kind || cited.has(f.id)) continue;
      const id = JSON.stringify([o.repoId, kind, f.key]);
      const group = groups.get(id) ?? { repoId: o.repoId, key: f.key, check: f.check, kind, findings: [], fix: null };
      group.findings.push({ qaOutcomeId: o.id, findingId: f.id, prNumber: o.prNumber, sha: o.headSha });
      groups.set(id, group);
    }
  }
  return [...groups.values()].filter((g) => new Set(g.findings.map((f) => f.prNumber)).size > 1).map((g) => {
    const seen = outcomes.filter((o) => g.findings.some((f) => f.qaOutcomeId === o.id));
    const fix = outcomes.filter((o) => o.verdict === 'pass' && o.repoId === g.repoId &&
      seen.some((s) => s.prNumber === o.prNumber && s.finishedAt <= o.finishedAt)).sort((x, y) => y.finishedAt - x.finishedAt)[0];
    return { ...g, fix: fix ? { qaOutcomeId: fix.id, prNumber: fix.prNumber, sha: fix.headSha } : null };
  });
}

/** The revisions a version cites, in order and without repeats. */
export function lessonRevisions(v: Pick<LessonVersion, 'sources' | 'verification'>): string[] {
  return [...new Set([...v.sources, v.verification.evidence].map((s) => s.sha).filter((sha): sha is string => !!sha))];
}

/** Whether the record behind a source is still held here; a link's external artifact can't be checked. */
export function sourceHeld(s: LessonSource, outcomes: QaOutcomeView[], attempts: RunAttemptView[]): boolean {
  if (s.kind === 'link') return true;
  if (s.qaOutcomeId) return outcomes.some((o) => o.id === s.qaOutcomeId && (s.kind !== 'finding' || o.findings.some((f) => f.id === s.ref)));
  return attempts.some((x) => x.id === s.ref);
}
