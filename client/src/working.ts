// Who is working right now, grouped by where they work: the lobby (the CEO and the company researcher), then the floors.
import { CEO_ID, RESEARCHER_ID, type RepoView } from '../../shared/types';
import { agentsOnRepo, isBusy, type Agent } from './store';

export interface WorkingGroup {
  key: string;
  label: string;
  title: string;
  color: string;
  list: Agent[];
}

/** Groups with someone working in them: the lobby, then the floor you're on, then the other floors by number. */
export function workingGroups(agents: Record<string, Agent>, repos: RepoView[], floor: number): WorkingGroup[] {
  const lobby = [agents[CEO_ID], agents[RESEARCHER_ID]].filter((a): a is Agent => !!a && isBusy(a));
  const floors = [...repos].sort((x, y) => (x.floor === floor ? -1 : y.floor === floor ? 1 : x.floor - y.floor));
  return [
    ...(lobby.length ? [{ key: 'hq', label: 'Lobby', title: 'The lobby: the CEO and the company researcher', color: lobby[0].color, list: lobby }] : []),
    ...floors.map((r) => ({
      key: r.id,
      label: `${r.floor} · ${r.fullName.split('/')[1]}`,
      title: `Floor ${r.floor}: ${r.fullName}`,
      color: r.color,
      list: agentsOnRepo(agents, r.id).filter(isBusy),
    })),
  ].filter((g) => g.list.length > 0);
}
