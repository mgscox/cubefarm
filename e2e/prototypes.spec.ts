import { expect, test } from '@playwright/test';
import type { RepoView, ServerEvent } from '../shared/types';

test('Blocked prototypes expose review evidence, feedback and explicit implementation approval', async ({ page, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  let fixture: RepoView | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const event = JSON.parse(String(message)) as ServerEvent;
      if (event.type === 'snapshot') {
        const repo = event.data.repos[0];
        fixture = {
          ...repo,
          autoAssign: true,
          issues: [{ number: 999999, title: 'Prototype the research handoff', body: '', url: '', labels: ['swarm:prototype'], createdAt: '' }],
          pulls: [{
            number: 999999, title: 'Prototype the research handoff', url: 'https://example.invalid/prototype',
            isCrossRepository: false, headRefName: 'prototype/issue-999999-ada', headSha: 'reviewed-prototype',
            state: 'OPEN', isDraft: true, closesIssues: [], mergeable: 'MERGEABLE', reviewDecision: null,
            createdAt: '', mergedAt: null, additions: 1, deletions: 0, checks: 'none',
            mergeState: 'DRAFT', failedChecks: [], pendingChecks: [],
          }],
        };
        event.data.repos[0] = fixture;
      }
      if (event.type === 'repo' && fixture && event.repo.id === fixture.id) event.repo = fixture;
      ws.send(JSON.stringify(event));
    });
  });
  const feedback: unknown[] = [];
  const approvals: unknown[] = [];
  await page.route('**/prototype/revise', async (route) => {
    feedback.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });
  await page.route('**/prototype/approve', async (route) => {
    approvals.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect.poll(() => fixture?.id).toBeTruthy();
  await page.getByRole('navigation', { name: 'Floors' }).getByRole('button', { name: new RegExp(fixture!.fullName) }).click();
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  const blocked = page.locator('.kcol-blocked');
  await expect(blocked).toContainText('Awaiting prototype approval');
  await blocked.scrollIntoViewIfNeeded();
  await expect(blocked.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('prototype-blocked.png') });

  await blocked.getByRole('button', { name: 'Send back…' }).click();
  await page.getByRole('textbox', { name: 'What should the developer change?' }).fill('Show the floor filter and add a screenshot of the empty state.');
  await page.screenshot({ path: testInfo.outputPath('prototype-feedback.png') });
  await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect.poll(() => feedback).toEqual([{ head: 'reviewed-prototype', feedback: 'Show the floor filter and add a screenshot of the empty state.' }]);

  await blocked.getByRole('button', { name: 'Approve for implementation…' }).click();
  await page.getByRole('textbox', { name: 'Implementation title' }).fill('Implement research filters');
  await page.getByRole('textbox', { name: 'Implementation scope and acceptance criteria' }).fill('Filter reports by floor and preserve the chosen filter.');
  await expect(page.getByRole('dialog')).toContainText('Auto-assign may start it immediately.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('prototype-approval-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('prototype-implementation-approval.png') });
  await page.getByRole('button', { name: 'Approve and release issue' }).click();
  await expect.poll(() => approvals).toEqual([{
    head: 'reviewed-prototype', title: 'Implement research filters', body: 'Filter reports by floor and preserve the chosen filter.',
  }]);
});
