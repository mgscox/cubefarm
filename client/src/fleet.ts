import type { AgentCli, AgentStatus, AgentView, BoxView, RepoView } from '../../shared/types';

// The fleet as the manager's console shows it: which machine each agent works on, and what moving a floor does.

/** Agents who take desks on a box (the CEO and researchers stay on the office's machine). */
export const movable = (a: Pick<AgentView, 'role'>) => a.role === 'dev' || a.role === 'qa';

const BUSY: AgentStatus[] = ['preparing', 'working'];
/** On a task now: it finishes where it started. */
export const busy = (a: Pick<AgentView, 'status'>) => BUSY.includes(a.status);

/** A box's name for the console, mid-sentence: '' is the office's own machine. */
export function boxName(boxes: Pick<BoxView, 'id' | 'name'>[], id: string): string {
  if (!id) return 'this machine';
  return boxes.find((b) => b.id === id)?.name ?? 'a removed box';
}

/** The box an agent's next task starts on: their own, else their floor's. */
export const agentBox = (a: Pick<AgentView, 'box'>, floor: Pick<RepoView, 'box'> | undefined) => a.box ?? floor?.box ?? '';

/** Moving a whole floor to a box: who ends up somewhere new, how many of them finish a task first, and how many own boxes it clears. */
export function floorMove(repo: Pick<RepoView, 'box'>, agents: Pick<AgentView, 'role' | 'box' | 'status'>[], to: string) {
  const team = agents.filter(movable);
  const moving = team.filter((a) => agentBox(a, repo) !== to);
  return { moving: moving.length, busy: moving.filter(busy).length, overrides: team.filter((a) => a.box !== null).length };
}

/** What a floor move says before it happens, or null when nothing would change. */
export function floorMoveText(move: ReturnType<typeof floorMove>, where: string): string | null {
  if (!move.moving && !move.overrides) return null;
  const parts = [`${move.moving} ${move.moving === 1 ? 'agent moves' : 'agents move'} to ${where} as their next task starts.`];
  if (move.busy) parts.push(move.busy === 1 ? '1 of them is mid-task and moves once that task is done.' : `${move.busy} of them are mid-task and move once their tasks are done.`);
  if (move.overrides) parts.push(`Clears ${move.overrides} agent${move.overrides === 1 ? "'s own box" : "s' own boxes"}, so the whole floor follows it.`);
  return parts.join(' ');
}

/**
 * Agents whose coding agent a box doesn't have: their next task there would fail to start. Only an online box says what
 * it has; one that isn't online is waited for, and the office's own machine is checked where agents are hired.
 */
export function missingClis<A extends Pick<AgentView, 'name' | 'cli'>>(agents: A[], box: Pick<BoxView, 'status' | 'clis'> | undefined, defaultCli: AgentCli): A[] {
  if (!box || box.status !== 'online') return [];
  return agents.filter((a) => !box.clis.some((c) => c.id === (a.cli || defaultCli) && c.installed));
}

/**
 * A box's status line: what it runs, what's missing before agents can work there, and why its CLIs' hooks wouldn't
 * reach the office.
 */
export function boxNotes(b: Pick<BoxView, 'status' | 'platform' | 'version' | 'git' | 'ghReady' | 'hookError' | 'clis'>): { info: string; missing: string[]; hooks: string | null } {
  const info = [b.platform, b.version && `cubefarm ${b.version}`, b.git && (/^git\b/i.test(b.git) ? b.git : `git ${b.git}`)].filter(Boolean).join(' · ');
  if (b.status !== 'online') return { info, missing: [], hooks: null };
  const missing: string[] = [];
  if (!b.git) missing.push('git');
  if (!b.ghReady) missing.push('gh auth login');
  if (!b.clis.some((c) => c.installed)) missing.push('a coding-agent CLI');
  return { info, missing, hooks: b.hookError ? `Can't reach the office's hook URL (${b.hookError}): its agents' steps won't reach the office, which follows their transcripts to see when they're done.` : null };
}
