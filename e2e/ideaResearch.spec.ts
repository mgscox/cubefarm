import { expect, test } from '@playwright/test';
import type { WorldSnapshot } from '../shared/types';

test('research an unhinted Idea, answer its blocker and inspect the same saved PRD revision after reload', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const initial = await (await request.get('/api/state')).json() as WorldSnapshot;
  await request.patch('/api/settings', { data: { tutorialStep: -1, pacingSessions: 32 } });
  await request.post('/api/office/reopen');
  const created = await (await request.post('/api/ideas', { data: { description: '[clarify] Help new teammates find the onboarding flow', links: ['https://example.com/previous-research'] } })).json();
  const enter = async (hash: string) => {
    await page.goto(`/${hash}`);
    await page.reload();
    await page.getByRole('button', { name: 'Enter the office' }).click();
  };
  try {
    await enter(`#idea/${created.id}`);
    const detail = page.getByRole('article', { name: 'Idea detail' });
    await expect(detail.getByRole('status')).toHaveText('Needs clarification', { timeout: 90_000 });
    await expect(detail).toContainText('Who is the primary user');
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.screenshot({ path: testInfo.outputPath('idea-clarification.png') });
    await page.getByLabel('Reply to researcher').fill('New teammates finish onboarding in under 3 minutes');
    await page.getByRole('button', { name: 'Reply and resume research' }).click();
    await expect(detail.getByRole('status')).toHaveText('PRD ready', { timeout: 150_000 });
    await expect(detail).toContainText('Focused input');
    await expect(detail).toContainText('Received');
    await expect(detail).toContainText('PRD revision 1');
    await expect(detail).toContainText('New teammates finish onboarding in under 3 minutes');
    for (const name of ['Problem', 'Desired outcome', 'Scope', 'Linked evidence', 'Unresolved assumptions', 'Target floors and rationale', 'Measurable acceptance criteria']) {
      await expect(detail.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    const revision = await detail.getByRole('link', { name: 'View PRD revision' }).getAttribute('href');
    expect(revision).toBe(`#idea/${created.id}/prd/${created.id}-prd-1`);
    await detail.getByRole('heading', { name: 'Problem', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('idea-prd.png') });
    await enter(revision!);
    await expect(detail.getByRole('status')).toHaveText('PRD ready');
    await expect(detail.getByRole('heading', { name: 'PRD revision 1', exact: true })).toBeVisible();
    const researchHeading = detail.getByRole('heading', { name: 'Research', exact: true });
    await researchHeading.scrollIntoViewIfNeeded();
    await request.patch(`/api/repos/${encodeURIComponent(initial.repos[0].id)}`, { data: { autoAssign: initial.repos[0].autoAssign } });
    await page.waitForTimeout(300); // Deliver the floor event: it must not jump a reader back to the PRD.
    await expect(researchHeading).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.tab-body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('idea-prd-mobile.png') });
    const saved = await (await request.get('/api/state')).json() as WorldSnapshot;
    expect(saved.ideaRecords.filter((r) => r.ideaId === created.id && r.prd)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    if (initial.officeLifecycle.state !== 'open') await request.post('/api/office/close');
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep, pacingSessions: initial.settings.pacingSessions } });
  }
});
