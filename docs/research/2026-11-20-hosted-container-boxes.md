# Hosted container boxes as a first-class worker type

Date: 2026-11-20 · Issue: #352 · Researcher: Humboldt · Checked against `main` at `5eda196` (cubefarm 0.3.19)

## The question

Cubefarm already runs agents on worker boxes reached over SSH (`server/boxLink.ts`, `server/boxStdio.ts`) and on
disposable Upstash Boxes (`server/upstashProvider.ts`). What would it take to support hosted, hardened container boxes
as a first-class worker type? The example is a Nisosa Agent Box: an unprivileged user, a read-only root filesystem, no
systemd, and access through an authenticated API tunnel instead of a published SSH port. The issue asks five things:

1. What the SSH worker contract assumes about the machine, and which assumptions a container box breaks or bends.
2. How the Upstash transport differs from SSH, and whether a hosted box should be an SSH destination with a proxy
   command or a provider of its own.
3. Version sync when the box's cubefarm is baked into a read-only image.
4. Where real CPU and memory limits should come from, given that `os.cpus()` and `os.totalmem()` report the host.
5. Which credentials reach the box today, and what a provider-style integration could keep off it.

## Summary

The box contract already works on a hardened container. This research session ran on one: a Nisosa Agent Box with
tini as PID 1, user `agent` (uid 1000), a read-only overlay root, a writable per-box home disk, and sshd running as
that user on port 2222 inside the container. It's reached over SSH, with the office's remote command pointed at a
cubefarm baked into `/opt/cubefarm-worker`. Nothing in the box path needs root or systemd. The keeper is a detached
Node process that tini reaps, and every file cubefarm writes is under `$HOME`.

The gaps are in how the office understands such a box:

- **Version sync doesn't account for a pinned image.** A baked image isn't a git checkout, so the box reports
  `commit: null`. `fleet.boxSync` then compares only `package.json` versions. Because the version stays `0.3.19`
  across many commits, the office can't tell when the box falls behind. After a version bump it tries `relink`
  instead, which can't succeed, so it fails and retries every 30 minutes.
- **Telemetry reads the whole machine.** `machineResources.ts` uses `os.cpus()`, `os.totalmem()`, `/proc/meminfo`
  and `/proc/pressure/*`, which describe the host (or VM), not the container's cgroup. On this box the cgroup limits
  roughly match the VM, so the numbers look right here. On a host packed with several boxes they would be wrong.
- **Each box keeps a long-lived personal GitHub token on its own disk.** This box holds a classic `gh` OAuth token
  with `repo`, `workflow`, `gist` and `read:org` scopes on its persistent home disk.

**Recommendation:** keep hosted boxes on the SSH path, reached through a `ProxyCommand` to the provider's
authenticated tunnel. Add a small "pinned image" notion to the box contract, sample cgroup v2 limits, and move GitHub
credentials to short-lived, repo-scoped tokens pushed per session. A provider adapter, like Upstash's, is only worth
building for lifecycle operations: create, replace the image, resize, delete and host-key discovery. It isn't needed
for the transport.

Confidence: high for anything tied to cubefarm code or measured on this box; medium for the cgroup and libuv details
(from primary docs and changelogs, not tested across kernels); low for anything about Nisosa beyond what this box
shows. I found no public Nisosa documentation (search on 2026-11-20).

## How this was checked

- I read the box path in the code: `fleet.ts`, `boxLink.ts`, `boxStdio.ts`, `boxOps.ts`, `boxUpdate.ts`,
  `ptyHost.ts`, `ptyProtocol.ts`, `cliFiles.ts`, `machineResources.ts`, `machineHealth.ts`, `upstash*.ts`,
  `swarm.ts` (`syncBoxes`, `moveBox`, the Upstash start rule), and also `docs/fleet-design.md`,
  `docs/remote-claude-auth.md` and `docs/configuration.md`.
- I inspected the box this session ran on, read-only, and printed no secrets. I looked at `/proc`, `/sys/fs/cgroup`,
  mounts, the process tree, `/etc/nisos/sshd_config`, `/usr/local/bin/entrypoint-cubefarm.sh`, `/opt/cubefarm-worker`,
  and `gh auth status` with the token redacted. I did not read `~/.cubefarm`, the office's config or the keeper's secret.
- I used primary docs for Node, libuv, the Linux cgroup v2 interface, OpenSSH, the GitHub CLI and GitHub tokens,
  Claude Code and Upstash Box, plus two GitHub issues. They are listed under Sources.

### What the Nisosa box looks like (observed 2026-11-20)

| Property | Observed |
| --- | --- |
| PID 1 | `/usr/bin/tini -- /usr/local/bin/entrypoint-cubefarm.sh` |
| User | `agent` uid/gid 1000, no root, `PermitRootLogin no` |
| Root filesystem | overlay mounted `ro` (`touch /usr/x` → "Read-only file system") |
| Home | `/var/lib/nisos/boxes/nisos-box-…-home.img` (ext4, 3.9 GB) on `/home/agent`, persistent |
| `/tmp` | tmpfs 256 MB, `noexec`; `TMPDIR=/home/agent/.tmp` |
| `~/.cache` | tmpfs 512 MB, `noexec`, not persistent |
| sshd | started by the entrypoint as `agent`: `-f /etc/nisos/sshd_config`, port 2222, key-only, `AllowUsers agent`, host key generated once into the home disk |
| Link | `SSH_CONNECTION=172.18.0.1 … 172.18.0.2 2222`: arrives from the container network's gateway, consistent with a tunnel that ends on the container host |
| cubefarm | `/opt/cubefarm-worker` (read-only, version 0.3.19, no `.git`), symlinked from `~/.local/share/cubefarm-worker`; the bridge runs `node ~/.local/share/cubefarm-worker/bin/cubefarm.js box --stdio --office …` (so the office sets `SWARM_BOX_COMMAND`) |
| Its build | its `server/*.ts` sources match `main` at `5eda196` byte for byte (the newest commit; checked against the last 60) |
| Tools | Node 24.11.1 (libuv 1.51.0), git 2.39.5, gh 2.23.0 (Debian, Feb 2023), Chromium + Xvfb + noVNC for the desktop |
| Limits | cgroup v2, `/proc/self/cgroup` = `0::/` (own namespace); `cpu.max` = `400000 100000` (4 CPUs); `memory.max` = 8 GiB; `pids.max` = 512 |
| What Node sees | `os.cpus().length` 4, `os.availableParallelism()` 4, `os.totalmem()` 7.57 GiB, `process.constrainedMemory()` 8 GiB, `process.availableMemory()` 6.2 GiB |
| Kernel | `hypervisor` flag in `/proc/cpuinfo`; the same 6.8.0 kernel as the environment reports, so a container on a VM, not a microVM per box |

## Findings

### 1. What the SSH worker contract assumes, and what a container box changes

| Assumption | Where | On a hardened container box |
| --- | --- | --- |
| **ssh reaches a login shell.** The remote command runs as `sh -c 'exec "${SHELL:-/bin/sh}" -l -c "$1"'` so Node from nvm or Homebrew is on PATH | `fleet.ts:80` (`loginShell`), `fleet.ts:113-121` (`sshBox`) | **Holds** when the box runs sshd (Nisosa does, as the unprivileged user). It breaks for API exec tunnels with no shell at all: Upstash avoids it by sending an exact argv with an explicit `PATH` (`upstashBridge.ts:10-16`). |
| **The remote command is `npx -y cubefarm@<office version> box`**, or one office-wide `SWARM_BOX_COMMAND` | `fleet.ts:115` | **Bends.** `npx` needs a writable npm cache and network access to npm. That works in a writable home, but defeats a pinned image. `SWARM_BOX_COMMAND` is global, so an office can't mix npx boxes with image boxes. |
| **A writable home.** Box home `~/.cubefarm-box/<office id>` (`SWARM_BOX_HOME`), the keeper's socket and secret, `sessions/`, `bin/` helper scripts, `workspaces/` clones and desks, plus the CLIs' own `~/.claude`, `~/.codex` and `~/.config/gh` | `boxStdio.ts:82-91`, `config.ts:14-15`, `cliFiles.ts:20-35` | **Holds** if the provider gives a persistent home. Two things bend: the home is small (3.9 GB here, holding every floor's clone, a worktree per desk and their `node_modules`), and `/tmp` and `~/.cache` are `noexec` tmpfs, so tools that run binaries from there fail. One example is a Playwright browser download to the default `~/.cache/ms-playwright`. The Unix socket path must stay under the 108-byte `sun_path` limit, which matters if a provider puts the home somewhere deep. |
| **A checkout at a fixed path to update.** `cubefarm box --update` fast-forwards the box's git checkout, runs `npm install` and rebuilds | `boxUpdate.ts:34-38`, `:84-130` | **Breaks.** A read-only image has no `.git` and can't be written, so `checkoutCommit` returns `null` and `updateBox` returns `{ ok: true, checkout: false }` without doing anything. See §3. |
| **A long-lived keeper** detached from ssh (`spawn(..., { detached: true })`), surviving link drops for 6 hours | `boxStdio.ts:58-63`, `ptyHost.ts:35` | **Holds, with an init.** The detached keeper is reparented to PID 1, so the container needs a reaping init (tini here, or `docker run --init`); systemd isn't needed and isn't used anywhere in the box path. **Bends** on container stop or restore: the keeper and its CLIs die, while desks and transcripts survive on the home disk. The next link's `ready.ptys` is empty, so followed terminals end (`boxLink.ts:176`, `ready()`) and sessions resume from transcripts, the same as when the office machine reboots. |
| **Hooks on `127.0.0.1:<keeper port>`** | `ptyHost.ts:304`, `boxStdio.ts:118` | **Holds.** It's all inside the container. |
| **`gh` signed in on the box** (agents push and open PRs from it); `info` checks `gh auth status` | `boxOps.ts:247`, `docs/fleet-design.md` §5 | **Holds, but stale and over-scoped.** Debian's gh 2.23.0 failed `gh issue view 352` on this box today with "Projects (classic) is being deprecated" (a GraphQL `projectCards` error; the same class of failure is reported in [5]). The token is a classic OAuth token; see §5. |
| **Telemetry from `os` and `/proc`**: `os.cpus()` times, `os.totalmem()`, `/proc/meminfo` `MemAvailable`, `/proc/pressure/{cpu,memory,io}`, `os.loadavg()` | `machineResources.ts:177-220`, `machineHealth.ts:227-264` | **Bends.** All of these describe the kernel's machine (the host, or the VM in this case), not the container's cgroup. See §4. |
| **Reboot status** from `/run/reboot-required` | `rebootStatus.ts:32` | **Meaningless** in a container: the image is updated by replacing it, not by rebooting. It just reports "no reboot needed". |
| **CLI first-run state already set up** | none: cubefarm passes `--settings` but never touches `~/.claude.json` | **Breaks on a fresh home.** Claude Code shows its theme picker and login gate until `~/.claude.json` has `hasCompletedOnboarding: true`, even when `CLAUDE_CODE_OAUTH_TOKEN` is set [6]. The first session for this issue stalled there. The manager has since set the flag on this box (confirmed: it's now `true`). |
| **CLI auto-update** | Claude Code is the SDK's bundled binary under the cubefarm install | **Bends.** Under `/opt` it can't update itself, which is fine and arguably right for a pinned image. Codex and OpenCode installed into `~/.local/bin` still can. |

Nothing in the contract needs a published SSH port. A destination is anything `ssh` accepts, including a
`~/.ssh/config` alias (`fleet.ts:68-70`), so a tunnel already works through `ProxyCommand`.

### 2. The Upstash transport compared with the SSH path

Both paths end in the same place: `boxStdio.js --stdio --office <id>` on the worker, speaking the same JSON-lines
protocol to `connectBox`. What differs is how the office gets there, who owns the machine's lifecycle, and which
credentials go along.

| | SSH box | Upstash Box |
| --- | --- | --- |
| How the link is made | `ssh -T -o BatchMode=yes … <destination> <login shell> <box command>` (`fleet.ts:113-121`) | A local Node process, `upstashBridge.ts`, opens a provider exec session over WebSocket with an exact argv and its own `PATH`/`SWARM_BOX_HOME` (`upstashBridge.ts:8-19`); passed to `connectBox` as `opts.transport` (`machine.ts:165-166`, `upstashProvider.ts:182-186`) |
| Lifetime | Long-lived, set up by the manager; floors and agents are assigned to it | One disposable Box per task, created by the office via the SDK, capped at 10 (`upstash.ts:10`), deleted only after a saved-work check (`upstash.ts`, `cleanup`) |
| Installing cubefarm | `npx cubefarm@<office version>`, or the box's checkout, kept in step by `--update` | Bootstrapped once per Box: `npm install cubefarm@<VERSION>` + Playwright + gh, then the office's own `dist-server/{boxStdio,boxOps,ptyHost,browser-init}.js` written over it (`upstashProvider.ts:47-78`, `:172-179`); a `ready-<VERSION>` marker stops it reinstalling (`:149`) |
| Version sync | `Swarm.syncBoxes` / `fleet.boxSync` (`swarm.ts:2454`, `fleet.ts:165-177`) | None needed: a Box lives for one task; `syncBoxes` only walks `state.boxes`, so Upstash tasks are never in it |
| CLI login | The box's own logins; Claude can use the office's token if opted in (§5) | API keys only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`; the subscription token is removed (`cliFiles.ts:134`) |
| GitHub | The box's own `gh auth login` | The office's own `gh auth token`, set as `GH_TOKEN` in the Box's environment at create time (`upstashProvider.ts:22`, `:160`) |
| Provider credential | none | `UPSTASH_BOX_API_KEY` stays in the office's bridge process (`upstashProvider.ts:185`) |
| Telemetry | `resources` RPC on the box | Same RPC, same host-view problem |

Upstash also offers plain SSH (`ssh <box-id>@us-east-1.box.upstash.com`, API key as password) [10]. Cubefarm chose the
SDK exec session instead. That keeps the API key off the command line and needs no host-key handling.

**Fit for a hosted, hardened box.** The Nisosa box is long-lived (persistent home disk, host key kept across pause,
stop and restore), runs sshd as the box user, and is reached by key. That is the Fleet box model, not the
Upstash task model. Making it "a provider of its own" in the Upstash sense would bring per-task create and delete, a
bootstrap that writes code into the box, and per-task API keys. A pinned image deliberately rejects the first two, and
the third is already handled better by SSH's per-destination Claude forwarding.

The SSH path also brings things a custom transport would need to rebuild:

- **Host-key pinning.** Claude token forwarding is refused unless the link is plain ssh (`!this.opts.transport`) with
  `StrictHostKeyChecking=yes` (`boxLink.ts:122-123`).
- **`--update` and other one-off commands.** `BoxLink.update` always builds an ssh command and ignores
  `opts.transport` (`boxLink.ts:237-259`). That doesn't matter for Upstash today, but it would for any transport box
  added to `state.boxes`.
- **Keepalives.** `ServerAliveInterval` is already set.

A `ProxyCommand` gives the tunnel without code changes. OpenSSH runs the command and talks SSH over its
stdin/stdout [8]. That's the same pattern as AWS Session Manager (`ProxyCommand … aws ssm start-session --document-name
AWS-StartSSHSession`) [11] and Coder (`coder config-ssh` writes host entries so workspaces need no open ports) [12].
The provider's tunnel credential stays in the office user's environment or the provider CLI's config, as Upstash's API
key does today.

**Answer:** use an SSH destination with a `ProxyCommand` for the link. Add a provider adapter later, and only for
lifecycle operations: create, replace image, resize, delete, and returning the box's host-key fingerprint so the office
can pin it before the first connection.

### 3. Version sync for a read-only image

What happens today with an image box (`fleet.ts:165-177`, `swarm.ts:2454-2533`):

| Situation | `boxSync` result | What the office does |
| --- | --- | --- |
| Office commit moves ahead, version unchanged (most merges: `package.json` is still 0.3.19) | `info.commit === null` → compare versions → equal → `null` | **Nothing, and it shows nothing.** The box runs older box code while the card looks in sync. |
| Office version bumped | `{ step: 'relink' }` (treated like npx) | Redials. The box still reports the old version, so `moveBox` throws "it still runs v0.3.19", the card says "Look again tries now", and it retries every 30 minutes (`BOX_SYNC_RETRY_MS`). Scheduling isn't blocked (`boxMoving` ignores `failed`), so work keeps starting there, which is good, but the advice is wrong. |
| `PTY_PROTOCOL` bumped | `refused` → `{ step: 'update' }` | `--update` returns `checkout: false`, the relink is still refused, and the box is unusable with a misleading message until someone rebuilds the image. |

Today the image happens to match `main` (`5eda196`), so none of this has bitten yet.

What the office should do:

1. **Have the box say that it's pinned.** Add `install: 'checkout' | 'npx' | 'image'` and `build: <commit>` to
   `BoxInfo`. The image records its commit at build time, for example in `<install>/build.json`, written by whoever
   builds the image. `boxOps.info` reads it when there's no checkout.
2. **Never try to update a pinned box.** `boxSync` returns a new `'pinned'` outcome: no `--update`, no relink loop, no
   30-minute retry toast.
3. **Gate on compatibility, not on equality.** The office and box share three contracts: `PTY_PROTOCOL` (the keeper
   protocol), the `boxOps` method set and arguments, and the session files and command lines that `cliFiles.ts`
   writes on the box from an office-built `CliPlan`. Add one `BOX_API` integer, bumped whenever the last two change.
   Then:
   - **compatible, but behind:** keep scheduling. The card says "Pinned image `abc1234`, office at `5eda196` (N
     commits ahead)", and the office logs it once.
   - **incompatible:** treat it like offline for new tasks (`startPlace` → `wait`, as with a missing CLI). Let running
     tasks finish. Show "This box's image is too old for this office: rebuild or replace it."
4. **Replace, don't update.** With a provider adapter, "Replace image" drains the box the way `restart` already does
   (`fleet.boxSync` → `draining`), asks the provider to recreate the container from the image tagged with the office's
   commit (the home disk stays), and redials. Without an adapter, it's a manual step and the card tells the manager
   what to do.

Another option exists: overwrite the code from the office, as Upstash does. The entrypoint only creates the
`~/.local/share/cubefarm-worker` symlink if it's missing, so the office could replace it with a writable copy in the
home directory. That works mechanically, since agents already run arbitrary commands there, so it doesn't widen trust
much. But it defeats the point of pinning the worker in a read-only image, and it needs a matching `node_modules` with
native `node-pty`. I don't recommend it as the default.

### 4. Real capacity inside a container

What the current reader uses, and what it actually measures:

- `os.cpus()` is the kernel's online CPUs, and its `times` are machine-wide, so `cpuPercent` is the host's (or VM's)
  CPU use, not the box's. Node's own docs say not to use `os.cpus().length` for parallelism [1].
- `os.totalmem()` and `/proc/meminfo` `MemAvailable` are machine-wide (unless the provider runs LXCFS).
- `/proc/pressure/*` is system-wide PSI. Neighbouring containers' stalls count, and the box's own throttling under
  `cpu.max` is hidden.
- `os.loadavg()` is system-wide too, so `load1 > cpus × 1.1` (`machineHealth.ts:236`) compares the host's queue with
  whichever CPU count was sampled.

On this box the error is small because the cgroup is sized close to its VM (4 CPUs; 8 GiB `memory.max` against
7.57 GiB of RAM), and it may be the only box on that VM, though I couldn't verify that. On a host packed with boxes
the numbers would describe the host.

Where the real limits are (cgroup v2 [3]). The box reads them from its own cgroup: the path after `0::` in
`/proc/self/cgroup`, under `/sys/fs/cgroup`.

| Need | Source |
| --- | --- |
| CPU limit | `cpu.max` (`$MAX $PERIOD`; `max` = no limit) → MAX/PERIOD CPUs. `os.availableParallelism()` already includes it: libuv 1.49.0 fixed "uv_available_parallelism using cgroup" [4], and 1.52.0 handles `cpu.max` below one CPU; Node 24.11 ships libuv 1.51.0. It returned 4 here [1][4]. |
| CPU use and throttling | `cpu.stat`: `usage_usec` delta ÷ (limit × interval) gives use against the box's own limit; `nr_throttled` / `throttled_usec` show hitting the quota. That's the direct "needs more CPU" signal for a container. |
| Memory limit | `memory.max` (hard, OOM above it) and `memory.high` (throttling); `process.constrainedMemory()` returns the cgroup limit (8 GiB here) and `process.availableMemory()` takes the limit into account; both Stable since Node 24.0 / 22.16 [2][4] |
| Memory headroom and kills | `memory.current`; `memory.events` `oom_kill` and `high` counters |
| Pressure | the cgroup's own `cpu.pressure`, `memory.pressure`, `io.pressure` (same format as `/proc/pressure/*`, so `pressureAverage` parses it) |
| Process limit | `pids.max` / `pids.current`. **512 here**, which Chromium + Playwright MCP + a CLI + a test runner can reach. |
| Disk | `statfs` on the box home (3.9 GB here). Not sampled today, yet it's the likeliest limit for many desks. |
| What's declared and whether it can resize | The provider's API (plan size, resizable or not), once there's an adapter. Today the manager sets it per box (`setMachineCapacity`), and `docs/fleet-design.md` rules that capacity is never inferred from a name or provider. A provider declaration would be an explicit source, not an inference. |

Recommended reading rule: effective CPUs = min(online CPUs, `cpu.max` quota) (or just `os.availableParallelism()`);
memory total = min(`os.totalmem()`, `memory.max`); prefer cgroup PSI over system PSI when it exists; add pids and disk.
Fall back to today's readings when there's no cgroup v2 (cgroup v1 hosts, macOS, Windows). Label the source on the
card so "host view" and "box limits" are never confused.

### 5. Credentials: what reaches the box today

**SSH box (Nisosa today):**

| Credential | How it gets there | Where it lives on the box |
| --- | --- | --- |
| GitHub | Manager runs `gh auth login` on the box once (`docs/fleet-design.md` §5) | `~/.config/gh/hosts.yml` on the persistent home disk. **This box:** user `mgscox`, a classic OAuth token, scopes `gist, read:org, repo, workflow`. It can push to every repo that account can reach and edit workflows, it doesn't expire, and it sits in a disk image on the provider's host (`/var/lib/nisos/boxes/…-home.img`). |
| Claude (forwarded) | Only if the exact destination is in `CUBEFARM_CLAUDE_AUTH_BOXES`, the link is plain ssh with `StrictHostKeyChecking=yes`, and the bridge says `officeClaudeAuth` (`boxLink.ts:87-89`, `:122-123`, `:387-393`, `boxStdio.ts:126`). The office's `CLAUDE_CODE_OAUTH_TOKEN` goes as an argument of the `prepare` RPC. | Only in the CLI's process environment (`cliFiles.ts:127`, then the keeper's `spawn`); cubefarm doesn't write it to disk. Any same-uid process on the box can read it from `/proc/<pid>/environ`, and that includes the agent's own tool calls. |
| Claude (box's own) | `claude` login on the box | `~/.claude/` on the home disk |
| Codex / OpenCode | The box's own logins | `~/.codex`, OpenCode config |
| Keeper secret | Generated on the box (`boxStdio.ts:87`) | `~/.cubefarm-box/<office>/pty.secret`, mode 0600 |
| What doesn't go | The office config file, the Upstash key, Telegram, the manager MCP token, the CEO's office MCP (CEO stays on the office) | — |

I didn't inspect process environments, so I can't say whether forwarding is turned on for this box.

**Upstash Box:** the office's own `gh auth token` (the manager's full GitHub credential) and the selected CLI's API key
are put in the Box environment at create time, so the provider stores them as Box config. The Upstash API key stays in
the office.

**What a provider-style integration could keep off the box:**

1. **Long-lived GitHub credentials.** The office could mint a GitHub App installation token per session. These expire
   after one hour, can be limited to listed repositories (up to 500) and to chosen permissions [9]. For an agent that
   would be `contents: write`, `pull_requests: write`, `issues: read`, for the floor's repo only. It would be passed
   the same way as the Claude token: `GH_TOKEN` in the CLI's environment, which `gh` prefers over stored credentials
   [7]. Sessions can run past an hour, so refresh needs a git credential helper in `BIN_DIR` that asks the office for a
   fresh token through the keeper's hook relay. That relay already carries box-to-office requests. Without a GitHub
   App, a smaller step is a fine-grained PAT per box: one owner, chosen repos, an expiry. Its known gaps (no Checks
   API, no multi-org, no outside-collaborator repos [13]) don't affect what agents do on a box, because check runs are
   read on the office side.
2. **The provider's API credential.** Keep it in the office or the `ProxyCommand`'s environment, as Upstash does now.
3. **The Claude subscription token.** This can't be scoped down. Keep forwarding opt-in per destination as now.
   Prefer it over a box-side `claude login`, because a token forwarded per session never lands on the box's disk,
   though it's still readable in `/proc` while the session runs.
4. **Host identity.** The provider API should return the box's host-key fingerprint at create time, so the office can
   write `known_hosts` and keep `StrictHostKeyChecking=yes` through the tunnel. The Nisosa entrypoint already
   generates one key per box and keeps it on the home disk, which makes this possible.

## Recommendation

1. **Transport:** treat a hosted container box as an ordinary Fleet box whose destination is a `~/.ssh/config` alias
   with `ProxyCommand <provider tunnel> %h`. This works today; document it.
2. **Make the remote command per box.** Store the box command with each box instead of the office-wide
   `SWARM_BOX_COMMAND`, so image boxes and npx or checkout boxes can share an office.
3. **Pinned images:** add `install` and `build` to `BoxInfo`, a `'pinned'` outcome in `boxSync`, and a `BOX_API`
   compatibility gate (§3). Behind but compatible means a warning only. Incompatible means no new work and a clear
   "rebuild or replace the image" message.
4. **Capacity:** sample cgroup v2 (`cpu.max`, `cpu.stat`, `memory.max`/`high`/`current`/`events`, cgroup PSI,
   `pids.max`) plus disk free, and label the source (§4).
5. **Box readiness:** `info` should also report whether Claude Code's first-run setup is done, whether `TMPDIR` is
   writable and allows exec, free disk, and the `gh` version. Show a missing item on the card the way `ghReady` is shown.
   Seeding `hasCompletedOnboarding` belongs to whoever builds the box. For Nisosa that's the image entrypoint;
   cubefarm should detect it, not silently write to the user's `~/.claude.json`.
6. **Credentials:** short term, use a fine-grained PAT per box limited to its floors' repos, with an expiry, and
   document it in the fleet design. Longer term, per-session GitHub App tokens pushed like the Claude token (§5).
7. **Provider adapter:** build it only when the provider publishes an API for create, replace-image, resize, delete and
   host key. Model it on `UpstashProvider`'s durable reservation pattern, but for long-lived boxes.

Assumptions: the box this session ran on is representative of a "Nisosa Agent Box" (its paths say `nisos`). Nisosa
publishes no API docs I could find, so the adapter in recommendation 7 is a placeholder.

## Open questions

- Does Nisosa run one box per VM or pack several per VM? That decides how wrong the current telemetry is in practice.
- Does Nisosa's "pause" freeze the cgroup (the keeper survives) or stop the container (the keeper and its CLIs die)?
- Does the tunnel expose the box's host key, or must the first connection trust on first use?
- Does Nisosa offer image tags per commit, so "replace with the office's build" can be automated?
- Is the image builder willing to write `build.json` (the commit) into the image?

## Issues to file

1. **Report how a box runs cubefarm and stop update loops on pinned images** (server)
   - `BoxInfo` gains `install: 'checkout' | 'npx' | 'image'` and `build` (commit or null); `boxOps.info` reads an image's
     build stamp when there's no checkout.
   - `fleet.boxSync` returns a pinned outcome for `install: 'image'`: no `--update`, no relink, no 30-minute retry toast.
   - The box card says "Pinned image `<sha>`, office at `<sha>`".
   - Unit tests in `fleet.test.ts` for each row of the table in §3; demo parity with one fake pinned box in `demo.ts`.
2. **Gate boxes on a box API version, not on equality** (server)
   - A `BOX_API` constant shared by `boxOps` and the office, bumped when box methods or session file formats change,
     and reported in `ready` or `info`.
   - An incompatible box is skipped for new tasks with a "rebuild or replace its image" reason; running tasks finish.
   - Tests for compatible-behind, incompatible and older-box cases.
3. **Per-box remote command** (server + frontend)
   - `PersistedBox` gains an optional `command`; `POST /api/boxes` and the Fleet add-box form accept it;
     `SWARM_BOX_COMMAND` stays as the default.
   - `fleet.boxCommand` and `boxUpdateCommand` use the box's own command; `validDestination`-style validation (no
     newlines, bounded length).
   - Tests in `fleet.test.ts`.
4. **Sample container limits from cgroup v2** (server)
   - `createResourceReader` reads the process's cgroup (`/proc/self/cgroup`), then `cpu.max`, `cpu.stat`,
     `memory.max`/`high`/`current`/`events`, `{cpu,memory,io}.pressure` and `pids.max`/`current`, plus home-disk
     free space.
   - `MachineSample` carries the effective limits and their source. `machineHealth` uses cgroup PSI and throttling
     when present and falls back to today's readings otherwise.
   - Pure parser tests with fixture files, for a container with limits and a host with `max`.
5. **Box readiness checks for hosted boxes** (server)
   - `info` reports Claude first-run state (`hasCompletedOnboarding` in `~/.claude.json`, or under `CLAUDE_CONFIG_DIR`),
     whether `TMPDIR` is exec-capable, free disk and the `gh` version. The box card shows what's missing.
   - Nothing is written to the user's CLI config.
6. **Scope GitHub credentials on boxes** (server; design first)
   - Document a fine-grained PAT per box (owner, repos, expiry) in `docs/fleet-design.md` §5.
   - Design note for per-session GitHub App installation tokens passed as `GH_TOKEN`, with a credential helper that
     refreshes through the keeper's hook relay. Covers SSH boxes and Upstash, where today's `GH_TOKEN` is the office's
     own token.
7. **`BoxLink.update` ignores the box's transport** (server)
   - `update()` uses `opts.transport` when set (or refuses clearly) instead of building an ssh command.
   - Test with a fake transport.

## Sources

1. Node.js `os` module docs: `os.availableParallelism()` (added v19.4.0/v18.14.0), `os.cpus()` note. https://nodejs.org/api/os.html (read 2026-11-20)
2. Node.js `process` docs: `process.constrainedMemory()`, `process.availableMemory()`, both Stable since v24.0.0/v22.16.0. https://nodejs.org/api/process.html (read 2026-11-20)
3. Linux kernel, Control Group v2: `cpu.max`, `cpu.stat`, `memory.max`/`high`/`current`/`events`, pressure files. https://docs.kernel.org/admin-guide/cgroup-v2.html (read 2026-11-20)
4. libuv ChangeLog: 1.45.0 (2023-05-19) cgroup v2 in `uv_get_constrained_memory`; 1.49.0 (2024-09-25) "fix uv_available_parallelism using cgroup"; 1.52.0 (2026-02-11) `cpu.max` with limit < period. https://raw.githubusercontent.com/libuv/libuv/v1.x/ChangeLog and https://docs.libuv.org/en/v1.x/misc.html (read 2026-11-20)
5. cli/cli issue #11983, "gh pr edit fails with Projects (classic) deprecation error" (opened 2025-10-21; reports on 2.45–2.82). https://github.com/cli/cli/issues/11983 (read 2026-11-20)
6. anthropics/claude-code issue #8938, "claude setup-token/CLAUDE_CODE_OAUTH_TOKEN is not enough to authenticate claude" (opened 2025-10-04, open; workaround `hasCompletedOnboarding: true`). https://github.com/anthropics/claude-code/issues/8938. Related: #46259. https://github.com/anthropics/claude-code/issues/46259 (read 2026-11-20)
7. GitHub CLI manual, environment: `GH_TOKEN` takes precedence over stored credentials. https://cli.github.com/manual/gh_help_environment (read 2026-11-20)
8. OpenBSD `ssh_config(5)`: `ProxyCommand` reads stdin and writes stdout; `%h`/`%p`. https://man.openbsd.org/ssh_config (read 2026-11-20)
9. GitHub Docs, generating an installation access token: one-hour expiry; `repositories`/`repository_ids` (up to 500) and `permissions`. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app (read 2026-11-20)
10. Upstash Box, getting started: API, SSH (`ssh <box-id>@us-east-1.box.upstash.com`) and agent interfaces; `/workspace/home`. https://upstash.com/docs/box/overall/getstarted (read 2026-11-20)
11. AWS Systems Manager, allowing SSH connections through Session Manager (`ProxyCommand` with `AWS-StartSSHSession`). https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html (read 2026-11-20)
12. Coder, workspace access: `coder config-ssh`, no open ports on workspaces. https://coder.com/docs/user-guides/workspace-access (read 2026-11-20)
13. GitHub Docs, managing personal access tokens: fine-grained token scope and limitations. https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens (read 2026-11-20)
14. Claude Code docs, development containers: `~/.claude` and `~/.claude.json` persistence, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER`, short-lived or repo-scoped tokens. https://code.claude.com/docs/en/devcontainer (read 2026-11-20)
