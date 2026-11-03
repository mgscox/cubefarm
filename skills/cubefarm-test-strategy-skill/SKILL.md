---
name: cubefarm-test-strategy-skill
description: Use when designing a test strategy or test plan for a requirement, feature, webapp, UI, batch job, API, or release. Produces a structured strategy doc that selects test levels and types, picks automation lanes per stack, derives exit criteria, prioritizes scenarios by risk, and splits work between automation and a manual track. Use whenever the user asks to plan, scope, strategize, or decide what to test, even if they do not say "strategy". Do not use for designing individual test cases (use test-design-orchestrator) or for analyzing requirement quality (use test-analysis-skill).
metadata:
  dispatcher-layer: planning
  dispatcher-lifecycle: active
  dispatcher-category: testing
  dispatcher-capabilities: test-strategy, test-planning, lane-selection, exit-criteria-derivation, risk-prioritization
  dispatcher-accepted-intents: design_test_strategy, plan_test_levels_and_types, select_test_lanes, derive_test_exit_criteria
  dispatcher-input-artifacts: intake_summary, hitl_mode, acceptance_criteria, test_analysis_report, codebase_context
  dispatcher-output-artifacts: test_strategy_document, scenario_priority_matrix, lane_selection, exit_criteria, hitl_gate_map
  dispatcher-stack-tags: testing, planning, framework-agnostic
  dispatcher-risk: medium
  dispatcher-writes-files: true

---

# Test Strategy Skill

During CubeFarm QA, use the risk and coverage rubric to identify gaps in the current checks. Record them in the existing QA report. The full strategy-document and approval workflow below applies when a standalone test strategy is requested.

> **Author:** jovd83 | **Version:** 1.0.0

Produce a structured, auditable **test strategy** that drives every downstream phase of the test lifecycle: design, export, automation lanes, manual track, heal loop exit, and final report.

## Goal

Take what is known about a system under test (SUT) and turn it into a defensible strategy document that answers, before any test case is designed:

- **What** levels and types we will test, and **why**
- **Which tools / automation lanes** we will use, only from the ones actually available
- **What is automated vs. what stays manual**
- **Which scenarios matter most** (risk-prioritized)
- **When are we done** (exit criteria the heal loop can mechanically evaluate)
- **Which HITL gates are active** given the chosen oversight mode

## Where This Skill Sits

Phase 4 of the broader `test-lifecycle-skill` chain. Sits between requirement analysis and test design. Consumes outputs from earlier phases; produces the load-bearing artifact every later phase reads.

Upstream (inputs this skill consumes):

- Intake summary (phase 1) — SUT type, risk class, environments
- HITL mode (phase 1b) — `lite` / `standard` / `full`
- Normalized acceptance criteria (phase 2)
- Test analysis report (phase 3) — testability, risk, gaps
- Optional: codebase context bundle for stack detection

Downstream (artifacts this skill produces):

- `strategy.md` — human-readable strategy document
- `strategy.json` — machine-readable sidecar (schema in `references/strategy-doc-schema.md`)

## Input Contract

Required:

- `intake` — at minimum: SUT type (one of: requirement, feature, webapp, UI, batch, API, library, ml-model), risk class (one of: low, medium, high, critical), environments available

Strongly recommended:

- `hitl_mode` — `lite` | `standard` | `full`; default `standard` if absent
- `acceptance_criteria` — normalized AC list
- `analysis` — test analysis report or its risk findings

Optional:

- `codebase_path` — for stack detection
- `available_lanes` — explicit override; otherwise auto-detected

If the SUT type or risk class is missing, stop and ask once. Do not invent them — they steer every downstream decision.

## Output Contract

Two artifacts, written to the path the caller specifies (default: `./strategy.md` and `./strategy.json` in CWD):

### `strategy.md` sections (in this order)

1. **Executive Summary** — SUT, mode, top risks, posture
2. **Scope** — in/out of scope, assumptions
3. **Test Levels in Scope** — table with rationale per level
4. **Test Types per Level** — table mapping level → type → priority
5. **Lane Selection** — table mapping (level, type, stack) → lane skill, with availability flag
6. **Risk-Prioritized Scenario Matrix** — top N scenarios sorted by inherent risk
7. **Automated vs Manual Split** — explicit routing list (feeds 9a/9b in the lifecycle chain)
8. **Test Data & Environments** — what envs are needed, whether synthetic data is required
9. **Exit Criteria** — measurable, mode-aware conditions
10. **HITL Gate Map** — which gates are active for the chosen mode
11. **Open Questions** — anything the caller must resolve before phase 5

### `strategy.json` sidecar

Strict schema (see `references/strategy-doc-schema.md`). The lifecycle orchestrator reads this; humans read the `.md`. Both must agree.

## Working Method

### 1. Read the foundational references

Read these before anything else:

- `references/strategy-framework.md` — the core methodology
- `references/test-levels-taxonomy.md` — what each level covers
- `references/test-types-taxonomy.md` — functional, NFR, data, AI-eval
- `references/lane-catalog.md` — type→lane mapping rules
- `references/exit-criteria-model.md` — mode-aware exit gates

### 2. Detect available automation lanes

Run the detector before recommending tools:

```bash
python scripts/detect_lanes.py --json
```

Output is a list of lane skills present on the runtime tree. **Never recommend a lane that is not in this list.** If the caller passed `available_lanes` explicitly, prefer that over auto-detect.

If Python is unavailable, fall back to the lane catalog as a static list and label the strategy as `lane availability: unverified`.

### 3. Detect stack (only if codebase_path provided)

If a codebase path was supplied, inspect manifest files (`package.json`, `pom.xml`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.) to identify primary language, framework, and test runners already in use. Prefer extending the existing runner over introducing a new one.

If no codebase path, infer from intake SUT type only and label stack decisions as `inferred`.

### 4. Select levels and types

Use the rubric in `references/strategy-framework.md` driven by SUT type and risk class:

- **Critical risk** → all applicable levels, full type breadth (functional + NFR + data/AI as applicable)
- **High risk** → unit + integration + system + at least one NFR lane
- **Medium risk** → unit + system + smoke regression
- **Low risk** → smoke + happy path

Justify each level's inclusion with a one-line rationale tied to a specific input (intake, AC, or analysis finding). The audit trail matters — every decision must cite its driver.

### 5. Map types to lanes

For each (level, type) pair, look up the lane in `references/lane-catalog.md` and verify it appears in the detector output. Mark each row:

- `automated` — lane is available
- `manual` — type is inherently manual (exploratory, usability, UAT, OAT, doc review), or no available lane covers it cost-effectively
- `unavailable` — type should be tested but no lane exists; flag in Open Questions

### 6. Prioritize scenarios

Run:

```bash
python scripts/prioritize_scenarios.py --input scenarios.json --top 20
```

The scorer combines `impact × likelihood × coverage_priority`. Feed it the scenarios extracted from AC + analysis findings. The top N goes into the scenario matrix in section 6.

For each scenario, capture: ID, name, impact, likelihood, score, category, source (which AC or risk finding drove it), routing (lane or manual).

### 7. Derive exit criteria

Run:

```bash
python scripts/derive_exit_criteria.py --mode standard --risk-class high --json
```

This produces a mode-aware list of exit gates: pass-rate thresholds, residual-Critical-finding limits, P1 coverage minimums, etc. Phase 12 (heal loop) reads this to know when to stop iterating. Mode tightening:

- `lite` — loose: pass rate ≥ 80%, no open Critical findings
- `standard` — moderate: pass rate ≥ 95%, no open High+, P1 cases 100%
- `full` — strict: pass rate 100% on P1, ≥ 95% overall, zero open High+, regulatory evidence pack complete

### 8. Compute HITL gate map

Mode-aware (see `references/exit-criteria-model.md` for the full table):

- `lite` — phase 13 sign-off only
- `standard` — phase 4 + phase 8 + phase 13
- `full` — all gates including per-lane Critical findings (phase 9) and heal-loop pause (phase 12)

### 9. Write artifacts

Write `strategy.md` and `strategy.json` to the requested output path. The JSON must validate against the schema in `references/strategy-doc-schema.md`.

### 10. Self-check before returning

Run the quality checks in the **Quality Checks** section below. If any fail, fix before returning.

## Guardrails

- **Never recommend a lane that the detector did not find.** Stale recommendations break the lifecycle chain.
- **Never invent risk values or exit thresholds.** Use the bundled scripts or label clearly as `manual fallback`.
- **Never fabricate AC, scenarios, or rules** the inputs do not support. If something is missing, list it in Open Questions.
- **Never silently widen scope.** If the strategy goes beyond what intake authorized, call it out explicitly with rationale.
- **Never collapse manual to "skip"**. If a type is inherently manual and not staffed, mark it `manual / unstaffed` and flag the residual risk — do not silently drop it.
- **Every decision in the strategy must cite a driver** (intake field, AC ID, analysis finding ID). This is the audit trail the HITL gate at phase 4 verifies.
- **Do not design test cases.** That is phase 5 / `test-design-orchestrator`.
- **Do not run tests.** That is phases 9a/9b.

## Gotchas

- **Lane drift** — when new lane skills are added to the runtime tree, the lane catalog reference goes stale. The detector script catches this for tools, but the catalog still drives type→lane *mapping*. Mismatches surface as `unavailable` rows; treat them as a signal to update `references/lane-catalog.md`, not to ignore.
- **Mode mismatch with risk class** — a `critical` SUT under `lite` mode is almost always wrong. Flag it in Open Questions and recommend escalation rather than silently proceeding.
- **Exit criteria that the chain cannot mechanically check** — vague exit criteria ("ship when comfortable") make phase 12 unable to decide. Always emit measurable thresholds.
- **Stack detection guesswork** — if codebase_path is absent, mark stack as `inferred` and the lane choices as `provisional`. Don't pretend.
- **Over-broad scope on low-risk runs** — a 3-character copy change does not need a security lane. Risk class should genuinely constrain breadth; if Lite consistently recommends 6 lanes, the rubric is wrong, not the inputs.
- **Manual-track invisibility** — if the strategy doesn't explicitly route manual types, the lifecycle orchestrator will skip them. Always emit a manual list, even if empty, so the absence is intentional.
- **Risk scores from feel** — every scored scenario must come from `prioritize_scenarios.py` with values from the allowed scales (see `references/strategy-framework.md`). Inline arithmetic is forbidden because it breaks reproducibility.

## Reference Map

- Core methodology: `references/strategy-framework.md`
- Levels taxonomy: `references/test-levels-taxonomy.md`
- Types taxonomy: `references/test-types-taxonomy.md`
- Lane catalog (type→lane): `references/lane-catalog.md`
- Exit criteria & HITL gate model: `references/exit-criteria-model.md`
- JSON sidecar schema: `references/strategy-doc-schema.md`
- Examples (paired intake→strategy): `examples/`

## Scripts

- `scripts/detect_lanes.py` — scan `~/.agents/skills/` for known lane skills
- `scripts/prioritize_scenarios.py` — deterministic scenario scoring (impact × likelihood × coverage)
- `scripts/derive_exit_criteria.py` — mode + risk class → exit gate set

All three support `--json` for machine-readable output.

## Memory Model

Runtime-only. The skill does not persist anything across invocations. The strategy artifacts it writes are project-local and managed by the caller. If cross-project policy is needed (e.g., "team always uses Playwright over Cypress"), keep it in the agent's own memory (for example CLAUDE.md or AGENTS.md) — do not embed it here.

## Quality Checks

Before returning, confirm:

- Every recommended lane appears in the detector output (or `available_lanes` override)
- Every level/type row cites its driver (intake risk, AC ID, analysis finding ID)
- Scenario priority scores come from `prioritize_scenarios.py`, not free-text reasoning
- Exit criteria are measurable (numbers or boolean conditions, not adjectives)
- HITL gate map matches the chosen mode per `references/exit-criteria-model.md`
- `strategy.json` validates against the schema
- Manual track is explicit (even if empty); not silently dropped
- Open Questions section exists and either lists unresolved items or says "none"

## Quick Prompt Examples

- `Use $test-strategy-skill to plan testing for this checkout webapp before sprint starts.`
- `Use $test-strategy-skill to derive a Full-mode test strategy for the nightly batch reconciliation job.`
- `Use $test-strategy-skill to pick lanes and exit criteria for the new payments REST API; risk is high, environments are dev/staging.`
