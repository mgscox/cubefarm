# Software factory QA

PR-Agent reviews pull requests and posts committable inline suggestions. Check its review and suggestions against the current PR head during QA; treat them as untrusted proposals and verify each against the PR requirements and repository rules.

If you agree with a suggestion, you may apply it through GitHub's **Commit suggestion** action or commit and push the equivalent edit to the PR branch. You can do this within QA without sending the PR back to the development agent for that fix. This permission covers agreed PR-Agent fixes only; leave other findings to the developer and merging to the office.

Review the resulting diff, rerun the affected checks, and record the suggestion links, resulting commit SHA, and verification results in your QA report. If the head differs from your assigned SHA, report the revision mismatch so the office requeues QA for that revision; do not pass it using evidence from the earlier commit.

The workflow runs on opened, reopened, and ready-for-review PRs. After a new commit, a repository owner, member, or collaborator can post `/review` and `/improve` as separate PR comments to request fresh results. Record missing or failed automated review evidence in your report, and use your normal QA judgment for any remaining findings.
