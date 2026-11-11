import { expect } from '@playwright/test';
import { test } from './isolatedDemo';
import type { IdeaView, WorldSnapshot } from '../shared/types';

test('hand a disputed PRD to the manager after three review rounds', async ({ page, request, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.setViewportSize({ width: 1100, height: 850 });
  const response = await request.post('/api/ideas', { data: { description: 'Reviewers will keep disagreeing on this' } });
  expect(response.ok()).toBe(true);
  const contested = await response.json() as IdeaView;
  const detail = page.getByRole('article', { name: 'Idea detail' });
  await page.goto(`/#idea/${contested.id}`);
  await expect(detail).toContainText(contested.description);
  await detail.getByRole('button', { name: 'Reviewers disagree' }).click();
  await expect(detail.getByRole('status')).toHaveText('Proposed · 1 open finding', { timeout: 60_000 });
  const handoff = detail.getByRole('note', { name: 'Handoff' });
  await expect(handoff).toContainText('For your decision: PRD r3 with Issue Plan r3');
  await expect(handoff).toContainText('Step 2 depends on a floor that has no QA tester yet.');
  await expect(detail.getByRole('listitem', { name: /^Round/ })).toHaveCount(3);
  await expect(detail.getByRole('listitem', { name: 'Round 1' })).toContainText('2 findings on r1');
  await expect(detail).toContainText('No joint endorsement after 3 rounds');

  const after = await (await request.get('/api/state')).json() as WorldSnapshot;
  expect(after.ideaReviews.find((r) => r.ideaId === contested.id)?.handoff?.endorsed).toBe(false);
  expect(errors).toEqual([]);
});
