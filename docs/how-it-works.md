# How cubefarm works

The details behind the office: how an issue becomes a merged pull request, who does what, and what agents are allowed to do on your machine. For getting started, see the [README](../README.md).

## How an issue flows through the office

1. **Backlog and To do.** Issues labeled `needs-triage` wait in **Backlog**. Remove the label when the issue is ready. You can assign issues from **To do**, the terminal panel or the manager's console, or let the floor's **auto-assign** pick eligible work.
   - An issue that says `Depends on #N` waits until #N is closed. Of the rest, the ones that hold up the longest chain of other issues go first, then the oldest.
   - An issue published from an approved Idea also waits for the prerequisites its approved plan names, on any floor, and neither auto-assign nor a manual start can override that. Each sync reads them back from GitHub; one counts only once it is closed as completed. An unreadable, missing or not-planned prerequisite keeps the issue waiting, and its note says which one. A Tracking Parent never starts.
   - A parent issue never starts. Once all its sub-issues are done, the next sync closes it as completed with a comment, on every floor and even with `ready-for-human`. It stays open while a PR closes it or a session works on it, or if it has the `keep-open` label. If you reopen it, it stays open until its sub-issue count changes.
   - A `swarm:<specialty>` label is a preference, not a lock. A free specialist gets first pick, and otherwise the issue goes to whichever free developer is least needed for their own specialty.
   - If a session fails, its issue goes back on the board for someone else, and the agent gets new work after a two-minute cooldown. An issue that fails twice waits for you to assign it by hand.
   - If Claude turns a session away because your usage limit is reached, the office starts no new work until the limit resets.
   - Before that, when Claude warns that usage is getting high, the office paces itself until the window resets (an hour if Claude doesn't say): QA, fixes and CEO jobs start as usual, but new issues only start while fewer sessions than **Sessions while pacing** (manager's console → Settings, default 3) are running. Your phone gets a message when pacing starts and when it ends.
2. **In progress.** The server fetches the repo and creates a git worktree for that developer on the branch `swarm/issue-<n>-<agent>`, branched from the default branch. The developer's coding agent starts there with the issue text. The developer implements the change, runs the project's checks, pushes the branch and opens a PR with `gh pr create` that says `Closes #<n>`.
3. **In QA.** The PR is handed to the floor's QA lab. A free QA tester checks out the PR head in their own worktree; when every tester is busy, a free developer who didn't write the PR covers for them, `testing` specialists first. The tester then:
   - reads the PR, the linked issue, and any `CUBEBASE_QA.md` in the repository root at the PR base, then states the blast radius and evidence needed before checking CI. Changes to the guidance take effect once they reach the target branch.
   - may apply current inline suggestions it independently agrees with when that base guidance explicitly opts QA in. Only the configured reviewer's suggestions on an open, in-repository PR head qualify. QA commits only those edits after verifying the original head, then stops; the office queues full QA for the resulting commit without a developer hand-back. Security audits and fork PRs stay read-only. See the [QA playbook](specialisms/qa.md#opted-in-inline-suggestions) for the opt-in and revision checks.
   - reviews the diff like a code reviewer: bugs, unhandled errors and edge cases, security problems, leftover debug code, missing tests
   - uses trusted, successful CI results for the assigned PR head for checks those jobs cover
   - names the coverage gap before running each extra check, including browser checks where the affected behavior or QA brief calls for them
   - follows the repository's automated review instructions when specified, such as waiting for CodeRabbit on the assigned commit. By default, QA checks for unresolved Codex P1 and P2 findings on the assigned commit at each stage. A confirmed blocker goes back for repair. A confirmed non-blocking fix is queued for a separate developer PR after the original merges.
   - returns a structured report: a verdict, the checks performed, the commands run, and a caption for each screenshot
4. **Evidence on the PR.** The server uploads the screenshots to an orphan branch called `swarm-qa-evidence`, so evidence never lands in your code, and posts a comment on the PR. The comment contains the verdict, a table of checks, the commands run, and the screenshots.
   - **QA history** on the floor's Kanban retains each attempt after its active card is removed: cycle, reviewer, tested base/head, original checks, finding IDs, exact-commit CI identifiers and conclusions, and a fresh worker observation of at most one minute when available. Missing signals remain unknown. Worker, code and inconclusive findings are kept separately, including mixed reports. This history stays local in the office state; raw transcripts and screenshots are not copied into it.
   - Legacy score penalties require a confirmed code finding with evidence identifying a verified contribution SHA. Worker-only, inconclusive, stale and unattributed results are neutral. A retry of the same finding on the same revision does not charge again. QA can supply `findingKey`, `confirmed` and `introducedBySha` in its check report; these fields do not change merge or retry decisions. The manager can append a classification correction with a reason in QA history; the original evidence remains visible. A correction that removes the last eligible finding refunds that outcome's legacy penalty.
   - A finding that recurs on more than one PR can become a reviewed **lesson** for later work ([lessons](lessons.md)).
   - **Authorship and Repair** replace the combined score badge in the Team tab and terminal header. Each shows its points and sample count (`Authorship +1 · 2 events`); the old combined total stays beside them, labelled **Legacy**, and automatic assignment still ranks by it for now. Authorship gives +2 once when a PR merges, to the developer the office verified as its original author, and -1 at most once per PR for a confirmed defect QA attributes to that original submission. Repair gives +1 at most once per developer per PR when a later QA, by someone else and on the repair's own revision, verifies the fix to another developer's confirmed defect, and -1 once per submitted repair for a confirmed new defect it introduced. Handing a PR to a repairer never moves the merge award or the inherited defect. Self-repairs, no-op handoffs, conflict reconciliations, repeated unresolved defects, worker or inconclusive results, stale evidence and unknown attribution are recorded with no score change.
   - The scores are projected from a versioned, append-only ledger in the office state. Each event's identity comes from its evidence, so retries, restarts, repeated syncs and reopened PRs never count twice. When a finding correction or a moved revision changes what the evidence supports, a linked correction voids or restores the event; nothing is rewritten. **Score events** on the floor's Kanban lists every event with its reason, revision and evidence. An office that existed before the ledger starts both scores at zero and scores only contributions and QA recorded from then on.
5. **Fail → fix → re-test.** If QA fails, the report goes back to the developer who wrote the PR, who resumes their own session and pushes fixes to the same branch. If they're busy on something else, any free developer takes the fix instead. QA groups blockers by root cause and gives each finding an ID. Later reports use those IDs to say what is still open or resolved.
   - From the third QA round, QA can review the changes since the previous review when the earlier code review was complete, the branch continues from the reviewed commit, and the merge base is the same. QA still verifies open findings, runs the applicable checks, and screens the full PR for security before sign-off. If the approach changed or the comparison cannot be verified, QA reviews the full PR.
   - After 3 failed rounds, Cubefarm flags the PR **needs you** and asks for a reconsidered approach before retrying QA. This also applies when the PR has a merge conflict.
   - When QA reports only worker environment limits (such as memory exhaustion), with no known or suspected code defect, the office records the incomplete local checks as skipped and continues toward automatic merge. GitHub checks must pass for the reviewed commit, with at least one successful check; missing, skipped or neutral checks alone do not count. Real or unexplained failures still go back for fixes, and detailed security review keeps its own gate.
6. **Review and merge.** A QA-passed PR labeled `needs-review` waits in **Review**. Remove the label on GitHub after approval. Other QA-passed PRs move directly to **Ready to merge**. With **auto-merge** on for the floor (the default), the office takes it from there.
   - When QA requests detailed security review, the office adds `ready-for-review` and queues a fresh session on a QA desk with the security playbook. The label can also request that review directly. The specialist assesses affected trust boundaries and can use CI results for the assigned head for checks they cover. CubeFarm clears the label after a complete passing audit of the current PR revision. A blocking finding goes back for fixes, and an incomplete audit keeps the merge held for follow-up. If the base changes before CubeFarm submits the merge, a developer reconciles the PR with the latest base and pushes it back through QA and security review. Closing and reopening the PR requires fresh QA and a fresh audit. GitHub pins the head in its merge API. Enforcing an up-to-date base inside that call requires GitHub branch protection.
   - The office advances one merge at a time per floor. If the target branch advanced after a PR passed CI, the office rebases the approved head on GitHub, verifies the resulting tree for the exact original head and current target, and waits for fresh CI. When GitHub's test merge is missing or has stale parents, the office computes that tree locally using Git 2.38 or later. The original QA sign-off carries through a verified rebase. Other new commits go back through QA first.
   - If checks fail, or the PR conflicts with the default branch because other work merged first, a free developer gets the failing checks or the conflict, fixes the branch, and QA re-tests it when the code changed. After 3 such fixes it's flagged **needs you**.
   - The office prefers rebase merge for a rebased candidate and squash for an already-current PR. Enable required CI checks and **Require branches to be up to date before merging** for the target branch, with bypass disabled for the office's credentials. This makes GitHub reject a merge if the base moves between the office's final check and the merge request.
   - If GitHub refuses the merge (say, branch protection wants an approving review), your phone gets a message and the office retries every 10 minutes. Checks still running after 30 minutes also get a message.
   - Only `swarm/` branches merge themselves. PRs people opened are left for you.

   With auto-merge off, review the PR on GitHub, including the QA comment, then press **Merge** (squash) on the board. Merging a PR that hasn't passed QA asks you to confirm first. Either way, the developer sees the merge, celebrates, and goes back to the backlog.
7. **Your folder catches up.** After any merge, the floor's folder fast-forwards to the default branch, but only when it's on that branch with no local changes. Nothing is ever stashed, reset or discarded; otherwise the manager's console shows why it wasn't updated (`2 behind: local changes`, `on branch feature-x`, `diverged`). If `package.json` or the lockfile changed, it runs `npm install`. **Sync now** in the manager's console retries.

   The office's own folder is the exception: pulling it would restart the office mid-work, so it shows `update ready` and the **Office** row at the top of the manager's console takes over. When the office was started by its launcher (`npm run dev` / `npm start`) and **Update automatically** is on, or you press **Update now**, the office drains: it starts no new issues, QA or CEO jobs, and lets the running sessions finish. Once nothing runs (or after 20 minutes, when the remaining sessions are stopped and their work goes back to the queue), it hands the update to the launcher, which pulls, installs, builds and restarts it; your phone then says which commit it moved to, or why the update was rolled back. **Later** postpones it for 2 hours, or until a newer commit lands. Started any other way, the office only reports the update.

PRs opened by people, not agents, show up under **In QA** as "not tested yet", with a **Send to QA** button.

**Blocked** shows issues and PRs labeled `needs-human`, as well as PRs the QA pipeline has escalated. After intervening, remove the label on GitHub or use **Retry QA** for an escalated PR.

You can message an agent at any time. While they're working, the message is injected into their live session. After a developer finishes, the message resumes their session, e.g. "the CI failed, please fix the lint errors".

## Pasting images

Paste a clipboard image into a message, Idea, issue description, feedback or brief. CubeFarm saves it in
`<SWARM_HOME>/attachments/images` and inserts an HTTP link at the cursor. PNG, JPEG, GIF and WebP images up to
8 MB each are supported. Wait for the upload to finish before sending; failed uploads leave the surrounding text intact.

Images stay outside Git history and survive office restarts. When a prompt references one, the agent receives the
path to a readable copy on its own machine. For remote agents the office sends the bytes over its existing SSH link,
so the box does not need access to the browser's URL or the office's filesystem. Pasting directly into a live terminal
also prepares the copy before inserting the link and path; it does not press Enter for you.

Back up the attachments directory with the office state. Images have no automatic expiry, including uploads removed
from an unsent draft. Links are served by this office; they are not public GitHub attachments for outside readers.

## QA testers

- Every floor always has at least one QA tester: one is hired when a repo is connected, and the last one can't be let go. You can hire up to 3 per floor (manager's console → Team, or press `E` on an empty QA station).
- QA testers use the same model and effort settings as everyone else. Their instructions allow only the opted-in inline suggestion pushes described above. They leave comments, GitHub reviews, merges and PR or issue edits to the office, which posts their report for them.
- QA is automatic for every PR from a `swarm/` branch, whether or not auto-assign is on, except research docs (`swarm/research-` branches): there's nothing to test, so they count as passed and merge like any other PR once GitHub's checks are green.

## Prototypes

Choose **Prototype** when filing an issue, or label a GitHub issue `swarm:prototype`. Set a developer's specialty to `prototype` to give them first pick of this work. The desk uses the Prototype Developer playbook and the bundled Pocock prototype skill.

The experiment stays on its own branch. Its draft PR appears in **Blocked** with **Preview**, **Send back…**, and **Approve for implementation…**. The PR must explain the question, how to run and review the experiment, what it showed, and what remains uncertain, with screenshots of the important states. Send back provides feedback on the same draft. Approval records the reviewed commit, replaces the issue's prototype brief with the implementation scope and acceptance criteria, and releases the issue to regular scheduling. Implementation gets its own branch and PR and follows the normal QA workflow.

## Researchers

- Researchers do web research (Claude Code's WebSearch and WebFetch) and write it up as Markdown docs: the question, the answer first, findings, recommendations, open questions and numbered sources. They always run Claude Code, and they never change code.
- **The lobby researcher** is always there, at the desk by the lobby's east windows, and works for the whole company from a queue of briefs: the CEO's `request_research` tool, or yours (press `E` at their desk; the first line of a brief is its topic). Company research goes by pull request into `docs/research/company/` in the signed-in GitHub account's `cubebase` repository, which the CEO reads. Create a private `cubebase` repository with an initial commit to enable company briefs. The manager can merge these pull requests in GitHub. A brief for a floor goes into that repo's `docs/research/` by pull request instead.
- **Floor researchers** sit at free developer desks (they share the floor's 12 desks with developers). Hire them in the manager's console → Team, or the CEO proposes them. They take issues labelled `swarm:research`, and nothing else; developers never get those issues automatically. Their docs go into `docs/research/` by pull request, which closes the issue.
- New research waits while Claude's usage is pacing or paused, like new issues.

## Ideas

Submit a description in the manager's **Ideas** tab. Research starts automatically when the office is open and a session slot is available. The lobby researcher leads one PRD, can ask configured floor researchers or specialists for focused evidence, and treats floor hints as context. Research respects office closure and usage pacing.

A material question appears as **Needs clarification** on the Idea. Reply there to resume. Research errors include a retry action. The completed **PRD ready** record contains linked evidence, assumptions, target-floor rationale and measurable acceptance criteria. **View PRD revision** links to that saved revision for later planning and review. Research itself creates no implementation issues.

The lead drafts an Issue Plan from the saved PRD. Two other agents review the exact pair independently. Joint endorsement promotes it immediately; otherwise the lead revises for up to three rounds, then the manager sees the latest pair with remaining findings. The approval card’s **View PRD** opens that paired revision. One approval publishes the displayed graph, with duplicate decisions, partial writes and restarts reconciled by the publisher. Substantive refinement starts fresh reviews; cosmetic changes can return directly for a new decision. Rejection archives the Idea without implementation issues.

Demo research uses fixed illustrative evidence. Include `[clarify]` to exercise the question/reply path, `[cross-floor]` for a two-floor graph, or `[disagree]` for three rounds with findings. A description alone reaches the approval card without fixture buttons. With no configured floors, research asks the manager to configure one before continuing. See [verification evidence and limits](ideas-verification.md).

## The team

Agents get names from a pool of computing pioneers (developers), fictional detectives (QA testers) and scientists (researchers). Each character's look is picked from their name, so Ada, Grace and Marple are drawn with long hair, a ponytail or a bun. You can change any agent's name or look in the manager's console → Team.

## Models and usage

- Developers and QA default to **Claude Code with Claude Opus 5.5 (`claude-opus-5-5`) at medium effort**. In the manager's console, Settings sets the default coding agent, its model and the effort; the Team tab overrides any of them per agent. The default model belongs to the default coding agent: an agent on another one uses that agent's own default unless you name a model for them. The CEO runs Claude Code, with its own model and effort on the CEO tab.
- Agents run on your Claude **subscription**: the server removes `ANTHROPIC_API_KEY` and all other inherited `CLAUDE_*` / `ANTHROPIC_*` variables before starting each agent, so Claude Code uses your login. Codex and OpenCode agents use whatever those CLIs are signed in with, and don't count toward Claude's usage pacing.
- Every agent draws on the same subscription usage limits. By default every agent with work runs at once; set a **Session limit** in the manager's console to cap it. When a limit is hit, the agent's terminal shows it.

## Agents' terminals

By default (manager's console → Settings → **How agents run: Real terminals**) every agent is the actual coding CLI running in its own pseudo-terminal on your machine. Open a desk to watch it live; click the terminal to type into it (while it has focus, `Esc` goes to the agent, which interrupts its turn: the office then counts the agent as stopped, the way the Stop button does, and what you type next at its prompt is a follow-up). The office keeps a copy of each agent's screen and scrollback, so a terminal opened late shows everything so far, and it's saved to `<SWARM_HOME>/terminals/` so it survives a restart. The message box under the terminal types into it for you, or, when the agent isn't running, resumes their session.

- **Claude Code** (the default; the office runs the copy that ships with the Agent SDK, the one `cubefarm login` signs in) reports each tool call, finished turn and failure through HTTP hooks passed with `--settings`. Its status line reports cost and usage limits for pacing and shows who the agent is and what they're on.
- **Codex** and **OpenCode** (experimental) run if they're installed: pick one for everyone (Settings → *Default coding agent*) or per agent (Team). They get the same prompt and instructions, and tell the office when a turn ends (Codex's `notify` program, an OpenCode plugin). Codex also gets the office's hooks (`-c hooks.*`, which only report its steps, and Esc as `Interrupt`), but Codex runs hooks only once you trust them: the first time, Codex asks to review them, the office carries on without them and its log says how to trust them (type `/hooks` in a Codex agent's terminal and press `t`). That holds for every later session, since the office's hook command never changes (the office's address travels in `CUBEFARM_HOOK_URL`). Until then, and for OpenCode, the office shows their task rather than each step. Their browser screenshots still reach the office: each session's Playwright server saves its snapshots and unnamed screenshots in the session's own folder (not the worktree), and the office collects new images from there, so their QA reports carry screenshots too. Codex saves every session in your own Codex, where the Codex and ChatGPT apps list it with your chats, so the office archives each agent's thread (`codex archive`) once its CLI closes and unarchives it before resuming it: they're in the apps' Archived list, not your recent chats. Neither runs sandboxed or stops for approvals (see the safety model). OpenCode's self-update is switched off, since several agents starting at once would each reinstall it. The CEO always runs Claude Code.
- A session is finished when the CLI's turn ends and it doesn't pick up another prompt within 3 seconds. A developer's CLI then stays at its prompt for 30 minutes: type into it and the office takes it on as a follow-up, and the message box (or the office itself, e.g. to fix QA findings) continues in the same CLI. QA testers' and the CEO's CLIs close. After that, a follow-up resumes the session in a new CLI (only the CLI that made a session can resume it).
- The office answers the folder-trust question for its own worktrees (moving to "Yes" first where the CLI selects "No"). Anything else a CLI asks before it starts (sign in, first-run screens) waits for you in its terminal, and the agent's log says so.
- **Agents keep working while the office restarts** (an update, a code change during development, a crash). The CLIs run in the office's *terminal keeper* (`server/ptyHost.ts`), a small process of its own that the office starts and talks to over a local socket (a named pipe on Windows, `<SWARM_HOME>/pty.sock` elsewhere, with a secret in `<SWARM_HOME>/pty.secret`). Their hooks go to the keeper too, which holds each one while the office is away, so none fails and nothing is lost. When the office is back it takes each CLI into its agent's terminal again (what it printed meanwhile, then a redraw) and follows the busy ones' sessions. The CEO's session is resumed instead, since its office tools live in the office. When the office quits for good (Ctrl+C) the CLIs stop with it, and a keeper that no office comes back to for 10 minutes stops them itself. If the keeper can't start, terminals run inside the office and stop when it restarts, as before.
- **Agent SDK** runs Claude Code through the SDK instead, shown as a log of its steps: the office's original runtime.

## Safety model

Agents behave like the coding agents you run in your own terminal: they load your setup (user and project settings, `CLAUDE.md`, skills, plugins, MCP servers and claude.ai connectors; Codex and OpenCode their own config), and nothing runs in a sandbox. On top of that the office adds its hooks, its Playwright server when a floor tests in a browser, the office tools for the CEO, and its instructions.

For unattended work, Claude Code terminals for developers, QA testers and the CEO start in `bypassPermissions` mode. Researchers start in Claude's `auto` mode. Codex starts with `--dangerously-bypass-approvals-and-sandbox`, and OpenCode uses the office's permission config.

The office's workflow rules live in each agent's instructions. Agents push their own branches and open PRs. They must avoid pushing to the default branch, force-pushing or merging. QA testers leave GitHub alone except for opted-in inline suggestion pushes; the office posts their reports and handles merges. `AskUserQuestion` and plan mode stay off for Claude Code, so agents decide and record their assumptions in the PR. You can still type into any agent's terminal.

Agents can do anything your own coding agent in a terminal can. Run the office where you'd run those.

## Where things live

- `~/.cubefarm/state.json`: floors, agents, settings and terminal history (`SWARM_HOME` overrides the folder)
- `~/.cubefarm/run-history.json`: every attempt at an issue or PR, kept through restarts and QA cleanup ([run history](run-history.md))
- `~/.cubefarm/terminals/<agent>.ansi`: each agent's terminal screen and scrollback
- `~/.cubefarm/sessions/<token>/`: a running CLI session's settings, MCP config and instructions (removed when it ends); `~/.cubefarm/bin/`: the small scripts the CLIs call back to the office with
- `~/.cubefarm/workspaces/<owner>__<repo>/main`: a clone of each repo
- `~/.cubefarm/workspaces/<owner>__<repo>/desks/<agent>`: one worktree per agent
- `~/.cubefarm/idea-research/`: the local working directory for Idea research sessions. Company research reports live in Cubebase.

Workspaces live outside this project on purpose: agents working in them never pick up this project's `CLAUDE.md`.

Disconnecting a floor never deletes anything on GitHub, and it leaves the clone on disk.

## Floor connections

In the manager's console, each floor can **link** to other connected repos. Agents on that floor get read access to the linked repos' clones (for example, a frontend team that needs to read the API repo) and are told about them in their instructions.

## Floor previews

Every floor can run its app so you can open and use it from the office. The server side:

- `POST /api/repos/:repo/preview` starts it on the default branch, or `{ "pr": 12 }` on an open pull request (and restarts it when it is already running on another ref). `DELETE /api/repos/:repo/preview` stops it. One preview per floor.
- It runs in its own worktree, `workspaces/<owner>__<repo>/desks/preview` (branch `swarm-preview`), never in the floor's main checkout.
- Its port is reserved for the floor: **6300 + floor number** (moved up by 100 if that clashes with the office's own `SWARM_PORT` or another preview). It never uses 4317, 5317 or the agents' 5200-5899 range. If something else already holds the port, the preview reports an error and leaves that program alone.
- Statuses: `preparing` (checkout) → `installing` (`npm ci` with a lockfile, else `npm install`; skipped when `package.json` and the lockfile haven't changed since the last install) → `starting` → `running` (once the port accepts connections; 3 minute timeout), or `error` / `stopped`. The repo's `preview` field carries the status, URL, ref, short commit, start time, error and the last 40 log lines, and is pushed over the websocket.
- Previews stop when their floor is disconnected and when the server gets SIGINT/SIGTERM; anything left over from a hard kill is cleaned up at the next start, and every preview reads `stopped` after a restart.

**Configuring it** (`PATCH /api/repos/:repo` with `previewCommand` and `previewEnv`, or the CEO's `set_floor_profile` tool with `preview_command` / `preview_env`):

- `previewCommand`: a shell command run from the worktree root (`cmd.exe` on Windows). `null` or `""` means the default: `npm run dev`, else `npm run start`, else `npm run preview`. Plain `vite` scripts get `-- --port {port} --strictPort` appended, since Vite ignores `PORT`. No command and no `package.json` means `unconfigured`.
- `previewEnv`: extra environment variables (string values). `ANTHROPIC_*` / `CLAUDE_*` names are refused.
- Placeholders, replaced in the command and in env values: `{port}` is the floor's preview port; `{tmp}` is a scratch folder inside the preview worktree (`.preview-tmp`, kept out of git status).
- `PORT={port}` is always set. The app gets the office's environment minus `ANTHROPIC_*`, `CLAUDE_*` and the office's own `SWARM_*` variables.

Example, this repo previewing itself (a demo office on the floor's port, with its state in the scratch folder):

```json
{ "previewCommand": "npm run build && node --import tsx server/index.ts --demo",
  "previewEnv": { "SWARM_PORT": "{port}", "SWARM_HOME": "{tmp}" } }
```

In `--demo` mode no git or npm runs: starting a preview serves a small placeholder page ("<floor> app · <ref>", with a click counter) on the floor's port.

## Updating the office

Run from a clone of this repo, the office has a parent process, the launcher `scripts/office.mjs`. `npm start` runs the built office under it (`bin/cubefarm.js`: the usual checks, then `dist-server/` serving `dist/`); `npm run dev` and `npm run demo` add `--dev`: the server from source plus Vite (on `SWARM_CLIENT_PORT`, default 5317), with the server restarted when code in `server/` or `shared/` changes. It starts the server with an IPC channel and `SWARM_LAUNCHER=1`.

When the office has finished its work and asks for an update (`{ type: 'office:update', from }`), or when you type `u` + Enter in the launcher's terminal, the launcher:

1. Pauses the file watcher and stops the office: it sends the server `{ type: 'office:shutdown', restart: true }` (the server stops its floor previews and exits; agents' CLIs carry on in the terminal keeper), stops Vite, and kills whatever is still running after 20 seconds, process trees included (`taskkill /T /F` on Windows).
2. Checks the folder: only on origin's default branch, with no local changes and no local commits. Otherwise it changes nothing. Nothing is ever stashed or discarded.
3. Runs `git fetch` and `git merge --ff-only origin/<default>`.
4. Runs `npm install --no-save` if `package.json` or `package-lock.json` changed. This only happens once nothing is running, because Windows locks esbuild's and Rollup's binaries while they're in use. `--no-save` leaves the lockfile as pulled, so another npm version can't turn it into a local change that blocks the next update.
5. Under `npm start`, runs `npm run build`.
6. Writes `<SWARM_HOME>/last-update.json`: `{ from, to, ok, error?, installed, built, at }`. Here `to` is the commit the office runs afterwards, `installed` and `built` say whether npm install and the build ran, and `at` is a timestamp in milliseconds. Then it starts the office again, and the server reports the result on your phone.

If a step fails, the launcher goes back with `git reset --keep <from>`, which never touches local changes. It reinstalls the old dependencies if npm install ran, rebuilds if a build ran, starts the old version and writes `ok: false` with the error. A refused update (another branch, local changes) also writes `ok: false`.

Ctrl+C (or SIGTERM) stops the server, then Vite, and leaves no processes behind; press it twice to quit at once. The launcher is only for a checkout: `npx cubefarm` and a bare `node --import tsx server/index.ts` have none, so there the office only reports that an update is ready.
