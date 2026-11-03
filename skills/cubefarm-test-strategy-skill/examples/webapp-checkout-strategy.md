# Test Strategy: Webapp Checkout Redesign

## Executive Summary

- **SUT:** WEB-CHECKOUT-2026 (webapp, Next.js 14 / TypeScript)
- **Mode:** standard | **Risk:** high
- **Mode/risk match:** ok
- **Top risks driving scope:** payment timeout (R1), price-mismatch-vs-server (R4), a11y on summary panel (R5)
- **Posture:** Comprehensive automation across unit/component/system + dedicated a11y, perf, and security lanes. Manual track for UAT and exploratory only.

## 1. Scope

**In scope:** new checkout flow front-end behavior (address autocomplete, saved-payment selector, summary panel), integration with payment provider sandbox, a11y, perf at the order-submit endpoint, security review of payment handoff.

**Out of scope:** payment provider internals, fulfillment downstream, legacy Cypress migration.

**Assumptions:** Playwright is the chosen E2E lane (Cypress deprecating per intake); synthetic test card numbers available from payment provider sandbox.

## 2. Test Levels in Scope

| Level | In scope | Rationale | Driver |
| --- | --- | --- | --- |
| Unit | ✓ | Price calculation, validation logic, saved-card filtering | intake.stack=Next.js; AC-3, AC-7 |
| Component | ✓ | Summary panel and saved-payment selector are reused | intake.SUT=webapp; AC-9, AC-11 |
| Integration | ✓ | Address autocomplete calls Google API; payment calls provider sandbox | analysis.R1, R2 |
| Contract | — | No published API surface owned by this team | — |
| System / E2E | ✓ | End-to-end happy path + key negatives | intake.risk=high |
| Acceptance | ✓ (UAT manual) | Product owner sign-off before launch | intake.HITL=standard |

## 3. Test Types per Level

| Level | Type | Priority | Rationale | Driver |
| --- | --- | --- | --- | --- |
| Unit | Positive + Negative + Boundary | P1 | Pricing logic; addr validation rules | AC-3, AC-7 |
| Component | Positive + Negative | P1 | Summary panel renders 12 fields | AC-9 |
| Component | Visual regression | P2 | Design system stable | analysis.R5 context |
| Integration | Happy path + timeout | P1 | Payment-timeout R1 is highest risk | analysis.R1 |
| System | Smoke | P1 | Cheapest failsafe | always |
| System | Positive (happy) | P1 | Each AC end-to-end | AC-1..AC-14 |
| System | Negative | P1 | Invalid card, expired session, network drop | analysis.R1, R4 |
| System | Regression | P1 | Legacy paths still work | intake.release_window |
| System | Accessibility | P1 | WCAG 2.1 AA mandatory | intake.constraints (legal) |
| System | Responsive | P1 | Mobile is 70% of traffic (inferred) | intake.SUT=webapp |
| System | Performance | P2 | Order-submit endpoint under load | analysis.R1 |
| System | Security | P1 | Payment handoff | intake.risk=high; PII/PCI |
| Acceptance | UAT (manual) | P1 | Product owner sign-off | intake.HITL=standard |
| Acceptance | Exploratory (manual) | P2 | Risk class high warrants charter session | intake.risk=high |

## 4. Lane Selection

| Level | Type | Lane | Availability | Rationale |
| --- | --- | --- | --- | --- |
| Unit | Positive/Negative/Boundary | `stack-aware-unit-testing-skill` | available | Detector confirmed; dispatches to jest |
| Component | Positive/Negative | `playwright-skill` (component mode) | available | Playwright already in repo |
| Component | Visual regression | `playwright-skill` (snapshot) | available | Folded into Playwright |
| Integration | Happy + timeout | `stack-aware-unit-testing-skill` + testcontainers | available | Jest + MSW for provider stub |
| System | All functional | `playwright-skill` | available | Stack override: Next.js prefers Playwright |
| System | Accessibility | `a11y-audit-agent-skill` | available | Detector confirmed |
| System | Responsive | `responsive-testing` | available | Detector confirmed |
| System | Performance | `performance-testing-skill` | available | Order-submit load test |
| System | Security | `defensive-appsec-review-skill` | available | Payment-handoff review |
| Acceptance | UAT, Exploratory | Phase 9b manual | — | Manual track |

`login-flows` will be consumed as a helper by the Playwright E2E lane (saved-payment selector requires auth state).

## 5. Risk-Prioritized Scenario Matrix

(Top 10; see `scenarios.json` for full list. All scored via `prioritize_scenarios.py`.)

| ID | Score | Cat | I | L | P | Source | Name | Routing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S-001 | 144 | Critical | 16 | 3 | 3 | analysis.R1 | Payment timeout leaves order in inconsistent state | automated (system + integration) |
| S-002 | 96 | High | 16 | 2 | 3 | analysis.R4 | Client price differs from server-computed total | automated (unit + system) |
| S-003 | 72 | High | 8 | 3 | 3 | analysis.R2 | Address validation bypassed via paste | automated (component + system) |
| S-004 | 72 | High | 8 | 3 | 3 | AC-11 | Saved-card selector shows expired cards | automated (component) |
| S-005 | 48 | High | 4 | 4 | 3 | AC-5 | Order summary renders wrong tax for tax-exempt | automated (unit) |
| S-006 | 48 | High | 8 | 2 | 3 | intake.legal | a11y violation blocks screen-reader checkout | automated (a11y lane) |
| S-007 | 36 | High | 4 | 3 | 3 | analysis.R5 | Summary panel keyboard trap | automated (a11y) + manual review |
| S-008 | 24 | Medium | 4 | 2 | 3 | AC-9 | Mobile viewport overlap on summary | automated (responsive) |
| S-009 | 18 | Medium | 2 | 3 | 3 | AC-13 | Network drop mid-submit retries safely | automated (system) |
| S-010 | 16 | Medium | 8 | 2 | 1 | hazard | XSS in address autocomplete | automated (security) |

## 6. Automated vs Manual Split

**Automated (feeds phase 9a):** S-001 through S-010 plus all P1/P2 AC-derived positives.

**Manual (feeds phase 9b):**
- UAT — product owner walks through all 14 ACs
- Exploratory — 90-minute charter session focused on edge cases around saved payments and address autocomplete
- Visual-diff triage — humans review any visual snapshots flagged by the automated lane

## 7. Test Data & Environments

- **Synthetic data required:** yes. Use `lifelike-synthetic-data-generator` for addresses (Belgian + US postal formats). Payment cards come from payment provider sandbox.
- **PII handling:** no real customer data in any environment.
- **Environments:**
  - `dev` — unit, component, integration (per branch)
  - `staging` — system, a11y, responsive, security
  - `prod-like` — performance only

## 8. Exit Criteria

(Generated via `derive_exit_criteria.py --mode standard --risk-class high`)

```
overall_pass_rate >= 95%
p1_case_pass_rate == 100%      (bumped by high risk class)
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
| 8 | Exported test artifacts approval | QA lead |
| 13 | Final sign-off | Product owner |

## 10. Open Questions

| ID | Question | Blocker | Owner |
| --- | --- | --- | --- |
| Q-1 | Confirm: a11y target is WCAG 2.1 AA, not 2.2? | no | Product owner |
| Q-2 | Performance SLO for order-submit (p95 latency)? | yes | SRE |
| Q-3 | Are international cards in scope this release? | yes | Product owner |

## 11. Audit Trail (citations)

- Level Unit included → AC-3, AC-7 require pricing logic
- Level Integration included → analysis.R1 (payment timeout)
- Type Performance included → analysis.R1, intake.risk=high
- Type Accessibility included → intake.constraints (legal requirement)
- Lane Playwright chosen → stack-detection: Next.js + Playwright already in repo
- Mode/risk match → high + standard = no mismatch
