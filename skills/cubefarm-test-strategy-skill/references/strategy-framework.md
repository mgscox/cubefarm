# Strategy Framework

Use this reference to keep level/type selection, lane mapping, prioritization, and exit-criteria choices consistent and defensible across strategy runs.

## 1. Build the Strategy Baseline

Before selecting anything, capture:

- SUT identifier and type (requirement / feature / webapp / UI / batch / API / library / ml-model)
- Risk class (low / medium / high / critical)
- HITL mode (lite / standard / full)
- Environments available (dev, staging, prod-like, isolated)
- Stack (language, framework, runners already in use) — only if codebase_path supplied
- AC list with stable IDs (so decisions can cite them)
- Risk findings with stable IDs (from upstream analysis)

If most of this is missing, stop and ask. Do not infer the risk class — it drives every breadth decision.

## 2. Level Selection Rubric

Walk the levels in this order and decide in/out based on the cues:

| Level | Default for SUT types | Skip when |
| --- | --- | --- |
| Unit | Any code-bearing SUT (feature, library, API, batch, ml-model) | SUT is a pure config/requirement doc with no executable code |
| Component | UI work (webapp, UI), modular backend | No isolatable components; everything is procedural |
| Integration | Any SUT with ≥ 2 collaborating modules or external systems | Single-process, no integrations |
| Contract | API SUT, or any service-to-service boundary | No service boundaries crossed |
| System / E2E | webapp, UI, full-feature delivery | Library or pure batch with no user-visible path |
| Acceptance | Any user-facing or business-process-touching SUT | Internal-only tooling with no stakeholder approval needed |

Cross-check with risk class:

- `critical` — all applicable levels in scope
- `high` — applicable levels except optionally Acceptance (if internal)
- `medium` — Unit + at least one higher level (Integration or System)
- `low` — Unit + Smoke at System level only

## 3. Type Selection Rubric

For each level kept in scope, apply types:

**Functional** (always considered, scaled by risk):

| Type | When |
| --- | --- |
| Smoke | Always (cheapest failsafe) |
| Sanity | Whenever a build / deploy step exists |
| Positive (happy path) | Always |
| Negative | medium+ risk; or whenever AC define error states |
| Boundary | Whenever AC contain ranges, limits, or sizes |
| Regression | Whenever the SUT touches existing functionality |
| Confirmation/retest | Whenever a bug fix is in scope |

**Non-functional** (gated by risk and SUT type):

| Type | When |
| --- | --- |
| Performance | high+ risk OR explicit perf AC OR batch SUT |
| Security | high+ risk OR external-facing OR handles credentials/PII |
| Accessibility | Any user-facing UI; mandatory at high+ risk |
| Responsive | Web/UI SUT with multiple form factors |
| Usability | high+ risk user-facing; routes to manual track |
| Localization (i18n) | When AC reference multiple locales |
| Compatibility | When AC reference multiple browsers/OS/devices |
| Visual regression | UI SUT with stable design system |
| Reliability / Chaos | critical risk distributed systems only |
| Installation / Upgrade | Installer/distribution SUTs only |

**Data** (gated by SUT type):

| Type | When |
| --- | --- |
| Schema validation | batch / ETL / data pipeline SUT |
| Row-count / reconciliation | batch SUT |
| Idempotency / replay | batch SUT processing external events |
| Referential integrity | Any SUT touching relational data |

**AI / ML** (gated by SUT containing a model):

| Type | When |
| --- | --- |
| Output quality eval | SUT generates LLM/model output |
| Hallucination check | SUT is a generative model |
| Bias / fairness | SUT produces decisions affecting people |
| Prompt regression | SUT depends on a prompt library |

**Process / human** (always routed to manual track):

| Type | When |
| --- | --- |
| Exploratory | medium+ risk |
| UAT | Stakeholder approval gate required |
| Alpha / Beta | Pre-release validation |
| Operational acceptance (OAT) | SUT changes operational runbooks |
| Documentation review | SUT changes public-facing docs |

## 4. Lane Mapping Discipline

Once types are picked, every type must route somewhere. Use `lane-catalog.md` for the canonical map. If a type has no available lane:

1. Check if a sibling lane covers it (e.g. visual regression folds into Playwright/Cypress).
2. If still uncovered and risk class is `low`/`medium`, mark `manual / opportunistic` and explain in Open Questions.
3. If still uncovered and risk class is `high`/`critical`, mark `unavailable` and require Open Questions resolution before phase 5.

Never silently drop a needed type.

## 5. Scenario Prioritization

Source scenarios from:

- Acceptance criteria (each AC produces one or more scenarios)
- Risk findings from upstream analysis (each risk becomes a negative scenario)
- Inherent SUT hazards from the type taxonomy (e.g. concurrent access for batch)

Score with `scripts/prioritize_scenarios.py`. Allowed scales:

**Impact**: 1 (Very Low), 2 (Low), 4 (Moderate), 8 (High), 16 (Severe)
**Likelihood**: 1 (Rare), 2 (Unlikely), 3 (Possible), 4 (Likely), 5 (Almost Certain)
**Coverage Priority**: 1 (P3 / nice-to-have), 2 (P2 / should), 3 (P1 / must)

`score = impact × likelihood × coverage_priority`

Categories (post-coverage weighting):

| Score range | Category |
| --- | --- |
| 1–8 | Low |
| 9–32 | Medium |
| 33–96 | High |
| 97–240 | Critical |

Top N (default 20) goes into the strategy matrix. Anything Critical must have an explicit routing decision.

## 6. Automated vs Manual Routing

For each scored scenario, decide:

- **Automated** — primary lane has a runner; scenario fits the lane's strengths
- **Manual** — type is inherently manual (exploratory/usability/UAT/OAT/docs) OR cost-of-automation > value
- **Hybrid** — automated for the deterministic path, manual for judgment calls (e.g. visual diffs flagged for human review)

Document the rationale on each row. Manual entries feed lifecycle phase 9b; automated entries feed 9a.

## 7. Exit Criteria Construction

Exit criteria must be **mechanically checkable** by phase 12 of the lifecycle chain. Acceptable forms:

- Pass rate threshold (e.g. `overall ≥ 95%`)
- P-bucket coverage (e.g. `P1 cases: 100% passing`)
- Open-finding limits (e.g. `0 open High+ severity`)
- Coverage thresholds (e.g. `branch coverage ≥ 75%`)
- Evidence artifacts (e.g. `regulatory evidence pack present`)

Unacceptable:

- "When the team feels confident"
- "When QA signs off" (this is a HITL gate, not an exit criterion)
- "Reasonable coverage"

Use `scripts/derive_exit_criteria.py` to generate the starting set; tighten or relax per SUT specifics.

## 8. HITL Gate Mapping

Mode → gates (see `exit-criteria-model.md` for full detail):

| Mode | Gates active |
| --- | --- |
| lite | phase 13 (final sign-off) only |
| standard | phase 4 (strategy approval), phase 8 (export approval), phase 13 |
| full | phase 4, phase 8, phase 9 (per-lane Critical findings), phase 12 (heal-loop cap or definition-changing fix), phase 13 |

A `critical` risk class under `lite` mode should be flagged as a mismatch — recommend escalation.

## 9. Evidence and Audit

Every decision in the strategy document must be traceable to an input. Acceptable citation forms:

- `intake.risk_class = high`
- `AC-12 (boundary on max_order_value)`
- `analysis.R3 (payment timeout)`
- `stack-detection: pom.xml → spring-boot`
- `lane-detector: playwright-skill present`

A strategy without citations cannot pass the phase 4 HITL gate.

## 10. Anti-patterns to Avoid

- **Kitchen-sink strategy** — recommending every level and type regardless of risk. Strategy is about deliberate scope, not maximal coverage.
- **Lane-as-decoration** — listing lanes without verifying they're installed. Always run the detector.
- **Untestable exits** — exit criteria stated in adjectives. Convert to numbers.
- **Silent manual drops** — types that should be manual but get omitted from the routing list. Manual is a routing decision, not an absence.
- **Risk class drift** — accepting a low risk class for a critical SUT because intake said so. Push back via Open Questions if the classification looks wrong.
- **Stack chasing** — recommending tools the team has never used. Prefer the existing test runner unless there's a concrete reason to switch.
