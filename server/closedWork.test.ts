import { describe, expect, it } from 'vitest';
import { PUBLICATION_HOLD } from '../shared/issues.ts';
import { closedWork, issueClosed, type FloorWork } from './closedWork.ts';

describe('closed work', () => {
  const dev = { id: 'd1', role: 'dev' as const, task: 'issue' as const, status: 'working' as const, issueNumber: 7, prNumber: null };
  const floor = (patch: Partial<FloorWork> = {}): FloorWork => ({ pulls: [], openIssues: new Set([7]), parkedPrs: new Set(), ...patch });

  it('leaves an open issue alone', () => expect(closedWork(dev, floor())).toBeNull());
  it('flags an issue gone from the open list', () => expect(closedWork(dev, floor({ openIssues: new Set() }))).toEqual({ kind: 'issue', number: 7 }));
  it('flags it while the desk is still preparing', () => {
    expect(closedWork({ ...dev, status: 'preparing' }, floor({ openIssues: new Set() }))).toEqual({ kind: 'issue', number: 7 });
  });
  it('waits when the issues could not be read', () => expect(closedWork(dev, floor({ openIssues: null }))).toBeNull());
  it.each(['idle', 'done', 'stopped', 'error'] as const)('ignores a %s agent', (status) => {
    expect(closedWork({ ...dev, status }, floor({ openIssues: new Set() }))).toBeNull();
  });
  it('ignores the CEO', () => expect(closedWork({ ...dev, role: 'ceo' }, floor({ openIssues: new Set() }))).toBeNull());

  const fixer = { ...dev, task: 'fix' as const, prNumber: 12 };
  const tester = { ...dev, role: 'qa' as const, task: 'qa' as const, prNumber: 12 };
  it.each([['a fix', fixer], ['QA', tester]])('flags %s on a PR closed unmerged', (_, a) => {
    expect(closedWork(a, floor({ pulls: [{ number: 12, state: 'CLOSED' }] }))).toEqual({ kind: 'pr', number: 12 });
  });
  it.each([['a fix', fixer], ['QA', tester]])('flags %s on a PR the open and merged lists leave out, to be read back', (_, a) => {
    expect(closedWork(a, floor({ pulls: [{ number: 13, state: 'OPEN' }] }))).toEqual({ kind: 'pr', number: 12 });
  });
  it('checks an unlisted PR on an issue task through its issue', () => {
    expect(closedWork({ ...dev, prNumber: 12 }, floor())).toBeNull();
    expect(closedWork({ ...dev, prNumber: 12 }, floor({ openIssues: new Set() }))).toEqual({ kind: 'issue', number: 7 });
  });
  it('leaves an open PR alone', () => expect(closedWork(fixer, floor({ pulls: [{ number: 12, state: 'OPEN' }] }))).toBeNull());
  it('leaves a merged PR to the merge flow, even once its issue closes', () => {
    expect(closedWork({ ...dev, prNumber: 12 }, floor({ pulls: [{ number: 12, state: 'MERGED' }], openIssues: new Set() }))).toBeNull();
  });
  it.each([[[{ number: 12, state: 'CLOSED' as const }]], [[]]])('leaves a CEO-parked PR alone: %j', (pulls) => {
    expect(closedWork(fixer, floor({ pulls, parkedPrs: new Set([12]) }))).toBeNull();
  });
  it('checks only issue tasks for a closed issue', () => {
    expect(closedWork({ ...fixer, issueNumber: 7 }, floor({ pulls: [{ number: 12, state: 'OPEN' }], openIssues: new Set() }))).toBeNull();
    expect(closedWork({ ...tester, issueNumber: 7 }, floor({ pulls: [{ number: 12, state: 'OPEN' }], openIssues: new Set() }))).toBeNull();
  });
});

describe('issueClosed', () => {
  it('confirms a closed issue', () => expect(issueClosed({ state: 'CLOSED', labels: [] })).toBe(true));
  it('keeps an open one', () => expect(issueClosed({ state: 'OPEN', labels: [] })).toBe(false));
  it('leaves an Ideas issue held for publication', () => expect(issueClosed({ state: 'CLOSED', labels: [PUBLICATION_HOLD] })).toBe(false));
  it('does not guess about an issue it could not find', () => expect(issueClosed(null)).toBe(false));
});
