import { expect, test } from '@playwright/test';
import type { IdeaView, WorldSnapshot } from '../shared/types';

// The demo fixture plan on an Idea: drafted, inspectable, revisioned, and nothing created on the fake tracker.
test('draft and inspect a demo Issue Plan on an Idea', async ({ page, request, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  const issueIds = (s: WorldSnapshot) => s.repos.flatMap((r) => r.issues.map((i) => `${r.id}#${i.number}`));
  const before = issueIds(await (await request.get('/api/state')).json() as WorldSnapshot);
  const idea = await (await request.post('/api/ideas', { data: { description: 'Show the weather on todos due soon' } })).json() as IdeaView;
  await page.goto(`/#idea/${idea.id}`);
  await page.getByRole('button', { name: 'Enter the office' }).click();
  const plan = page.getByRole('region', { name: 'Issue Plan' });
  await expect(page.getByText('No Issue Plan yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Draft demo Issue Plan' }).click();
  await expect(plan.getByText('Revision 1 · drafted from PRD revision 1')).toBeVisible();
  await expect(plan.getByText('4 new · 1 already on the tracker · 3 dependencies · 1 Tracking Parent')).toBeVisible();
  await plan.getByText('Forecast a single day on /forecast', { exact: true }).click();
  await expect(plan.getByText('so this issue holds only the remaining work')).toBeVisible();
  await expect(plan.getByText('A date outside the next 5 days answers 400', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Draft demo Issue Plan' }).click();
  await expect(plan.getByLabel('Issue Plan revision')).toHaveValue('2');
  const after = await (await request.get('/api/state')).json() as WorldSnapshot;
  expect(issueIds(after).filter((id) => !before.includes(id))).toEqual([]); // demo merges may close issues; none are created
  expect(after.issuePlans?.filter((p) => p.ideaId === idea.id).map((p) => p.revision)).toEqual([1, 2]);
  expect(errors).toEqual([]);
});
