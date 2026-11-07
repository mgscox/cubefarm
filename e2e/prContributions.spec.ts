import { expect, test } from '@playwright/test';
import type { PrContributionView, RepoView, ServerEvent } from '../shared/types';

test('PR contributions remain visible after QA cleanup and reconnection', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let fixture: RepoView;
  let history: PrContributionView;
  let closePr = () => {};
  let closed = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    closePr = () => {
      closed = true;
      history = { ...history, state: 'CLOSED' };
      ws.send(JSON.stringify({ type: 'prContribution', contribution: history }));
      ws.send(JSON.stringify({ type: 'qaRemoved', repoId: fixture.id, prNumber: 999999 }));
      ws.send(JSON.stringify({ type: 'repo', repo: { ...fixture, pulls: [] } }));
    };
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      if (event.type === 'snapshot') {
        fixture = { ...event.data.repos[0], issues: [], pulls: [{
          number: 999999, title: 'Durable handoff', url: 'https://example.invalid/pr/999999',
          isCrossRepository: false, headRefName: 'swarm/issue-99-ada', headSha: 'barbara-revision',
          state: 'OPEN', isDraft: false, closesIssues: [], mergeable: 'MERGEABLE', reviewDecision: null,
          createdAt: '', mergedAt: null, additions: 1, deletions: 0, checks: 'none',
          mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
        }] };
        history = {
          repoId: fixture.id, prNumber: 999999, title: 'Durable handoff', url: fixture.pulls[0].url,
          state: closed ? 'CLOSED' : 'OPEN',
          original: { agentId: 'original-desk', name: 'Ada', submittedSha: 'original-revision', at: 1000 },
          repairs: [{ id: 'repair-1', agentId: 'repair-desk', name: 'Barbara', reason: 'qa', startingSha: 'original-revision', submittedSha: 'barbara-revision', reviewId: 'review-1', round: 1, commentUrl: 'https://example.invalid/findings', findings: 'Fix toolbar overflow', startedAt: 2000, finishedAt: 3000 }],
        };
        event.data.repos[0] = closed ? { ...fixture, pulls: [] } : fixture;
        event.data.qa = [];
        event.data.prContributions = [history];
      }
      if (event.type === 'repo' && fixture && event.repo.id === fixture.id) event.repo = closed ? { ...fixture, pulls: [] } : fixture;
      if (event.type !== 'prContribution') ws.send(JSON.stringify(event));
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const openBoard = async () => {
    await page.goto('/');
    await expect.poll(() => fixture?.id).toBeTruthy();
    await page.getByRole('navigation', { name: 'Floors' }).getByRole('button', { name: new RegExp(fixture!.fullName) }).click();
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  };
  await openBoard();
  await page.getByText('Contribution history', { exact: true }).click();
  await expect(page.getByText('Original author:', { exact: false })).toContainText('Ada');
  await expect(page.getByText('Repair: Barbara', { exact: false })).toBeVisible();
  await expect(page.getByText('Submitted SHA:', { exact: false })).toContainText('barbara-revision');
  closePr();
  await page.getByText('Archived PR contributions', { exact: true }).click();
  await page.getByText('Contribution history', { exact: true }).click();
  await expect(page.getByText('Repair: Barbara', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pr-contribution-archive.png') });
  await openBoard();
  await page.getByText('Archived PR contributions', { exact: true }).click();
  await page.getByText('Contribution history', { exact: true }).click();
  await expect(page.getByText('Original author:', { exact: false })).toContainText('original-revision');
  await expect(page.getByText('Repair: Barbara', { exact: false })).toBeVisible();
});
