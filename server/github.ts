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

const dependencyWarnings = new Set<string>();

/** Repo sync batches dependency reads; scheduling uses the resulting IssueInfo cache without any API calls. */
export async function listIssues(fullName: string, query: (args: string[]) => Promise<RawIssue[]> = ghJson, api: RestQuery = ghJson): Promise<IssueInfo[]> {
  const raw = await query(['issue', 'list', '-R', fullName, '--state', 'open', '--limit', '100', '--json', 'number,title,body,url,labels,createdAt']);
  const issues: IssueInfo[] = raw
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? '', url: i.url, labels: i.labels.map((l) => l.name), createdAt: i.createdAt }))
    .sort((a, b) => a.number - b.number);
  const [owner, name] = fullName.split('/');
  try {
    for (let start = 0; start < issues.length; start += 25) {
      let pending = issues.slice(start, start + 25).map((issue) => ({ issue, cursor: null as string | null }));
      while (pending.length) {
        const fields = pending.map(({ issue, cursor }) => `i${issue.number}: issue(number:${issue.number}) { blockedBy(first:100${cursor ? `,after:${JSON.stringify(cursor)}` : ''}) { nodes { number state repository { nameWithOwner } } pageInfo { hasNextPage endCursor } } }`).join('\n');
        const result = await api(['api', 'graphql', '-f', `query=query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${fields} } }`, '-f', `owner=${owner}`, '-f', `name=${name}`]) as {
          data?: { repository: Record<string, { blockedBy: BlockerConnection }> }; errors?: unknown[];
        };
        if (result.errors?.length || !result.data?.repository) throw new Error('Dependency query unavailable');
        const next: typeof pending = [];
        for (const { issue, cursor } of pending) {
          const connection = result.data.repository[`i${issue.number}`]?.blockedBy;
          if (!connection) throw new Error('Dependency query incomplete');
          issue.nativeBlockers = [...(issue.nativeBlockers ?? []), ...connection.nodes.map((b) => ({
            number: b.number, state: b.state,
            ...(b.repository.nameWithOwner.toLowerCase() !== fullName.toLowerCase() && { repo: b.repository.nameWithOwner }),
          }))];
          if (connection.pageInfo.hasNextPage) {
            if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) throw new Error('Dependency pagination incomplete');
            next.push({ issue, cursor: connection.pageInfo.endCursor });
          }
        }
        pending = next;
      }
    }
  } catch {
    // Older hosts and restricted tokens still sync issues normally, without repeated warning noise.
    for (const issue of issues) delete issue.nativeBlockers;
    if (!dependencyWarnings.has(fullName)) {
      dependencyWarnings.add(fullName);
      console.warn(`[GitHub] Native issue dependencies unavailable for ${fullName}; using body dependencies.`);
    }
  }
  return issues;
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

/** How many commits a branch has on GitHub that the base branch doesn't (throws when the branch isn't there). */
export async function branchAhead(fullName: string, base: string, branch: string): Promise<number> {
  return Number(await gh(['api', `repos/${fullName}/compare/${base}...${branch}?per_page=1`, '--jq', '.ahead_by'])) || 0;
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
