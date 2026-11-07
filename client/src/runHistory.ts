// Labels for the run history view: a measurement the office doesn't have reads as unknown, never as zero.
import type { RunHistoryExport } from '../../shared/types';

type Row = RunHistoryExport['attempts'][number];

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function cost(usd: number | null): string {
  return usd === null ? 'unknown' : `$${usd.toFixed(2)}`;
}

export function workLabel(x: Pick<Row, 'issueNumber' | 'prNumber' | 'prState'>): string {
  const pr = x.prNumber === null ? '' : `PR #${x.prNumber}${x.prState && x.prState !== 'OPEN' ? ` (${x.prState.toLowerCase()})` : ''}`;
  return [x.issueNumber === null ? '' : `#${x.issueNumber}`, pr].filter(Boolean).join(' · ') || '—';
}

export function outcomeLabel(x: Pick<Row, 'outcome' | 'times'>): string {
  if (x.outcome) return `${x.outcome.result} · ${x.outcome.cause}`;
  return x.times.startedAt === null ? 'pending' : 'running';
}

export function runtimeLabel(x: Pick<Row, 'runtime'>): string {
  const { cli, model, effort } = x.runtime;
  return cli ? [cli, model ?? 'CLI default model', effort].filter(Boolean).join(' · ') : 'not started';
}
