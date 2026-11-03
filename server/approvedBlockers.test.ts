import { describe, expect, it } from 'vitest';
import { approvedHold, blockerKey, readBlocker, type BlockerReading, type IdeaIssueOrigin } from './approvedBlockers.ts';

const origin = (over: Partial<IdeaIssueOrigin> = {}): IdeaIssueOrigin => ({
  proposalId: 'p1', entryId: 'e1', step: 'released', tracking: false,
  blockers: [{ ref: 'demo-co/api#7', repo: 'demo-co/api', number: 7 }], ...over,
});
const readings = (r?: BlockerReading) => new Map<string, BlockerReading>(r ? [[blockerKey('DEMO-CO/api', 7), r]] : []);

describe('approvedHold', () => {
  it('leaves ordinary issues and delivered prerequisites to the usual rules', () => {
    expect(approvedHold(null, readings())).toBeNull();
    expect(approvedHold(origin({ blockers: [] }), readings())).toBeNull();
    expect(approvedHold(origin(), readings({ state: 'CLOSED', stateReason: 'completed' }))).toBeNull();
  });

  it.each([
    [undefined, 'not read yet'],
    ['unreadable', 'unreadable'],
    ['missing', 'missing'],
    [{ state: 'OPEN', stateReason: null }, 'open'],
    [{ state: 'OPEN', stateReason: 'reopened' }, 'open'],
    [{ state: 'CLOSED', stateReason: 'not_planned' }, 'closed as not planned, delivery not confirmed'],
    [{ state: 'CLOSED', stateReason: null }, 'closed, delivery not confirmed'],
  ] as [BlockerReading | undefined, string][])('holds on %o', (r, note) => {
    expect(approvedHold(origin(), readings(r))).toBe(`waits for approved prerequisite demo-co/api#7 (${note})`);
  });

  it('holds an unpublished plan entry and a Tracking Parent', () => {
    expect(approvedHold(origin({ blockers: [{ ref: 'plan entry api', repo: null, number: null }] }), readings())).toBe('waits for approved prerequisite plan entry api (not published yet)');
    expect(approvedHold(origin({ tracking: true, blockers: [] }), readings())).toMatch(/^Tracking Parent/);
  });

  it('reads a prerequisite back failing closed', async () => {
    const issue = { repo: 'demo-co/api', number: 7, url: '', title: '', body: '', labels: [], state: 'CLOSED' as const, stateReason: 'completed' };
    expect(await readBlocker(async () => issue)).toEqual({ state: 'CLOSED', stateReason: 'completed' });
    expect(await readBlocker(async () => null)).toBe('missing');
    expect(await readBlocker(async () => { throw new Error('HTTP 502'); })).toBe('unreadable');
  });
});
