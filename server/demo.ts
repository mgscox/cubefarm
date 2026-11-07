import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Backend } from './backend.ts';
import type { BoxConnection, BoxOptions, Machine } from './machine.ts';
import type { PreviewBackend } from './previewRunner.ts';
import { describeOfficeTool, type LogEntry, type SessionCallbacks, type SessionHandle, type SessionOptions } from './agentRunner.ts';
import { bootNotice, CLIS } from './clis.ts';
import { updateFailure } from './fleet.ts';
import type { ApprovedSnapshot, IdeaView, IdeaRecordView, CliView, GhRepoSummary, IssueInfo, PullInfo, MachineSample, MachineTelemetry } from '../shared/types.ts';
import type { TrackedIssue } from './github.ts';
import { monitorResources } from './machineHealth.ts';
import { dependencyUrls, prototypeIssueNumber, READY_FOR_HUMAN, READY_FOR_SECURITY_REVIEW, RESEARCH } from '../shared/issues.ts';
import type { LocalFolder } from './workspace.ts';
import { HOME_DIR } from './config.ts';
import { CommandError } from './exec.ts';
import { takeLastUpdate, underLauncher, type OfficeHost } from './officeUpdate.ts';
import type { prStatusView } from './ceo.ts';
import type { IdeaResearchReport } from './ideaResearch.ts';

// `npm run demo`: a fake GitHub and fake Claude Code sessions, so the office (including the
// dev → QA → fix loop) can be explored without spending any usage or touching real repos.

interface FakeRepo {
  fullName: string;
  description: string;
  issues: IssueInfo[];
  pulls: PullInfo[];
  nextNumber: number;
}

const now = () => new Date().toISOString();

function issue(n: number, title: string, body: string, fullName: string, labels: string[] = []): IssueInfo {
  return { number: n, title, body, url: `https://github.com/${fullName}/issues/${n}`, labels, createdAt: now() };
}

const tracked = (fullName: string, i: IssueInfo): TrackedIssue => ({ repo: fullName, number: i.number, url: i.url, title: i.title, body: i.body, labels: [...i.labels], state: 'OPEN', stateReason: null });

const repos = new Map<string, FakeRepo>();
const COMPANY_REPO = 'demo-manager/cubebase';
/** Repos made in the demo (new projects, published folders): empty, so no package.json for the preview to fall back on. */
const bareRepos = new Set<string>();
const mergedSinceSync = new Map<string, number>(); // merges the fake project folder hasn't pulled yet
const closedIssues = new Map<string, TrackedIssue>(); // `${fullName}#${n}` → an issue closed (as completed) by a merge

/** An open PR from someone's fork whose (bare) branch name is the given one, e.g. one of the office's desk branches. Returns its removal. */
export function demoForkPull(fullName: string, headRefName: string): { pull: PullInfo; remove: () => void } {
  return demoPull(fullName, headRefName, true);
}

/** An open PR on `headRefName`, from the repo itself or (`fork`) from someone's fork. Returns its removal. */
export function demoPull(fullName: string, headRefName: string, fork: boolean): { pull: PullInfo; remove: () => void } {
  const repo = repos.get(fullName);
  if (!repo) throw new Error(`Unknown demo repo ${fullName}`);
  const number = repo.nextNumber++;
  const pull: PullInfo = {
    number, title: fork ? 'Outside contribution' : 'Desk PR', url: `https://github.com/${fullName}/pull/${number}`, headRefName, isCrossRepository: fork, state: 'OPEN',
    isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, closesIssues: [], createdAt: now(), mergedAt: null,
    additions: 3, deletions: 1, checks: 'passing', hasSuccessfulChecks: true, headSha: fakeSha(), mergeState: 'CLEAN', failedChecks: [], pendingChecks: [],
  };
  repo.pulls.unshift(pull);
  return { pull, remove: () => { repo.pulls = repo.pulls.filter((p) => p !== pull); } };
}

const fakeSha = () => crypto.randomBytes(20).toString('hex');

// ---------- publication fixtures ----------

/** Faults the fake tracker injects at the publication boundary, so recovery can be watched in the demo and tests. */
export const demoTracker = {
  /** Creates that succeed on the fake GitHub but whose response is lost. */
  lostCreates: 0,
  /** Repos refusing writes (READ permission) until this time. */
  refused: new Map<string, number>(),
  /** Fail creates after preflight succeeds, to exercise partially staged cross-floor plans. */
  refusedCreates: new Map<string, number>(),
};

const refusing = (fullName: string) => (demoTracker.refused.get(fullName) ?? 0) > Date.now();

let fixtureSeq = 0;
/**
 * A seeded, already-approved single-issue Proposal. Its approval is a fixture: only the demo office and tests accept
 * it, never the real one. With a prerequisite, the approved plan says the issue waits for that one.
 */
export function demoApprovedProposal(repo: string, at = Date.now(), prerequisite?: { repo: string; number: number }): ApprovedSnapshot {
  const n = `${at.toString(36)}-${++fixtureSeq}`;
  return {
    approval: { decisionId: `demo-decision-${n}`, proposalId: `demo-proposal-${n}`, ideaId: `demo-idea-${n}`, prdRevision: 2, planRevision: 4, decidedAt: at, source: 'fixture' },
    issues: [{
      entryId: 'weekly-summary',
      repo,
      title: 'Show a weekly summary of completed todos',
      body: [
        'From an approved Idea: a short weekly recap keeps people coming back.',
        '',
        '## Scope',
        'One session: a summary card above the list with the number of todos completed in the last 7 days.',
        '',
        '## Acceptance criteria',
        '- [ ] The card shows the count of todos completed in the last 7 days.',
        '- [ ] It updates when a todo is completed or reopened.',
        '',
        'PRD requirement: R2 (weekly recap).',
      ].join('\n'),
      ...(prerequisite && { blockedBy: [prerequisite] }),
    }],
  };
}

/** An approved cross-floor fixture with a tracking Parent, independent leaves and a read-only reference. */
export function demoCrossFloorProposal(a: string, b: string): ApprovedSnapshot {
  const snapshot = demoApprovedProposal(a);
  const leaf = snapshot.issues[0];
  snapshot.issues = [
    { entryId: 'parent', repo: a, title: 'Weekly plan', body: 'Track delivery across the two floors.', tracking: true },
    { ...leaf, parent: 'parent' },
    { entryId: 'endpoint', repo: b, title: 'Serve the weekly summary', body: 'Add a read-only weekly summary endpoint.', parent: 'parent' },
    { entryId: 'existing', repo: b, title: 'Existing API work', body: '', existing: { number: 1, url: `https://github.com/${b}/issues/1` } },
    { entryId: 'panel', repo: a, title: 'Connect the weekly panel', body: 'Read the endpoint and show its summary.', parent: 'parent', blockedBy: [{ entryId: 'endpoint' }, { entryId: 'existing' }] },
  ];
  return snapshot;
}

/** Fake CI: checks run for a while after every push, and now and then one fails so the fix loop shows. */
function runChecks(pr: PullInfo, fail = Math.random() < 0.2) {
  Object.assign(pr, { checks: 'pending', hasSuccessfulChecks: false, pendingChecks: ['CI', 'Vercel'], failedChecks: [] });
  setTimeout(() => {
    Object.assign(pr, {
      checks: fail ? 'failing' : 'passing',
      hasSuccessfulChecks: !fail,
      pendingChecks: [],
      failedChecks: fail ? [{ name: 'CI', url: `${pr.url.split('/pull/')[0]}/actions/runs/${pr.number}` }] : [],
    });
  }, 12_000 + Math.random() * 10_000);
}

function seed(fullName: string, description: string, titles: [string, string, string[]?][]) {
  const r: FakeRepo = { fullName, description, issues: [], pulls: [], nextNumber: 1 };
  for (const [title, body, labels] of titles) r.issues.push(issue(r.nextNumber++, title, body, fullName, labels));
  repos.set(fullName, r);
}

seed('demo-co/pixel-todo', 'A cheerful todo app', [
  ['Add dark mode toggle', 'Users want a dark theme. Persist the choice in localStorage.'],
  ['Todos should support due dates', 'Add an optional due date and highlight overdue items.'],
  ['Drag and drop to reorder', 'Let users reorder todos by dragging.'],
  ['Empty state illustration', 'Show a friendly illustration when the list is empty.'],
  ['Keyboard shortcuts', 'N for new todo, / to search, ? for help.'],
  ['Fix: completed count off by one', 'The footer shows one more completed item than there is.'],
  ['How do popular todo apps handle due dates?', 'Compare three or four well-known todo apps: how they set, show and remind about due dates. Recommend an approach for us.', [`swarm:${RESEARCH}`]],
  // Needs a person: the office never hands it out, however many developers are free.
  ['Register the app in the App Store', 'Needs the company account and a signed agreement.', [READY_FOR_HUMAN]],
]);
const parentRepo = repos.get('demo-co/pixel-todo')!;
const parent = issue(parentRepo.nextNumber++, 'Todo release plan', 'Implementation is complete; review and close this parent.', parentRepo.fullName);
parent.subIssues = { total: 6, completed: 6 };
parentRepo.issues.push(parent);
repos.get('demo-co/pixel-todo')!.issues[2].nativeBlockers = [{ number: 2, state: 'OPEN' }];
repos.get('demo-co/pixel-todo')!.issues[2].body += '\n\nDepends on https://github.com/demo-co/pixel-todo/issues/2';
seed('demo-co/weather-api', 'Tiny weather REST API', [
  ['Add /forecast endpoint', 'Return a 5-day forecast for a city.'],
  ['Rate limit anonymous callers', '60 requests per minute per IP.'],
  ['OpenAPI spec', 'Publish an OpenAPI 3.1 document at /openapi.json.'],
]);

function screenshotSvg(title: string, url: string, hue: number) {
  const safe = (s: string) => s.replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="hsl(${hue},60%,97%)"/>
  <rect width="640" height="56" fill="hsl(${hue},70%,55%)"/>
  <text x="24" y="37" font-family="Segoe UI, Arial" font-size="22" font-weight="700" fill="#fff">${safe(title)}</text>
  <text x="620" y="36" text-anchor="end" font-family="Segoe UI, Arial" font-size="13" fill="#fff">${safe(url)}</text>
  ${[0, 1, 2, 3]
    .map(
      (i) => `<rect x="24" y="${84 + i * 70}" width="592" height="56" rx="10" fill="#fff" stroke="hsl(${hue},40%,85%)"/>
  <circle cx="54" cy="${112 + i * 70}" r="11" fill="none" stroke="hsl(${hue},60%,55%)" stroke-width="3"/>
  <rect x="80" y="${104 + i * 70}" width="${180 + ((i * 97) % 220)}" height="14" rx="7" fill="hsl(${hue},25%,80%)"/>`,
    )
    .join('\n')}
</svg>`;
}

type Step = LogEntry[] | (() => void);

function devScript(opts: SessionOptions, cb: SessionCallbacks, issueNumber: number, issueTitle: string): Step[] {
  const branch = path.basename(opts.cwd);
  const hue = (issueNumber * 67) % 360;
  const file = ['src/App.tsx', 'src/components/TodoList.tsx', 'src/api/routes.ts', 'src/styles.css'][issueNumber % 4];
  const port = 5200 + (issueNumber % 50);
  return [
    [{ kind: 'text', text: `● I'll start by getting familiar with the codebase for "${issueTitle}".` }],
    [{ kind: 'tool', tool: 'Glob', text: '⏺ Glob src/**/*.{ts,tsx}' }, { kind: 'result', text: '  ⎿ Found 23 files' }],
    [{ kind: 'tool', tool: 'Read', text: `⏺ Read ${file}` }, { kind: 'result', text: '  ⎿ Read 184 lines' }],
    [{ kind: 'thinking', text: '✻ Thinking…' }],
    [
      { kind: 'tool', tool: 'TodoWrite', text: '⏺ Update todo list' },
      { kind: 'result', text: '  ◐ Understand current behaviour' },
      { kind: 'result', text: '  ☐ Implement the change' },
      { kind: 'result', text: '  ☐ Add tests' },
      { kind: 'result', text: '  ☐ Verify in the browser' },
    ],
    [{ kind: 'tool', tool: 'Grep', text: '⏺ Grep "useTodos"' }, { kind: 'result', text: '  ⎿ Found 6 matches in 4 files' }],
    [{ kind: 'text', text: "● The state lives in a single hook. I'll extend it and keep the API backwards compatible." }],
    [{ kind: 'tool', tool: 'Edit', text: `⏺ Edit ${file}` }, { kind: 'result', text: '  ⎿ Updated' }],
    [{ kind: 'tool', tool: 'Write', text: '⏺ Write src/__tests__/feature.test.ts' }, { kind: 'result', text: '  ⎿ Saved' }],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ npm test -- --run' }],
    [
      { kind: 'result', text: '  ⎿ ✓ src/__tests__/feature.test.ts (4 tests) 38ms' },
      { kind: 'result', text: '    Test Files  7 passed (7)' },
    ],
    [{ kind: 'tool', tool: 'Bash', text: `⏺ $ npm run dev -- --port ${port} &` }, { kind: 'result', text: '  ⎿ VITE ready in 412 ms' }],
    () => cb.browserUrl(`http://localhost:${port}/`),
    [{ kind: 'tool', tool: 'mcp__playwright__browser_navigate', text: `⏺ 🌐 navigate http://localhost:${port}/` }, { kind: 'result', text: `  ⎿ Page URL: http://localhost:${port}/` }],
    () => cb.screenshot(Buffer.from(screenshotSvg(issueTitle, `localhost:${port}`, hue)), 'image/svg+xml'),
    [{ kind: 'tool', tool: 'mcp__playwright__browser_take_screenshot', text: '⏺ 🌐 take_screenshot' }, { kind: 'result', text: '  ⎿ Took a screenshot of the current page' }],
    [{ kind: 'text', text: '● Looks right in the browser. Committing and opening a PR.' }],
    [{ kind: 'tool', tool: 'Bash', text: `⏺ $ git commit -am "feat: ${issueTitle.toLowerCase()}"` }, { kind: 'result', text: `  ⎿ [${branch} 3f2a91c] feat: ${issueTitle.toLowerCase()}` }],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ git push -u origin HEAD' }, { kind: 'result', text: '  ⎿ branch set up to track origin' }],
    [{ kind: 'tool', tool: 'Bash', text: `⏺ $ gh pr create --title "${issueTitle}" --body "Closes #${issueNumber}"` }],
  ];
}

function qaScript(cb: SessionCallbacks, pr: number, title: string, round: number): Step[] {
  const port = 5600 + (pr % 50);
  const hue = (pr * 41) % 360;
  return [
    [{ kind: 'text', text: `● Testing PR #${pr} "${title}" (round ${round}). First, the acceptance criteria from the issue.` }],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ git diff origin/main...HEAD --stat' }, { kind: 'result', text: '  ⎿  3 files changed, 82 insertions(+), 9 deletions(-)' }],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ npm ci && npm test -- --run' }],
    [
      { kind: 'result', text: '  ⎿ Test Files  8 passed (8)' },
      { kind: 'result', text: '    Tests  41 passed (41)' },
    ],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ npm run lint && npm run build' }, { kind: 'result', text: '  ⎿ ✓ built in 1.84s' }],
    [{ kind: 'tool', tool: 'Bash', text: `⏺ $ npm run preview -- --port ${port} &` }, { kind: 'result', text: `  ⎿ Local: http://localhost:${port}/` }],
    () => cb.browserUrl(`http://localhost:${port}/`),
    [{ kind: 'tool', tool: 'mcp__playwright__browser_navigate', text: `⏺ 🌐 navigate http://localhost:${port}/` }, { kind: 'result', text: `  ⎿ Page URL: http://localhost:${port}/` }],
    () => cb.screenshot(Buffer.from(screenshotSvg(`QA · ${title}`, `localhost:${port}`, hue)), 'image/svg+xml'),
    [{ kind: 'tool', tool: 'mcp__playwright__browser_take_screenshot', text: '⏺ 🌐 take_screenshot' }, { kind: 'result', text: '  ⎿ Took a screenshot of the current page' }],
    [{ kind: 'tool', tool: 'mcp__playwright__browser_click', text: '⏺ 🌐 click "Add todo" button' }, { kind: 'result', text: '  ⎿ Clicked' }],
    [{ kind: 'tool', tool: 'mcp__playwright__browser_resize', text: '⏺ 🌐 resize 375x740' }, { kind: 'result', text: '  ⎿ Resized' }],
    () => cb.screenshot(Buffer.from(screenshotSvg(`QA · mobile · ${title}`, `localhost:${port}`, (hue + 40) % 360)), 'image/svg+xml'),
    [{ kind: 'tool', tool: 'mcp__playwright__browser_take_screenshot', text: '⏺ 🌐 take_screenshot' }, { kind: 'result', text: '  ⎿ Took a screenshot of the current page' }],
    [{ kind: 'tool', tool: 'mcp__playwright__browser_console_messages', text: '⏺ 🌐 console_messages' }, { kind: 'result', text: '  ⎿ No errors' }],
  ];
}

function researchScript(topic: string, dir: string, doc: string): Step[] {
  const q = topic.length > 50 ? `${topic.slice(0, 49)}…` : topic;
  return [
    [{ kind: 'text', text: `● Researching "${q}". First, what we already know.` }],
    [{ kind: 'tool', tool: 'Glob', text: `⏺ Glob ${dir}/*.md` }, { kind: 'result', text: '  ⎿ Found 2 files' }],
    [{ kind: 'tool', tool: 'WebSearch', text: `⏺ Web Search("${q} ${new Date().getFullYear()}")` }, { kind: 'result', text: '  ⎿ Did 1 search in 2s' }],
    [{ kind: 'tool', tool: 'WebFetch', text: '⏺ Fetch(https://example.com/guide)' }, { kind: 'result', text: '  ⎿ Received 48.2KB (200 OK)' }],
    [{ kind: 'thinking', text: '✻ Thinking…' }],
    [{ kind: 'tool', tool: 'WebSearch', text: `⏺ Web Search("${q} comparison")` }, { kind: 'result', text: '  ⎿ Did 1 search in 3s' }],
    [{ kind: 'tool', tool: 'WebFetch', text: '⏺ Fetch(https://example.org/review)' }, { kind: 'result', text: '  ⎿ Received 31.7KB (200 OK)' }],
    [{ kind: 'text', text: '● Three independent sources agree on the main point; one disagrees on pricing. Writing it up with both.' }],
    [{ kind: 'tool', tool: 'Write', text: `⏺ Write ${doc}` }, { kind: 'result', text: '  ⎿ Wrote 86 lines' }],
    [{ kind: 'tool', tool: 'Edit', text: `⏺ Edit ${dir}/README.md` }, { kind: 'result', text: '  ⎿ Updated' }],
    [{ kind: 'tool', tool: 'Bash', text: `⏺ $ git add -A && git commit -m "Research: ${q}"` }, { kind: 'result', text: '  ⎿ 2 files changed, 87 insertions(+)' }],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ git push -u origin HEAD && gh pr create' }],
  ];
}

function fixScript(pr: number, pushes: boolean): Step[] {
  return [
    [{ kind: 'text', text: `● Reading the QA report for PR #${pr}. The toolbar overflows on phones; I'll let it wrap.` }],
    [{ kind: 'tool', tool: 'Read', text: '⏺ Read src/styles.css' }, { kind: 'result', text: '  ⎿ Read 212 lines' }],
    [{ kind: 'tool', tool: 'Edit', text: '⏺ Edit src/styles.css' }, { kind: 'result', text: '  ⎿ Updated' }],
    [{ kind: 'tool', tool: 'Bash', text: '⏺ $ npm test -- --run' }, { kind: 'result', text: '  ⎿ Test Files  8 passed (8)' }],
    pushes
      ? [{ kind: 'tool', tool: 'Bash', text: '⏺ $ git commit -am "fix: wrap toolbar on narrow screens" && git push origin HEAD' }, { kind: 'result', text: '  ⎿ pushed' }]
      : [{ kind: 'tool', tool: 'Bash', text: '⏺ $ git status --short' }, { kind: 'result', text: '  ⎿  M src/styles.css' }],
  ];
}

/** Fixed evidence and decisions: no random output, web access, files or tracker writes. */
export function demoIdeaResearch(context: {
  idea: IdeaView; records: IdeaRecordView[];
  floors: { id: string }[]; specialists: { id: string; repoId: string; title: string }[];
  request: { question: string } | null;
}): IdeaResearchReport {
  const { idea, floors, specialists, request } = context;
  const base: IdeaResearchReport = { action: 'prd', question: '', requests: [], answer: '', sources: [], prd: null };
  if (request) return { ...base, action: 'evidence', answer: `Demo feasibility evidence for: ${request.question}. The configured floor can own this change; verify the assumptions during review.`, sources: ['https://example.com/demo-research'] };
  if (!floors.length) return { ...base, action: 'clarify', question: 'Configure a target floor in CubeFarm, then reply with the intended outcome.' };
  if (idea.description.includes('[clarify]') && !idea.research?.questions.length) return { ...base, action: 'clarify', question: 'Who is the primary user, and what measurable outcome should this Idea deliver?' };
  const floor = floors.find((f) => idea.floorHints.includes(f.id)) ?? floors[0];
  const specialist = specialists.find((s) => s.repoId === floor.id && /research/i.test(s.title)) ?? specialists.find((s) => s.repoId === floor.id);
  if (specialist && !idea.research?.requests.length) return { ...base, action: 'request', requests: [{ agentId: specialist.id, question: 'Check feasibility and existing research for this Idea on your floor; cite the evidence and open risks.' }] };
  const sources = [...new Set([...idea.links, ...(idea.research?.requests.flatMap((r) => r.sources ?? []) ?? []), 'https://example.com/demo-research'])];
  return { ...base, prd: {
    problem: idea.description,
    outcome: idea.research?.questions.at(-1)?.answer ?? 'A new teammate can complete the requested workflow without assistance.',
    scope: `Deliver the requested workflow on ${floor.id}.${idea.constraints ? ` Constraints: ${idea.constraints}` : ''}`,
    evidence: sources.map((source) => ({ source, finding: 'Illustrative demo evidence; no live research was performed.' })),
    assumptions: ['The target user and feasibility need independent validation; demo evidence is illustrative.'],
    targetFloors: (idea.description.includes('[cross-floor]') ? floors.slice(0, 2) : [floor]).map((f) => ({ repoId: f.id, rationale: 'This configured floor owns part of the demo workflow.' })),
    acceptanceCriteria: ['A new teammate completes the requested workflow in under 3 minutes in 4 of 5 observed trials.', 'The workflow succeeds at desktop and 390px viewport widths with zero uncaught errors.'],
  } };
}

/** Deterministic planning and independent review at the same session boundary as production. */
export function demoIdeaWork(context: {
  phase: string; focus?: string; idea: IdeaView; prd: { prd: import('../shared/types.ts').IdeaPrd };
  previous?: import('../shared/types.ts').ProposalView;
  floors: { id: string; openIssues?: IssueInfo[] }[];
}) {
  if (context.phase === 'review') {
    const disagree = context.idea.description.includes('[disagree]') && context.focus === 'feasibility';
    return { verdict: disagree ? 'findings' : 'endorse', findings: disagree ? ['Validate the target-floor integration with observed user trials.'] : [] };
  }
  const prd = structuredClone(context.prd.prd);
  const targets = prd.targetFloors.map((f) => f.repoId);
  const cross = targets.length > 1;
  const entries = targets.map((repo, i) => ({ key: `work${i + 1}`, repo, requirement: 'R1',
    title: `Deliver Idea workflow ${context.idea.id.slice(0, 8)} on floor ${i + 1}`, brief: prd.scope,
    acceptance: prd.acceptanceCriteria, ...(cross ? { parent: 'tracking' } : {}) }));
  const parents = cross ? [{ key: 'tracking', repo: targets[0], title: 'Track the Idea workflow', summary: prd.outcome }] : [];
  const dependencies = cross ? [{ issue: 'work2', blockedBy: 'work1' }] : [];
  const draft = { entries, parents, dependencies };
  if (context.phase !== 'revise') return draft;
  if (!context.previous?.decision?.wordingOnly) {
    prd.scope += `\nRevision: ${context.previous?.decision?.feedback ?? 'Address the review findings.'}`;
    entries.forEach((e) => { e.brief = prd.scope; });
  }
  return { prd, draft };
}

function fakeIdeaSession(opts: SessionOptions, cb: SessionCallbacks): SessionHandle {
  cb.log([{ kind: 'text', text: '● Inspecting the Idea and linked research (deterministic demo).' }]);
  const timer = setTimeout(() => {
    const context = JSON.parse(opts.prompt);
    const structured = context.phase ? demoIdeaWork(context) : demoIdeaResearch(context);
    cb.finished({ ok: true, text: JSON.stringify(structured), structured, costUsd: 0, turns: 1, errors: [] });
  }, 500);
  return { send: () => undefined, stop: () => {
    clearTimeout(timer);
    cb.finished({ ok: false, text: '', costUsd: 0, turns: 0, errors: ['Stopped'], interrupted: true });
  } };
}

function fakeSession(opts: SessionOptions, cb: SessionCallbacks, fullName: string): SessionHandle {
  if (opts.systemAppend.startsWith('Complete the given Idea phase')) return fakeIdeaSession(opts, cb);
  if (opts.outputSchema && 'action' in (opts.outputSchema.properties as object ?? {})) return fakeIdeaSession(opts, cb);
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const prototypeBranch = opts.systemAppend.match(/ on (prototype\/issue-\S+)\. Answer the question/)?.[1];
  const kind = prototypeBranch ? 'issue' : opts.role === 'qa' ? 'qa' : /FAILED|taking over pull request|git push origin HEAD:/.test(opts.prompt) ? 'fix' : opts.role === 'researcher' ? 'research' : 'issue';
  const prMatch = opts.prompt.match(/pull request #(\d+)(?::\s*(.+))?/);
  const issueMatch = opts.prompt.match(/#(\d+):\s*(.+)/);
  const number = Number((kind === 'issue' ? issueMatch?.[1] : prMatch?.[1]) ?? 0);
  const security = kind === 'qa' && opts.prompt.startsWith('Please perform a detailed security review of');
  const title = (kind === 'issue' ? issueMatch?.[2] : prMatch?.[2])?.trim() ?? 'follow-up';
  const round = Number(opts.prompt.match(/QA round (\d+)/)?.[1] ?? 1);
  // Now and then a QA fix ends without pushing, so the office's "no new commits" check can be seen.
  const pushes = kind !== 'fix' || !/^Fix your pull request|taking over pull request/.test(opts.prompt) || Math.random() > 0.25;

  const header: Step = [
    { kind: 'system', text: `✻ Claude Code (demo) · ${opts.model} · ${opts.effort} effort` },
    { kind: 'system', text: `  cwd ${opts.cwd}` },
  ];
  // Research: an issue on a floor, or a brief filed by pull request.
  const topic = (issueMatch?.[2] ?? opts.prompt.match(/Topic: (.+)/)?.[1] ?? 'the brief').trim();
  const docName = `${new Date().toISOString().slice(0, 10)}-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}.md`;
  const dir = fullName === COMPANY_REPO ? 'docs/research/company' : 'docs/research';
  const doc = `${dir}/${docName}`;
  const body: Step[] = prototypeBranch ? [
    [{ kind: 'text', text: '● Testing the question with a small demo and sample data.' }],
    [{ kind: 'tool', tool: 'Write', text: '⏺ Write prototype walkthrough and findings' }],
    () => cb.screenshot(Buffer.from(screenshotSvg(title, 'Demo prototype', 200)), 'image/svg+xml'),
    [{ kind: 'text', text: '● Updating the draft PR with the walkthrough and screenshot for the manager.' }],
  ] : security ? [[{ kind: 'text' as const, text: '● Checking the changed trust boundaries and validating the simulated audit reports.' }]]
    : kind === 'qa' ? qaScript(cb, number, title, round) : kind === 'fix' ? fixScript(number, pushes) : kind === 'research' ? researchScript(topic, dir, doc) : devScript(opts, cb, number, title);
  const script = [header, ...body];

  const finish = () => {
    const costUsd = 0.3 + Math.random();
    const turns = 15 + Math.floor(Math.random() * 20);
    cb.tool(null);
    if (security) {
      cb.finished({
        ok: true, text: '', costUsd, turns, errors: [],
        structured: {
          verdict: 'pass', summary: 'The simulated scoped audit passed.',
          validationGap: 'no-os-sandbox', normalGatesPassed: true, blockingFindings: 'none',
          checks: [
            ...['Scoped audit coverage', 'validate-findings.cjs', 'validate-coverage-ledger.cjs']
              .map((name) => ({ name, result: 'pass', details: 'Passed in the demo fixture; normal QA/CI gates passed.' })),
            { name: 'Dynamic validation', result: 'skip', details: 'No OS sandbox on this demo desk.' },
          ],
          commands: [], screenshots: [],
        },
      });
      return;
    }
    if (kind === 'qa') {
      if (opts.prompt.includes('[environment]')) {
        cb.finished({
          ok: true, text: '', costUsd, turns, errors: [],
          structured: {
            verdict: 'fail', summary: 'The changed behavior passed; local validation stopped because the demo worker exhausted memory. No code defect was found.',
            checks: [
              { name: 'Changed behavior', result: 'pass', details: 'Acceptance criteria passed in the demo fixture.' },
              { name: 'Local suite', result: 'fail', failureKind: 'resources', details: 'Simulated worker memory exhaustion: the suite was cancelled, not timed out.',
                resources: { freeMemory: '0.8 GB', swap: '0 B', load: '61', cancelled: 204 } },
            ],
            commands: [{ command: 'npm test', result: 'Interrupted by simulated worker memory exhaustion.' }],
            screenshots: [],
          },
        });
        return;
      }
      // Most first rounds pass; some fail so the fix loop can be seen in action.
      const pass = round > 1 || Math.random() > 0.35;
      const introducedBySha = opts.prompt.match(/Known contribution SHAs: ([0-9a-f]+)/)?.[1];
      cb.log([{ kind: 'text', text: pass ? '● Everything checks out. Writing up the report.' : '● The toolbar overflows on a 375px screen. Failing this round.' }]);
      cb.finished({
        ok: true,
        text: '',
        costUsd,
        turns,
        errors: [],
        structured: {
          verdict: pass ? 'pass' : 'fail',
          summary: pass
            ? 'The change does what the issue asks: the feature works on desktop and mobile, all 41 tests pass, and lint and build are clean.'
            : 'The feature works on desktop, but on a 375px-wide screen the toolbar overflows and the new button is cut off.',
          checks: [
            { name: 'Unit tests', result: 'pass', details: '41 passed, 0 failed' },
            { name: 'Lint + build', result: 'pass', details: 'No lint errors; production build succeeds' },
            { name: 'Feature works on desktop', result: 'pass', details: 'Clicked through the new flow at 1280x800' },
            pass ? { name: 'Mobile layout (375px)', result: 'pass', details: 'Layout wraps correctly' } : {
              name: 'Mobile layout (375px)', result: 'fail', failureKind: 'code', findingKey: 'mobile-toolbar', confirmed: true,
              details: 'Toolbar overflows horizontally; button unreachable. Reproduced at the PR head; the base branch wraps correctly.',
              // The first known contribution is the original submission, so the inherited-defect repair handoff can be seen.
              ...(introducedBySha && { introducedBySha }),
            },
            { name: 'Console errors', result: 'pass', details: 'None' },
          ],
          commands: [
            { command: 'npm test -- --run', result: '41 passed' },
            { command: 'npm run lint && npm run build', result: 'clean, built in 1.84s' },
          ],
          screenshots: ['Desktop view after the change', 'Mobile view at 375px'],
          fixInstructions: pass ? undefined : 'Make the toolbar wrap (flex-wrap: wrap) below 480px so every button stays visible.',
        },
      });
      return;
    }
    if (kind === 'fix') {
      const pr = repos.get(fullName)?.pulls.find((p) => p.number === number);
      if (pr && pushes) {
        pr.headSha = fakeSha();
        pr.mergeState = 'CLEAN';
        pr.mergeable = 'MERGEABLE';
        runChecks(pr, false);
      }
      cb.log([{ kind: 'text', text: pushes ? `● Fixed PR #${number} and pushed. Ready for another QA round.` : '● The toolbar wraps on narrow screens now. Ready for another QA round.' }]);
      cb.finished({ ok: true, text: '', costUsd, turns, errors: [] });
      return;
    }
    if (kind === 'research') {
      const repo = repos.get(fullName);
      const branch = opts.systemAppend.match(/Your branch: (\S+)/)?.[1];
      const answer = `Three of four sources agree on the main point, so I recommend following them; the doc compares all four, with links, and lists what is still open.`;
      if (!repo || !branch) {
        cb.finished({ ok: false, text: '', costUsd, turns, errors: ['No research worktree'] });
        return;
      }
      const n = repo.nextNumber++;
      const url = `https://github.com/${fullName}/pull/${n}`;
      repo.pulls.unshift({
        number: n,
        title: `Research: ${topic}`,
        url,
        headRefName: branch,
        isCrossRepository: false,
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        closesIssues: number ? [number] : [],
        createdAt: now(),
        mergedAt: null,
        additions: 87,
        deletions: 0,
        checks: 'pending',
        headSha: fakeSha(),
        mergeState: 'CLEAN',
        failedChecks: [],
        pendingChecks: [],
      });
      runChecks(repo.pulls[0], false);
      cb.log([{ kind: 'result', text: `  ⎿ ${url}` }, { kind: 'text', text: `● ${answer}` }]);
      cb.finished({ ok: true, text: `${answer}\n${url}`, costUsd, turns, errors: [] });
      return;
    }
    const repo = repos.get(fullName);
    let url = '';
    if (title.includes('[no-pr]')) { // a run that ends without a pull request, for the run history
      cb.log([{ kind: 'text', text: '● Stopping here without a pull request (demo [no-pr] issue).' }]);
      cb.finished({ ok: true, text: '', costUsd, turns, errors: [] });
      return;
    }
    if (repo && number) {
      const existing = prototypeBranch && repo.pulls.find((p) => p.state === 'OPEN' && p.headRefName === prototypeBranch);
      if (existing) {
        existing.headSha = fakeSha();
        cb.finished({ ok: true, text: existing.url, costUsd, turns, errors: [] });
        return;
      }
      const n = repo.nextNumber++;
      url = `https://github.com/${fullName}/pull/${n}`;
      repo.pulls.unshift({
        number: n,
        title,
        url,
        headRefName: prototypeBranch ?? `swarm/issue-${number}-${path.basename(opts.cwd).replace(/-[0-9a-f]{4}$/, '')}`,
        isCrossRepository: false,
        state: 'OPEN',
        isDraft: !!prototypeBranch,
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        closesIssues: prototypeBranch ? [] : [number],
        createdAt: now(),
        mergedAt: null,
        additions: 40 + ((number * 13) % 200),
        deletions: (number * 7) % 40,
        checks: 'pending',
        headSha: fakeSha(),
        mergeState: 'CLEAN',
        failedChecks: [],
        pendingChecks: [],
      });
      if (!prototypeBranch) runChecks(repo.pulls[0]);
      cb.log([{ kind: 'result', text: `  ⎿ ${url}` }]);
    }
    if (prototypeBranch) {
      cb.finished({ ok: true, text: url, costUsd, turns, errors: [] });
      return;
    }
    cb.log([{ kind: 'text', text: `● Opened ${url || 'the pull request'}. It closes #${number} and includes tests.` }]);
    cb.finished({ ok: true, text: url, costUsd, turns, errors: [] });
  };

  let i = 0;
  const step = () => {
    if (stopped) return;
    if (i >= script.length) return finish();
    const s = script[i++];
    if (typeof s === 'function') s();
    else {
      const tool = s.find((e) => e.kind === 'tool');
      cb.tool(tool?.tool ?? null);
      cb.log(s);
    }
    timers.push(setTimeout(step, 1600 + Math.random() * 3800));
  };
  timers.push(setTimeout(step, 600));

  return {
    send(text) {
      timers.push(
        setTimeout(() => {
          if (stopped) return;
          cb.log([{ kind: 'text', text: `● Got it — "${text.slice(0, 60)}". Adjusting my approach.` }]);
        }, 1500),
      );
    },
    stop() {
      stopped = true;
      timers.forEach(clearTimeout);
      cb.finished({ ok: false, text: '', costUsd: 0.1, turns: i, errors: ['Stopped by manager'] });
    },
  };
}

// ---------- the terminal runtime ----------

const ANSI: Record<LogEntry['kind'], (text: string) => string> = {
  text: (t) => t.replace(/^● /, '\x1b[97m●\x1b[0m '),
  tool: (t) => `\x1b[32m●\x1b[0m \x1b[1m${t.replace(/^⏺ /, '')}\x1b[0m`,
  result: (t) => `\x1b[2m${t}\x1b[0m`,
  thinking: (t) => `\x1b[35m${t}\x1b[0m`,
  error: (t) => `\x1b[31m${t}\x1b[0m`,
  system: (t) => `\x1b[2m${t}\x1b[0m`,
  manager: (t) => `\x1b[36m${t.replace(/^▶ /, '❯ ')}\x1b[0m`,
  done: (t) => `\x1b[32m${t}\x1b[0m`,
};

/**
 * With a terminal (the terminal runtime), the fake session's lines are drawn there the way Claude Code draws them,
 * and what the manager types into it is taken as a message.
 */
function inTerminal(opts: SessionOptions, cb: SessionCallbacks, start: (cb: SessionCallbacks) => SessionHandle): SessionHandle {
  const term = opts.terminal;
  if (!term) return start(cb);
  const name = CLIS.find((c) => c.id === (opts.cli ?? 'claude'))?.label ?? 'Claude Code';
  term.note(`── ${name}${opts.label ? ` · ${opts.label}` : ''} ──`);
  term.write(
    [
      '',
      ` \x1b[38;5;209m▐▛███▜▌\x1b[0m   \x1b[1m${name}\x1b[0m (demo)`,
      `\x1b[38;5;209m▝▜█████▛▘\x1b[0m  ${opts.model || 'default model'} · ${opts.effort} effort`,
      `\x1b[38;5;209m  ▘▘ ▝▝\x1b[0m    \x1b[2m${opts.cwd}\x1b[0m`,
      '',
      `\x1b[36m❯\x1b[0m ${opts.prompt.split('\n')[0].slice(0, 200)}`,
      '',
    ].join('\r\n'),
  );
  let handle: SessionHandle | null = null;
  let line = '';
  term.bind({
    write: (data) => {
      for (const ch of data.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b./g, '')) {
        if (ch === '\r') {
          const text = line.trim();
          line = '';
          term.write('\r\n');
          if (text && handle) {
            cb.log([{ kind: 'manager', text: `▶ Typed in the terminal: ${text}` }]);
            handle.send(text);
          }
        } else if (ch === '\x7f' || ch === '\b') {
          if (line) term.write('\b \b');
          line = line.slice(0, -1);
        } else if (ch >= ' ') {
          line += ch;
          term.write(ch);
        }
      }
    },
    resize: () => undefined,
  });
  handle = start({
    ...cb,
    log: (entries) => {
      cb.log(entries);
      for (const e of entries) term.write(`${e.kind === 'tool' || (e.kind === 'text' && e.text.startsWith('●')) ? '\r\n' : ''}${ANSI[e.kind](e.text)}\r\n`);
    },
    finished: (r) => {
      term.bind(null);
      term.note(`── ${name} session ended ──`);
      cb.finished(r);
    },
  });
  return handle;
}

// Claude's usage warning, faked once so the office can be seen pacing new work: the 4th session gets it, and the
// window "resets" 5 minutes later.
const USAGE_WARNING_AT = 4;
const USAGE_WARNING_MS = 5 * 60_000;
let sessionsStarted = 0;

function fakeUsageWarning(cb: SessionCallbacks) {
  setTimeout(() => {
    const resetsAt = Date.now() + USAGE_WARNING_MS;
    cb.log([{ kind: 'error', text: `⚠ Subscription usage warning (five_hour) · resets ${new Date(resetsAt).toLocaleTimeString()} (demo)` }]);
    cb.usageWarning?.({ resetsAt, rateLimitType: 'five_hour', utilization: 0.82 });
  }, 3000);
}

const fakeClis = () => CLIS.map((c) => ({ id: c.id, label: c.label, installed: true, version: 'demo', integrated: c.integrated }));

const demoResources = (profile = ''): MachineSample => ({
  at: Date.now(), cpus: 4, cpuPercent: profile.startsWith('cpu-busy') ? 97 : 25, load1: profile.startsWith('cpu-busy') ? 8 : 1,
  memoryTotal: 16 * 1024 ** 3, memoryAvailable: (profile.startsWith('memory-busy') ? 0.5 : 10) * 1024 ** 3,
  memoryPressure: null, cpuStall: profile.startsWith('cpu-busy') ? 40 : 0, memoryStall: profile.startsWith('memory-busy') ? 20 : 0,
  ioStall: profile.startsWith('io-busy') ? 30 : 0,
});

/**
 * A pretend box: it "connects" after a moment (one whose destination starts with "offline" never does; "no-hooks": its
 * CLIs can't reach its hook URL), and its desks and fake sessions are the demo's own under its folder, labelled with
 * its name in the terminal. One whose destination starts with "stale" runs an older commit than the office, so it's
 * brought up to date; "stale-keeper": and that update changes its terminal keeper, which restarts once its agents finish.
 * One starting with "old" too, but its cubefarm predates --update: the first try fails, as if the manager then updated
 * it by hand, so Look again moves it.
 */
function fakeBox(opts: BoxOptions, desks: Pick<Machine, 'mainDir' | 'deskDir' | 'deskExists' | 'prepareDesk' | 'removeDesk' | 'releaseDesk' | 'deskHead' | 'deskAhead'>, start: Machine['startSession']): BoxConnection {
  let status: 'connecting' | 'online' | 'offline' = 'connecting';
  let running = 0;
  let telemetry: MachineTelemetry | null = null;
  let stopResources: (() => void) | undefined;
  const offline = /^offline/i.test(opts.box.destination);
  const claudeOnly = /^claude-only/i.test(opts.box.destination);
  let clis: CliView[] = [];
  const noHooks = /^no-hooks/i.test(opts.box.destination);
  let tooOld = /^old/i.test(opts.box.destination);
  let commit = /^(stale|old)/i.test(opts.box.destination) ? `5ta1e00${'0'.repeat(33)}` : DEMO_HEAD;
  let pulled = commit;
  let keeperStale = /^restart-demo/i.test(opts.box.destination);
  const keeperChanges = /^stale-keeper/i.test(opts.box.destination);
  let ready: (() => void) | undefined;
  const connected = opts.box.upstash ? new Promise<void>((resolve) => { ready = resolve; }) : Promise.resolve();
  let timer = setTimeout(async () => {
    status = offline ? 'offline' : 'online';
    if (!offline) clis = await machine.detectClis();
    if (!offline) stopResources = monitorResources(async () => demoResources(opts.box.destination), (value) => { telemetry = value; opts.changed(); });
    opts.changed();
    ready?.();
  }, 1500);
  const workspaces = `/boxes/${opts.box.name}/workspaces`;
  const machine: Machine = {
    ...desks,
    startSession: (o, cb) => {
      running += 1;
      opts.changed();
      let over = false;
      // Hooks that never reach the office: said a moment in; the office follows the transcript until the session ends.
      if (noHooks) {
        setTimeout(() => {
          if (over) return;
          cb.log([{ kind: 'error', text: `${bootNotice('Claude Code', 'esc to interrupt', 'http://127.0.0.1:41234/api/hooks').text} (demo)` }]);
          cb.boot?.('no-hooks');
        }, 2000);
      }
      return start({ ...o, label: `${o.label ?? ''} @ ${opts.box.name}`.trim() }, {
        ...cb,
        finished: (r) => {
          over = true;
          running -= 1;
          opts.changed();
          if (noHooks) cb.boot?.(null);
          cb.finished(r);
        },
      });
    },
    terminals: true,
    detectClis: async () => fakeClis().map((c) => (claudeOnly && c.id !== 'claude' ? { ...c, installed: false, version: null } : c)),
  };
  return {
    machine,
    state: () => ({
      status,
      error: offline && status === 'offline' ? 'ssh: connect to host: Connection timed out (demo)' : null,
      info: status === 'online' ? { platform: 'linux', version: 'demo', commit, git: 'git version 2.47.0 (demo)', ghReady: true, hookError: noHooks ? 'http://127.0.0.1:41234/api/hooks/cubefarm-probe: ECONNREFUSED (demo)' : null, workspaces, sep: '/', keeperStale, reboot: /^restart-demo/i.test(opts.box.destination) ? { required: true, reason: 'A software update is available and needs an OS restart to install (demo).' } : { required: false, reason: null } } : null,
      // A box whose destination starts with "claude-only" has just Claude Code: other agents can't move there.
      clis: status === 'online' ? clis : [],
      running,
      reported: status === 'online',
      refused: false,
      telemetry,
    }),
    reconnected: connected.then(() => []), // fake sessions end with the office
    hooksReady: () => undefined,
    // An online box detects again on the same link; an offline one tries connecting and still fails.
    check: async () => {
      if (opts.box.upstash) await connected;
      if (status === 'online') {
        clis = await machine.detectClis();
        return opts.changed();
      }
      if (status !== 'offline') return opts.changed();
      status = 'connecting';
      opts.changed();
      await new Promise((r) => setTimeout(r, 1000));
      status = 'offline';
      opts.changed();
      throw new Error('ssh: connect to host: Connection timed out (demo)');
    },
    // A pull and a build take a moment; a new link runs the new commit (its sessions carry on), a restart its keeper too.
    update: async (target) => {
      await new Promise((r) => setTimeout(r, 3000));
      if (tooOld) {
        tooOld = false;
        throw new Error(updateFailure(opts.box.name, 'cubefarm box: an office starts this over ssh: cubefarm box --stdio --office <office id>', 1));
      }
      const from = pulled;
      pulled = target;
      return { ok: true, checkout: true, from, to: target };
    },
    relink: async () => {
      status = 'connecting';
      opts.changed();
      await new Promise<void>((r) => (timer = setTimeout(r, 1500)));
      if (commit !== pulled) keeperStale = keeperChanges;
      commit = pulled;
      status = 'online';
      opts.changed();
    },
    restart: async () => {
      status = 'connecting';
      opts.changed();
      await new Promise<void>((r) => (timer = setTimeout(r, 1500)));
      commit = pulled;
      keeperStale = false;
      status = 'online';
      opts.changed();
    },
    close: () => { clearTimeout(timer); stopResources?.(); },
  };
}

export function createDemoBackend(): Backend {
  if (!repos.has(COMPANY_REPO)) {
    repos.set(COMPANY_REPO, { fullName: COMPANY_REPO, description: 'Company research', issues: [], pulls: [], nextNumber: 1 });
  }
  // Tie each fake session back to its repo via the desk directory name.
  const deskRepo = new Map<string, string>();
  const deskBranches = new Map<string, string | null>();
  const deskPulls = new Map<string, number | undefined>();
  const workerBlocked = new Set<string>();
  /** Fake desks under a folder: the office's own (/demo), or a box's. */
  const desks = (root: string) => ({
    mainDir: (fullName: string) => `${root}/${fullName}/main`,
    deskDir: (fullName: string, slug: string) => `${root}/${fullName}/desks/${slug}`,
    deskExists: async (fullName: string, slug: string) => deskRepo.has(`${root}/${fullName}/desks/${slug}`),
    prepareDesk: async (fullName: string, base: { pr?: number }, slug: string, branch: string, note?: (text: string) => void) => {
      await new Promise((r) => setTimeout(r, 900));
      // A [worker-blocked] PR's first QA desk fails as a full disk would, so the retry shows in the run history.
      const blocked = repos.get(fullName)?.pulls.find((pr) => pr.number === base.pr && pr.title.includes('[worker-blocked]'));
      if (blocked && branch.startsWith('qa/') && !workerBlocked.has(`${fullName}#${blocked.number}`)) {
        workerBlocked.add(`${fullName}#${blocked.number}`);
        throw new Error('Simulated worker failure: ENOSPC: no space left on device');
      }
      const dir = `${root}/${fullName}/desks/${slug}`;
      const holder = [...deskBranches].find(([d, b]) => b === branch && d !== dir && deskRepo.get(d) === fullName)?.[0];
      if (holder) note?.(`${branch} is checked out at ${holder}; this desk uses detached HEAD at origin/pr/${base.pr}. Push fixes with git push origin HEAD:${branch}.`);
      deskBranches.set(dir, holder ? null : branch);
      deskRepo.set(dir, fullName);
      deskPulls.set(dir, base.pr);
      return dir;
    },
    removeDesk: async () => undefined,
    releaseDesk: async () => undefined,
    deskAhead: async () => 0,
    deskHead: async (fullName: string, slug: string) => repos.get(fullName)?.pulls
      .find((pr) => pr.number === deskPulls.get(`${root}/${fullName}/desks/${slug}`))?.headSha ?? 'demo-head',
  });
  const startSession: Machine['startSession'] = (opts, cb) => {
    if (++sessionsStarted === USAGE_WARNING_AT) fakeUsageWarning(cb);
    const fullName = deskRepo.get(opts.cwd) ?? (opts.role === 'researcher' ? '' : [...repos.keys()][0]);
    return inTerminal(opts, cb, (c) => (opts.role === 'ceo' ? ceoSession(opts, c) : fakeSession(opts, c, fullName)));
  };
  // A pretend projects folder: the demo repos, one git folder that isn't on GitHub yet, and one plain folder.
  const folders = new Map<string, LocalFolder>();
  const addFolder = (name: string, github: string | null, git = true) =>
    folders.set(name, { name, path: `/demo/projects/${name}`, git, github, modified: Date.now() - folders.size * 3_600_000 });
  for (const r of repos.values()) addFolder(r.fullName.split('/')[1], r.fullName);
  addFolder('sketchbook', null);
  addFolder('recipe-notes', null, false);
  const newRepo = (name: string, description = '') => {
    const fullName = `demo-co/${name}`;
    if (!repos.has(fullName)) {
      repos.set(fullName, { fullName, description, issues: [], pulls: [], nextNumber: 1 });
      bareRepos.add(fullName);
    }
    addFolder(name, fullName);
    return fullName;
  };
  const folderOf = (dir: string) => {
    const f = folders.get(dir.replace(/\\/g, '/').split('/').pop() ?? '');
    if (!f) throw new Error(`${dir} is not a folder`);
    return f;
  };
  return {
    demo: true,
    resources: async () => demoResources(),
    user: async () => 'demo-manager',
    listMyRepos: async (): Promise<GhRepoSummary[]> =>
      [...repos.values()].filter((r) => r.fullName !== COMPANY_REPO).map((r) => ({ nameWithOwner: r.fullName, description: r.description, visibility: 'PUBLIC', updatedAt: now() })),
    repoMeta: async (fullName) => {
      const r = repos.get(fullName);
      if (!r) throw new Error(`Unknown demo repo ${fullName}`);
      return { nameWithOwner: fullName, description: r.description, url: `https://github.com/${fullName}`, defaultBranch: 'main' };
    },
    setLocalPath: () => undefined,
    scanProjects: async () => [...folders.values()].sort((a, b) => b.modified - a.modified),
    inspectFolder: async (dir) => folderOf(dir),
    publishFolder: async (dir, opts) => {
      const f = folderOf(dir);
      return f.github ?? newRepo(f.name, opts.description);
    },
    createProject: async (_root, name, opts) => {
      if (folders.has(name)) throw new Error(`/demo/projects/${name} already exists. Pick another name, or connect that folder instead.`);
      return { fullName: newRepo(name, opts.description), path: `/demo/projects/${name}` };
    },
    listIssues: async (fullName) => (repos.get(fullName)?.issues ?? []).map((i) => ({ ...i,
      bodyBlockers: dependencyUrls(i.body).map((b) => ({ ...b, state: closedIssues.has(`${b.repo}#${b.number}`) ? 'CLOSED' : 'OPEN' })),
      subIssues: i.subIssues ?? { total: 0, completed: 0 },
      nativeBlockers: (i.nativeBlockers ?? []).map((b) => ({ ...b,
        state: closedIssues.has(`${b.repo ?? fullName}#${b.number}`) ? 'CLOSED' : b.state,
      })),
    })),
    listPulls: async (fullName) => ({ pulls: [...(repos.get(fullName)?.pulls ?? [])] }),
    createIssue: async (fullName, title, body, labels = []) => {
      const r = repos.get(fullName);
      if (!r) throw new Error('Unknown repo');
      if (refusing(fullName) || (demoTracker.refusedCreates.get(fullName) ?? 0) > Date.now()) throw new CommandError('gh issue create failed: HTTP 403', 'HTTP 403: Resource not accessible by integration', 1, '');
      const n = r.nextNumber++;
      r.issues.push(issue(n, title, body, fullName, labels));
      if (demoTracker.lostCreates > 0) {
        demoTracker.lostCreates--;
        throw new Error('connection reset before GitHub answered');
      }
      return n;
    },
    issueAccess: async (fullName) => {
      if (!repos.has(fullName)) throw new CommandError(`gh repo view ${fullName} failed`, 'GraphQL: Could not resolve to a Repository', 1, '');
      return { repo: fullName, issues: true, permission: refusing(fullName) ? 'READ' : 'ADMIN' };
    },
    readIssue: async (fullName, number) => {
      const i = repos.get(fullName)?.issues.find((x) => x.number === number);
      const closed = closedIssues.get(`${fullName}#${number}`);
      return i ? tracked(fullName, i) : closed ? { ...closed, labels: [...closed.labels] } : null;
    },
    findIssuesByMarker: async (fullName, marker) => [
      ...(repos.get(fullName)?.issues ?? []).map((i) => tracked(fullName, i)),
      ...[...closedIssues.values()].filter((i) => i.repo === fullName).map((i) => ({ ...i, labels: [...i.labels] })),
    ].filter((i) => i.body.includes(marker)),
    issueState: async (fullName, number) => {
      const r = repos.get(fullName);
      return r?.issues.some((i) => i.number === number) ? 'OPEN' : closedIssues.has(`${fullName}#${number}`) ? 'CLOSED' : null;
    },
    closeIssue: async (fullName, number, reason, _comment) => {
      const r = repos.get(fullName);
      const i = r?.issues.find((x) => x.number === number);
      if (!r || (!i && !closedIssues.has(`${fullName}#${number}`))) throw new Error(`Unknown issue #${number}`);
      if (refusing(fullName)) throw new CommandError('gh issue close failed: HTTP 403', 'HTTP 403: Resource not accessible by integration', 1, '');
      if (i) closedIssues.set(`${fullName}#${number}`, { ...tracked(fullName, i), state: 'CLOSED', stateReason: reason === 'completed' ? 'completed' : 'not_planned' });
      r.issues = r.issues.filter((x) => x.number !== number);
    },
    editIssue: async (fullName, number, edit) => {
      const i = repos.get(fullName)?.issues.find((x) => x.number === number);
      if (!i) throw new Error(`Unknown issue #${number}`);
      if (refusing(fullName)) throw new CommandError('gh issue edit failed: HTTP 403', 'HTTP 403: Resource not accessible by integration', 1, '');
      if (edit.title !== undefined) i.title = edit.title;
      if (edit.body !== undefined) i.body = edit.body;
      i.labels = [...i.labels.filter((l) => !edit.removeLabels?.includes(l)), ...(edit.addLabels ?? []).filter((l) => !i.labels.includes(l))];
    },
    mergePull: async (fullName, number, _method, headSha) => {
      const r = repos.get(fullName);
      const pr = r?.pulls.find((p) => p.number === number);
      if (!r || !pr) throw new Error('Unknown PR');
      if (headSha && pr.headSha !== headSha) throw new Error('Head branch was modified. Review and try the merge again.');
      mergedSinceSync.set(fullName, (mergedSinceSync.get(fullName) ?? 0) + 1);
      pr.state = 'MERGED';
      pr.mergedAt = now();
      for (const i of r.issues.filter((x) => pr.closesIssues.includes(x.number))) {
        closedIssues.set(`${fullName}#${i.number}`, { ...tracked(fullName, i), state: 'CLOSED', stateReason: 'completed' });
      }
      r.issues = r.issues.filter((i) => !pr.closesIssues.includes(i.number));
    },
    updateBranch: async (fullName, number) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.number === number);
      if (!pr) throw new Error('Unknown PR');
      Object.assign(pr, { headSha: fakeSha(), mergeState: 'CLEAN' });
      runChecks(pr, false);
    },
    rerunFailedJobs: async (fullName, runIds) => {
      for (const pr of repos.get(fullName)?.pulls ?? []) {
        if (runIds.includes(pr.number) && pr.checks === 'failing') runChecks(pr, false);
      }
    },
    markPullReady: async (fullName, number) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.number === number);
      if (!pr) throw new Error('Unknown PR');
      pr.isDraft = false;
    },
    setSecurityReviewLabel: async (fullName, number, present) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.number === number);
      if (!pr) throw new Error('Unknown PR');
      pr.labels = (pr.labels ?? []).filter((label) => label !== READY_FOR_SECURITY_REVIEW);
      if (present) pr.labels.push(READY_FOR_SECURITY_REVIEW);
    },
    closePull: async (fullName, number) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.number === number);
      if (pr) pr.state = 'CLOSED';
    },
    prForBranch: async (fullName, branch) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.headRefName === branch && p.state === 'OPEN' && !p.isCrossRepository);
      return pr ? { number: pr.number, url: pr.url } : null;
    },
    branchAhead: async () => 0, // the fake sessions always open their PR
    containsCommit: async () => true,
    qaCi: async (fullName, headSha) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.headSha === headSha);
      return { headSha, observedAt: Date.now(), availability: pr ? 'available' : 'unavailable', checks: pr ? [{
        id: `demo-check-${headSha}`, runId: `demo-run-${headSha}`, name: 'Demo CI', status: 'COMPLETED',
        conclusion: pr.checks === 'passing' ? 'SUCCESS' : pr.checks === 'failing' ? 'FAILURE' : null,
        url: `${pr.url}/checks`,
      }] : [] };
    },
    prDetails: async (fullName, number) => {
      const pr = repos.get(fullName)?.pulls.find((p) => p.number === number);
      if (!pr) throw new Error(`Unknown PR #${number}`);
      return {
        number,
        title: pr.title,
        createdAt: pr.createdAt,
        labels: pr.labels ?? [],
        isDraft: pr.isDraft,
        body: prototypeIssueNumber(pr.headRefName)
          ? '## Question and scope\nDemo prototype.\n\n## How to run and review\nOpen Preview and try the example.\n\n## Screenshots\n![Demo screenshot](https://example.invalid/demo.png)\n\n## Findings and limitations\nIllustrative fixture only.'
          : `Implements the change.\n\nCloses #${pr.closesIssues[0] ?? '?'}`,
        url: pr.url,
        headRefName: pr.headRefName,
        headSha: pr.headSha,
        baseSha: 'demo-base',
        isCrossRepository: pr.isCrossRepository === true,
        closesIssues: pr.closesIssues,
        state: pr.state,
        mergeable: pr.mergeable,
        mergeState: pr.mergeState,
      };
    },
    issueDetails: async (fullName, number) => {
      const i = repos.get(fullName)?.issues.find((x) => x.number === number);
      return { title: i?.title ?? `Issue #${number}`, body: i?.body ?? '' };
    },
    commentIssue: async (fullName, number) => {
      if (!repos.get(fullName)?.issues.some((i) => i.number === number)) throw new Error(`Unknown issue #${number}`);
      return `https://github.com/${fullName}/issues/${number}#issuecomment-${Date.now()}`;
    },
    commentPull: async (fullName, number) => `https://github.com/${fullName}/pull/${number}#issuecomment-${Date.now()}`,
    uploadEvidence: async (fullName, filePath) => `https://github.com/${fullName}/raw/swarm-qa-evidence/${filePath}`,
    ensureClone: async () => new Promise((r) => setTimeout(r, 400)),
    syncMain: async (fullName, _branch, { touch }) => {
      const behind = mergedSinceSync.get(fullName) ?? 0;
      if (behind === 0) return { status: 'in sync', behind: 0, updatable: false };
      if (!touch) return { status: `update ready (${behind} commit${behind === 1 ? '' : 's'})`, behind, updatable: true };
      mergedSinceSync.set(fullName, 0);
      return { status: `updated to ${fakeSha().slice(0, 7)}`, behind: 0, updatable: false };
    },
    ...desks('/demo'),
    prepareResearchFolder: async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
    startSession,
    terminals: true,
    reconnectClis: async () => [], // fake sessions end with the office
    hooksReady: () => undefined,
    releaseClis: async () => undefined,
    detectClis: async () => fakeClis(),
    connectBox: (opts) => fakeBox(opts, desks(`/boxes/${opts.box.name.replace(/[^\w.-]+/g, '-')}`), startSession),
    previews: demoPreviews,
    office: demoOffice,
  };
}

// ---------- the office's own update ----------

/**
 * Floor 1's folder plays the office's own folder, so merges there make an update ready. There is a launcher when
 * the real one started the demo, or with SWARM_DEMO_LAUNCHER=1; either way the update is faked: a short pause, then
 * the result message, and nothing restarts.
 */
const OFFICE_REPO = 'demo-co/pixel-todo';
const DEMO_HEAD = `0ff1ce5${'0'.repeat(33)}`;
const lastFakeUpdate = { to: '', commits: 0 };
const demoOffice: OfficeHost = {
  launcher: underLauncher() || process.env.SWARM_DEMO_LAUNCHER === '1',
  head: async () => DEMO_HEAD,
  isOwnFolder: (dir) => dir === `/demo/${OFFICE_REPO}/main`,
  // Only its own fake updates have a count; one the real launcher did (u) gets no count rather than a wrong one.
  commitsBetween: async (_from, to) => (to === lastFakeUpdate.to ? lastFakeUpdate.commits : null),
  takeLastUpdate: () => takeLastUpdate(HOME_DIR),
  async update(from) {
    await new Promise((r) => setTimeout(r, 4000));
    lastFakeUpdate.commits = mergedSinceSync.get(OFFICE_REPO) ?? 0;
    mergedSinceSync.set(OFFICE_REPO, 0);
    lastFakeUpdate.to = fakeSha();
    return { from, to: lastFakeUpdate.to, ok: true, installed: true, built: true, at: Date.now() };
  },
};

// ---------- the demo preview ----------

function placeholderPage(title: string, hue: number) {
  const safe = title.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe}</title><link rel="icon" href="data:,">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: 'Segoe UI', Arial, sans-serif; background: hsl(${hue},60%,96%); color: #222; }
  main { text-align: center; padding: 32px 40px; background: #fff; border-radius: 18px; box-shadow: 0 8px 30px hsla(${hue},50%,40%,.18); }
  h1 { margin: 0 0 6px; font-size: 26px; color: hsl(${hue},60%,38%); }
  p { margin: 0 0 22px; color: #666; }
  button { font: inherit; font-size: 18px; padding: 10px 26px; border: 0; border-radius: 999px; background: hsl(${hue},70%,55%); color: #fff; cursor: pointer; }
  button:active { transform: scale(.97); }
  #count { display: block; margin-top: 16px; font-size: 15px; color: #444; }
</style></head>
<body><main>
  <h1>${safe}</h1>
  <p>A placeholder app served by the demo office.</p>
  <button id="btn" type="button">Click me</button>
  <span id="count">Clicked 0 times</span>
</main>
<script>
  let n = 0;
  document.getElementById('btn').addEventListener('click', () => {
    n++;
    document.getElementById('count').textContent = 'Clicked ' + n + (n === 1 ? ' time' : ' times');
  });
</script>
</body></html>`;
}

/** Programs the demo pretends to have, so a bogus preview command fails the way it would for real. */
const DEMO_PROGRAMS = ['npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'deno', 'vite', 'next', 'python', 'python3', 'py', 'php', 'ruby', 'go', 'cargo', 'dotnet'];

/**
 * No git, no npm: short fake delays through the real statuses, then a placeholder page on the floor's port.
 * Floors made in the demo have nothing to run until they get a command, and a command whose program isn't in
 * DEMO_PROGRAMS fails, so the viewer's unconfigured and error states can be tried out.
 */
const demoPreviews: PreviewBackend = {
  hasDefault: async (fullName) => !bareRepos.has(fullName),
  start(job, cb) {
    let stopped = false;
    let server: http.Server | null = null;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(() => !stopped && fn(), ms));
    const hue = [...job.fullName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    const sha = (job.pr ? repos.get(job.fullName)?.pulls.find((p) => p.number === job.pr)?.headRefName ?? String(job.pr) : job.fullName + job.defaultBranch)
      .split('')
      .reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381)
      .toString(16)
      .padStart(7, '0')
      .slice(0, 7);

    cb.status('preparing');
    later(700, () => {
      cb.commit(sha);
      cb.log([`HEAD is now at ${sha} (${job.pr ? `PR #${job.pr}` : job.defaultBranch})`]);
      if (!job.command && bareRepos.has(job.fullName)) {
        stopped = true;
        cb.failed('Nothing to run: this floor has no preview command and no package.json.', true);
        return;
      }
      cb.status('installing');
      cb.log(['$ npm ci', 'added 214 packages in 1s (demo)']);
    });
    later(1600, () => {
      cb.status('starting');
      cb.log([`$ ${job.command ?? 'npm run dev'}`.replaceAll('{port}', String(job.port))]);
      const program = job.command?.trim().split(/\s+/)[0] ?? 'npm';
      if (!DEMO_PROGRAMS.includes(program.toLowerCase())) {
        later(400, () => {
          cb.log([`'${program}' is not recognized as an internal or external command,`, 'operable program or batch file.']);
          stopped = true;
          cb.failed(`The app exited (code 1) before it listened on port ${job.port}.`);
        });
        return;
      }
      server = http.createServer((req, res) => {
        if (req.url !== '/' && !req.url?.startsWith('/?')) return void res.writeHead(404).end('Not found');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(placeholderPage(job.title, hue));
      });
      server.once('error', (err) => {
        if (stopped) return;
        stopped = true;
        cb.failed(`Could not listen on port ${job.port}: ${err.message}`);
      });
      server.listen(job.port, '127.0.0.1', () => {
        if (stopped) return void server?.close();
        later(500, () => {
          cb.log([`  ➜  Local:   http://localhost:${job.port}/`]);
          cb.status('running');
        });
      });
    });

    return {
      async stop() {
        stopped = true;
        timers.forEach(clearTimeout);
        const s = server;
        server = null;
        if (!s?.listening) return;
        s.closeAllConnections();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      },
    };
  },
};

// ---------- the demo CEO ----------

interface Profile {
  summary: string;
  qa: string;
  qaTitle: string;
  qaJob: string;
  devTitle: string;
  devSpecialty: string;
  devJob: string;
  hires: { title: string; specialty: string; job_description: string; reason: string }[];
}

const PROFILES: Record<string, Profile> = {
  'pixel-todo': {
    summary: 'Todo web app · React + Vite + TypeScript',
    qa: '- Add, complete, edit and delete todos; they survive a reload\n- Keyboard only: every action reachable, focus always visible\n- Phone width (375px): nothing overflows or gets cut off\n- No errors in the browser console',
    qaTitle: 'UI QA tester',
    qaJob: 'You test every PR the way a picky user would: click through the whole flow, try it on a phone-sized screen and with the keyboard only.',
    devTitle: 'React UI engineer',
    devSpecialty: 'frontend',
    devJob: 'You own the React components and styling. Keep components small, reuse the existing hooks, and check every change at desktop and phone widths.',
    hires: [
      {
        title: 'Accessibility engineer',
        specialty: 'a11y',
        job_description:
          'You make the app work for **everyone**:\n\n- Keyboard navigation and focus management\n- ARIA roles, checked with `axe`\n- Colour contrast (WCAG AA)\n\nTest with the keyboard only. The [WAI-ARIA practices](https://www.w3.org/WAI/ARIA/apg/) are your reference.',
        reason: 'Keyboard shortcuts and drag-and-drop are in the backlog, and both are *easy to get wrong* for keyboard and screen-reader users.',
      },
    ],
  },
  'weather-api': {
    summary: 'REST API · Node + Express',
    qa: '- Every endpoint: happy path, bad input (400), unknown city (404)\n- Response shapes match the OpenAPI document\n- Rate limiting returns 429 with Retry-After\n- Tests and lint pass',
    qaTitle: 'API QA tester',
    qaJob: 'You test the API from the outside: curl every endpoint, try bad input and edge cases, and compare responses with the OpenAPI document.',
    devTitle: 'Backend engineer',
    devSpecialty: 'backend',
    devJob: 'You own the routes and data layer. Validate input at the edge, return consistent error shapes, and add tests for every endpoint you touch.',
    hires: [
      {
        title: 'API reliability engineer',
        specialty: 'reliability',
        job_description: 'You own rate limiting, caching and error handling. Measure before you optimise and document every limit in the OpenAPI spec.',
        reason: 'Rate limiting is in the backlog and the forecast endpoint will call an upstream service that needs caching and timeouts.',
      },
    ],
  },
};

const GENERIC: Profile = {
  summary: 'Web project · early stage',
  qa: '- The app builds and starts\n- The changed feature works end to end in the browser\n- Phone width: nothing overflows\n- No console errors',
  qaTitle: 'QA tester',
  qaJob: 'You check every PR end to end in the browser, at desktop and phone widths.',
  devTitle: 'Full-stack engineer',
  devSpecialty: 'fullstack',
  devJob: 'You build features end to end, from the UI down to the data.',
  hires: [
    {
      title: 'Frontend engineer',
      specialty: 'frontend',
      job_description: 'You own the UI:\n\n1. Layout and components\n2. Styling, checked at **desktop and phone** widths',
      reason: 'The project needs someone who owns the UI from the start.',
    },
  ],
};

interface DemoFloor {
  floor: number;
  repo: string;
  brief: string | null;
  team: { id: string; name: string; role: string; specialty: string | null; status: string }[];
  backlog: unknown[];
  pullRequests: unknown[];
}

type DemoPull = ReturnType<typeof prStatusView>;

/** Which PR and floors "why is #N stuck (on floor F | on repo)?" asks about; null when it isn't that question. */
export function stuckTarget(text: string, floors: { floor: number; repo: string }[]): { number: number; floors: number[] } | { refused: string } | null {
  const m = text.match(/\bwhy\b.*?#(\d+)(?:.*?\bon\s+(?:floor\s+(\d+)|([\w./-]+)))?/i);
  if (!m) return null;
  const number = Number(m[1]);
  if (m[2]) {
    const floor = Number(m[2]);
    return floors.some((f) => f.floor === floor) ? { number, floors: [floor] } : { refused: `There is no floor ${floor}.` };
  }
  if (m[3]) {
    const name = m[3].toLowerCase();
    const f = floors.find((x) => x.repo.toLowerCase() === name || x.repo.split('/').pop()?.toLowerCase() === name);
    return f ? { number, floors: [f.floor] } : { refused: `No floor for "${m[3]}".` };
  }
  return { number, floors: floors.map((f) => f.floor) };
}

/** The demo CEO's answer to "why is PR #N stuck?", read from company_status like a real CEO would. */
export function stuckAnswer(floor: number, p: Partial<DemoPull> & { number: number; qa: string }): string {
  const status = p.qa.split(' ')[0];
  const dev = p.developer ?? 'A developer';
  const why: string[] = [];
  if (p.qa === 'not tested') why.push('QA has not tested it yet.');
  if (status === 'queued') why.push('It is waiting for a QA tester.');
  if (status === 'testing') why.push('QA is testing it now.');
  if (p.qaSummary) why.push(`QA said: ${p.qaSummary}${/[.!?…]$/.test(p.qaSummary) ? '' : '.'}`);
  if (p.failedChecks?.length) why.push(`Failed QA checks: ${p.failedChecks.join(', ')}.`);
  if (p.mergeable === 'conflicting') why.push('It conflicts with the default branch.');
  if (p.mergeable === 'unknown') why.push("GitHub hasn't said yet whether it merges cleanly.");
  if (p.checks === 'failing') why.push(`GitHub's checks are failing${p.ciFailedChecks?.length ? `: ${p.ciFailedChecks.join(', ')}` : ''}.`);
  if (p.checks === 'pending') why.push("GitHub's checks are still running.");
  if (p.checks === 'unavailable') why.push("The office can't read GitHub's checks.");
  if (p.merge) why.push(`Auto-merge: ${p.merge}.`);
  if (p.newCommitsSinceQa) why.push(`${p.headSha} was pushed after QA tested ${p.testedSha}.`);
  if (p.sessionFailures) why.push(`QA sessions failed ${p.sessionFailures} time${p.sessionFailures === 1 ? '' : 's'}.`);
  const rounds = `${p.qaRoundsLeft} QA round${p.qaRoundsLeft === 1 ? '' : 's'} left`;
  const next = p.newCommitsSinceQa
    ? `I'd rerun QA: say "rerun QA on #${p.number} on floor ${floor}".`
    : p.mergeable === 'conflicting'
      ? `${dev} should resolve the conflicts.`
      : status === 'needs-human' || p.qaRoundsLeft === 0
        ? 'It needs your call: fix it by hand, close it, or rerun QA.'
        : status === 'fixing'
          ? `${dev} is fixing it (${rounds}).`
          : p.qaRoundsLeft
            ? `${dev} gets it back to fix (${rounds}).`
            : '';
  const answer = [`PR #${p.number} on floor ${floor} is ${p.qa}.`, ...why, next].filter(Boolean).join(' ');
  return why.length || next ? answer : `${answer} Nothing is holding it up.`;
}

/** A scripted CEO that uses the real office tools, so proposals, profiles and issues behave exactly as in the real thing. */
function ceoSession(opts: SessionOptions, cb: SessionCallbacks): SessionHandle {
  const office = opts.office!;
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let done = false;
  const wait = (ms: number) => new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));
  const step = async (entries: LogEntry[], ms = 900 + Math.random() * 1500) => {
    if (stopped) throw new Error('Stopped by manager');
    cb.tool(entries.find((e) => e.tool)?.tool ?? null);
    cb.log(entries);
    await wait(ms);
  };
  const status = async () => {
    await step([{ kind: 'tool', tool: 'mcp__office__company_status', text: `⏺ ${describeOfficeTool('company_status', {})}` }]);
    const s = JSON.parse(await office.call('company_status', {})) as { floors: DemoFloor[]; pendingProposals: unknown[] };
    const people = s.floors.reduce((n, f) => n + f.team.length, 0);
    const issues = s.floors.reduce((n, f) => n + f.backlog.length, 0);
    cb.log([{ kind: 'result', text: `  ⎿ ${s.floors.length} floors · ${people} people · ${issues} open issues · ${s.pendingProposals.length} proposals pending` }]);
    return s;
  };
  const use = async (name: string, args: Record<string, unknown>) => {
    await step([{ kind: 'tool', tool: `mcp__office__${name}`, text: `⏺ ${describeOfficeTool(name, args)}` }]);
    const out = await office.call(name, args);
    cb.log([{ kind: out.startsWith('Refused') ? 'error' : 'result', text: `  ⎿ ${out.split('\n')[0].slice(0, 170)}` }]);
    return out;
  };
  const read = (file: string, lines: number) => step([{ kind: 'tool', tool: 'Read', text: `⏺ Read ${file}` }, { kind: 'result', text: `  ⎿ Read ${lines} lines` }]);
  const think = (text: string) => step([{ kind: 'thinking', text: '✻ Thinking…' }, { kind: 'text', text: `● ${text}` }], 1800);
  const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

  const planIssues = async (floor: number, mission: string, team: DemoFloor['team']) => {
    const first = await use('file_issue', {
      floor,
      title: 'Set up the project skeleton',
      body: `Scaffold the app so the rest of the milestone has something to build on.\n\nBrief: ${mission}\n\nAcceptance criteria:\n- The dev server starts\n- A placeholder home page renders\n- Lint, tests and build scripts exist`,
      specialty: 'frontend',
    });
    const n = Number(first.match(/#(\d+)/)?.[1] ?? 0);
    await use('file_issue', {
      floor,
      title: `Build the core: ${short(mission, 60)}`,
      body: `${n ? `Depends on #${n}\n\n` : ''}Implement the heart of the brief.\n\nAcceptance criteria:\n- The main flow works end to end\n- Covered by tests`,
      specialty: 'frontend',
    });
    await use('file_issue', {
      floor,
      title: 'Polish: phone layout and empty states',
      body: `${n ? `Depends on #${n}\n\n` : ''}Make every screen work at 375px and add friendly empty states.`,
      specialty: 'frontend',
    });
    if (!team.some((a) => a.specialty === 'frontend')) {
      await use('propose_hire', { floor, role: 'dev', ...GENERIC.hires[0], reason: 'All three issues are UI work and nobody on the floor owns the frontend yet.' });
    }
    return n;
  };

  const scripts = {
    async onboard(floor: number, fullName: string) {
      const s = await status();
      const f = s.floors.find((x) => x.floor === floor);
      if (!f) return 'That floor has gone, so there was nothing to onboard.';
      const p = PROFILES[fullName.split('/')[1] ?? ''] ?? GENERIC;
      await read(`${f.repo}/README.md`, 48);
      await step([{ kind: 'tool', tool: 'Glob', text: '⏺ Glob src/**/*' }, { kind: 'result', text: '  ⎿ Found 23 files' }]);
      await read('package.json', 36);
      await think(`${p.summary}. Let me shape the team around that.`);
      await use('set_floor_profile', { floor, summary: p.summary, qa_brief: p.qa });
      await use('request_research', { floor, topic: `What similar ${p.summary.split(' · ')[0].toLowerCase()} projects do well`, brief: 'Find three or four comparable projects. What do users praise and complain about? What should we copy or avoid?' });
      const qa = f.team.find((a) => a.role === 'qa');
      if (qa) {
        await step([{ kind: 'tool', tool: 'mcp__office__agent_detail', text: `⏺ ${describeOfficeTool('agent_detail', { agent_id: qa.id })}` }]);
        const d = JSON.parse(await office.call('agent_detail', { agent_id: qa.id })) as { title: string; jobDescription: string | null };
        cb.log([{ kind: 'result', text: `  ⎿ ${d.title} · job description ${d.jobDescription?.length ?? 0} chars` }]);
        await use('update_job', { agent_id: qa.id, title: p.qaTitle, job_description: p.qaJob });
      }
      const dev = f.team.find((a) => a.role === 'dev' && !a.specialty);
      if (dev) await use('update_job', { agent_id: dev.id, title: p.devTitle, specialty: p.devSpecialty, job_description: p.devJob });
      const proposed: string[] = [];
      for (const h of p.hires) if (!(await use('propose_hire', { floor, role: 'dev', ...h })).startsWith('Refused')) proposed.push(h.title);
      let planned = '';
      if (f.brief && f.backlog.length === 0) {
        const n = await planIssues(floor, f.brief, f.team);
        planned = ` I also turned your brief into three issues; #${n} sets up the skeleton and the other two wait for it.`;
      }
      return [
        `Floor ${floor}: ${p.summary}.`,
        `I wrote a QA brief for it${qa ? `, made ${qa.name} our ${p.qaTitle}` : ''}${dev ? ` and ${dev.name} our ${p.devTitle}` : ''}.`,
        proposed.length ? `I've proposed hiring: ${proposed.join(', ')}. The resume${proposed.length === 1 ? ' is' : 's are'} waiting on your phone.` : '',
        planned,
      ]
        .filter(Boolean)
        .join(' ');
    },
    async plan(floor: number, mission: string) {
      const s = await status();
      const f = s.floors.find((x) => x.floor === floor);
      if (!f) return 'That floor has gone, so there was nothing to plan.';
      await read(`${f.repo}/README.md`, 12);
      await think("Foundation first, so the parallel work doesn't collide.");
      const n = await planIssues(floor, mission, f.team);
      return `I turned the brief into three issues on floor ${floor}. #${n} sets up the skeleton; the other two say "Depends on #${n}", so nobody starts them early.`;
    },
    async review() {
      const s = await status();
      await think('Checking each floor for idle people and stuck work.');
      for (const f of s.floors) {
        const idle = f.team.filter((a) => a.role === 'dev' && !a.specialty && (a.status === 'idle' || a.status === 'done'));
        const devs = f.team.filter((a) => a.role === 'dev').length;
        if (devs >= 6 && idle.length >= 2 && f.backlog.length < devs) {
          await use('propose_let_go', { agent_id: idle[idle.length - 1].id, reason: `Floor ${f.floor} has ${devs} developers for ${f.backlog.length} open issues; ${idle.length} of them are idle.` });
          return `Floor ${f.floor} is overstaffed: ${devs} developers for ${f.backlog.length} open issues. I suggest letting ${idle[idle.length - 1].name} go; it's on your phone.`;
        }
      }
      // An issue nobody routed while the floor has a specialist: re-route it rather than file a duplicate.
      for (const f of s.floors) {
        const specialist = f.team.find((a) => a.role === 'dev' && a.specialty);
        const unrouted = (f.backlog as { number: number; specialty: string | null; inProgress?: boolean; readyForHuman?: boolean }[]).find(
          (i) => !i.specialty && !i.inProgress && !i.readyForHuman,
        );
        if (!specialist || !unrouted) continue;
        const out = await use('route_issue', { floor: f.floor, number: unrouted.number, specialty: specialist.specialty });
        if (!out.startsWith('Refused')) return `Floor ${f.floor}: #${unrouted.number} had no specialty, so I routed it to ${specialist.specialty}, ${specialist.name}'s lane.`;
      }
      const issues = s.floors.reduce((n, f) => n + f.backlog.length, 0);
      const prs = s.floors.reduce((n, f) => n + f.pullRequests.length, 0);
      return `All ${s.floors.length} floors look healthy: ${issues} open issues and ${prs} pull requests in flight. No changes needed.`;
    },
    async chat(text: string) {
      const s = await status();
      await think('Reading your message.');
      const connect = text.match(/\b(?:add|connect)\s+([\w.-]+\/[\w.-]+)\b/i);
      if (connect) {
        const assign = text.match(/\bauto[- ]assign\s+(on|off)\b/i);
        const merge = text.match(/\bauto[- ]merge\s+(on|off)\b/i);
        return use('connect_floor', {
          repo: connect[1], reason: text.trim().slice(0, 1000),
          ...(assign ? { auto_assign: assign[1].toLowerCase() === 'on' } : {}),
          ...(merge ? { auto_merge: merge[1].toLowerCase() === 'on' } : {}),
        });
      }
      const close = text.match(/\bclose\s+(?:issue\s*)?#(\d+)\s+on\s+floor\s+(\d+)\s+because\s+([^\n]+)/i);
      if (close) return use('close_issue', { floor: Number(close[2]), number: Number(close[1]), reason: close[3].trim() });
      const comment = text.match(/\bcomment\s+on\s+(?:issue\s*)?#(\d+)\s+on\s+floor\s+(\d+):\s*([\s\S]+)/i);
      if (comment) return use('comment_issue', { floor: Number(comment[2]), number: Number(comment[1]), body: comment[3].trim().slice(0, 6000) });
      const triage = text.match(/\btriage\s+(?:issue\s*)?#(\d+)\s+on\s+floor\s+(\d+)/i);
      if (triage) return use('route_issue', { floor: Number(triage[2]), number: Number(triage[1]), triaged: true });
      const merge = text.match(/\bmerge\s+(?:PR\s*)?#(\d+)\s+on\s+(?:floor\s+(\d+)|([\w./-]+))\s+(?:because|with|reason)\s+([^\n]+)/i);
      if (merge) {
        const floor = merge[2] ? Number(merge[2]) : s.floors.find((f) => f.repo.toLowerCase() === merge[3].toLowerCase() || f.repo.split('/').pop()?.toLowerCase() === merge[3].toLowerCase())?.floor;
        if (floor === undefined) return `Refused: No floor for "${merge[3]}".`;
        return use('merge_pr', { floor, number: Number(merge[1]), reason: merge[4].trim() });
      }
      const research = text.match(/\bresearch\s+(.+?)(?:\s+for\s+floor\s+(\d+))?\s*$/i);
      if (research) {
        return use('request_research', { topic: research[1].trim().slice(0, 120), brief: text.trim(), ...(research[2] && { floor: Number(research[2]) }) });
      }
      const humanIssue = text.match(/\bfile\s+(?:an?\s+)?issue\s+on\s+floor\s+(\d+)\s+titled\s+(.+?)\s+for\s+a\s+person:\s*([\s\S]+)/i);
      if (humanIssue) {
        return use('file_issue', { floor: Number(humanIssue[1]), title: humanIssue[2].trim(), body: humanIssue[3].trim(), ready_for_human: true });
      }
      const park = text.match(/\bpark\s+(?:PR\s*)?#(\d+)\s+on\s+(?:floor\s+(\d+)|([\w./-]+))\s+(?:because|with|reason)\s+([^;\n]+)/i);
      if (park) {
        const floor = park[2] ? Number(park[2]) : s.floors.find((f) => f.repo.toLowerCase() === park[3].toLowerCase() || f.repo.split('/').pop()?.toLowerCase() === park[3].toLowerCase())?.floor;
        if (floor === undefined) return `Refused: No floor for "${park[3]}".`;
        const deps = text.match(/;\s*depends on\s+((?:#\d+[\s,]*)+)/i);
        return use('park_pr', { floor, number: Number(park[1]), reason: park[4].trim(), ...(deps ? { depends_on: [...deps[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])) } : {}) });
      }
      const sendBack = text.match(/\bsend\s+(?:back\s+)?(?:PR\s*)?#(\d+)\s+(?:back\s+)?to\s+(?:dev|developer)\s+on\s+(?:floor\s+(\d+)|([\w./-]+))(?:\s+with\s+([^;\n]+))?/i);
      if (sendBack) {
        const floor = sendBack[2] ? Number(sendBack[2]) : s.floors.find((f) => f.repo.toLowerCase() === sendBack[3].toLowerCase() || f.repo.split('/').pop()?.toLowerCase() === sendBack[3].toLowerCase())?.floor;
        if (floor === undefined) return `Refused: No floor for "${sendBack[3]}".`;
        return use('send_back_to_dev', { floor, number: Number(sendBack[1]), ...(sendBack[4] ? { note: sendBack[4].trim().slice(0, 1500) } : {}) });
      }
      const rerun = text.match(/\b(?:rerun\s+qa|re-test|retest)\s+(?:on\s+)?(?:PR\s*)?#(\d+)\s+on\s+(?:floor\s+(\d+)|([\w./-]+))(?:\s+with\s+([^;\n]+))?/i);
      if (rerun) {
        const floor = rerun[2] ? Number(rerun[2]) : s.floors.find((f) => f.repo.toLowerCase() === rerun[3].toLowerCase() || f.repo.split('/').pop()?.toLowerCase() === rerun[3].toLowerCase())?.floor;
        if (floor === undefined) return `Refused: No floor for "${rerun[3]}".`;
        return use('rerun_qa', { floor, number: Number(rerun[1]), ...(rerun[4] ? { note: rerun[4].trim() } : {}) });
      }
      const stuck = stuckTarget(text, s.floors);
      if (stuck && 'refused' in stuck) return `Refused: ${stuck.refused}`;
      if (stuck) {
        for (const floor of stuck.floors) {
          const out = await use('company_status', { floor });
          if (out.startsWith('Refused')) return out;
          const pr = ((JSON.parse(out) as { floors: DemoFloor[] }).floors[0]?.pullRequests as DemoPull[]).find((p) => p.number === stuck.number);
          if (pr) return stuckAnswer(floor, pr);
        }
        return `I can't find an open PR #${stuck.number}${stuck.floors.length === 1 ? ` on floor ${stuck.floors[0]}` : ''}.`;
      }
      const start = text.match(/\bstart\s+#(\d+)\s+on\s+(?:floor\s+(\d+)|([\w./-]+))(?:\s+with\s+([^.;\n]+))?/i);
      if (start) {
        const floor = start[2] ? Number(start[2]) : s.floors.find((f) => f.repo.toLowerCase() === start[3].toLowerCase() || f.repo.split('/').pop()?.toLowerCase() === start[3].toLowerCase())?.floor;
        if (floor === undefined) return `Refused: No floor for "${start[3]}".`;
        return use('start_issue', { floor, number: Number(start[1]), ...(start[4] ? { agent: start[4].trim() } : {}) });
      }
      const people = s.floors.reduce((n, f) => n + f.team.length, 0);
      const issues = s.floors.reduce((n, f) => n + f.backlog.length, 0);
      const pending = s.pendingProposals.length;
      // Real CEOs answer in Markdown, so the demo one does too: every element the phone renders.
      const rows = s.floors.map((f) => `| ${f.floor} | \`${f.repo.split('/').pop()}\` | ${f.team.length} | ${f.backlog.length} | ${f.pullRequests.length} |`);
      return [
        `**Quick status:** ${s.floors.length} floor${s.floors.length === 1 ? '' : 's'}, ${people} people and ${issues} open issues.`,
        '',
        '- The team is *heads down* on the backlog',
        `- ${pending ? `**${pending}** proposal${pending === 1 ? ' is' : 's are'} waiting for you in Hires` : 'No hiring decisions waiting on you'}`,
        '  - QA re-tests every PR after a fix',
        '',
        '| Floor | Repo | People | Issues | PRs |',
        '| ---: | --- | ---: | ---: | ---: |',
        ...(rows.length ? rows : ['| – | no projects yet | 0 | 0 | 0 |']),
        '',
        'What I would do next:',
        '',
        '1. Merge anything that passed QA',
        '2. Run `npm run build` on each floor before the next milestone',
        '3. Hire only where the backlog is piling up',
        '',
        '```bash',
        'SWARM_HOME=/tmp/cubefarm-demo SWARM_PORT=5260 node --import tsx server/index.ts --demo',
        '```',
        '',
        `> I'm the demo CEO, so I can't act on "${short(text)}", but the real one would. See the [Claude Code docs](https://docs.claude.com/en/docs/claude-code/overview).`,
      ].join('\n');
    },
  };

  const prompt = opts.prompt;
  const where = prompt.match(/[Ff]loor (\d+) \(([^,)]+)/);
  const run = /just joined the company/.test(prompt)
    ? () => scripts.onboard(Number(where?.[1]), where?.[2] ?? '')
    : /has a brief for floor/.test(prompt)
      ? () => scripts.plan(Number(where?.[1]), prompt.match(/"""([\s\S]*?)"""/)?.[1]?.trim() ?? '')
      : /Periodic review/.test(prompt)
        ? () => scripts.review()
        : () => scripts.chat(prompt.split('\n').slice(1).join(' ').trim() || prompt);

  const finish = (ok: boolean, text: string, error?: string) => {
    if (done) return;
    done = true;
    cb.tool(null);
    cb.finished({ ok, text, costUsd: ok ? 0.4 + Math.random() : 0.05, turns: 6 + Math.floor(Math.random() * 10), errors: error ? [error] : [] });
  };

  timers.push(
    setTimeout(async () => {
      try {
        cb.log([{ kind: 'system', text: `✻ Claude Code (demo) · ${opts.model} · ${opts.effort} effort · CEO` }]);
        const reply = await run();
        cb.log([{ kind: 'text', text: `● ${reply}` }]);
        cb.turn?.(reply);
        finish(true, reply);
      } catch (err) {
        finish(false, '', stopped ? 'Stopped by manager' : (err as Error).message);
      }
    }, 500),
  );

  return {
    send(text) {
      timers.push(
        setTimeout(() => {
          if (stopped || done) return;
          const said = text.split('\n').slice(1).join(' ').trim() || text;
          cb.log([{ kind: 'text', text: `● Noted: "${short(said, 70)}"` }]);
          cb.turn?.(`Noted, I'll factor that in: "${short(said, 90)}"`);
        }, 1500),
      );
    },
    stop() {
      stopped = true;
      timers.forEach(clearTimeout);
      finish(false, '', 'Stopped by manager');
    },
  };
}

/** Local Telegram Bot API simulation. It never reads credentials or opens a network connection. */
export function createDemoTelegram(): import('./telegram.ts').TelegramTransport & { offline: boolean; ambiguous: boolean } {
  let nextId = 1;
  const sent = new Map<number, { text: string; buttons?: string[] }>();
  const fake = {
    identity: 'demo-telegram', offline: false, ambiguous: false,
    preview: () => ({ sent: structuredClone([...sent.values()].slice(-20)), offline: fake.offline }),
    async call(method: string, body: Record<string, unknown>) {
      const { TelegramFailure } = await import('./telegram.ts');
      if (fake.offline) throw new TelegramFailure('retry', 'Demo Telegram disconnected.', 1);
      if (fake.ambiguous) { fake.ambiguous = false; throw new TelegramFailure('uncertain', 'Demo Telegram send result unknown.'); }
      if (method === 'answerCallbackQuery') return true;
      const keyboard = body.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
      const message = { text: String(body.text ?? ''), buttons: keyboard?.inline_keyboard?.flat().map((b) => b.callback_data) };
      if (method === 'editMessageText') {
        const previous = sent.get(Number(body.message_id));
        if (previous) Object.assign(previous, message);
        return { message_id: body.message_id };
      }
      const id = nextId++;
      sent.set(id, message);
      if (sent.size > 200) sent.delete(sent.keys().next().value!);
      return { message_id: id };
    },
  };
  return fake;
}


// Demo Boxes never contact the provider, even when the office host has real credentials.
export function createDemoUpstash() {
  const boxes = new Set<string>();
  return {
    allocate: async (name: string) => {
      if (boxes.size >= 10) return null;
      boxes.add(name);
      return name;
    },
    find: async (name: string) => boxes.has(name) ? name : null,
    bootstrap: async () => {},
    present: async (id: string) => boxes.has(id),
    safeToDelete: async () => true,
    remove: async (id: string) => { boxes.delete(id); },
  };
}
