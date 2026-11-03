import { describe, expect, it, vi } from 'vitest';
import { CEO_ID, RESEARCHER_ID, type RepoView } from '../../shared/types';
import type { Agent } from './store';
import { workingGroups } from './working';

// The store's helpers come with its sound cues, a browser boundary.
vi.mock('./ui/sfx', () => ({ cue: vi.fn(), chirp: vi.fn() }));

const agent = (id: string, repoId: string, status: Agent['status'], role: Agent['role'] = 'dev', desk = 0) =>
  ({ id, repoId, status, role, desk, color: `#${id}` }) as Agent;
const repo = (id: string, floor: number) => ({ id, floor, fullName: `acme/${id}`, color: `#${id}` }) as RepoView;

const repos = [repo('web', 2), repo('api', 1), repo('docs', 3)];
const agents = Object.fromEntries(
  [
    agent(CEO_ID, '', 'working', 'ceo'),
    agent(RESEARCHER_ID, '', 'preparing', 'researcher'),
    agent('ada', 'api', 'working', 'dev', 1),
    agent('bob', 'api', 'idle', 'dev', 2),
    agent('cy', 'web', 'working', 'qa'),
    agent('di', 'web', 'preparing', 'dev', 3),
    agent('ed', 'docs', 'done'),
  ].map((a) => [a.id, a]),
);

describe('workingGroups', () => {
  it('groups only busy agents by floor, the lobby first and empty floors left out', () => {
    const groups = workingGroups(agents, repos, 0);
    expect(groups.map((g) => [g.key, g.label, g.list.map((a) => a.id)])).toEqual([
      ['hq', 'Lobby', [CEO_ID, RESEARCHER_ID]],
      ['api', '1 · api', ['ada']],
      ['web', '2 · web', ['di', 'cy']],
    ]);
  });

  it('puts the floor you are on right after the lobby', () => {
    expect(workingGroups(agents, repos, 2).map((g) => g.key)).toEqual(['hq', 'web', 'api']);
  });

  it('leaves the lobby out when nobody there is working', () => {
    const quiet = { ...agents, [CEO_ID]: agent(CEO_ID, '', 'idle', 'ceo'), [RESEARCHER_ID]: agent(RESEARCHER_ID, '', 'idle', 'researcher') };
    expect(workingGroups(quiet, repos, 0).map((g) => g.key)).toEqual(['api', 'web']);
    expect(workingGroups({}, repos, 0)).toEqual([]);
  });
});
