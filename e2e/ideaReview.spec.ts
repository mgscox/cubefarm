import { expect, test } from '@playwright/test';
import type { IdeaView, WorldSnapshot } from '../shared/types';

// The demo review fixture: a first-round joint endorsement, and disagreement capped at three rounds.
test('review a fixture PRD to a manager handoff, endorsed or capped', async ({ page, request, baseURL }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const initial = await (await request.get('/api/state')).json() as WorldSnapshot;
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  const submit = async (description: string) => (await (await request.post('/api/ideas', { data: { description } })).json()) as IdeaView;
  const agreed = await submit('Reviewers will agree on this');
  const contested = await submit('Reviewers will keep disagreeing on this');
  const detail = page.getByRole('article', { name: 'Idea detail' });
  const open = async (idea: IdeaView) => {
    await page.goto(`/#idea/${idea.id}`);
    await page.reload();
    await page.getByRole('button', { name: 'Enter the office' }).click();
    await expect(detail).toContainText(idea.description);
  };
  try {
    await open(agreed);
    await detail.getByRole('button', { name: 'Reviewers agree' }).click();
    await expect(detail.getByRole('status')).toHaveText('Proposed · endorsed', { timeout: 30_000 });
    await expect(detail.getByRole('note', { name: 'Handoff' })).toHaveText('For your decision: PRD r1 with Issue Plan r1');
    await expect(detail.getByRole('listitem', { name: /^Round/ })).toHaveCount(1);
    await expect(detail.getByText('Endorsed r1')).toHaveCount(2);
    await expect(detail.getByRole('button', { name: 'Reviewers agree' })).toHaveCount(0);

    await open(contested);
    await detail.getByRole('button', { name: 'Reviewers disagree' }).click();
    await expect(detail.getByRole('status')).toHaveText('Proposed · 1 open finding', { timeout: 60_000 });
    const handoff = detail.getByRole('note', { name: 'Handoff' });
    await expect(handoff).toContainText('For your decision: PRD r3 with Issue Plan r3');
    await expect(handoff).toContainText('Step 2 depends on a floor that has no QA tester yet.');
    await expect(detail.getByRole('listitem', { name: /^Round/ })).toHaveCount(3);
    await expect(detail.getByRole('listitem', { name: 'Round 1' })).toContainText('2 findings on r1');
    await expect(detail).toContainText('No joint endorsement after 3 rounds');

    const after = await (await request.get('/api/state')).json() as WorldSnapshot;
    expect(after.ideaReviews.filter((r) => r.ideaId === agreed.id || r.ideaId === contested.id).map((r) => r.handoff?.endorsed)).toEqual([true, false]);
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep } });
  }
});
