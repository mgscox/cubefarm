# Intake: New Payments REST API

## SUT
- **id:** API-PAY-2026
- **type:** API
- **summary:** New REST API exposing payment-initiation endpoints (`/v1/payments`, `/v1/payments/{id}`, `/v1/payments/{id}/refund`) consumed by internal storefront and 2 partner integrations.

## Risk Class
**high** — money movement, multi-consumer contract, public-ish surface.

## HITL Mode
**standard**

## Environments
- `dev`
- `staging` (sandbox payment provider attached)

## Inputs Available
- OpenAPI 3.1 spec at `apis/payments.yaml` (under version control)
- Stack: Spring Boot 3.2 / Java 21; JUnit 5 already in use; REST Assured present
- 8 ACs derived from the spec
- Risk findings: idempotency-key-collision (R1), refund-exceeds-original (R2), partner-A-uses-deprecated-field (R3)

## Constraints
- Two consumers must not break: storefront (owned) + partner-A (external)
- Idempotency mandatory for `POST /v1/payments`
- p95 latency target: 300ms at 100 RPS
