import { test } from './isolatedDemo';
import { expect } from '@playwright/test';
import type { AgentView, WorldSnapshot } from '../shared/types';

test('demo placement controls hire on Upstash, update Team and move a whole floor', async ({ page, request, baseURL }, testInfo) => {
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await request.get('/api/state').then((r) => r.json()) as WorldSnapshot;
  const floor = state.repos[0];
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();
  await page.getByRole('button', { name: /Team/ }).click();
  const card = page.locator('.floor-card').filter({ hasText: floor.fullName });
  await card.getByPlaceholder('Name (optional)').fill('Box worker');
  await page.getByLabel(`Placement for new workers on floor ${floor.floor}`).selectOption('upstash');
  await card.getByRole('button', { name: '+ Developer', exact: true }).click();
  const workerRow = card.locator('.team-agent').filter({ has: page.getByText('Box worker', { exact: true }) });
  await workerRow.getByRole('button', { name: 'Details', exact: true }).click();
  const picker = workerRow.getByRole('combobox', { name: 'Machine', exact: true });
  await expect(picker).toHaveValue('upstash');
  await picker.selectOption('');
  await expect(picker).toHaveValue('');
  await picker.selectOption('upstash');
  await expect(picker).toHaveValue('upstash');
  await page.screenshot({ path: testInfo.outputPath('upstash-team.png'), animations: 'disabled' });

  await page.getByRole('button', { name: /Fleet/ }).click();
  await page.getByLabel(`Machine for floor ${floor.floor}`).selectOption('upstash');
  const floorCard = page.locator('.floor-card').filter({ hasText: floor.fullName });
  await floorCard.getByRole('button', { name: 'Move the whole floor' }).click();
  await page.getByRole('button', { name: 'Move the floor', exact: true }).click();
  await expect(page.getByLabel(`Machine for floor ${floor.floor}`)).toHaveValue('upstash');
  await expect(floorCard).toContainText('Works on Upstash');
  await expect(page.getByText('0/10 task Boxes reserved.', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('upstash-fleet.png'), animations: 'disabled' });

  // The closed demo has no autonomous workers; explicitly start only this new worker's issue.
  const snapshot = await request.get('/api/state').then((r) => r.json()) as WorldSnapshot;
  const worker = snapshot.agents.find((a) => a.name === 'Box worker') as AgentView;
  expect(worker.box).toBeNull();
  await request.patch(`/api/repos/${encodeURIComponent(floor.id)}`, { data: { autoAssign: false } });
  await request.post('/api/office/reopen');
  const filed = await request.post(`/api/repos/${encodeURIComponent(floor.id)}/issues`, { data: { title: 'Rehearse disposable worker placement', body: 'Exercise the demo task placement.' } });
  expect(filed.ok(), await filed.text()).toBe(true);
  const issue = await filed.json() as { number: number };
  const assigned = await request.post(`/api/agents/${worker.id}/assign`, { data: { issueNumber: issue.number } });
  expect(assigned.ok(), await assigned.text()).toBe(true);
  await expect.poll(async () => {
    const next = await request.get('/api/state').then((r) => r.json()) as WorldSnapshot;
    const current = next.agents.find((a) => a.id === worker.id);
    return current?.status === 'working' && current.deskBox.startsWith('upstash-');
  }).toBe(true);
  await expect(page.getByText('1/10 task Boxes reserved.', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('upstash-task.png'), animations: 'disabled' });

  const route = '/api/settings/upstash';
  for (const key of ['demo-first-key', 'demo-replacement-key', null]) {
    const changed = await request.patch(route, { data: { key } });
    expect(changed.ok(), await changed.text()).toBe(true);
    expect(await changed.json()).toEqual({ keySource: key ? 'settings' : null, canManage: true });
  }
  await expect(page.getByText('1/10 task Boxes reserved.', { exact: false })).toBeVisible();
});

test('Settings saves and clears the write-only Upstash Box key on localhost', async ({ page, request, baseURL }, testInfo) => {
  const route = '/api/settings/upstash';
  const key = 'box-synthetic-e2e-fixture';
  expect((await request.patch(route, { headers: { Origin: 'https://outside.example' }, data: { key } })).status()).toBe(403);
  expect((await request.patch(route, { headers: { 'X-Forwarded-For': '192.0.2.1' }, data: { key } })).status()).toBe(403);
  expect((await request.patch(route, { data: { key: 'invalid key' } })).status()).toBe(400);

  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (r) => r.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();
  await page.locator('.panel').getByRole('button', { name: /Settings/ }).click();

  const panel = page.getByRole('region', { name: 'Upstash Box' });
  const field = panel.getByLabel('Upstash Box API key');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(key);
  await panel.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Using the Box key saved in Settings.');
  await expect(field).toHaveValue('');
  const metadata = await request.get(route);
  expect(metadata.headers()['cache-control']).toBe('no-store');
  expect(await metadata.json()).toEqual({ keySource: 'settings', canManage: true });
  await panel.screenshot({ path: testInfo.outputPath('upstash-key-settings.png') });

  await panel.getByRole('button', { name: 'Clear saved key' }).click();
  await expect(panel.getByRole('status')).toHaveText('Set a Box API key to use Upstash workers.');
  expect(await (await request.get(route)).json()).toEqual({ keySource: null, canManage: true });
});
