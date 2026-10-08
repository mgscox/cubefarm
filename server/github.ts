import { CommandError, gh, ghJson } from './exec.ts';
import type { GhRepoSummary, IssueInfo, PullInfo, PullRefresh } from '../shared/types.ts';

// All GitHub access goes through the gh CLI so it reuses the user's existing `gh auth login`.

export async function currentUser(): Promise<string> {
  return gh(['api', 'user', '--jq', '.login']);
}

export async function listMyRepos(owner?: string): Promise<GhRepoSummary[]> {
  const args = ['repo', 'list'];
  if (owner) args.push(owner);
  args.push('--limit', '200', '--json', 'nameWithOwner,description,visibility,updatedAt');
  const repos = await ghJson<GhRepoSummary[]>(args);
  return repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface RepoMeta {
  nameWithOwner: string;
  description: string;
  url: string;
  defaultBranch: string;
}

export async function repoMeta(fullName: string): Promise<RepoMeta> {
  const raw = await ghJson<{ nameWithOwner: string; description: string | null; url: string; defaultBranchRef: { name: string } | null }>([
    'repo',
    'view',
    fullName,
    '--json',
    'nameWithOwner,description,url,defaultBranchRef',
  ]);
  return {
    nameWithOwner: raw.nameWithOwner,
    description: raw.description ?? '',
    url: raw.url,
    defaultBranch: raw.defaultBranchRef?.name || 'main',
  };
}

interface RawIssue {
  number: number; title: string; body: string; url: string; labels: { name: string }[]; createdAt: string;
}

interface BlockerConnection {
  nodes: { number: number; state: 'OPEN' | 'CLOSED'; repository: { nameWithOwner: string } }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface NativeIssue {
  blockedBy?: BlockerConnection;
  subIssuesSummary?: { total: number; completed: number };
  comments?: { nodes: { author: { login: string } | null; createdAt: string }[] };
}

interface DependencyResponse {
  data?: { repository: Record<string, NativeIssue | null> };
  errors?: unknown[];
}

/** Issue fields that older GitHub hosts (or narrower tokens) may lack; each is dropped from the query on its own. */
type NativeField = 'blockedBy' | 'subIssuesSummary' | 'comments';
const NATIVE_FIELDS: NativeField[] = ['blockedBy', 'subIssuesSummary', 'comments'];
const SUPPORT = { blockedBy: 'supported', subIssuesSummary: 'parentsSupported', comments: 'commentsSupported' } as const;

function fieldsPresent(result: DependencyResponse | undefined): Set<NativeField> {
  const present = new Set<NativeField>();
  for (const issue of Object.values(result?.data?.repository ?? {})) for (const f of NATIVE_FIELDS) if (issue?.[f]) present.add(f);
  return present;
}

function failedDependencyResponse(error: unknown): DependencyResponse | undefined {
  if (error instanceof CommandError && error.stdout.trim()) {
    try { return JSON.parse(error.stdout) as DependencyResponse; } catch { /* Invalid output cannot prove lack of support. */ }
  }
  return undefined;
}

interface DependencyCache {
  supported?: boolean;
  parentsSupported?: boolean;
  commentsSupported?: boolean;
  blockers: Map<number, NonNullable<IssueInfo['nativeBlockers']>>;
  parents: Map<number, NonNullable<IssueInfo['subIssues']>>;
  ownerComments: Map<number, string>;
  warnedAt?: number;
}
const dependencyCaches = new WeakMap<RestQuery, Map<string, DependencyCache>>();

const MISSING_FIELD = /(?:Field ['"](\w+)['"] doesn't exist on type ['"]Issue['"]|Cannot query field ['"](\w+)['"] on type ['"]Issue['"])/i;
const DENIED_FIELD = /^(?:GraphQL:\s*)?Resource not accessible by (?:personal access token|integration)\s*\((?:[\w.]*\.)?(\w+)(?:\.[\w.]*)?\)$/;

/**
 * The native fields that explicit schema/access denials name, or null when any diagnostic is an outage, a partial
 * result or about something else: only those denials permit reading without a field.
 */
export function unsupportedFields(error: unknown): Set<NativeField> | null {
  const failed = error instanceof CommandError && error.stdout.trim() ? failedDependencyResponse(error) : undefined;
  if (error instanceof CommandError && error.stdout.trim() && (!failed || (failed.errors?.length && !unsupportedFields(failed.errors)))) return null;
  const messages = error instanceof CommandError ? error.stderr.trim().replace(/^gh:\s*/, '').replace(/^GraphQL:\s*/, '').split(/,\s*(?=Resource|Field|Cannot)|\r?\n/)
    : Array.isArray(error) ? error.map((e) => {
      const message = e?.message ?? '';
      return Array.isArray(e?.path) && /^Resource not accessible by (?:personal access token|integration)$/.test(message)
        ? `${message} (${e.path.join('.')})` : message;
    }) : [];
  const lines = messages.map((m) => String(m).trim()).filter(Boolean);
  const fields = new Set<NativeField>();
  for (const line of lines) {
    const field = (MISSING_FIELD.exec(line) ?? DENIED_FIELD.exec(line))?.slice(1).find(Boolean) as NativeField | undefined;
    if (!field || !NATIVE_FIELDS.includes(field)) return null;
    fields.add(field);
  }
  const present = fieldsPresent(failed);
  return fields.size && ![...fields].some((f) => present.has(f)) ? fields : null; // data for a named field means a partial denial
}

/** Only explicit schema/access denials permit body-only scheduling; outages and partial results do not. */
export function dependenciesUnsupported(error: unknown): boolean {
  return unsupportedFields(error) !== null;
}

/** Repo sync batches native reads (blockers, sub-issue summaries, owner comments); scheduling uses the resulting IssueInfo cache. */
export async function listIssues(fullName: string, query: (args: string[]) => Promise<RawIssue[]> = ghJson, api: RestQuery = ghJson): Promise<IssueInfo[]> {
  const raw = await query(['issue', 'list', '-R', fullName, '--state', 'open', '--limit', '100', '--json', 'number,title,body,url,labels,createdAt']);
  const issues: IssueInfo[] = raw
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? '', url: i.url, labels: i.labels.map((l) => l.name), createdAt: i.createdAt }))
    .sort((a, b) => a.number - b.number);
  let caches = dependencyCaches.get(api);
  if (!caches) dependencyCaches.set(api, caches = new Map());
  const key = fullName.toLowerCase();
  let cache = caches.get(key);
  if (!cache) caches.set(key, cache = { blockers: new Map(), parents: new Map(), ownerComments: new Map() });
  const [owner, name] = fullName.split('/');
  const markSupported = (result: DependencyResponse | undefined) => { for (const f of fieldsPresent(result)) cache[SUPPORT[f]] = true; };
  const skipped = new Set<NativeField>(); // per sync, so an upgraded host or token is picked up next time
  for (;;) {
    const want = NATIVE_FIELDS.filter((f) => !skipped.has(f));
    const blockers = new Map<number, NonNullable<IssueInfo['nativeBlockers']>>();
    const parents = new Map<number, NonNullable<IssueInfo['subIssues']>>();
    const comments = new Map<number, string>();
    try {
      for (let start = 0; want.length && start < issues.length; start += 25) {
        let pending = issues.slice(start, start + 25).map((issue) => ({ issue, cursor: null as string | null }));
        while (pending.length) {
          const fields = pending.map(({ issue, cursor }) => `i${issue.number}: issue(number:${issue.number}) { ${[
            cursor === null && want.includes('subIssuesSummary') && 'subIssuesSummary { total completed }',
            cursor === null && want.includes('comments') && 'comments(last:100) { nodes { author { login } createdAt } }',
            want.includes('blockedBy') && `blockedBy(first:100${cursor ? `,after:${JSON.stringify(cursor)}` : ''}) { nodes { number state repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }`,
          ].filter(Boolean).join(' ')} }`).join('\n');
          const result = await api(['api', 'graphql', '-f', `query=query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${fields} } }`, '-f', `owner=${owner}`, '-f', `name=${name}`]) as DependencyResponse;
          markSupported(result);
          if (result.errors?.length) throw result.errors;
          if (!result.data?.repository) throw new Error('Dependency query unavailable');
          const next: typeof pending = [];
          for (const { issue, cursor } of pending) {
            const node = result.data.repository[`i${issue.number}`];
            if (!node) throw new Error('Dependency query incomplete');
            if (cursor === null && want.includes('subIssuesSummary')) {
              const summary = node.subIssuesSummary;
              if (!summary || !Number.isSafeInteger(summary.total) || !Number.isSafeInteger(summary.completed) || summary.total < 0 || summary.completed < 0 || summary.completed > summary.total) throw new Error('Sub-issue query incomplete');
              parents.set(issue.number, { total: summary.total, completed: summary.completed });
            }
            const commentAt = node.comments?.nodes.filter((c) => c.author?.login.toLowerCase() === owner.toLowerCase()).map((c) => c.createdAt).sort().at(-1);
            if (commentAt) comments.set(issue.number, commentAt);
            if (!want.includes('blockedBy')) continue;
            const connection = node.blockedBy;
            if (!connection) throw new Error('Dependency query incomplete');
            blockers.set(issue.number, [...(blockers.get(issue.number) ?? []), ...connection.nodes.map((b) => ({
              number: b.number, state: b.state,
              ...(b.repository.nameWithOwner.toLowerCase() !== fullName.toLowerCase() && { repo: b.repository.nameWithOwner }),
            }))]);
            if (connection.pageInfo.hasNextPage) {
              if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) throw new Error('Dependency pagination incomplete');
              next.push({ issue, cursor: connection.pageInfo.endCursor });
            }
          }
          pending = next;
        }
      }
      for (const issue of issues) {
        if (want.includes('blockedBy')) issue.nativeBlockers = blockers.get(issue.number) ?? [];
        if (want.includes('subIssuesSummary')) issue.subIssues = parents.get(issue.number);
        issue.ownerCommentAt = comments.get(issue.number) ?? cache.ownerComments.get(issue.number);
      }
      if (issues.length) {
        for (const f of want) cache[SUPPORT[f]] = true;
        if (want.includes('blockedBy')) cache.blockers = blockers;
        if (want.includes('subIssuesSummary')) cache.parents = parents;
        cache.ownerComments = new Map(issues.filter((i) => i.ownerCommentAt).map((i) => [i.number, i.ownerCommentAt!]));
      }
      return issues;
    } catch (error) {
      markSupported(failedDependencyResponse(error));
      const dropped = [...unsupportedFields(error) ?? []].filter((f) => cache[SUPPORT[f]] !== true && !skipped.has(f));
      for (const f of dropped) { cache[SUPPORT[f]] = false; skipped.add(f); }
      if (dropped.length) continue; // retry without what this host/token lacks, so the remaining fields still load
      for (const issue of issues) {
        issue.nativeBlockers = cache.blockers.get(issue.number) ?? (cache.supported === false ? undefined : null);
        issue.subIssues = cache.parents.get(issue.number) ?? (cache.parentsSupported === false ? undefined : null);
        issue.ownerCommentAt = cache.ownerComments.get(issue.number);
      }
      const now = Date.now();
      if (cache.warnedAt === undefined || now - cache.warnedAt >= 10 * 60_000) {
        cache.warnedAt = now;
        console.warn(`[GitHub] Native issue dependency read failed for ${fullName}; ${cache.supported === false ? 'using body dependencies' : 'keeping cached blockers; unread issues wait'}.`, error);
      }
      return issues;
    }
  }
}

interface RawPull {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  closingIssuesReferences: { number: number }[] | null;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  headRefOid: string;
  mergeStateStatus: string;
  // check runs (GitHub Actions…) carry name/status/conclusion/detailsUrl; commit statuses (Vercel…) carry context/state/targetUrl
  statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[] | null;
}

const PR_FIELDS =
  'number,title,url,headRefName,headRefOid,state,isDraft,mergeable,mergeStateStatus,reviewDecision,closingIssuesReferences,createdAt,mergedAt,additions,deletions';

type Check = NonNullable<RawPull['statusCheckRollup']>[number];
const BAD = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const failed = (c: Check) => BAD.includes(c.conclusion ?? '') || BAD.includes(c.state ?? '');
const pending = (c: Check) => (!!c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED';
const checkName = (c: Check) => c.name || c.context || 'check';

function checksOf(rollup: RawPull['statusCheckRollup']): PullInfo['checks'] {
  if (!rollup || rollup.length === 0) return 'none';
  if (rollup.some(failed)) return 'failing';
  if (rollup.some(pending)) return 'pending';
  return 'passing';
}

function toPull(p: RawPull): PullInfo {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    headRefName: p.headRefName,
    state: p.state,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    reviewDecision: p.reviewDecision || null,
    closesIssues: (p.closingIssuesReferences ?? []).map((r) => r.number),
    createdAt: p.createdAt,
    mergedAt: p.mergedAt,
    additions: p.additions,
    deletions: p.deletions,
    checks: checksOf(p.statusCheckRollup),
    headSha: p.headRefOid,
    mergeState: p.mergeStateStatus || 'UNKNOWN',
    failedChecks: (p.statusCheckRollup ?? []).filter(failed).map((c) => ({ name: checkName(c), url: c.detailsUrl || c.targetUrl || null })),
    pendingChecks: (p.statusCheckRollup ?? []).filter(pending).map(checkName),
  };
}

/** Only access denials located inside check rollups qualify; mixed GraphQL failures must remain errors. */
export function isCheckAccessError(error: unknown): boolean {
  if (!(error instanceof CommandError)) return false;
  const errors = error.stderr.trim().replace(/^gh:\s*/, '').replace(/^GraphQL:\s*/, '').split(/,\s*(?=Resource)|\r?\n/);
  return errors.length > 0 && errors.every((line) =>
    /^(?:GraphQL:\s*)?Resource not accessible by (?:personal access token|integration)\s*\([\w.]*statusCheckRollup[\w.]*\)$/.test(line.trim()));
}

type RestQuery = (args: string[]) => Promise<unknown>;
interface WorkflowRun { name: string | null; status: string; conclusion: string | null; html_url: string }
interface CommitStatus { context: string; state: string; target_url: string | null }
const REST_CACHE_MS = 30_000; // Reuse manual refresh bursts, but re-read even completed runs on the normal 45s sync.
const restCache = new WeakMap<RestQuery, Map<string, { at: number; checks: Check[] }>>();

async function restChecks(fullName: string, sha: string, api: RestQuery): Promise<Check[]> {
  let cache = restCache.get(api);
  if (!cache) restCache.set(api, cache = new Map());
  const key = `${fullName}#${sha}`;
  const now = Date.now();
  for (const [key, entry] of cache) if (now - entry.at >= REST_CACHE_MS) cache.delete(key);
  const cached = cache.get(key);
  if (cached) return cached.checks;

  // Both endpoints paginate. Never infer passing from a truncated response.
  const pages = async <T>(endpoint: string, field: 'workflow_runs' | 'statuses'): Promise<T[]> => {
    const items: T[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await api(['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`]) as { total_count: number } & Record<typeof field, T[]>;
      items.push(...response[field]);
      if (items.length >= response.total_count) return items;
      if (response[field].length === 0) break;
    }
    throw new Error('REST checks exceeded the pagination limit');
  };
  const runs = await pages<WorkflowRun>(`repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(sha)}`, 'workflow_runs');
  let statuses: CommitStatus[] = [];
  try {
    statuses = await pages<CommitStatus>(`repos/${fullName}/commits/${encodeURIComponent(sha)}/status`, 'statuses');
  } catch (error) {
    // Commit statuses are optional for tokens that can read Actions but not statuses.
    if (!(error instanceof CommandError) || !/\bHTTP (?:403|404)\b/.test(error.stderr)) throw error;
  }
  const checks: Check[] = [
    ...runs.map((r) => ({ name: r.name || 'workflow', status: r.status.toUpperCase(), conclusion: r.conclusion?.toUpperCase(), detailsUrl: r.html_url })),
    ...statuses.map((s) => ({ context: s.context, state: s.state.toUpperCase(), targetUrl: s.target_url || undefined })),
  ];
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, checks });
  return checks;
}

export async function listPulls(fullName: string, query: (args: string[]) => Promise<RawPull[]> = ghJson, api: RestQuery = ghJson): Promise<PullRefresh> {
  const list = async (state: string, limit: string): Promise<PullRefresh> => {
    const args = ['pr', 'list', '-R', fullName, '--state', state, '--limit', limit, '--json'];
    try {
      const raw = await query([...args, `${PR_FIELDS},statusCheckRollup`]);
      return { pulls: raw.map(toPull) };
    } catch (error) {
      if (!isCheckAccessError(error)) throw error;
      const raw = await query([...args, PR_FIELDS]);
      if (state !== 'open') return { pulls: raw.map(toPull) };
      const bySha = new Map<string, Promise<Check[]>>();
      const pulls: PullInfo[] = new Array(raw.length);
      const errors: string[] = [];
      let next = 0;
      const worker = async () => {
        while (next < raw.length) {
          const index = next++;
          const p = raw[index];
          try {
            let checks = bySha.get(p.headRefOid);
            if (!checks) bySha.set(p.headRefOid, checks = restChecks(fullName, p.headRefOid, api));
            pulls[index] = toPull({ ...p, statusCheckRollup: await checks });
          } catch (error) {
            pulls[index] = { ...toPull(p), checks: 'unavailable', failedChecks: [], pendingChecks: [] };
            errors.push(`PR #${p.number}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, raw.length) }, worker));
      return { pulls, checksError: `Check rollup access denied; REST fallback in use (GitHub Actions and commit statuses).${errors.length ? `\n${errors.join('\n')}` : ''}` };
    }
  };
  const [open, merged] = await Promise.all([list('open', '50'), list('merged', '8')]);
  return { pulls: [...open.pulls, ...merged.pulls], checksError: [open.checksError, merged.checksError].filter(Boolean).join('\n') || undefined };
}

// swarm:<specialty> labels route issues to specialists. gh refuses unknown labels, so they're created on first use.
const labelsMade = new Set<string>();

async function ensureLabel(fullName: string, name: string) {
  const key = `${fullName}#${name}`;
  if (labelsMade.has(key)) return;
  await gh(['label', 'create', name, '-R', fullName, '--color', 'c77dff', '--description', 'cubefarm: routed to this specialty', '--force']);
  labelsMade.add(key);
}

export async function createIssue(fullName: string, title: string, body: string, labels: string[] = []): Promise<number> {
  for (const l of labels) await ensureLabel(fullName, l);
  const args = ['issue', 'create', '-R', fullName, '--title', title, '--body-file', '-'];
  for (const l of labels) args.push('--label', l);
  const out = await gh(args, { input: body || ' ' });
  const match = out.match(/\/issues\/(\d+)/);
  if (!match) throw new Error(`Could not read the new issue number from gh output: ${out}`);
  return Number(match[1]);
}

/** OPEN or CLOSED; null when the repo has no such issue. */
export async function issueState(fullName: string, number: number): Promise<'OPEN' | 'CLOSED' | null> {
  try {
    const raw = await ghJson<{ state: string }>(['issue', 'view', String(number), '-R', fullName, '--json', 'state']);
    return raw.state === 'OPEN' ? 'OPEN' : 'CLOSED';
  } catch {
    return null;
  }
}

/** Replace an issue's body and/or add and remove labels. */
export async function editIssue(fullName: string, number: number, edit: { body?: string; addLabels?: string[]; removeLabels?: string[] }): Promise<void> {
  const args = ['issue', 'edit', String(number), '-R', fullName];
  if (edit.body !== undefined) args.push('--body-file', '-');
  for (const l of edit.addLabels ?? []) {
    await ensureLabel(fullName, l);
    args.push('--add-label', l);
  }
  for (const l of edit.removeLabels ?? []) args.push('--remove-label', l);
  if (args.length === 5) return;
  await gh(args, edit.body !== undefined ? { input: edit.body || ' ' } : undefined);
}

/** Merge a PR. With headSha, GitHub refuses if anything was pushed after that commit (e.g. after QA signed it off). */
export async function mergePull(fullName: string, number: number, method: 'squash' | 'merge' | 'rebase', headSha?: string): Promise<void> {
  const pr = await ghJson<{ headRefName: string; isCrossRepository: boolean }>(['pr', 'view', String(number), '-R', fullName, '--json', 'headRefName,isCrossRepository']);
  await gh(['pr', 'merge', String(number), '-R', fullName, `--${method}`, ...(headSha ? ['--match-head-commit', headSha] : [])], { timeoutMs: 60_000 });
  // Tidy up the swarm branch on the remote; the local worktree is cleaned when the agent takes its next issue.
  if (!pr.isCrossRepository && pr.headRefName.startsWith('swarm/')) {
    await gh(['api', '-X', 'DELETE', `repos/${fullName}/git/refs/heads/${pr.headRefName}`]).catch(() => undefined);
  }
}

/** Merge the base branch into a PR's branch on GitHub, for repos that only merge up-to-date branches. */
export async function updateBranch(fullName: string, number: number): Promise<void> {
  await gh(['pr', 'update-branch', String(number), '-R', fullName], { timeoutMs: 60_000 });
}

export async function closePull(fullName: string, number: number): Promise<void> {
  await gh(['pr', 'close', String(number), '-R', fullName]);
}

export async function prForBranch(fullName: string, branch: string): Promise<{ number: number; url: string } | null> {
  const list = await ghJson<{ number: number; url: string }[]>(['pr', 'list', '-R', fullName, '--head', branch, '--state', 'all', '--json', 'number,url', '--limit', '1']);
  return list[0] ?? null;
}

/** Pushed commits ahead of base; zero also covers a verified absent remote branch. Unknown reads throw. */
export async function branchAhead(fullName: string, base: string, branch: string, api: RestQuery = ghJson): Promise<number> {
  try {
    const result = await api(['api', `repos/${fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?per_page=1`]) as { ahead_by?: number } | null;
    const ahead = result?.ahead_by;
    if (typeof ahead !== 'number' || !Number.isInteger(ahead) || ahead < 0) throw new Error('Branch comparison unavailable');
    return ahead;
  } catch (error) {
    if (!(error instanceof CommandError) || !/\bHTTP 404\b/.test(error.stderr)) throw error;
    // A comparison 404 can mean a missing base or inaccessible repo. Only a successful refs read proves absence.
    const refs = await api(['api', `repos/${fullName}/git/matching-refs/heads/${encodeURIComponent(branch)}`]);
    if (Array.isArray(refs) && refs.every((ref) => typeof ref?.ref === 'string') && !refs.some((ref) => ref.ref === `refs/heads/${branch}`)) return 0;
    throw error;
  }
}

// ---------- QA support ----------

export interface PrDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  headSha: string;
  isCrossRepository: boolean;
  closesIssues: number[];
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: string;
  mergeState: string;
}

export async function prDetails(fullName: string, number: number): Promise<PrDetails> {
  const raw = await ghJson<{
    number: number;
    title: string;
    body: string;
    url: string;
    headRefName: string;
    headRefOid: string;
    isCrossRepository: boolean;
    closingIssuesReferences: { number: number }[] | null;
    state: PrDetails['state'];
    mergeable: string;
    mergeStateStatus: string;
  }>(['pr', 'view', String(number), '-R', fullName, '--json', 'number,title,body,url,headRefName,headRefOid,isCrossRepository,closingIssuesReferences,state,mergeable,mergeStateStatus']);
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    headRefName: raw.headRefName,
    headSha: raw.headRefOid,
    isCrossRepository: raw.isCrossRepository,
    closesIssues: (raw.closingIssuesReferences ?? []).map((r) => r.number),
    state: raw.state,
    mergeable: raw.mergeable,
    mergeState: raw.mergeStateStatus || 'UNKNOWN',
  };
}

export async function issueDetails(fullName: string, number: number): Promise<{ title: string; body: string }> {
  const raw = await ghJson<{ title: string; body: string }>(['issue', 'view', String(number), '-R', fullName, '--json', 'title,body']);
  return { title: raw.title, body: raw.body ?? '' };
}

export async function commentPull(fullName: string, number: number, body: string): Promise<string> {
  const out = await gh(['pr', 'comment', String(number), '-R', fullName, '--body-file', '-'], { input: body });
  return out.match(/https:\/\/github\.com\/\S+/)?.[0] ?? '';
}

// QA screenshots live on an orphan branch so evidence never lands in the default branch when a PR is merged.
export const EVIDENCE_BRANCH = 'swarm-qa-evidence';
const evidenceReady = new Set<string>();

const ghApiJson = <T>(method: string, endpoint: string, body: unknown) =>
  gh(['api', '-X', method, endpoint, '-H', 'Content-Type: application/json', '--input', '-'], { input: JSON.stringify(body), timeoutMs: 120_000 }).then(
    (out) => (out ? JSON.parse(out) : null) as T,
  );

async function ensureEvidenceBranch(fullName: string) {
  if (evidenceReady.has(fullName)) return;
  try {
    await gh(['api', `repos/${fullName}/git/ref/heads/${EVIDENCE_BRANCH}`]);
  } catch {
    const readme =
      '# QA evidence\n\nScreenshots attached to pull request QA reports by cubefarm QA agents.\nThis branch has no shared history with the code and is never merged.\n';
    const newTree = await ghApiJson<{ sha: string }>('POST', `repos/${fullName}/git/trees`, {
      tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: readme }],
    });
    const commit = await ghApiJson<{ sha: string }>('POST', `repos/${fullName}/git/commits`, { message: 'QA evidence branch (cubefarm)', tree: newTree.sha, parents: [] });
    await ghApiJson('POST', `repos/${fullName}/git/refs`, { ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: commit.sha });
  }
  evidenceReady.add(fullName);
}

/** Upload one evidence file and return a URL that renders inside PR comments (also for private repos). */
export async function uploadEvidence(fullName: string, filePath: string, data: Buffer): Promise<string> {
  await ensureEvidenceBranch(fullName);
  await ghApiJson('PUT', `repos/${fullName}/contents/${filePath}`, {
    message: `QA evidence: ${filePath}`,
    content: data.toString('base64'),
    branch: EVIDENCE_BRANCH,
  });
  return `https://github.com/${fullName}/raw/${EVIDENCE_BRANCH}/${filePath}`;
}
