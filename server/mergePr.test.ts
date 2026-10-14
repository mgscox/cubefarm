import { describe, expect, it } from 'vitest';
import { checkMergePr } from './mergePr.ts';

describe('CEO merge preflight', () => {
  const context = () => ({
    merging: false, syncing: false, parking: false, busy: false,
    qa: { status: 'needs-human' as const, testedSha: 'tested' },
    pull: { state: 'OPEN' as const, headSha: 'tested', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
  });

  it('allows a manager override of failed findings at the tested SHA', () => {
    expect(checkMergePr(13, 'owner/repo', context())).toBe('tested');
  });

  it.each([
    { qa: undefined },
    { qa: { status: 'passed' as const, testedSha: null } },
    { qa: { status: 'testing' as const, testedSha: 'tested' } },
    { qa: { status: 'fixing' as const, testedSha: 'tested' } },
    { pull: { ...context().pull, headSha: 'unseen' } },
    { pull: { ...context().pull, mergeable: 'CONFLICTING' } },
    { pull: { ...context().pull, mergeState: 'DIRTY' } },
    { merging: true }, { syncing: true }, { parking: true }, { busy: true },
  ])('refuses an unsafe override: %j', (patch) => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), ...patch })).toThrow();
  });

  it.each(['CLOSED', 'MERGED'] as const)('refuses %s PRs', (state) => {
    expect(() => checkMergePr(13, 'owner/repo', { ...context(), pull: { ...context().pull, state } })).toThrow('not open');
  });
});
