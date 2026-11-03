import { expect, test } from '@playwright/test';
import type { IdeaView, ProposalView, WorldSnapshot } from '../shared/types';

// Seeded review handoffs and the demo's fake downstream worker: manager decisions with no tracker writes.
test('approve, refine and reject Proposals from the approval card', async ({ page, request, baseURL }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const initial = await (await request.get('/api/state')).json() as WorldSnapshot;
  const before = new Set(initial.repos.flatMap((r) => r.issues.map((i) => `${r.id}#${i.number}`)));
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  const seeded = async (description: string) => {
    const idea = await (await request.post('/api/ideas', { data: { description } })).json() as IdeaView;
    const proposal = await (await request.post(`/api/ideas/${idea.id}/proposals/demo`)).json() as ProposalView;
    return { idea, proposal };
  };
  const open = async (hash: string) => {
    await page.goto(`/${hash}`);
    await page.reload(); // a hash-only navigation keeps the old page alive
    await page.getByRole('button', { name: 'Enter the office' }).click();
  };
  const card = page.getByRole('region', { name: 'Approval card' });
  try {
    const approved = await seeded('Weekly plan for new teammates');
    await open(`#idea/${approved.idea.id}`);
    await expect(card).toContainText('PRD v3 · Issue Plan v4');
    await expect(card.getByRole('note')).toContainText('A newer draft exists (Issue Plan v5)');
    await expect(card).toContainText('Existing #2');
    await expect(card).toContainText('waits for Serve the weekly plan at /plan');
    await expect(card).toContainText('Two-second load time is still untested');
    await card.getByText('Review history').click();
    await expect(card).toContainText('Round 1');
    await card.getByRole('link', { name: 'View PRD' }).click();
    const prd = page.getByRole('article', { name: 'PRD revision' });
    await expect(prd).toContainText('PRD v3');
    await expect(prd).toContainText('paired with Issue Plan v4');
    await prd.getByRole('link', { name: 'Back to the card' }).click();
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card.getByRole('status')).toContainText('Handed to publication');
    await expect(card.getByRole('status')).toContainText('PRD v3 · Issue Plan v4');
    const again = await request.post(`/api/proposals/${approved.proposal.id}/decision`, { data: { action: 'approve', prdRevision: 3, planRevision: 4 } });
    expect(((await again.json()) as ProposalView).decision?.publication?.status).toBe('accepted');

    const refined = await seeded('Share todos between apps');
    await open(`#idea/${refined.idea.id}`);
    await card.getByRole('button', { name: 'Request refinement' }).click();
    await card.getByLabel('What should change?').fill('Say "weekly" everywhere');
    await card.getByLabel('Wording only (skip a fresh review)').check();
    await card.getByRole('button', { name: 'Send for refinement' }).click();
    await expect(card).toContainText('Wording revision — returned without a fresh review');
    await expect(card).toContainText('PRD v4 · Issue Plan v5');
    await card.getByRole('button', { name: 'Request refinement' }).click();
    await expect(card.getByLabel('Wording only (skip a fresh review)')).not.toBeChecked();
    await card.getByLabel('What should change?').fill('Cache the plan');
    await card.getByRole('button', { name: 'Send for refinement' }).click();
    await expect(card).toContainText('Endorsed by both reviewers in round 1');
    await expect(card).toContainText('PRD v5 · Issue Plan v6');
    await expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await card.getByText('Review history', { exact: false }).click();
    await card.getByText('Earlier Proposal: PRD v3 · Issue Plan v4', { exact: true }).click();
    const original = card.getByRole('region', { name: 'Earlier Proposal PRD v3 · Issue Plan v4', exact: true });
    await expect(original).toContainText('R3 has no evidence teammates follow links from plans.');
    await expect(original).toContainText('Two-second load time is still untested');
    await expect(original).toContainText('Say "weekly" everywhere');
    await original.getByText('Serve the weekly plan at /plan', { exact: true }).click();
    await expect(original).toContainText('Add a read-only');
    await expect(original).toContainText('GET /plan?team=x returns this week\'s items as JSON');
    await expect(original).not.toContainText('Addresses: Cache the plan');
    await page.screenshot({ path: testInfo.outputPath('proposal-earlier-history.png') });
    await original.getByRole('link', { name: 'View PRD v3', exact: true }).click();
    await expect(prd).toContainText('paired with Issue Plan v4');
    await expect(prd).not.toContainText('Revision note');
    await prd.getByRole('link', { name: 'Back to the card' }).click();

    const rejected = await seeded('Help reviewers find context');
    await open(`#idea/${rejected.idea.id}`);
    await card.getByRole('button', { name: 'Reject' }).click();
    await card.getByLabel('Why reject it? (optional)').fill('Not this quarter');
    await card.getByRole('button', { name: 'Reject and archive' }).click();
    const detail = page.getByRole('article', { name: 'Idea detail' });
    await expect(detail.getByRole('status').first()).toHaveText('Archived');
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.screenshot({ path: testInfo.outputPath('proposal-rejected.png') });
    await card.getByRole('button', { name: 'Start a linked Idea' }).click();
    await expect(page.getByLabel('Short description')).toHaveValue('Help reviewers find context');
    await page.getByRole('button', { name: 'Queue Idea', exact: true }).click();
    await expect(detail).toContainText('Continues an earlier Idea');
    await expect(detail.getByRole('link', { name: 'an earlier Idea' })).toHaveAttribute('href', `#idea/${rejected.idea.id}`);

    // Demo agents may complete existing issues while the manager decides; no new implementation issues should appear.
    const after = await (await request.get('/api/state')).json() as WorldSnapshot;
    const added = after.repos.flatMap((r) => r.issues.map((i) => `${r.id}#${i.number}`)).filter((id) => !before.has(id));
    expect(added).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep } });
  }
});
