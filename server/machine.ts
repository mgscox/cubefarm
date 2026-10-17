import type { HeldPty } from './ptyProtocol.ts';
import type { Pty } from './ptyClient.ts';
import type { SessionCallbacks, SessionHandle, SessionOptions } from './agentRunner.ts';
import type { DeskBase } from './workspace.ts';
import type { ReconnectedCli } from './cliRunner.ts';
import type { ClaudeTurn } from './clis.ts';
import type { BoxInfo, BoxUpdateResult, PersistedBox } from './fleet.ts';
import type { AgentTerminal } from './terminal.ts';
import type { AgentCli, AgentRole, BoxStatus, CliView, EffortLevel } from '../shared/types.ts';

// Where an agent works: its desk (a worktree), its sessions and the CLIs it runs: the office's own machine, or a box
// (another machine, reached over ssh: see docs/fleet-design.md). Paths a machine hands out are its own: the office
// passes them back to it, and into the agent's prompts, as they are (a box may run another OS).

/** The machine-side half of an agent's work: its desk and its sessions. */
export interface Machine {
  /** A floor's checkout as this machine sees it (linked repos are read-only references in the agent's session). */
  mainDir(fullName: string): string;
  deskDir(fullName: string, agentSlug: string): string;
  prepareDesk(fullName: string, base: DeskBase, agentSlug: string, branch: string, note?: (text: string) => void): Promise<string>;
  removeDesk(fullName: string, agentSlug: string): Promise<void>;
  /** Stop processes an agent left running (dev servers on its port, anything started in its desk). */
  releaseDesk(fullName: string, agentSlug: string, port: number): Promise<void>;
  /** Current local HEAD, captured before an issue session starts. */
  deskHead(fullName: string, agentSlug: string): Promise<string>;
  /** Local commits ahead of the desk base, including unpushed work. */
  deskAhead(fullName: string, agentSlug: string, base: string): Promise<number>;
  /** An agent session: the real CLI in the agent's terminal when opts.terminal is set, else an Agent SDK session. */
  startSession(opts: SessionOptions, cb: SessionCallbacks): SessionHandle;
  /** Terminals can run here (the native pseudo-terminal module loaded). */
  terminals: boolean;
  /** The coding-agent CLIs installed here. */
  detectClis(): Promise<CliView[]>;
}

// ---------- launching a CLI ----------

/** What the office wants started: everything a machine needs to write a CLI's session files and command line. */
export interface CliPlan {
  cli: AgentCli;
  /** Names the session's hook and MCP routes, and its folder. */
  token: string;
  /** The id a new Claude Code session gets. */
  sessionId: string;
  resumeId?: string;
  cwd: string;
  /** The task, with the structured-report instructions when one is asked for. */
  prompt: string;
  systemAppend: string;
  model: string;
  effort: EffortLevel | '';
  /** Shown in Claude Code's prompt box and the terminal title. */
  name: string;
  role: AgentRole;
  additionalDirectories: string[];
  browserTesting: boolean;
  /** The office's address: hooks go here when there's no terminal keeper, and the CEO's office tools are served here. */
  officeUrl: string;
  /** The session gets the office's MCP tools (the CEO). */
  officeTools: boolean;
}

/** The plan for a new CLI session (pure: no files, no processes). */
export function planCli(opts: SessionOptions, ids: { cli: AgentCli; token: string; sessionId: string; officeUrl: string }): CliPlan {
  let prompt = opts.prompt;
  if (opts.outputSchema) {
    prompt += `\n\nWhen you are done, end your final message with your report as one JSON object in a \`\`\`json block, matching this JSON schema:\n${JSON.stringify(opts.outputSchema)}`;
  }
  return {
    ...ids,
    resumeId: opts.resumeSessionId,
    cwd: opts.cwd,
    prompt,
    systemAppend: opts.systemAppend,
    model: opts.model,
    effort: opts.effort,
    name: opts.label ?? 'cubefarm',
    role: opts.role,
    additionalDirectories: opts.additionalDirectories,
    browserTesting: opts.browserTesting,
    officeTools: !!opts.office,
  };
}

/** A CLI's session files are written and its command line is built: it's ready to start. */
export interface PreparedCli {
  /** The session's folder on its machine. */
  dir: string;
  /** The prompt as the CLI is given it (a long one is a pointer to its file). */
  prompt: string;
  /** Where its hooks post on its machine, when not the office's own address (a box's): said when none arrive. */
  hookUrl?: string;
  /** Start it in a new pseudo-terminal. Throws, with a message for the manager, if it can't. */
  start(size: { cols: number; rows: number }, meta: unknown): Pty;
}

type Shot = { data: Buffer; mime: string };

/** Where a CLI runs: writes its files, starts it, and reads back what it leaves on disk. A box answers asynchronously. */
export interface CliHost {
  /** Throws (or rejects), with a message for the manager, when the CLI can't be prepared (not installed, files not written). */
  prepare(plan: CliPlan): PreparedCli | Promise<PreparedCli>;
  /** A file exists on this machine (a Claude Code transcript a hook names). */
  hasFile(file: string): boolean;
  /** Where a Claude Code conversation stands by its transcript here (see clis.readClaudeTurn); null when it isn't there. */
  claudeTurn(cwd: string, sessionId: string): ClaudeTurn | null | Promise<ClaudeTurn | null>;
  /** Browser screenshots new in a session's browser folder (dir: the session's), each then added to seen (Codex and OpenCode don't report tool results). */
  newShots(dir: string, seen: Set<string>, now: number): (Shot & { name: string })[] | Promise<(Shot & { name: string })[]>;
  /** The screenshot a Playwright result names (relative to the CLI's folder). */
  savedShot(cwd: string, text: string): Shot | null | Promise<Shot | null>;
  /** Archive or unarchive a Codex thread (see clis.codexThread). */
  codexThread(action: 'archive' | 'unarchive', id: string, after?: Promise<unknown>): Promise<void>;
  /** A session is over: its folder goes. */
  removeDir(dir: string): void;
  /** Connect to the terminal keeper: the terminals it held through an office restart. */
  reconnect(onHook: (token: string, body: unknown) => unknown): Promise<HeldPty[]>;
  adopt(held: HeldPty): Pty;
  discard(held: HeldPty): void;
  hooksReady(): void;
  /** The office is stopping: its terminals carry on in the keeper. */
  leave(): void;
  /** What a desk clean-up must leave alone here: the keeper, and the session files' folders. */
  protect(): { pids: number[]; markers: string[] };
}

// ---------- boxes ----------

/** The office's link to one of its boxes: the box as a Machine, and how it stands. */
export interface BoxConnection {
  machine: Machine;
  /** reported: info and clis are from the link that's up now. refused: it runs another protocol version. */
  state(): { status: BoxStatus; error: string | null; info: BoxInfo | null; clis: CliView[]; running: number; reported: boolean; refused: boolean };
  /**
   * The CLIs the box kept running while the office was away, back in their agents' terminals: resolves the first
   * time the box connects (which may be long after the office starts). Call hooksReady() once they're followed again.
   */
  reconnected: Promise<ReconnectedCli[]>;
  hooksReady(): void;
  /** Ask again: an online box reports what it has set up (the manager fixed something there); one that isn't is dialled now. */
  check(): Promise<void>;
  /** Bring the box's cubefarm to the office's commit or release (`cubefarm box --update`, over ssh of its own). */
  update(target: string): Promise<BoxUpdateResult>;
  /** Restart the box's host on the cubefarm now on its disk (its terminals stop); settles once it's back and has reported. */
  restart(): Promise<void>;
  /** Close the link: the box's CLIs carry on there (they were stopped first when the office quits for good). */
  close(): void;
}

/** What the office gives a box link: the box, and who to tell when it changes. */
export interface BoxOptions {
  box: PersistedBox;
  officeId: string;
  changed(): void;
  terminalFor(agentId: string): AgentTerminal | null;
}
