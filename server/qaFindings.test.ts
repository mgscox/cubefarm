import { expect, it } from 'vitest';
import { reviewFindings } from './qaFindings.ts';

const ownership = { title: 'Missing ownership check', details: 'Check ownership on every write path, including update.' };

it('carries blockers across rounds without repeating the original finding', () => {
  const first = reviewFindings([], [ownership], []);
  const { id } = first.findings[0];
  expect(first.findings).toEqual([{ ...ownership, id: expect.stringMatching(/^QA-[0-9a-f]+$/), status: 'open' }]);
  const next = reviewFindings(first.findings, [{ ...ownership, title: 'missing ownership check' }], [], first.published);
  expect(next.findings).toEqual(first.findings);
  expect(next.comment).toEqual([`- **${id}** still open`]);

  const fixed = reviewFindings(next.findings, [], [{ id, status: 'resolved', evidence: 'Update rejects cross-account writes.' }], next.published);
  expect(fixed.findings[0]?.status).toBe('resolved');
  expect(fixed.comment).toEqual([`- **${id}** resolved. Update rejects cross-account writes.`]);

  const reopened = reviewFindings(fixed.findings, [ownership], [], fixed.published);
  expect(reopened.findings[0]).toMatchObject({ ...ownership, id, status: 'open' });
  expect(reopened.comment).toEqual([`- **${id}** reopened`]);

  expect(reviewFindings([], [ownership], [], first.published).comment).toEqual([`- **${id}** still open`]);
  expect(reviewFindings(fixed.findings, [], [], first.published).comment).toEqual(fixed.comment);
});

it('requires explicit evidence to close a known blocker', () => {
  const first = reviewFindings([], [ownership], []);
  expect(reviewFindings(first.findings, [], [{ id: 'QA-02', status: 'resolved', evidence: 'Different finding.' }]).findings).toEqual(first.findings);
  expect(reviewFindings(first.findings, [], [{ id: first.findings[0].id, status: 'resolved', evidence: ' ' }]).findings).toEqual(first.findings);
  expect(reviewFindings(first.findings, [], []).comment).toEqual(first.comment);
});
