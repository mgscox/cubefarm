# Developer specialism

Use this playbook for CubeFarm developer issue work and PR repairs. The desk's job brief defines project ownership and local constraints. Follow the office instructions, repository rules, and assigned issue throughout.

- **Claude Code.** Invoke the `Skill` tool with the `cubefarm:` plugin namespace, for example `cubefarm:cubefarm-ponytail`.
- **Codex.** Load the matching `SKILL.md` from `.agents/skills/cubefarm-bundle/`.
- **OpenCode.** Call the native `skill` tool with the registered skill ID using the tool's current schema. On OpenCode v2, use `skill({ id: "cubefarm-ponytail" })`.

Try loading the applicable skill before using the phase's fallback, and record any fallback you use.

## 1. Prepare

- Use `cubefarm-ponytail` to get oriented. If unavailable, read the issue, repository instructions, and the relevant code and tests directly.
- Use Context7 MCP when an implementation decision depends on a library or API. Check the version the repo uses. If Context7 is unavailable, use the repo's installed types, source, or official documentation for that version.
- For a PR repair, read the existing PR, linked issue, and the QA findings or failing check before making changes.

Move to Build once you can state the change to make, its acceptance criteria, and the constraints on testing it.

## 2. Build

Pick the primary route from the work in front of you.

| Work | Route |
| --- | --- |
| Feature | Use `cubefarm-implement` with the assigned issue as the spec. |
| Bug or regression | Use `cubefarm-diagnosing-bugs`. Reproduce the failure and isolate the cause before changing code. |
| Refactor | Use `cubefarm-codebase-design` to identify the seam and the behaviour that must be preserved. |
| Merge conflict | Inspect both sides of the conflict and preserve their intended changes. Follow CubeFarm's instructions for the existing PR branch. |

Use `cubefarm-tdd` when a focused test can capture a regression or prove new behaviour. If a skill is unavailable, follow the route's intent using the repo's existing workflow. Keep changes scoped to the issue or requested repair. Move to Check when the implementation and its targeted tests are ready to review.

## 3. Check

- Use `cubefarm-verification-before-completion` to gather fresh evidence for the current diff. If unavailable, run the relevant checks directly. Record the commands, what they proved, and what remains unverified. Follow the desk brief and repository guidance for required checks.
- If Chrome or Playwright hits a proxy error, blank page, or navigation timeout on a local or LAN preview, read `cubefarm-browser-proxy-resolve`. Confirm the route from the browser host and rerun the affected browser check before handing off.
- Use `cubefarm-code-review` to review the diff against the issue and the repo's conventions. If unavailable, perform that review directly. Keep review feedback in the session and address it before hand-off.
- Use `cubefarm-humanizer` if available and useful to make the hand-off easy to read. Preserve the evidence, caveats, and exact issue reference.

Return to Build for actionable failures and rerun the affected checks after fixing them. A check that needs a person, device, service, or another OS belongs in the hand-off with the reason it remains unverified.

## 4. Hand-off

For an issue, commit and push the assigned CubeFarm branch. Open a PR against the floor repository's default branch with `Closes #<issue number>` in the body. State what changed, what you verified, what remains unverified, and any assumptions. Open it ready for review when the implementation is complete. If the implementation itself is unfinished, open a draft and explain what remains. End the final reply with the GitHub PR URL on its own line.

For a QA, check, or conflict repair, push a new commit to the existing PR branch and briefly report the fix and verification. Keep the existing PR as the hand-off. CubeFarm queues or requeues the PR for independent QA through its existing workflow. The developer stops after handing off the PR and leaves the merge to the office or manager. The PR is the hand-off record.
