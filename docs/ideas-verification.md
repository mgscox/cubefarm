# Ideas workflow verification

Issue #149 connects the research, planning, review, decision, publication and dispatch slices. Research and all subsequent agent phases use the existing research session slot, office closure and usage pacing. Two different agents review the same saved pair; neither receives the other's verdict. Reviews can run consecutively while keeping their inputs independent.

The approval card stores the complete displayed graph, including Tracking Parents, specialties, reused issues and blocker keys. Approval goes directly to the held-first publisher. The persisted approval and publication identities survive retries and restarts. Existing slice demo buttons remain available for testing those slices independently; close the demo office while exercising them so the automatic worker cannot claim the same Idea. They are not needed for the connected path.

## Stateful emulation and demo

Run stateful emulation before hosted checks:

```sh
npm test -- server/ideaWorkflow.test.ts server/ideasWorkflow.test.ts server/publication.test.ts server/swarm.test.ts server/approvedBlockers.test.ts shared/ideaReview.test.ts
E2E_PORT=5324 E2E_SWARM_HOME="$PWD/.swarm-e2e" npm run test:e2e
```

| Scenario | Evidence |
| --- | --- |
| Description only → exact reviewed pair → one approval | `ideasWorkflow.test.ts` submits through Swarm with the stateful demo backend, receives two independent reviews, flags a newer draft, approves concurrently and reads back the published issue. `e2e/ideasWorkflow.spec.ts` opens View PRD, returns to the card, approves once, repeats the decision, and verifies complete publication. |
| Whole cross-floor graph and dispatch | Connected emulation publishes a parent and two leaves on different floors. Publication tests check reuse, full-graph verification before release and release progress. Swarm tests cover both start paths, stale/missing/unreadable approved blockers and completed delivery. |
| Three rounds, refinement and rejection | Connected emulation caps disagreement at three rounds, preserves findings, starts a fresh review cycle for substantive feedback, returns cosmetic changes directly for a new decision, archives rejection and starts a linked Idea. It asserts no publication before approval. |
| Refused write, lost create and restart during release | Connected emulation refuses the second floor after the first accepts held issues, loses a create response, restores access and reuses identities. Another scenario loses the first release response and starts a new Swarm from the saved state with the same fake tracker, completing without another approval or duplicate marker. |

Demo descriptions accept `[clarify]`, `[cross-floor]` and `[disagree]` to exercise the corresponding paths using deterministic output. The normal description-only path requires no fixture command. Browser screenshots are captured by `e2e/ideasWorkflow.spec.ts`. The [connected approval card](screenshots/issue149-connected-review.png) and [exact paired PRD](screenshots/issue149-exact-prd.png) were also inspected through the browser tools.

## Hosted native relationship evidence

After stateful emulation passed, on 2026-11-03 the available GitHub CLI identity (`gh api user`: `mgscox`) created two disposable private repositories:

- `mgscox/cubefarm-ideas-149-check-a`: Tracking Parent #1 and dependent #2.
- `mgscox/cubefarm-ideas-149-check-b`: prerequisite #1.

All three issues were created with `[Draft]` titles. Native cross-repository writes succeeded:

- `POST repos/...-a/issues/1/sub_issues`, `sub_issue_id=6193115519`.
- `POST repos/...-a/issues/2/dependencies/blocked_by`, `issue_id=6193115519`.

Both relationship GETs returned repository B's issue URL. The production `server/github.ts:listIssues` reader then returned:

```json
{"number":1,"subIssues":{"total":1,"completed":0},"nativeBlockers":[],"reason":"parent or PRD"}
{"number":2,"subIssues":{"total":0,"completed":0},"nativeBlockers":[{"number":1,"state":"OPEN","repo":"mgscox/cubefarm-ideas-149-check-b"}],"reason":"open blockers"}
```

Here `reason` is `shared/issues.ts:issueWaitReason`, evaluated with the draft prefix removed to isolate native metadata readiness. After closing B#1 with `state_reason=completed`, the same production reader returned a `CLOSED` native blocker and a null wait reason for A#2. The parent's summary still reported `completed: 0` in that immediate read; Tracking Parents remain held regardless of that count. Both disposable repositories were deleted after verification.

This hosted drill is separate from the publisher's reciprocal body links and persisted approved-blocker graph. It verifies native cross-repository writes and the ordinary dispatch reader under the available CLI credentials; it does not run a real office or start implementation agents. No live office state or ports were used.

## Local check results

- `npm run typecheck`: passed.
- `npm test`: 90 files passed; 1,525 tests passed, two skipped and one existing todo.
- `npm run build` and `node scripts/smoke-package.mjs`: passed.
- Initial local evidence on `9585d53`: 30 of 32 passed, followed by seven targeted passes after resolving a LAN proxy 407 and a concurrent-build collision in MCP settings. Those passes did not establish a reliable full-suite result: [CI run 41741986921](https://github.com/mgscox/cubefarm/actions/runs/41741986921) on that same head failed the fixture-driven Issue Plan test (31 passed, one failed). The test now closes and drains the demo office, restores any source issues completed by earlier tests before recording its write baseline, checks that automatic research/proposals did not run for the fixture Idea, and restores the previous office state in `finally`.
- Independent standards and specification re-reviews found no remaining actionable issues.

## Limits

Real paid research/review sessions, other deployed credentials, mixed-visibility permissions and Windows execution were not exercised locally. Those checks require their respective services or CI runners. Hosted refusal and lost-response behavior was exercised with the stateful fake tracker, not by changing live GitHub access. Demo evidence is illustrative research, not validation of a product Idea's assumptions.
