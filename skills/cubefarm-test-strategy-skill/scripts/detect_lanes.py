"""Detect which test-lane skills are present on the runtime tree.

The runtime tree is the location the harness loads skills from. On the user's
machine this is ~/.agents/skills/ (Windows: %USERPROFILE%\\.agents\\skills\\).

Usage:
    python scripts/detect_lanes.py              # human-readable
    python scripts/detect_lanes.py --json       # machine-readable
    python scripts/detect_lanes.py --root PATH  # override scan root
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Lanes the strategy skill knows how to map types to.
# Keep this in sync with references/lane-catalog.md.
KNOWN_LANES: dict[str, str] = {
    "stack-aware-unit-testing-skill": "Unit, Component (multi-stack)",
    "junit5-skill": "Unit, Component (Java)",
    "restassured-skill": "API system / E2E (Java)",
    "api-contract-sentinel": "Contract drift detection",
    "openapi-spec-generation": "Contract authoring",
    "playwright-skill": "E2E UI, visual, cross-browser, component",
    "cypress-skill": "E2E UI, component (alt to Playwright)",
    "login-flows": "Auth helper for E2E lane",
    "responsive-testing": "Responsive layout & behavior",
    "a11y-audit-agent-skill": "Accessibility",
    "performance-testing-skill": "Performance (load, stress, spike, soak)",
    "defensive-appsec-review-skill": "Security review",
    "data-batch-testing-skill": "Data / batch / ETL (planned)",
    "llm-eval-skill": "AI / ML evals (planned)",
}


def default_root() -> Path:
    """Return the platform-correct default runtime skills tree."""
    # Honor SKILLS_ROOT first (testability + override).
    env_root = os.environ.get("SKILLS_ROOT")
    if env_root:
        return Path(env_root)
    # Windows: %USERPROFILE%\.agents\skills
    # POSIX: ~/.agents/skills
    return Path.home() / ".agents" / "skills"


def detect(root: Path) -> dict[str, object]:
    if not root.exists():
        return {
            "root": str(root),
            "root_exists": False,
            "available": [],
            "missing": list(KNOWN_LANES.keys()),
            "unknown_present": [],
        }

    present_dirs = {p.name for p in root.iterdir() if p.is_dir()}
    available = []
    missing = []
    for lane, covers in KNOWN_LANES.items():
        if lane in present_dirs:
            available.append({"skill": lane, "covers": covers})
        else:
            missing.append(lane)
    # Anything in the runtime tree that we didn't list — surfaces drift
    unknown_present = sorted(present_dirs - set(KNOWN_LANES.keys()))
    return {
        "root": str(root),
        "root_exists": True,
        "available": available,
        "missing": missing,
        "unknown_present": unknown_present,
    }


def format_text(result: dict[str, object]) -> str:
    lines = [f"Runtime skills root: {result['root']}"]
    if not result["root_exists"]:
        lines.append("Root does not exist. Treat all known lanes as MISSING.")
    lines.append("")
    lines.append("Available lanes:")
    if result["available"]:
        for entry in result["available"]:
            lines.append(f"  - {entry['skill']}  ({entry['covers']})")
    else:
        lines.append("  (none)")
    lines.append("")
    lines.append("Missing lanes (mapped in catalog but not installed):")
    if result["missing"]:
        for name in result["missing"]:
            lines.append(f"  - {name}")
    else:
        lines.append("  (none)")
    if result.get("unknown_present"):
        lines.append("")
        lines.append("Other skills present (not in catalog):")
        for name in result["unknown_present"]:
            lines.append(f"  - {name}")
    return "\n".join(lines)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=None, help="Override the runtime skills root.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = args.root if args.root else default_root()
    result = detect(root)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_text(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
