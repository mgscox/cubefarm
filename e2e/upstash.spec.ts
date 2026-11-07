import { expect } from '@playwright/test';
import { test } from './isolatedDemo';
import type { WorldSnapshot } from '../shared/types';

test('manager can hire onto Upstash, keep that assignment when moving the floor, and reassign the worker', async ({ page, request, baseURL }, testInfo) => {
  const state = async (): Promise<WorldSnapshot> => (await request.get('/api/state')).json();
  const repo = (await state()).repos[0];
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Manager console', exact: true }).click();
  const console = page.locator('.panel').filter({ hasText: "Manager's console" });
  await console.getByRole('button', { name: /Team/ }).click();
  const card = console.locator('.floor-card').filter({ hasText: repo.fullName });
  const destination = card.getByRole('combobox', { name: `New worker machine on floor ${repo.floor}` });
  await expect(destination.locator('option:checked')).toHaveText('Follow floor');
  await destination.selectOption('upstash');
  await card.getByPlaceholder('Name (optional)').fill('Upstash pilot');
  await card.getByRole('button', { name: '+ Developer', exact: true }).click();
  const worker = card.getByRole('combobox', { name: "Upstash pilot's machine" });
  await expect(worker).toHaveValue('upstash');
  await expect.poll(async () => (await state()).boxes).toHaveLength(0); // hiring allocates no Box
  await page.screenshot({ path: testInfo.outputPath('upstash-hire-and-placement.png'), animations: 'disabled' });

  const { id } = (await state()).agents.find((a) => a.name === 'Upstash pilot')!;
  await console.getByRole('button', { name: /Fleet/ }).click();
  const floor = console.locator('.floor-card').filter({ hasText: repo.fullName });
  await floor.getByRole('combobox').selectOption('upstash');
  await floor.getByRole('button', { name: 'Move the whole floor' }).click();
  await page.getByRole('button', { name: 'Move the floor', exact: true }).click();
  await expect.poll(async () => (await state()).repos.find((r) => r.id === repo.id)?.box).toBe('upstash');
  await console.getByRole('button', { name: /Team/ }).click();
  await expect(worker).toHaveValue('upstash');
  await worker.selectOption('');
  await expect.poll(async () => (await state()).agents.find((a) => a.id === id)?.box).toBe('');
});
