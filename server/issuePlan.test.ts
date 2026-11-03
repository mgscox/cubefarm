import { describe, expect, it } from 'vitest';
import { coveredItems, dependencyCycle, draftIssuePlan, MAX_ACCEPTANCE, normalized, type PlanContext } from './issuePlan.ts';
import { DEMO_TODO, DEMO_WEATHER, demoPlanDraft, demoPrd } from './planFixture.ts';
import type { IssueInfo } from '../shared/types.ts';

const issue = (repo: string, number: number, title: string, body = ''): IssueInfo => ({
  number, title, body, url: `https://github.com/${repo}/issues/${number}`, labels: [], createdAt: '2026-11-01T00:00:00Z',
});
const open: Record<string, IssueInfo[]> = {
  'a/app': [issue('a/app', 4, 'Add dark mode', 'Users want a dark theme.\n- [ ] Toggle in settings\n- [x] Persist the choice')],
  'a/api': [issue('a/api', 7, 'Add /forecast endpoint', 'Return a 5-day forecast for a city.')],
};
const ctx: PlanContext = {
  prd: { ideaId: 'idea-1', revision: 3, requirements: [{ id: 'R1', text: 'One' }, { id: 'R2', text: 'Two' }] },
  floors: ['a/app', 'a/api'],
  openIssues: (repo) => open[repo] ?? [],
  specialties: (repo) => (repo === 'a/app' ? ['frontend'] : []),
};
const work = (key: string, more: Record<string, unknown> = {}) => ({
  key, repo: 'a/app', requirement: 'R1', title: `Build the ${key} part`, brief: 'Do it.', acceptance: [`${key} works in a test`], ...more,
});
const draft = (input: unknown) => draftIssuePlan(input, ctx);
const problems = (input: unknown) => {
  const r = draft(input);
  return r.ok ? [] : r.problems;
};

describe('Issue Plan drafting', () => {
  it('saves a flat plan of new issues citing their PRD requirement', () => {
    const r = draft({ entries: [work('one'), work('two', { repo: 'a/api', requirement: 'R2', specialty: undefined })] });
    expect(r).toEqual({
      ok: true,
      parents: [],
      dependencies: [],
      entries: [
        { key: 'one', kind: 'new', repo: 'a/app', title: 'Build the one part', brief: 'Do it.', acceptance: ['one works in a test'], requirement: { id: 'R1', text: 'One' } },
        { key: 'two', kind: 'new', repo: 'a/api', title: 'Build the two part', brief: 'Do it.', acceptance: ['two works in a test'], requirement: { id: 'R2', text: 'Two' } },
      ],
    });
  });

  it('turns an exact title match into a reference to the existing issue', () => {
    const r = draft({ entries: [work('dark', { title: 'add dark mode.' })] });
    expect(r.ok && r.entries[0]).toEqual({
      key: 'dark', kind: 'existing', repo: 'a/app', title: 'Add dark mode', brief: '', acceptance: [], requirement: { id: 'R1', text: 'One' },
      issue: { number: 4, url: 'https://github.com/a/app/issues/4', title: 'Add dark mode' },
    });
  });

  it('reuses a named open issue and refuses one that is not open', () => {
    expect(draft({ entries: [work('dark', { existing: 4, title: undefined })] })).toMatchObject({ ok: true, entries: [{ kind: 'existing', issue: { number: 4 } }] });
    expect(problems({ entries: [work('gone', { existing: 9 })] })).toEqual(["Issue gone: a/app#9 is not an open issue, so it can't be reused."]);
    expect(problems({ entries: [work('x', { existing: 4 }), work('y', { existing: 4 })] })).toEqual(['x and y both reuse a/app#4; keep one.']);
  });

  it('keeps only the remaining work of a partial overlap, and reuses an overlap that leaves nothing', () => {
    const r = draft({ entries: [work('day', { repo: 'a/api', overlaps: 7, acceptance: ['Return a 5-day forecast for a city', 'Accept a date'] })] });
    expect(r.ok && r.entries[0]).toMatchObject({ kind: 'new', acceptance: ['Accept a date'], covered: ['Return a 5-day forecast for a city'], issue: { number: 7 } });
    const all = draft({ entries: [work('toggle', { overlaps: 4, acceptance: ['- [ ] toggle in settings', 'Persist the choice.'] })] });
    expect(all.ok && all.entries[0]).toMatchObject({ kind: 'existing', issue: { number: 4 }, acceptance: [] });
  });

  it('refuses an overlap without criteria instead of dropping its work', () => {
    for (const acceptance of [undefined, [], [null, ' ']]) {
      expect(problems({ entries: [work('theme', { title: 'Customize theme colors', overlaps: 4, acceptance })] })).toEqual(['Issue theme needs measurable acceptance criteria.']);
    }
  });

  it('checks titles, briefs, criteria, floors, requirements and specialties', () => {
    expect(problems({ entries: [{ key: 'k', repo: 'a/app', requirement: 'R1', title: 'Fix', brief: '', acceptance: [] }] })).toEqual([
      'Issue k needs an actionable title of a few words, at most 100 characters.',
      'Issue k needs a brief of at most 8000 characters.',
      'Issue k needs measurable acceptance criteria.',
    ]);
    const many = Array.from({ length: MAX_ACCEPTANCE + 1 }, (_, i) => `criterion ${i}`);
    expect(problems({ entries: [work('big', { acceptance: many })] })).toEqual([`Issue big has ${MAX_ACCEPTANCE + 1} acceptance criteria; one session covers at most ${MAX_ACCEPTANCE}, so split it.`]);
    expect(problems({ entries: [work('far', { repo: 'b/other' }), work('why', { requirement: 'R9' })] })).toEqual([
      'Issue far: "b/other" is not a configured floor.',
      'Issue why must cite a requirement of PRD revision 3 (R1, R2).',
    ]);
    expect(problems({ entries: [work('ui', { specialty: 'Frontend' }), work('db', { specialty: 'databases' })] })).toEqual([
      'Issue db: nobody on a/app has the specialty "databases"; leave it out for anyone.',
    ]);
    expect(draft({ entries: [work('ui', { specialty: 'Frontend' })] })).toMatchObject({ ok: true, entries: [{ specialty: 'frontend' }] });
    expect(problems({ entries: [] })).toEqual(['A plan needs at least one implementation issue.']);
    expect(problems({ entries: [work('same', { title: 'Do the thing' }), work('again', { title: 'do the thing' })] })).toEqual(['same and again propose the same issue on a/app; merge them.']);
  });

  it('groups work under optional Tracking Parents, never existing issues', () => {
    const parents = [{ key: 'group', repo: 'a/app', title: 'Theme work' }];
    expect(draft({ parents, entries: [work('one', { parent: 'group' })] })).toMatchObject({
      ok: true, parents: [{ key: 'group', repo: 'a/app', title: 'Theme work', summary: '' }], entries: [{ parent: 'group' }],
    });
    expect(problems({ parents, entries: [work('one', { existing: 4, parent: 'group' })] })).toEqual([
      "Issue one reuses a/app#4, which stays untouched, so it can't join a Tracking Parent.",
      'Tracking Parent group groups no issues; drop it or group related work under it.',
    ]);
    expect(problems({ parents, entries: [work('group'), work('two', { parent: 'nope' })] })).toEqual([
      'The key "group" is used twice; keys are unique across issues and Tracking Parents.',
      'Issue two: "nope" is not a Tracking Parent in this plan.',
      'Tracking Parent group groups no issues; drop it or group related work under it.',
    ]);
  });

  it('keeps dependency edges separate, unambiguous and acyclic', () => {
    const entries = [work('a'), work('b'), work('c'), work('old', { existing: 4 })];
    expect(draft({ entries, dependencies: [{ issue: 'b', blockedBy: 'a' }, { issue: 'b', blockedBy: 'a' }, { issue: 'c', blockedBy: 'old' }] })).toMatchObject({
      ok: true, dependencies: [{ issue: 'b', blockedBy: 'a' }, { issue: 'c', blockedBy: 'old' }],
    });
    expect(problems({ entries, dependencies: [{ issue: 'a', blockedBy: 'b' }, { issue: 'b', blockedBy: 'c' }, { issue: 'c', blockedBy: 'a' }] })).toEqual([
      "Dependencies form a cycle (a waits for b waits for c waits for a); remove an edge that isn't a true blocker.",
    ]);
    expect(problems({ entries, dependencies: [{ issue: 'a', blockedBy: 'a' }, { issue: 'old', blockedBy: 'a' }, { issue: 'a', blockedBy: '#4' }] })).toEqual([
      "Dependency a on a: an issue can't wait for itself.",
      "Dependency old on a: old reuses a/app#4, which stays untouched, so it can't gain a blocker.",
      'Dependency a on #4: "#4" is not an issue key in this plan.',
    ]);
    expect(problems({ parents: [{ key: 'p', repo: 'a/app', title: 'Group' }], entries: [work('a', { parent: 'p' })], dependencies: [{ issue: 'a', blockedBy: 'p' }] })).toEqual([
      "Dependency a on p: Tracking Parents group work; they can't block or be blocked.",
    ]);
  });

  it('keeps identifiers distinct when matching titles and coverage, while ignoring formatting', () => {
    const repo = 'a/ids';
    const ids = [issue(repo, 1, 'Return the user_id field', 'The JSON response includes user_id.')];
    const idCtx: PlanContext = { ...ctx, floors: [repo], openIssues: () => ids };
    const entry = { key: 'k', repo, requirement: 'R1', title: 'Return the userid field', brief: 'Add userid.', acceptance: ['The JSON response includes userid'] };
    expect(draftIssuePlan({ entries: [entry] }, idCtx)).toMatchObject({ ok: true, entries: [{ kind: 'new', brief: 'Add userid.', acceptance: ['The JSON response includes userid'] }] });
    const overlap = draftIssuePlan({ entries: [{ ...entry, title: 'Expose the id', overlaps: 1 }] }, idCtx);
    expect(overlap).toMatchObject({ ok: true, entries: [{ kind: 'new', brief: 'Add userid.', acceptance: ['The JSON response includes userid'], covered: [] }] });
    expect(draftIssuePlan({ entries: [{ ...entry, title: '**Return the `user_id` field**' }] }, idCtx)).toMatchObject({ ok: true, entries: [{ kind: 'existing', issue: { number: 1 } }] });
    const formatted = draftIssuePlan({ entries: [{ ...entry, title: 'Expose the id', overlaps: 1, acceptance: ['- [ ] The JSON response includes `user_id`', '_Also_ the email'] }] }, idCtx);
    expect(formatted).toMatchObject({ ok: true, entries: [{ kind: 'new', acceptance: ['_Also_ the email'], covered: ['- [ ] The JSON response includes `user_id`'] }] });
    expect(normalized('__init__ and snake_case_name')).toBe('init and snake_case_name');
  });

  it('keeps underscores at the edges of inline code, so `_user` and `__init__` stay new work', () => {
    const repo = 'a/ids';
    for (const [code, plain] of [['_user', 'user'], ['user_', 'user'], ['__init__', 'init']]) {
      const ids = [issue(repo, 1, `Return the \`${code}\` field`, `The JSON response includes \`${code}\`.`)];
      const idCtx: PlanContext = { ...ctx, floors: [repo], openIssues: () => ids };
      const entry = { key: 'k', repo, requirement: 'R1', title: `Return the \`${plain}\` field`, brief: `Add ${plain}.`, acceptance: [`The JSON response includes \`${plain}\``] };
      const fresh = { kind: 'new', brief: `Add ${plain}.`, acceptance: [`The JSON response includes \`${plain}\``] };
      expect(draftIssuePlan({ entries: [entry] }, idCtx)).toMatchObject({ ok: true, entries: [fresh] });
      expect(draftIssuePlan({ entries: [{ ...entry, title: 'Expose the field', overlaps: 1 }] }, idCtx)).toMatchObject({ ok: true, entries: [{ ...fresh, covered: [] }] });
      expect(draftIssuePlan({ entries: [{ ...entry, title: `**Return the \`${code}\` field**` }] }, idCtx)).toMatchObject({ ok: true, entries: [{ kind: 'existing', issue: { number: 1 } }] });
    }
    expect(normalized('**Call `__init__`** and `` a`b ``')).toBe('call __init__ and a`b');
  });

  it('finds cycles and normalizes comparable text', () => {
    expect(dependencyCycle([{ issue: 'a', blockedBy: 'b' }, { issue: 'b', blockedBy: 'c' }])).toBeNull();
    expect(dependencyCycle([{ issue: 'x', blockedBy: 'a' }, { issue: 'a', blockedBy: 'a' }])).toEqual(['a', 'a']);
    expect(normalized('  1. **Persist**   the choice!  ')).toBe('persist the choice');
    expect([...coveredItems('One thing. Two things!\n* [X] Three')]).toEqual(['one thing', 'two things', 'three']);
  });

  it('drafts the two-floor demo plan with reuse, remaining work, a parent and cross-floor blockers', () => {
    const demo: Record<string, IssueInfo[]> = {
      [DEMO_TODO]: [issue(DEMO_TODO, 2, 'Todos should support due dates')],
      [DEMO_WEATHER]: [issue(DEMO_WEATHER, 1, 'Add /forecast endpoint', 'Return a 5-day forecast for a city.')],
    };
    const openIssues = (repo: string) => demo[repo] ?? [];
    const r = draftIssuePlan(demoPlanDraft(openIssues), { prd: demoPrd('i'), floors: [DEMO_TODO, DEMO_WEATHER], openIssues, specialties: () => [] });
    if (!r.ok) throw new Error(r.problems.join('\n'));
    expect(r.entries.map((e) => [e.key, e.kind, e.repo, e.issue?.number, e.parent])).toEqual([
      ['due-dates', 'existing', DEMO_TODO, 2, undefined],
      ['forecast-day', 'new', DEMO_WEATHER, 1, undefined],
      ['forecast-cache', 'new', DEMO_WEATHER, undefined, undefined],
      ['weather-badge', 'new', DEMO_TODO, undefined, 'weather-parent'],
      ['hide-weather', 'new', DEMO_TODO, undefined, 'weather-parent'],
    ]);
    expect(r.entries[1].covered).toEqual(['Return a 5-day forecast for a city.']);
    expect(r.entries[1].acceptance).toHaveLength(2);
    expect(r.dependencies).toHaveLength(3);
  });
});
