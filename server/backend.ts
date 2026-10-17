import * as github from './github.ts';
import * as workspace from './workspace.ts';
import { startSession } from './agentRunner.ts';
import { hooksReady, officeProcesses, reconnectClis, releaseClis, startCliSession, terminalsAvailable, type ReconnectedCli } from './cliRunner.ts';
import { detectClis } from './clis.ts';
import { realPreviews, type PreviewBackend } from './previewRunner.ts';
import { realOffice, type OfficeHost } from './officeUpdate.ts';
import { connectBox } from './boxLink.ts';
import type { BoxConnection, BoxOptions, Machine } from './machine.ts';
import type { AgentTerminal } from './terminal.ts';
import type { GhRepoSummary, IssueInfo, PullRefresh } from '../shared/types.ts';

/** Everything the swarm needs from the outside world, the office's own machine included. The demo backend fakes all of it. */
export interface Backend extends Machine {
  demo: boolean;
  user(): Promise<string>;
  listMyRepos(owner?: string): Promise<GhRepoSummary[]>;
  repoMeta(fullName: string): Promise<github.RepoMeta>;
  listIssues(fullName: string): Promise<IssueInfo[]>;
  listPulls(fullName: string): Promise<PullRefresh>;
  createIssue(fullName: string, title: string, body: string, labels?: string[]): Promise<number>;
  /** OPEN or CLOSED; null when there is no such issue. */
  issueState(fullName: string, number: number): Promise<'OPEN' | 'CLOSED' | null>;
  editIssue(fullName: string, number: number, edit: { body?: string; addLabels?: string[]; removeLabels?: string[] }): Promise<void>;
  mergePull(fullName: string, number: number, method: 'squash' | 'merge' | 'rebase', headSha?: string): Promise<void>;
  updateBranch(fullName: string, number: number): Promise<void>;
  /** Marks a draft PR ready for review. */
  markPullReady(fullName: string, number: number): Promise<void>;
  closePull(fullName: string, number: number): Promise<void>;
  prForBranch(fullName: string, branch: string): Promise<{ number: number; url: string } | null>;
  /** Commits a branch has on GitHub ahead of the base branch (throws when the branch was never pushed). */
  branchAhead(fullName: string, base: string, branch: string): Promise<number>;
  prDetails(fullName: string, number: number): Promise<github.PrDetails>;
  issueDetails(fullName: string, number: number): Promise<{ title: string; body: string }>;
  commentPull(fullName: string, number: number, body: string): Promise<string>;
  uploadEvidence(fullName: string, filePath: string, data: Buffer): Promise<string>;
  ensureClone(fullName: string): Promise<void>;
  /** Fast-forward the floor's main checkout to GitHub when that is safe; returns how it stands. */
  syncMain(fullName: string, defaultBranch: string, opts: { touch: boolean }): Promise<workspace.MainSync | null>;
  /** Point a floor at the user's own project folder (null: a clone the office manages). */
  setLocalPath(fullName: string, dir: string | null): void;
  scanProjects(root: string): Promise<workspace.LocalFolder[]>;
  inspectFolder(dir: string): Promise<workspace.LocalFolder>;
  publishFolder(dir: string, opts: { name: string; visibility: 'private' | 'public'; owner?: string; description?: string }): Promise<string>;
  createProject(root: string, name: string, opts: { visibility: 'private' | 'public'; owner?: string; description?: string }): Promise<{ fullName: string; path: string }>;
  /** The company's research folder: created and put under git (no remote) on first use. */
  prepareResearchFolder(dir: string): Promise<void>;
  /** The office started: the CLIs its terminal keeper kept running through a restart, back in their agents' terminals. */
  reconnectClis(terminalFor: (agentId: string) => AgentTerminal | null): Promise<ReconnectedCli[]>;
  /** The office follows those CLIs' sessions again: hooks that waited for it can come in. */
  hooksReady(): void;
  /** The office is stopping: its CLIs carry on in the keeper through a restart (true), or stop with it. */
  releaseClis(restart: boolean): Promise<void>;
  /** Connect to a box: another machine agents' desks and CLIs run on, over ssh (see docs/fleet-design.md). */
  connectBox(opts: BoxOptions): BoxConnection;
  /** Run a floor's app for the preview monitor (its own worktree, its own port). */
  previews: PreviewBackend;
  /** The running office's own folder and its launcher, for the office's self-update. */
  office: OfficeHost;
}

export const realBackend: Backend = {
  demo: false,
  user: github.currentUser,
  listMyRepos: github.listMyRepos,
  repoMeta: github.repoMeta,
  listIssues: github.listIssues,
  listPulls: github.listPulls,
  createIssue: github.createIssue,
  issueState: github.issueState,
  editIssue: github.editIssue,
  mergePull: github.mergePull,
  updateBranch: github.updateBranch,
  markPullReady: github.markPullReady,
  closePull: github.closePull,
  prForBranch: github.prForBranch,
  branchAhead: github.branchAhead,
  deskAhead: workspace.deskAhead,
  deskHead: workspace.deskHead,
  prDetails: github.prDetails,
  issueDetails: github.issueDetails,
  commentPull: github.commentPull,
  uploadEvidence: github.uploadEvidence,
  ensureClone: workspace.ensureClone,
  syncMain: workspace.syncMain,
  setLocalPath: workspace.setLocalPath,
  scanProjects: workspace.scanProjects,
  inspectFolder: workspace.inspectFolder,
  publishFolder: workspace.publishFolder,
  createProject: workspace.createProject,
  mainDir: workspace.mainDir,
  deskDir: workspace.deskDir,
  prepareDesk: workspace.prepareDesk,
  removeDesk: workspace.removeDesk,
  prepareResearchFolder: workspace.ensureLocalRepo,
  releaseDesk: (fullName, agentSlug, port) => workspace.releaseDesk(fullName, agentSlug, port, officeProcesses()),
  startSession: (opts, cb) => (opts.terminal ? startCliSession(opts, cb) : startSession(opts, cb)),
  terminals: terminalsAvailable,
  reconnectClis: (terminalFor) => (terminalsAvailable ? reconnectClis(terminalFor) : Promise.resolve([])),
  hooksReady,
  releaseClis,
  detectClis,
  connectBox,
  previews: realPreviews,
  office: realOffice,
};
