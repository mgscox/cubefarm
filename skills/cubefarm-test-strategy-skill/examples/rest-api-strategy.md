# Test Strategy: New Payments REST API

## Executive Summary

- **SUT:** API-PAY-2026 (API, Spring Boot 3.2 / Java 21)
- **Mode:** standard | **Risk:** high
- **Top risks:** idempotency-key-collision (R1), refund-exceeds-original (R2), partner-A-deprecated-field (R3)
- **Posture:** Contract-first (OpenAPI in place), unit + integration + system in the JVM stack, perf at the SLO target, security review for money handling.

## 1. Scope

**In scope:** the three endpoints, idempotency semantics, refund authorization rules, contract conformance with two consumers, perf at SLO.

**Out of scope:** payment provider internals, partner-A's client code, downstream reporting.

## 2. Test Levels in Scope

| Level | In scope | Rationale | Driver |
| --- | --- | --- | --- |
| Unit | ✓ | Authorization, idempotency-key logic, refund amount validation | analysis.R1, R2 |
| Integration | ✓ | Provider sandbox + persistence | intake.risk=high |
| Contract | ✓ | Two consumers depend on shape | analysis.R3; intake.constraints |
| System (API E2E) | ✓ | Full happy + error paths | intake.risk=high |
| Acceptance | UAT light | Stakeholder sign-off before partner rollout | intake.HITL=standard |

## 3. Test Types per Level

| Level | Type | Priority | Driver |
| --- | --- | --- | --- |
| Unit | Positive/Negative/Boundary | P1 | AC-1..AC-8 |
| Unit | Idempotency-key | P1 | analysis.R1 |
| Integration | Sandbox provider + DB | P1 | analysis.R2 |
| Contract | Schema drift vs OpenAPI | P1 | analysis.R3 |
| Contract | Consumer-driven (partner-A pact) | P2 | intake.constraints |
| System | Smoke + happy + negative | P1 | AC coverage |
| System | Performance | P1 | intake.p95=300ms at 100 RPS |
| System | Security | P1 | money movement |

## 4. Lane Selection

| Level | Type | Lane | Availability | Rationale |
| --- | --- | --- | --- | --- |
| Unit | All | `junit5-skill` | available | Stack override: Java |
| Integration | All | `junit5-skill` + testcontainers | available | Spring slice tests |
| Contract | Schema drift | `api-contract-sentinel` | available | Detects drift vs `apis/payments.yaml` |
| Contract | Authoring | `openapi-spec-generation` | available | Keeps spec in sync |
| System | API E2E | `restassured-skill` | available | Stack override: Java |
| System | Performance | `performance-testing-skill` | available | k6 or Gatling |
| System | Security | `defensive-appsec-review-skill` | available | Authn/authz + money-movement review |
| Acceptance | UAT | Phase 9b manual | — | Light UAT (stakeholder check) |

## 5. Risk-Prioritized Scenario Matrix

| ID | Score | Cat | I | L | P | Source | Name | Routing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S-001 | 144 | Critical | 16 | 3 | 3 | analysis.R1 | Same idempotency-key with different body double-charges | automated (unit + integration) |
| S-002 | 96 | High | 16 | 2 | 3 | analysis.R2 | Refund amount exceeds original payment | automated (unit) |
| S-003 | 72 | High | 8 | 3 | 3 | analysis.R3 | Partner-A breaks when deprecated field removed | automated (contract) |
| S-004 | 48 | High | 16 | 1 | 3 | intake.SLO | p95 exceeds 300ms at 100 RPS | automated (perf) |
| S-005 | 36 | High | 4 | 3 | 3 | AC-7 | Concurrent refunds race condition | automated (integration) |
| S-006 | 24 | Medium | 8 | 1 | 3 | hazard | Auth token replay across endpoints | automated (security) |

## 6. Automated vs Manual Split

**Automated:** S-001..S-006 plus AC-derived positives.
**Manual:** UAT check by storefront product owner; partner-A integration walkthrough.

## 7. Test Data & Environments

- Synthetic only. Sandbox provider supplies test cards. No real PAN data anywhere.
- `dev` — unit + integration. `staging` — system + perf + security.

## 8. Exit Criteria

(Generated via `derive_exit_criteria.py --mode standard --risk-class high`)

```
overall_pass_rate >= 95%
p1_case_pass_rate == 100%
p2_case_pass_rate >= 90%
regression_pass_rate == 100%
open_findings.Critical == 0
open_findings.High == 0
open_findings.Medium <= 5
```

**Heal-loop cap:** 4 iterations.

## 9. HITL Gate Map

| Phase | Gate | Approver |
| --- | --- | --- |
| 4 | Strategy approval | QA lead |
| 8 | Exported artifacts approval | QA lead |
| 13 | Final sign-off | Product owner |

## 10. Open Questions

| ID | Question | Blocker | Owner |
| --- | --- | --- | --- |
| Q-1 | Does partner-A run a pact broker, or do we publish contract stubs they pull? | yes | Integration lead |
| Q-2 | Is 100 RPS the steady-state or peak target? | no | SRE |

## 11. Audit Trail

- Level Contract → analysis.R3 + two-consumer constraint
- Lane junit5-skill → stack detection: Spring Boot / Java 21
- Lane restassured-skill → stack override for API system tests
- p95 exit criterion → intake.constraints (300ms at 100 RPS)
