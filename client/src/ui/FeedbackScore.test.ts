import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeedbackScore, scoreEventLine } from './FeedbackScore';

it('shows Authorship and Repair with sample counts beside the labelled legacy score', () => {
  const scores = { authorship: { points: 1, events: 2 }, repair: { points: -1, events: 1 }, neutral: 3 };
  const html = renderToStaticMarkup(createElement(FeedbackScore, { agent: { role: 'dev', score: 4, scores } }));
  expect(html).toContain('Authorship +1 · 2 events</span>');
  expect(html).toContain('Repair -1 · 1 event</span>');
  expect(html).toContain('Legacy +4</span>');
  expect(html).toContain('3 events recorded with no score change');
});

it('starts new scores at zero when none are recorded', () => {
  const html = renderToStaticMarkup(createElement(FeedbackScore, { agent: { role: 'dev', score: -1 } }));
  expect(html).toContain('Authorship 0 · 0 events</span>');
  expect(html).toContain('Repair 0 · 0 events</span>');
  expect(html).toContain('Legacy -1</span>');
});

it.each(['qa', 'researcher', 'ceo'] as const)('hides feedback scores for %s agents', (role) => {
  expect(renderToStaticMarkup(createElement(FeedbackScore, { agent: { role, score: 0 } }))).toBe('');
});

it('explains a score event and marks one a correction voided', () => {
  const event = { id: 'authorship:defect:r1#7:f-1', repoId: 'r1', prNumber: 7, agentId: 'ada', name: 'Ada', score: 'authorship' as const, points: -1,
    rule: 'original-defect' as const, reason: 'Confirmed defect "toolbar" from the original implementation', evidence: {}, at: 0 };
  expect(scoreEventLine(event)).toBe('PR #7 · Ada · Authorship -1 · Confirmed defect "toolbar" from the original implementation');
  expect(scoreEventLine({ ...event, score: null, points: 0, name: null, agentId: null, reason: 'QA fail scored nothing' }, event))
    .toBe('PR #7 · Unknown author · No score change · QA fail scored nothing (voided)');
});
