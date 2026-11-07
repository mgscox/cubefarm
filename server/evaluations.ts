// Validated, immutable pinned evaluations and point-in-time cohort reports for a manager's review.
import crypto from 'node:crypto';
import { EVALUATION_METRICS, evaluationContext, evaluationReport } from '../shared/evaluations.ts';
import { approvedVersion } from '../shared/lessons.ts';
import type { EvaluationMetric, EvaluationObservation, EvaluationResult, LessonView, PlaybookEvaluation, QaOutcomeView, RunAttemptView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';
import { evidenceUrl } from './lessons.ts';
import { redact } from './runHistory.ts';

export interface EvaluationEvidence { repoId: string; lessons: LessonView[]; attempts: RunAttemptView[]; outcomes: QaOutcomeView[] }

function text(value: unknown, name: string, max = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name} needs text of at most ${max} characters`);
  return value.trim();
}

/** Capture facts already observed in base/candidate runs. This never starts a paid agent or changes a playbook. */
export function createEvaluation(input: unknown, ev: EvaluationEvidence, at: number): PlaybookEvaluation {
  const body = (input ?? {}) as Record<string, unknown>;
  const lesson = ev.lessons.find((l) => l.id === body.lessonId && l.repoId === ev.repoId);
  const approved = lesson && approvedVersion(lesson);
  if (!approved) throw new HttpError(400, 'Choose an approved lesson on this floor');
  const basePlaybook = text(body.basePlaybook, 'basePlaybook', 120);
  const candidatePlaybook = text(body.candidatePlaybook, 'candidatePlaybook', 120);
  if (basePlaybook === candidatePlaybook || ![basePlaybook, candidatePlaybook].every((v) => /^.+@[a-f0-9]{12}$/.test(v))) {
    throw new HttpError(400, 'Choose distinct versioned base and candidate playbooks (name@12-character hash)');
  }
  if (!Array.isArray(body.cases) || !body.cases.length || body.cases.length > 20) throw new HttpError(400, 'Pin 1 to 20 cases');
  const report = evaluationReport(ev.attempts, ev.outcomes, { repoId: ev.repoId, specialty: approved.specialty, basePlaybook, candidatePlaybook }, at);
  // Links are never fetched: a missing/expired artifact cannot erase an exact-revision structured result.
  for (const o of report.observations) for (const e of o.evidence) {
    e.url = evidenceUrl(e.url);
    e.summary = redact(e.summary) ?? '';
  }
  const observation = (id: unknown, playbook: string): EvaluationObservation => {
    const o = report.observations.find((x) => x.attemptId === id && x.runtime.playbook === playbook);
    if (!o) throw new HttpError(400, `Pinned attempt must exist, match ${playbook}, and fall within the lesson's scope`);
    return o;
  };
  const match = (result: EvaluationResult, expected: boolean): EvaluationResult => !expected && (result === 'yes' || result === 'no') ? result === 'yes' ? 'no' : 'yes' : result;
  const cases = body.cases.map((value: unknown) => {
    const c = (value ?? {}) as Record<string, unknown>;
    if (!EVALUATION_METRICS.includes(c.metric as EvaluationMetric) || typeof c.expected !== 'boolean') throw new HttpError(400, 'A case needs a metric and boolean expected value');
    const metric = c.metric as EvaluationMetric;
    const base = observation(c.baseAttemptId, basePlaybook);
    const candidate = observation(c.candidateAttemptId, candidatePlaybook);
    if (base.metrics[metric] === 'not-applicable' || candidate.metrics[metric] === 'not-applicable') throw new HttpError(400, 'The pinned metric must apply to both attempts');
    return { id: text(c.id, 'Case id', 120), expectedBehavior: redact(text(c.expectedBehavior, 'Expected behavior')) ?? '', metric, expected: c.expected,
      base, candidate, baseResult: match(base.metrics[metric], c.expected), candidateResult: match(candidate.metrics[metric], c.expected),
      comparable: evaluationContext(base, false) === evaluationContext(candidate, false) };
  });
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new HttpError(400, 'Pinned case ids must be unique');
  return structuredClone({ id: crypto.randomUUID(), repoId: ev.repoId, at, lesson: approved, cases, report });
}
