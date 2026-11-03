"""Derive mode-aware exit criteria and HITL gate map for a test strategy.

Inputs:
    --mode       lite | standard | full
    --risk-class low | medium | high | critical

Output (JSON or text) mirrors references/exit-criteria-model.md:
    - exit_criteria: numeric thresholds the heal loop checks
    - hitl_gates: which gates are active for the chosen mode
    - heal_cap: maximum heal-loop iterations
    - mismatch: severity flag if mode does not fit risk class

Usage:
    python scripts/derive_exit_criteria.py --mode standard --risk-class high
    python scripts/derive_exit_criteria.py --mode lite --risk-class critical --json
"""
from __future__ import annotations

import argparse
import json
import sys

MODES = ("lite", "standard", "full")
RISK_CLASSES = ("low", "medium", "high", "critical")

BASE_EXIT_CRITERIA = {
    "lite": {
        "overall_pass_rate_min": 0.80,
        "p1_case_pass_rate_min": 0.90,
        "p2_case_pass_rate_min": None,
        "regression_pass_rate_min": None,
        "open_findings": {"Critical": 0, "High": 3, "Medium": None},
    },
    "standard": {
        "overall_pass_rate_min": 0.95,
        "p1_case_pass_rate_min": 1.00,
        "p2_case_pass_rate_min": 0.90,
        "regression_pass_rate_min": 1.00,
        "open_findings": {"Critical": 0, "High": 0, "Medium": 5},
    },
    "full": {
        "overall_pass_rate_min": 0.95,
        "p1_case_pass_rate_min": 1.00,
        "p2_case_pass_rate_min": 1.00,
        "regression_pass_rate_min": 1.00,
        "open_findings": {"Critical": 0, "High": 0, "Medium": 5},
        "extras": [
            {"key": "a11y_violations.critical", "op": "==", "value": 0},
            {"key": "security_findings.severity_ge_high", "op": "==", "value": 0},
            {"key": "evidence_pack.complete", "op": "==", "value": True},
            {"key": "audit_trail.complete", "op": "==", "value": True},
        ],
    },
}

HITL_GATES = {
    "lite": [
        {"phase": 13, "name": "Final sign-off", "approver_role": "Owner / QA lead"},
    ],
    "standard": [
        {"phase": 4, "name": "Strategy approval", "approver_role": "QA lead"},
        {"phase": 8, "name": "Exported artifacts approval", "approver_role": "QA lead"},
        {"phase": 13, "name": "Final sign-off", "approver_role": "Product owner"},
    ],
    "full": [
        {"phase": 4, "name": "Strategy approval", "approver_role": "QA lead + Security"},
        {"phase": 8, "name": "Exported artifacts approval", "approver_role": "QA lead"},
        {"phase": 9, "name": "Per-lane Critical finding pause", "approver_role": "Lane owner"},
        {"phase": 12, "name": "Heal-loop cap or definition-changing fix", "approver_role": "QA lead"},
        {"phase": 13, "name": "Final sign-off", "approver_role": "Product owner + Compliance"},
    ],
}

HEAL_CAPS = {"lite": 2, "standard": 4, "full": 6}


def adjust_for_risk(exit_criteria: dict, risk_class: str, mode: str) -> dict:
    """Apply risk-class adjustments per references/exit-criteria-model.md."""
    adjusted = json.loads(json.dumps(exit_criteria))  # deep copy via json
    if risk_class == "critical":
        # Bump pass-rate thresholds by 0.05 (capped at 1.0)
        for key in ("overall_pass_rate_min", "p1_case_pass_rate_min", "p2_case_pass_rate_min"):
            v = adjusted.get(key)
            if isinstance(v, (int, float)):
                adjusted[key] = min(1.0, round(v + 0.05, 2))
        adjusted["open_findings"]["High"] = 0
    elif risk_class == "high":
        # Even in Lite, P1 must pass 100%
        if mode == "lite":
            adjusted["p1_case_pass_rate_min"] = 1.00
    elif risk_class == "low" and mode == "lite":
        # Relax P2 threshold if present
        if adjusted.get("p2_case_pass_rate_min") is not None:
            adjusted["p2_case_pass_rate_min"] = max(0.0, round(adjusted["p2_case_pass_rate_min"] - 0.10, 2))
    return adjusted


def mismatch_severity(mode: str, risk_class: str) -> str:
    """Return 'none' | 'warn' | 'block' for the mode/risk pairing."""
    table = {
        ("low", "lite"): "none",
        ("low", "standard"): "none",
        ("low", "full"): "warn",
        ("medium", "lite"): "none",
        ("medium", "standard"): "none",
        ("medium", "full"): "warn",
        ("high", "lite"): "warn",
        ("high", "standard"): "none",
        ("high", "full"): "none",
        ("critical", "lite"): "block",
        ("critical", "standard"): "warn",
        ("critical", "full"): "none",
    }
    return table.get((risk_class, mode), "none")


def build_result(mode: str, risk_class: str) -> dict:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if risk_class not in RISK_CLASSES:
        raise ValueError(f"risk-class must be one of {RISK_CLASSES}")
    exit_criteria = adjust_for_risk(BASE_EXIT_CRITERIA[mode], risk_class, mode)
    return {
        "mode": mode,
        "risk_class": risk_class,
        "mismatch": mismatch_severity(mode, risk_class),
        "exit_criteria": exit_criteria,
        "hitl_gates": HITL_GATES[mode],
        "heal_cap": HEAL_CAPS[mode],
    }


def format_text(result: dict) -> str:
    lines = []
    lines.append(f"Mode: {result['mode']}   Risk class: {result['risk_class']}")
    lines.append(f"Mode/risk mismatch: {result['mismatch']}")
    if result["mismatch"] == "block":
        lines.append("  >>> BLOCK: this pairing is unsafe; recommend escalation.")
    elif result["mismatch"] == "warn":
        lines.append("  >>> WARN: pairing is suboptimal; consider escalating or relaxing mode.")
    lines.append("")
    lines.append("Exit criteria:")
    ec = result["exit_criteria"]
    for key, value in ec.items():
        if key == "extras":
            lines.append("  extras:")
            for extra in value:
                lines.append(f"    - {extra['key']} {extra['op']} {extra['value']}")
        elif key == "open_findings":
            lines.append("  open_findings:")
            for severity, threshold in value.items():
                if threshold is None:
                    lines.append(f"    - {severity}: (no limit)")
                else:
                    lines.append(f"    - {severity}: <= {threshold}")
        else:
            display = "(no limit)" if value is None else value
            lines.append(f"  {key}: {display}")
    lines.append("")
    lines.append("HITL gates active:")
    for gate in result["hitl_gates"]:
        lines.append(f"  - phase {gate['phase']}: {gate['name']}  (approver: {gate['approver_role']})")
    lines.append("")
    lines.append(f"Heal-loop iteration cap: {result['heal_cap']}")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=MODES)
    parser.add_argument("--risk-class", required=True, choices=RISK_CLASSES, dest="risk_class")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = build_result(args.mode, args.risk_class)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
