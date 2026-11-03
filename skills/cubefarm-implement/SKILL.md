---
name: cubefarm-implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

For an issue, use GitHub Issues for the assigned CubeFarm floor. Read the issue with `gh issue view <number> --repo <owner>/<repo>` and follow its linked spec and blockers. Take the repository from the assignment or the worktree's Git remote.

Use the issue's existing GitHub labels as workflow signals. `needs-triage`, `needs-info`, `needs-human`, and `ready-for-human` hold agent work. `swarm:skip` excludes automatic assignment, `swarm:research` routes to researchers, and other `swarm:<specialty>` labels guide assignment. `ready-for-agent` can signal readiness, but CubeFarm does not require it. Follow the assignment for any label changes.

Use the cubefarm-tdd skill where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Before committing, review the diff against the repository's documented standards and the GitHub issue or supplied spec. Fix actionable findings and rerun the affected checks.

Commit your work to the current task branch. When the assignment calls for opening a PR, follow the repository's instructions and link its issue with `Closes #<number>`.
