# Upstream PR port review: leonvanzyl/cubefarm → mgscox/cubefarm

*Researched 2026-11-04 by Humboldt for [#193](https://github.com/mgscox/cubefarm/issues/193). Fork main checked at `def083f`. Upstream main checked at `157efde` (2026-10-22, version 0.3.20).*

## The question

Which pull requests merged to (or about to land on) upstream `leonvanzyl/cubefarm:main` since the fork split are worth bringing into this fork? The manager's rule applies: no frivolous ports. Only changes that make the office more correct, reliable, secure, compatible or faster, or that fix a real bug the fork also has.

## Summary

- **Fork point.** The merge-base of `mgscox/cubefarm:main` and `leonvanzyl/cubefarm:main` is [`11237cf`](https://github.com/leonvanzyl/cubefarm/commit/11237cf554f21312a2aecd9758d611f2817fc71e), "Release 0.3.2", committed 2026-10-01 10:32 +0200.
- **Upstream since then.** 114 PRs merged to main between 2026-10-02 and 2026-10-22. Two PRs are still open (#299 is a draft, #303 has had no review since 2026-10-17). Twelve were closed without merging. There are also 21 commits with no PR: 18 release bumps (0.3.3 to 0.3.20), two release-workflow commits and one merge.
- **Most of it is out of scope.** About 60 of the merged PRs are toys, sounds, scenery or novelty features (coffee, jukebox, dog, weather, ping-pong, holidays, voice, photo mode and so on). Nine more are already in the fork: the fork's own backports (fork #69 to #74), plus fork #42, #44 and #60.
- **Worth taking: 5 PORT, 13 ADAPT and 1 ADAPT from a closed PR.** They group into 13 issues (listed at the end).
- **Highest value:**
  - pin the agents' Playwright MCP instead of running `npx @playwright/mcp@latest` ([#98](https://github.com/leonvanzyl/cubefarm/pull/98), security);
  - stop handing out an issue whose PR the office just merged ([#106](https://github.com/leonvanzyl/cubefarm/pull/106));
  - stop sessions on closed work ([#236](https://github.com/leonvanzyl/cubefarm/pull/236));
  - the QA and merge-loop fixes for conflicts and flaky checks ([#140](https://github.com/leonvanzyl/cubefarm/pull/140), [#176](https://github.com/leonvanzyl/cubefarm/pull/176));
  - the outline GPU leak in the 3D client ([#179](https://github.com/leonvanzyl/cubefarm/pull/179)).
- **A security finding from neither side's PRs.** While reviewing #259 and #310, I found that the fork, like upstream, accepts `/ws` and `/ws/term` websocket upgrades with no `Origin` check. Since `/ws/term` types into unsandboxed agent CLIs, this is filed as its own issue (see Security).

**How sure I am.** The verdicts come from reading each squash commit's diff with `git show`, and comparing it with the fork's current code. Fork line numbers are at `def083f`. I read the toy and scenery PRs only far enough to confirm two things: what they touch outside `client/`, and that they hold no fix the fork needs. None of the changes was built or run. The claims marked "bug present" are code-reading conclusions; nothing was reproduced.

## Method

- `git fetch https://github.com/leonvanzyl/cubefarm.git main` into this worktree, then `git merge-base HEAD upstream/main`.
- `gh pr list/view/diff --repo leonvanzyl/cubefarm`. The listing returned 150 PRs, under the 200 limit, so it is complete. A second search, `merged:>=2026-10-01`, returned the same 114. Every one targets `main`.
- `git cherry` found no patch-equivalent commits; the fork's backports were rewritten by hand. I mapped fork equivalents from the fork PR bodies, each of which names the upstream PR it backports.
- Nothing was written to upstream: no comments, reactions, labels or forks.

## Summary table: merged PRs (oldest first)

Size is files changed and lines added/removed, as GitHub reports them.

| PR | Title | Merged | Size | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| [#56](https://github.com/leonvanzyl/cubefarm/pull/56) | Keep a Claude session only once its conversation exists | 2026-10-02 | 4f, +62/-4 | **SKIP** | Covered: fork #69 (`resumableSession`/`lostConversation` in `server/clis.ts`) |
| [#58](https://github.com/leonvanzyl/cubefarm/pull/58) | Re-queue QA a restart left in "testing" with nobody on it | 2026-10-04 | 3f, +59/-0 | **SKIP** | Covered, more broadly: fork #42 (`server/qaOwnership.ts` `orphanedQa`, `Swarm.reconcileOrphanedQa`) |
| [#61](https://github.com/leonvanzyl/cubefarm/pull/61) | Stop the elevator cabin's side walls flickering beside the doorway | 2026-10-04 | 1f, +3/-2 | **PORT** | Real flicker; fork's `Elevator.tsx:83-84` has the same code; cherry-pick applies cleanly |
| [#62](https://github.com/leonvanzyl/cubefarm/pull/62) | Move the lobby's east windows clear of the waiting room sign | 2026-10-04 | 1f, +2/-1 | **SKIP** | Covered: fork #60 raised the sign above the window instead |
| [#64](https://github.com/leonvanzyl/cubefarm/pull/64) | Check fixes really pushed, and resume the right task after a restart | 2026-10-04 | 7f, +321/-29 | **SKIP** | Covered: fork #72 (`fixOutcome.ts`, restart recovery) |
| [#81](https://github.com/leonvanzyl/cubefarm/pull/81) | Footsteps that change with the floor: wood, rugs, lobby and the elevator | 2026-10-04 | 9f, +249/-31 | **SKIP** | Frivolous: footstep sounds |
| [#82](https://github.com/leonvanzyl/cubefarm/pull/82) | Sound groundwork: groups, positional audio, a limiter, a voice cap and __swarmSfx | 2026-10-04 | 6f, +419/-42 | **SKIP** | Frivolous: sound groundwork for toys |
| [#94](https://github.com/leonvanzyl/cubefarm/pull/94) | Coffee, part 2: put a mug under the machine, press the button, watch it brew | 2026-10-04 | 10f, +532/-31 | **SKIP** | Frivolous: coffee machine |
| [#95](https://github.com/leonvanzyl/cubefarm/pull/95) | Coffee, part 1: a mug dispenser and mugs you can carry, drop and pick up | 2026-10-04 | 11f, +549/-3 | **SKIP** | Frivolous: mugs |
| [#96](https://github.com/leonvanzyl/cubefarm/pull/96) | Volume sliders for footsteps, typing, toys and alerts | 2026-10-04 | 9f, +222/-84 | **SKIP** | Frivolous: volume sliders for upstream-only sounds |
| [#97](https://github.com/leonvanzyl/cubefarm/pull/97) | Stop local e2e runs from downloading browsers or building twice | 2026-10-04 | 8f, +137/-7 | **PORT** | Faster local e2e: use installed Chrome, `E2E_SKIP_BUILD`; CI unchanged |
| [#98](https://github.com/leonvanzyl/cubefarm/pull/98) | Pin the agents' Playwright MCP and run it with node instead of npx @latest | 2026-10-04 | 9f, +232/-12 | **PORT** | Security: fork still runs `npx -y @playwright/mcp@latest` on every browser session |
| [#99](https://github.com/leonvanzyl/cubefarm/pull/99) | CEO status: free desks and QA stations per floor; propose a full floor at once | 2026-10-04 | 4f, +63/-11 | **SKIP** | Mostly covered (`deskLimits`); only the 8-proposal cap differs |
| [#100](https://github.com/leonvanzyl/cubefarm/pull/100) | Make the basketball fun to score: an arcade arc into the hoop, with a throw simulation | 2026-10-04 | 9f, +443/-60 | **SKIP** | Frivolous: basketball arc |
| [#101](https://github.com/leonvanzyl/cubefarm/pull/101) | Walkways: where people can walk on each floor, and how to get there | 2026-10-04 | 5f, +412/-13 | **SKIP** | Frivolous: walk grid for wandering people |
| [#102](https://github.com/leonvanzyl/cubefarm/pull/102) | Roomba sounds: a positional hum, bumps, and beeps for leaving, returning and charging | 2026-10-04 | 9f, +477/-20 | **SKIP** | Frivolous: roomba sounds |
| [#106](https://github.com/leonvanzyl/cubefarm/pull/106) | Close an issue as soon as the office merges its PR, and don't hand it out again | 2026-10-04 | 6f, +155/-5 | **ADAPT** | Real bug: fork `issueTaken` only counts OPEN PRs, so a merged issue can be handed out again |
| [#107](https://github.com/leonvanzyl/cubefarm/pull/107) | Ball sounds: bounces per ball, rim clank, backboard thud and grabs | 2026-10-04 | 6f, +308/-2 | **SKIP** | Frivolous: ball sounds |
| [#108](https://github.com/leonvanzyl/cubefarm/pull/108) | A working coffee corner in the lobby | 2026-10-04 | 9f, +131/-14 | **SKIP** | Frivolous: coffee corner |
| [#110](https://github.com/leonvanzyl/cubefarm/pull/110) | Foam blaster and dart sounds: impacts by surface, varied thwips, rack, drop and reload | 2026-10-04 | 8f, +393/-26 | **SKIP** | Frivolous: foam blaster sounds |
| [#111](https://github.com/leonvanzyl/cubefarm/pull/111) | Typing and mouse clicks from working agents' desks | 2026-10-04 | 12f, +822/-27 | **SKIP** | Frivolous: typing sounds |
| [#112](https://github.com/leonvanzyl/cubefarm/pull/112) | Confetti over the developer's desk when their PR merges | 2026-10-04 | 5f, +350/-3 | **SKIP** | Frivolous: confetti |
| [#113](https://github.com/leonvanzyl/cubefarm/pull/113) | Coffee, part 3: sip with E, a big last gulp, then drop the empty mug | 2026-10-04 | 13f, +460/-24 | **SKIP** | Frivolous: coffee sipping |
| [#114](https://github.com/leonvanzyl/cubefarm/pull/114) | Folder sync names the files blocking a fast-forward | 2026-10-04 | 4f, +120/-9 | **SKIP** | Diagnostic wording only; no bug in the fork |
| [#117](https://github.com/leonvanzyl/cubefarm/pull/117) | Edit an agent's setup from their own panel | 2026-10-04 | 7f, +345/-124 | **SKIP** | UI refactor; fork's settings differ |
| [#119](https://github.com/leonvanzyl/cubefarm/pull/119) | Agents can stand up, walk about and sit back down | 2026-10-04 | 6f, +609/-102 | **SKIP** | Frivolous: agents walk about |
| [#124](https://github.com/leonvanzyl/cubefarm/pull/124) | CI: client-only PRs skip the Windows and macOS checks | 2026-10-04 | 3f, +56/-12 | **SKIP** | CI cost tweak for GitHub-hosted runners; fork runs native checks on its own LAN runners (fork #77) |
| [#125](https://github.com/leonvanzyl/cubefarm/pull/125) | Desk sweep: remove worktrees, desk folders and branches nobody uses any more | 2026-10-04 | 7f, +409/-10 | **SKIP** | Defer: destructive sweep with data-loss edges (untracked files, macOS in-use probe) and no box support |
| [#126](https://github.com/leonvanzyl/cubefarm/pull/126) | Show what an agent is told: a read-only preview of their full prompt in their Setup | 2026-10-04 | 9f, +472/-71 | **SKIP** | UI feature; fork has no `prompts.ts` and its prompts differ |
| [#127](https://github.com/leonvanzyl/cubefarm/pull/127) | QA trusts GitHub's checks; re-tests focus on what the fix changed | 2026-10-04 | 8f, +237/-24 | **SKIP** | Conflicts with fork's QA specialism (`docs/specialisms/qa.md`, fork #176), which wants checks re-run |
| [#128](https://github.com/leonvanzyl/cubefarm/pull/128) | Free disk space: idle desks drop their node_modules and build output | 2026-10-04 | 16f, +416/-11 | **SKIP** | Disk-space convenience; forces reinstalls, needs box plumbing |
| [#129](https://github.com/leonvanzyl/cubefarm/pull/129) | Desk reset: close the idle CLI first, and recover from a locked folder | 2026-10-04 | 8f, +215/-23 | **ADAPT** | Real bug: desk reset doesn't close the idle CLI first, no stale `index.lock` recovery |
| [#130](https://github.com/leonvanzyl/cubefarm/pull/130) | Install a desk's dependencies before the agent starts, and skip it when nothing changed | 2026-10-04 | 12f, +437/-56 | **SKIP** | Speed only; as written it leaks fork secrets (`CUBEFARM_*`) into PR install scripts |
| [#131](https://github.com/leonvanzyl/cubefarm/pull/131) | Merge gong, part 1: a big gong on every floor that booms and sets off a celebration when a PR merges | 2026-10-04 | 16f, +497/-18 | **SKIP** | Frivolous: merge gong |
| [#132](https://github.com/leonvanzyl/cubefarm/pull/132) | Errands: idle people get up, stretch their legs and come back (and hurry back for work) | 2026-10-04 | 8f, +775/-4 | **SKIP** | Frivolous: errands |
| [#138](https://github.com/leonvanzyl/cubefarm/pull/138) | Little life at the desk: fidgets, stretches and reactions | 2026-10-04 | 11f, +821/-14 | **SKIP** | Frivolous: desk fidgets |
| [#139](https://github.com/leonvanzyl/cubefarm/pull/139) | Sounds for people on the move: footsteps, chairs, stickies, sighs and chats | 2026-10-04 | 7f, +501/-26 | **SKIP** | Frivolous: movement sounds |
| [#140](https://github.com/leonvanzyl/cubefarm/pull/140) | A merge conflict alone never sends a PR to the manager | 2026-10-04 | 7f, +141/-11 | **ADAPT** | Real gap: last-round QA fail on a conflicting PR goes to needs-human instead of a conflict fix |
| [#141](https://github.com/leonvanzyl/cubefarm/pull/141) | Merge gong, part 2: the PR's author runs to the gong and hits it | 2026-10-04 | 10f, +619/-36 | **SKIP** | Frivolous: gong part 2 |
| [#143](https://github.com/leonvanzyl/cubefarm/pull/143) | Keep agents from ending a turn to wait, and resume a QA session once when it ends without a report | 2026-10-04 | 9f, +117/-16 | **SKIP** | Covered: fork #71 (`server/qaRetry.ts`) |
| [#146](https://github.com/leonvanzyl/cubefarm/pull/146) | Send a needs-human PR back to a developer from its Kanban card | 2026-10-04 | 6f, +189/-0 | **SKIP** | UI convenience; fork has `sendBackToDev` via CEO `send_back_to_dev` (fork #33) |
| [#151](https://github.com/leonvanzyl/cubefarm/pull/151) | Coffee breaks: idle agents brew a coffee at the machine and drink it | 2026-10-04 | 13f, +1101/-26 | **SKIP** | Frivolous: coffee breaks |
| [#153](https://github.com/leonvanzyl/cubefarm/pull/153) | Add a jukebox with synthesized songs to every floor | 2026-10-04 | 14f, +1194/-16 | **SKIP** | Frivolous: jukebox |
| [#154](https://github.com/leonvanzyl/cubefarm/pull/154) | Agents move their stickies on the whiteboard themselves | 2026-10-04 | 13f, +1299/-68 | **SKIP** | Frivolous: agents move stickies |
| [#159](https://github.com/leonvanzyl/cubefarm/pull/159) | Idle agents play with the toys: shoot hoops, play catch, poke the roomba | 2026-10-04 | 19f, +1433/-49 | **SKIP** | Frivolous: idle agents play with toys |
| [#160](https://github.com/leonvanzyl/cubefarm/pull/160) | Help, tutorial and README catch up with what's on main | 2026-10-04 | 5f, +42/-13 | **SKIP** | Upstream docs for upstream features |
| [#161](https://github.com/leonvanzyl/cubefarm/pull/161) | Comings and goings: hires arrive by elevator, leavers take a box, chats at the water cooler | 2026-10-04 | 14f, +903/-49 | **SKIP** | Frivolous: arrivals and leavers |
| [#162](https://github.com/leonvanzyl/cubefarm/pull/162) | Only needs-human PRs are red and counted as needing the manager | 2026-10-04 | 4f, +117/-41 | **SKIP** | Cosmetic colour change; fork already has a Blocked column for needs-human |
| [#170](https://github.com/leonvanzyl/cubefarm/pull/170) | Voice messages, part 1: ElevenLabs key, voice settings and a speech endpoint | 2026-10-04 | 14f, +931/-0 | **SKIP** | Frivolous: ElevenLabs voice (security note below) |
| [#171](https://github.com/leonvanzyl/cubefarm/pull/171) | Screenshot fetches answer 204 instead of 404, and the client ignores a missing shot | 2026-10-04 | 8f, +91/-35 | **SKIP** | Cosmetic: 404 vs 204 for a cleared screenshot |
| [#172](https://github.com/leonvanzyl/cubefarm/pull/172) | Outside 0: the time-of-day clock the sky and lights will follow | 2026-10-04 | 6f, +491/-0 | **SKIP** | Frivolous: time-of-day clock |
| [#174](https://github.com/leonvanzyl/cubefarm/pull/174) | Voice section in Settings: ElevenLabs key, voice picker, preview and test | 2026-10-04 | 9f, +580/-5 | **SKIP** | Frivolous: voice settings (security note below) |
| [#176](https://github.com/leonvanzyl/cubefarm/pull/176) | Re-run a flaky check before sending a PR back, and count a re-run as a QA fix | 2026-10-04 | 11f, +186/-31 | **ADAPT** | Real gap: one flaky check costs a developer fix session and a merge-fix strike |
| [#177](https://github.com/leonvanzyl/cubefarm/pull/177) | CEO tool: close an issue that's superseded or no longer wanted | 2026-10-04 | 7f, +92/-8 | **ADAPT** | Real gap: CEO prompt says "close parents" but no CEO tool or Backend method can close an issue |
| [#179](https://github.com/leonvanzyl/cubefarm/pull/179) | All-day check: free leaked outline geometry, stop whole-floor re-renders on agent events | 2026-10-04 | 12f, +191/-18 | **PORT** | Real GPU leak (drei `<Outlines>` under React 19) and whole-floor desk re-renders, both in the fork |
| [#180](https://github.com/leonvanzyl/cubefarm/pull/180) | Split e2e/smoke.spec.ts into one spec file per feature | 2026-10-04 | 14f, +461/-414 | **SKIP** | Upstream e2e reorg; fork's specs diverged |
| [#181](https://github.com/leonvanzyl/cubefarm/pull/181) | Developers own their PR until it merges: bigger budgets, a nudge before a strike, conflicts fixed before QA | 2026-10-04 | 17f, +559/-61 | **SKIP** | Policy/budget change built on #127/#140/#176; fork has its own budgets (fork #29) |
| [#182](https://github.com/leonvanzyl/cubefarm/pull/182) | Outside 1: real windows, a sliding door on each side and balconies you can walk out onto | 2026-10-04 | 21f, +1109/-106 | **SKIP** | Frivolous: windows, doors, balconies |
| [#183](https://github.com/leonvanzyl/cubefarm/pull/183) | A city around the building, with lights that come on at night | 2026-10-04 | 6f, +931/-13 | **SKIP** | Frivolous: city |
| [#184](https://github.com/leonvanzyl/cubefarm/pull/184) | A real sky: moving sun, drifting clouds, golden hour, moon and stars | 2026-10-04 | 5f, +503/-8 | **SKIP** | Frivolous: sky |
| [#185](https://github.com/leonvanzyl/cubefarm/pull/185) | CEO plans whole features per issue; company_status shows the QA queue | 2026-10-04 | 3f, +113/-11 | **ADAPT** | CEO planning: whole-feature issues, QA-queue capacity, in-progress miscount bug |
| [#186](https://github.com/leonvanzyl/cubefarm/pull/186) | Count only open PRs in the floor HUD, lobby, phone and floor signs | 2026-10-04 | 6f, +69/-20 | **ADAPT** | Mostly covered by fork #54; only `OfficeFloor.tsx` wall signs still count closed records |
| [#187](https://github.com/leonvanzyl/cubefarm/pull/187) | Merge cheer: each agent lets out their own little "woo!" | 2026-10-04 | 4f, +464/-0 | **SKIP** | Frivolous: merge cheer |
| [#188](https://github.com/leonvanzyl/cubefarm/pull/188) | Day and night light inside: moving sun, golden-hour glow, cozy lamps at night | 2026-10-04 | 10f, +686/-27 | **SKIP** | Frivolous: day/night lighting |
| [#189](https://github.com/leonvanzyl/cubefarm/pull/189) | Read the CEO's messages aloud the moment they arrive | 2026-10-04 | 14f, +603/-14 | **SKIP** | Frivolous: read messages aloud |
| [#190](https://github.com/leonvanzyl/cubefarm/pull/190) | Jukebox volume control: quiet to filling the floor, ducking under alerts | 2026-10-04 | 10f, +494/-45 | **SKIP** | Frivolous: jukebox volume |
| [#191](https://github.com/leonvanzyl/cubefarm/pull/191) | Outside 5: what it sounds like outside: birds by day, the city at dusk, crickets at night | 2026-10-04 | 9f, +911/-8 | **SKIP** | Frivolous: outdoor sounds |
| [#194](https://github.com/leonvanzyl/cubefarm/pull/194) | Stuck PRs go to the CEO for triage before they reach the manager | 2026-10-04 | 15f, +504/-55 | **SKIP** | New paid-usage feature (CEO triage per stuck PR); fork has its own CEO PR tools |
| [#195](https://github.com/leonvanzyl/cubefarm/pull/195) | Take e2e out of CI | 2026-10-04 | 3f, +12/-46 | **SKIP** | Conflicts: fork keeps e2e in CI on purpose |
| [#203](https://github.com/leonvanzyl/cubefarm/pull/203) | Fix hand-out: work on a PR branch another desk holds, wait for a busy author, and stop desk-failure loops | 2026-10-04 | 6f, +283/-19 | **SKIP** | Covered: fork #70 |
| [#204](https://github.com/leonvanzyl/cubefarm/pull/204) | Whiteboard: a card out for testing reads as "Marple · testing", not a faint outline | 2026-10-04 | 4f, +93/-12 | **SKIP** | Cosmetic; builds on upstream-only `qaCard.ts` |
| [#232](https://github.com/leonvanzyl/cubefarm/pull/232) | Replay the CEO's voice messages from the phone: ▶ per message, cached audio only, a tidy cache | 2026-10-04 | 18f, +690/-88 | **SKIP** | Frivolous: voice replay (security note below) |
| [#233](https://github.com/leonvanzyl/cubefarm/pull/233) | Desk prep: compare real paths when looking for the branch's holder (fixes main's red CI) | 2026-10-04 | 1f, +4/-1 | **SKIP** | Covered: fork #74 |
| [#235](https://github.com/leonvanzyl/cubefarm/pull/235) | Whiteboard 2.0: read any card up close, carry a sticky to someone's desk to assign it, live stats and dependency strings | 2026-10-04 | 30f, +1573/-51 | **SKIP** | Frivolous: whiteboard 2.0 |
| [#236](https://github.com/leonvanzyl/cubefarm/pull/236) | Closing an issue or PR cleans up after itself: stop its sessions, drop its queued work, clear desks and stickies | 2026-10-04 | 13f, +824/-70 | **ADAPT** | Real bug: a BUSY session on a closed issue/PR keeps running and spending usage |
| [#237](https://github.com/leonvanzyl/cubefarm/pull/237) | Pocket office: a phone-friendly installable app and notifications (desktop, push, Discord/Slack/Telegram/ntfy) | 2026-10-04 | 55f, +3548/-97 | **SKIP** | Frivolous for the fork; overlaps fork Telegram/Dashboard. Security-relevant |
| [#238](https://github.com/leonvanzyl/cubefarm/pull/238) | Jukebox lo-fi and focus set with a Focus station; adaptive soundtrack and room acoustics | 2026-10-04 | 21f, +2604/-115 | **SKIP** | Frivolous: lo-fi jukebox |
| [#239](https://github.com/leonvanzyl/cubefarm/pull/239) | PR theatre: try any open PR running live, side by side with main, before it merges | 2026-10-04 | 31f, +2397/-279 | **SKIP** | Feature; runs any open PR's code live. Security-relevant |
| [#240](https://github.com/leonvanzyl/cubefarm/pull/240) | Characters 2.0: expressive faces, role outfits, more body types and a look editor per agent | 2026-10-04 | 22f, +1594/-162 | **SKIP** | Frivolous: characters 2.0 |
| [#241](https://github.com/leonvanzyl/cubefarm/pull/241) | In-person hiring: candidates wait in the lobby, interviews face to face, a welcome tour for new hires | 2026-10-04 | 29f, +1666/-148 | **SKIP** | Frivolous: in-person hiring |
| [#242](https://github.com/leonvanzyl/cubefarm/pull/242) | See what everyone is doing: live activity icons over agents, a hover card and a floor activity ticker | 2026-10-04 | 19f, +1501/-2 | **SKIP** | Covered by fork Dashboard Lobby (fork #172, #183, #185) |
| [#243](https://github.com/leonvanzyl/cubefarm/pull/243) | Office time-lapse: record the day and replay it at up to 600x in the 3D office | 2026-10-04 | 37f, +3466/-35 | **SKIP** | Frivolous: time-lapse |
| [#244](https://github.com/leonvanzyl/cubefarm/pull/244) | Office rituals: stand-ups at the whiteboard, lunch, Friday pizza, the evening wind-down, and the CEO walks the floor | 2026-10-04 | 33f, +2903/-21 | **SKIP** | Frivolous: office rituals |
| [#245](https://github.com/leonvanzyl/cubefarm/pull/245) | Mission control in the lobby: live dashboards, a usage meter with "Resume full speed", alarms when you're needed | 2026-10-04 | 37f, +2162/-78 | **SKIP** | Dashboards covered by fork #157/#183; "Resume full speed" waiver optional |
| [#246](https://github.com/leonvanzyl/cubefarm/pull/246) | Talk instead of type: voice input for the CEO and agents, with a hands-free conversation mode (#205) | 2026-10-04 | 30f, +2141/-27 | **SKIP** | Frivolous: voice input (security note below) |
| [#247](https://github.com/leonvanzyl/cubefarm/pull/247) | Camera & controls: overview dollhouse, building view, follow cam, gamepad and rebindable keys | 2026-10-04 | 66f, +3758/-340 | **SKIP** | Frivolous: camera modes |
| [#248](https://github.com/leonvanzyl/cubefarm/pull/248) | An office dog: wanders, follows you, plays fetch, comforts stressed agents and celebrates merges | 2026-10-04 | 25f, +3405/-9 | **SKIP** | Frivolous: office dog |
| [#249](https://github.com/leonvanzyl/cubefarm/pull/249) | Graphics tiers: bloom, ambient occlusion, glowing screens, time-of-day grading and an auto quality governor | 2026-10-04 | 31f, +1617/-22 | **SKIP** | Cosmetic graphics tiers; only `FrameRateSampler` reused under #306 |
| [#250](https://github.com/leonvanzyl/cubefarm/pull/250) | Ping-pong: a real table you can play against idle agents, with rallies, spin, scoring and a floor leaderboard | 2026-10-05 | 47f, +3856/-35 | **SKIP** | Frivolous: ping-pong |
| [#251](https://github.com/leonvanzyl/cubefarm/pull/251) | Holiday themes: a theme engine with Halloween, Christmas, New Year, Valentine's, Easter and your birthday | 2026-10-05 | 45f, +4603/-16 | **SKIP** | Frivolous: holiday themes |
| [#252](https://github.com/leonvanzyl/cubefarm/pull/252) | Office progression and desks that tell a story: coins, a catalogue kiosk, decorations, trophies and careers | 2026-10-04 | 47f, +4273/-15 | **SKIP** | Frivolous: coins and careers |
| [#253](https://github.com/leonvanzyl/cubefarm/pull/253) | A rooftop terrace: garden, deck chairs, a telescope over the city and stars, a BBQ and a helipad | 2026-10-04 | 56f, +3599/-72 | **SKIP** | Frivolous: rooftop |
| [#254](https://github.com/leonvanzyl/cubefarm/pull/254) | Weather and world events outside: rain, storms, fog and snow (real weather optional), and planes to a friendly kaiju with agents running to watch | 2026-10-04 | 59f, +6047/-36 | **SKIP** | Frivolous: weather (optional outbound location call) |
| [#255](https://github.com/leonvanzyl/cubefarm/pull/255) | Agents talk: cute synthesized babble voices with speech bubbles about their real work (#229) | 2026-10-05 | 25f, +2226/-56 | **SKIP** | Frivolous: babble voices |
| [#256](https://github.com/leonvanzyl/cubefarm/pull/256) | Photo mode and clips: freeze the office, frame the perfect shot, filters, and record short shareable clips (#230) | 2026-10-05 | 54f, +3559/-41 | **SKIP** | Frivolous: photo mode |
| [#257](https://github.com/leonvanzyl/cubefarm/pull/257) | Accessibility and comfort: captions, colour-blind-safe status, motion comfort, UI scale, full keyboard use | 2026-10-05 | 54f, +2490/-122 | **SKIP** | Accessibility pass on upstream-only UI; outside the manager's criteria |
| [#258](https://github.com/leonvanzyl/cubefarm/pull/258) | Queue state file writes so overlapping saves don't race on its temp file | 2026-10-05 | 2f, +24/-2 | **SKIP** | Covered: fork #44 queues writes (`stateWrites` → `writeStateNow`, `swarm.ts:1086-1102`) |
| [#259](https://github.com/leonvanzyl/cubefarm/pull/259) | Shared presence: everyone viewing the office appears in it as a visitor you can see, wave at, ping and follow | 2026-10-05 | 34f, +3037/-13 | **SKIP** | Frivolous: shared presence. Security-relevant (`/ws` becomes inbound) |
| [#260](https://github.com/leonvanzyl/cubefarm/pull/260) | E2E health: fix the dog's fetch on a planned path, and six specs broken or flaky after today's merges | 2026-10-05 | 9f, +68/-18 | **SKIP** | E2E fixes for upstream-only features |
| [#261](https://github.com/leonvanzyl/cubefarm/pull/261) | Scale up: a 10-floor building with 15 people per floor at 60 fps | 2026-10-05 | 53f, +2874/-262 | **ADAPT** | Only three micro-fixes apply: shared keyboard texture, no double canvas paint, `useShallow` in OfficeFloor |
| [#274](https://github.com/leonvanzyl/cubefarm/pull/274) | Show the running version, and drop the Discord, Slack and Telegram notifications | 2026-10-05 | 18f, +107/-170 | **SKIP** | Removes channels the fork uses (Telegram); version display optional |
| [#275](https://github.com/leonvanzyl/cubefarm/pull/275) | Self-healing office: startup reconciliation, a watchdog for stuck work, and an office doctor | 2026-10-05 | 17f, +1159/-32 | **ADAPT** | Quiet-session watchdog and restart work-state checks are missing; skip the doctor UI |
| [#284](https://github.com/leonvanzyl/cubefarm/pull/284) | Fix black characters and missing desk legs, and the fogged-out floor in the zoomed-out views | 2026-10-05 | 7f, +79/-73 | **SKIP** | Fixes regressions in upstream-only batching/camera/sky code |
| [#288](https://github.com/leonvanzyl/cubefarm/pull/288) | Interchangeable agents on machines of their own; the CEO never files issues unasked | 2026-10-07 | 171f, +3240/-2815 | **ADAPT** | Only "CEO never files issues unasked" and the `gh label create --force` fix apply |
| [#292](https://github.com/leonvanzyl/cubefarm/pull/292) | Explain why gh/git commands fail, and retry the Kanban's GitHub reads once | 2026-10-08 | 4f, +95/-8 | **SKIP** | Covered: fork #73 |
| [#293](https://github.com/leonvanzyl/cubefarm/pull/293) | Dock the aim cards at the left edge, clear of the monitor | 2026-10-08 | 4f, +66/-35 | **SKIP** | Cosmetic; code absent in the fork |
| [#295](https://github.com/leonvanzyl/cubefarm/pull/295) | README: any coding agent, not just Claude Code | 2026-10-08 | 2f, +59/-16 | **SKIP** | Upstream README |
| [#305](https://github.com/leonvanzyl/cubefarm/pull/305) | Add --host / SWARM_HOST to listen beyond 127.0.0.1 | 2026-10-22 | 7f, +96/-17 | **ADAPT** | Covered by fork #48 except a real bug: a single-IP `SWARM_HOST` leaves callbacks on 127.0.0.1 |
| [#306](https://github.com/leonvanzyl/cubefarm/pull/306) | Find and fix the freezes while walking around a floor; record hitches | 2026-10-22 | 19f, +1281/-56 | **ADAPT** | Two re-render bugs present: DPR steps and Game subscribing to every floor |
| [#307](https://github.com/leonvanzyl/cubefarm/pull/307) | Count a floor's preview env in characters, not variables | 2026-10-20 | 7f, +102/-6 | **PORT** | Real bug: fork refuses a preview env with more than 50 variables |
| [#308](https://github.com/leonvanzyl/cubefarm/pull/308) | The kitchenette fridge: open it, grab a snack or a cold drink, and eat it (you and the agents) | 2026-10-22 | 28f, +1939/-41 | **SKIP** | Frivolous: fridge |
| [#309](https://github.com/leonvanzyl/cubefarm/pull/309) | Cloud agents: an Upstash Box each, signed in at their desk | 2026-10-20 | 48f, +4815/-162 | **SKIP** | Conflicts with fork's ssh boxes. Security-relevant (ships `gh` token to a cloud VM) |
| [#310](https://github.com/leonvanzyl/cubefarm/pull/310) | Show floors' apps through the office's own address on other devices | 2026-10-22 | 13f, +457/-37 | **SKIP** | Needs upstream-only `syncProxy`; would put agent-built previews on the office origin. Security-relevant |
| [#311](https://github.com/leonvanzyl/cubefarm/pull/311) | Local models for Codex and OpenCode agents (Ollama, LM Studio, llama.cpp, oMLX) | 2026-10-22 | 7f, +118/-7 | **SKIP** | Feature; fork's OpenCode model path differs (fork #126) |

### Open PRs, and closed PRs that matter

| PR | Title | State | Size | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| [#299](https://github.com/leonvanzyl/cubefarm/pull/299) | Let the manager pick the CEO's coding agent | Open, draft (updated 2026-10-26) | 22, +653/-77 | **SKIP** | Not close to landing, and large. Opens Codex/OpenCode to the office MCP with auto-approve. See Open questions for the `sessionCli` behaviour it touches |
| [#303](https://github.com/leonvanzyl/cubefarm/pull/303) | Resume a stopped QA session from the Send button | Open (updated 2026-10-17, no review) | 5, +47/-6 | **SKIP** | The fork blocks messaging QA on purpose (`swarm.ts:4099`). In the fork it would resume a security-review session with the regular QA prompt |
| [#286](https://github.com/leonvanzyl/cubefarm/pull/286) | Answer the folder-trust question under older sessions' screens, and for CLIs picked back up | Closed unmerged 2026-10-06 | 3, +103/-37 | **ADAPT** | Real bug in both upstream and the fork. `trustKey` reads the first `❯` anywhere on screen |
| #123, #198, #234 | CI throwaways and an e2e sharding experiment | Closed | small | SKIP | Never landed. #198 shards e2e that upstream later removed from CI |
| #276 to #283, #300 | Idea wall, server room, ducks, gazette, personalities, cinematic arrival, mods, street plaza, fridge v1 | Closed | 1.5k to 3k lines each | SKIP | Frivolous, and not merged (#300 later landed as #308) |

### Upstream commits on main without a PR

| Commit | What | Verdict |
| --- | --- | --- |
| 18 × `Release 0.3.x` (0.3.3 to 0.3.20) | Version bumps in `package.json`/lock | SKIP. The fork versions itself (`9a6914e`, fork 0.3.19) |
| [`7177aa7`](https://github.com/leonvanzyl/cubefarm/commit/7177aa7) and [`e3058bc`](https://github.com/leonvanzyl/cubefarm/commit/e3058bc) | `.github/workflows/release.yml`: npm trusted publishing (OIDC, `id-token: write`, no stored npm token, `npm publish --ignore-scripts`) and a "Run workflow" release button | SKIP. The fork doesn't publish to npm and can't publish the `cubefarm` name. Well built if that ever changes (security note below) |
| [`6b44166`](https://github.com/leonvanzyl/cubefarm/commit/6b44166) | Merge that brought PR #56 into main | SKIP. Covered by fork #69 |

## Per-PR detail: PORT and ADAPT

The table under each item answers question 4: which fork files it touches, how likely it is to conflict, and whether it reaches CLAUDE.md's SAFETY section, the self-update launcher (`scripts/office.mjs`), ports 4317/5317 or the state in `~/.cubefarm`.

### #98 Pin the agents' Playwright MCP and start it with node, not npx @latest (PORT)

[#98](https://github.com/leonvanzyl/cubefarm/pull/98), merged 2026-10-04, 9 files, +232/-12.

- **What it changes.** It adds `@playwright/mcp` as an exact-pinned dependency. A new `server/browser.ts` (`playwrightMcpCli`, `playwrightMcpCommand`, `browserProblem`) resolves the installed `cli.js` and runs it with `node`, with no shell. `cubefarm doctor` reports the tool's version, and `scripts/smoke-package.mjs` runs it.
- **Fork status.** The bug is present. `server/agentRunner.ts:345-346` and `server/cliFiles.ts:43` still run `npx -y @playwright/mcp@latest`, through `cmd /c npx` on Windows. That fetches and runs whatever the npm registry serves as `latest`, unpinned, at the start of every QA or browser session.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `package.json`/lock, new `server/browser.ts`, `server/agentRunner.ts`, `server/cliFiles.ts` (the fork's equivalent of upstream's `cliRunner.ts` hunk), `bin/cubefarm.js`, `scripts/smoke-package.mjs` | Low | None. Boxes resolve the package from their own install (`cliFiles.ts` runs on the box, and `boxUpdate.ts` reinstalls when dependencies change) |

Keep the fork's Codex key `mcp_servers.cubefarm_playwright` (fork #3). Upstream pinned `0.0.83`, which pulls a `playwright 1.64.0-alpha` prerelease, so pick a current non-alpha release when porting.

### #106 Close an issue as soon as the office merges its PR, and don't hand it out again (ADAPT)

[#106](https://github.com/leonvanzyl/cubefarm/pull/106), merged 2026-10-04, 6 files, +155/-5.

- **What it changes.**
  - Adds `Backend.closeIssue` (`gh issue close --reason completed --comment`) with a demo fake.
  - `closeResolvedIssues()` closes the issues a merged PR resolves, after both the auto-merge and the manual merge paths.
  - `issueTaken()` treats an issue as taken while a PR for it merged in the last 6 hours (`RECENT_MERGE_MS`).
- **Fork status.** The bug is present. Fork `issueTaken` (`swarm.ts:2817-2821`) counts only `p.state === 'OPEN'` pulls. Between the merge and GitHub processing "Closes #N", the scheduler can hand the same issue out again. That gives a wasted session and a no-op PR. Nothing in the fork's `server/` closes issues. Fork `listPulls` already fetches merged PRs with `mergedAt`, so the 6-hour guard has the data it needs.
- **What the re-do takes.** Hand re-do; the fork's `issueClaims.ts` exists with different content (`issueHolder`). Keep the fork's researcher, `heldRetry` and `RESEARCH_BRANCH` cases. Hook into the auto-merge success path (around `swarm.ts:2169`) and `mergePull` (around `:2533`), which the CEO's `merge_pr` also uses.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/backend.ts`, `server/github.ts`, `server/demo.ts`, `server/swarm.ts`, `server/issueClaims.ts` | Medium | None |

### #307 Count a floor's preview env in characters, not variables (PORT)

[#307](https://github.com/leonvanzyl/cubefarm/pull/307), merged 2026-10-20, 7 files, +102/-6.

- **What it changes.** A new `shared/previewEnv.ts` (`PREVIEW_ENV_MAX_CHARS = 16000`, `previewEnvTooBig`) replaces the 50-variable cap and the 4,000-character per-value cap. The CEO's `set_floor_profile` description and the settings form use the same rule.
- **Fork status.** The bug is present. `server/previews.ts:56` refuses more than 50 variables with "previewEnv has too many variables", so a real project's `.env` is refused. The `ANTHROPIC_`/`CLAUDE` refusal stays as it is.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| new `shared/previewEnv.ts`, `server/previews.ts`, `server/ceo.ts`, the fork's preview settings form | Low | None |

### #61 Stop the elevator cabin's side walls flickering (PORT)

[#61](https://github.com/leonvanzyl/cubefarm/pull/61), merged 2026-10-04, 1 file, +3/-2.

- **What it changes.** The cabin side walls start 5 cm inside the wall face, so they no longer share a plane with it and z-fight.
- **Fork status.** The same code is at `client/src/world/Elevator.tsx:83-84`. `git apply --check` of `24329a3` succeeds on the fork. It's a real rendering bug, the same class as fork #60 and #68.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `client/src/world/Elevator.tsx` | Low | None |

### #179 Free leaked outline geometry; stop whole-floor re-renders on agent events (PORT)

[#179](https://github.com/leonvanzyl/cubefarm/pull/179), merged 2026-10-04, 12 files, +191/-18.

- **What it changes.**
  - **The leak.** A local `Outlines.tsx`, with a pure, tested `outlineMesh.ts`, replaces drei's `<Outlines>`. drei 10.7.9 frees its creased hull in a cleanup that reads `ref.current`, which React 19 has already cleared, and it never disposes its material. So every outline that unmounts keeps its GPU buffers until reload.
  - **The re-renders.** `Desk` is wrapped in `memo`, and the callers pass module-level position arrays.
- **Fork status.** Both bugs are present.
  - The fork pins `@react-three/drei ^10.7.9` with React `^19.3.0`. `Toon.tsx` uses outlines with the default crease angle (4 places), `Character.tsx` 6 places, plus the roomba, balls and hoop. Each floor change or hire/fire leaks.
  - `Desk.tsx:219` isn't memoised. `OfficeFloor.tsx:61-69` and `Lobby.tsx:260,304` build new `[x,0,z]` arrays on every render.
  - Every caller uses only `thickness`, `color` and `angle`, which the replacement supports.
- **Port note.** The new files come over as they are. The memo and stable arrays need a hand re-apply, plus one more stable array for the fork's research desk. Skip `mugLook.tsx`, which doesn't exist in the fork.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| new `client/src/world/Outlines.tsx`, `outlineMesh.ts`, `outlineMesh.test.ts`; `Character.tsx`, `Toon.tsx`, `toys/*`, `Desk.tsx`, `OfficeFloor.tsx`, `Lobby.tsx` | Low to medium | None |

### #186 Count only open PRs in the HUD, lobby, phone and floor signs (ADAPT, small)

[#186](https://github.com/leonvanzyl/cubefarm/pull/186), merged 2026-10-04, 6 files, +69/-20.

- **Fork status.** Mostly covered by fork #54: `client/src/qaCounts.ts` is used by `HUD.tsx:63` and `Lobby.tsx:43`, and the phone already filters to open PRs. The remaining gap is that the floor's own wall signs (`OfficeFloor.tsx:48-49`, drawn at `:76` and `:115`) still count every QA record, so a closed PR can show until the next sync.
- **Re-do.** Use the fork's `qaCounts()` there, not upstream's `floorPrCounts`. About 2 lines.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `client/src/world/OfficeFloor.tsx` | Low | None |

### #306 and #261 Scene re-render and frame-time fixes (ADAPT)

[#306](https://github.com/leonvanzyl/cubefarm/pull/306) (merged 2026-10-22, 19 files, +1281/-56) and [#261](https://github.com/leonvanzyl/cubefarm/pull/261) (merged 2026-10-05, 53 files, +2874/-262). Most of both targets upstream-only code: instanced batches, canvas painting in a worker, the outbox protocol, the bench and the hitch recorder. These pieces apply to the fork's existing scene:

- **#306, adaptive resolution.**
  - The bug: the fork's `Game.tsx:41` `useState(maxDpr)`, fed by drei `PerformanceMonitor` → `setMaxDpr` (`perf.tsx:69-71`), re-renders Game and the whole scene on every DPR step.
  - The fix: upstream's pure `dprControl.ts` (with test) steps DPR through R3F's `setDpr` with hysteresis. Bring it with the ~30-line `FrameRateSampler` from #249. Drop the graphics-tier hooks.
- **#306, Game re-renders for every floor.** The fork's `Game.tsx:35` subscribes to all `repos`, so any floor's `repo` event (18 `emitRepo` call sites in `swarm.ts`) re-renders the whole scene. Upstream wraps it in an `OfficeRoom` that follows only its own floor.
- **#261, three micro-fixes.**
  - One shared keyboard texture: the fork paints a 512×176 canvas per occupied desk (`Desk.tsx:174-197`).
  - `useCanvasTexture` paints twice on every change, because `document.fonts.ready` resolves at once when fonts are already loaded (`interact.ts:43`). Skip the second paint when `document.fonts.status === 'loaded'`.
  - `useShallow` for OfficeFloor's agent and QA subscriptions (`OfficeFloor.tsx:41,47`).
- **#306, `ScenePrecompile` (optional).** `gl.compileAsync` as the scene grows, which plausibly removes first-look shader stalls. Unmeasured on the fork.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `client/src/perf.tsx`, `client/src/world/Game.tsx`, new `client/src/dprControl.ts` (+ test), `Desk.tsx`, `interact.ts`, `OfficeFloor.tsx` | Medium (`perf.tsx` reworked by hand) | None. Upstream's `scripts/bench.mjs`, which boots demo servers, is excluded |

### #140 A merge conflict alone never sends a PR to the manager (ADAPT)

[#140](https://github.com/leonvanzyl/cubefarm/pull/140), merged 2026-10-04, 7 files, +141/-11.

- **What it changes.**
  - The QA prompt says a conflict with the default branch is not a fail.
  - A new `qaOutcome.ts` routes a last-round QA fail on a CONFLICTING/DIRTY PR back to a developer as a conflict fix (while `mergeFixes < MAX_MERGE_FIXES`), instead of needs-human.
- **Fork status.** Partly covered. `fixOutcome.ts:52` already requires `passedSha` for conflicts, and the conflict fix prompt has instructions (`swarm.ts:3994`). Still missing:
  - the prompt line, in `buildQaSystemAppend` (`swarm.ts:3570`);
  - the routing: `swarm.ts:3872` sends a last-round fail to needs-human even when the PR merely conflicts.
- **Re-do.** The routing interleaves with the fork's security-review, escalate and incomplete branches in `onQaFinished`.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/swarm.ts`, new `server/qaOutcome.ts` (+ test) | Medium | None |

### #176 Re-run a flaky check before sending a PR back (ADAPT)

[#176](https://github.com/leonvanzyl/cubefarm/pull/176), merged 2026-10-04, 11 files, +186/-31.

- **What it changes.**
  - `mergeGate.mergeStep` gains a `rerun` step: the first time a QA-passed PR's checks fail on a given head, `Backend.rerunFailedJobs` runs `gh run rerun <id> --failed`, with run ids parsed from check URLs. A 2-minute grace follows before any send-back.
  - A QA fix that pushed nothing but turned checks green counts as a free re-test.
- **Fork status.** Not present. Fork `mergeGate.ts:51` goes straight to send-back, so one flaky check costs a developer fix session and a merge-fix strike. Only the developer's fix prompt (`swarm.ts:4006`) suggests `gh run rerun`.
- **Re-do.**
  - Insert the step after the fork's `unavailable` branch.
  - Upstream's `fixOutcome` signature differs: the fork passes a `fixer` and tracks `fixCrashes`.
  - The fork's `prDetails` has no `checks`, so either add them or drop the free-re-test half.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/mergeGate.ts`, `backend.ts`, `github.ts`, `demo.ts`, `fixOutcome.ts`, `swarm.ts` (QaRecord fields and their load) | Medium | Adds persisted QaRecord fields to `state.json` (backward-compatible defaults needed) |

### #236 Closing an issue or PR cleans up after itself (ADAPT, narrow)

[#236](https://github.com/leonvanzyl/cubefarm/pull/236), merged 2026-10-04, 13 files, +824/-70.

- **What it changes.** The pure `closeCleanup.ts` decides what to do once an issue or unmerged PR is found closed: stop its sessions, clear desks, drop the QA record, hold the issue. `runTask`/`runFix` check the work is still open before preparing. There are also board Close buttons.
- **Fork status.** The bug is partly present.
  - `reconcilePulls` (around `swarm.ts:2352`) skips `BUSY` agents, so a running session on a closed issue or PR keeps going and spends usage.
  - There is no issue-closure handling and no pre-start check.
- **Re-do.** Take only two things: stop BUSY sessions on known-closed work, and the pre-start open check. Keep the fork's record semantics: `closeQaRecord` (`:2394`) deliberately keeps closed records that have a `securityReview`, so a reopened PR gets a fresh review, and upstream's `dropQa` would delete them. Respect CEO-parked PRs and Ideas' held-for-publication issues. Skip the board UI.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/swarm.ts` (heavy), new pure module (+ test), `server/demo.ts` | High | Adds persisted fields to `state.json` |

### #275 Self-healing office: startup reconciliation, a watchdog, an office doctor (ADAPT, selective, after #236)

[#275](https://github.com/leonvanzyl/cubefarm/pull/275), merged 2026-10-05, 17 files, +1159/-32.

- **What it changes.**
  - `reconcile.ts` decides clear, reattach, resume or requeue per agent on restart.
  - `watchdog.ts` nudges a session that has been quiet for 20 minutes, requeues it 10 minutes after the nudge, and requeues desks stuck preparing. At most one remedy per item per hour.
  - The doctor UI (`/api/doctor/*`).
- **Fork status.** Partly covered by other means: `startWatch` covers stalls before startup (fork #92/#124, `swarm.ts:1769-1808`), `reconcileOrphanedQa` covers orphaned QA, and fork #132 covers startup crashes. Two gaps remain:
  - a CLI that goes silent mid-run hangs indefinitely;
  - on restart, an issue closed while the office was down isn't noticed for reattached `carryOn` CLIs.
- **Re-do.** Take the quiet-session watchdog and the restart work-state check; skip the doctor and its demo scenarios. Upstream's `deskExists` uses local `existsSync`, so it must go through `machineFor(a)`. Otherwise a box agent's desk reads as missing and is "restored" on the office machine. Activity must count box hooks too. Map upstream's `requeue` onto the fork's `heldRetry`/`requestedStarts`.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/swarm.ts` (heavy), new `server/watchdog.ts`/`reconcile.ts` (+ tests), `backend.ts`/`machine.ts`, `shared/types.ts`, `demo.ts` | High | None for SAFETY, launcher or ports. The office restart path (`recover()`) changes behaviour |

### #129 Desk reset: close the idle CLI first, and recover from a locked folder (ADAPT)

[#129](https://github.com/leonvanzyl/cubefarm/pull/129), merged 2026-10-04, 8 files, +215/-23.

- **What it changes.**
  - `setUpDesk()` awaits `term.releaseIdle()` before `releaseDesk`/`prepareDesk`, so a kept CLI whose working directory is the desk exits first. `releaseIdle` and `endLive` now return promises.
  - `prepareDesk` removes an `index.lock` older than 10 minutes and retries once.
  - On Windows, `clearDeskFolder` tolerates an empty folder it can't remove.
  - It logs why in-place reuse failed.
- **Fork status.** The bug is present.
  - The fork's `prepare` (around `swarm.ts:3059`) calls `releaseDesk` without closing an idle CLI.
  - `terminal.ts:44` types `releaseIdle` as `() => void`, and `cliRunner.ts:185` `endLive` doesn't wait for exit.
  - `workspace.ts:299-308` swallows the reuse error, so the desk is rebuilt from scratch and loses its warm `node_modules`.
  - On Windows a live CLI holding the folder makes this worse.
- **Re-do.** Skip `releaseIdle` when the author's own fix round keeps its conversation (`place()` returns `'within'`). Check the seven `releaseIdle?.()` call sites.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/workspace.ts`, `swarm.ts`, `cliRunner.ts`, `terminal.ts`, new `server/deskSetup.ts` (+ test) | Medium (fork's `endLive` is box-aware) | None |

### #185, #288 (part) and #177 CEO planning rules and a close_issue tool (ADAPT)

- **[#185](https://github.com/leonvanzyl/cubefarm/pull/185)** (merged 2026-10-04, 3 files, +113/-11).
  - CEO prompts move from "small issues, at least one per developer" to whole-feature issues, 1 to 4 per brief, with QA as the scarce resource.
  - A pure `floorCapacity()` adds `prsAwaitingQa` to `company_status`.
  - It fixes `issuesWaitingOnOthers` counting in-progress issues.
  - In the fork, `ceo.ts:417` still says "aim for at least one per developer… split big pieces", and `swarm.ts:5768` has the miscount.
- **[#288](https://github.com/leonvanzyl/cubefarm/pull/288)** (merged 2026-10-07, 171 files, +3240/-2815). Most of it reworks roles and machines. Upstream's "machines" are local per-agent clones, unrelated to the fork's ssh boxes, so that part is SKIP. Two pieces apply:
  - **The CEO never files issues unasked.** `askedFor(job)` is true only for plan and chat jobs, and `fileIssue` throws `NOT_ASKED` otherwise. The fork's review and onboard jobs still tell the CEO to "plan the next milestone" as issues (`ceo.ts:434,458`), which cuts across the fork's approval-gated Ideas → Issue Plan flow (`publication.ts`).
  - **The `gh label create --force` fix.** The fork's `github.ts:415` resets the colour and description of a label the manager already has. Upstream drops `--force` and tolerates "already exists".
- **[#177](https://github.com/leonvanzyl/cubefarm/pull/177)** (merged 2026-10-04, 7 files, +92/-8). A `close_issue` CEO tool that closes as "not planned" with a comment, refusing unknown or closed issues and ones an open PR closes. The fork's prompt tells the CEO to "review or close parents" (`ceo.ts:417`), but none of its tools can close an issue, and its Backend has no `closeIssue`. This shares the Backend method with #106.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/ceo.ts` (+ test), `server/swarm.ts` (`fileIssue` around `:5983`, capacity around `:5768`, CEO job start around `:4812`), `server/github.ts`, `backend.ts`, `demo.ts` | Medium (`ceo.ts:417` is a long, fork-specific line) | None |

### #286 (closed) Folder-trust answer under older sessions' screens (ADAPT)

[#286](https://github.com/leonvanzyl/cubefarm/pull/286), closed unmerged 2026-10-06, 3 files, +103/-37.

- **What it changes.** A pure `selectedOption()` reads the menu under the *last* matching question, only when exactly one `❯`/`›` sits below it. The startup watcher also runs for re-adopted CLIs and follow-ups.
- **Fork status.** The bug is present in both the fork and upstream main.
  - The fork's `clis.ts:486-491` and `:557-561` take the first marker anywhere on screen, so a stale prompt line in a reused terminal, such as the CEO's, is read as the selection. The trust question then goes unanswered.
  - The watcher runs only for fresh CLIs (`cliRunner.ts:922-933`).
- **Confidence.** Medium: from code reading, not reproduced.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `server/clis.ts` (+ tests), `server/cliRunner.ts` | Low for `selectedOption`, medium for the watcher | None. It only answers "trust" for the office's own worktrees |

### #305 SWARM_HOST: callbacks for a single-address bind (ADAPT, small)

[#305](https://github.com/leonvanzyl/cubefarm/pull/305), merged 2026-10-22, 7 files, +96/-17.

- **Fork status.** Mostly covered by fork #48 (`bin/officeNetwork.js` `officeHost`, `bindMessage`, with an equivalent no-sign-in warning). One real bug remains. If `SWARM_HOST` is a single LAN IP rather than `0.0.0.0`, these still point at `127.0.0.1`, where nothing listens:
  - agent hooks and the CEO's MCP (`setOfficeUrl('http://127.0.0.1:…')`, `server/index.ts:220`);
  - the `bin/cubefarm.js` running-office probes;
  - the Vite proxy targets.
- **Re-do.** Port upstream's `localAddress(HOST)` and use it for those three places, or refuse a single-IP bind outright. Skip the `--host` flag. `officeHost` should also trim and validate the value.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `bin/officeNetwork.js`, `server/index.ts`, `bin/cubefarm.js`, `vite.config.ts` | Low | It changes how the server and Vite bind and call back on 4317/5317. Keep the loopback default, test only in demo mode on a reserved port, and re-check the SAFETY text. `scripts/office.mjs` inherits `SWARM_HOST` and should need no change |

### #97 Local e2e uses installed Chrome and skips a second build (PORT)

[#97](https://github.com/leonvanzyl/cubefarm/pull/97), merged 2026-10-04, 8 files, +137/-7.

- **What it changes.**
  - `scripts/e2eSteps.mjs` and `e2e-check.mjs` (`pretest:e2e`) use a local Google Chrome when one is installed and `CI` is unset, instead of downloading Chromium.
  - `E2E_SKIP_BUILD=1` reuses `dist/`.
  - It warns when `PLAYWRIGHT_BROWSERS_PATH` points inside the checkout.
- **Why it matters.** Every desk in this office runs `npm run test:e2e` before opening a PR (CLAUDE.md), so this saves a browser download and a build per run. CI is unchanged.

| Fork files | Conflict | SAFETY / launcher / ports / state |
| --- | --- | --- |
| `package.json`, `playwright.config.ts`, new `scripts/e2eSteps.mjs`/`.d.mts`/`e2e-check.mjs` (+ test), CONTRIBUTING/CLAUDE.md lines | Low | None. `E2E_PORT` handling stays as it is |

## Per-PR detail: SKIP

### Already covered in the fork

| Upstream | Fork equivalent |
| --- | --- |
| #56 Keep a Claude session only once its conversation exists | fork #69: `resumableSession`/`lostConversation` in `server/clis.ts`, tests at `clis.test.ts:425-482` |
| #58 Re-queue QA a restart left in "testing" | fork #42: `server/qaOwnership.ts` `orphanedQa()`, `Swarm.reconcileOrphanedQa()` (`swarm.ts:1855`). Runs on recover and in `clearTask`, which is broader than upstream |
| #62 Lobby east windows vs waiting-room sign | fork #60: the sign was raised above the window frame (`Lobby.tsx`) |
| #64 Check fixes really pushed; resume the right task after a restart | fork #72: `server/fixOutcome.ts`, restart recovery |
| #143 Keep agents in one turn; resume a reportless QA session once | fork #71: `server/qaRetry.ts`, `QA_RESUME_PROMPT` |
| #203 Hand-out on a PR branch another desk holds | fork #70: detached-HEAD QA/fix desks, waiting for a busy author |
| #233 Compare real paths when finding a branch's holder | fork #74: `realPath()`/`samePath()` in `workspace.ts` |
| #258 Queue state file writes | fork #44: `stateWrites` → `writeState()` → `writeStateNow()` (`swarm.ts:1086-1102`). Every save goes through the queue. Upstream's overlap test is optional |
| #292 Explain gh/git failures; retry board reads once | fork #73: `exec.ts` diagnostics, `readTwice` in `github.ts` |
| #242 Activity signs and floor ticker | fork #172, #183, #185: Dashboard Lobby, who's working, office notices |
| #245 Mission control dashboards | fork #157, #183: Dashboard. The "Resume full speed" pacing waiver isn't in the fork's `pacing.ts`. It's a ~60-line optional extra, not a fix |
| #99 CEO sees free desks | the fork's `deskLimits` (`swarm.ts:5829`) and per-proposal desk check (`:5905`). Only upstream's raised cap (8 → 15 pending proposals, fork `MAX_PENDING_REQUESTS = 8`) differs, and that's a one-line policy choice |

### Conflicts with how the fork works

- **#127 QA trusts GitHub's checks.** It tells QA not to re-run what CI covers. The fork's file-backed QA specialism (`docs/specialisms/qa.md`, fork #176) prescribes the opposite, and the fork's QA desks also run security reviews (fork #186).
- **#181 Developers own their PR until it merges.** Raised budgets plus `prOwnership` catch-up, built on #127/#140/#176. The fork counts failed fixes per developer (fork #29) and hands crashed fixes to another developer. Its `qaGate` idea (don't QA a conflicting PR) can follow the #140 issue later. Security note: it pipes a CI-log tail (`failedRunLog`), which PR code controls, into developer prompts.
- **#194 Stuck PRs go to the CEO for triage.** It queues a paid CEO session per stuck PR and adds tools that overlap the fork's `send_back_to_dev`, `park_pr`, `merge_pr` and `rerun_qa`.
- **#195 Take e2e out of CI.** The fork keeps its e2e job (CLAUDE.md, `ci.yml`).
- **#124 Client-only PRs skip Windows/macOS CI.** Written for GitHub-hosted runners. The fork runs native checks on its own LAN runners (fork #77), so the saving is small and the jobs would need rewriting.
- **#274 Show running version; drop Discord/Slack/Telegram.** It removes the Telegram channel the fork uses (fork #91, #117). The version display is a nice-to-have, not a fix. The fork already sends its version to boxes (`swarm.ts:1583`).
- **#309 Cloud agents (Upstash Box).** It conflicts with the fork's ssh boxes, which share the "box" name.
- **#311 Local models for Codex/OpenCode.** A compatibility feature, but its OpenCode `--model` path is what fork #126 found the installed OpenCode rejects. The fork routes models through `OPENCODE_CONFIG_CONTENT`. Revisit `codexLocal` only if the manager wants Codex on local models.
- **#310 Previews through the office's own address.** It needs upstream-only `syncProxy.ts`, and it makes previews same-origin with the office (see Security).
- **#130 Install a desk's dependencies before the agent starts.** A speed gain only, since desks keep `node_modules` warm. As written it would run PR install scripts from the office with an environment that strips only `ANTHROPIC_|CLAUDE|SWARM_`, which leaks the fork's `CUBEFARM_TELEGRAM_TOKEN`/`CUBEFARM_MCP_TOKEN`. Any future port must go through `projectEnv()` (fork #56).
- **#125 Desk sweep** (deferred, not rejected). A real but minor gap: desks left by a failed `removeDesk` accumulate. The sweep deletes (`branch -D`, `rm -r`); `saveLeftovers` loses untracked files; the `inUse()` rename probe only protects on Windows; and it has no box support. Worth an issue only if disk use or stale branches become a problem.
- **#128 Idle desks drop node_modules.** A disk-space feature that forces reinstalls.

### Small or cosmetic

#114 (more detailed folder-sync status text), #117 (agent settings UI), #126 (prompt preview UI), #146 (Kanban send-back button; the server side exists as `sendBackToDev`), #160 and #295 (upstream docs), #162 (failed PRs amber instead of red), #171 (204 instead of 404 for a cleared screenshot), #204 and #293 (whiteboard and HUD cosmetics on upstream-only code), #180 and #260 (upstream e2e reorganisation), #249 (bloom, ambient occlusion and graphics tiers; only `FrameRateSampler` is reused, under #306), #257 (accessibility on upstream-only UI), #284 (fixes regressions in upstream-only batching, camera and sky code; the fork has none of the seven files).

### Frivolous (toys, decorations, novelty)

Sound: #81, #82, #96, #102, #107, #110, #111, #139, #187, #190, #191, #238. Coffee: #94, #95, #108, #113, #151. Toys and games: #100, #159, #250. People life: #101, #119, #132, #138, #154, #161, #241, #244. Merge celebrations: #112, #131, #141. Scenery: #172, #182, #183, #184, #188, #253, #254. Characters and themes: #240, #251, #255. Pets, progression and capture: #248, #252, #256, #243. Voice: #170, #174, #189, #232, #246. Other features: #235, #237, #239, #247, #259, #308.

I checked each of these for server changes. Where a toy touches `server/` it adds state or routes for itself (for example `state.pong`, `/api/progress/*`, a holiday-greeting phone message in #251, which the fork would also mirror to Telegram). None carries a fix the fork needs.

## Security-relevant items

These are flagged whatever the verdict.

1. **Not from an upstream PR: no Origin check on websocket upgrades (fork and upstream).**
   - `server/index.ts:211-216` upgrades `/ws` and `/ws/term` for any `Origin`. `/ws/term` relays `{t:'input'}` keystrokes into the agent's unsandboxed CLI (`terminal.ts:159-167`); `allowInput` only checks whether the office is held.
   - So a web page open in the manager's browser could connect to `ws://localhost:4317/ws`, read agent ids from the snapshot, then open `/ws/term?agent=<id>` and type into Claude Code. That is cross-site WebSocket hijacking leading to code execution as the manager.
   - Mitigations, partial: Chromium's Local Network Access now covers WebSocket connections from public sites to loopback and private addresses behind a permission prompt [1][2]. Firefox and Safari behaviour was not verified, and a page on the same LAN, or one the user allows, is not covered. With `SWARM_HOST=0.0.0.0` (fork #48), any LAN host can connect directly; the docs already state there's no sign-in.
   - The fork already guards its manager MCP with loopback, Host and Origin checks (`managerMcpSettings.ts:85-91` `canManage`), so the pattern exists.
   - Not exploited; code-path reading only. Filed below as its own issue. It's a transport check, not a hook or permission rule on agents' tool calls, so it doesn't conflict with CLAUDE.md's SAFETY section.
2. **#98: supply chain.** The fork fetches `@playwright/mcp@latest` from npm at every browser session and runs it through `cmd /c` on Windows. This is the PORT above.
3. **#130 (SKIP): token leak if ported naively.** Upstream's `npmCi` environment would pass `CUBEFARM_*` secrets and an inherited `npm_config_allow_scripts` into PR install scripts, including PRs from forks.
4. **#239 (SKIP): runs untrusted PR code.** PR theatre runs any open PR, including PRs from forks, with the floor's preview env. The fork's single preview already accepts any open PR (`previews.ts:125-148`, no `isCrossRepository` check); that is worth knowing even without the port. Its sync proxy strips the app's CSP and `X-Frame-Options`, but listens only on 127.0.0.1.
5. **#310 (SKIP): previews on the office origin.** The gateway isn't an open proxy (a server-side port allowlist, loopback only, `//` and `/\` blocked). But it serves agent-built preview JS same-origin with the office. Combined with the fork's iframe `sandbox="allow-scripts allow-same-origin"` (`AppViewer.tsx:276`), that JS could call `/api` and `/ws/term`. Reached as `localhost:4317/preview/…`, it would also pass `canManage`'s Host/Origin check. If ever wanted, serve previews from a separate port or origin.
6. **#237 (SKIP): unauthenticated notification routes.** Webhook URLs, bot tokens and the ntfy token are stored plaintext in `<SWARM_HOME>/secrets.json` (0600), and VAPID keys in `push.json`. The `/api/notify/*` routes are unauthenticated, and ntfy accepts `http:` to any host. Anyone who can reach the office could make it POST CEO-message and PR-title text to a URL of their choice (limited SSRF).
7. **#309 (SKIP): credentials to a third-party VM.** With no PAT given, it ships the manager's `gh auth token` as `GH_TOKEN` into an Upstash VM. Upstash, Anthropic, OpenAI and GitHub keys go plaintext into `secrets.json` through unauthenticated PUT routes. It adds a new third-party dependency.
8. **#170, #174, #232, #246 (SKIP): voice.** The ElevenLabs key goes in `secrets.json`. The audio routes are unauthenticated, so anyone who can reach the office can spend the manager's credits. The manager's speech and CEO text go to ElevenLabs.
9. **#254 (SKIP): location disclosure.** Opt-in real weather sends the city and ~1 km coordinates to open-meteo.com.
10. **#274: npm malware scan.** Its commit message says npm's publish-time scan held 0.3.15 and 0.3.16 because hard-coded webhook and bot API calls looked like exfiltration. The fork's `server/telegram.ts` calls `api.telegram.org`, which matters only if the fork ever publishes to npm.
11. **`7177aa7`/`e3058bc`: well-built release workflow.** OIDC trusted publishing, no stored npm token, `persist-credentials: false`, `--ignore-scripts`, and the bump input passed through env. A template if the fork ever publishes.
12. **#181 and #241 (SKIP): minor prompt-injection surfaces.** CI log output in developer prompts; a manager note quoted into the CEO's prompt through an unauthenticated route.

## Open questions

- **Switching an agent's CLI.** `sessionCli` resumes a follow-up on the old CLI after the manager switches the agent's CLI (`swarm.ts:2910-2911`). This looks deliberate, to keep the conversation, and upstream's open #299 changes it. I haven't filed it; the manager should say whether a switch should take effect at once.
- **Verification depth.** None of the "bug present" findings were reproduced in a demo office: #106 re-hand-out, #129 locked desk, #236 busy-on-closed, #286 trust prompt, and the websocket Origin gap. Each issue's tests should show the bug first.
- **Preview code from forks.** Previews already run any open PR's code, including PRs from forks (`previews.ts:125-148`). Whether the fork should refuse cross-repository PRs for previews is a policy question for the manager.
- **Non-Chromium browsers.** I didn't check Firefox or Safari behaviour for cross-site websockets to loopback; that affects how urgent issue 2 is.

## Sources

1. Chrome for Developers, "Local Network Access" (covers WebSocket and WebTransport), read 2026-11-04. https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access
2. Visualware support note, "Chrome LNA and WebSockets" (Chrome 147 enforces LNA on WebSockets; secondary source), read 2026-11-04. https://myconnectionserver.visualware.com/support/v11/userguide/chrome-lna-websocket
3. Upstream repository and PRs, read with `gh pr list/view/diff --repo leonvanzyl/cubefarm` and `git show`, 2026-11-04. https://github.com/leonvanzyl/cubefarm/pulls?q=is%3Apr
4. Fork backport PRs that name their upstream sources: mgscox/cubefarm #69, #70, #71, #72, #73, #74 (and #42, #44, #48, #54, #60). https://github.com/mgscox/cubefarm/pulls?q=is%3Apr

## Recommendation

Port in this order:

1. **Pin the Playwright MCP (#98).** Security, low risk, a handful of files.
2. **Origin check on `/ws` and `/ws/term`** (fork finding, no upstream PR). Security; small, with an existing pattern in `canManage`.
3. **Don't re-hand merged issues; close them on merge (#106).** It stops duplicate sessions and PRs. Bring #177's `close_issue` along, since it shares the Backend method.
4. **Preview env limit in characters (#307).** A small correctness fix that unblocks real projects.
5. **3D client leak and flicker (#179, #61, #186 floor signs).** Low risk; fixes a GPU leak on every floor change.
6. **QA and merge loop: conflicts aren't fails (#140), re-run flaky checks once (#176).** Fewer wasted fix sessions and fewer PRs on the manager's desk.
7. **Stop sessions on closed work (#236, narrow), then the quiet-session watchdog and restart checks (#275, selective).** The biggest reliability gain, but high conflict in `swarm.ts`: do one at a time.
8. **Desk reset reliability (#129)** and the **folder-trust answer (#286).**
9. **CEO planning rules (#185, the #288 rule) and the label `--force` fix.**
10. **Scene re-render and DPR fixes (#306, #261 micro-fixes)**, **single-IP `SWARM_HOST` callbacks (#305)** and **faster local e2e (#97).**

Everything else: SKIP. Nothing that needs porting changes `scripts/office.mjs` or the `~/.cubefarm` layout. Only #305 touches how 4317/5317 bind, and #176/#236 add `state.json` fields.

## Issues to file

Each issue is written to be re-done against the fork's code, not cherry-picked (except #61). Every server issue needs a demo fake in `server/demo.ts` wherever a Backend method is added (CLAUDE.md demo parity).

### 1. Pin the agents' Playwright MCP and start it with node, not `npx @latest`
- **Specialty:** server · **From:** upstream #98
- **Acceptance criteria:**
  - [ ] `@playwright/mcp` is an exact-pinned dependency (a current non-alpha release).
  - [ ] Both runtimes start it as `node <resolved cli.js>`, with no `npx`, no `@latest` and no `cmd /c` (`server/agentRunner.ts`, `server/cliFiles.ts`). A new `server/browser.ts` helper has unit tests for command resolution on win32 and posix.
  - [ ] Codex keeps the `mcp_servers.cubefarm_playwright` key, and the box path still works (it resolves from the box's own install).
  - [ ] `cubefarm doctor` reports the MCP version. `scripts/smoke-package.mjs` checks it resolves from the packed install.
  - [ ] typecheck, test, build and e2e pass.

### 2. Reject cross-origin websocket upgrades on `/ws` and `/ws/term`
- **Specialty:** server · **From:** this review (no upstream PR; upstream has the same gap)
- **Acceptance criteria:**
  - [ ] `server/index.ts` refuses an upgrade whose `Origin` header doesn't match the office's own host. That means loopback names, or, with `SWARM_HOST` set, the office's bound and LAN addresses on `SWARM_PORT` (and on the Vite port in dev). A missing `Origin`, as from non-browser clients, follows a documented rule.
  - [ ] The decision is a pure function with unit tests: same origin, `localhost` vs `127.0.0.1`, LAN IP, foreign origin, missing origin.
  - [ ] The office, the dashboard, the terminal and the e2e suite still connect in demo mode on a reserved port.
  - [ ] No change to agents' tool permissions, consistent with the SAFETY section.

### 3. Don't hand out an issue whose PR the office just merged; close it on merge; give the CEO `close_issue`
- **Specialty:** server · **From:** upstream #106, #177, and the label fix from #288
- **Acceptance criteria:**
  - [ ] `issueTaken` also treats an issue as taken while a PR that closes it (or a `swarm/issue-<n>-` or research branch for it) merged within the last 6 hours. Tested as a pure helper.
  - [ ] After an auto-merge and after `mergePull` (including the CEO's `merge_pr`), the office closes the PR's resolved issues as completed, with a short comment, and drops them from the floor's issue list.
  - [ ] There's a new `Backend.closeIssue(repo, n, reason, comment)` with a `gh` implementation and a demo fake.
  - [ ] A CEO `close_issue` tool (zod schema: floor, number, reason up to 1000 characters) closes an issue as "not planned". It refuses unknown or closed issues and issues an open PR closes, with errors the CEO can act on.
  - [ ] `ensureLabel` no longer passes `--force` to `gh label create`, and treats "already exists" as success.

### 4. Count a floor's preview env in characters, not variables
- **Specialty:** server · **From:** upstream #307
- **Acceptance criteria:**
  - [ ] `shared/previewEnv.ts` defines one size rule (about 16,000 characters across names and values), with tests. `parsePreviewPatch` uses it in place of the 50-variable and 4,000-per-value caps.
  - [ ] The CEO's `set_floor_profile` description and the preview settings form show and enforce the same limit.
  - [ ] The `ANTHROPIC_`/`CLAUDE` refusal is unchanged.

### 5. Fix the outline GPU leak, desk re-renders, the elevator flicker and the floor-sign QA count
- **Specialty:** graphics · **From:** upstream #179, #61, #186
- **Acceptance criteria:**
  - [ ] A local `Outlines` component replaces drei's `<Outlines>` everywhere the fork uses it. It disposes its geometry and material on unmount, and its pure mesh builder has tests.
  - [ ] `Desk` is memoised and receives stable position arrays, including the lobby's CEO and research desks. An agent event re-renders only that agent's desk (checked with React DevTools or `?stats`).
  - [ ] The elevator cabin walls no longer z-fight beside the doorway (upstream `24329a3` applied).
  - [ ] The floor wall signs use `qaCounts()`, so closed PRs don't count.
  - [ ] Demo-office screenshots before and after.

### 6. Re-render and frame-time fixes in the 3D client
- **Specialty:** graphics · **From:** upstream #306 (items 1 and 2), #261 (micro-fixes), #249 (`FrameRateSampler` only)
- **Acceptance criteria:**
  - [ ] Adaptive resolution steps DPR without re-rendering `Game`. A pure `dprControl` has hysteresis, with tests.
  - [ ] The scene re-renders only for its own floor's `repo` events, not every floor's.
  - [ ] One keyboard texture is shared by all desks.
  - [ ] `useCanvasTexture` paints once when fonts are already loaded.
  - [ ] OfficeFloor's store subscriptions use `useShallow`.
  - [ ] No new npm dependencies. No graphics tiers or bloom.

### 7. A merge conflict alone isn't a QA fail; re-run a flaky check once before sending a PR back
- **Specialty:** server · **From:** upstream #140, #176
- **Acceptance criteria:**
  - [ ] The QA system prompt says a conflict with the default branch is not a fail.
  - [ ] A last-round QA fail on a CONFLICTING/DIRTY PR goes to a conflict fix while merge-fix budget remains, not to needs-human. This happens without bypassing the fork's security-review, escalate or incomplete outcomes. It's a pure `qaOutcome` with tests.
  - [ ] The first check failure on a QA-passed head triggers `gh run rerun <id> --failed` once (via a new Backend method with a demo fake), then a short grace period before send-back. A second failure on the same head sends back as today.
  - [ ] Run ids are parsed from check URLs as numbers only, with tests.
  - [ ] New QaRecord fields load with defaults from an older `state.json`.

### 8. Stop sessions on closed issues and PRs, and check work is still open before starting it
- **Specialty:** server · **From:** upstream #236 (narrow)
- **Acceptance criteria:**
  - [ ] When sync finds a BUSY agent's issue closed, or its PR closed without merging, the office stops that session and clears the desk. It does not delete QA records that hold a `securityReview`.
  - [ ] `runTask`/`runFix` re-check that the issue or PR is open before preparing a desk.
  - [ ] CEO-parked PRs and Ideas issues held for publication are left alone.
  - [ ] The decisions live in a pure module with tests, and the demo can close an issue mid-session to show it.

### 9. Watchdog for silent sessions, and a work-state check on restart
- **Specialty:** server · **From:** upstream #275 (selective; after issue 8)
- **Acceptance criteria:**
  - [ ] A session with no hook or terminal activity for a set time gets one office nudge, then is ended and requeued (through `heldRetry`/`requestedStarts`). Each remedy is limited to once per item per period.
  - [ ] On restart, reattached or resumed agents whose issue or PR closed while the office was down are cleared, not resumed.
  - [ ] Desk-existence and activity checks go through `machineFor(a)` and count box hooks, so box agents are never "restored" on the office machine.
  - [ ] Pure decision functions with tests. No doctor UI.

### 10. Desk reset: close the idle CLI first, and recover from a stale `index.lock`
- **Specialty:** server · **From:** upstream #129
- **Acceptance criteria:**
  - [ ] Before a desk is released or reset for new work, an idle kept CLI with that desk as its working directory is closed, and the office waits for it to exit. The exception is when the author's own fix round keeps its conversation.
  - [ ] `prepareDesk` removes an `index.lock` older than 10 minutes, only inside the repo's `.git/worktrees/<desk>`, and retries reuse once. The reuse failure reason is logged.
  - [ ] Works for box desks. Tests cover the lock-age rule and path confinement.

### 11. Answer the folder-trust question from the menu under the latest prompt
- **Specialty:** server · **From:** upstream #286 (closed, unmerged)
- **Acceptance criteria:**
  - [ ] A pure `selectedOption(screen, question)` reads the selection marker only under the last occurrence of the question, and only when exactly one marker is there. It is used by `trustKey` and `hookReviewKey`. Tests cover a stale `❯` prompt line above the question.
  - [ ] The startup watcher also runs for re-adopted CLIs and follow-ups. A follow-up waits while the question is showing.

### 12. CEO planning: whole-feature issues, QA-queue capacity, and no issues filed unasked
- **Specialty:** server · **From:** upstream #185, #288 (the CEO rule only)
- **Acceptance criteria:**
  - [ ] CEO prompts ask for whole-feature issues (1 to 4 per brief), not one per developer, keeping the fork's parent, stalled and ready-for-human guidance.
  - [ ] `company_status` reports PRs awaiting QA per floor, and no longer counts in-progress issues as waiting on others. Pure `floorCapacity` with tests.
  - [ ] `file_issue` refuses, with an actionable error, in CEO jobs other than plan or chat (for example review and onboard). Those prompts say not to file issues, consistent with the Ideas → Issue Plan approval flow.

### 13. Small: single-address `SWARM_HOST` callbacks, and faster local e2e
- **Specialty:** server · **From:** upstream #305, #97
- **Acceptance criteria:**
  - [ ] With `SWARM_HOST` set to one non-loopback address, agent hook and MCP callbacks, `bin/cubefarm.js` probes and Vite proxy targets use an address the server actually listens on, or startup refuses the setting with a clear message. `officeHost` trims and validates its input. Tests cover loopback, `0.0.0.0`, `::` and a single IP.
  - [ ] `npm run test:e2e` uses a locally installed Google Chrome when `CI` is unset, and `E2E_SKIP_BUILD=1` reuses `dist/`. CI behaviour is unchanged. Pure step logic with tests.
  - [ ] The SAFETY section's port guidance is re-read and still accurate.
