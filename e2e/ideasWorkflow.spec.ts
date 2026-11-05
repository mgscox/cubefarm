import { expect } from '@playwright/test';
import { test } from './isolatedDemo';
import type { IdeaView, ProposalView, WorldSnapshot } from '../shared/types';

test('description to reviewed card, exact View PRD, one approval and verified publication', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const state = async () => await (await request.get('/api/state')).json() as WorldSnapshot;
  const initial = await state();
  await request.patch('/api/settings', { data: { tutorialStep: -1, pacingSessions: 64 } });
  for (const r of initial.repos) await request.patch(`/api/repos/${encodeURIComponent(r.id)}`, { data: { autoAssign: false } });
  await request.post('/api/office/reopen');
  try {
    const response = await request.post('/api/ideas', { data: { description: 'Help new teammates complete onboarding' } });
    expect(response.ok()).toBe(true);
    const idea = await response.json() as IdeaView;
    expect(idea.floorHints).toEqual([]);
    let proposal: ProposalView | undefined;
    await expect.poll(async () => {
      proposal = (await state()).proposals.find((p) => p.ideaId === idea.id);
      return !!proposal;
    }, { timeout: 120_000 }).toBe(true);
    await page.goto(`/#idea/${idea.id}`);
    await page.getByRole('button', { name: 'Enter the office' }).click();
    await page.setViewportSize({ width: 1100, height: 850 });
    const detail = page.getByRole('article', { name: 'Idea detail' });
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
    expect(errors).toEqual([]);
  } finally {
    await request.post('/api/office/close');
    for (const r of initial.repos) await request.patch(`/api/repos/${encodeURIComponent(r.id)}`, { data: { autoAssign: r.autoAssign } });
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep, pacingSessions: initial.settings.pacingSessions } });
    if (initial.officeLifecycle.state === 'open') await request.post('/api/office/reopen');
  }
});
