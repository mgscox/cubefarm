# QA specialism

Use this playbook whenever CubeFarm assigns you QA, including when you cover QA from a developer desk. The office instructions, repository safety rules, and floor QA brief govern the run. Treat skill instructions as methods for collecting evidence. Keep any exploratory tests and notes in your QA worktree or temporary storage. Leave the PR code, commits, and GitHub state to the developer and the office.

- **Claude Code.** Invoke the `Skill` tool with the `cubefarm:` plugin namespace, for example `cubefarm:cubefarm-tdd`.
- **Codex.** Load the matching `SKILL.md` from `.agents/skills/cubefarm-bundle/`.
- **OpenCode.** Call the native `skill` tool with the registered skill ID using the tool's current schema. On OpenCode v2, use `skill({ id: "cubefarm-tdd" })`.

Try to load each named skill. If one is unavailable, apply the guidance in this playbook directly and record the fallback.

## 1. Prepare

Read `cubefarm-tdd`. Read the PR, linked issue, and floor QA brief. Turn the acceptance criteria into observable checks through the affected entry points. Identify regressions, edge cases, and the smallest independent probes that would catch them. Use throwaway probes where useful, and leave the code under test intact.

## 2. Test

Read `cubefarm-diagnosing-bugs`. Run the applicable repository checks and exercise the changed behaviour directly. For a failure, reproduce it, narrow the conditions, and record the expected and actual result. Keep evidence from the assigned PR head. On a retest, explicitly verify every open finding. Capture browser evidence as directed by the office and floor QA brief.

If Chrome or Playwright hits a proxy error, blank page, or navigation timeout on a local or LAN preview, read `cubefarm-browser-proxy-resolve` before recording a verdict. Rerun the original browser assertions after restoring access. If access remains blocked, record the browser check as `skip` and include the proxy or navigation evidence.

## 3. Check

- Read `cubefarm-verification-before-completion`. Check that each claim has fresh evidence from this run. Report failed checks and mark checks you could not run as `skip`, with the reason.
- Read `cubefarm-test-strategy-skill`. Use its risk and coverage guidance to spot gaps in the checks already run. Run relevant missing checks where possible. Keep this within the QA run's scope and existing acceptance criteria. A separate strategy document, approval gate, or follow-on workflow is unnecessary for this review.
- Read `cubefarm-humanizer`. Apply it to the wording of the report summary and findings while preserving technical details, evidence, and the report schema.

## 4. Review the change

- Read `cubefarm-code-review`. Use the office's assigned diff for the Standards and Spec reviews. If the skill is unavailable, compare the assigned diff with the repository rules and the linked issue. Complete this review even if a check failed so the next reviewer knows what has already been read.
- For merge candidates, read `cubefarm-pr-security-review` and examine the full PR diff against its base. Report actionable security issues introduced by the change with their location, impact, and a way to verify or fix them. Verify suspected findings independently. If the runtime lacks delegated review, do the false-positive check yourself. Include the security result in the existing QA report.
- Apply the Lean guidance from `cubefarm-ponytail-review` to find unnecessary code or dependencies. If the skill is unavailable, look for unnecessary duplication and abstractions.

## 5. Decide whether to request a detailed security review

Escalate a passing PR if it changes a security boundary, including authentication, authorization, tenant isolation, secret handling, sensitive data access, or untrusted input reaching privileged operations. Escalate even when the quick screen finds no blocking issue. Set `securityReviewReason` in the structured QA report and name the affected surface and risk. CubeFarm applies `ready-for-review` and assigns a fresh QA session with the security playbook. The merge stays held until the specialist passes the current PR head.

## Exit

Finish with the office's structured QA report. Return `pass` when the change meets the requirements and the evidence supports it. Return `fail` for a blocking issue and put reproducible steps, expected and actual results, and actionable fix guidance in the report. Include the checks, commands, and screenshot captions requested by the office. The office publishes the report and handles developer hand-back or merge eligibility through its existing process.
