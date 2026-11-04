import { describe, expect, it } from 'vitest';
import { failedRunIds } from './checkRuns.ts';

describe('failedRunIds', () => {
  const ids = (...urls: (string | null)[]) => failedRunIds(urls.map((url) => ({ name: 'CI', url })));

  it('returns numeric IDs once per run, including job URLs and enterprise hosts', () => {
    expect(ids('https://github.com/o/r/actions/runs/42', 'https://github.com/o/r/actions/runs/42/job/99',
      'https://git.example.com/o/r/actions/runs/73?attempt=2#logs', 'https://github.com/o/r/actions/runs/74/jobs/98')).toEqual([42, 73, 74]);
  });

  it.each([null, '', 'not a URL', 'https://vercel.com/o/r/42', 'https://github.com/o/r/checks/42',
    'https://github.com/o/r/actions/runs/42oops', 'https://github.com/o/r/actions/runs/42/other',
    'https://github.com/o/r/actions/runs/1e3', 'https://github.com/o/r/actions/runs/-42',
    'https://github.com/o/r/actions/runs/0', 'https://github.com/o/r/actions/runs/9007199254740993',
    'https://github.com/o/r/actions/runs/42%3Bwhoami', 'file:///o/r/actions/runs/42'])('ignores invalid or non-run URLs: %s', (url) => {
    expect(ids(url)).toEqual([]);
  });
});
