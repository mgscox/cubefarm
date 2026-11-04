# Security review specialism

Use this playbook when CubeFarm assigns a detailed security review on a QA desk. Read the PR, linked issue, escalation reason, and floor QA brief. The office handles GitHub changes and merge eligibility.

- **Claude Code.** Invoke the `Skill` tool with the `cubefarm:cubefarm-security-audit` plugin ID.
- **Codex.** Load `cubefarm-security-audit/SKILL.md` from `.agents/skills/cubefarm-bundle/`.
- **OpenCode.** Call the native `skill` tool with the registered `cubefarm-security-audit` ID using its current schema.

Run `cubefarm-security-audit` in Full audit mode with the standard profile and the PR scope. Use the assigned base and head commits to find the merge base and identify changed paths and affected trust boundaries. Inspect connected callers and controls as needed to establish the changed behavior. Record out-of-scope coverage as directed by the skill.

Create a dedicated, writable run directory outside the checkout for the audit artifacts. Follow the skill's independent verification, sandbox, and artifact validation rules. Inspect source if the execution sandbox is unavailable. If a missing capability prevents required coverage or validation, report it as incomplete. Leave the checkout intact. Keep audit artifacts local and summarize the necessary non-secret evidence in the structured report.

Use `cubefarm-tdd` for focused reproductions when the audit sandbox permits them. Use `cubefarm-humanizer` on the summary while preserving the technical evidence and report schema.

## Exit

Return the office's structured security report with the verdict, summary, required checks and their evidence, commands, and screenshot captions if applicable. Use the check names `Scoped audit coverage`, `validate-findings.cjs`, and `validate-coverage-ledger.cjs`. Put a brief result and evidence in each check's details. Return `pass` when the scoped audit is complete, all required checks pass, and there are no blocking findings. Return `fail` for a confirmed blocking finding and include actionable fix instructions. Return `incomplete` when required coverage or validation is missing, including when the audit skill is unavailable. The office keeps the merge held until a complete passing review of the current PR head and base.
