import { expect } from '@playwright/test';
import { test } from './isolatedDemo';
import type { IdeaView, ProposalView, WorldSnapshot } from '../shared/types';

test('clarify an Idea, reopen its saved PRD, and approve and publish the reviewed plan once', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  await page.addInitScript(() => localStorage.setItem('cubefarm:mode', 'dashboard'));
  await page.setViewportSize({ width: 1100, height: 850 });
  const state = async (): Promise<WorldSnapshot> => (await request.get('/api/state')).json();
  const initial = await state();
  expect((await request.patch('/api/settings', { data: { pacingSessions: 64 } })).ok()).toBe(true);
  for (const repo of initial.repos) {
    expect((await request.patch(`/api/repos/${encodeURIComponent(repo.id)}`, { data: { autoAssign: false } })).ok()).toBe(true);
  }
  expect((await request.post('/api/office/reopen')).ok()).toBe(true);
  const response = await request.post('/api/ideas', { data: {
    description: '[clarify] Help new teammates find the onboarding flow',
    links: ['https://example.com/previous-research'],
  } });
  expect(response.ok()).toBe(true);
  const idea = await response.json() as IdeaView;
  expect(idea.floorHints).toEqual([]);
  await page.goto(`/#idea/${idea.id}`);
  const detail = page.getByRole('article', { name: 'Idea detail' });

  await test.step('Answer the researcher and reopen the saved PRD', async () => {
    await expect(detail.getByRole('status')).toHaveText('Needs clarification', { timeout: 90_000 });
    await expect(detail).toContainText('Who is the primary user');
    await page.screenshot({ path: testInfo.outputPath('idea-clarification.png') });
    await page.getByLabel('Reply to researcher').fill('New teammates finish onboarding in under 3 minutes');
    await page.getByRole('button', { name: 'Reply and resume research' }).click();
    await expect(detail.getByRole('link', { name: 'View PRD revision' })).toBeVisible({ timeout: 150_000 });
    await expect(detail).toContainText('Focused input');
    await expect(detail).toContainText('Received');
    await expect(detail).toContainText('PRD revision 1');
    await expect(detail).toContainText('New teammates finish onboarding in under 3 minutes');
    for (const name of ['Problem', 'Desired outcome', 'Scope', 'Linked evidence', 'Unresolved assumptions', 'Target floors and rationale', 'Measurable acceptance criteria']) {
      await expect(detail.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    const revision = await detail.getByRole('link', { name: 'View PRD revision' }).getAttribute('href');
    expect(revision).toBe(`#idea/${idea.id}/prd/${idea.id}-prd-1`);
    await detail.getByRole('heading', { name: 'Problem', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('idea-prd.png') });
    await page.goto(`/${revision!}`);
    await page.reload();
    await expect(detail.getByRole('heading', { name: 'PRD revision 1', exact: true })).toBeVisible();
    const researchHeading = detail.getByRole('heading', { name: 'Research', exact: true });
    await researchHeading.scrollIntoViewIfNeeded();
    expect((await request.patch(`/api/repos/${encodeURIComponent(initial.repos[0].id)}`, { data: { autoAssign: false } })).ok()).toBe(true);
    await page.waitForTimeout(300); // Deliver the floor event: it must not jump a reader back to the PRD.
    await expect(researchHeading).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.tab-body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('idea-prd-mobile.png') });
    const saved = await state();
    expect(saved.ideaRecords.filter((r) => r.ideaId === idea.id && r.prd)).toHaveLength(1);
  });

  await test.step('Inspect the endorsed revision and verify publication', async () => {
    let proposal: ProposalView | undefined;
    await expect.poll(async () => {
      proposal = (await state()).proposals.find((p) => p.ideaId === idea.id);
      return !!proposal;
    }, { timeout: 120_000 }).toBe(true);
    await page.goto(`/#idea/${idea.id}`);
    await page.setViewportSize({ width: 1100, height: 850 });
    const approval = detail.locator('[aria-label="Approval card"]');
    await expect(approval).toContainText('Endorsed by both reviewers in round 1');
    await expect(approval).toContainText(proposal!.plan.issues[0].title);
    await approval.getByRole('link', { name: 'View PRD', exact: true }).click();
    await expect(page.getByRole('article', { name: 'PRD revision' })).toContainText(proposal!.prd.body.split('\n')[2]);
    await expect(page).toHaveURL(new RegExp(`/prd/${proposal!.id}$`));
    await page.getByRole('link', { name: 'Back to the card' }).click();
    await page.screenshot({ path: testInfo.outputPath('ideas-reviewed-card.png') });
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => (await state()).publications?.find((p) => p.proposalId === proposal!.id)?.status).toBe('complete');
    const duplicate = await request.post(`/api/proposals/${proposal!.id}/decision`, { data: { action: 'approve', prdRevision: proposal!.prd.revision, planRevision: proposal!.plan.revision } });
    expect(duplicate.ok(), await duplicate.text()).toBe(true);
    await expect(detail).toContainText('Published');
    await page.screenshot({ path: testInfo.outputPath('ideas-published.png') });
    expect((await state()).publications?.filter((p) => p.proposalId === proposal!.id)).toHaveLength(1);
  });
  expect(errors).toEqual([]);
});
