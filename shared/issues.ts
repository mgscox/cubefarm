// Issue conventions shared by the server's scheduler and the client's whiteboard.
import type { IssueInfo } from './types.ts';

export const AGENT_COMMENT_MARKER = '<!-- cubefarm:agent -->';
const ISSUE_URL = 'https://github\\.com/([\\w.-]+)/([\\w.-]+)/issues/(\\d+)';
const DEPENDENCY = new RegExp(`\\b(?:depends\\s+on|blocked\\s+by)\\s*:?\\s*(?:(?:#\\d+|${ISSUE_URL})(?:\\s*(?:,|and|&)\\s*)?)+`, 'gi');

/** Full issue URLs in dependency statements; unrelated links do not block work. */
export function dependencyUrls(body: string) {
  const refs = new Map<string, { repo: string; number: number }>();
  for (const statement of (body ?? '').matchAll(DEPENDENCY)) {
    for (const m of statement[0].matchAll(new RegExp(ISSUE_URL, 'gi'))) {
      const repo = `${m[1]}/${m[2]}`.toLowerCase();
      refs.set(`${repo}#${m[3]}`, { repo, number: Number(m[3]) });
    }
  }
  return [...refs.values()];
}

/** The specialty an issue is routed to, from its swarm:<specialty> label ('' = anyone). */
export function issueSpecialty(labels: string[]) {
  const l = labels.find((x) => /^swarm:/i.test(x) && !/^swarm:skip$/i.test(x));
  return l ? l.slice(6).toLowerCase() : '';
}

/** The specialty of research issues (swarm:research): only a floor's researchers take them, and only them. */
export const RESEARCH = 'research';

/** Branches of research docs. Their pull requests skip QA: there is nothing to test. */
export const RESEARCH_BRANCH = 'swarm/research-';

export const isResearchIssue = (labels: string[]) => issueSpecialty(labels) === RESEARCH;

/** The label the manager puts on issues that need a person (hardware, live servers, accounts, sign-off). */
export const READY_FOR_HUMAN = 'ready-for-human';

/** Whether an issue is reserved for a human: agents never get it, whatever its letter case. */
export function forHuman(labels: string[]) {
  return labels.some((l) => l.toLowerCase() === READY_FOR_HUMAN);
}

/** Preparation gates that must be cleared before automatic or explicit agent starts. */
export function issueReadinessReason(issue: Pick<IssueInfo, 'labels' | 'title'>) {
  if (issue.labels.some((l) => /^needs-triage$/i.test(l))) return 'needs triage';
  if (issue.labels.some((l) => /^needs-info$/i.test(l))) return 'waiting for info';
  if (/^(?:\[Draft\]|Draft:)/i.test(issue.title)) return 'draft';
  return null;
}

/** Whether the office may hand an issue to an agent, without requiring ready-for-agent. */
export function schedulable(labels: string[], title = '') {
  return !issueReadinessReason({ labels, title }) && !forHuman(labels) && !labels.some((l) => /^(swarm:skip|wontfix|question)$/i.test(l));
}

/** Open issues this issue waits for, from "Depends on #3" / "Blocked by #4, #5" in its body. */
export function blockers(body: string, open: Set<number>) {
  const out = new Set<number>();
  for (const m of (body ?? '').matchAll(DEPENDENCY)) {
    for (const n of m[0].replace(new RegExp(`${ISSUE_URL}(?:#[\\w-]+)?`, 'gi'), '').matchAll(/#(\d+)/g)) if (open.has(Number(n[1]))) out.add(Number(n[1]));
  }
  return [...out];
}

export type IssueRef = number | string;
type DependencyIssue = Pick<IssueInfo, 'body' | 'nativeBlockers' | 'bodyBlockers'> & Partial<Pick<IssueInfo, 'url'>>;

/** Union body dependencies with open native blockers, including blockers outside the fetched backlog. */
export function issueBlockers(issue: DependencyIssue, open: Set<number>): IssueRef[] {
  const out = new Set<IssueRef>(blockers(issue.body, open));
  const repo = issue.url?.match(new RegExp(ISSUE_URL, 'i'))?.slice(1, 3).join('/').toLowerCase();
  for (const ref of dependencyUrls(issue.body)) {
    const known = issue.bodyBlockers?.find((b) => b.repo?.toLowerCase() === ref.repo && b.number === ref.number);
    if (known ? known.state === 'OPEN' : ref.repo !== repo || open.has(ref.number)) out.add(ref.repo === repo ? ref.number : `${ref.repo}#${ref.number}`);
  }
  for (const b of issue.nativeBlockers ?? []) {
    if (b.state === 'OPEN') out.add(b.repo ? `${b.repo}#${b.number}` : b.number);
  }
  return [...out];
}

/** Native parent summary for backlog cards and manual-start warnings. */
export function issueParent(issue: Pick<IssueInfo, 'subIssues' | 'labels' | 'title'>): string | null {
  if (issue.subIssues?.total) return `${issue.subIssues.completed}/${issue.subIssues.total} sub-issues done`;
  if (issue.labels.some((l) => /^(parent|prd|epic)$/i.test(l)) || /^(?:\[PRD\]|PRD:|Parent:)\s*/i.test(issue.title)) return 'parent or PRD';
  return null;
}

/** Status shared by the manager's issue list and Kanban cards. */
export function issueWorkNote(issue: IssueInfo): string | null {
  const parent = issueParent(issue);
  return [issueReadinessReason(issue), parent ? `parent: ${parent}` : issue.subIssues === null ? 'sub-issues have not loaded' : '', issue.stalled].filter(Boolean).join(' · ') || null;
}

/** Why an issue must stay in the backlog, including explicit parent/PRD containers. */
export function issueWaitReason(issue: IssueInfo, open: Set<number>): string | null {
  const readiness = issueReadinessReason(issue);
  if (readiness) return readiness;
  if (issue.subIssues === null) return 'sub-issues have not loaded';
  if (issueParent(issue)) return 'parent or PRD';
  if (issue.stalled) return issue.stalled;
  if (issue.nativeBlockers === null) return 'native blockers have not loaded';
  if (issueBlockers(issue, open).length) return 'open blockers';
  if (!schedulable(issue.labels, issue.title)) return 'reserved or skipped work';
  return null;
}

const STATEMENT = new RegExp(`\\s*${DEPENDENCY.source}[.;,]?`, 'gi'); // with the space before it and a full stop after

/**
 * An issue body with its "Depends on #N" / "Blocked by #N" statements replaced by one "Depends on #a, #b" line at the
 * top ([] removes them). A line that only said that goes; the rest of the body is left alone.
 */
export function setDependsOn(body: string, deps: number[]) {
  const lines: string[] = [];
  let dropped = false;
  for (const line of (body ?? '').split(/\r?\n/)) {
    const rest = line.match(DEPENDENCY) ? line.replace(STATEMENT, '').trimEnd() : line;
    if (rest !== line && !/[\p{L}\p{N}]/u.test(rest)) {
      dropped = true;
      continue;
    }
    // A dropped line between two paragraphs doesn't leave a double gap.
    if (dropped && !rest.trim() && !lines[lines.length - 1]?.trim()) continue;
    dropped = false;
    lines.push(rest);
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  const rest = lines.join('\n');
  if (deps.length === 0) return rest;
  return `Depends on ${deps.map((n) => `#${n}`).join(', ')}${rest ? `\n\n${rest}` : ''}`;
}

/**
 * How much of the backlog each open issue holds up: the longest chain of open issues waiting on it (`chain`) and how
 * many wait on it directly or indirectly (`waiting`). Starting the issues with the most behind them first lets the
 * most work run in parallel later.
 */
export function holdUps(issues: (DependencyIssue & { number: number })[]) {
  const open = new Set(issues.map((i) => i.number));
  const waiters = new Map<IssueRef, number[]>();
  for (const i of issues) for (const b of issueBlockers(i, open)) waiters.set(b, [...(waiters.get(b) ?? []), i.number]);
  const chains = new Map<IssueRef, number>();
  const visiting = new Set<IssueRef>();
  const chain = (n: IssueRef): number => {
    const known = chains.get(n);
    if (known !== undefined) return known;
    if (visiting.has(n)) return 0; // a dependency cycle
    visiting.add(n);
    const longest = Math.max(0, ...(waiters.get(n) ?? []).map((w) => chain(w) + 1));
    visiting.delete(n);
    chains.set(n, longest);
    return longest;
  };
  const out = new Map<IssueRef, { chain: number; waiting: number }>();
  for (const n of new Set<IssueRef>([...issues.map((i) => i.number), ...waiters.keys()])) {
    const seen = new Set<number>();
    const stack = [...(waiters.get(n) ?? [])];
    while (stack.length) {
      const w = stack.pop()!;
      if (w === n || seen.has(w)) continue;
      seen.add(w);
      stack.push(...(waiters.get(w) ?? []));
    }
    out.set(n, { chain: chain(n), waiting: seen.size });
  }
  return out;
}
