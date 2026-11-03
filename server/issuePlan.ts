// Issue Plans: the lead researcher's draft from a PRD revision, checked and reconciled with the open tracker issues
// before it is saved or presented. Pure: the swarm supplies the floors, their open issues and specialties, persists the
// result as the Idea's next plan revision, and nothing here writes to GitHub.
import type { IssueInfo, IssuePlanEntry, PlanDependency, PrdForPlanning, TrackingParent } from '../shared/types.ts';
import { specialtySlug } from './ceo.ts';

/**
 * What the lead submits, as JSON. Per entry: `key` (theirs, unique), `repo`, `requirement` (a PRD requirement id),
 * `title`, `brief`, `acceptance`, optional `specialty` and `parent`; `existing: <n>` reuses an open issue as is, and
 * `overlaps: <n>` drafts only what that issue doesn't already cover. `dependencies` are separate `{ issue, blockedBy }` edges.
 */
export type IssuePlanDraft = unknown;

export interface PlanContext {
  prd: PrdForPlanning;
  floors: string[]; // configured repo ids
  openIssues(repo: string): IssueInfo[];
  specialties(repo: string): string[]; // held on the floor (or by a pending hire)
}

export type PlanDraftResult =
  | { ok: true; entries: IssuePlanEntry[]; parents: TrackingParent[]; dependencies: PlanDependency[] }
  | { ok: false; problems: string[] };

export const MAX_PLAN_ENTRIES = 30;
/** One session's worth of work: more criteria than this is more than one issue. */
export const MAX_ACCEPTANCE = 8;
const MAX_TITLE = 100;
const MAX_BRIEF = 8000;
const KEY = /^[A-Za-z][\w-]{0,31}$/;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
const ref = (i: IssueInfo) => ({ number: i.number, url: i.url, title: i.title });

/** Comparable form of a title or criterion: case, bullets, checkboxes, spacing and closing punctuation don't count. */
export function normalized(s: string) {
  return s
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ x]\]\s+/, '')
    .replace(/`/g, '')
    .replace(/(?<!\w)[*_]+|[*_]+(?!\w)/g, '') // emphasis markers only: user_id keeps its underscore
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;:,]+$/, '')
    .trim();
}

/** The checklist items, bullets and sentences of an issue body: what an overlapping entry mustn't ask for again. */
export function coveredItems(body: string): Set<string> {
  const items = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const n = normalized(part);
      if (n) items.add(n);
    }
  }
  return items;
}

/** A dependency cycle as a path of keys (first = last), or null. Edges point from an issue to what it waits for. */
export function dependencyCycle(deps: PlanDependency[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const d of deps) next.set(d.issue, [...(next.get(d.issue) ?? []), d.blockedBy]);
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    if (done.has(k)) return null;
    const at = path.indexOf(k);
    if (at >= 0) return [...path.slice(at), k];
    path.push(k);
    for (const n of next.get(k) ?? []) {
      const cycle = visit(n);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(k);
    return null;
  };
  for (const k of next.keys()) {
    const cycle = visit(k);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Check a draft against its PRD revision and the floors, and reconcile it with the open issues: an exact match (same
 * title, or an overlap that leaves nothing) becomes a reference to the existing issue, and an overlap keeps only the
 * remaining criteria. Every problem is reported at once, worded so the lead can fix the draft.
 */
export function draftIssuePlan(input: IssuePlanDraft, ctx: PlanContext): PlanDraftResult {
  const problems: string[] = [];
  const body = obj(input);
  const rawEntries = list(body.entries);
  if (!rawEntries.length) problems.push('A plan needs at least one implementation issue.');
  if (rawEntries.length > MAX_PLAN_ENTRIES) problems.push(`A plan has at most ${MAX_PLAN_ENTRIES} issues; split the Idea.`);
  const requirements = new Map(ctx.prd.requirements.map((r) => [r.id, r]));
  const keys = new Set<string>();
  const claim = (key: string, who: string) => {
    if (!KEY.test(key)) problems.push(`${who} key "${key}" must be a letter followed by up to 31 letters, digits, - or _.`);
    else if (keys.has(key)) problems.push(`The key "${key}" is used twice; keys are unique across issues and Tracking Parents.`);
    else return keys.add(key);
    return false;
  };
  const onFloor = (repo: string, who: string) => ctx.floors.includes(repo) || (problems.push(`${who}: "${repo}" is not a configured floor.`), false);

  // ---------- Tracking Parents ----------
  const parents: TrackingParent[] = [];
  for (const raw of list(body.parents)) {
    const p = obj(raw);
    const key = str(p.key);
    const who = `Tracking Parent ${key || '(no key)'}`;
    if (!claim(key, 'Tracking Parent')) continue;
    const repo = str(p.repo);
    const title = str(p.title);
    onFloor(repo, who);
    if (!title || title.length > MAX_TITLE) problems.push(`${who} needs a title of at most ${MAX_TITLE} characters.`);
    parents.push({ key, repo, title, summary: str(p.summary) });
  }
  const parentKeys = new Set(parents.map((p) => p.key));

  // ---------- issues ----------
  const entries: IssuePlanEntry[] = [];
  const reused = new Map<string, string>(); // repo#number → key
  const drafted = new Map<string, string>(); // repo + normalized title → key
  for (const raw of rawEntries) {
    const e = obj(raw);
    const key = str(e.key);
    const who = `Issue ${key || '(no key)'}`;
    if (!claim(key, 'Issue')) continue;
    const repo = str(e.repo);
    if (!onFloor(repo, who)) continue;
    const requirement = requirements.get(str(e.requirement));
    if (!requirement) {
      problems.push(`${who} must cite a requirement of PRD revision ${ctx.prd.revision} (${[...requirements.keys()].join(', ') || 'it has none'}).`);
      continue;
    }
    const parent = str(e.parent) || undefined;
    if (parent && !parentKeys.has(parent)) problems.push(`${who}: "${parent}" is not a Tracking Parent in this plan.`);
    const open = ctx.openIssues(repo);
    const find = (n: unknown, use: string) => {
      if (n === undefined) return undefined;
      const issue = open.find((i) => i.number === n);
      if (!issue) problems.push(`${who}: ${repo}#${String(n)} is not an open issue, so it can't be ${use}.`);
      return issue ?? null;
    };
    const title = str(e.title);
    const existing = find(e.existing, 'reused');
    const exact = existing === undefined ? (title ? open.find((i) => normalized(i.title) === normalized(title)) : undefined) : existing;
    const overlap = exact === undefined ? find(e.overlaps, 'overlapped') : undefined;
    if (exact === null || overlap === null) continue;
    let acceptance = list(e.acceptance).map(str).filter(Boolean);
    const covered = overlap ? acceptance.filter((c) => coveredItems(overlap.body).has(normalized(c))) : [];
    acceptance = acceptance.filter((c) => !covered.includes(c));
    const match = exact ?? (overlap && !acceptance.length ? overlap : undefined);

    if (match) {
      if (parent) problems.push(`${who} reuses ${repo}#${match.number}, which stays untouched, so it can't join a Tracking Parent.`);
      const twice = reused.get(`${repo}#${match.number}`);
      if (twice) problems.push(`${twice} and ${key} both reuse ${repo}#${match.number}; keep one.`);
      reused.set(`${repo}#${match.number}`, key);
      entries.push({ key, kind: 'existing', repo, title: match.title, brief: '', acceptance: [], requirement, issue: ref(match) });
      continue;
    }

    const brief = str(e.brief);
    if (!title || title.length > MAX_TITLE || !/\s/.test(title)) problems.push(`${who} needs an actionable title of a few words, at most ${MAX_TITLE} characters.`);
    const same = drafted.get(`${repo}\n${normalized(title)}`);
    if (title && same) problems.push(`${same} and ${key} propose the same issue on ${repo}; merge them.`);
    drafted.set(`${repo}\n${normalized(title)}`, key);
    if (!brief || brief.length > MAX_BRIEF) problems.push(`${who} needs a brief of at most ${MAX_BRIEF} characters.`);
    if (!acceptance.length) problems.push(`${who} needs measurable acceptance criteria.`);
    if (acceptance.length > MAX_ACCEPTANCE) problems.push(`${who} has ${acceptance.length} acceptance criteria; one session covers at most ${MAX_ACCEPTANCE}, so split it.`);
    const asked = str(e.specialty);
    const specialty = specialtySlug(asked) || undefined;
    if (asked && !specialty) problems.push(`${who}: "${asked}" is not a specialty; leave it out for anyone.`);
    else if (specialty && !ctx.specialties(repo).includes(specialty)) problems.push(`${who}: nobody on ${repo} has the specialty "${specialty}"; leave it out for anyone.`);
    entries.push({
      key, kind: 'new', repo, title, brief, acceptance, requirement,
      ...(specialty && { specialty }),
      ...(parent && { parent }),
      ...(overlap && { issue: ref(overlap), covered }),
    });
  }
  for (const p of parents) {
    if (!entries.some((e) => e.parent === p.key)) problems.push(`Tracking Parent ${p.key} groups no issues; drop it or group related work under it.`);
  }

  // ---------- dependencies ----------
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const dependencies: PlanDependency[] = [];
  const edges = new Set<string>();
  for (const raw of list(body.dependencies)) {
    const d = obj(raw);
    const issue = str(d.issue);
    const blockedBy = str(d.blockedBy);
    const edge = `Dependency ${issue || '?'} on ${blockedBy || '?'}`;
    if (parentKeys.has(issue) || parentKeys.has(blockedBy)) {
      problems.push(`${edge}: Tracking Parents group work; they can't block or be blocked.`);
      continue;
    }
    const a = byKey.get(issue);
    const b = byKey.get(blockedBy);
    if (!a || !b) {
      const missing = [issue, blockedBy].filter((k) => !byKey.has(k) && !keys.has(k)); // keys already reported above stay quiet
      if (missing.length) problems.push(`${edge}: ${missing.map((k) => `"${k}"`).join(' and ')} is not an issue key in this plan.`);
      continue;
    }
    if (issue === blockedBy) problems.push(`${edge}: an issue can't wait for itself.`);
    else if (a.kind === 'existing') problems.push(`${edge}: ${issue} reuses ${a.repo}#${a.issue?.number}, which stays untouched, so it can't gain a blocker.`);
    else if (!edges.has(`${issue}\n${blockedBy}`)) {
      edges.add(`${issue}\n${blockedBy}`);
      dependencies.push({ issue, blockedBy });
    }
  }
  const cycle = dependencyCycle(dependencies);
  if (cycle) problems.push(`Dependencies form a cycle (${cycle.join(' waits for ')}); remove an edge that isn't a true blocker.`);

  return problems.length ? { ok: false, problems } : { ok: true, entries, parents, dependencies };
}
