# Security review specialism

Use this playbook when CubeFarm assigns a detailed security review on a QA desk. Read the PR, linked issue, escalation reason, and floor QA brief. The office handles GitHub changes and merge eligibility.

- **Claude Code.** Invoke the `Skill` tool with the `cubefarm:cubefarm-security-audit` plugin ID.
- **Codex.** Load `cubefarm-security-audit/SKILL.md` from `.agents/skills/cubefarm-bundle/`.
- **OpenCode.** Call the native `skill` tool with the registered `cubefarm-security-audit` ID using its current schema.

Run `cubefarm-security-audit` in Full audit mode with the standard profile and the PR scope. Use the assigned base and head commits to find the merge base and identify changed paths and affected trust boundaries. Inspect connected callers and controls as needed to establish the changed behavior. Record out-of-scope coverage as directed by the skill.

Create a dedicated, writable run directory outside the checkout for the audit artifacts. Follow the skill's independent verification, sandbox, and artifact validation rules. Inspect source if the execution sandbox is unavailable. If a missing capability prevents required coverage or validation, report it as incomplete, except for the desk sandbox limit below. Leave the checkout intact. Keep audit artifacts local and summarize the necessary non-secret evidence in the structured report.

Use `cubefarm-tdd` for focused reproductions when the audit sandbox permits them. Use `cubefarm-humanizer` on the summary while preserving the technical evidence and report schema.

## Desk sandbox limit

A missing OS sandbox alone is a known desk limit. Finish source review, independent verification, and artifact validation without executing target code. This scoped PR policy takes precedence over the audit skill's generic incomplete rule for this limit only. Do not invent a vulnerability or a `needs_validation` finding solely because the desk lacks a sandbox.

When this is the only gap, normal QA/CI gates passed for the reviewed revision, and there are no blocking findings, return `pass` with `validationGap: "no-os-sandbox"`, `normalGatesPassed: true`, and `blockingFindings: "none"`. Record gate evidence in checks and include exactly "dynamic validation not run: no OS sandbox on this desk" in the summary; the office publishes it in the PR comment. An optional `Dynamic validation` check may be `skip` with this explanation. The three required audit checks must still pass with evidence.

Confirmed blocking findings (including high/critical findings) set `blockingFindings: "confirmed"` and fail. High/critical `needs_validation` findings set `blockingFindings: "needs_validation"` and hold, including source-grounded candidates with potentially high/critical impact whose severity is unassigned by the skill. Missing source coverage, artifact validators, skills, or other required validation remains `incomplete` with `validationGap: "other"`. Never use the sandbox exception to dismiss a finding.

For a sandbox-only `incomplete` result that meets the passing conditions, the office retries once on another available QA tester, without charging a QA round. If none is available, or the retry has the same limit, it applies the passing policy above.

## Exit

Return the office's structured security report with the verdict, summary, required checks and their evidence, commands, and screenshot captions if applicable. Use the check names `Scoped audit coverage`, `validate-findings.cjs`, and `validate-coverage-ledger.cjs`. Set each required check's `result` to `pass` when it passed or `fail` when it failed; `skip` makes the review incomplete except for the `Dynamic validation` desk limit above. Put a brief result and evidence in each check's details. Return `pass` when the scoped audit is complete, all required checks pass, and there are no blocking findings. Return `fail` for a confirmed blocking finding and include actionable fix instructions. Return `incomplete` when required coverage or validation is missing, including when the audit skill is unavailable; the desk sandbox limit above is the only exception. Set `validationGap` to `none`, `no-os-sandbox`, or `other`, `normalGatesPassed` from gate evidence, and `blockingFindings` to `none`, `confirmed`, or `needs_validation`. The office keeps the merge held until a complete passing review of the current PR head and base.
