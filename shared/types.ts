// Types shared between the swarm server and the 3D client.

export type AgentStatus =
  | 'idle' // at desk, nothing assigned
  | 'preparing' // setting up the git worktree
  | 'working' // Claude Code session running
  | 'done' // finished, PR opened (or finished without one)
  | 'error' // session failed
  | 'stopped'; // manager stopped it

export type LogKind = 'text' | 'tool' | 'result' | 'system' | 'error' | 'manager' | 'done' | 'thinking';

export interface LogLine {
  id: number;
  t: number; // epoch ms
  kind: LogKind;
  text: string;
  tool?: string; // tool name for kind === 'tool'
}

export interface IssueDependency {
  number: number;
  state: 'OPEN' | 'CLOSED';
  repo?: string; // present only for a blocker in another repository
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  createdAt: string;
  subIssues?: { total: number; completed: number } | null; // null: unread; last successful native summary otherwise
  ownerCommentAt?: string; // newest unmarked (human) comment by the repository owner
  bodyBlockers?: IssueDependency[]; // resolved dependency URLs; unread URLs are held open
  stalled?: string;
  nativeBlockers?: IssueDependency[] | null; // null: unread, undefined: unsupported; otherwise last successful sync
}

export interface PullInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  reviewDecision: string | null;
  closesIssues: number[];
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  checks: 'pending' | 'passing' | 'failing' | 'none' | 'unavailable';
  headSha: string;
  mergeState: string; // GitHub's mergeStateStatus: CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | DRAFT | UNKNOWN …
  failedChecks: { name: string; url: string | null }[];
  pendingChecks: string[];
}

export interface PullRefresh {
  pulls: PullInfo[];
  checksError?: string; // diagnostic details from optional check enrichment
}

export interface RepoRefresh {
  status: 'success' | 'partial' | 'failed';
  issues: { at: number | null; error?: string };
  pulls: { at: number | null; error?: string };
  checksError?: string;
}

/** An explicit issue start survives until it is cancelled or handed to a PR. */
export interface RequestedStart {
  issueNumber: number;
  preferredAgentId: string;
  note?: string;
  restartPending: boolean;
}

/** A closed placeholder PR whose branch can be reused when its issue becomes ready. */
export interface ParkedBranch {
  issueNumber: number;
  prNumber: number;
  branch: string;
}

export interface NoWorkEnding {
  issueNumber: number;
  count: number;
  body: string;
  labels: string[];
  ownerCommentAt?: string;
  retryAfterSync?: number; // no automatic retry until an issue refresh starts after this ending
}

export interface RepoView {
  id: string; // "owner/name"
  fullName: string;
  description: string;
  url: string;
  defaultBranch: string;
  floor: number; // 1-based floor number in the building
  color: string; // accent color for the floor
  autoAssign: boolean;
  requestedStarts: RequestedStart[];
  parkedBranches: ParkedBranch[];
  noWorkEndings: NoWorkEnding[];
  autoMerge: boolean; // PRs merge themselves once QA passes and GitHub's checks are green
  folderSync: string | null; // how the floor's main checkout stands against GitHub: "in sync", "updated to abc1234", "2 behind: local changes" …
  browserTesting: boolean;
  links: string[]; // ids of related repos this floor's agents can read for context
  mission: string; // the manager's brief: what this floor is building
  summary: string; // the CEO's one-line read of the project, e.g. "3D browser game · Three.js + Vite"
  qaBrief: string; // how QA should test this kind of project (written by the CEO, editable)
  localPath: string | null; // the manager's own project folder, when the floor lives in one
  checkoutPath: string; // where the floor's main checkout is on disk (localPath, or a clone the office manages)
  box: string; // the box its developers and QA testers work on unless they have their own ('' = the office's machine)
  cloneStatus: 'pending' | 'cloning' | 'ready' | 'error';
  cloneError?: string;
  issues: IssueInfo[]; // open issues
  pulls: PullInfo[]; // open + recently merged PRs
  lastSync: number | null;
  syncError?: string;
  refresh?: RepoRefresh;
  syncing?: boolean;
  previewConfig: PreviewConfig;
  preview: PreviewView;
}

/**
 * How a floor's app is run for the preview monitor. {port} and {tmp} are replaced in the command and env values;
 * PORT={port} is always set. command null: npm run dev, else start, else preview from package.json.
 */
export interface PreviewConfig {
  command: string | null;
  env: Record<string, string>;
}

export type PreviewStatus =
  | 'unconfigured' // no command and no package.json
  | 'stopped'
  | 'preparing' // checking out the ref in the preview worktree
  | 'installing' // npm ci / npm install
  | 'starting' // command started, waiting for the port
  | 'running'
  | 'error';

/** The floor's running app, served from its own worktree on a port reserved for the floor. */
export interface PreviewView {
  status: PreviewStatus;
  port: number;
  url: string | null; // set while running
  ref: string | null; // the default branch's name, or "PR #n"
  pr: number | null;
  commit: string | null; // short sha
  startedAt: number | null;
  error: string | null;
  logTail: string[]; // the last 40 lines of install / app output
}

/** A folder in the manager's projects folder, as offered when adding a floor. */
export interface ProjectFolderView {
  name: string;
  path: string;
  git: boolean;
  github: string | null; // owner/name of its GitHub origin
  floor: number | null; // already a floor in the office
}

/**
 * dev and qa are the two pipeline lanes on every floor; the one CEO works in the lobby and runs the company.
 * Researchers do web research and file it as docs: one always works in the lobby for the company (RESEARCHER_ID), and
 * floors can have their own at developer desks, taking swarm:research issues.
 */
export type AgentRole = 'dev' | 'qa' | 'ceo' | 'researcher';

/** Fixed id of the CEO agent. */
export const CEO_ID = 'ceo';

/** Fixed id of the lobby researcher, who researches for the whole company. */
export const RESEARCHER_ID = 'researcher';

/** How the cartoon character is drawn. Picked from the agent's name when hired; the manager can change it. */
export type AgentLook = 'feminine' | 'masculine';

/** What an agent is currently doing: implementing an issue, testing a PR, or fixing a PR after QA. */
export type AgentTask = 'issue' | 'qa' | 'fix';

/**
 * How agents run. terminal: each agent is the real coding-agent CLI in its own terminal, shown live in the office.
 * sdk: Claude Code through the Agent SDK, its stream turned into log lines.
 */
export type AgentRuntime = 'terminal' | 'sdk';

/** The coding-agent CLI an agent runs in its terminal. The CEO is always Claude Code. */
export type AgentCli = 'claude' | 'codex' | 'opencode';

/** A coding-agent CLI the office knows how to run, and whether it's installed on this machine. */
export interface CliView {
  id: AgentCli;
  label: string;
  installed: boolean;
  version: string | null;
  /** Hooks report every tool call and enforce the guard rails; the others report only when a turn ends. */
  integrated: boolean;
}

export type BoxStatus = 'connecting' | 'online' | 'offline';

/** Another machine agents' desks and CLIs can run on, reached over ssh. */
export interface BoxView {
  id: string;
  name: string;
  destination: string; // what ssh is given: user@host, an ~/.ssh/config alias, a Tailscale name
  status: BoxStatus;
  error: string | null;
  platform: string | null;
  version: string | null; // cubefarm on the box
  git: string | null;
  ghReady: boolean;
  hookError: string | null; // why its CLIs can't reach the office's hook URL (null: they can, or not known yet)
  clis: CliView[];
  running: number; // CLIs running there now
  sync: { text: string; failed: boolean } | null; // moving to the office's version (#94), or why it couldn't
}

/** Messages on an agent's terminal socket (/ws/term?agent=<id>), server to browser. */
export type TermServerMessage =
  | { t: 'snapshot'; data: string; cols: number; rows: number; live: boolean } // the screen and scrollback so far
  | { t: 'data'; data: string }
  | { t: 'size'; cols: number; rows: number } // another viewer resized the terminal
  | { t: 'live'; live: boolean }; // a CLI is (or is no longer) running in it

/** Browser to server: keystrokes go to the running CLI; the size is the viewer's fitted terminal. */
export type TermClientMessage = { t: 'input'; data: string } | { t: 'resize'; cols: number; rows: number };

export interface AgentView {
  id: string;
  name: string;
  repoId: string;
  role: AgentRole;
  title: string; // job title, e.g. "Three.js graphics engineer" ('' = plain developer / QA tester)
  specialty: string; // routes issues labelled swarm:<specialty> to this agent first ('' = generalist)
  brief: string; // job description for this project, added to the agent's instructions
  hiredBy: 'manager' | 'ceo';
  look: AgentLook;
  task: AgentTask | null;
  desk: number; // desk slot on the floor (dev desks and QA lab stations are numbered separately)
  color: string; // shirt color
  hair: string; // hair color
  skin: string;
  model: string; // '' = use the swarm default model, or a model id / alias
  effort: EffortLevel | ''; // '' = use the swarm default effort
  cli: AgentCli | ''; // the CLI they run in the terminal runtime ('' = the office default)
  terminal: boolean; // they have a terminal to watch (the terminal runtime); otherwise their log lines are the screen
  status: AgentStatus;
  issueNumber: number | null; // devs: the issue being worked on
  issueTitle: string | null; // devs: issue title; QA: title of the PR under test
  branch: string | null;
  issueStartHead?: string | null; // baseline of this issue session; unknown after legacy recovery
  prNumber: number | null; // devs: the PR they opened; QA: the PR under test
  prUrl: string | null;
  currentTool: string | null;
  startedAt: number | null;
  endedAt: number | null;
  costUsd: number;
  turns: number;
  browserUrl: string | null;
  hasScreenshot: boolean;
  screenshotAt: number | null;
  lastError: string | null;
  box: string | null; // their own box, overriding the floor's (null = the floor's)
  deskBox: string; // where their current task's desk and CLI are ('' = the office's machine)
  boot: AgentBoot | null; // a new CLI the office hasn't heard from yet (null: it has, or none is starting)
  log: LogLine[]; // tail of the terminal log (full buffer on snapshot)
}

/** A new Claude CLI with no hook after a minute: 'waiting' to start on the task, or 'no-hooks' (working, but its hooks don't reach the office). */
export type AgentBoot = 'waiting' | 'no-hooks';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type QaStatus =
  | 'queued' // waiting for a free QA tester
  | 'testing' // a QA tester is on it
  | 'passed' // ready to merge
  | 'failed' // failed; waiting for the dev who wrote it to be free
  | 'fixing' // the dev is fixing what QA found
  | 'needs-human'; // failed too many rounds, or nobody can fix it automatically

export interface QaCheck {
  name: string;
  result: 'pass' | 'fail' | 'skip';
  details: string;
}

/** Failed preparations for one PR task and head; kept across office restarts. */
export interface DeskPreparation {
  headSha: string | null;
  failures: number;
  holds: number;
  holdUntil: number;
}

export interface QaView {
  repoId: string;
  prNumber: number;
  status: QaStatus;
  round: number; // 1-based QA round
  preparation?: Partial<Record<'qa' | 'fix', DeskPreparation>>;
  rerunNote?: { round: number; text: string }; // manager's instructions for one QA round
  devAgentId: string | null; // who wrote it (null for PRs opened outside the swarm)
  qaAgentId: string | null; // who is testing / last tested it
  summary: string | null; // latest QA summary
  checks: QaCheck[];
  commentUrl: string | null; // the PR comment with the latest QA report
  mergeNote: string | null; // where auto-merge stands once QA passed, e.g. "waiting for checks: Vercel"
  updatedAt: number;
}

export interface SwarmSettings {
  sessionLimit: number; // most Claude Code sessions running at once; 0 = no limit
  defaultModel: string;
  defaultEffort: EffortLevel;
  runtime: AgentRuntime;
  defaultCli: AgentCli; // what developers and QA testers run in their terminals unless they have their own
  hiring: 'approve' | 'auto'; // CEO proposals wait for the manager, or go through while the floor is under teamCap
  teamCap: number; // most agents per floor the CEO may reach without the manager's approval (auto mode)
  ceoHeartbeatMin: number; // minutes between the CEO's periodic reviews; 0 = off
  managerName: string; // what the office calls you
  companyName: string;
  projectsDir: string; // where your project folders live; new projects are created here
  setupDone: boolean; // the first-run setup wizard has been completed or skipped
  tutorialStep: number; // index of the current tutorial step; -1 when finished or skipped
  autoUpdate?: boolean; // update the office itself once it's quiet (absent on servers without self-update)
  pacingSessions: number; // after Claude warns about usage, new issues start only while fewer sessions than this run
}

/** Claude's subscription usage: normal, pacing new work after a usage warning, or paused at the limit until `until`. */
export interface UsageView {
  state: 'normal' | 'pacing' | 'paused';
  until: number | null;
}

/**
 * Where the office's own update stands. none: up to date · available: new commits on GitHub · waiting / draining:
 * starting nothing new while running sessions finish · updating: handed to the launcher · failed: see detail.
 */
export type OfficeUpdateState = 'none' | 'available' | 'waiting' | 'draining' | 'updating' | 'failed';

export interface OfficeLifecycleView {
  state: 'open' | 'closing' | 'closed';
  running: number; // includes preparation and completion bookkeeping across all floors
}

export interface OfficeUpdateView {
  state: OfficeUpdateState;
  behind: number; // commits the office's folder is behind GitHub
  launcher: boolean; // started by npm run dev / npm start, which can install the update and restart the office
  drainingSince: number | null;
  running: number; // sessions still running
  detail: string | null;
}

/** A CEO proposal to hire someone or let someone go. The manager (the board) decides. */
export interface HireRequestView {
  id: string;
  kind: 'hire' | 'let-go';
  repoId: string;
  role: 'dev' | 'qa' | 'researcher';
  agentId: string | null; // let-go: who; hire: who was hired once approved
  name: string; // the candidate's name (let-go: the agent's name)
  title: string;
  specialty: string;
  brief: string;
  reason: string;
  model: string;
  effort: EffortLevel | '';
  look: AgentLook;
  color: string;
  hair: string;
  skin: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string; // the manager's reason when rejecting
  createdAt: number;
  decidedAt: number | null;
  decidedBy: 'manager' | 'auto' | null;
}

/** One message in the phone thread between the manager and the CEO. */
export interface PhoneMessage {
  id: number;
  from: 'ceo' | 'manager' | 'office'; // office = notes from the building itself (decisions, errors)
  text: string;
  at: number;
  requestId?: string; // a hire / let-go proposal this message is about
  origin?: 'web' | 'telegram';
  telegram?: { updateId: number; chatId: number; messageId: number };
}

/** Non-secret Telegram connection state; delivery never changes phone read state. */
export interface TelegramView {
  configured: boolean;
  state: 'unconfigured' | 'unpaired' | 'connected' | 'reconnecting' | 'error';
  detail: string;
  paired: { userId: number; chatId: number } | null;
  pairing: { code: string; expiresAt: number; candidate: { userId: number; chatId: number } | null } | null;
  pending: number;
  uncertain: boolean;
  demo?: { sent: { text: string; buttons?: string[] }[]; offline: boolean };
}

export type CeoJobKind = 'onboard' | 'plan' | 'review' | 'chat';

export interface CeoInfo {
  queue: { kind: CeoJobKind; label: string }[]; // jobs waiting for the CEO
  job: { kind: CeoJobKind; label: string } | null; // what the CEO is doing now
  lastReviewAt: number | null;
  nextReviewAt: number | null; // null when the heartbeat is off
}

/** The lobby researcher's work: briefs from the CEO or the manager, and the docs filed lately. */
export interface ResearchInfo {
  queue: { label: string }[];
  job: { label: string } | null;
  done: ResearchDoc[]; // newest last
}

export interface ResearchDoc {
  topic: string;
  where: string; // a pull request URL, or the doc's path in the company research folder
  at: number;
}

export interface WorldSnapshot {
  user: string | null; // gh login
  ghReady: boolean;
  ghError?: string;
  demo: boolean;
  workspaceRoot: string;
  settings: SwarmSettings;
  repos: RepoView[];
  agents: AgentView[];
  qa: QaView[];
  requests: HireRequestView[];
  ceo: CeoInfo;
  research: ResearchInfo;
  messages: PhoneMessage[];
  phoneReadAt: number; // CEO messages newer than this are unread
  telegram?: TelegramView;
  officeCommit?: string | null; // short sha the server started on (absent on servers without self-update)
  officeLifecycle: OfficeLifecycleView;
  officeUpdate?: OfficeUpdateView;
  usage: UsageView;
  clis: CliView[];
  boxes: BoxView[];
}

export type ServerEvent =
  | { type: 'snapshot'; data: WorldSnapshot }
  | { type: 'repo'; repo: RepoView }
  | { type: 'repoRemoved'; repoId: string }
  | { type: 'agent'; agent: Omit<AgentView, 'log'> }
  | { type: 'agentRemoved'; agentId: string }
  | { type: 'log'; agentId: string; lines: LogLine[] }
  | { type: 'screen'; agentId: string; url: string | null; at: number }
  | { type: 'qa'; qa: QaView }
  | { type: 'qaRemoved'; repoId: string; prNumber: number }
  | { type: 'settings'; settings: SwarmSettings }
  | { type: 'request'; request: HireRequestView }
  | { type: 'ceo'; ceo: CeoInfo }
  | { type: 'research'; research: ResearchInfo }
  | { type: 'message'; message: PhoneMessage }
  | { type: 'phoneRead'; at: number }
  | { type: 'telegram'; telegram: TelegramView }
  | { type: 'officeLifecycle'; officeLifecycle: OfficeLifecycleView }
  | { type: 'officeUpdate'; officeUpdate: OfficeUpdateView }
  | { type: 'usage'; usage: UsageView }
  | { type: 'clis'; clis: CliView[] }
  | { type: 'box'; box: BoxView }
  | { type: 'boxRemoved'; boxId: string }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; text: string };

export interface GhRepoSummary {
  nameWithOwner: string;
  description: string;
  visibility: string;
  updatedAt: string;
}
