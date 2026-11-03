"""Score and rank test scenarios deterministically.

Scoring formula (must match references/strategy-framework.md):
    score = impact * likelihood * coverage_priority

Allowed scales:
    impact:            1, 2, 4, 8, 16
    likelihood:        1, 2, 3, 4, 5
    coverage_priority: 1, 2, 3  (1=P3, 2=P2, 3=P1)

Categories (post-coverage weighting):
    1-8       -> Low
    9-32      -> Medium
    33-96     -> High
    97-240    -> Critical

Input JSON shape (list at top level):
[
  {
    "id": "S-001",
    "name": "...",
    "source": "AC-12",
    "impact": 8,
    "likelihood": 3,
    "coverage_priority": 3,
    "routing_hint": "automated"   # optional
  },
  ...
]

Usage:
    python scripts/prioritize_scenarios.py --input scenarios.json --json
    python scripts/prioritize_scenarios.py --input scenarios.json --top 20
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

IMPACT_SCALE = {1, 2, 4, 8, 16}
LIKELIHOOD_SCALE = {1, 2, 3, 4, 5}
COVERAGE_SCALE = {1, 2, 3}

COVERAGE_LABEL = {1: "P3", 2: "P2", 3: "P1"}


def categorize(score: int) -> str:
    if score <= 8:
        return "Low"
    if score <= 32:
        return "Medium"
    if score <= 96:
        return "High"
    return "Critical"


def validate(scenario: dict) -> None:
    required = ("id", "impact", "likelihood", "coverage_priority")
    for key in required:
        if key not in scenario:
            raise ValueError(f"scenario {scenario.get('id', '?')} missing required field: {key}")
    if scenario["impact"] not in IMPACT_SCALE:
        raise ValueError(
            f"scenario {scenario['id']}: impact must be one of {sorted(IMPACT_SCALE)}"
        )
    if scenario["likelihood"] not in LIKELIHOOD_SCALE:
        raise ValueError(
            f"scenario {scenario['id']}: likelihood must be one of {sorted(LIKELIHOOD_SCALE)}"
        )
    if scenario["coverage_priority"] not in COVERAGE_SCALE:
        raise ValueError(
            f"scenario {scenario['id']}: coverage_priority must be one of {sorted(COVERAGE_SCALE)}"
        )


def score_scenario(scenario: dict) -> dict:
    validate(scenario)
    impact = scenario["impact"]
    likelihood = scenario["likelihood"]
    coverage_priority = scenario["coverage_priority"]
    score = impact * likelihood * coverage_priority
    return {
        "id": scenario["id"],
        "name": scenario.get("name", ""),
        "source": scenario.get("source", ""),
        "impact": impact,
        "likelihood": likelihood,
        "coverage_priority": coverage_priority,
        "p_label": COVERAGE_LABEL[coverage_priority],
        "score": score,
        "category": categorize(score),
        "routing_hint": scenario.get("routing_hint"),
    }


def score_all(scenarios: list[dict]) -> list[dict]:
    scored = [score_scenario(s) for s in scenarios]
    scored.sort(key=lambda s: (-s["score"], s["id"]))
    return scored


def format_text(scored: list[dict], top: int | None) -> str:
    rows = scored if top is None else scored[:top]
    lines = [
        f"{'ID':<10} {'Score':>6} {'Cat':<9} {'I':>3} {'L':>3} {'P':<3} {'Source':<18} Name",
        "-" * 90,
    ]
    for s in rows:
        lines.append(
            f"{s['id']:<10} {s['score']:>6} {s['category']:<9} "
            f"{s['impact']:>3} {s['likelihood']:>3} {s['p_label']:<3} "
            f"{(s['source'] or '-'):<18} {s['name']}"
        )
    if top is not None and len(scored) > top:
        lines.append("")
        lines.append(f"(showing top {top} of {len(scored)} scenarios)")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score and rank test scenarios.")
    parser.add_argument("--input", type=Path, required=True, help="Path to scenarios JSON file.")
    parser.add_argument("--top", type=int, default=None, help="Limit output to top N scenarios.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        scenarios = json.loads(args.input.read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"Error reading {args.input}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"Error: input is not valid JSON: {exc}", file=sys.stderr)
        return 2

    if not isinstance(scenarios, list):
        print("Error: input JSON must be a list of scenarios.", file=sys.stderr)
        return 2

    try:
        scored = score_all(scenarios)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    if args.json:
        rows = scored if args.top is None else scored[: args.top]
        print(json.dumps(rows, indent=2))
    else:
        print(format_text(scored, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
