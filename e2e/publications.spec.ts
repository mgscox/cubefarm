import { test, expect } from '@playwright/test';
import type { WorldSnapshot } from '../shared/types';

// Publication's REST routes: a retry only reaches recorded publications, so inherited keys can't reach server objects
// or the connected clients.
test('retrying inherited keys is a 404 that leaves the office and its clients intact', async ({ page, request, baseURL }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const state = async (): Promise<WorldSnapshot> => (await request.get('/api/state')).json();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Enter the office' })).toBeEnabled();

  const seeded = await request.post('/api/publications/demo', { data: { fault: '' } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  const { proposalId } = await seeded.json();
  await expect.poll(async () => (await state()).publications?.find((p) => p.proposalId === proposalId)?.status).toBe('complete');

  for (const key of ['__proto__', 'constructor', 'toString']) {
    const response = await request.post(`/api/publications/${key}/retry`);
    expect(response.status(), key).toBe(404);
  }
  const after = await state();
  expect(after.publications?.map((p) => p.proposalId)).toContain(proposalId);
  expect(after.publications?.every((p) => Array.isArray(p.issues) && typeof p.proposalId === 'string')).toBe(true);
  expect((await request.post(`/api/publications/${proposalId}/retry`)).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Enter the office' })).toBeVisible();
  expect(problems).toEqual([]);
});
