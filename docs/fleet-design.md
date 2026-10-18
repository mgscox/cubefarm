# Fleet: running agents' CLIs on other machines (design)

Status: phases 1 and 2 are built: the `Machine` / `CliHost` seam (`server/machine.ts`), and boxes over SSH with
assignment through REST (below); phase 3 adds the console UI (the Fleet tab, `client/src/ui/FleetTab.tsx`). The 3D touches
and phase 4 are still a design. Goal: the manager adds and removes **boxes** (other machines on the LAN or the
tailnet), assigns developers and QA testers to a box, and their coding-agent CLIs (Claude Code, Codex, OpenCode) run
there. Adding or removing a box, or reassigning an agent, never touches a running CLI: it applies when a session
starts.

## What already makes this cheap

The terminal keeper (`server/ptyHost.ts`) is already most of a remote node:

- it holds the CLIs' pseudo-terminals in a process of its own and speaks JSON lines (`ptyProtocol.ts`) to one office
  at a time: `spawn`, `write`, `resize`, `kill`, `attach`, `data`, `exit`;
- it runs a hook server on its own `127.0.0.1` port and relays hooks to the office (`hook` / `hookReply`), holding
  them while the office is away;
- it keeps output backlogs and running CLIs through disconnects, and an office that reconnects picks them up
  (`ready.ptys` → `adoptPty`).

A dropped Tailscale link looks exactly like an office restart, which the keeper already survives. The office only
ever sees a CLI as a byte stream plus hooks.

## What is tied to the office's machine today

| Piece | Where | Remote fix |
| --- | --- | --- |
| Desk worktrees, git ops (`prepareDesk`, `removeDesk`, `releaseDesk`, `deskHead`, `deskAhead`) | `workspace.ts` | run on the box, against the box's own clone of the repo |
| Linked repos' reference clones (`additionalDirectories`) | `workspace.ensureClone` | box keeps its own clones |
| Session files: `settings.json`, `mcp.json`, `instructions.md`, `task.md` | `cliRunner.ts` `SESSIONS_DIR` | box writes them in its home |
| Helper scripts (`statusline.cjs`, `notify.cjs`, `codex-hook.cjs`, `opencode-plugin.mjs`) and `process.execPath` | `cliRunner.ts` `BIN_DIR` | box writes its own (same package version) |
| CLI detection, `commandFor`, `.cmd` shim unwrapping, env | `clis.ts` | box detects and builds the command line |
| Hook URL `127.0.0.1:<keeper port>` | `keeperHookUrl()` | unchanged: it's the box's own keeper |
| Transcript check in hooks (`resumableSession(b, fs.existsSync)`) | `cliRunner.ts` | box checks, annotates the hook body |
| Codex/OpenCode screenshots read from the session's `browser/` folder; `screenshotFile(cwd, …)` | `cliRunner.ts` | box sends the files |
| `codexThread('unarchive')` before a resume | `clis.ts` | box runs it |
| Path building (`path.join`) | everywhere | box builds its own paths; office treats them as opaque strings (office and box may be different OSes) |
| CEO's office MCP (`officeUrl/api/mcp/:token`) | `cliRunner.ts` | not needed: CEO and researchers stay on the office |

Stays on the office: GitHub API work (`gh`: issues, PR state, merges, evidence upload), the floor's main checkout,
previews, the agents' terminal mirrors (`terminal.ts`), hook interpretation, scheduling, state.

## Design

### 1. A `Machine` seam (refactor, no behaviour change)

Pull the machine-local parts of `Backend` and `cliRunner` behind one interface:

```ts
interface Machine {
  id: string;                    // '' = the office itself
  platform: NodeJS.Platform;
  detectClis(): Promise<CliView[]>;
  ensureClone(fullName: string): Promise<void>;
  mainDir(fullName: string): Promise<string>;
  deskDir(fullName: string, agent: string): Promise<string>;
  prepareDesk(...): Promise<string>;
  removeDesk(...); releaseDesk(...); deskHead(...); deskAhead(...);
  /** Write the session's files, build the CLI's command line and env, spawn it in a pty. */
  launchCli(plan: LaunchPlan, meta: unknown): Pty;
  adopt(held: HeldPty): Pty;
  /** New screenshot files in a session's browser folder. */
  shots(sessionDir: string, since: number): Promise<{ data: Buffer; mime: string }[]>;
}
```

`localMachine` wraps today's code. `cliRunner.startCliSession` splits into *plan* (pure: prompt, hooks, MCP servers,
launch args; already mostly `clis.launchArgs`) and *launch* (files + spawn, done by the machine). Hook handling,
terminals and the session contract stay where they are. `swarm.ts` calls `this.machineFor(a)` wherever it calls a
desk method today (≈15 sites listed by `grep backend.(prepareDesk|deskDir|…)`).

### 2. The box host: the keeper, extended

`cubefarm box` on the box machine is `ptyHost.ts` plus a few ops, running the box's own copy of `workspace.ts` and
`clis.ts`:

- new `ToHost` ops: `rpc` (`{ rid, method, args }` for the `Machine` desk methods and `detectClis`), `launch` (a
  `LaunchPlan`; the host writes the files and spawns), `shots`;
- new `FromHost` ops: `rpcReply`, `info` (platform, version, CLIs found, `gh auth status`, git version, free disk);
- `ready` carries the box's office-id so one machine can serve two offices (home per office:
  `~/.cubefarm-box/<office id>`);
- a longer orphan time for boxes (hours, not 10 min): a remote link can be down longer than a restart;
- hooks whose answer never depends on the office (PreToolUse = allow, PostToolUse, status line with the last line
  the office sent) are answered on the box at once and forwarded fire-and-forget, so a slow or dropped link never
  stalls an agent. Only replies that matter (e.g. UserPromptSubmit's follow-up decision) wait for the office.

Bump `PTY_PROTOCOL`; an office and box on different versions refuse each other with a clear error.

### 3. Transport: SSH first

The box host executes commands for whoever connects, so the link is effectively remote code execution. Don't invent
auth for that; ride SSH:

- the office runs `ssh -T -o BatchMode=yes <destination> npx -y cubefarm@<office version> box --stdio`;
- `box --stdio` starts (or finds) the detached box host on the box, exactly as `ptyClient.startKeeper` launches the
  keeper, and pipes stdio ↔ its local socket. The ssh process can die and be redialled; the CLIs live in the
  detached host;
- `<destination>` is whatever `ssh` accepts: `user@192.168.1.20`, a `~/.ssh/config` alias, or a Tailscale MagicDNS
  name. With Tailscale SSH (`tailscale up --ssh`, Linux/macOS boxes) there are no keys to manage and tailnet ACLs
  decide who may connect; on the LAN it's ordinary key auth. Either way the office keeps listening on localhost only
  and the box opens no new port;
- Windows' built-in OpenSSH client covers a Windows office; a Windows box needs the OpenSSH Server feature.

Later, if sshd on Windows boxes is too much friction: `cubefarm box --listen <addr>` with a pairing token and TLS
(pinned self-signed certificate, fingerprint shown when pairing), behind the same JSON-lines protocol. Not v1.

### 4. Fleet state and the start rule

```ts
// shared/types.ts
interface BoxView {
  id: string; name: string; destination: string;
  status: 'connecting' | 'online' | 'offline' | 'removing';
  platform?: string; clis: CliView[]; ghReady: boolean; running: number; error?: string;
}
// persisted floor
box: string;         // the floor's box: where its developers and QA testers work by default; '' = this machine
// persisted agent
box: string | null;  // the agent's own box, overriding the floor's; null = follow the floor
deskBox: string;     // where the current task's desk (worktree + CLI conversation) actually is
```

An agent's box is `a.box ?? floor.box`. New hires follow the floor, so a floor moves as one unless someone on it was
given a box of their own.

Snapshot gets `boxes`; a new `box` server event carries changes; REST: `POST /api/boxes` (name, destination),
`DELETE /api/boxes/:id`, `PATCH /api/agents/:id { box }` (`null`: follow the floor again),
`PATCH /api/repos/:id { box, everyone? }`. With `everyone: true` the whole floor moves to that box: the floor's box is
set and every override on the floor is cleared.

When the agent's **task starts** (new issue, QA run): if the agent's box (`a.box ?? floor.box`) is online and has the
agent's CLI, `deskBox` is set to that box; if it is offline or hasn't got that CLI, the agent waits ("waiting for <box>")
and the scheduler retries (offline is usually transient); if
it was removed, the agent falls back to the office machine with a log line. Everything inside a task (fix rounds,
follow-ups, `finishPushedWork`, typed prompts, reattach after a restart) uses `deskBox`, because the worktree,
unpushed commits and the CLI's conversation (`--resume`) are on that disk. Reassigning shows "moves to <box> after
this task".

Removing a box marks it `removing`: nothing new starts there, busy CLIs keep running and reporting, the office stays
connected until they exit, then drops the box. A developer's CLI idling at its prompt (`keepAlive`) on a removed
box is closed when that agent's next task starts elsewhere. If a task's `deskBox` is gone and the task needs another
session (a fix round), it starts fresh on the new machine from the pushed PR branch (`prepareDesk` with `base.pr`),
without resuming the conversation.

### 5. Per box, the manager sets up once

Node 24, git, `gh auth login` (agents push from the box), and each CLI signed in. The connect check (`info`) reports
what's missing in the box's card, like `cubefarm doctor`. Sign-ins can be done from the office: the agent's terminal
is streamed, and the existing "needs you to sign in" nudge already points the manager there.

Limits: floors pointed at a local-only folder (`setLocalPath`) and the research folder have no remote the box can
clone, so their agents stay on the office. The Agent SDK runtime stays local; boxes are terminal-runtime only.
Pacing (`pacing.ts`) is per CLI account; boxes signed into other accounts should get their own pacing state.

### 6. UI

Manager's console: a Fleet tab (boxes, status, CLIs, running count, add/remove), and per floor a box picker with a
"Move the whole floor" button (the floor's box, overrides cleared; it says how many agents finish their current task
first). Team tab: a box picker per developer and QA tester whose first entry is "Floor's box". In the building (not built yet): the box name on the desk's monitor; a small server rack in the lobby with one light per box would fit
the style.

## Demo parity and tests

`demo.ts` fakes boxes: adding one "connects" after a moment with fake CLIs, fake sessions on it are labelled with its
name, one demo box can be toggled offline. Pure, tested helpers: the start rule (`pickMachine(agent, boxes, task)`),
the removal drain, `box --stdio` argument building, version/handshake checks, and path handling for a box on another
OS.

## Phase 2 as built

- `cubefarm box --stdio --office <office id>` (`server/boxStdio.ts`) finds or starts the box's host in
  `~/.cubefarm-box/<office id>` (`SWARM_BOX_HOME` overrides) and bridges stdio to it. The bridge itself runs
  `boxOps.ts` (desks, session files, screenshots on its own disk) and starts prepared CLIs in the host, so each link
  runs the cubefarm on the box's disk then. The host is `ptyHost.ts` with a trailing `box`: only terminals and hooks;
  it answers every hook but `UserPromptSubmit` itself (`localHookAnswer`), queues them for the office, waits 6 hours
  for an office that went, and reports a hash of its own code (`keeperBuild`).
- The office side is `server/boxLink.ts` (`connectBox`): the ssh process (`fleet.boxCommand`), redialled with backoff
  after a drop, the box as a `Machine` and a `CliHost`. `SWARM_BOX_COMMAND` replaces the remote
  `npx -y cubefarm@<version> box` (a box that runs a checkout: `node <checkout>/bin/cubefarm.js box`).
- Persisted: `boxes` (with each box's last-reported workspaces folder and separator, so desk paths are known while it's
  offline), `officeId`, the floor's `box` and the agent's `box` / `deskBox`. The start rule is `fleet.startPlace`;
  `Swarm.prepare` applies it, `available()` keeps agents whose box is offline out of the queue, and an explicit
  assignment to one waits as a requested start. A fix round for the PR's own author stays on its desk's box.
- REST: `POST /api/boxes { name, destination }`, `DELETE /api/boxes/:id`, `PATCH /api/agents/:id { box }`,
  `PATCH /api/repos/:id { box, everyone? }`. The snapshot has `boxes`; `box` / `boxRemoved` events carry changes.
- A removed box leaves the list at once (agents on it follow their floor, floors on it go back to the office); its link
  stays open until the CLIs still running there end. In the demo, a box connects after a moment and one whose
  destination starts with `offline` never does.

## Following the office's version (#94)

When the office runs another commit than a box's cubefarm checkout (it updated, or the box is new), it updates the box
at once while its agents carry on (nothing new starts there meanwhile): the office runs
`ssh <destination> <box command> --update <office commit>` (`server/boxUpdate.ts`), which fast-forwards the box's
checkout by the launcher's rules (default branch, no local changes, never past the office), runs `npm install` when the
dependencies changed and rebuilds `dist-server/`, rolling back on failure. The office then redials the box once its
calls there have answered (`relink`): the new bridge runs the new build, and the host keeps its terminals. A box run
by npx only needs that relink when its cubefarm version differs. An office run from npm has no commit: a checkout box
on another version moves to the office's release instead (its tag `v<version>`, else the commit that set
`package.json` to it). Boxes report `commit` in their info, the one their link started on; one that doesn't (older)
is asked to update too, and a box refused for another protocol version is updated and its next link replaces the host.

Only when an update changed the host's own code (the bridge finds the host's reported `keeperBuild` differs from the
one on disk: `keeperStale` in its info) does the box drain: nothing new starts there while its agents finish, then the
office shuts the host down and redials it (its idle CLIs stop). A host from before the bridge ran the box's methods
counts as changed, so that happens once. A failure shows on the box's card and is tried again after 30 minutes, or at
once on Look again (`fleet.syncRetryDue`). Rules: `fleet.boxSync`; flow: `Swarm.syncBoxes`.

CLI detection and launch share `commandFor`: after PATH, they search `~/.local/bin`, `~/.bun/bin` and
`~/.npm-global/bin`, with `~/.opencode/bin` first for OpenCode. While a free agent waits for a missing CLI,
the scheduler asks the box for a fresh report at most every five minutes. Look again refreshes it immediately;
both use the existing link and resume scheduling after the report. Wait messages name the searched folders.

## Phases

1. `Machine` seam and `localMachine`, plan/launch split in `cliRunner` (no behaviour change; reviewable alone).
2. Box host and SSH transport, one box, assignment via REST.
3. Fleet state, events, console UI (the floor-wide box assignment included), demo boxes, removal drain.
4. Optional: `--listen` transport for boxes without sshd; per-account pacing.
