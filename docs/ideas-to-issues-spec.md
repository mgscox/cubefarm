# CubeFarm Ideas to Issues

## Problem statement

CubeFarm dispatches work from repository issues. A manager with a rough idea still has to coordinate research, decide which repositories are involved, and turn the result into a backlog before that workflow can begin.

## Solution

Submitting an Idea queues research. Agents produce one PRD and an Issue Plan, then review and refine the proposal. The manager receives one approval card. Approving publishes the displayed plan across configured floors and hands the verified implementation issues to CubeFarm’s existing workflow.

## Implementation status

The implementation on `main` includes Idea intake and research, revisioned PRDs and Issue Plans, review and manager decisions, cross-floor publication with recovery, and approved blocker checks on both dispatch paths. The merged slices verified publication and dispatch with unit tests and an isolated demo using a fake tracker. Publication records hierarchy and dependency links as repository-qualified URLs in issue bodies. Dispatch enforces the approved blockers from the saved plan.

End-to-end acceptance under the intended GitHub credentials remains open. It includes native cross-repository relationship writes and dispatch read-back in disposable repositories, with stateful emulation before live testing. [Cross-floor publication](https://github.com/mgscox/cubefarm/pull/170) · [Approved blocker checks](https://github.com/mgscox/cubefarm/pull/169) · [Integration acceptance](https://github.com/mgscox/cubefarm/issues/149)

## User stories

1. As a manager, I want to submit an Idea with a short description so I can start research before I know the affected repositories.
2. As a manager, I want to answer a blocking question on the Idea so research can resume in context.
3. As a lead researcher, I want to select target floors and request focused evidence so I can produce one PRD for the entire Idea.
4. As a reviewer, I want to assess a specific PRD revision and record my findings independently so the lead can act on them.
5. As a manager, I want an approval card with the proposed issues, target floors, dependencies, and unresolved findings so I can decide in one place.
6. As a manager, I want the card’s **View PRD** link to open the exact paired revision so I can verify what the plan implements.
7. As a manager, I want to approve the displayed plan, request refinement, or reject it so I can direct work without editing issue briefs myself.
8. As a planner, I want to reference existing work and optionally group related deliverables so the Issue Plan avoids duplicate tickets and preserves parallelism.
9. As a developer, I want my published issue to contain a clear scope, acceptance criteria, and dependencies so I can start it when its prerequisites are satisfied.
10. As a manager, I want publication to recover automatically when possible and show issue links and blockers so I only need to act when agents cannot recover.

## Requirements and implementation decisions

### Intake and research

- Require a short description of the problem or desired outcome. Accept optional links, constraints, and floor hints. Queue on submission. Show the description, hints, and **Queued**, **Researching**, or **Needs clarification** during intake. A reply on the Idea lets blocked research resume.
- Assign one lead researcher to select target floors, reuse relevant research with source links, and ask floor researchers or specialists for focused evidence when needed. Only configured floors can be publication targets. Treat the manager’s initial floor hints as input to research.
- Keep one PRD for the Idea. Include the problem, desired outcome, scope, linked evidence, unresolved assumptions, reasons for selecting each floor, and measurable acceptance criteria.

Sources [Intake decision](https://github.com/mgscox/cubefarm/issues/134#issuecomment-6607661796) · [Research and review decision](https://github.com/mgscox/cubefarm/issues/135#issuecomment-6607769922)

### Review and manager decision

- Run two independent reviews by agents who did not write the PRD. Both reviews must identify the same PRD revision. One covers evidence, requirements, and success criteria. The other covers feasibility, floor selection, and cross-repository dependencies. Record each reviewer’s endorsement or findings on the Idea.
- Count both reviews of the initial revision as round one. If both endorse the same revision, promote it immediately. Otherwise, the lead can revise and resubmit up to three rounds total. At the cap, promote the latest PRD with both review outcomes and the unresolved findings.
- Present one compact approval card for a Proposal, a specific pair of PRD and Issue Plan revisions. Show the planned issues, target floors, dependencies, reused issues, and unresolved findings. Provide the direct **View PRD** link to the paired revision, access to the full issue briefs, and review history on demand.
- Make **Approve** the primary action and **Reject** and **Request refinement** secondary. Approval queues publication of the displayed pair without another confirmation. If newer drafts exist, flag their availability and allow the displayed pair to be approved while its decision remains open. A repeat or concurrent decision cannot trigger a second publication for the same Proposal.
- Record refinement feedback on the Idea. Substantive changes go through a fresh review cycle of up to three rounds. Wording changes can return directly to the manager. A revised Proposal always requires a new decision. Rejection archives the Idea and its PRD, Issue Plan, and review and decision history. A linked new Idea can reuse that history as context.

Sources [Research and review decision](https://github.com/mgscox/cubefarm/issues/135#issuecomment-6607769922) · [Manager decision and card](https://github.com/mgscox/cubefarm/issues/137#issuecomment-6607925431)

### Issue Plan

- The lead researcher prepares the plan with specialist help as needed. Each new implementation issue has an actionable title, configured floor and repository, one-session scope, measurable acceptance criteria, a reference to the relevant PRD requirement, and any actual blockers. An existing specialty is an optional routing hint.
- Keep plans flat by default. Add a Tracking Parent when related deliverables benefit from grouped progress. Store hierarchy separately from dependencies. Use stable plan references or repository-qualified issue URLs for dependency endpoints. Check the dependency graph for cycles before presenting it.
- Reference existing issues that cover the work and label them as existing on the card. Leave their bodies, hierarchy, and routing untouched. For partial overlap, scope a new issue to the gap and reference the existing issue for context or as a blocker.

Source [Draft Issue Plan decision and two-floor example](https://github.com/mgscox/cubefarm/issues/138#issuecomment-6607994107)

### Publication and dispatch

- Persist the approved revisions and publication progress before GitHub writes. Preflight target floor configuration, repository access, holds, existing references, and the dependency graph. Changes to an approved target, scope, or dependency require a revised Proposal and a new decision.
- Create each new issue with a dispatch hold in the create request. Use a draft title so the hold applies even if a label is dropped. Persist a stable ID for each plan entry and include it in the issue body. Record each GitHub URL. Wire the approved hierarchy and dependencies, then verify issue contents, relationships, and blocker visibility to dispatch. Keep all newly created issues held until the entire plan is verified.
- After verification, release implementation issues into the existing workflow and keep Tracking Parents held. Enforce the approved blockers for Idea issues on both automatic and explicit starts. A missing or unreadable blocker, or a closed prerequisite whose delivery is unclear, keeps the dependent work held while CubeFarm investigates.
- Serialize publication of the same approved plan. Reconcile the stable ID after an uncertain create and reuse a verified issue. If identity or outcome remains uncertain, keep the affected work held and surface the discrepancy. Retry temporary errors and resume after a restart, including during the issue-by-issue release phase.
- Show publication in progress, blocked, or complete on the Idea, with available issue links and any blocking cause. Ask the manager only when recovery requires access or a decision agents cannot supply. When repository access is restored, continue the original approved plan.

Sources [Publication decision](https://github.com/mgscox/cubefarm/issues/139#issuecomment-6608034755) · [GitHub and dispatch evidence](https://github.com/mgscox/cubefarm/issues/136/artifacts/1)

## Acceptance scenarios

| Scenario | Observable result |
| --- | --- |
| Single-floor Idea with only a description | Submission queues research. The lead selects a configured floor. Two independent endorsements can promote the first PRD revision. The card shows the plan and its paired **View PRD** link. One approval publishes the exact displayed plan even if a newer draft exists. A duplicate approval creates no second set of issues. |
| Cross-floor plan with independent and dependent work | The plan shows an optional Tracking Parent, new work on both floors, and a reused issue where appropriate. The approved hierarchy and dependencies read back correctly. The parent stays held and reused work is untouched. Independent work can start after release. Dependent work waits on both start paths, including when a blocker is unreadable or closed without confirmed delivery. |
| Refinement and rejection | Persistent reviewer disagreement promotes the latest PRD after the third round with findings visible. A substantive manager refinement starts a fresh review cycle, while wording changes can return directly. No issues are created before approval of the revised Proposal. Rejection archives the history, and a linked new Idea can reuse it. |
| Recoverable publication interruption | Repository A accepts a held issue, repository B refuses writes, and no new work starts. After access is restored, a retry finds and reuses the issue in A by its stable ID, verifies the complete plan, and releases it. Exercise a create whose response was lost and a restart during release. The Idea shows accurate status and links, with no duplicate issues or second approval. |

Use CubeFarm’s existing demo backend and scheduler fixtures to exercise the workflow through observable commands and state. Inject partial writes, lost responses, unavailable blocker metadata, duplicate decisions, and restarts at the tracker boundary. The planning investigation verified same-repository GitHub relationships and local dispatch fixtures.

## Out of scope

- Publishing to repositories outside configured CubeFarm floors.
- Redesigning development, QA, merge, or the scheduling behavior of ordinary issues.
- Executing the issues produced by an Idea as part of the Ideas workflow itself.
