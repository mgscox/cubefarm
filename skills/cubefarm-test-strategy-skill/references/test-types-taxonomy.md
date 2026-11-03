# Test Types Taxonomy

Use this reference to pick types per level. Organized by family. Each entry says **what it covers**, **when to include**, **default routing** (automated / manual / hybrid), and **typical lane**.

## Functional Family

### Smoke
- **Covers:** "Does it boot?" — a thin pass to confirm the build is testable at all.
- **When:** Always.
- **Routing:** Automated.
- **Lane:** Same lane as System / E2E.

### Sanity
- **Covers:** A handful of critical paths after a localized change.
- **When:** Whenever a build or deploy step exists.
- **Routing:** Automated.
- **Lane:** System / E2E.

### Positive (happy path)
- **Covers:** Each AC executed with expected inputs.
- **When:** Always.
- **Routing:** Automated.
- **Lane:** Per level — unit or system.

### Negative
- **Covers:** Each AC executed with invalid / unexpected inputs.
- **When:** Risk ≥ medium, or whenever AC define error states.
- **Routing:** Automated.
- **Lane:** Per level.

### Boundary
- **Covers:** Values at the edges of allowed ranges/sizes/types.
- **When:** Whenever AC contain ranges, limits, or sizes.
- **Routing:** Automated.
- **Lane:** Unit (cheapest) — push as low as possible.

### Regression
- **Covers:** Existing functionality after a change.
- **When:** SUT touches existing code paths.
- **Routing:** Automated.
- **Lane:** Whatever lane covers the affected paths.

### Confirmation / retest
- **Covers:** A specific fixed defect.
- **When:** A bug fix is in scope.
- **Routing:** Automated where possible, manual when reproduction requires human steps.
- **Lane:** Per defect.

## Non-Functional Family

### Performance
- **Covers:** Latency, throughput, scalability under load.
- **When:** Risk ≥ high, or explicit perf AC, or batch SUT, or external-facing API.
- **Routing:** Automated.
- **Lane:** `performance-testing-skill`.

### Security
- **Covers:** OWASP-class issues, secret leaks, authn/authz, dependency CVEs.
- **When:** Risk ≥ high, or external-facing, or handles credentials/PII.
- **Routing:** Automated scan + manual triage.
- **Lane:** `defensive-appsec-review-skill`.

### Accessibility (a11y)
- **Covers:** WCAG/Section 508 compliance.
- **When:** Any user-facing UI. Mandatory at risk ≥ high.
- **Routing:** Automated scan + manual screen-reader verification.
- **Lane:** `a11y-audit-agent-skill`.

### Responsive
- **Covers:** Layout/behavior across form factors (mobile/tablet/desktop).
- **When:** Web/UI SUT with multiple form factors.
- **Routing:** Automated.
- **Lane:** `responsive-testing`.

### Usability
- **Covers:** Is it actually usable by the target user?
- **When:** User-facing at risk ≥ high.
- **Routing:** Manual.
- **Lane:** Phase 9b manual track.

### Localization (i18n)
- **Covers:** Locale-correct rendering, text expansion, RTL, date/number formats, missing keys.
- **When:** AC reference multiple locales.
- **Routing:** Automated (key coverage) + manual (cultural review).
- **Lane:** Currently no dedicated skill on this machine — fold into E2E lane with pseudo-localization.

### Compatibility
- **Covers:** Cross-browser / OS / device behavior beyond responsive layout.
- **When:** AC reference multiple browsers/OS/devices.
- **Routing:** Automated.
- **Lane:** `playwright-skill` with multi-project config.

### Visual regression
- **Covers:** Unintended pixel-level changes.
- **When:** UI SUT with a stable design system.
- **Routing:** Automated capture + manual review of flagged diffs.
- **Lane:** Folded into `playwright-skill` / `cypress-skill` snapshot mode.

### Reliability / Chaos
- **Covers:** Fault tolerance, graceful degradation.
- **When:** Risk = critical, distributed system.
- **Routing:** Automated drills.
- **Lane:** No dedicated skill on this machine — flag as unavailable if needed.

### Installation / Upgrade / Migration
- **Covers:** Install, upgrade-from-prior-version, migration paths.
- **When:** Installer/distribution SUT, or SUT contains DB migrations.
- **Routing:** Automated where possible, manual for OS-level installer flows.
- **Lane:** Project-native scripts; no skill.

## Data Family

### Schema validation
- **Covers:** Input/output schema conformance.
- **When:** Batch / ETL / data pipeline SUT.
- **Routing:** Automated.
- **Lane:** `data-batch-testing-skill` (planned) — fall back to project-native (Great Expectations, dbt tests).

### Row-count / reconciliation
- **Covers:** Source-vs-target counts and totals.
- **When:** Batch SUT moving data between systems.
- **Routing:** Automated.
- **Lane:** Same as schema validation.

### Idempotency / replay
- **Covers:** Re-running the same batch yields the same result; replay after partial failure recovers correctly.
- **When:** Batch SUT processing external events or with retry semantics.
- **Routing:** Automated.
- **Lane:** Same as schema validation.

### Referential integrity
- **Covers:** FK and uniqueness constraints hold after the change.
- **When:** Any SUT touching relational data.
- **Routing:** Automated.
- **Lane:** Integration tests or data-batch lane.

## AI / ML Family

Only applies when SUT contains a model or LLM-driven feature.

### Output quality eval
- **Covers:** Model output meets quality thresholds on a held-out dataset.
- **When:** SUT generates model output.
- **Routing:** Automated.
- **Lane:** `llm-eval-skill` (planned) — fall back to project-native.

### Hallucination check
- **Covers:** Model fabrication rate.
- **When:** SUT is generative.
- **Routing:** Automated.
- **Lane:** Same as output quality eval.

### Bias / fairness
- **Covers:** Disparate impact across protected attributes.
- **When:** SUT produces decisions affecting people.
- **Routing:** Automated metrics + manual ethics review.
- **Lane:** Same as output quality eval + manual track.

### Prompt regression
- **Covers:** Existing prompts still produce expected outputs after changes.
- **When:** SUT depends on a prompt library.
- **Routing:** Automated.
- **Lane:** Same as output quality eval.

## Process / Human Family (always manual)

These never route to a lane in phase 9a. They go to phase 9b's manual track.

### Exploratory
- **When:** Risk ≥ medium.
- **Format:** Charter-based session, time-boxed.

### UAT (User Acceptance)
- **When:** Stakeholder approval gate required.
- **Format:** Stakeholders execute against approved AC.

### Alpha / Beta
- **When:** Pre-release validation against real-ish users.
- **Format:** Limited rollout with feedback capture.

### Operational Acceptance (OAT)
- **When:** SUT changes operational runbooks (deploys, backups, DR).
- **Format:** Ops team runs through changed runbook.

### Documentation review
- **When:** SUT changes public-facing docs or API references.
- **Format:** Human reads and approves.

## Type Selection Quick Map

When in doubt, this table tells you what types are *typically* in scope for a SUT type at a given risk class:

| SUT type | Low | Medium | High | Critical |
| --- | --- | --- | --- | --- |
| Webapp | smoke + happy | + negative + boundary + regression + a11y + responsive | + perf + security + visual + UAT | + chaos + compliance |
| API / service | smoke + happy + contract | + negative + boundary + regression | + perf + security | + chaos + compliance |
| Batch / ETL | smoke + schema | + reconciliation + idempotency | + perf + replay | + DR + compliance |
| UI (lib) | unit + happy | + a11y + visual | + responsive + i18n | + cross-browser matrix |
| ML model | unit + quality eval | + prompt regression | + bias + hallucination | + ethics review |
