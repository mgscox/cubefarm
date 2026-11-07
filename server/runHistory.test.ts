import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunAttemptView } from '../shared/types.ts';
import { addUsage, errorCause, exportAttempts, finishedOutcome, playbookVersion, pruneAttempts, redact, RunHistory, RUN_HISTORY_LIMITS } from './runHistory.ts';

const DAY = 86_400_000;
const attempt = (id: string, patch: Partial<RunAttemptView> = {}): RunAttemptView => ({
  id, parentId: null, repoId: 'r', repo: 'demo-co/app', task: 'issue', specialty: null, issueNumber: 1, prNumber: null,
  agent: { id: 'a1', name: 'Ada', role: 'dev', specialty: '' },
  assignment: { reason: 'auto', factors: {} },
  runtime: { cli: null, model: null, effort: null, playbook: null, office: '0.0.0' },
  worker: { box: '', name: 'office', healthAtStart: null, healthAtEnd: null },
  sessionIds: [], revisions: { start: null, submitted: null }, review: null,
  times: { assignedAt: 1000, startedAt: null, endedAt: null },
  usage: { sessions: 0, costUsd: null, turns: null },
  events: [], outcome: null,
  ...patch,
});

describe('redacted excerpts', () => {
  it('removes secrets, keeps commit SHAs and bounds the length', () => {
    const sha = 'a'.repeat(40);
    const text = `push failed for https://bot:hunter2@github.com/x at ${sha} with token=abc123 and ghp_${'x'.repeat(36)}\nBearer eyJhbGciOi`;
    const out = redact(text)!;
    expect(out).toContain(sha);
    expect(out).toContain('https://[redacted]@github.com');
    expect(out).toContain('token=[redacted]');
    expect(out).not.toMatch(/hunter2|abc123|ghp_x|eyJhbGciOi|\n/);
    expect(redact('x '.repeat(500))!.length).toBe(RUN_HISTORY_LIMITS.excerptChars);
    expect(redact('  ')).toBeUndefined();
  });
});

describe('end causes', () => {
  it.each([
    ['Stopped by manager', 'manager'],
    ['Claude usage limit reached', 'provider'],
    ['API Error: 529 overloaded', 'provider'],
    ['ENOSPC: no space left on device', 'worker'],
    ['Session never started on office: no output', 'worker'],
    ['Tests failed after the change', 'agent'],
    ['', 'unknown'],
  ] as const)('%s → %s', (text, cause) => expect(errorCause(text)).toBe(cause));
});

describe('finished outcomes', () => {
  const base = { task: 'issue' as const, result: { ok: true }, status: 'done' as const, lastError: null, prNumber: null };
  it('tells delivery from a run without a PR', () => {
    expect(finishedOutcome({ ...base, prNumber: 7 })).toEqual({ result: 'delivered', cause: 'agent' });
    expect(finishedOutcome(base)).toEqual({ result: 'no-pr', cause: 'agent' });
  });
  it('blames the worker for startup and recovery failures, the manager for stops', () => {
    expect(finishedOutcome({ ...base, result: { ok: false, startupFailed: true }, status: 'error', lastError: 'exited' })).toMatchObject({ result: 'start-failed', cause: 'worker' });
    expect(finishedOutcome({ ...base, result: { ok: false, recoveryFailed: true }, status: 'stopped' })).toMatchObject({ result: 'failed', cause: 'worker' });
    expect(finishedOutcome({ ...base, status: 'stopped', lastError: 'Interrupted in the terminal' })).toMatchObject({ result: 'stopped', cause: 'manager' });
    expect(finishedOutcome({ ...base, status: 'error', lastError: 'rate limit exceeded' })).toMatchObject({ result: 'failed', cause: 'provider' });
  });
  it('reads QA verdicts, including a pass the worker blocked locally', () => {
    const qa = { task: 'qa' as const, result: { ok: true }, status: 'done' as const, lastError: null, prNumber: 3 };
    expect(finishedOutcome({ ...qa, qa: { status: 'passed', ciRequired: false, failedTested: false } })).toEqual({ result: 'qa-passed', cause: 'agent' });
    expect(finishedOutcome({ ...qa, qa: { status: 'passed', ciRequired: true, failedTested: false } })).toMatchObject({ result: 'worker-blocked', cause: 'worker' });
    expect(finishedOutcome({ ...qa, qa: { status: 'failed', ciRequired: false, failedTested: true } })).toEqual({ result: 'qa-failed', cause: 'agent' });
  });
  it('tells a pushed fix from one without new commits', () => {
    const fix = { task: 'fix' as const, result: { ok: true }, prNumber: 3 };
    expect(finishedOutcome({ ...fix, status: 'done', lastError: null })).toEqual({ result: 'repaired', cause: 'agent' });
    expect(finishedOutcome({ ...fix, status: 'error', lastError: 'No new commits were pushed for PR #3' })).toMatchObject({ result: 'no-change', cause: 'agent' });
  });
});

describe('usage', () => {
  const none = { sessions: 0, costUsd: null, turns: null };
  it('keeps a reported zero apart from an unreported cost', () => {
    expect(addUsage(none, { costUsd: 0, turns: 0 })).toEqual({ sessions: 1, costUsd: 0, turns: 0 });
    expect(addUsage(none, { costUsd: 0, turns: 3, costReported: false })).toEqual({ sessions: 1, costUsd: null, turns: 3 });
  });
  it('sums sessions, and one unknown cost makes the total unknown', () => {
    const one = addUsage(none, { costUsd: 0.5, turns: 4 });
    expect(addUsage(one, { costUsd: 0.25, turns: 2 })).toEqual({ sessions: 2, costUsd: 0.75, turns: 6 });
    expect(addUsage(addUsage(one, { costUsd: 0, turns: 1, costReported: false }), { costUsd: 1, turns: 1 }).costUsd).toBeNull();
  });
});

it('versions a playbook by its text', () => {
  expect(playbookVersion('qa', 'Test it.')).toMatch(/^qa@[0-9a-f]{12}$/);
  expect(playbookVersion('qa', 'Test it.')).not.toBe(playbookVersion('qa', 'Test it twice.'));
  expect(playbookVersion('qa', '')).toBeNull();
});

describe('retention', () => {
  const now = 400 * DAY;
  it('keeps running attempts and drops stale waits and old or excess ended ones, oldest first', () => {
    const ended = (id: string, at: number) => attempt(id, { times: { assignedAt: at, startedAt: at, endedAt: at }, outcome: { result: 'no-pr', cause: 'agent' } });
    const list = [
      attempt('open', { times: { assignedAt: 0, startedAt: 1, endedAt: null } }), attempt('stale wait', { times: { assignedAt: 0, startedAt: null, endedAt: null } }),
      ended('old', now - 181 * DAY), ended('a', now - 3), ended('b', now - 2), ended('c', now - 1),
    ];
    expect(pruneAttempts(list, now).map((x) => x.id)).toEqual(['open', 'a', 'b', 'c']);
    expect(pruneAttempts(list, now, { maxAttempts: 2, maxAgeDays: 180 }).map((x) => x.id)).toEqual(['open', 'c']);
  });
});

describe('export', () => {
  it('filters, orders newest first, and adds queue and run times and the PR state', () => {
    const list = [
      attempt('first', { prNumber: 5, times: { assignedAt: 1000, startedAt: 4000, endedAt: 9000 }, outcome: { result: 'delivered', cause: 'agent' } }),
      attempt('pending', { times: { assignedAt: 2000, startedAt: null, endedAt: null } }),
      attempt('elsewhere', { repoId: 'other' }),
    ];
    const out = exportAttempts(list, (repoId, pr) => (repoId === 'r' && pr === 5 ? 'MERGED' : null), { repoId: 'r' }, 10_000);
    expect(out.attempts.map((x) => x.id)).toEqual(['pending', 'first']);
    expect(out.attempts[0]).toMatchObject({ queueMs: null, runMs: null, prState: null });
    expect(out.attempts[1]).toMatchObject({ queueMs: 3000, runMs: 5000, prState: 'MERGED' });
    expect(exportAttempts(list, () => null, { pr: 5 }, 0).attempts.map((x) => x.id)).toEqual(['first']);
  });
});

describe('the store', () => {
  it('ends an attempt once and survives a reload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-history-'));
    try {
      const file = path.join(dir, 'run-history.json');
      const store = new RunHistory(file);
      const x = store.add(attempt('one'));
      expect(store.end(x, { result: 'no-pr', cause: 'agent' }, 5000)).toBe(true);
      expect(store.end(x, { result: 'delivered', cause: 'agent' }, 6000)).toBe(false);
      await store.write(5000);
      const again = new RunHistory(file);
      await again.load();
      expect(again.attempts).toEqual([expect.objectContaining({ id: 'one', outcome: { result: 'no-pr', cause: 'agent' }, times: expect.objectContaining({ endedAt: 5000 }) })]);
      const missing = new RunHistory(path.join(dir, 'none.json'));
      await missing.load();
      expect(missing.attempts).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('finds the latest attempt on the same issue or PR', () => {
    const store = new RunHistory('unused');
    store.add(attempt('issue-1', { issueNumber: 1 }));
    store.add(attempt('qa-1', { task: 'qa', issueNumber: 1, prNumber: 5 }));
    store.add(attempt('issue-1b', { issueNumber: 1 }));
    expect(store.latestOn('r', { pr: null, issue: 1 })?.id).toBe('issue-1b');
    expect(store.latestOn('r', { pr: 5, issue: 1 })?.id).toBe('qa-1');
    expect(store.latestOn('other', { pr: 5, issue: 1 })).toBeUndefined();
  });
});
