// Comparable outcomes from recorded attempts; worker evidence never proves a code outcome.
import { findingClassification } from './lessons.ts';
import type { EvaluationMetric, EvaluationObservation, EvaluationReport, EvaluationResult, QaOutcomeView, RunAttemptView } from './types.ts';

export const EVALUATION_METRICS: EvaluationMetric[] = ['firstPassQa', 'verifiedRepair', 'workerBlocked'];

const codeFindings = (o: QaOutcomeView) => o.revision === 'exact' && o.verdict === 'fail'
  ? o.findings.filter((f) => f.confirmed && findingClassification(o, f.id) === 'code') : [];
const workerFinding = (o: QaOutcomeView) => o.findings.some((f) => findingClassification(o, f.id) === 'worker');

function codeResult(o: QaOutcomeView | undefined, sha: string | null): EvaluationResult {
  if (!o || !sha || o.headSha !== sha || o.revision !== 'exact') return 'unknown';
  if (codeFindings(o).length) return 'no';
  if (o.verdict === 'incomplete' || workerFinding(o)) return 'incomplete';
  return o.verdict === 'pass' ? 'yes' : 'unknown';
}

/** An attempt's measured outcomes, with exact-revision references and no raw logs or commands. */
export function observeAttempt(x: RunAttemptView, allOutcomes: QaOutcomeView[]): EvaluationObservation {
  const outcomes = allOutcomes.filter((o) => o.repoId === x.repoId && x.prNumber !== null && o.prNumber === x.prNumber)
    .sort((a, b) => a.startedAt - b.startedAt || a.finishedAt - b.finishedAt || a.id.localeCompare(b.id));
  const evidence = new Map<string, QaOutcomeView>();
  const use = (o: QaOutcomeView | undefined) => { if (o) evidence.set(o.id, o); return o; };
  let firstPassQa: EvaluationResult = 'not-applicable';
  let verifiedRepair: EvaluationResult = 'not-applicable';
  if (x.task === 'issue' || x.task === 'prototype') {
    const first = use(outcomes.find((o) => o.startedAt >= x.times.assignedAt));
    firstPassQa = first && first.round !== 1 ? 'unknown' : codeResult(first, x.revisions.submitted);
    if (!first && !x.outcome) firstPassQa = 'incomplete';
  }
  if (x.task === 'fix') {
    const before = outcomes.filter((o) => o.headSha === x.revisions.start && o.finishedAt <= x.times.assignedAt && o.revision === 'exact').at(-1);
    use(before);
    const keys = new Set(before ? codeFindings(before).map((f) => f.key) : []);
    verifiedRepair = !x.outcome ? 'incomplete' : 'unknown';
    if (keys.size) {
      const later = outcomes.filter((o) => !!x.revisions.submitted && o.headSha === x.revisions.submitted &&
        x.times.endedAt !== null && o.startedAt >= x.times.endedAt && o.reviewer.agentId !== x.agent.id && o.revision === 'exact');
      later.forEach(use);
      const after = later.at(-1);
      if (after) {
        if (codeFindings(after).some((f) => keys.has(f.key))) verifiedRepair = 'no';
        else if (codeResult(after, x.revisions.submitted) === 'yes' && x.revisions.start !== x.revisions.submitted) verifiedRepair = 'yes';
        else verifiedRepair = codeResult(after, x.revisions.submitted) === 'incomplete' ? 'incomplete' : 'unknown';
      } else if (x.outcome?.result === 'no-change') verifiedRepair = 'no';
    }
  }
  const own = outcomes.filter((o) => o.attemptId === x.id);
  own.forEach(use);
  // Pressure alone is context. A recorded worker outcome or finding is evidence of a blocked attempt.
  const workerBlocked: EvaluationResult = x.outcome?.cause === 'worker' || [...evidence.values()].some((o) => o.startedAt >= x.times.assignedAt && workerFinding(o)) ? 'yes'
    : !x.outcome ? 'incomplete' : x.outcome.cause === 'unknown' ? 'unknown' : 'no';
  return {
    attemptId: x.id, repoId: x.repoId, specialty: x.specialty, task: x.task, prNumber: x.prNumber,
    runtime: structuredClone(x.runtime), worker: structuredClone(x.worker), revisions: { ...x.revisions }, result: x.outcome?.result ?? null, cause: x.outcome?.cause ?? null,
    metrics: { firstPassQa, verifiedRepair, workerBlocked },
    evidence: [...evidence.values()].map((o) => ({ outcomeId: o.id, sha: o.headSha, revision: o.revision, verdict: o.verdict,
      worker: { box: o.worker.boxId, health: o.worker.telemetry ? { status: o.worker.telemetry.status,
        constraints: [...o.worker.telemetry.constraints], cpuPercent: o.worker.telemetry.cpuAveragePercent } : null },
      url: o.commentUrl, summary: o.summary })),
  };
}

/** Stable cohorts hold repository, specialty, task, requested runtime and worker conditions constant. */
export function evaluationContext(x: Pick<EvaluationObservation, 'repoId' | 'specialty' | 'task' | 'runtime' | 'worker'>, includePlaybook = true): string {
  const health = (h: RunAttemptView['worker']['healthAtStart']) => h ? [h.status, [...h.constraints].sort()] : null;
  return JSON.stringify([x.repoId, x.specialty, x.task, x.runtime.cli, x.runtime.model, x.runtime.effort,
    includePlaybook ? x.runtime.playbook : null, x.runtime.office, x.worker.box, health(x.worker.healthAtStart), health(x.worker.healthAtEnd)]);
}

/** Counts include unknown and incomplete evidence separately; only yes/no enter a rate's denominator. */
export function evaluationReport(attempts: RunAttemptView[], outcomes: QaOutcomeView[], filter: { repoId: string; specialty: string | null; basePlaybook: string; candidatePlaybook: string }, now: number): EvaluationReport {
  const observations = attempts.filter((x) => x.repoId === filter.repoId && (filter.specialty === null || x.specialty === filter.specialty) &&
    (x.runtime.playbook === filter.basePlaybook || x.runtime.playbook === filter.candidatePlaybook)).map((x) => observeAttempt(x, outcomes));
  const groups = new Map<string, EvaluationReport['cohorts'][number]>();
  for (const x of observations) {
    const key = evaluationContext(x);
    let group = groups.get(key);
    if (!group) {
      const counts = () => ({ yes: 0, no: 0, incomplete: 0, unknown: 0, 'not-applicable': 0, numerator: 0, denominator: 0 });
      group = { context: { repoId: x.repoId, specialty: x.specialty, task: x.task, runtime: x.runtime, worker: x.worker },
        attempts: 0, smallSample: true, metrics: { firstPassQa: counts(), verifiedRepair: counts(), workerBlocked: counts() } };
      groups.set(key, group);
    }
    group.attempts++;
    group.smallSample = group.attempts < 5;
    for (const metric of EVALUATION_METRICS) {
      const count = group.metrics[metric];
      count[x.metrics[metric]]++;
      count.numerator = count.yes;
      count.denominator = count.yes + count.no;
    }
  }
  return { format: 'cubefarm-evaluation-report', version: 1, generatedAt: now, basePlaybook: filter.basePlaybook,
    candidatePlaybook: filter.candidatePlaybook, observations, cohorts: [...groups.values()].sort((a, b) => evaluationContext(a.context).localeCompare(evaluationContext(b.context))) };
}
