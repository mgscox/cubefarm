import { expect, test } from '@playwright/test';
import type { PrContributionView, RepoView, RunAttemptView, ServerEvent } from '../shared/types';

test('an open run history follows lifecycle events, PR merges and reconnects', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let repo: RepoView;
  let attempt: RunAttemptView;
  let contribution: PrContributionView;
  let finish = () => {};
  let ended = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    finish = () => {
      ended = true;
      attempt = { ...attempt, times: { ...attempt.times, endedAt: 6000 }, outcome: { result: 'no-change', cause: 'agent' } };
      contribution = { ...contribution, state: 'MERGED' };
      ws.send(JSON.stringify({ type: 'runAttempt', attempt } satisfies ServerEvent));
      ws.send(JSON.stringify({ type: 'prContribution', contribution } satisfies ServerEvent));
    };
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      if (event.type === 'snapshot') {
        repo = event.data.repos[0];
        attempt = {
          id: 'live-history-attempt', parentId: null, repoId: repo.id, repo: repo.fullName,
          task: 'fix', specialty: null, issueNumber: 999, prNumber: 999,
          agent: { id: 'history-desk', name: 'History developer', role: 'dev', specialty: '' },
          assignment: { reason: 'repair', factors: { policyVersion: 'specialty-first-v2', specialty: 'server', specialtyMatch: false, specialtyFallback: true, scoreKind: 'repair', score: 2 } },
          runtime: { cli: 'codex', model: null, effort: 'high', playbook: null, office: 'test' },
          worker: { box: '', name: 'office', healthAtStart: null, healthAtEnd: null },
          sessionIds: [], revisions: { start: null, submitted: null }, review: null,
          times: { assignedAt: 1000, startedAt: 2000, endedAt: ended ? 6000 : null },
          usage: { sessions: 1, costUsd: null, turns: 1 }, events: [],
          outcome: ended ? { result: 'no-change', cause: 'agent' } : null,
        };
        contribution = { repoId: repo.id, prNumber: 999, title: 'History fixture', url: '', state: ended ? 'MERGED' : 'OPEN', original: null, repairs: [] };
        event.data.runAttempts = [attempt];
        event.data.prContributions = [contribution];
      }
      if (event.type !== 'runAttempt' && event.type !== 'runAttemptsRemoved' && event.type !== 'prContribution') ws.send(JSON.stringify(event));
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const openHistory = async () => {
    await page.goto('/');
    await expect.poll(() => repo?.id).toBeTruthy();
    await page.getByRole('navigation', { name: 'Floors' }).getByRole('button', { name: new RegExp(repo!.fullName) }).click();
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    await page.getByText('Run history', { exact: true }).click();
  };
  await openHistory();
  const row = page.locator('.run-history tbody tr').filter({ hasText: 'History developer' });
  await expect(row).toContainText('running');
  await expect(row).toContainText('repair · server fallback · Repair 2');
  await expect(row.getByText('repair · server fallback · Repair 2')).toHaveAttribute('title', 'specialty-first-v2');
  finish();
  await expect(row).toContainText('no-change · agent');
  await expect(row).toContainText('PR #999 (merged)');
  await expect(row).toContainText('4s');
  await page.screenshot({ path: testInfo.outputPath('run-history-live.png') });
  await openHistory();
  await expect(row).toContainText('repair · server fallback · Repair 2');
  await expect(row).toContainText('no-change · agent');
  await expect(row).toContainText('PR #999 (merged)');
});
