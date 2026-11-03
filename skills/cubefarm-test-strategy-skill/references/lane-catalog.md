# Lane Catalog

Canonical mapping from (level, type) to the lane skill that should run it. Used by the strategy generator to fill section 5 of the strategy doc.

**Important:** Mapping a type to a lane here does *not* mean the lane is installed. Always cross-reference with `scripts/detect_lanes.py` before recommending a lane. If a lane is mapped but missing, surface as `unavailable` in the strategy and flag in Open Questions.

## Lane Inventory (expected runtime tree)

The following lane skills are expected at `~/.agents/skills/` (or `%USERPROFILE%\.agents\skills\` on Windows):

| Lane skill | Covers |
| --- | --- |
| `stack-aware-unit-testing-skill` | Unit, Component |
| `junit5-skill` | Unit, Component (Java) |
| `restassured-skill` | API system / E2E (Java) |
| `api-contract-sentinel` | Contract drift detection |
| `openapi-spec-generation` | Contract authoring (paired with `api-contract-sentinel`) |
| `playwright-skill` | E2E UI, visual regression, cross-browser, component (modern) |
| `cypress-skill` | E2E UI, component (alt to Playwright) |
| `login-flows` | Auth helper consumed by E2E lane |
| `responsive-testing` | Responsive layout & behavior |
| `a11y-audit-agent-skill` | Accessibility |
| `performance-testing-skill` | Performance (load, stress, spike, soak) |
| `defensive-appsec-review-skill` | Security review (non-destructive) |
| `data-batch-testing-skill` | Data / batch / ETL (planned) |
| `llm-eval-skill` | AI / ML evals (planned, conditional) |

## Level → Default Lane

| Level | Lane (default) | Alt |
| --- | --- | --- |
| Unit | `stack-aware-unit-testing-skill` | `junit5-skill` (Java) |
| Component | `stack-aware-unit-testing-skill` | `playwright-skill` (browser components), `junit5-skill` |
| Integration | `stack-aware-unit-testing-skill` + project test containers | `junit5-skill` |
| Contract | `api-contract-sentinel` + `openapi-spec-generation` | — |
| System / E2E (UI) | `playwright-skill` | `cypress-skill` |
| System / E2E (API) | `restassured-skill` | project-native (supertest, requests) |
| System / E2E (batch) | project-native batch runner | — |
| Acceptance (automated) | Same as System | — |
| Acceptance (manual UAT) | Phase 9b manual track | — |

## Type → Lane

### Functional
| Type | Default lane |
| --- | --- |
| Smoke | Same as System lane |
| Sanity | Same as System lane |
| Positive (happy) | Per level (unit / system) |
| Negative | Per level |
| Boundary | Unit (push down) |
| Regression | Whatever covers affected paths |
| Confirmation/retest | Per defect |

### Non-functional
| Type | Default lane |
| --- | --- |
| Performance | `performance-testing-skill` |
| Security | `defensive-appsec-review-skill` |
| Accessibility | `a11y-audit-agent-skill` |
| Responsive | `responsive-testing` |
| Usability | Manual (phase 9b) |
| Localization (i18n) | E2E lane with pseudo-localization (no dedicated skill) |
| Compatibility (cross-browser) | `playwright-skill` (multi-project config) |
| Visual regression | `playwright-skill` or `cypress-skill` snapshot mode |
| Reliability / Chaos | No dedicated skill — flag as `unavailable` |
| Installation / Upgrade | Project-native — flag as `unavailable` |

### Data
| Type | Default lane |
| --- | --- |
| Schema validation | `data-batch-testing-skill` (planned) → fallback `stack-aware-unit-testing-skill` + Great Expectations / dbt |
| Reconciliation | Same as schema |
| Idempotency / replay | Same as schema |
| Referential integrity | Integration tests (`stack-aware-unit-testing-skill`) |

### AI / ML
| Type | Default lane |
| --- | --- |
| Output quality eval | `llm-eval-skill` (planned) → fallback project-native |
| Hallucination check | `llm-eval-skill` (planned) |
| Bias / fairness | `llm-eval-skill` (planned) + manual ethics |
| Prompt regression | `llm-eval-skill` (planned) |

### Process / human (always manual)
| Type | Routing |
| --- | --- |
| Exploratory | Phase 9b |
| UAT | Phase 9b |
| Alpha / Beta | Phase 9b |
| OAT | Phase 9b |
| Documentation review | Phase 9b |

## Stack-Specific Overrides

When stack detection runs, apply these overrides:

- **Java/Spring** detected → prefer `junit5-skill` over generic `stack-aware-unit-testing-skill`; prefer `restassured-skill` for API E2E.
- **Node/TypeScript** detected → prefer `playwright-skill` over `cypress-skill` unless Cypress is already present in the repo.
- **Python** detected → use `stack-aware-unit-testing-skill` (it dispatches to pytest); for data/batch prefer project-native (Great Expectations, dbt).
- **Existing test runner present in repo** → extend it rather than introducing a new one. Note the override in the rationale column.

## Unavailable-Type Handling

If a type is mapped to a lane that the detector did not find:

1. Check if a sibling lane covers the same intent (visual → Playwright snapshot mode).
2. If still uncovered and risk ≥ high, mark `unavailable` and require Open Questions resolution.
3. If risk is low/medium, mark `manual / opportunistic` with a note.

Never silently drop a needed type.
