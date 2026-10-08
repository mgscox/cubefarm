import { describe, expect, it } from 'vitest';
import { issueSessionWork, recordNoWork, retainNoWork } from './issueWork.ts';
import { deskAhead } from './workspace.ts';
import type { IssueInfo } from '../shared/types.ts';

const issue: IssueInfo = { number: 51, body: 'Brief', labels: ['b', 'a'], title: 'Work', url: '', createdAt: '', ownerCommentAt: '2026-10-08T01:00:00Z' };

describe('no-work reset decisions', () => {
  it('ignores label ordering, old comments and repeated poll data', () => {
    const records = recordNoWork(recordNoWork([], issue), issue);
    expect(retainNoWork(records, [{ ...issue, labels: ['a', 'b'], ownerCommentAt: '2026-10-07T01:00:00Z' }])).toEqual(records);
    expect(records[0].count).toBe(2);
    expect(retainNoWork(records, [])).toEqual([]);
  });
});

describe('local commit inspection', () => {
  it('uses local git with argument arrays, without fetching', async () => {
    const calls: string[][] = [];
    const query: NonNullable<Parameters<typeof deskAhead>[3]> = async (args) => { calls.push(args); return '2'; };
    expect(await deskAhead('demo/repo', 'ada', 'main', query)).toBe(2);
    expect(calls).toEqual([['rev-list', '--count', 'origin/main..HEAD']]);
  });

  it.each(['', 'NaN', '-1', '0.5'])('rejects unavailable counts: %j', async (raw) => {
    await expect(deskAhead('demo/repo', 'ada', 'main', async () => raw)).rejects.toThrow('Local branch comparison unavailable');
  });
});

describe('work produced by a session', () => {
  it('counts an unchanged inherited branch as empty, but a new commit as work', () => {
    const start = { startHead: 'old', localAhead: 3, remoteAhead: 3 };
    expect(issueSessionWork({ ...start, head: 'old' })).toBe('none');
    expect(issueSessionWork({ ...start, head: 'new' })).toBe('commits');
  });

  it('uses verified empty branches after legacy recovery and preserves unknown reads', () => {
    expect(issueSessionWork({ head: null, localAhead: 0, remoteAhead: 0 })).toBe('none');
    expect(issueSessionWork({ head: null, localAhead: null, remoteAhead: 0 })).toBe('unknown');
    expect(issueSessionWork({ head: null, localAhead: 2, remoteAhead: null })).toBe('commits');
  });
});
