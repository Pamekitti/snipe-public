"""Run from bot/: python3 -m research prepare|benchmark|compare|report."""

import argparse
from pathlib import Path
from .core.data import capture, prepare


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    fidelity = sub.add_parser(
        "validate-replay",
        help="Compare independent execution and account predictions against actual cash",
    )
    inputs = fidelity.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--evaluation", type=Path)
    inputs.add_argument("--capture", type=Path, help="Frozen capture export for the corrected execution-account-v3 model")
    inputs.add_argument("--manifest", type=Path, help="Hashed shared-model audit manifest with fixed UTC boundaries")
    fidelity.add_argument("--out", required=True, type=Path)
    fidelity.add_argument("--dataset", type=Path, help="Optional immutable historical execution archive for --capture")
    cap = sub.add_parser("capture")
    cap.add_argument("--bot-db", required=True, type=Path)
    cap.add_argument("--gate-db", required=True, type=Path)
    cap.add_argument("--state", required=True, type=Path)
    cap.add_argument("--out", required=True, type=Path)
    prep = sub.add_parser("prepare")
    prep.add_argument("--snapshot", required=True, type=Path)
    prep.add_argument("--out", required=True, type=Path)
    prep.add_argument("--cache", type=Path, default=Path("data/research/cache.sqlite"))
    prep.add_argument("--fetch-missing", action="store_true")
    prep.add_argument("--days", type=int, default=14)
    pool = sub.add_parser("pools")
    pool.add_argument("--run", required=True, type=Path)
    pool.add_argument("--cache", type=Path, default=Path("data/research/cache.sqlite"))
    pool.add_argument("--fetch-missing", action="store_true")
    fork = sub.add_parser("fork-check")
    fork.add_argument("--run", required=True, type=Path)
    fork.add_argument("--anvil", required=True, type=Path)
    prep.add_argument(
        "--scope", choices=["benchmark", "opportunities"], default="benchmark"
    )
    prep.add_argument("--immutable-latest", action="store_true")
    prep.add_argument("--population", choices=["book", "screened"], default="book")
    prep.add_argument("--since-ms", type=int)
    for name in ["benchmark", "compare", "report"]:
        q = sub.add_parser(name)
        q.add_argument("--run", required=True, type=Path)
        if name == "compare":
            q.add_argument(
                "--mode",
                choices=["recorded", "opportunities", "legacy"],
                default="recorded",
            )
            q.add_argument("--policy-file", type=Path)
    args = p.parse_args()
    if args.command == "validate-replay":
        from .core.fidelity import run

        if args.manifest:
            from .core.unified_fidelity import run as unified_run
            result = unified_run(args.manifest, args.out)
        elif args.capture:
            from .core.alignment import run as corrected_run
            result = corrected_run(args.capture, args.out, args.dataset)
        else:
            result = run(args.evaluation, args.out)
        print(result["verdict"]["status"])
        print(args.out / "report.md")
        if not result["verdict"]["historical_fidelity_passed"]:
            raise SystemExit(2)
    elif args.command == "capture":
        print(capture(args.bot_db, args.gate_db, args.state, args.out))
    elif args.command == "prepare":
        print(
            prepare(
                args.snapshot,
                args.out,
                args.cache,
                args.fetch_missing,
                args.days,
                args.scope,
                args.immutable_latest,
                args.population,
                args.since_ms,
            )
        )
    elif args.command == "fork-check":
        from .core.forkcheck import run_forks

        print(run_forks(args.run, args.anvil))
    elif args.command == "pools":
        from .core.pools import quote

        quote(args.run, args.cache, args.fetch_missing)
    elif args.command == "benchmark":
        from .core.execution import benchmark

        benchmark(args.run)
    elif args.command == "compare":
        from .core.account import compare

        compare(args.run, args.mode, args.policy_file)
    else:
        from .core.reporting import report

        report(args.run)


if __name__ == "__main__":
    main()
