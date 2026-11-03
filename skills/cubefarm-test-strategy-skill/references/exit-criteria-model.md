# Exit Criteria & HITL Gate Model

This reference defines, per HITL mode and risk class, the **exit criteria** phase 12 (heal loop) uses to know when to stop, and the **HITL gate map** that phases consult to decide where to pause for human approval.

## Principle

Exit criteria must be **mechanically checkable**. The lifecycle orchestrator must be able to read the strategy JSON and compute pass/fail without further interpretation. Anything stated as an adjective ("comfortable", "reasonable") is invalid and must be rewritten as a number or boolean condition.

## Exit Criteria Templates

### Lite mode
Loose floor. For low-risk, internal, or prototype work.

```
overall_pass_rate >= 80%
open_findings.severity == "Critical": 0
open_findings.severity == "High": <= 3
p1_case_pass_rate >= 90%
```

### Standard mode
Default for customer-facing, non-regulated work.

```
overall_pass_rate >= 95%
open_findings.severity == "Critical": 0
open_findings.severity == "High": 0
open_findings.severity == "Medium": <= 5
p1_case_pass_rate == 100%
p2_case_pass_rate >= 90%
regression_pass_rate == 100%
```

### Full mode
Strict. For regulated, security-critical, EU AI Act high-risk, or auditor-visible work.

```
overall_pass_rate >= 95%
p1_case_pass_rate == 100%
p2_case_pass_rate == 100%
open_findings.severity == "Critical": 0
open_findings.severity == "High": 0
regression_pass_rate == 100%
a11y_violations.critical: 0
security_findings.severity >= "High": 0
evidence_pack.complete: true
audit_trail.complete: true
```

### Risk-class adjustments

Layer these on top of the mode baseline:

- **Critical risk class** — bump pass-rate thresholds by 5pp; require zero open High+.
- **High risk class** — require P1 100% pass even in Lite mode.
- **Low risk class** — may relax P2 thresholds by 10pp in Lite mode.

## HITL Gate Map

| Gate | Lite | Standard | Full |
| --- | --- | --- | --- |
| Phase 4 (Strategy approval) | — | ✓ | ✓ |
| Phase 8 (Exported artifacts approval) | — | ✓ | ✓ |
| Phase 9 (Per-lane Critical finding pause) | — | — | ✓ |
| Phase 12 (Heal-loop cap reached OR definition-changing fix) | — | log only | ✓ |
| Phase 13 (Final sign-off) | ✓ | ✓ | ✓ |

### Gate semantics

- **Phase 4** — human approves the strategy document. Defaults documented in `strategy-framework.md` apply unless overridden.
- **Phase 8** — human approves the exported test artifacts before automation cost is paid.
- **Phase 9** — when a lane (security, a11y, perf, etc.) surfaces a Critical-severity finding mid-execution, that lane pauses for triage. Other lanes continue.
- **Phase 12** — when the heal loop hits its iteration cap without exit criteria met, OR when a fix would mutate a stored case definition (phase 8 artifact), human decides whether to continue, accept residual risk, or rewrite the case.
- **Phase 13** — final attestable sign-off on the report. Captures who signed, when, and any waivers.

## Mode / Risk Mismatch Detection

The strategy doc must flag these:

| Risk class | Lite | Standard | Full |
| --- | --- | --- | --- |
| Low | ✓ | ✓ | over-engineered (warn) |
| Medium | ✓ | ✓ | possibly over-engineered (note) |
| High | mismatch (warn) | ✓ | ✓ |
| Critical | **block: must escalate** | mismatch (strongly warn) | ✓ |

A `block` condition means: write the strategy but emit an Open Questions entry saying "Critical risk under Lite mode is unsafe; recommend escalation to Full" and do not let phase 4 auto-approve.

## Audit Trail Requirements

For Full mode (and Standard when the SUT touches regulated data):

- Every HITL gate decision must be logged: who, when, what, why, and the evidence reviewed.
- Heal-loop iterations must be logged: iteration number, what changed, residual finding count.
- Exit criteria evaluation must be logged: which criteria passed, which failed, and the underlying numbers.
- Final report must include the audit trail summary.

Lite mode logs only the final sign-off.

## Heal Loop Iteration Caps

| Mode | Default cap |
| --- | --- |
| Lite | 2 iterations |
| Standard | 4 iterations |
| Full | 6 iterations |

When cap is hit:
- Lite — auto-stop, report residual risk.
- Standard — log; auto-stop but flag in report.
- Full — pause for HITL decision (phase 12 gate).

## Worked Example

A `webapp` SUT, risk `high`, mode `standard`:

**Exit criteria emitted:**
```
overall_pass_rate >= 95%
open_findings.severity == "Critical": 0
open_findings.severity == "High": 0
open_findings.severity == "Medium": <= 5
p1_case_pass_rate == 100%      ← bumped by high risk class
p2_case_pass_rate >= 90%
regression_pass_rate == 100%
```

**Gates active:** Phase 4, 8, 13.

**Heal cap:** 4 iterations.

**Audit:** Standard mode → log gate decisions only; full audit not required unless regulated data is in play.
