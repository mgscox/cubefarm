import { describe, expect, it, vi } from 'vitest';
import { qaCi } from './github.ts';

describe('exact-revision QA CI evidence', () => {
  it('retains paginated check IDs, Actions run IDs, and commit status conclusions at the requested SHA', async () => {
    const api = vi.fn(async (args: string[]) => args[1].includes('check-runs')
      ? args[1].includes('page=2') ? { total_count: 2, check_runs: [{ id: 8, name: 'Windows', status: 'queued', conclusion: null, html_url: null }] }
        : { total_count: 2, check_runs: [{ id: 7, name: 'Unit tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/42/job/7' }] }
      : { total_count: 1, statuses: [{ id: 9, context: 'Deploy', state: 'failure', target_url: 'https://example.invalid/deploy' }] });
    const ci = await qaCi('o/r', 'tested-head', api);
    expect(api.mock.calls.map(([args]) => args[1])).toEqual(['repos/o/r/commits/tested-head/check-runs?per_page=100&page=1', 'repos/o/r/commits/tested-head/status?per_page=100&page=1', 'repos/o/r/commits/tested-head/check-runs?per_page=100&page=2']);
    expect(ci).toMatchObject({ headSha: 'tested-head', availability: 'available', checks: [
      { id: '7', runId: '42', conclusion: 'success' }, { id: '8', runId: null, conclusion: null }, { id: '9', runId: null, conclusion: 'failure' },
    ] });
  });

  it('preserves partial evidence without calling missing checks successful', async () => {
    const api = vi.fn(async (args: string[]) => {
      if (args[1].includes('check-runs')) throw new Error('Unavailable');
      return { total_count: 1, statuses: [{ context: 'Deploy', state: 'pending', target_url: null }] };
    });
    expect(await qaCi('o/r', 'old-head', api)).toMatchObject({ headSha: 'old-head', availability: 'unavailable', checks: [{ id: null, runId: null, conclusion: 'pending' }] });
  });
});
