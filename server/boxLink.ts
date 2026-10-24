import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { VERSION } from './config.ts';
import { KeeperPty, terminalMessage } from './ptyClient.ts';
import { encode, PTY_PROTOCOL, readMessages, type FromHost, type HeldPty, type ToHost } from './ptyProtocol.ts';
import { reconnectClis, startCliSession } from './cliRunner.ts';
import type { ClaudeTurn } from './clis.ts';
import type { RecoveredTurn } from './cliTranscript.ts';
import { boxCommand, boxDeskDir, boxMainDir, boxUpdateCommand, parseUpdateResult, redialDelay, retryForm, updateFailure, type BoxInfo, type BoxLayout, type BoxUpdateResult } from './fleet.ts';
import type { BoxConnection, BoxOptions, CliHost, CliPlan, Machine, PreparedCli } from './machine.ts';
import type { SessionHandle } from './agentRunner.ts';
import type { AgentCli, BoxStatus, CliView, MachineSample, MachineTelemetry } from '../shared/types.ts';
import { monitorResources } from './machineHealth.ts';

// The office's side of a box: `ssh <destination> cubefarm box --stdio` (boxStdio.ts) runs desk and session-file
// methods there (boxOps.ts) and bridges to the box's host, a terminal keeper on that machine. The ssh link can drop
// and is redialled; the box's CLIs keep running meanwhile and their hooks wait on the box. Paths the box hands out are
// its own and are only ever passed back to it.

/** How long the first answer may take: npx may be installing cubefarm on the box. */
const READY_MS = 180_000;
/** A method on the box: most are quick, cloning and preparing a desk aren't. */
const CALL_MS = 120_000;
const SLOW_CALL_MS = 15 * 60_000;
const SLOW = new Set(['prepareDesk', 'detectClis', 'info']);
/** Updating a box's cubefarm: a fetch, maybe an npm install, and a build. */
const UPDATE_MS = 20 * 60_000;
/** A relink waits this long at most for the box's methods to answer and prepared CLIs to start (a new link loses them). */
const RELINK_WAIT_MS = 2 * 60_000;
/** A CLI prepared on the box is started within this, or never. */
const LAUNCH_MS = 30_000;

class BoxLink implements CliHost {
  status: BoxStatus = 'connecting';
  error: string | null = null;
  info: BoxInfo | null = null;
  clis: CliView[] = [];
  telemetry: MachineTelemetry | null = null;
  private stopResources?: () => void;
  readonly ptys = new Map<string, KeeperPty>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderr = '';
  private nextRid = 1;
  private calls = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private attempt = 0;
  private redial?: NodeJS.Timeout;
  private closed = false;
  /** Why the box was refused (another protocol version): kept over the link's own error. */
  private refused: string | null = null;
  /** Kills sent while the link was down: delivered when it's back, so a stopped CLI stops. */
  private kills: string[] = [];
  private hooksOpen = false;
  private onHook: (token: string, body: unknown) => unknown = () => ({});
  private firstHeld?: (held: HeldPty[]) => void;
  /**
   * Send the command as it is, not through the login shell (a Windows box's cmd has no sh). Until a form has worked
   * (pinned), a failed dial tries the other one next: Windows' "not recognized" is in the box's own language.
   */
  private plain = false;
  private pinned = false;
  /** check()s waiting on a dial: settled when the box answers, or when the dial ends with it offline. */
  private dialWaiters: { resolve(): void; reject(e: Error): void }[] = [];
  /** Transcripts the box said are on its disk (see hasFile). */
  private transcripts = new Set<string>();
  /** info and clis are from the link that's up now. */
  reported = false;
  /** The link was dropped on purpose (a restart or a relink): its closing is expected, and redialled at once. */
  private restarting = false;
  /** CLIs prepared on the box and not started yet, by token: when each was. */
  private launching = new Map<string, number>();

  constructor(
    private readonly opts: BoxOptions,
    private readonly onChange: () => void,
  ) {}

  private get name() {
    return this.opts.box.name;
  }

  private set(status: BoxStatus, error: string | null = this.error) {
    if (status !== 'online') {
      this.stopResources?.();
      this.stopResources = undefined;
      this.telemetry = null;
    }
    this.status = status;
    this.error = error;
    this.onChange();
  }

  private send = (m: ToHost) => {
    const c = this.child;
    if (c && this.status === 'online' && c.stdin.writable) c.stdin.write(encode(m));
    else if (m.op === 'kill') this.kills.push(m.id);
  };

  // ---------- the link ----------

  dial() {
    if (this.closed || this.child) return;
    clearTimeout(this.redial);
    let cmd: { file: string; args: string[] };
    try {
      cmd = boxCommand(this.opts.box.destination, VERSION, this.opts.officeId, undefined, this.opts.box.layout ? this.opts.box.layout.sep === '\\' : this.plain);
    } catch (err) {
      return this.set('offline', (err as Error).message);
    }
    this.set('connecting');
    this.stderr = '';
    const child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) child.kill();
    }, READY_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-2000)));
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      this.stderr += `\n${err.message}`;
    });
    readMessages<FromHost>(child.stdout, (m) => {
      if (this.child !== child) return;
      if (!ready) {
        if (m.op !== 'ready') return;
        ready = true;
        clearTimeout(timer);
        return this.ready(m);
      }
      this.message(m);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = null;
      this.reported = false;
      for (const [rid, c] of this.calls) {
        clearTimeout(c.timer);
        c.reject(new Error(`Lost the link to ${this.name}.`));
        this.calls.delete(rid);
      }
      if (this.closed) return;
      if (this.restarting) {
        this.restarting = false;
        this.set('connecting', null);
        return void (this.redial = setTimeout(() => this.dial(), 1000));
      }
      if (!ready && !this.pinned && !this.opts.box.layout) {
        const next = retryForm(this.plain, this.stderr);
        this.plain = next.plain;
        if (next.now) return void (this.redial = setTimeout(() => this.dial(), 0));
      }
      const said = this.stderr.trim().split('\n').filter(Boolean).pop();
      this.set('offline', this.refused ?? (ready ? `the link dropped${said ? `: ${said}` : ''}` : (said ?? `ssh exited (${code})`)));
      for (const w of this.dialWaiters.splice(0)) w.reject(new Error(this.error ?? 'it went offline'));
      this.redial = setTimeout(() => this.dial(), redialDelay(this.attempt++));
    });
  }

  private ready(m: Extract<FromHost, { op: 'ready' }>) {
    if (m.version !== PTY_PROTOCOL) {
      this.refused = `${this.name} runs cubefarm protocol v${m.version}; this office speaks v${PTY_PROTOCOL}. Update cubefarm on one of them.`;
      this.child?.kill();
      return;
    }
    this.pinned = true;
    this.attempt = 0;
    this.refused = null;
    this.set('online', null);
    this.stopResources?.();
    this.stopResources = monitorResources(() => this.call<MachineSample>('resources'), (value) => {
      this.telemetry = value;
      this.onChange();
    });
    for (const id of this.kills.splice(0)) this.send({ op: 'kill', id });
    // Terminals followed before the link dropped carry on from what they printed meanwhile; ones the box lost, ended.
    const listed = new Set(m.ptys.map((p) => p.id));
    for (const [id, p] of this.ptys) {
      if (listed.has(id)) this.send({ op: 'attach', id });
      else p.exit(-1);
    }
    const unknown = m.ptys.filter((p) => !this.ptys.has(p.id));
    if (this.firstHeld) {
      this.firstHeld(unknown);
      this.firstHeld = undefined;
    } else {
      for (const p of unknown) this.send({ op: 'kill', id: p.id });
    }
    if (this.hooksOpen) this.send({ op: 'hooksReady' });
    const waiters = this.dialWaiters.splice(0);
    void this.report().then(
      () => waiters.forEach((w) => w.resolve()),
      (err: Error) => {
        console.warn(`  box ${this.name}: ${err.message}`);
        waiters.forEach((w) => w.reject(err));
      },
    );
  }

  /** What the box has set up (its git, gh, paths) and the CLIs it has. */
  private report() {
    return this.call<BoxInfo>('info')
      .then((info) => {
        this.info = info;
        this.onChange();
        return this.call<CliView[]>('detectClis');
      })
      .then((clis) => {
        this.clis = clis;
        this.reported = true;
        this.onChange();
      });
  }

  get isRefused() {
    return this.refused !== null;
  }

  /** `cubefarm box --update <target>` on the box, over an ssh of its own (it works whatever protocol the host speaks). */
  update(target: string): Promise<BoxUpdateResult> {
    let cmd: { file: string; args: string[] };
    try {
      cmd = boxUpdateCommand(this.opts.box.destination, VERSION, target, undefined, this.opts.box.layout ? this.opts.box.layout.sep === '\\' : this.plain);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), UPDATE_MS);
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out = (out + d).slice(-20_000)));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-2000)));
      child.on('error', (e) => (err += `\n${e.message}`));
      child.on('close', (code) => {
        clearTimeout(timer);
        const result = parseUpdateResult(out);
        if (result) return resolve(result);
        reject(new Error(updateFailure(this.opts.box.name, err.trim().split('\n').filter(Boolean).pop(), code)));
      });
    });
  }

  /** Shut the host down and dial again: the box's next host runs the cubefarm now on its disk. One that's offline is dialled now. */
  restart(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const child = this.child;
    if (this.status !== 'online' || !child) return this.check();
    const back = new Promise<void>((resolve, reject) => this.dialWaiters.push({ resolve, reject }));
    this.restarting = true;
    this.send({ op: 'shutdown' });
    setTimeout(() => this.child === child && child.kill(), 15_000).unref(); // a host that never went: the link goes instead
    return back;
  }

  /**
   * Dial a new link once the box's methods have answered and its prepared CLIs started: the box's next bridge runs the
   * cubefarm now on its disk, and its keeper keeps the terminals. One that's offline is dialled now.
   */
  async relink(): Promise<void> {
    this.stopResources?.(); // background sampling must not keep this link's outstanding-RPC drain busy
    const until = Date.now() + RELINK_WAIT_MS;
    const busy = () => {
      for (const [token, at] of this.launching) if (Date.now() - at > LAUNCH_MS) this.launching.delete(token);
      return this.calls.size > 0 || this.launching.size > 0;
    };
    while (!this.closed && this.status === 'online' && busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    const child = this.child;
    if (this.closed) return;
    if (this.status !== 'online' || !child) return this.check();
    const back = new Promise<void>((resolve, reject) => this.dialWaiters.push({ resolve, reject }));
    this.restarting = true;
    child.stdin.end(); // the bridge goes; the keeper waits for the next
    setTimeout(() => this.child === child && child.kill(), 15_000).unref();
    return back;
  }

  /**
   * Ask again (BoxConnection.check): an online box reports again; one that isn't is dialled now, not after its wait.
   * Settles once that dial has: the box answered and reported, or it's still offline (rejected with why).
   */
  async check() {
    if (this.closed) return;
    if (this.status === 'online') return this.report();
    const answered = new Promise<void>((resolve, reject) => this.dialWaiters.push({ resolve, reject }));
    if (!this.child) {
      clearTimeout(this.redial);
      this.attempt = 0;
      this.dial();
    }
    return answered;
  }

  private message(m: FromHost) {
    if (terminalMessage(this.ptys, m)) {
      if (m.op !== 'data') this.onChange(); // a CLI started or ended: the box's running count changed
      return;
    }
    if (m.op === 'rpcReply') {
      const c = this.calls.get(m.rid);
      if (!c) return;
      this.calls.delete(m.rid);
      clearTimeout(c.timer);
      return m.ok ? c.resolve(m.value) : c.reject(new Error(m.error ?? 'failed on the box'));
    }
    if (m.op === 'hook') {
      const body = m.body as Record<string, unknown> | null;
      if (body?.cubefarm_transcript === true && typeof body.transcript_path === 'string') this.transcripts.add(body.transcript_path);
      void Promise.resolve()
        .then(() => this.onHook(m.token, m.body))
        .catch(() => ({}))
        .then((answer) => this.send({ op: 'hookReply', rid: m.rid, answer }));
    }
  }

  /** Run one of the box's methods (boxOps.ts). Rejects at once while the box is offline. */
  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.status !== 'online') return Promise.reject(new Error(`${this.name} is ${this.status}${this.error ? ` (${this.error})` : ''}.`));
    return new Promise<T>((resolve, reject) => {
      const rid = this.nextRid++;
      const timer = setTimeout(() => {
        this.calls.delete(rid);
        reject(new Error(`${this.name} didn't answer ${method} in time.`));
      }, method === 'resources' ? 10_000 : SLOW.has(method) ? SLOW_CALL_MS : CALL_MS);
      this.calls.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ op: 'rpc', rid, method, args });
    });
  }

  close() {
    this.closed = true;
    this.stopResources?.();
    clearTimeout(this.redial);
    for (const w of this.dialWaiters.splice(0)) w.reject(new Error('the box was removed'));
    const c = this.child;
    this.child = null;
    c?.stdin.end();
    setTimeout(() => c?.kill(), 2000).unref();
  }

  // ---------- CliHost ----------

  async prepare(plan: CliPlan): Promise<PreparedCli> {
    const { dir, prompt, hookUrl } = await this.call<{ dir: string; prompt: string; hookUrl?: string }>('prepare', plan);
    this.launching.set(plan.token, Date.now());
    return {
      dir,
      prompt,
      hookUrl,
      start: ({ cols, rows }, meta) => {
        this.launching.delete(plan.token);
        if (this.status !== 'online') throw new Error(`Could not start the CLI: ${this.name} went ${this.status}.`);
        const p = new KeeperPty(crypto.randomUUID(), this.send, this.ptys);
        this.send({ op: 'launch', id: p.id, token: plan.token, cols, rows, meta });
        this.onChange();
        return p;
      },
    };
  }

  hasFile(file: string) {
    return this.transcripts.has(file);
  }

  claudeTurn(cwd: string, sessionId: string) {
    return this.call<ClaudeTurn | null>('claudeTurn', cwd, sessionId).catch(() => null);
  }

  recoverTurn(cwd: string, cli: AgentCli, sessionId: string | null, since: number) {
    return this.call<RecoveredTurn | null>('recoverTurn', cwd, cli, sessionId, since).catch(() => null);
  }

  async newShots(dir: string, seen: Set<string>, now: number) {
    const shots = await this.call<{ name: string; data: string; mime: string }[]>('newShots', dir, [...seen], Number.isFinite(now) ? now : 0).catch(() => []);
    for (const s of shots) seen.add(s.name);
    return shots.map((s) => ({ name: s.name, mime: s.mime, data: Buffer.from(s.data, 'base64') }));
  }

  async savedShot(cwd: string, text: string) {
    const s = await this.call<{ data: string; mime: string } | null>('savedShot', cwd, text).catch(() => null);
    return s ? { mime: s.mime, data: Buffer.from(s.data, 'base64') } : null;
  }

  async codexThread(action: 'archive' | 'unarchive', id: string, after?: Promise<unknown>) {
    await after;
    await this.call('codexThread', action, id).catch(() => undefined);
  }

  removeDir(dir: string) {
    void this.call('removeDir', dir).catch(() => undefined);
  }

  /** Dial the box; resolves with the terminals it held for this office the first time it answers. */
  reconnect(onHook: (token: string, body: unknown) => unknown): Promise<HeldPty[]> {
    this.onHook = onHook;
    const held = new Promise<HeldPty[]>((resolve) => (this.firstHeld = resolve));
    this.dial();
    return held;
  }

  adopt(held: HeldPty) {
    const p = new KeeperPty(held.id, this.send, this.ptys);
    p.pid = held.pid;
    queueMicrotask(() => this.send({ op: 'attach', id: held.id }));
    return p;
  }

  discard(held: HeldPty) {
    this.send({ op: 'kill', id: held.id });
  }

  hooksReady() {
    this.hooksOpen = true;
    this.send({ op: 'hooksReady' });
  }

  leave() {
    this.close();
  }

  protect() {
    return { pids: [], markers: [] };
  }
}

/** Where a box keeps desks before it has said (never connected yet): a guess, replaced by its info. */
const UNKNOWN_LAYOUT: BoxLayout = { workspaces: '~/.cubefarm-box/workspaces', sep: '/' };

/** A box over ssh: its link, and the box as a Machine (desks and sessions on it; terminals only, no Agent SDK). */
export function connectBox(opts: BoxOptions): BoxConnection {
  const link = new BoxLink(opts, opts.changed);
  const layout = () => link.info ?? opts.box.layout ?? UNKNOWN_LAYOUT;
  const machine: Machine = {
    mainDir: (fullName) => boxMainDir(layout(), fullName),
    deskDir: (fullName, slug) => boxDeskDir(layout(), fullName, slug),
    async prepareDesk(fullName, base, slug, branch, note) {
      const r = await link.call<{ dir: string; notes: string[] }>('prepareDesk', fullName, base, slug, branch);
      for (const n of r.notes) note?.(n);
      return r.dir;
    },
    removeDesk: (fullName, slug) => link.call('removeDesk', fullName, slug),
    releaseDesk: (fullName, slug, port) => link.call('releaseDesk', fullName, slug, port),
    deskHead: (fullName, slug) => link.call('deskHead', fullName, slug),
    deskAhead: (fullName, slug, base) => link.call('deskAhead', fullName, slug, base),
    startSession(o, cb): SessionHandle {
      if (o.terminal) return startCliSession(o, cb, link);
      setTimeout(() => cb.finished({ ok: false, text: '', errors: [`${opts.box.name} runs agents in terminals only: switch the office's runtime to terminals.`], costUsd: 0, turns: 0 }), 0);
      return { send: () => undefined, stop: () => undefined };
    },
    terminals: true,
    detectClis: () => link.call<CliView[]>('detectClis'),
  };
  return {
    machine,
    state: () => ({ status: link.status, error: link.error, info: link.info, clis: link.clis, running: link.ptys.size, reported: link.reported, refused: link.isRefused, telemetry: link.telemetry }),
    reconnected: Promise.resolve().then(() => reconnectClis(opts.terminalFor, link)), // dials once the caller has the connection
    hooksReady: () => link.hooksReady(),
    check: () => link.check(),
    update: (target) => link.update(target),
    relink: () => link.relink(),
    restart: () => link.restart(),
    close: () => link.close(),
  };
}
