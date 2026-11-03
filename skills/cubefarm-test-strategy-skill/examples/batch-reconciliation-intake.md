# Intake: Nightly Reconciliation Batch

## SUT
- **id:** BATCH-RECON-2026
- **type:** batch
- **summary:** Nightly Spark job that reconciles ledger entries between the core banking system and the data warehouse. Produces an exception report when discrepancies exceed a tolerance.

## Risk Class
**critical** — financial reconciliation; errors mean unbooked transactions or incorrect regulatory reports. SOX-relevant.

## HITL Mode
**full** — regulated finance, auditor visibility, compliance.

## Environments
- `dev` — small sample dataset
- `staging` — replicated subset of prod data (1 week)
- `prod-like` — full-volume snapshot, restricted access

## Inputs Available
- Functional spec describing 6 reconciliation rules (R-1..R-6)
- Risk findings: source-system-delay (R1), tolerance-threshold-drift (R2), duplicate-event-replay (R3), null-handling-asymmetry (R4)
- Stack: Spark 3.5 / Scala; Airflow DAG; results land in Snowflake
- Source schemas published; target schema versioned in dbt

## Constraints
- Job must complete in 2-hour window (00:00–02:00 UTC)
- Cannot run perf tests against prod
- Audit trail mandatory: who ran what when, what changed, signed off by whom
- All PII must be tokenized in non-prod
