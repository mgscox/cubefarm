// The office's boxes: other machines an agent's desk and CLI can run on, reached over SSH (see docs/fleet-design.md).
// Pure rules here: which machine a session starts on, the ssh command line, and paths built the box's way.

/** A box as the office stores it. What it last reported is kept so its paths are known while it's offline. */
export interface PersistedBox {
  id: string;
  name: string;
  /** Whatever ssh accepts: user@host, a ~/.ssh/config alias, a Tailscale MagicDNS name. */
  destination: string;
  /** Its workspaces folder and path separator, from its last info. */
  layout?: BoxLayout | null;
}

/** Where a box keeps desks: its own folder and separator (it may run another OS than the office). */
export interface BoxLayout {
  workspaces: string;
  sep: '/' | '\\';
}

/** What a box reports when it connects. */
export interface BoxInfo extends BoxLayout {
  platform: string;
  version: string;
  /** The commit its host started on (its cubefarm checkout's then); null when it isn't a checkout (npx). A box from before #94 doesn't say. */
  commit?: string | null;
  git: string | null;
  ghReady: boolean;
}

/** The box an agent works on: their own, else their floor's. '' is the office's own machine. */
export const agentBox = (own: string | null | undefined, floor: string | undefined) => own ?? floor ?? '';

/** wait: the box to wait for; lacks: the coding agent it hasn't got (else it's offline). */
export type StartPlace = { box: string; fellBack?: string } | { wait: string; lacks?: string };

/**
 * Where a session starts. A new task (a new issue, a QA run) goes to the agent's box; anything inside a task (a fix
 * round, a follow-up, a resume, a reattach) stays on deskBox, where its worktree and CLI conversation are. A box that's
 * offline is waited for, and so is one without the agent's coding agent (lacks: its name, for a new task: a task
 * already there runs the CLI it started with); one that was removed falls back to the office (fellBack: the box it was).
 */
export function startPlace(kind: 'new' | 'within', want: string, deskBox: string, online: (id: string) => boolean | null, lacks: (id: string) => string | null = () => null): StartPlace {
  const box = kind === 'new' ? want : deskBox;
  if (!box) return { box: '' };
  const up = online(box);
  if (up === null) return { box: '', fellBack: box };
  if (!up) return { wait: box };
  const missing = kind === 'new' ? lacks(box) : null;
  return missing ? { wait: box, lacks: missing } : { box };
}

/** A destination ssh takes as a host, never as an option: no leading dash, no spaces or control characters. */
export function validDestination(d: string): boolean {
  return d.length > 0 && d.length <= 255 && !d.startsWith('-') && /^[\w.@:%[\]-]+$/.test(d);
}

/** A word for a POSIX shell, single-quoted. */
const sq = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

/**
 * The box host's command run in the box user's login shell. ssh runs a command in a plain non-interactive shell, which
 * on a Mac (zsh) never reads ~/.zprofile, so Node from Homebrew or nvm isn't on its PATH. sh starts it, so a fish or
 * csh login shell still works. What the login shell prints (nvm's "Now using node") isn't JSON and is skipped.
 */
export const loginShell = (command: string) => `sh -c ${sq('exec "${SHELL:-/bin/sh}" -l -c "$1"')} sh ${sq(command)}`;

/** Windows' shell (cmd) saying it has no such program: that box needs the command as it is, not through sh. */
export const notPosix = (stderr: string) => /is not recognized as an internal or external command|is not recognized as the name of a cmdlet/i.test(stderr);

/**
 * A box that never answered, before either form of its command has worked: the next dial tries the other form
 * (Windows says "not recognized" in its own language, so the message can't be relied on). now: it was clearly a
 * Windows box, so try at once.
 */
export const retryForm = (plain: boolean, stderr: string) => ({ plain: !plain, now: !plain && notPosix(stderr) });

/**
 * The command that reaches a box: ssh in batch mode (it never prompts) running the box host of the office's own
 * version, with stdio bridged to it, in the box user's login shell (plain: as it is, for a Windows box).
 * SWARM_BOX_COMMAND replaces the remote command (a box that runs a checkout).
 */
export function boxCommand(destination: string, version: string, officeId: string, remote = process.env.SWARM_BOX_COMMAND, plain = false): { file: string; args: string[] } {
  return sshBox(destination, version, `--stdio --office ${officeId}`, remote, plain);
}

/** A release (0.3.19), as opposed to a commit: what a box follows when the office runs from npm. */
export const isRelease = (target: string) => /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(target);

/** What `cubefarm box --update` takes: the office's commit, or its release when it isn't a checkout. */
export const isUpdateTarget = (target: string) => /^[0-9a-f]{7,40}$/.test(target) || isRelease(target);

/** The command that has a box bring its cubefarm to the office's commit or release (`cubefarm box --update <target>`, boxUpdate.ts). */
export function boxUpdateCommand(destination: string, version: string, target: string, remote = process.env.SWARM_BOX_COMMAND, plain = false): { file: string; args: string[] } {
  if (!isUpdateTarget(target)) throw new Error(`"${target}" isn't a commit or a release.`);
  return sshBox(destination, version, `--update ${target}`, remote, plain);
}

function sshBox(destination: string, version: string, rest: string, remote: string | undefined, plain: boolean) {
  if (!validDestination(destination)) throw new Error(`"${destination}" isn't a destination ssh can use.`);
  const run = `${remote?.trim() || `npx -y cubefarm@${version} box`} ${rest}`;
  const command = plain ? run : loginShell(run);
  return {
    file: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '--', destination, command],
  };
}

// ---------- following the office's version (#94) ----------

/** What `cubefarm box --update` prints as its last line. checkout: false when the box runs cubefarm from npx. */
export interface BoxUpdateResult {
  ok: boolean;
  checkout: boolean;
  from: string | null;
  to: string | null;
  error?: string;
}

/** The update's result from what the command printed (a login shell may print other lines first); null when there's none. */
export function parseUpdateResult(stdout: string): BoxUpdateResult | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {
      const r = JSON.parse(line) as Partial<BoxUpdateResult> | null;
      if (r && typeof r.ok === 'boolean') {
        const sha = (v: unknown) => (typeof v === 'string' ? v : null);
        return { ok: r.ok, checkout: r.checkout !== false, from: sha(r.from), to: sha(r.to), error: typeof r.error === 'string' ? r.error : undefined };
      }
    } catch {
      // not the result
    }
  }
  return null;
}

/**
 * What a box needs to run the office's own cubefarm, or null when it does (or can't be told). A checkout follows the
 * office's commit, or its release (target) when the office runs from npm, then its host restarts; one run by npx only
 * needs its host restarted, as its next link already runs the office's version. A box from before #94 doesn't say
 * which it is: it's asked to update, which also tells an old one apart. A box refused for another protocol runs an
 * old checkout (npx would run the office's version), so it's updated.
 */
export function boxSync(office: { version: string; commit: string | null }, box: { info: BoxInfo | null; refused: boolean }): { target: string; step: 'update' | 'restart' } | null {
  if (box.refused) return { target: office.commit ?? office.version, step: 'update' };
  const info = box.info;
  if (!info) return null;
  if (info.commit === null || !office.commit) {
    if (info.version === office.version) return null;
    return { target: office.version, step: info.commit === null ? 'restart' : 'update' };
  }
  return info.commit === office.commit ? null : { target: office.commit, step: 'update' };
}

/** A box following the office: waiting for its agents to finish, updating, restarting its host, or it failed. */
export interface BoxSyncState {
  target: string;
  step: 'update' | 'restart';
  state: 'draining' | 'updating' | 'restarting' | 'failed';
  error?: string;
}

const targetLabel = (t: string) => (isRelease(t) ? `v${t}` : t.slice(0, 7));

/** The line on a box's card while it follows the office. busy: its agents still at work. */
export function boxSyncText(s: BoxSyncState, busy: number): string {
  const t = targetLabel(s.target);
  if (s.state === 'draining' && busy > 0) return `Moving to the office's ${t} once its ${busy} agent${busy === 1 ? ' finishes' : 's finish'}: nothing new starts there.`;
  if (s.state !== 'restarting' && s.state !== 'failed') return `Updating to the office's ${t}…`;
  if (s.state === 'restarting') return `Restarting on ${t}…`;
  return `Couldn't move to the office's ${t}: ${s.error ?? 'unknown error'}`;
}

const repoFolder = (fullName: string) => fullName.replace('/', '__');

/** A floor's checkout on a box. */
export const boxMainDir = (l: BoxLayout, fullName: string) => [l.workspaces, repoFolder(fullName), 'main'].join(l.sep);

/** An agent's desk on a box. */
export const boxDeskDir = (l: BoxLayout, fullName: string, agentSlug: string) => [l.workspaces, repoFolder(fullName), 'desks', agentSlug].join(l.sep);

/** Redial delays after a box's link drops: quick at first, then once a minute. */
export const redialDelay = (attempt: number) => [2_000, 5_000, 10_000, 30_000][attempt] ?? 60_000;
