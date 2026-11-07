import { describe, expect, it } from 'vitest';
import { machineHealth } from './machineHealth.ts';
import { qaFindings, workerSnapshot } from './qaEvidence.ts';
import { scoringFindings } from '../shared/qaEvidence.ts';
import type { MachineSample, PrContributionView, QaCheck, QaOutcomeView } from '../shared/types.ts';

const history: PrContributionView = { repoId: 'r1', prNumber: 13, title: 'Feature', url: '', state: 'OPEN',
  original: { agentId: 'ada', name: 'Ada', submittedSha: 'head-1', at: 1 }, repairs: [] };
const defect: QaCheck = { name: 'Feature', findingKey: 'missing-button', result: 'fail', failureKind: 'code', confirmed: true,
  introducedBySha: 'head-1', details: 'Head loses the button; the same reproduction passes at base.' };
const outcome = (checks: QaCheck[]): QaOutcomeView => ({
  id: 'attempt', attemptId: 'attempt', reviewId: 'cycle', round: 1, repoId: 'r1', prNumber: 13,
  reviewer: { agentId: 'qa', name: 'Grace' }, startedAt: 0, finishedAt: 100, headSha: 'head-1', baseSha: 'base-1',
  revision: 'exact', classification: 'mixed', observed: { headSha: 'head-1', baseSha: 'base-1', at: 100 }, verdict: 'fail', summary: 'Checked',
  checks, commands: [], findings: qaFindings(checks, 'head-1', 'base-1', history, []), worker: workerSnapshot(null, null, 0, 100),
  terminalReason: null, ci: null, commentUrl: null, corrections: [],
});

describe('revision-pinned QA evidence', () => {
  it('keeps worker and unknown failures neutral, including in mixed reports', () => {
    const evidence = outcome([defect,
      { name: 'Suite', result: 'fail', failureKind: 'environment', confirmed: true, details: 'Worker exited 137 (OOM).' },
      { name: 'Unexplained', result: 'fail', details: 'Timed out; cause not established.' },
      { ...defect, name: 'Suspected', confirmed: false },
      { ...defect, name: 'Unknown owner', introducedBySha: 'unverified' },
    ]);
    expect(evidence.findings.map((f) => f.classification)).toEqual(['code', 'worker', 'inconclusive', 'code', 'code']);
    expect(scoringFindings(evidence).map((f) => f.check)).toEqual(['Feature']);
    expect(scoringFindings({ ...evidence, revision: 'stale' })).toEqual([]);
    expect(scoringFindings({ ...evidence, revision: 'unknown' })).toEqual([]);
    expect(scoringFindings({ ...evidence, verdict: 'incomplete' })).toEqual([]);
  });

  it('reuses the same defect identity on an unchanged revision, even if the first outcome lacks it', () => {
    const first = outcome([defect]);
    const retry = qaFindings([{ ...defect, name: 'Renamed check', details: 'Confirmed again' }], 'head-1', 'base-1', history, [outcome([]), first]);
    expect(retry[0].id).toBe(first.findings[0].id);
    expect(qaFindings([defect], 'head-2', 'base-1', history, [first])[0].id).not.toBe(first.findings[0].id);
    expect(qaFindings([defect], null, null, history, [first])[0].id).not.toBe(first.findings[0].id);
  });

  it('does not attribute inherited defects to no-op or unfinished repairs', () => {
    const repair = { id: 'repair-1', agentId: 'repairer', name: 'Repairer', reason: 'qa' as const, startingSha: 'head-1', submittedSha: 'head-1',
      reviewId: 'review-1', round: 1, commentUrl: null, findings: 'Fix the button', startedAt: 1, finishedAt: 2 };
    for (const repairs of [[repair], [{ ...repair, startingSha: 'head-0', finishedAt: null }]]) {
      expect(qaFindings([defect], 'head-1', 'base-1', { ...history, original: null, repairs }, [])[0].attributableTo).toBeNull();
    }
    expect(qaFindings([defect], 'head-1', 'base-1', { ...history, original: null, repairs: [{ ...repair, startingSha: 'head-0' }] }, [])[0].attributableTo)
      .toEqual({ agentId: 'repairer', submittedSha: 'head-1' });
  });

  it('applies the latest linked correction without mutating the original classification', () => {
    const evidence = outcome([defect]);
    evidence.corrections.push({ id: 'c1', findingId: evidence.findings[0].id, previousCorrectionId: null, actor: 'manager', reason: 'Stable worker retry passed unchanged', classification: 'worker', at: 110 });
    expect(scoringFindings(evidence)).toEqual([]);
    expect(evidence.findings[0].classification).toBe('code');
  });

  it('retains at most a minute of fresh worker evidence and leaves unavailable signals unknown', () => {
    const sample: MachineSample = { at: 100_000, cpus: 4, cpuPercent: null, load1: null, memoryTotal: 100,
      memoryAvailable: null, memoryPressure: null, cpuStall: null, memoryStall: null, ioStall: null };
    const telemetry = machineHealth([{ ...sample, at: 40_000 }, sample]);
    const worker = workerSnapshot('box-1', telemetry, 30_000, 101_000);
    expect(worker).toMatchObject({ boxId: 'box-1', from: 40_000, to: 100_000, telemetry: { status: 'unknown', sample: { cpuPercent: null } } });
    expect(workerSnapshot('box-1', telemetry, 30_000, 121_000).telemetry).toBeNull();
    expect(workerSnapshot(null, telemetry, 100_001, 101_000).telemetry).toBeNull();
    expect(workerSnapshot(null, telemetry, 90_000, 101_000)).toMatchObject({ from: 90_000, telemetry: { observedSeconds: 10, status: 'unknown', cpuAveragePercent: null } });
    expect(telemetry.observedSeconds).toBe(60);
  });
});
