# Playbook evaluations

Open a floor's **Kanban → Playbook evaluations**. Choose an approved lesson, a pinned case ID and expected
behavior, then the recorded base run and candidate replay of that case. Select the metric and expected value.
**Save evaluation** compares their structured evidence and saves a local report of comparable attempts in the
persisted run history at that time. Repeating it after more runs creates another immutable evaluation.

A maintainer runs the pinned task with each playbook version using their normal workflow before comparing it here.
Use the same case inputs, runtime, worker and test expectations for both runs; the case ID identifies that fixture.
The evaluator checks the recorded evidence, not the task's prose. It neither launches paid sessions nor rewrites
playbooks. The manager reviews the lesson, pinned results and live cohorts before deciding to adopt guidance.

Each saved evaluation keeps the approved lesson version, both playbook hashes, pinned attempt IDs, expected
behavior and metric, observed result, revisions, runtime, worker context and QA evidence IDs/links/summaries.
These compact facts survive source pruning. Summaries are redacted and bounded; raw commands, prompts, logs,
transcripts and screenshots are excluded. Artifact links are not fetched. A missing link is shown explicitly;
an expired external artifact leaves its structured result and summary intact. Link availability is unchecked.

## Reading the report

The report selects attempts on the lesson's repository and specialty (all specialties for an unscoped lesson),
with either the base or candidate playbook hash. Other playbooks and unknown hashes are excluded. All matching
attempts, including failed starts, no-PR attempts and pending work, remain inspectable in the JSON export.
It groups by repository, specialty, task, requested CLI/model/effort, office version, playbook, worker ID and
start/end health status and constraints. CPU percentages remain context, rather than splitting each measurement
into a new cohort. Compare base and candidate rows only when their other context matches. A pinned pair with
unequal context is flagged as confounded; unequal live cohorts remain separate. A null model means the CLI's
default was requested; the effective model is unknown.

Every metric shows a numerator and denominator plus separate incomplete, unknown and not-applicable counts:

- **First-pass QA**: original issue/prototype attempts whose first recorded QA round was round 1, on their exact
  submitted revision. An exact pass counts yes; a confirmed code finding counts no. A worker-only or incomplete
  review is incomplete. A missing round, missing revision, no-PR run, stale review or unconfirmed failure is
  unknown. A pending run with no QA is incomplete. QA, research and fix attempts are not applicable.
- **Verified repair**: fix attempts with a confirmed code defect on their starting revision, reviewed before
  assignment. The latest exact independent QA on the submitted revision must pass and the revision must change
  to count yes. A still-confirmed inherited defect counts no, as does a no-change handoff with a known defect.
  A pushed commit alone is unknown. Self repairs may count when independently verified: this measures code
  outcomes, not score credit. Repairs without known inherited defects (including conflict work) are unknown.
  Pending work and worker-blocked verification are incomplete. Other tasks are not applicable.
- **Worker blocked**: a recorded worker-caused outcome or worker finding in the QA evidence used for that attempt counts yes (including its first review or repair verification).
  Findings recorded before assignment remain audit evidence and do not count as that attempt's worker blocks.
  A known other cause counts no, an unknown cause stays unknown, and pending work is incomplete. Resource
  pressure alone never proves a block. Mixed reviews may show both a code failure and a worker block.

Only yes/no observations enter a rate's denominator. Counts below five are marked as small samples, including
individual metric denominators. Zero-denominator rows remain visible; they do not mean a zero success rate.
Pinned yes/no results indicate whether the observed metric matches the expected value. Unknown and incomplete
results remain unresolved. These are observational comparisons, not causal proof or an agent ranking.

## API

```
POST /api/repos/<encoded-owner/name>/evaluations
{
  "lessonId": "<approved lesson id>",
  "basePlaybook": "developer@111111111111",
  "candidatePlaybook": "developer@222222222222",
  "cases": [{
    "id": "toolbar-375px",
    "expectedBehavior": "All toolbar buttons are reachable at 375px on the first QA pass.",
    "metric": "firstPassQa",
    "expected": true,
    "baseAttemptId": "<base recorded run>",
    "candidateAttemptId": "<candidate recorded replay>"
  }]
}
GET /api/evaluations?repoId=<owner/name>&download=1
```

The API accepts 1–20 uniquely named pins. Metrics are `firstPassQa`, `verifiedRepair` and `workerBlocked`.
Pins must belong to the approved lesson's scope, match their side's distinct versioned playbook and support
the selected metric. State is saved before the websocket evaluation event; reconnects restore saved evaluations.
Results are stored in the office's local state, without automatic adoption or publication.

## Isolated demo

In a demo office, click **Run pinned demo evaluation** (or POST `/api/repos/<repo>/evaluations/demo`). It seeds
an approved viewport lesson, a base failure and a candidate pass for `toolbar-375px`, an independently verified
repair, a worker startup failure, pending work and unknown evidence. It then evaluates that pin through the same
comparison and persistence path. No GitHub, agent session or external artifact is needed. The report shows
base first-pass QA 0/1, candidate 1/1 with two unknown and one incomplete, candidate repairs 1/1, and candidate
issue worker blocks 1/2 with one unknown and one incomplete. All samples are small; the artifact URLs are missing.
The fixture endpoint is unavailable outside demo mode.
