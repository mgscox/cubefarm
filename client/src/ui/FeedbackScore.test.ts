import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FeedbackScore } from './FeedbackScore';

it('shows a signed developer score and explains how it is earned', () => {
  const html = renderToStaticMarkup(createElement(FeedbackScore, { agent: { role: 'dev', score: 4 } }));
  expect(html).toContain('Score +4</span>');
  expect(html).toContain('title="+2 per merged PR, -1 per QA send-back"');
});

it.each([[0, '0'], [-1, '-1']])('shows a developer score of %s as %s', (score, label) => {
  expect(renderToStaticMarkup(createElement(FeedbackScore, { agent: { role: 'dev', score } }))).toContain(`Score ${label}</span>`);
});

it.each(['qa', 'researcher', 'ceo'] as const)('hides feedback scores for %s agents', (role) => {
  expect(renderToStaticMarkup(createElement(FeedbackScore, { agent: { role, score: 0 } }))).toBe('');
});
