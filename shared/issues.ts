// Issue conventions shared by the server's scheduler and the client's whiteboard.
import type { IssueInfo } from './types.ts';

/** The specialty an issue is routed to, from its swarm:<specialty> label ('' = anyone). */
export function issueSpecialty(labels: string[]) {
  const l = labels.find((x) => /^swarm:/i.test(x) && !/^swarm:skip$/i.test(x));
  return l ? l.slice(6).toLowerCase() : '';
}

/** The label the manager puts on issues that need a person (hardware, live servers, accounts, sign-off). */
export const READY_FOR_HUMAN = 'ready-for-human';

/** Whether an issue is reserved for a human: agents never get it, whatever its letter case. */
export function forHuman(labels: string[]) {
  return labels.some((l) => l.toLowerCase() === READY_FOR_HUMAN);
}

/** Whether the office may hand an issue to an agent at all (not swarm:skip, wontfix, question or ready-for-human). */
export function schedulable(labels: string[]) {
  return !forHuman(labels) && !labels.some((l) => /^(swarm:skip|wontfix|question)$/i.test(l));
}

/** Open issues this issue waits for, from "Depends on #3" / "Blocked by #4, #5" in its body. */
export function blockers(body: string, open: Set<number>) {
  const out = new Set<number>();
  for (const m of (body ?? '').matchAll(/\b(?:depends\s+on|blocked\s+by)\s*:?\s*((?:#\d+(?:\s*(?:,|and|&)\s*)?)+)/gi)) {
    for (const n of m[1].matchAll(/#(\d+)/g)) if (open.has(Number(n[1]))) out.add(Number(n[1]));
  }
  return [...out];
}

export type IssueRef = number | string;
type DependencyIssue = Pick<IssueInfo, 'body' | 'nativeBlockers'>;

/** Union body dependencies with open native blockers, including blockers outside the fetched backlog. */
export function issueBlockers(issue: DependencyIssue, open: Set<number>): IssueRef[] {
  const out = new Set<IssueRef>(blockers(issue.body, open));
  for (const b of issue.nativeBlockers ?? []) {
    if (b.state === 'OPEN') out.add(b.repo ? `${b.repo}#${b.number}` : b.number);
  }
  return [...out];
}

const DEPENDENCY = /\b(?:depends\s+on|blocked\s+by)\s*:?\s*(?:#\d+(?:\s*(?:,|and|&)\s*)?)+/gi;
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
