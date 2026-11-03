# Test Levels Taxonomy

Aligned with ISTQB level definitions, adapted for modern stacks. Use this as the authoritative reference for what each level *is* and what it is *not*.

## Unit

**Scope:** One function, method, or class in isolation.

**Goal:** Verify the smallest testable unit behaves per its contract, fast, with no I/O.

**Typical signals you need this level:**
- Code-bearing SUT with discrete units
- Logic-heavy modules (calculations, parsers, state machines)
- Risk class medium or above

**Out of scope:** Cross-module integration, I/O, real databases, real network.

**Common runners:** JUnit, pytest, Jest, Vitest, RSpec, Go's `testing`.

## Component

**Scope:** A single deployable component or UI element in isolation, with collaborators stubbed.

**Goal:** Verify a component's external behavior across its public API or rendered output, without spinning up the full system.

**Typical signals:**
- UI work where individual components carry behavior
- Backend modules that are large enough to deserve isolated tests beyond unit
- Risk class medium or above for user-visible components

**Out of scope:** Cross-component flows, real backends.

**Common runners:** React Testing Library, Vue Test Utils, Storybook interaction tests, Spring `@WebMvcTest` slice tests.

## Integration

**Scope:** Two or more collaborating modules or services exercised together, often with real adapters but external systems faked or sandboxed.

**Goal:** Catch contract-mismatch and wiring bugs that unit tests miss.

**Typical signals:**
- SUT involves database, message queue, or another service
- A bug fix being confirmed crossed a module boundary
- Stack uses adapters / repositories / clients to external systems

**Out of scope:** Pure logic (use unit) and full end-to-end user paths (use system).

**Common runners:** Spring `@SpringBootTest`, testcontainers, pytest with docker fixtures, supertest.

## Contract

**Scope:** The agreement between consumer and provider of an API (REST, GraphQL, gRPC, async events).

**Goal:** Detect breaking changes to API shape, semantics, or behavior — independently from end-to-end runs.

**Typical signals:**
- SUT is an API or service crossing org/team boundaries
- Multiple consumers depend on a published interface
- OpenAPI / AsyncAPI / Protobuf contract exists

**Out of scope:** Business logic depth (use unit/integration) and full E2E flows.

**Common runners:** Pact, Spring Cloud Contract, Schemathesis, Postman/Newman against OpenAPI, `api-contract-sentinel`.

## System / E2E

**Scope:** The full SUT exercised through its real entry point (browser, CLI, API endpoint, batch invocation).

**Goal:** Confirm the assembled system delivers the intended user-visible behavior.

**Typical signals:**
- SUT has an end-to-end user journey
- Acceptance criteria are stated in user terms
- Risk class medium or above

**Out of scope:** Exhaustive edge cases (push those down to unit/integration), pure unit logic.

**Common runners:** Playwright, Cypress, Selenium, REST-Assured for API E2E, custom batch harnesses.

## Acceptance

**Scope:** Stakeholder validation that the system meets agreed acceptance criteria. May be automated (against AC) or human (UAT).

**Goal:** Provide the go/no-go signal for release.

**Typical signals:**
- A stakeholder approval gate exists
- AC are explicit and approved
- The work is user-facing or business-critical

**Out of scope:** Internal-only tooling without stakeholder visibility.

**Routes:** Automated AC checks via Gherkin/BDD frameworks; UAT routed to manual track in phase 9b.

## Level Coverage Matrix

Use this as a quick reference when filling section 3 of the strategy doc:

| SUT type | Unit | Component | Integration | Contract | System | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| Requirement (doc only) | — | — | — | — | — | review only |
| Feature (mixed stack) | ✓ | conditional | ✓ | conditional | ✓ | ✓ |
| Webapp | ✓ | ✓ | ✓ | conditional | ✓ | ✓ |
| UI (component lib) | ✓ | ✓ | rare | — | ✓ (storybook) | conditional |
| Batch / ETL | ✓ | rare | ✓ | conditional | ✓ (job run) | conditional |
| API / service | ✓ | rare | ✓ | ✓ | ✓ | conditional |
| Library | ✓ | — | conditional | conditional | smoke only | — |
| ML model | ✓ (data prep) | — | ✓ (pipeline) | conditional | ✓ (eval suite) | conditional |

`conditional` = include if risk class ≥ medium or AC explicitly require it.
