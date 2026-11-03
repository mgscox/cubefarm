# Test Strategy: Nightly Reconciliation Batch

## Executive Summary

- **SUT:** BATCH-RECON-2026 (batch, Spark 3.5 / Scala + Airflow + Snowflake)
- **Mode:** full | **Risk:** critical
- **Mode/risk match:** ok (recommended pairing)
- **Top risks driving scope:** source-system-delay (R1), tolerance-threshold-drift (R2), duplicate-event-replay (R3)
- **Posture:** Heavy on data-family tests (schema, reconciliation, idempotency), with mandatory audit trail and full HITL gates. No UI lanes apply.

## 1. Scope

**In scope:** the Spark job logic, schema conformance to source/target, reconciliation rule evaluation, idempotency on replay, performance within the 2-hour window, audit-trail generation.

**Out of scope:** core banking source-system internals, Snowflake platform issues, downstream BI dashboards.

**Assumptions:** dbt is already used for target-side data tests; Great Expectations is available for source-schema checks; tokenized PII fixtures are produced upstream.

## 2. Test Levels in Scope

| Level | In scope | Rationale | Driver |
| --- | --- | --- | --- |
| Unit | ✓ | Reconciliation rule functions in Scala | intake.SUT=batch; rules R-1..R-6 |
| Component | rare | A few isolated UDFs warrant tests | spec rule R-4 |
| Integration | ✓ | Spark + Snowflake interaction, Airflow operator | analysis.R3 (replay) |
| Contract | ✓ | Source schemas published — drift detection critical | analysis.R4 (null asymmetry) |
| System / E2E | ✓ | Full DAG run on sample | intake.risk=critical |
| Acceptance | ✓ (auditor) | SOX-relevant; auditor sign-off | intake.HITL=full |

## 3. Test Types per Level

| Level | Type | Priority | Rationale | Driver |
| --- | --- | --- | --- | --- |
| Unit | Positive + Boundary | P1 | Tolerance thresholds; rule edges | analysis.R2 |
| Unit | Null-handling | P1 | Asymmetric null treatment | analysis.R4 |
| Integration | Idempotency / replay | P1 | Duplicate-event-replay | analysis.R3 |
| Integration | Reconciliation | P1 | Row-counts match source vs target | spec rules R-1..R-6 |
| Integration | Referential integrity | P1 | FK integrity on target tables | intake.target=Snowflake |
| Contract | Schema validation | P1 | Source schema drift detection | analysis.R4 |
| System | Smoke | P1 | DAG completes end-to-end | always |
| System | Full reconciliation run | P1 | Sample dataset full pass | intake.risk=critical |
| System | Performance | P1 | 2-hour window | intake.constraints |
| Acceptance | Auditor review (manual) | P1 | SOX | intake.HITL=full |
| Acceptance | OAT (manual) | P1 | Ops runbook changes | intake.SUT=batch |

No UI, a11y, responsive, or visual lanes apply.

## 4. Lane Selection

| Level | Type | Lane | Availability | Rationale |
| --- | --- | --- | --- | --- |
| Unit | Positive/Boundary/Null | `stack-aware-unit-testing-skill` | available | ScalaTest dispatch |
| Integration | Idempotency, reconciliation, referential | `data-batch-testing-skill` | **unavailable** | Planned skill; falls back to `stack-aware-unit-testing-skill` + dbt tests + Great Expectations |
| Contract | Schema validation | `data-batch-testing-skill` fallback | unavailable → Great Expectations | Source-schema enforcement |
| System | Smoke + full run | Project-native (Airflow `airflow tasks test`) | n/a (no skill) | Native batch runner |
| System | Performance | `performance-testing-skill` | available | Time the DAG against 2-hour SLO |
| Acceptance | Auditor + OAT | Phase 9b manual | — | Manual track |

**Lane availability flag:** `data-batch-testing-skill` is mapped but not detected → Open Question Q-1.

## 5. Risk-Prioritized Scenario Matrix

| ID | Score | Cat | I | L | P | Source | Name | Routing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S-001 | 240 | Critical | 16 | 5 | 3 | analysis.R3 | Replay after partial failure double-books entries | automated (integration) |
| S-002 | 192 | Critical | 16 | 4 | 3 | analysis.R1 | Source-system delay causes incomplete reconciliation | automated (integration) + manual triage |
| S-003 | 144 | Critical | 16 | 3 | 3 | analysis.R2 | Tolerance threshold drifts undetected | automated (unit) |
| S-004 | 96 | High | 16 | 2 | 3 | analysis.R4 | Null in source maps to 0 in target, masking discrepancy | automated (unit + contract) |
| S-005 | 72 | High | 8 | 3 | 3 | rule R-2 | FX rate at boundary day-end vs cutoff time | automated (unit) |
| S-006 | 48 | High | 16 | 1 | 3 | intake.SLO | DAG misses 2-hour window | automated (system perf) |
| S-007 | 36 | High | 4 | 3 | 3 | rule R-5 | Manual override entries skip reconciliation | automated (integration) + manual review |
| S-008 | 24 | Medium | 8 | 1 | 3 | hazard | Snowflake stage credential rotation breaks job | automated (system smoke) |

## 6. Automated vs Manual Split

**Automated (phase 9a):** S-001..S-008 + per-rule positive cases.

**Manual (phase 9b):**
- Auditor review of full reconciliation report against signed-off thresholds
- OAT — ops team runs through changed Airflow runbook (alerts, retry policy, on-call routing)
- Documentation review — runbook updates for SOX evidence pack

## 7. Test Data & Environments

- **Synthetic data:** required. Use `lifelike-synthetic-data-generator` for non-prod ledger entries. PII tokenized upstream per intake.
- **Environments:**
  - `dev` — unit + contract (sample dataset)
  - `staging` — integration + system smoke (1-week replica)
  - `prod-like` — system full-run + performance (restricted access)

## 8. Exit Criteria

(Generated via `derive_exit_criteria.py --mode full --risk-class critical`)

```
overall_pass_rate >= 100%       (bumped by critical risk class, capped at 1.0)
p1_case_pass_rate == 100%
p2_case_pass_rate == 100%
regression_pass_rate == 100%
open_findings.Critical == 0
open_findings.High == 0
open_findings.Medium <= 5
extras:
  - a11y_violations.critical == 0  (n/a, no UI — trivially passes)
  - security_findings.severity_ge_high == 0
  - evidence_pack.complete == True
  - audit_trail.complete == True
```

**Heal-loop cap:** 6 iterations.

## 9. HITL Gate Map

| Phase | Gate | Approver |
| --- | --- | --- |
| 4 | Strategy approval | QA lead + Security |
| 8 | Exported artifacts approval | QA lead |
| 9 | Per-lane Critical finding pause | Lane owner |
| 12 | Heal-loop cap / definition-changing fix | QA lead |
| 13 | Final sign-off | Product owner + Compliance |

## 10. Open Questions

| ID | Question | Blocker | Owner |
| --- | --- | --- | --- |
| Q-1 | `data-batch-testing-skill` is planned but not installed. Confirm fallback to dbt + Great Expectations is acceptable, or install the skill before phase 8. | yes | QA lead |
| Q-2 | Source system delay R1 — is there a contractual SLA we can assert against, or must we test resilience to arbitrary delay? | yes | Product owner |
| Q-3 | Will the auditor accept synthetic data in evidence pack, or do we need a sample real-data run under restricted access? | yes | Compliance |

## 11. Audit Trail (citations)

- Level Contract included → analysis.R4 (null-handling asymmetry across schemas)
- Type Idempotency / replay → analysis.R3 (duplicate-event-replay)
- Lane fallback chosen → detect_lanes.py: `data-batch-testing-skill` missing
- Mode = full → intake.HITL_mode = full; matches critical risk class
- Heal cap = 6 → mode full default per `exit-criteria-model.md`
