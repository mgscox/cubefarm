import { describe, expect, it } from 'vitest';
import { parentReadyToClose, retainParentCloses } from './parentClose.ts';
import type { IssueInfo } from '../shared/types.ts';

const parent = (subIssues: IssueInfo['subIssues'], labels: string[] = []) => ({ number: 7, labels, subIssues });
const idle = { openPr: false, working: false, closed: [] };

describe('parentReadyToClose', () => {
  it('closes a parent whose sub-issues are all done', () => {
    expect(parentReadyToClose(parent({ total: 6, completed: 6 }), idle)).toBe(true);
  });

  it('closes a gated ready-for-human parent: the gate only stops agents starting it', () => {
    expect(parentReadyToClose(parent({ total: 2, completed: 2 }, ['Ready-For-Human']), idle)).toBe(true);
  });

  it.each([
    ['partly done', { total: 6, completed: 5 }],
    ['no sub-issues', { total: 0, completed: 0 }],
    ['sub-issues not loaded', null],
    ['parents unsupported', undefined],
  ])('leaves it open when %s', (_name, subIssues) => {
    expect(parentReadyToClose(parent(subIssues), idle)).toBe(false);
  });

  it('leaves it open while a PR closes it or a session works on it', () => {
    expect(parentReadyToClose(parent({ total: 3, completed: 3 }), { ...idle, openPr: true })).toBe(false);
    expect(parentReadyToClose(parent({ total: 3, completed: 3 }), { ...idle, working: true })).toBe(false);
  });

  it('honours the keep-open label in any letter case, and leaves held publications alone', () => {
    expect(parentReadyToClose(parent({ total: 3, completed: 3 }, ['Keep-Open']), idle)).toBe(false);
    expect(parentReadyToClose(parent({ total: 3, completed: 3 }, ['held-for-publication']), idle)).toBe(false);
  });

  it('does not close a parent the manager reopened until a sub-issue count changes', () => {
    const closed = [{ issueNumber: 7, total: 3, completed: 3 }];
    expect(parentReadyToClose(parent({ total: 3, completed: 3 }), { ...idle, closed })).toBe(false);
    expect(parentReadyToClose(parent({ total: 4, completed: 4 }), { ...idle, closed })).toBe(true);
    expect(parentReadyToClose({ ...parent({ total: 3, completed: 3 }), number: 8 }, { ...idle, closed })).toBe(true);
  });
});

describe('retainParentCloses', () => {
  const closed = [{ issueNumber: 7, total: 3, completed: 3 }];

  it('keeps closes of parents that are still closed, unchanged or unread', () => {
    expect(retainParentCloses(closed, [])).toEqual(closed);
    expect(retainParentCloses(closed, [parent({ total: 3, completed: 3 })])).toEqual(closed);
    expect(retainParentCloses(closed, [parent(null)])).toEqual(closed);
  });

  it('forgets a close once the reopened parent counts change, even back to all done', () => {
    expect(retainParentCloses(closed, [parent({ total: 4, completed: 3 })])).toEqual([]);
  });
});
