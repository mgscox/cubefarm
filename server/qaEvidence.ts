// Revision-pinned QA facts and score eligibility, independent of merge/retry policy.
import crypto from 'node:crypto';
import { RESOURCE_STALE_MS, type MachineTelemetry, type PrContributionView, type QaCheck, type QaOutcomeView } from '../shared/types.ts';

export function workerSnapshot(boxId: string | null, telemetry: MachineTelemetry | null, startedAt: number, finishedAt: number): QaOutcomeView['worker'] {
  if (!telemetry || telemetry.sample.at < startedAt || finishedAt - telemetry.sample.at > RESOURCE_STALE_MS || telemetry.sample.at > finishedAt) {
    return { boxId, from: null, to: null, telemetry: null };
  }
  const seconds = Math.min(60, telemetry.observedSeconds, (telemetry.sample.at - startedAt) / 1000);
  // Do not claim a pre-session baseline describes pressure throughout this QA attempt.
  const captured = structuredClone(telemetry);
  if (seconds < telemetry.observedSeconds) {
    captured.status = 'unknown';
    captured.constraints = [];
    captured.cpuAveragePercent = null;
    captured.summary = 'Partial QA observation window';
    captured.evidence = 'The monitor baseline began before this attempt; only the latest sample is retained.';
  }
  captured.observedSeconds = seconds;
  return { boxId, from: telemetry.sample.at - seconds * 1000, to: telemetry.sample.at, telemetry: captured };
}

export function qaFindings(checks: QaCheck[], headSha: string | null, baseSha: string | null, history: PrContributionView | undefined, previous: QaOutcomeView[]): QaOutcomeView['findings'] {
  return checks.filter((c) => c.result !== 'pass').map((c) => {
    const key = c.findingKey?.trim() || c.name.trim().toLowerCase();
    const old = headSha ? previous.filter((o) => o.headSha === headSha && o.baseSha === baseSha).flatMap((o) => o.findings).find((f) => f.key === key) : undefined;
    const contribution = c.introducedBySha && history ? [history.original, ...history.repairs.filter((r) => r.finishedAt != null && r.submittedSha !== r.startingSha)]
      .find((p) => p?.submittedSha === c.introducedBySha) : null;
    return {
      id: old?.id ?? crypto.randomUUID(), key, check: c.name,
      classification: c.failureKind === 'environment' ? 'worker' as const : c.failureKind === 'code' ? 'code' as const : 'inconclusive' as const,
      evidence: c.details, confirmed: c.confirmed === true && c.result === 'fail' && c.details.trim().length > 0,
      attributableTo: contribution ? { agentId: contribution.agentId, submittedSha: contribution.submittedSha! } : null,
    };
  });
}
