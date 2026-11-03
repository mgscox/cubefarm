# Intake: Webapp Checkout Redesign

## SUT
- **id:** WEB-CHECKOUT-2026
- **type:** webapp
- **summary:** Redesigned checkout flow on the storefront — new address autocomplete, saved-payment selector, and order-summary panel.

## Risk Class
**high** — revenue-critical flow; bug = lost sales; touches payment provider; affects every transacting customer.

## HITL Mode
**standard** — customer-facing, non-regulated, normal release cadence.

## Environments
- `dev` — feature branch CI
- `staging` — full staging with sandbox payment provider
- `prod-like` — perf rig with anonymized prod data

## Inputs Available
- 14 ACs in Jira epic WEB-2026 (covering address validation, payment, summary, error states)
- Stack: Next.js 14 / TypeScript on Vercel; Playwright already in repo
- Test analysis report identified 5 risks: payment-timeout (R1), address-validation-bypass (R2), saved-card-stale (R3), price-mismatch-vs-server (R4), a11y-on-summary-panel (R5)
- Codebase available at `./apps/storefront`

## Constraints
- Release window: 2 weeks
- Existing Cypress suite is being deprecated — prefer Playwright
- Payments must be tested without real card numbers (synthetic only)
- a11y: WCAG 2.1 AA mandatory (legal requirement)
