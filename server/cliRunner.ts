import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { claudeConversation, cliExit, cliLabel, codexTurnThread, hookReviewKey, interruptions, isCli, LOST_CONVERSATION, resumableSession, trustKey } from './clis.ts';
import { terminalsAvailable, type Pty } from './ptyClient.ts';
import { ALLOW } from './ptyProtocol.ts';
import { localCliHost } from './localCliHost.ts';
import { planCli, type CliHost, type PreparedCli } from './machine.ts';
import {
  clip,
  describeTool,
  playwrightAction,
  resultText,
  summariseResult,
  tidyPaths,
  todoLines,
  type LogEntry,
  type SessionCallbacks,
  type SessionHandle,
  type SessionOptions,
  type SessionResult,
} from './agentRunner.ts';
import type { OfficeTools } from './ceo.ts';
import type { AgentTerminal } from './terminal.ts';
import type { AgentCli } from '../shared/types.ts';

// One agent session as the real CLI in a pseudo-terminal: the same contract as the Agent SDK runner (log lines, the
// current tool, the final text, finished), so the rest of the office doesn't care which runtime an agent uses.
//
// Claude Code reports through HTTP hooks passed with --settings: every tool call (PreToolUse also approves it, so the
// CLI never stops to ask), each finished turn (Stop, with the final text), failures (StopFailure) and, through its
// status line, cost and usage limits. Codex says when a turn ends (notify) and, once the manager trusts the office's
// hooks in its /hooks, reports its steps through them too. OpenCode's plugin only says when a turn ends.
//
// The CLIs run in the office's terminal keeper (ptyClient.ts) and call their hooks there, so an office restart doesn't
// stop them: the office picks them up again when it's back (reconnectClis). Writing a CLI's files and starting it is
// its machine's part (a CliHost, see machine.ts): here, the office's own (localCliHost.ts).

export { terminalsAvailable };

/** After a turn ends the CLI may still pick up a queued message: only an idle prompt this long means it's done. */
const FINISH_GRACE_MS = 3000;
/** Starting up: how long before the office says the CLI seems to be waiting on something. */
const BOOT_MS = 60_000;
/** Claude's usage warning, the way the SDK's allowed_warning is used: pace new work from here. */
const USAGE_WARN_PCT = 90;

// ---------- routing the CLIs' calls back to their sessions ----------

let officeUrl = '';

/** The office's own address, for the hook and MCP endpoints the CLIs call back on. Set once the server listens. */
export function setOfficeUrl(url: string) {
  officeUrl = url;
}

interface Route {
  hook(body: Record<string, unknown>): Record<string, unknown>;
  office?: OfficeTools;
}
const routes = new Map<string, Route>();

/** A hook, status line or notify call from a CLI (POST /api/hooks/:token). The answer is the hook's output. */
export function handleHook(token: string, body: unknown): Record<string, unknown> {
  const route = routes.get(token);
  if (!route || !body || typeof body !== 'object' || Array.isArray(body)) return {};
  try {
    return route.hook(body as Record<string, unknown>);
  } catch (err) {
    console.warn('hook failed', err);
    return {};
  }
}

/** The CEO's office tools over MCP (Streamable HTTP, stateless: a fresh server per request). */
export async function handleMcp(token: string, req: Request, res: Response) {
  const office = routes.get(token)?.office;
  if (!office) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'This session has ended.' }, id: null });
    return;
  }
  const server = office.serve();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// ---------- plumbing ----------

/** What a tool call returned, as text, and any images in it (Playwright screenshots). */
function toolOutput(response: unknown): { text: string; images: { data: string; mime: string }[] } {
  const images: { data: string; mime: string }[] = [];
  const blocks = Array.isArray(response) ? response : Array.isArray((response as { content?: unknown })?.content) ? (response as { content: unknown[] }).content : null;
  if (blocks) {
    for (const b of blocks as Record<string, unknown>[]) {
      const source = b?.source as { type?: string; data?: string; media_type?: string } | undefined;
      if (b?.type === 'image' && source?.type === 'base64' && source.data) images.push({ data: source.data, mime: source.media_type ?? 'image/png' });
      else if (b?.type === 'image' && typeof b.data === 'string') images.push({ data: b.data, mime: String(b.mimeType ?? 'image/png') });
    }
    return { text: resultText(blocks), images };
  }
  if (typeof response === 'string') return { text: response, images };
  const r = response as { stdout?: unknown; stderr?: unknown; file?: { content?: unknown }; filenames?: unknown } | null;
  if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return { text: [r.stdout, r.stderr].filter((s) => typeof s === 'string' && s).join('\n'), images };
    if (typeof r.file?.content === 'string') return { text: r.file.content, images };
    if (Array.isArray(r.filenames)) return { text: r.filenames.join('\n'), images };
  }
  return { text: '', images };
}

/** A pseudo-terminal whose CLI just died throws on writes and resizes before it reports the exit: ignore that. */
function quietly(fn: () => void) {
  try {
    fn();
  } catch {
    // the CLI is gone; its exit is on the way
  }
}

// ---------- CLIs that outlive their session ----------

/**
 * A CLI running in an agent's terminal. It can outlive the office session that started it: when a developer's task
 * is done their CLI waits at its prompt, so the manager can keep using it, and a follow-up picks it up again. It also
 * outlives an office restart, held by the terminal keeper.
 */
interface LiveCli {
  agentId: string;
  cli: AgentCli;
  term: AgentTerminal;
  /** The machine it runs on. */
  host: CliHost;
  proc: Pty | null;
  token: string;
  dir: string;
  resumeId: string | null; // the session a follow-up resumes
  statusLine: string;
  /** Browser screenshots already passed on (Codex and OpenCode: collected from the browser's output folder). */
  shots: Set<string>;
  /** The office session driving it; null while it waits at its prompt. */
  session: { hook(b: Record<string, unknown>): Record<string, unknown>; exited(code: number, signal?: number): void } | null;
  idleTimer?: NodeJS.Timeout;
}
const lives = new Map<AgentTerminal, LiveCli>();
/** How to trust Codex's hooks was said once this run (Codex asks at the start of every session until they are). */
let hooksHinted = false;
/** A CLI left at its prompt this long is closed; its session can still be resumed. */
const IDLE_MS = 30 * 60_000;

const toolInput = (b: Record<string, unknown>) => (b.tool_input && typeof b.tool_input === 'object' ? b.tool_input : {}) as Record<string, unknown>;

/** The CLI has exited, or has had a few seconds to. */
const exitOf = (p: Pty) =>
  new Promise<void>((resolve) => {
    p.onExit(() => resolve());
    setTimeout(resolve, 5000);
  });

/** Close a CLI for good. A Codex thread is archived once its CLI is gone (see codexThread). */
function endLive(live: LiveCli): Promise<void> {
  if (lives.get(live.term) !== live) return Promise.resolve();
  lives.delete(live.term);
  clearTimeout(live.idleTimer);
  routes.delete(live.token);
  live.term.releaseIdle = null;
  live.term.bind(null);
  const gone = live.proc ? exitOf(live.proc) : undefined;
  live.proc?.kill();
  live.proc = null;
  live.term.note(`── ${cliLabel(live.cli)} session ended ──`);
  live.host.removeDir(live.dir);
  return live.cli === 'codex' && live.resumeId ? live.host.codexThread('archive', live.resumeId, gone) : Promise.resolve();
}

/** What the keeper holds with a CLI's terminal, so the office can pick it up again after a restart. */
interface CliMeta {
  agentId: string;
  cli: AgentCli;
  token: string;
  dir: string;
  resumeId: string | null;
  /** An office session was driving it (not waiting at its prompt). */
  busy: boolean;
}

const metaOf = (l: LiveCli): CliMeta => ({ agentId: l.agentId, cli: l.cli, token: l.token, dir: l.dir, resumeId: l.resumeId, busy: !!l.session });
const remember = (l: LiveCli) => l.proc?.setMeta(metaOf(l));

/** A CLI is running in its terminal: its output, its keys and its hooks are connected. */
function wire(l: LiveCli, office?: OfficeTools) {
  const p = l.proc!;
  lives.set(l.term, l);
  routes.set(l.token, { hook: (b) => (l.session ? l.session.hook(b) : idleHook(l, b)), office });
  l.term.bind({ write: (d) => quietly(() => p.write(d)), resize: (c, r) => quietly(() => p.resize(c, r)) });
  p.onData((data) => {
    if (lives.get(l.term) === l) l.term.write(data);
  });
  p.onExit((code, signal) => {
    l.proc = null;
    if (lives.get(l.term) !== l) return; // already replaced or closed
    if (l.session) l.session.exited(code, signal);
    else endLive(l); // quit while waiting at its prompt
  });
}

/** The task is done but the CLI stays at its prompt for the manager (or a follow-up), for a while. */
function waitAtPrompt(l: LiveCli) {
  clearTimeout(l.idleTimer);
  l.idleTimer = setTimeout(() => endLive(l), IDLE_MS);
  l.term.releaseIdle = () => endLive(l);
  remember(l);
}

export interface ReconnectedCli {
  agentId: string;
  cli: AgentCli;
  resumeId: string | null;
  /** It was working on a task: the office should follow its session again. */
  busy: boolean;
}

/**
 * The office started: connect to the terminal keeper and take back the CLIs it kept running through the restart, each
 * into its agent's terminal. They wait at their prompt until the office follows their session again (busy ones) or
 * the manager uses them. Ones whose agent is gone, or that exited while the office was away, are stopped: the office
 * resumes those sessions itself. Call hooksReady() once the busy ones are followed again.
 */
export async function reconnectClis(terminalFor: (agentId: string) => AgentTerminal | null, host: CliHost = localCliHost): Promise<ReconnectedCli[]> {
  const held = await host.reconnect(handleHook);
  const back: ReconnectedCli[] = [];
  for (const h of held) {
    const meta = (h.meta ?? {}) as Partial<CliMeta>;
    const term = meta.agentId ? terminalFor(meta.agentId) : null;
    if (h.exit !== null || !term || lives.has(term) || !isCli(meta.cli) || !meta.token || !meta.dir || !meta.agentId) {
      host.discard(h);
      if (meta.cli === 'codex' && meta.resumeId) void host.codexThread('archive', meta.resumeId, h.exit === null ? new Promise((r) => setTimeout(r, 5000)) : undefined);
      continue;
    }
    const l: LiveCli = { agentId: meta.agentId, cli: meta.cli, term, host, proc: host.adopt(h), token: meta.token, dir: meta.dir, resumeId: meta.resumeId ?? null, statusLine: '🏢 cubefarm', shots: new Set(), session: null };
    wire(l);
    waitAtPrompt(l);
    // Resizing makes the CLI draw its whole screen again, over whatever the saved copy of the terminal missed.
    setTimeout(() => quietly(() => (l.proc?.resize(term.cols - 1, term.rows), l.proc?.resize(term.cols, term.rows))), 500);
    back.push({ agentId: l.agentId, cli: l.cli, resumeId: l.resumeId, busy: !!meta.busy });
  }
  return back;
}

/** The office follows the reconnected CLIs' sessions again: hooks that waited for it can come in. */
export const hooksReady = () => localCliHost.hooksReady();

/**
 * What a desk clean-up (releaseDesk) must leave alone: the keeper, every CLI in a terminal, and the office's session
 * files, which only the CLIs' own command lines carry (Codex's instructions name the worktree, for one).
 */
export function officeProcesses(): { pids: number[]; markers: string[] } {
  const { pids, markers } = localCliHost.protect();
  const clis = [...lives.values()].filter((l) => l.host === localCliHost).map((l) => l.proc?.pid ?? 0);
  return { pids: [...pids, ...clis.filter((p) => p > 0)], markers };
}

/**
 * The office is stopping. On a restart its CLIs carry on in the terminal keeper, which holds their output and hooks
 * until it's back; when it quits for good they stop with it (once they're gone, their Codex threads are archived).
 */
export async function releaseClis(restart: boolean): Promise<void> {
  if (!restart) await Promise.all([...lives.values()].map(endLive)); // their exits come through the keeper
  localCliHost.leave();
}

/** A CLI waiting at its prompt: what the manager types there becomes a follow-up. */
function idleHook(live: LiveCli, b: Record<string, unknown>): Record<string, unknown> {
  switch (String(b.hook_event_name ?? '')) {
    case 'PreToolUse':
      return ALLOW;
    case 'UserPromptSubmit': {
      const text = String(b.prompt ?? '').trim();
      if (!text || live.term.onIdlePrompt?.(text)) return {};
      return { decision: 'block', reason: "The office couldn't take that on as a follow-up right now (see the agent's panel). Nothing was sent." };
    }
    case 'StatusLine':
      return { statusLine: live.statusLine };
  }
  return {};
}

// ---------- the session ----------

/** An agent session in its CLI, which runs on host (the office's own machine unless said otherwise). */
export function startCliSession(opts: SessionOptions, callbacks: SessionCallbacks, host: CliHost = localCliHost): SessionHandle {
  const term = opts.terminal!;
  // A follow-up to the session a CLI is still waiting in picks that CLI up again, and so does an office that restarted
  // while it worked (reattach); anything else replaces it.
  const prev = lives.get(term);
  const waiting = !!prev?.proc && !prev.session;
  const adopt = waiting && prev!.host === host && (!!opts.reattach || (prev!.cli === (opts.cli ?? 'claude') && !!opts.resumeSessionId && prev!.resumeId === opts.resumeSessionId));
  if (prev && !adopt) endLive(prev);
  let live: LiveCli | null = adopt ? prev! : null;
  const cli = live?.cli ?? opts.cli ?? 'claude';
  const label = cliLabel(cli);

  const token = crypto.randomUUID();
  const sessionId = opts.resumeSessionId ?? crypto.randomUUID();
  const started = Date.now();
  const statusLine = `🏢 cubefarm${opts.label ? ` · ${opts.label}` : ''}`;
  const toolNames = new Map<string, string>();
  const officePrompts: string[] = []; // prompts the office typed, so the ones the manager typed are told apart
  const launched: string[] = []; // every prompt the CLI was given, as given (Codex: finds its main thread)
  let mainThread: string | null = opts.resumeSessionId ?? null;
  const usageResets = new Map<string, number | null>();
  const warned = new Set<string>();
  let done = false;
  let costUsd = 0;
  let turns = 0;
  let lastText = '';
  let turnError: string | null = null; // the turn failed (OpenCode reports errors separately from going idle)
  let begun = false; // the CLI took its first prompt
  let working = true; // a prompt is in hand and its turn hasn't ended (a new CLI starts on the one it's launched with)
  let finishTimer: NodeJS.Timeout | undefined;
  let bootTimer: NodeJS.Timeout | undefined;
  let screenTimer: NodeJS.Timeout | undefined;
  let shotTimer: NodeJS.Timeout | undefined;
  const nudged = new Set<string>();
  let trustKeys = 0; // keys pressed on a folder-trust question (a few at most)
  let trustedAt = 0;

  const cb: SessionCallbacks = { ...callbacks };
  const conversation = claudeConversation(opts.resumeSessionId ?? null, (id) => cb.sessionId(id));
  const log = (entries: LogEntry[]) => entries.length && cb.log(entries);

  /**
   * Codex and OpenCode don't report tool results: pass on the screenshots their browser saved instead. all: the last
   * look. A box answers later: the promise settles once they're passed on.
   */
  const collectShots = (all = false): Promise<void> | undefined => {
    const l = live;
    if (!l || cli === 'claude' || !opts.browserTesting) return;
    const pass = (shots: { data: Buffer; mime: string }[]) => shots.forEach((shot) => cb.screenshot(shot.data, shot.mime));
    const shots = l.host.newShots(l.dir, l.shots, all ? Infinity : Date.now());
    if (!(shots instanceof Promise)) {
      pass(shots);
      return;
    }
    return shots.then(pass, () => undefined);
  };

  /** The session is over. A developer's CLI that ended its turn normally stays at its prompt (keep); others close. */
  const finish = (r: Omit<SessionResult, 'costUsd' | 'turns'>, keep = false) => {
    if (done) return;
    done = true;
    for (const t of [finishTimer, bootTimer]) clearTimeout(t);
    clearInterval(screenTimer);
    clearInterval(shotTimer);
    const lastShots = collectShots(true);
    if (term.onInput === watchKeys) term.onInput = null;
    const l = live;
    if (l && lives.get(term) === l) {
      l.session = null;
      if (keep && opts.keepAlive && l.proc) waitAtPrompt(l);
      else endLive(l);
    }
    cb.tool(null);
    // On a box, the last screenshots come back over the link: QA's evidence must be in before the session is over.
    if (!lastShots) return cb.finished({ ...r, costUsd, turns });
    void Promise.race([lastShots, new Promise((res) => setTimeout(res, 10_000))]).then(() => cb.finished({ ...r, costUsd, turns }));
  };

  /** A turn ended: finished, unless the CLI picks up another prompt within the grace period. */
  const turnEnded = (text: string) => {
    lastText = text;
    working = false;
    cb.tool(null);
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => finish({ ok: !turnError, text: lastText, errors: turnError ? [turnError] : [] }, true), FINISH_GRACE_MS);
  };
  const busy = () => {
    begun = true;
    working = true;
    clearTimeout(finishTimer);
  };

  /** The turn was interrupted from the terminal: the office treats it like Stop, and the CLI waits for the manager. */
  const interrupted = () => finish({ ok: false, text: lastText, errors: ['Interrupted in the terminal'], interrupted: true }, true);

  /** Esc typed in the terminal while the agent works: if the CLI then says it interrupted the turn, it's over. */
  const watchKeys = (data: string) => {
    if (data !== '\x1b' || done || !begun) return;
    const before = interruptions(term.screen());
    let looks = 0;
    const look = () => {
      if (done) return;
      if (interruptions(term.screen()) > before) interrupted();
      else if (++looks < 4) setTimeout(look, 1000);
    };
    setTimeout(look, 800);
  };
  term.onInput = watchKeys;

  const assistantLines = (text: string): LogEntry[] => {
    const lines = text.split('\n');
    const out: LogEntry[] = lines.slice(0, 30).map((l, i) => ({ kind: 'text', text: `${i === 0 ? '● ' : '  '}${l}` }));
    if (lines.length > 30) out.push({ kind: 'text', text: `  … (${lines.length - 30} more lines)` });
    return out;
  };

  const onStatus = (b: Record<string, unknown>) => {
    const cost = Number((b.cost as { total_cost_usd?: unknown } | undefined)?.total_cost_usd);
    if (Number.isFinite(cost)) costUsd = cost;
    const limits = (b.rate_limits ?? {}) as Record<string, { used_percentage?: unknown; resets_at?: unknown } | null>;
    for (const [type, l] of Object.entries(limits)) {
      const used = Number(l?.used_percentage);
      if (!Number.isFinite(used)) continue;
      const resetsAt = Number(l?.resets_at) > 0 ? Number(l?.resets_at) * 1000 : null;
      usageResets.set(type, used >= 100 ? resetsAt : null);
      if (used >= USAGE_WARN_PCT && used < 100 && !warned.has(type)) {
        warned.add(type);
        cb.usageWarning?.({ resetsAt, rateLimitType: type, utilization: used / 100 });
      }
    }
    return { statusLine };
  };

  /** Codex's hooks name the thread they come from: the first one that isn't a subagent's is the main thread. */
  const pinMain = (b: Record<string, unknown>) => {
    if (cli === 'codex' && !mainThread && typeof b.session_id === 'string' && b.session_id) mainThread = b.session_id;
  };

  const hook = (b: Record<string, unknown>): Record<string, unknown> => {
    const event = String(b.hook_event_name ?? '');
    const sub = typeof b.agent_id === 'string' && b.agent_id !== ''; // a subagent's call: kept off the log
    if (cli === 'claude') {
      const id = resumableSession(b, (file) => host.hasFile(file));
      if (id) conversation.found(id);
    }
    switch (event) {
      case 'PreToolUse': {
        const name = String(b.tool_name ?? '');
        const input = toolInput(b);
        if (!sub) {
          busy();
          turns += 1;
          toolNames.set(String(b.tool_use_id ?? ''), name);
          log([{ kind: 'tool', tool: name, text: `⏺ ${describeTool(opts.cwd, name, input)}` }, ...(name === 'TodoWrite' ? todoLines(input) : [])]);
          cb.tool(name);
          if (playwrightAction(name) === 'navigate' && typeof input.url === 'string') cb.browserUrl(input.url);
        }
        return ALLOW;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (sub) return {};
        const name = toolNames.get(String(b.tool_use_id ?? '')) ?? String(b.tool_name ?? '');
        const out = toolOutput(b.tool_response);
        // Codex's unnamed screenshots are collected from the browser's folder (its hooks may not be trusted yet).
        if (cli === 'claude') for (const img of out.images) cb.screenshot(Buffer.from(img.data, 'base64'), img.mime);
        const saved = playwrightAction(name) === 'take_screenshot' && !out.images.length ? host.savedShot(opts.cwd, out.text) : null;
        if (saved instanceof Promise) void saved.then((s) => s && cb.screenshot(s.data, s.mime));
        else if (saved) cb.screenshot(saved.data, saved.mime);
        if (playwrightAction(name) !== null) {
          const url = out.text.match(/Page URL:\s*(\S+)/);
          if (url) cb.browserUrl(url[1]);
        }
        if (event === 'PostToolUseFailure') log([{ kind: 'error', text: `  ⎿ ${clip(tidyPaths(opts.cwd, String(b.error ?? out.text ?? 'Error')).split('\n')[0] || 'Error', 200)}` }]);
        else if (name !== 'TodoWrite') log(summariseResult(opts.cwd, name, out.text));
        cb.tool(null);
        return {};
      }
      case 'SessionStart': // Codex, once its hooks are trusted: the thread it starts on is the main thread
        if (!sub) pinMain(b);
        return {};
      case 'UserPromptSubmit': {
        if (sub) return {};
        pinMain(b);
        busy();
        const prompt = String(b.prompt ?? '').trim();
        const i = officePrompts.findIndex((p) => p.slice(0, 60) === prompt.slice(0, 60));
        if (i >= 0) officePrompts.splice(i, 1);
        else if (prompt) log([{ kind: 'manager', text: `▶ Typed in the terminal: ${clip(prompt.split('\n')[0], 200)}` }]);
        return {};
      }
      case 'Stop': {
        const text = String(b.last_assistant_message ?? '').trim();
        turns += 1;
        if (text) {
          log(assistantLines(text));
          cb.turn?.(text);
        }
        turnEnded(text);
        return {};
      }
      case 'StopFailure': {
        const error = String(b.error ?? 'unknown');
        const details = String(b.error_details ?? '').trim();
        if (error === 'rate_limit') cb.limited?.([...usageResets.values()].find((t) => t !== null) ?? null);
        finish({ ok: false, text: lastText, errors: [`${label} stopped: ${error.replace(/_/g, ' ')}${details ? ` (${clip(details, 160)})` : ''}`] }, true);
        return {};
      }
      case 'Notification': {
        if (b.notification_type === 'permission_prompt') log([{ kind: 'error', text: `⚠ ${label} is waiting for a permission answer: open the terminal to answer it.` }]);
        return {};
      }
      case 'StatusLine':
        return onStatus(b);
      case 'Interrupt': // Codex: Esc in its terminal
        if (!sub) interrupted();
        return {};
      // Codex's notify program and the OpenCode plugin
      case 'TurnComplete': {
        const thread = typeof b.session_id === 'string' ? b.session_id : '';
        if (cli === 'codex') {
          // Codex also runs side threads (a title, subagents): only the main thread's turns count.
          const main = codexTurnThread(mainThread, { thread, input: String(b.input ?? '').trim(), subagent: b.subagent === true }, launched);
          if (main === null) return {};
          mainThread = main;
        }
        if (thread) {
          cb.sessionId(thread);
          if (live && live.resumeId !== thread) {
            live.resumeId = thread;
            remember(live);
          }
        }
        const text = String(b.last_assistant_message ?? '').trim();
        turns += 1;
        if (text) {
          log(assistantLines(text));
          cb.turn?.(text);
        }
        turnEnded(cli === 'codex' ? text || lastText : text); // an empty Codex reply keeps what it said last
        return {};
      }
      case 'TurnError':
        turnError = `${label}: ${clip(String(b.error ?? 'error'), 200)}`;
        log([{ kind: 'error', text: `✗ ${turnError}` }]);
        return {};
    }
    return {};
  };

  /** The CLI quit on its own: /exit typed in the terminal, a crash, a signal, or it couldn't start (not signed in, bad flag…). */
  const exited = (code: number, signal?: number) => {
    if (cli === 'claude' && !begun && conversation.lost(term.screen())) return finish({ ok: false, text: '', errors: [LOST_CONVERSATION] });
    const { ok, error } = cliExit(cli, { code, signal, working, lastText, ranMs: Date.now() - started });
    finish({ ok, text: lastText, errors: error ? [error] : [] });
  };

  const handle: SessionHandle = {
    send(text) {
      const proc = live?.proc;
      if (done || !proc) return;
      busy();
      turnError = null;
      officePrompts.push(text.trim());
      // Pasted, so newlines stay in the message instead of sending it early; then Enter.
      const clean = text.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n');
      launched.push(clean.trim());
      quietly(() => proc.write(`\x1b[200~${clean}\x1b[201~`));
      setTimeout(() => quietly(() => live?.proc?.write('\r')), 150);
    },
    stop() {
      finish({ ok: false, text: '', errors: ['Stopped by manager'] });
    },
  };

  if (adopt && live) {
    // Back in the CLI that was waiting at its prompt: same conversation, same terminal.
    clearTimeout(live.idleTimer);
    term.releaseIdle = null;
    live.session = { hook, exited };
    Object.assign(live, { statusLine });
    remember(live);
    if (live.resumeId && cli !== 'claude') cb.sessionId(live.resumeId); // Claude's hooks say when its conversation is on disk
    if (opts.typed || opts.reattach) busy(); // typed at the prompt, or still at it after a restart: already running
    else handle.send(opts.prompt);
    shotTimer = setInterval(collectShots, 2000);
    return handle;
  }
  if (opts.reattach) {
    // Its CLI didn't make it through the restart after all.
    setTimeout(() => finish({ ok: false, text: '', errors: [`${label} stopped while the office restarted.`] }), 0);
    return handle;
  }

  // ---------- a new CLI: its plan, then its files and command line on its machine ----------

  let ready: PreparedCli | Promise<PreparedCli>;
  try {
    ready = host.prepare(planCli(opts, { cli, token, sessionId, officeUrl }));
  } catch (err) {
    setTimeout(() => finish({ ok: false, text: '', errors: [(err as Error).message] }), 0);
    return handle;
  }
  if (ready instanceof Promise) {
    // A box writes the files: the CLI starts once it has (unless the session was stopped meanwhile).
    void ready.then(
      (prepared) => !done && launch(prepared),
      (err: unknown) => finish({ ok: false, text: '', errors: [(err as Error).message] }),
    );
  } else {
    launch(ready);
  }
  return handle;

  function launch(prepared: PreparedCli) {
    officePrompts.push(prepared.prompt.trim()); // as given: a long one is a pointer to its file
    launched.push(prepared.prompt.trim());

    if (cli === 'claude' && opts.resumeSessionId) cb.sessionId(sessionId); // a new one is saved once it's on disk (see the hooks)
    term.note(`── ${label}${opts.label ? ` · ${opts.label}` : ''} ──`);
    const resumeId = cli === 'claude' ? sessionId : (opts.resumeSessionId ?? null);
    const l: LiveCli = { agentId: opts.agentId ?? '', cli, term, host, proc: null, token, dir: prepared.dir, resumeId, statusLine, shots: new Set(), session: { hook, exited } };
    const begin = () => {
      if (done) return; // stopped while its thread was being unarchived
      let p: Pty;
      try {
        p = prepared.start({ cols: term.cols, rows: term.rows }, metaOf(l));
      } catch (err) {
        setTimeout(() => finish({ ok: false, text: '', errors: [(err as Error).message] }), 0);
        return;
      }
      l.proc = p;
      live = l;
      wire(l, opts.office);
      shotTimer = setInterval(collectShots, 2000);

      // Starting up: answer the folder-trust question for the office's own worktrees (the answer that trusts it), and
      // say so when a CLI is waiting on something only the manager can do (signing in).
      screenTimer = setInterval(() => {
        if (done || Date.now() - started > BOOT_MS * 2) return clearInterval(screenTimer);
        const screen = term.screen();
        const review = hookReviewKey(screen);
        const key = trustKeys < 12 && Date.now() - trustedAt > 3000 ? (trustKey(screen) ?? review) : null;
        if (key === 'down') {
          trustKeys += 1;
          quietly(() => p.write(term.appCursor ? '\x1bOB' : '\x1b[B'));
        } else if (key === 'enter') {
          trustKeys += 1;
          trustedAt = Date.now(); // the question takes a moment to go: don't answer it twice
          if (!review) log([{ kind: 'system', text: `✓ Trusted the worktree for ${label}.` }]);
          else if (!hooksHinted) {
            hooksHinted = true;
            log([{ kind: 'system', text: `ℹ To see ${label}'s steps here, trust the office's hooks once: in this terminal, type /hooks and press t. Until then the office shows its task.` }]);
          }
          quietly(() => p.write('\r'));
        }
        if (!nudged.has('login') && /Not logged in|run \/login|Select login method|Sign in with ChatGPT|Please login|Invalid API key/i.test(screen)) {
          nudged.add('login');
          log([{ kind: 'error', text: `⚠ ${label} needs you to sign in: open the terminal and sign in there, or run "${cli}" in a terminal of your own.` }]);
        } else if (!nudged.has('setup') && !trustKey(screen) && Date.now() - trustedAt > 5000 && /Choose the text style|Press Enter to continue|Bypass Permissions mode|Settings Error/i.test(screen)) {
          // First-run screens only the manager should answer: the CLI waits for them in the terminal.
          nudged.add('setup');
          log([{ kind: 'error', text: `⚠ ${label} is waiting on a setup screen: open the terminal to answer it.` }]);
        }
      }, 1000);
      bootTimer = setTimeout(() => {
        if (!done && !begun && cli === 'claude') log([{ kind: 'error', text: `⚠ ${label} hasn't started on the task yet. Open the terminal to see what it's waiting for.` }]);
      }, BOOT_MS);
    };
    // Codex won't resume a thread the office archived (see codexThread): it's unarchived first.
    if (cli === 'codex' && opts.resumeSessionId) void host.codexThread('unarchive', opts.resumeSessionId).then(begin);
    else begin();
  }
}
