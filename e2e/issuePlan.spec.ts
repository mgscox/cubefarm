import { expect, test } from '@playwright/test';
import type { IdeaView, WorldSnapshot } from '../shared/types';

// Isolated manual planning: stable tracker inputs, inspectable revisions, and no writes from drafting.
test('draft and inspect a demo Issue Plan on an Idea', async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => !url.href.startsWith(baseURL!) && !url.protocol.startsWith('data'), (route) => route.fulfill({ status: 200, body: '' }));
  const initial = await (await request.get('/api/state')).json() as WorldSnapshot;
  // Exercise this slice's manual fixtures without the automatic Ideas worker claiming the same Idea.
  expect((await request.post('/api/office/close')).ok()).toBe(true);
  await request.patch('/api/settings', { data: { tutorialStep: -1 } });
  try {
    const state = async () => await (await request.get('/api/state')).json() as WorldSnapshot;
    // Closing waits for running demo sessions: a developer's script alone takes 35-115 s.
    await expect.poll(async () => (await state()).officeLifecycle.state, { timeout: 150_000 }).toBe('closed');
    // Earlier tests let demo agents finish these issues; restore missing inputs before measuring fixture writes.
    const settled = await state();
    for (const [repoId, title, body] of [
      ['demo-co/pixel-todo', 'Todos should support due dates', 'Add an optional due date and highlight overdue items.'],
      ['demo-co/weather-api', 'Add /forecast endpoint', 'Return a 5-day forecast for a city.'],
    ]) {
      if (settled.repos.find((r) => r.id === repoId)?.issues.some((i) => i.title === title)) continue;
      const seeded = await request.post(`/api/repos/${encodeURIComponent(repoId)}/issues`, { data: { title, body } });
      expect(seeded.ok(), await seeded.text()).toBe(true);
    }
    const issueIds = (s: WorldSnapshot) => s.repos.flatMap((r) => r.issues.map((i) => `${r.id}#${i.number}`));
    const before = issueIds(await (await request.get('/api/state')).json() as WorldSnapshot);
    const idea = await (await request.post('/api/ideas', { data: { description: 'Show the weather on todos due soon' } })).json() as IdeaView;
    await page.goto(`/#idea/${idea.id}`);
    await page.getByRole('button', { name: 'Enter the office' }).click();
    const plan = page.getByRole('region', { name: 'Issue Plan' });
    await expect(page.getByText('No Issue Plan yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Draft demo Issue Plan' }).click();
    await expect(plan.getByText('Revision 1 · drafted from PRD revision 1')).toBeVisible();
    await expect(plan.getByText('4 new · 1 already on the tracker · 3 dependencies · 1 Tracking Parent')).toBeVisible();
    await plan.getByText('Forecast a single day on /forecast', { exact: true }).click();
    await expect(plan.getByText('so this issue holds only the remaining work')).toBeVisible();
    await expect(plan.getByText('A date outside the next 5 days answers 400', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Draft demo Issue Plan' }).click();
    await expect(plan.getByLabel('Issue Plan revision')).toHaveValue('2');
    // The independent review fixture and drafted plans coexist on the same Idea, including after a fresh snapshot.
    await page.getByRole('button', { name: 'Reviewers agree' }).click();
    const review = page.getByRole('region', { name: 'Proposal review' });
    await expect(review.getByRole('note', { name: 'Handoff' })).toBeVisible();
    await expect(plan.getByLabel('Issue Plan revision')).toHaveValue('2');
    await page.reload();
    await page.getByRole('button', { name: 'Enter the office' }).click();
    await expect(review.getByRole('note', { name: 'Handoff' })).toBeVisible();
    await expect(plan.getByLabel('Issue Plan revision')).toHaveValue('2');
    const after = await (await request.get('/api/state')).json() as WorldSnapshot;
    expect(issueIds(after).filter((id) => !before.includes(id))).toEqual([]); // demo merges may close issues; none are created
    expect(after.issuePlans?.filter((p) => p.ideaId === idea.id).map((p) => p.revision)).toEqual([1, 2]);
    expect(errors).toEqual([]);
    expect(after.ideas.find((i) => i.id === idea.id)?.research).toBeUndefined();
    expect(after.proposals.filter((p) => p.ideaId === idea.id)).toEqual([]);
  } finally {
    await request.patch('/api/settings', { data: { tutorialStep: initial.settings.tutorialStep } });
    if (initial.officeLifecycle.state === 'open') await request.post('/api/office/reopen');
  }
});
