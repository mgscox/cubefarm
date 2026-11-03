# Strategy Document JSON Schema

The `strategy.json` sidecar emitted by this skill must validate against the structure below. The lifecycle orchestrator consumes this JSON; if it is malformed, the chain halts.

## Top-Level Shape

```json
{
  "schema_version": "1.0",
  "skill": "test-strategy-skill",
  "generated_at": "ISO-8601 UTC timestamp",
  "sut": { ... },
  "mode": "lite | standard | full",
  "risk_class": "low | medium | high | critical",
  "mode_risk_mismatch": "none | warn | block",
  "stack": { ... },
  "levels": [ ... ],
  "types": [ ... ],
  "lanes": [ ... ],
  "scenarios": [ ... ],
  "routing": { "automated": [ ... ], "manual": [ ... ] },
  "test_data": { ... },
  "environments": [ ... ],
  "exit_criteria": { ... },
  "hitl_gates": [ ... ],
  "heal_cap": 4,
  "open_questions": [ ... ],
  "audit": [ ... ]
}
```

## Field Detail

### `sut`
```json
{
  "id": "string",
  "type": "requirement | feature | webapp | UI | batch | API | library | ml-model",
  "summary": "short one-liner"
}
```

### `stack` (may be `null` if no codebase_path was supplied)
```json
{
  "detected": true,
  "language": "string (e.g. typescript, java, python)",
  "framework": "string (e.g. next.js, spring-boot, fastapi)",
  "existing_runners": ["jest", "playwright", ...],
  "manifest_evidence": ["path/to/package.json", ...]
}
```

If `detected` is false, downstream lane choices are marked `provisional`.

### `levels`
Array of level objects:
```json
{
  "level": "unit | component | integration | contract | system | acceptance",
  "in_scope": true,
  "rationale": "one-sentence justification",
  "driver": "intake.risk_class=high | AC-12 | analysis.R3 | ..."
}
```

Every `in_scope: true` row must have a `driver`.

### `types`
Array of type-per-level objects:
```json
{
  "level": "system",
  "type": "performance",
  "priority": "P1 | P2 | P3",
  "rationale": "string",
  "driver": "string"
}
```

### `lanes`
Array of lane assignments:
```json
{
  "level": "system",
  "type": "performance",
  "lane_skill": "performance-testing-skill",
  "availability": "available | unavailable | provisional",
  "rationale": "string"
}
```

`availability` comes from `scripts/detect_lanes.py`. If `unavailable`, the row must appear in `open_questions` (or be acknowledged as low-risk and downgraded to manual).

### `scenarios`
Array of prioritized scenarios:
```json
{
  "id": "S-001",
  "name": "string",
  "source": "AC-12 | analysis.R3 | hazard.batch-concurrency",
  "impact": 1 | 2 | 4 | 8 | 16,
  "likelihood": 1 | 2 | 3 | 4 | 5,
  "coverage_priority": 1 | 2 | 3,
  "score": "impact * likelihood * coverage_priority",
  "category": "Low | Medium | High | Critical",
  "routing": "automated | manual | hybrid",
  "lane": "string (if automated/hybrid) or null"
}
```

Scenario scores must come from `scripts/prioritize_scenarios.py`. Inline scoring is invalid.

### `routing`
```json
{
  "automated": ["S-001", "S-003", ...],
  "manual": ["S-002", ...]
}
```

Must reference scenario IDs that exist in `scenarios`. Manual array must be present even if empty.

### `test_data`
```json
{
  "synthetic_required": true | false,
  "synthetic_skill": "lifelike-synthetic-data-generator" | null,
  "fixture_notes": "string",
  "pii_handling": "string"
}
```

### `environments`
Array of environments needed:
```json
{
  "name": "staging",
  "purpose": "E2E + perf",
  "available": true
}
```

### `exit_criteria`
```json
{
  "overall_pass_rate_min": 0.95,
  "p1_case_pass_rate_min": 1.0,
  "p2_case_pass_rate_min": 0.90,
  "open_findings": {
    "Critical": 0,
    "High": 0,
    "Medium": 5
  },
  "regression_pass_rate_min": 1.0,
  "additional": [
    { "key": "a11y_violations.critical", "op": "==", "value": 0 }
  ]
}
```

All numeric; no adjectives.

### `hitl_gates`
Array of active gates for the chosen mode:
```json
{
  "phase": 4,
  "name": "Strategy approval",
  "approver_role": "QA lead | Product owner | Security | ..."
}
```

### `open_questions`
```json
{
  "id": "Q-1",
  "question": "string",
  "blocker": true | false,
  "owner": "string or null"
}
```

If any `blocker: true`, the phase 4 HITL gate must not auto-approve.

### `audit`
Array of decision citations — every non-trivial choice in the doc, with its driver:
```json
{
  "decision": "include performance lane at system level",
  "driver": "intake.risk_class=high AND SUT.type=API"
}
```

## Validation

A minimal validator can check:

1. `schema_version` is present
2. `sut.type` is one of the allowed values
3. Every `levels[].in_scope=true` has a `driver`
4. Every `lanes[].availability=available` corresponds to a detected lane (cross-checked at runtime)
5. Every scenario's `score == impact * likelihood * coverage_priority`
6. `routing.manual` is present (may be empty)
7. `exit_criteria` contains no string values for thresholds
8. `hitl_gates` matches the mode (lite: only phase 13; standard: 4, 8, 13; full: 4, 8, 9, 12, 13)
