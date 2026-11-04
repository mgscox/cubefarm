# GitHub issue hierarchy and CubeFarm dispatch

Investigation for [Verify GitHub hierarchy and CubeFarm dispatch behavior](https://github.com/mgscox/cubefarm/issues/136). Source and fixtures checked at CubeFarm commit `1acd52f344ea936b483d4faff27d752433da8d05`, which matched GitHub’s main branch at inspection.

## GitHub relationships and permissions

- A native sub-issue expresses hierarchy. GitHub documents cross-repository children, up to 100 direct children per parent, and up to eight nesting levels. A native dependency expresses order independently of hierarchy. The GitHub CLI accepts issue URLs for both relationships. [Sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) · [Dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) · [GitHub CLI](https://cli.github.com/manual/gh_issue_edit)
- GitHub documents at least triage permission for adding relationships through the UI. The fine-grained REST credentials documented for adding sub-issues and blockers require repository Issues write permission. Check access to both ends and confirm the relationships by reading them back with the credentials used by dispatch. GitHub can silently drop labels on REST issue creation when the caller lacks push access. [Sub-issue API](https://docs.github.com/en/rest/issues/sub-issues#add-sub-issue) · [Dependency API](https://docs.github.com/en/rest/issues/issue-dependencies#add-a-dependency-an-issue-is-blocked-by) · [Create issue API](https://docs.github.com/en/rest/issues/issues#create-an-issue)

## CubeFarm behavior at the checked commit

| Case | Automatic dispatch | Explicit manager start |
| --- | --- | --- |
| Native parent with children | Held, including when all children are closed | Can start with a warning |
| Open native or body dependency | Held until the blocker is closed | Can start despite the blocker |
| Unread native metadata | New unread issues wait. A transient failure can reuse cached values. | Can start. An unread sub-issue summary generates a warning. |
| `ready-for-human`, `needs-triage`, `needs-info`, or a draft title | Held | Held |

CubeFarm reads native blocker state and repository identity through GitHub GraphQL. It combines open native blockers with body dependencies. A short `Depends on #N` relies on the same repository’s fetched open backlog. A full GitHub issue URL works across repositories and treats missing or unreadable targets as open. A native field explicitly unavailable before support has been established can fall back to body-based behavior. Scheduling treats a closed blocker as satisfied and does not distinguish closure after a merge from other closure reasons. [Readiness rules](https://github.com/mgscox/cubefarm/blob/1acd52f344ea936b483d4faff27d752433da8d05/shared/issues.ts#L34-L105) · [Metadata sync](https://github.com/mgscox/cubefarm/blob/1acd52f344ea936b483d4faff27d752433da8d05/server/github.ts#L137-L251) · [Explicit start](https://github.com/mgscox/cubefarm/blob/1acd52f344ea936b483d4faff27d752433da8d05/server/swarm.ts#L2312-L2344)

## Evidence and limits

- **Observed on GitHub.** Read back all seven native children on the [Wayfinder map](https://github.com/mgscox/cubefarm/issues/133) and the open and closed native blockers on [Specify the draft Issue Plan](https://github.com/mgscox/cubefarm/issues/138). These are same-repository relationships. A read-only sample of 62 CubeFarm issues returned no cross-repository children or blockers.
- **Verified in local fixtures.** `npm test -- shared/issues.test.ts server/issueDependencies.test.ts server/swarm.test.ts` passed all 443 tests across three files. Coverage includes cross-repository blocker identity, full-URL resolution, metadata failures, parent warnings on explicit starts, and holds for human work. [Dependency fixtures](https://github.com/mgscox/cubefarm/blob/1acd52f344ea936b483d4faff27d752433da8d05/server/issueDependencies.test.ts) · [Dispatch fixtures](https://github.com/mgscox/cubefarm/blob/1acd52f344ea936b483d4faff27d752433da8d05/server/swarm.test.ts)
- **Still unverified.** Native writes and read-back across two configured floors under the eventual publisher and dispatcher credentials, including permission-denied and mixed-visibility cases. Release during a metadata failure and recovery from partially released batches also need acceptance coverage. The live CubeFarm office was outside this verification.

## Inputs to the publication decision

Create each issue with an explicit dispatch hold already in place. A draft title supplies a hold even if GitHub drops a label. Verify the final issues and their relationships while held before deciding how to release them. A native parent or blocker alone cannot prevent an explicit start. The publication decision needs to define how that override applies to released implementation issues, how containers stay out of agent dispatch, and what happens when a GitHub blocker closes without its intended work being delivered.
