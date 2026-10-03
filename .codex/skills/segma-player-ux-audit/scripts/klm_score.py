#!/usr/bin/env python3
"""Deterministic KLM scorer for Segma Player UX flow comparisons."""

from __future__ import annotations

import argparse
import re
import sys

OPERATORS = {"M": 1.35, "P": 1.10, "B": 0.10, "K": 0.20, "H": 0.40}
TOKEN_RE = re.compile(r"^([MPBKH])(\d*)$", re.IGNORECASE)


def parse_sequence(raw: str) -> list[str]:
    tokens: list[str] = []
    for part in re.split(r"[\s,]+", raw.strip()):
        if not part:
            continue
        match = TOKEN_RE.fullmatch(part)
        if match:
            count = int(match.group(2) or "1")
            if count < 1:
                raise ValueError(f"invalid count in {part!r}")
            tokens.extend([match.group(1).upper()] * count)
            continue
        compact = re.fullmatch(r"(?:[MPBKH]\d*)+", part, re.IGNORECASE)
        if not compact:
            raise ValueError(f"unknown operator {part!r}; use M/P/B/K/H")
        for operator, count_text in re.findall(r"([MPBKH])(\d*)", part, re.IGNORECASE):
            tokens.extend([operator.upper()] * int(count_text or "1"))
    if not tokens:
        raise ValueError("empty sequence")
    return tokens


def score(raw: str) -> dict[str, object]:
    tokens = parse_sequence(raw)
    return {
        "ops": " ".join(tokens),
        "operators": len(tokens),
        "mental": tokens.count("M"),
        "seconds": round(sum(OPERATORS[token] for token in tokens), 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Score Segma Player interaction paths")
    sub = parser.add_subparsers(dest="command", required=True)
    score_parser = sub.add_parser("score")
    score_parser.add_argument("sequence", nargs="+")
    score_parser.add_argument("--label", nargs="*")
    steps_parser = sub.add_parser("steps")
    steps_parser.add_argument("step", nargs="+")
    selftest_parser = sub.add_parser("selftest")
    args = parser.parse_args()

    try:
        if args.command == "selftest":
            shortcut = score("M K K")
            menu = score("M H P B M P B")
            assert shortcut["seconds"] == 1.75
            assert menu["seconds"] == 5.50
            assert menu["mental"] == 2
            print("OK")
            return 0

        if args.command == "score":
            labels = args.label or [f"path{i + 1}" for i in range(len(args.sequence))]
            if len(labels) != len(args.sequence):
                parser.error("--label count must match sequence count")
            results = [(label, score(sequence)) for label, sequence in zip(labels, args.sequence)]
            for label, result in results:
                print(f"{label}: M={result['mental']} sec={result['seconds']:.2f} ops={result['ops']}")
            if len(results) >= 2:
                base, comparison = results[0][1], results[1][1]
                print(
                    f"delta: M={comparison['mental'] - base['mental']:+d} "
                    f"sec={comparison['seconds'] - base['seconds']:+.2f}"
                )
            return 0

        total_tokens: list[str] = []
        for item in args.step:
            label, _, operators = item.partition("=")
            result = score(operators or "MPB")
            total_tokens.extend(result["ops"].split())
            print(f"{label}: M={result['mental']} sec={result['seconds']:.2f} ops={result['ops']}")
        total = score(" ".join(total_tokens))
        print(f"total: M={total['mental']} sec={total['seconds']:.2f}")
        return 0
    except (AssertionError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

