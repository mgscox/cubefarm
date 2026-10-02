import { describe, expect, it } from 'vitest';
import { checkParkPr } from './parkPr.ts';

describe('parking preflight', () => {
  const free = { merging: false, syncing: false, parking: false, busy: false };
  it('permits stale fixing and queued records without live work', () => {
    expect(() => checkParkPr(13, 'demo/repo', { ...free, status: 'fixing' })).not.toThrow();
    expect(() => checkParkPr(13, 'demo/repo', { ...free, status: 'queued' })).not.toThrow();
  });
  it.each(['merging', 'syncing', 'parking', 'busy'] as const)('refuses %s', (condition) => {
    expect(() => checkParkPr(13, 'demo/repo', { ...free, [condition]: true })).toThrow();
  });
  it('always refuses active QA', () => {
    expect(() => checkParkPr(13, 'demo/repo', { ...free, status: 'testing' })).toThrow('wait until QA or its fix finishes');
  });
});
