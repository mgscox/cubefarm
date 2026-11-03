import { describe, expect, it } from 'vitest';
import { queuedIdea } from './ideas.ts';

const create = (input: unknown, floors: string[] = []) => queuedIdea(input, floors, 'idea-1', 123);

describe('Idea intake', () => {
  it('queues a description before any floors are configured', () => {
    expect(create({ description: '  Easier onboarding  ' })).toEqual({
      id: 'idea-1', createdAt: 123, description: 'Easier onboarding', status: 'queued', links: [], constraints: '', floorHints: [],
    });
  });

  it('keeps identity and queue state under server control', () => {
    expect(create({ description: 'Outcome', id: 'client-id', status: 'approved', createdAt: 0 })).toMatchObject({ id: 'idea-1', status: 'queued', createdAt: 123 });
  });

  it('preserves optional context and deduplicates advisory hints', () => {
    expect(create({ description: 'Connect apps', constraints: '  Keep offline support  ', links: [' https://example.com ', 'https://example.com'], floorHints: ['a/b', 'a/b'] }, ['a/b'])).toMatchObject({
      constraints: 'Keep offline support', links: ['https://example.com'], floorHints: ['a/b'],
    });
  });

  it.each([undefined, null, [], {}, { description: '' }, { description: '  ' }, { description: 42 }, { description: 'x'.repeat(2001) },
    { description: 'Valid', links: 'https://example.com' }, { description: 'Valid', links: [23] },
    { description: 'Valid', links: ['javascript:alert(1)'] }, { description: 'Valid', links: ['not a URL'] },
    { description: 'Valid', floorHints: ['missing/repo'] }, { description: 'Valid', constraints: false },
  ])('rejects malformed intake without queuing: %j', (input) => {
    expect(() => create(input)).toThrow();
  });
});
