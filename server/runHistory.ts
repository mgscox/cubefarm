// The run history: every attempt at an issue or PR, kept in its own file so QA cleanup and restarts leave it intact.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentStatus, MachineTelemetry, PullInfo, QaStatus, RunAttemptView, RunCause, RunHealth, RunHistoryExport, RunResult } from '../shared/types.ts';

/** Retention: running attempts are always kept; others go after maxAgeDays, then the oldest ended ones beyond maxAttempts. */
export const RUN_HISTORY_LIMITS = { maxAttempts: 5000, maxAgeDays: 180, excerptChars: 240 } as const;

type Outcome = NonNullable<RunAttemptView['outcome']>;

const SECRETS: [RegExp, string][] = [
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]'],
  [/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@'], // credentials in a URL
  [/\b(?![0-9a-f]{40}\b)[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]'], // long opaque tokens, but not commit SHAs
];

/** A short, one-line excerpt with secret-looking values removed. Undefined for empty text. */
export function redact(text: string | null | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  let out = text.replace(/\s+/g, ' ').trim();
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  const max = RUN_HISTORY_LIMITS.excerptChars;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Who an error points at, where its text gives evidence; the agent's own work otherwise. */
export function errorCause(text: string | null | undefined): RunCause {
  const t = text ?? '';
  if (/stopped by (the )?manager|interrupted in the terminal|let go/i.test(t)) return 'manager';
  if (/usage limit|rate.?limit|overloaded|quota|credit balance|\b(429|500|502|503|529)\b|api error|authenticat|unauthori[sz]ed/i.test(t)) return 'provider';
  if (/ENOSPC|ENOMEM|no space left|out of memory|ECONN|ETIMEDOUT|EHOSTUNREACH|EPIPE|ssh|box|desk|worktree|never started|session recovery|could not (check|reconnect)/i.test(t)) return 'worker';
  return t ? 'agent' : 'unknown';
}

/** What the office knew when a session finished and its task's handler had run. */
export interface FinishedState {
  task: RunAttemptView['task'];
  result: { ok: boolean; startupFailed?: boolean; recoveryFailed?: boolean };
  status: AgentStatus;
  lastError: string | null;
  prNumber: number | null; // an issue task's verified PR
  qa?: { status: QaStatus; ciRequired: boolean; failedTested: boolean } | null;
}

/** How an attempt ended when its session finished, from the state the handlers left. */
export function finishedOutcome(s: FinishedState): Outcome {
  const excerpt = redact(s.lastError);
  const failed = (result: RunResult, cause: RunCause): Outcome => ({ result, cause, ...(excerpt && { excerpt }) });
  if (s.result.recoveryFailed) return failed('failed', 'worker');
  if (s.result.startupFailed && !s.result.ok && s.status !== 'stopped') return failed('start-failed', 'worker');
  if (s.status === 'stopped') return failed('stopped', errorCause(s.lastError) === 'manager' ? 'manager' : 'unknown');
  if (s.task === 'fix' && s.status === 'error' && /no new commits/i.test(s.lastError ?? '')) return failed('no-change', 'agent');
  if (s.task === 'qa' && s.qa) {
    if (s.qa.status === 'passed') return s.qa.ciRequired
      ? { result: 'worker-blocked', cause: 'worker', excerpt: 'Local validation was blocked by the worker; merge waits for CI.' }
      : { result: 'qa-passed', cause: 'agent' };
    if (s.qa.status === 'failed' || s.qa.status === 'fixing' || (s.qa.status === 'needs-human' && s.qa.failedTested)) return { result: 'qa-failed', cause: 'agent' };
  }
  if (s.status === 'error') return failed('failed', errorCause(s.lastError));
  if (s.task === 'fix') return { result: 'repaired', cause: 'agent' };
  if (s.task !== 'qa') return s.prNumber ? { result: 'delivered', cause: 'agent' } : { result: 'no-pr', cause: 'agent' };
  return { result: 'completed', cause: 'agent', ...(excerpt && { excerpt }) };
}

/** A session's usage folded into the attempt's: one unreported cost makes the total unknown, not zero. */
export function addUsage(usage: RunAttemptView['usage'], session: { costUsd: number; turns: number; costReported?: boolean }): RunAttemptView['usage'] {
  const first = usage.sessions === 0;
  const cost = session.costReported === false || !Number.isFinite(session.costUsd) ? null : session.costUsd;
  const turns = Number.isFinite(session.turns) ? session.turns : null;
  return {
    sessions: usage.sessions + 1,
    costUsd: cost === null || (!first && usage.costUsd === null) ? null : Math.round(((first ? 0 : usage.costUsd!) + cost) * 10_000) / 10_000,
    turns: turns === null || (!first && usage.turns === null) ? null : (first ? 0 : usage.turns!) + turns,
  };
}

export function compactHealth(t: MachineTelemetry | null | undefined): RunHealth | null {
  if (!t) return null;
  return { status: t.status, constraints: [...t.constraints], cpuPercent: t.cpuAveragePercent == null ? null : Math.round(t.cpuAveragePercent) };
}

/** A playbook's version: its name and a hash of the text the agent was given. */
export function playbookVersion(name: string, text: string): string | null {
  return text ? `${name}@${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}` : null;
}

/**
 * Keep every started attempt still open; drop ended ones (and waits that never started) past the age limit, then the
 * oldest ended ones past the count limit.
 */
export function pruneAttempts(attempts: RunAttemptView[], now: number, limits: { maxAttempts: number; maxAgeDays: number } = RUN_HISTORY_LIMITS): RunAttemptView[] {
  const oldest = now - limits.maxAgeDays * 86_400_000;
  const kept = attempts.filter((x) => (!x.outcome && x.times.startedAt !== null) || (x.times.endedAt ?? x.times.assignedAt) >= oldest);
  const excess = kept.length - limits.maxAttempts;
  if (excess <= 0) return kept;
  const drop = new Set(kept.filter((x) => x.outcome).sort((x, y) => x.times.assignedAt - y.times.assignedAt).slice(0, excess).map((x) => x.id));
  return kept.filter((x) => !drop.has(x.id));
}

/** The export: newest first, filtered to a floor, issue or PR, with queue and run times and the PR's state. */
export function exportAttempts(
  attempts: RunAttemptView[],
  prState: (repoId: string, pr: number) => PullInfo['state'] | null,
  filter: { repoId?: string; issue?: number; pr?: number },
  now: number,
): RunHistoryExport {
  const wanted = attempts.filter((x) => (!filter.repoId || x.repoId === filter.repoId) &&
    (filter.issue === undefined || x.issueNumber === filter.issue) && (filter.pr === undefined || x.prNumber === filter.pr));
  return {
    format: 'cubefarm-run-history',
    version: 1,
    generatedAt: now,
    retention: { ...RUN_HISTORY_LIMITS },
    // Newest first; attempts in the same millisecond keep the order they were recorded in, reversed.
    attempts: wanted.map((x, i) => [x, i] as const).sort(([x, i], [y, j]) => y.times.assignedAt - x.times.assignedAt || j - i).map(([x]) => ({
      ...x,
      queueMs: x.times.startedAt === null ? null : x.times.startedAt - x.times.assignedAt,
      runMs: x.times.startedAt === null || x.times.endedAt === null ? null : x.times.endedAt - x.times.startedAt,
      prState: x.prNumber === null ? null : prState(x.repoId, x.prNumber),
    })),
  };
}

/** The attempts in memory and on disk. Writes go through a temp file and a rename. */
export class RunHistory {
  attempts: RunAttemptView[] = [];
  private dirty = false;

  constructor(private file: string) {}

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as { attempts?: RunAttemptView[] };
      this.attempts = Array.isArray(raw.attempts) ? raw.attempts : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('could not read the run history', err);
    }
  }

  async write(now = Date.now()) {
    if (!this.dirty) return;
    this.dirty = false;
    this.attempts = pruneAttempts(this.attempts, now);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ format: 'cubefarm-run-history', version: 1, attempts: this.attempts }));
    await fs.rename(tmp, this.file);
  }

  get(id: string | null | undefined) {
    return id ? this.attempts.find((x) => x.id === id) : undefined;
  }

  add(attempt: RunAttemptView) {
    this.attempts.push(attempt);
    this.dirty = true;
    return attempt;
  }

  /** The latest attempt on the same work: the PR for QA and fixes, else the issue. */
  latestOn(repoId: string, work: { pr: number | null; issue: number | null }) {
    for (let i = this.attempts.length - 1; i >= 0; i--) {
      const x = this.attempts[i];
      if (x.repoId !== repoId) continue;
      if (work.pr !== null ? x.prNumber === work.pr : work.issue !== null && x.issueNumber === work.issue && x.task !== 'qa' && x.task !== 'fix') return x;
    }
    return undefined;
  }

  change(attempt: RunAttemptView, patch: (x: RunAttemptView) => void) {
    patch(attempt);
    this.dirty = true;
  }

  /** Ends an open attempt once; later endings of the same attempt change nothing. */
  end(attempt: RunAttemptView | undefined, outcome: Outcome, at: number, note?: string) {
    if (!attempt || attempt.outcome) return false;
    attempt.outcome = outcome;
    attempt.times.endedAt = at;
    attempt.events.push({ at, kind: 'ended', note: note ?? `${outcome.result} (${outcome.cause})` });
    this.dirty = true;
    return true;
  }
}
