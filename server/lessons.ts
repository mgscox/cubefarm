// Drafting and reviewing lessons: input checks, source links with redacted summaries, and the review history.
import crypto from 'node:crypto';
import type { LessonKind, LessonSource, LessonVersion, LessonView, QaOutcomeView, RunAttemptView, RunResult } from '../shared/types.ts';
import { findingClassification, findingSupports, lessonRevisions, lessonRetired, lessonStatus, approvedVersion, canRevise } from '../shared/lessons.ts';
import { HttpError } from './httpError.ts';
import { redact } from './runHistory.ts';

export const LESSON_LIMITS = { title: 120, guidance: 2000, sources: 20, reason: 2000, test: 200 } as const;

/** What the office holds that a lesson can link to. */
export interface LessonEvidence {
  repoId: string;
  outcomes: QaOutcomeView[];
  attempts: RunAttemptView[];
  /** The version being revised: its sources stand in for records pruned since, with their summaries. */
  kept?: LessonSource[];
}

const VERIFYING: RunResult[] = ['qa-passed', 'repaired', 'delivered'];
const SECRET_PARAM = /token|secret|passw|api[_-]?key|access[_-]?key|signature|^sig$|^code$|^auth(orization)?$/i;

function text(value: unknown, name: string, max: number, required = true): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return '';
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, `${name} must be text of at most ${max} characters`);
  return value.trim();
}

function summary(value: string): string {
  return redact(value) ?? 'No summary recorded.';
}

/** One source link, resolved against the office's evidence: never the raw evidence, only its redacted summary. */
function source(ref: unknown, kind: LessonKind, ev: LessonEvidence): LessonSource {
  const r = (ref ?? {}) as { qaOutcomeId?: unknown; findingId?: unknown; attemptId?: unknown; url?: unknown; summary?: unknown };
  const kept = ev.kept?.find((s) => s.ref === (r.findingId ?? r.attemptId) && (s.kind === 'finding') === (typeof r.findingId === 'string'));
  if (typeof r.findingId === 'string') {
    const outcome = ev.outcomes.find((o) => o.id === r.qaOutcomeId && o.repoId === ev.repoId);
    const finding = outcome?.findings.find((f) => f.id === r.findingId);
    if ((!outcome || !finding) && kept && (kept.classification === 'worker' ? 'operational' : 'agent') === kind) return kept;
    if (!outcome || !finding) throw new HttpError(400, `Unknown finding ${r.findingId} on this floor`);
    const supports = findingSupports(outcome, finding.id);
    if (supports !== kind) {
      throw new HttpError(400, supports === 'operational' ? `Finding ${finding.key} is a worker failure: it can only support an operational lesson`
        : supports === 'agent' ? `Finding ${finding.key} is a code defect: it can only support an agent lesson`
        : `Finding ${finding.key} is not a confirmed code defect or a worker failure`);
    }
    return { kind: 'finding', ref: finding.id, qaOutcomeId: outcome.id, prNumber: outcome.prNumber, sha: outcome.headSha,
      classification: findingClassification(outcome, finding.id), url: outcome.commentUrl, summary: summary(`${finding.check}: ${finding.evidence}`) };
  }
  if (typeof r.attemptId === 'string') {
    const attempt = ev.attempts.find((x) => x.id === r.attemptId && x.repoId === ev.repoId);
    if (!attempt && kept) return kept;
    if (!attempt?.outcome) throw new HttpError(400, `Unknown or unfinished attempt ${r.attemptId} on this floor`);
    if (kind === 'agent' && (attempt.outcome.cause === 'worker' || attempt.outcome.cause === 'provider')) {
      throw new HttpError(400, `Attempt ${attempt.id} ended on a ${attempt.outcome.cause} problem: it can only support an operational lesson`);
    }
    const work = [attempt.issueNumber && `#${attempt.issueNumber}`, attempt.prNumber && `PR #${attempt.prNumber}`].filter(Boolean).join(' ');
    return { kind: 'attempt', ref: attempt.id, qaOutcomeId: null, prNumber: attempt.prNumber, sha: attempt.revisions.submitted ?? attempt.revisions.start,
      classification: null, url: null, summary: summary(`${attempt.task} ${work}: ${attempt.outcome.result} (${attempt.outcome.cause})${attempt.outcome.excerpt ? ` ${attempt.outcome.excerpt}` : ''}`) };
  }
  if (typeof r.url === 'string') {
    let url: URL;
    try { url = new URL(r.url); } catch { throw new HttpError(400, 'A link source needs an http(s) URL'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'A link source needs an http(s) URL');
    if (url.username || url.password || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some((k) => SECRET_PARAM.test(k))) {
      throw new HttpError(400, 'A link source must not carry credentials in its URL');
    }
    return { kind: 'link', ref: url.href, qaOutcomeId: null, prNumber: null, sha: null, classification: null, url: url.href,
      summary: summary(text(r.summary, 'A link source summary', LESSON_LIMITS.guidance)) };
  }
  throw new HttpError(400, 'A source is a finding (qaOutcomeId and findingId), an attempt (attemptId) or a link (url and summary)');
}

/** The passing review or finished attempt that verified the fix. */
function verifiedBy(ref: unknown, ev: LessonEvidence): LessonSource {
  const r = (ref ?? {}) as { qaOutcomeId?: unknown; attemptId?: unknown };
  if (typeof r.qaOutcomeId === 'string') {
    const o = ev.outcomes.find((x) => x.id === r.qaOutcomeId && x.repoId === ev.repoId);
    const kept = ev.kept?.find((s) => s.qaOutcomeId === r.qaOutcomeId && s.kind === 'attempt');
    if (!o && kept) return kept;
    if (!o) throw new HttpError(400, `Unknown QA outcome ${r.qaOutcomeId} on this floor`);
    if (o.verdict !== 'pass') throw new HttpError(400, `QA outcome ${o.id} did not pass, so it can't verify a fix`);
    return { kind: 'attempt', ref: o.attemptId, qaOutcomeId: o.id, prNumber: o.prNumber, sha: o.headSha, classification: null,
      url: o.commentUrl, summary: summary(`PR #${o.prNumber} QA round ${o.round} passed: ${o.summary}`) };
  }
  if (typeof r.attemptId === 'string') {
    const x = ev.attempts.find((a) => a.id === r.attemptId && a.repoId === ev.repoId);
    const kept = ev.kept?.find((s) => s.kind === 'attempt' && s.qaOutcomeId === null && s.ref === r.attemptId);
    if (!x && kept) return kept;
    if (!x?.outcome || !VERIFYING.includes(x.outcome.result)) throw new HttpError(400, `Attempt ${r.attemptId} did not pass QA, repair or deliver, so it can't verify a fix`);
    return source({ attemptId: x.id }, 'operational', ev);
  }
  throw new HttpError(400, 'Verification needs the passing QA outcome (qaOutcomeId) or attempt (attemptId) that verified it');
}

/** A new version from a request body, checked against the floor's evidence. */
export function lessonVersion(input: unknown, ev: LessonEvidence, meta: { version: number; author: string; at: number }): LessonVersion {
  const body = (input ?? {}) as Record<string, unknown>;
  const kind = body.kind;
  if (kind !== 'agent' && kind !== 'operational') throw new HttpError(400, 'kind must be agent or operational');
  const specialty = body.specialty === null || body.specialty === undefined || body.specialty === '' ? null : text(body.specialty, 'specialty', 40);
  if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > LESSON_LIMITS.sources) {
    throw new HttpError(400, `A lesson needs 1 to ${LESSON_LIMITS.sources} sources`);
  }
  const sources = body.sources.map((s) => source(s, kind, ev)).filter((s, i, all) => all.findIndex((t) => t.kind === s.kind && t.ref === s.ref) === i);
  const v = (body.verification ?? {}) as Record<string, unknown>;
  if (v.kind !== 'fix' && v.kind !== 'regression-test') throw new HttpError(400, 'verification.kind must be fix or regression-test');
  const verification = {
    kind: v.kind,
    test: v.kind === 'regression-test' ? text(v.test, 'The regression test', LESSON_LIMITS.test) : null,
    evidence: verifiedBy(v, ev),
  } as const;
  const version: LessonVersion = {
    version: meta.version,
    title: text(body.title, 'title', LESSON_LIMITS.title),
    guidance: text(body.guidance, 'guidance', LESSON_LIMITS.guidance),
    kind, specialty, sources, verification, revisions: [], author: meta.author, at: meta.at,
  };
  version.revisions = lessonRevisions(version);
  return version;
}

export function draftLesson(input: unknown, ev: LessonEvidence, author: string, at: number): LessonView {
  const id = crypto.randomUUID();
  const v = lessonVersion(input, ev, { version: 1, author, at });
  return { id, repoId: ev.repoId, versions: [v], reviews: [{ id: crypto.randomUUID(), version: 1, action: 'drafted', actor: author, reason: '', at }] };
}

/** A new draft version. An approved version keeps applying until the new one is approved. */
export function reviseLesson(lesson: LessonView, input: unknown, ev: LessonEvidence, author: string, at: number) {
  if (lessonRetired(lesson)) throw new HttpError(409, 'This lesson was superseded; draft a new lesson instead');
  if (!canRevise(lesson)) throw new HttpError(409, 'This lesson was rejected; draft a new lesson instead');
  const body = (input ?? {}) as Record<string, unknown>;
  const version = lesson.versions.at(-1)!.version + 1;
  const previous = lesson.versions.at(-1)!;
  const v = lessonVersion(input, { ...ev, kept: [...previous.sources, previous.verification.evidence] }, { version, author, at });
  lesson.versions.push(v);
  lesson.reviews.push({ id: crypto.randomUUID(), version, action: 'revised', actor: author, reason: text(body.reason, 'reason', LESSON_LIMITS.reason, false), at });
}

export type LessonDecision = 'approve' | 'request-revision' | 'reject' | 'supersede';

/** Records one review decision; approving a version supersedes the one approved before it. */
export function reviewLesson(lesson: LessonView, input: unknown, lessons: LessonView[], actor: string, at: number) {
  const body = (input ?? {}) as { action?: unknown; reason?: unknown; supersededBy?: unknown };
  const latest = lesson.versions.at(-1)!;
  const status = lessonStatus(lesson);
  const add = (version: number, action: LessonView['reviews'][number]['action'], reason: string, supersededBy?: string) =>
    lesson.reviews.push({ id: crypto.randomUUID(), version, action, actor, reason, at, ...(supersededBy && { supersededBy }) });
  switch (body.action) {
    case 'approve': {
      if (status !== 'draft') throw new HttpError(409, `Only a draft can be approved; version ${latest.version} is ${status}`);
      if (lessonRetired(lesson)) throw new HttpError(409, 'This lesson was superseded; draft a new lesson instead');
      const previous = approvedVersion(lesson);
      add(latest.version, 'approved', text(body.reason, 'reason', LESSON_LIMITS.reason, false));
      if (previous) add(previous.version, 'superseded', `Replaced by version ${latest.version}`);
      return;
    }
    case 'request-revision':
    case 'reject': {
      if (status !== 'draft' && status !== 'needs-revision') throw new HttpError(409, `Only a draft can be sent back or rejected; version ${latest.version} is ${status}`);
      add(latest.version, body.action === 'reject' ? 'rejected' : 'revision-requested', text(body.reason, 'reason', LESSON_LIMITS.reason));
      return;
    }
    case 'supersede': {
      const current = approvedVersion(lesson);
      if (!current) throw new HttpError(409, 'Only an approved lesson can be superseded');
      const by = body.supersededBy === undefined || body.supersededBy === null || body.supersededBy === '' ? undefined : String(body.supersededBy);
      if (by !== undefined && (by === lesson.id || !lessons.some((l) => l.id === by && l.repoId === lesson.repoId))) {
        throw new HttpError(400, 'supersededBy must be another lesson on this floor');
      }
      add(current.version, 'superseded', text(body.reason, 'reason', LESSON_LIMITS.reason), by);
      return;
    }
    default:
      throw new HttpError(400, 'action must be approve, request-revision, reject or supersede');
  }
}
