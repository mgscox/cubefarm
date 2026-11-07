# Lessons

A lesson is short, reviewed guidance drawn from something that went wrong more than once, or from a recovery that
worked: "check the toolbar at 375px before handing off", or "QA desks on small boxes need the suite run with fewer
workers". Each one links to the evidence behind it and to the fix or regression test that proved it, and only
approved versions are shown to maintainers or exported. Lessons are read by people; the office doesn't rewrite
prompts or playbooks from them.

Open a floor's **Kanban** and expand **Lessons**. It lists:

- **Approved lessons**, filtered by specialty. A lesson with no specialty applies to every specialty on the floor.
- **To review**: drafts and drafts sent back for revision, with **Approve**, **Send back**, **Reject** and **Revise…**.
- **Recurring findings**: the same finding key on more than one PR that no lesson cites yet, with the QA re-review
  that later passed. **Draft lesson…** starts a draft from it; pick the verifying evidence from the floor's passing QA
  reviews and attempts that passed QA, repaired or delivered.

## Two kinds

| Kind | Supported by |
| --- | --- |
| Agent guidance | confirmed `code` findings, and attempts the agent's own work ended |
| Operational | `worker` findings (memory, disk, a box), and attempts that ended on a worker or provider problem |

A finding's kind follows its latest classification correction in QA history. Unconfirmed code findings and
inconclusive ones support neither, and the office refuses a draft that mixes the kinds.

## What a version records

- **Scope**: the floor, the specialty (or every specialty) and the kind.
- **Sources** (1 to 20): QA findings, run-history attempts and links. Each keeps its ids, PR, revision and URL and a
  one-line summary of at most 240 characters with tokens, keys and passwords replaced by `[redacted]`. Logs, prompts,
  transcripts and screenshots are never copied in. If the QA outcome or attempt behind a source is later pruned, or
  an external link expires, the lesson keeps the link and the summary and the view marks it "record pruned". A link
  carrying credentials, a secret-named parameter, or a token-like value or path segment is refused.
- **Verification**: a fix or a regression test (with its name), and the passing QA outcome, or the `qa-passed`,
  `repaired` or `delivered` attempt, that verified it.
- **Revisions**: the commits where the findings were seen and where the fix was verified.
- **Guidance**: the proposed checklist or playbook text, at most 2,000 characters.

## Review history

Reviews are appended, never edited: `drafted`, `revised` (a new version), `approved`, `revision-requested`,
`rejected` and `superseded`, each with the version, who, when and why. Sending back, rejecting and superseding need a
reason. Approving a new version supersedes the version approved before it, which applies until then. **Supersede**
retires an approved lesson, optionally pointing at the lesson that replaces it. A rejected revision leaves the
approved version applying, and **Revise…** can try again; a lesson rejected with nothing approved, or retired, takes
no new versions or approvals: draft a new lesson instead.

## API

```
GET  /api/lessons?repoId=<owner/name>[&specialty=<s>][&download=1]   approved, applicable versions only
POST /api/repos/<repo>/lessons        { kind, specialty, title, guidance, sources, verification }
POST /api/lessons/<id>/versions       the same, plus an optional reason
POST /api/lessons/<id>/reviews        { action: approve | request-revision | reject | supersede, reason, supersededBy? }
```

A source is `{ qaOutcomeId, findingId }`, `{ attemptId }` or `{ url, summary }`; verification is
`{ kind: 'fix' | 'regression-test', test?, qaOutcomeId | attemptId }`. Lessons are saved in the office state
(`state.json`) on this machine.

## Trying it in the demo

In a demo office with auto-assign on, file two issues whose titles contain `[regression]`. Each PR's first QA round
fails on the same confirmed toolbar defect and passes after the fix, so **Recurring findings** offers a lesson. Draft
it, approve it, and it appears under the approved lessons and in the export. Issues whose titles contain
`[environment]` fail QA on worker memory instead; two of them offer an operational lesson, which a passing QA retry
(a `[worker-blocked]` PR's, say) can verify.
