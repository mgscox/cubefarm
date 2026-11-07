# Run history

The office records every attempt at an issue or pull request, including work that never reached a PR, so a manager
can see what happened to it and analyse agents and workers later. Open a floor's **Kanban** and expand **Run history**,
or export it as JSON:

```
GET /api/run-history?repoId=<owner/name>[&issue=<n>][&pr=<n>][&download=1]
```

The open table updates from the office's websocket snapshot and attempt events, including cancellations and PR
closure or merge. Export is a point-in-time download. A queued start keeps its attempt ID with the request, so
Stop, Clear desk, letting its developer go, or closing its issue also ends the waiting attempt.

## What an attempt is

An attempt is one task on one desk, from assignment to its end: an issue (or prototype or research issue), a QA run,
or a fix. When the office starts another session on the same work (a retry after a run with no PR, a QA resume for a
missing report, a resume after a restart, a follow-up the manager sends), the attempt ends and a new one starts with
`parentId` set to it. A QA run or fix's parent is the latest attempt on the same PR, so the chain goes from the issue
attempt that opened the PR through each QA round and repair to the merge.

Each attempt records:

- **Work**: repository, task (`issue`, `prototype`, `research`, `qa`, `fix`), the issue's `swarm:<specialty>`, issue
  and PR numbers, the QA `reviewId` and round, and for fixes the repair id from the PR's contribution history.
- **Assignment**: why it went to this desk (`manager`, `ceo`, `requested`, `auto`, `qa-queue`, `repair`, `retry`,
  `follow-up`, `resume`) and the routing factors the office had: specialty match, score, free developers and
  specialists, how many issues it holds up, earlier crashes.
- **Runtime**: the CLI, model and effort the office asked for (a null model is the CLI's own default; the CLIs don't
  report the model they actually used), the playbook as `<name>@<sha256 prefix>` of its text, and the office version.
- **Worker**: the box (or `office`) and its health at the start and end: status, CPU/memory/IO constraints and CPU.
- **Revisions and sessions**: the starting and submitted commit, and the CLI session ids. Prompts, transcripts and
  screenshots are never stored.
- **Times**: assigned, started and ended. The export adds `queueMs` and `runMs`.
- **Usage**: sessions, cost and turns. `null` means the measurement wasn't available (Codex and OpenCode don't
  report cost); `0` is a reported zero. One session with an unknown cost makes the attempt's total unknown.
- **Events**: assigned, waiting, started, reattached, session-ended, ended.
- **Outcome**: a result and who ended it, as far as the evidence shows:

| Result | Meaning |
| --- | --- |
| `delivered` | the issue session opened a PR the office verified |
| `no-pr` | it ended without a PR (retried once, then back to the backlog) |
| `qa-passed`, `qa-failed` | the QA verdict |
| `worker-blocked` | QA passed the change, but the worker stopped local validation: merge waits for CI |
| `repaired`, `no-change` | a fix pushed new commits, or didn't |
| `prepare-failed`, `start-failed` | the desk couldn't be set up, or the CLI never started |
| `failed` | the session failed |
| `stopped`, `cleared`, `interrupted`, `deferred`, `superseded`, `closed` | the manager stopped it or cleared the desk, the office restarted, closed or replaced it, or its issue or PR closed |

Causes are `agent`, `worker` (desk, box, CLI startup, disk or memory), `provider` (usage limits, rate limits, API
errors), `manager`, `office`, `external` (GitHub) and `unknown`. A pending attempt has no outcome yet; one waiting for
a desk has no start time either.

## Storage and retention

The history lives in `<SWARM_HOME>/run-history.json` (`demo-run-history.json` in the demo), apart from `state.json`,
so pruning QA records, merging PRs and letting agents go leave it alone. It stays on this machine.

- Attempts that started and haven't ended are always kept.
- Ended attempts are dropped 180 days after they ended (a wait for a desk that never started, 180 days after it was
  assigned), and the oldest ended ones go once there are more than 5,000.
- Excerpts are optional and bounded: only an outcome's reason (an error message, say) and short event notes, on one
  line, at most 240 characters, with tokens, keys, passwords and credentials in URLs replaced by `[redacted]`.

## Trying it in the demo

In a demo office with auto-assign on, file an issue whose title contains `[no-pr]` (its session ends without a PR)
and one containing `[worker-blocked]` (its PR's first QA desk fails with a full disk and QA is retried). The floor's
run history then shows the merged PR, the no-PR attempt and the worker-blocked retry with its parent.
