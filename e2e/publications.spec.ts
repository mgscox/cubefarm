import { test, expect } from '@playwright/test';
import type { PublicationView, WorldSnapshot } from '../shared/types';

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

// The fake tracker accepts floor A, refuses B after preflight, then restores access without another decision.
test('cross-floor publication stays held on refusal and updates its Idea through recovery', async ({ page, request, baseURL }, testInfo) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const initial = await (await request.get('/api/state')).json() as WorldSnapshot;
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  try {
    const response = await request.post('/api/publications/demo', { data: { fault: 'cross-floor-refused' } });
    expect(response.ok(), await response.text()).toBe(true);
    const seeded = await response.json() as PublicationView;
    const current = async () => ((await (await request.get('/api/state')).json()) as WorldSnapshot).publications!.find((p) => p.proposalId === seeded.proposalId)!;
    await expect.poll(async () => (await current()).status).toBe('blocked');
    const blocked = await current();
    expect(blocked.issues.slice(0, 2).every((i) => i.number !== null)).toBe(true);
    expect(blocked.issues.every((i) => i.step !== 'released')).toBe(true);
    expect(blocked.needsManager).toBe(true);
    await page.goto(`/#idea/${seeded.snapshot.approval.ideaId}`);
    await page.getByRole('button', { name: 'Enter the office' }).click();
    const detail = page.getByRole('article', { name: 'Idea detail' });
    await expect(detail).toContainText('GitHub refused');
    await expect(detail.getByRole('link', { name: `${blocked.issues[0].repo}#${blocked.issues[0].number}`, exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.screenshot({ path: testInfo.outputPath('cross-floor-held.png') });
    await expect.poll(async () => (await current()).status, { timeout: 60_000 }).toBe('complete');
    const done = await current();
    expect(done.issues.slice(0, 2).map((i) => i.number)).toEqual(blocked.issues.slice(0, 2).map((i) => i.number));
    expect(done.issues.map((i) => i.step)).toEqual(['held', 'released', 'released', 'referenced', 'held']);
    await expect(detail).toContainText('Plan verified; 2 entries stay held');
    await expect(detail).toContainText('Waiting for approved-blocker dispatch integration');
    await page.screenshot({ path: testInfo.outputPath('cross-floor-recovered.png') });
    await page.reload();
    await page.getByRole('button', { name: 'Enter the office' }).click();
    await expect(detail).toContainText('Plan verified; 2 entries stay held');
    expect(problems).toEqual([]);
  } finally {
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep } });
  }
});
