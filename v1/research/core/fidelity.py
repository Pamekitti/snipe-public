"""Standard actual-versus-predicted backtest checks. Offline; never approves trading."""

from __future__ import annotations

import collections
from dataclasses import replace
import math
from pathlib import Path
import statistics

from .data import BOT, HOUR, Worker, digest, read_json, write_artifact, write_json
from .evaluation import (
    NON_TRADE,
    context,
    entry,
    iso,
    spans,
    model_account_inputs,
    replay_model_account,
)
from .execution import booked, describe, path_request, validate_dataset

LIMITS = BOT / "research/BACKTEST_LIMITS_V1.json"


def validation_status(root):
    """A stale, absent or failed certificate never permits a realism claim."""
    try:
        pointer = read_json(Path(root) / "fidelity-current.json")
        artifact = Path(pointer["artifact"])
        if digest(artifact) != pointer["sha256"]:
            raise ValueError("certificate hash mismatch")
        result = read_json(artifact)
        if result.get("model_version") != "execution-account-v3":
            raise ValueError("historical model predates corrected execution-account-v3; ranking remains frozen")
        for name, expected in result["source_hashes"].items():
            if digest(Path(root) / name) != expected:
                raise ValueError("evaluation changed: " + name)
        for name, expected in result["runtime_hashes"].items():
            if digest(BOT / name) != expected:
                raise ValueError("simulator changed: " + name)
        if digest(LIMITS) != result["limits_sha256"]:
            raise ValueError("acceptance limits changed")
        return dict(
            status=result["verdict"]["status"],
            passed=result["verdict"]["historical_fidelity_passed"],
            report=pointer["report"],
            reason="Current frozen scorecard; no prospective validation or live approval",
        )
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return dict(status="diagnostic_only", passed=False, reason=str(exc))


def sign(value):
    return (value > 0) - (value < 0)


def cash_metrics(rows):
    """Gross wins/losses use whole attempts; equity uses each row's cash time."""
    rows = sorted(rows, key=lambda r: (r["at"], str(r["id"])))
    total = peak = dd = 0
    for r in rows:
        total += int(r["pnl"])
        peak = max(peak, total)
        dd = max(dd, peak - total)
    by_id = collections.defaultdict(int)
    for r in rows:
        by_id[r["id"]] += int(r["pnl"])
    return dict(
        n=len(by_id),
        net_wei=str(total),
        profit_wei=str(sum(max(v, 0) for v in by_id.values())),
        loss_wei=str(-sum(min(v, 0) for v in by_id.values())),
        drawdown_wei=str(dd),
        winners=sum(v > 0 for v in by_id.values()),
        losers=sum(v < 0 for v in by_id.values()),
        cash_eth=describe(v / 1e18 for v in by_id.values()),
    )


def cash_contrast(actual, predicted, stake):
    a, p = cash_metrics(actual), cash_metrics(predicted)
    events = collections.defaultdict(lambda: [0, 0])
    for i, rows in enumerate((actual, predicted)):
        for r in rows:
            events[r["at"]][i] += int(r["pnl"])
    av = pv = maximum = 0
    for at in sorted(events):
        av += events[at][0]
        pv += events[at][1]
        maximum = max(maximum, abs(pv - av))

    def relative(key):
        base, estimate = int(a[key]), int(p[key])
        return abs(estimate - base) / base if base else (0 if estimate == 0 else None)

    return dict(
        actual=a,
        predicted=p,
        net_error_wei=str(int(p["net_wei"]) - int(a["net_wei"])),
        net_error_stakes=abs(int(p["net_wei"]) - int(a["net_wei"])) / stake,
        gross_profit_relative_error=relative("profit_wei"),
        gross_loss_relative_error=relative("loss_wei"),
        drawdown_error_stakes=abs(int(p["drawdown_wei"]) - int(a["drawdown_wei"]))
        / stake,
        maximum_equity_gap_wei=str(maximum),
        maximum_equity_gap_stakes=maximum / stake,
    )


def paired_metrics(rows):
    pairs = [
        r
        for r in rows
        if r["predicted_wei"] is not None and r["actual_wei"] is not None
    ]
    errors = [
        100 * (int(r["predicted_wei"]) - int(r["actual_wei"])) / r["size"]
        for r in pairs
    ]
    signs = sum(
        sign(int(r["predicted_wei"])) == sign(int(r["actual_wei"])) for r in pairs
    )
    return dict(
        expected=len(rows),
        known=len(pairs),
        missing=len(rows) - len(pairs),
        signed_error_pp=describe(errors),
        absolute_error_pp=describe(abs(v) for v in errors),
        sign_matches=signs,
        sign_agreement=signs / len(pairs) if pairs else None,
        statuses=dict(collections.Counter(r["status"] for r in rows)),
    )


def prediction_rows(dataset, positions, models, worker):
    """Use known intent and preceding calibration, never copy actual P&L or failures."""
    rows = []
    for p in positions:
        at, token = entry(p), p["token"].lower()
        z = models["tokens"].get(token)
        result = {"status": "missing_model_inputs"}
        fill = {"status": "not_a_completed_trade"}
        if (
            z
            and z["entry"] == at
            and z["size"] == int(p["spend_wei"])
            and all(
                z.get(k) is not None
                for k in (
                    "gas_wei",
                    "buy_gas_wei",
                    "delay_ms",
                    "send_delay_ms",
                    "open_delay_ms",
                )
            )
        ):
            req, missing = path_request(
                dataset, p, int(z["gas_wei"]), lag=z["delay_ms"], poll=50
            )
            if missing:
                result = {"status": missing}
            else:
                req.update(
                    buyGasWei=z["buy_gas_wei"],
                    buyAt=at + max(0, z["send_delay_ms"]),
                    openedAt=at + max(0, z["open_delay_ms"]),
                )
                result = worker.call(**req)
                if (
                    p.get("closed")
                    and p.get("exit_reason") not in NON_TRADE
                    and p.get("buy_hash")
                    and p.get("entry_mark_wei") is not None
                ):
                    clock = context(p).get("at", at)
                    fill = worker.call(
                        **{
                            **req,
                            "mode": "recorded_fill",
                            "buyHash": p["buy_hash"],
                            "entryMarkWei": p["entry_mark_wei"],
                            "entryAt": clock,
                            "openedAt": clock,
                            "endAt": min(p["exit_at"], dataset["snapshot_at"]),
                        }
                    )
        status = result["status"]
        predicted = (
            result.get("pnlWei") if status in ("closed", "buy_reverted") else None
        )
        if status == "entry_price_rejected":
            # A definite model decision not to trade is a zero-cash prediction.
            # Missing execution evidence is never assigned this value.
            predicted = "0"
        actual = (
            booked(p)
            if p.get("closed")
            and (p.get("onchain_pnl_wei") is not None or p.get("pnl_wei") is not None)
            else None
        )
        rows.append(
            dict(
                id=p["id"],
                token=token,
                entry=at,
                size=int(p["spend_wei"]),
                actual_at=p.get("exit_at"),
                actual_wei=str(actual) if actual is not None else None,
                actual_reason=p.get("exit_reason"),
                actual_failed=p.get("exit_reason") in NON_TRADE,
                predicted_at=result.get(
                    "exitAt", at if status == "entry_price_rejected" else None
                ),
                predicted_wei=str(predicted) if predicted is not None else None,
                predicted_reason=result.get("reason"),
                status=status,
                result=result,
                fill_decision=fill,
                simulated_failure=status == "buy_reverted",
                gas_input_wei=z.get("gas_wei") if z else None,
                inputs_conditioned_on="recorded entry intent, target and send clock; preceding costs and exit delay",
            )
        )
    return rows


def execution_windows(rows, start, end, stake):
    result = {}
    for name, (lo, hi) in spans(end, start).items():
        cohort = [r for r in rows if lo <= r["entry"] < hi]
        known = [
            r
            for r in cohort
            if r["predicted_wei"] is not None and r["actual_wei"] is not None
        ]
        actual = [
            dict(at=r["actual_at"], id=r["id"], pnl=int(r["actual_wei"])) for r in known
        ]
        predicted = [
            dict(at=r["predicted_at"], id=r["id"], pnl=int(r["predicted_wei"]))
            for r in known
        ]
        result[name] = dict(
            from_ms=lo,
            to_ms=hi,
            available=hi > lo,
            paired=paired_metrics(cohort),
            cash=cash_contrast(actual, predicted, stake),
            cash_scope="common known intent cohort; unavailable outcomes excluded from both cash sums",
        )
    return result


def account_windows(positions, account, start, end, stake):
    actual_complete = all(
        p.get("closed")
        and p.get("exit_at")
        and (p.get("onchain_pnl_wei") is not None or p.get("pnl_wei") is not None)
        for p in positions
    )
    actual = [
        dict(at=p["exit_at"], id=p["token"].lower(), pnl=booked(p))
        for p in positions
        if p.get("closed")
        and p.get("exit_at")
        and (p.get("onchain_pnl_wei") is not None or p.get("pnl_wei") is not None)
    ]
    # Whole-attempt cash at close gives both sides the same accounting convention.
    accumulated = collections.defaultdict(int)
    last = {}
    for r in account["cash"]:
        accumulated[r["id"]] += int(r["pnl"])
        last[r["id"]] = max(last.get(r["id"], 0), r["at"])
    predicted = [dict(at=last[k], id=k, pnl=v) for k, v in accumulated.items()]
    known_until = min((r["at"] for r in account.get("unresolved", [])), default=end)
    result = {}
    for name, (lo, hi) in spans(end, start).items():
        bound = min(hi, known_until)
        a = [r for r in actual if lo <= r["at"] < bound]
        b = [r for r in predicted if lo <= r["at"] < bound]
        expected_entries = {
            p["token"].lower() for p in positions if lo <= entry(p) < bound
        }
        predicted_entries = {
            r["id"]
            for r in account["decisions"]
            if r["reason"] is None and lo <= r["at"] < bound
        }
        shared = expected_entries & predicted_entries
        result[name] = dict(
            from_ms=lo,
            to_ms=hi,
            available=bound > lo,
            complete=account["complete"]
            and actual_complete
            and not account.get("open_ids")
            and hi <= known_until,
            known_until_ms=known_until,
            cash=cash_contrast(a, b, stake),
            actual_entries=len(expected_entries),
            predicted_entries=len(predicted_entries),
            shared_entries=len(shared),
            entry_precision=(
                len(shared) / len(predicted_entries) if predicted_entries else None
            ),
            entry_recall=(
                len(shared) / len(expected_entries) if expected_entries else None
            ),
            missed_actual_tokens=sorted(expected_entries - predicted_entries),
            extra_simulated_tokens=sorted(predicted_entries - expected_entries),
        )
    return result


def grade(execution, account, evidence, limits):
    checks = []

    def check(name, observed, required, passed):
        checks.append(
            dict(name=name, observed=observed, required=required, passed=bool(passed))
        )

    def upper(name, value, threshold):
        check(name, value, f"<= {threshold}", value is not None and value <= threshold)

    def lower(name, value, threshold):
        check(name, value, f">= {threshold}", value is not None and value >= threshold)

    for key in (
        "receipt_accounting_complete",
        "arithmetic_exact",
        "historical_source_matches",
        "calibration_is_causal",
        "input_hashes_valid",
        "account_engine_reproduces_saved_run",
    ):
        check(key, evidence.get(key), True, evidence.get(key) is True)
    upper(
        "wallet_residual_wei",
        (
            abs(int(evidence["wallet_residual_wei"]))
            if evidence.get("wallet_residual_wei") is not None
            else None
        ),
        limits["max_wallet_residual_wei"],
    )
    lower(
        "actual_fill_exit_reason_agreement",
        evidence.get("exit_reason_agreement"),
        limits["min_exit_reason_agreement"],
    )
    timing = evidence.get("exit_time_error_ms", {})
    check(
        "actual_fill_timing_complete",
        timing.get("n"),
        evidence.get("exit_time_expected"),
        evidence.get("exit_time_expected", 0) > 0
        and timing.get("n") == evidence.get("exit_time_expected"),
    )
    upper(
        "actual_fill_median_exit_time_error_ms",
        timing.get("median"),
        limits["max_median_exit_time_error_ms"],
    )
    upper(
        "actual_fill_p95_exit_time_error_ms",
        timing.get("p95"),
        limits["max_p95_exit_time_error_ms"],
    )
    check(
        "independent_failure_predictions",
        evidence.get("failures_matched"),
        evidence.get("actual_failures"),
        evidence.get("actual_failures") is not None
        and evidence.get("failures_matched") == evidence.get("actual_failures"),
    )
    partitions = [
        ("fit", limits["min_fit_attempts"]),
        ("reserved6h", limits["min_reserved_attempts"]),
    ] + [
        (name, limits["min_era_attempts"])
        for name in execution
        if name.startswith("era_")
    ]
    for period, minimum in partitions:
        x = execution[period]["paired"]
        lower(period + ".sample", x["expected"], minimum)
        upper(period + ".missing_predictions", x["missing"], 0)
        signed, absolute = x["signed_error_pp"], x["absolute_error_pp"]
        upper(
            period + ".absolute_bias_pp",
            abs(signed["mean"]) if signed["mean"] is not None else None,
            limits["max_absolute_bias_pp"],
        )
        for stat, key in (
            ("mean", "max_mean_absolute_error_pp"),
            ("median", "max_median_absolute_error_pp"),
            ("p95", "max_p95_absolute_error_pp"),
        ):
            upper(period + ".absolute_error_" + stat, absolute[stat], limits[key])
        lower(
            period + ".sign_agreement",
            x["sign_agreement"],
            limits["min_sign_agreement"],
        )
    for period in ("current", "fit", "reserved6h"):
        a = account[period]
        check(period + ".account_complete", a["complete"], True, a["complete"])
        lower(
            period + ".entry_precision",
            a["entry_precision"],
            limits["min_entry_precision"],
        )
        lower(period + ".entry_recall", a["entry_recall"], limits["min_entry_recall"])
        for field, key in (
            ("gross_profit_relative_error", "max_gross_profit_relative_error"),
            ("gross_loss_relative_error", "max_gross_loss_relative_error"),
            ("net_error_stakes", "max_net_error_stakes"),
            ("drawdown_error_stakes", "max_drawdown_error_stakes"),
            ("maximum_equity_gap_stakes", "max_equity_gap_stakes"),
        ):
            upper(period + "." + field, a["cash"][field], limits[key])
    return dict(
        status=(
            "historical_fidelity_pass"
            if all(c["passed"] for c in checks)
            else "diagnostic_only"
        ),
        historical_fidelity_passed=all(c["passed"] for c in checks),
        prospective_validation=False,
        live_change_authorized=False,
        checks=checks,
    )


def causal_inputs(raw, positions, models, audit, end):
    """Recompute stored cost medians and counts using only earlier fit-period closes."""
    start = models["cost_era_start"]
    candidates = []
    for p in raw["bot_positions"]:
        if not (
            p["live"]
            and p.get("buy_ok")
            and p.get("closed")
            and p.get("exit_at")
            and start <= entry(p)
            and p["exit_at"] < end - 6 * HOUR
            and p.get("onchain_pnl_wei") is not None
        ):
            continue
        gas = int(p.get("proceeds_wei") or 0) - int(p["spend_wei"]) - booked(p)
        if gas >= 0:
            candidates.append((p["exit_at"], gas))
    failures = []
    for p in positions:
        z = models["tokens"].get(p["token"].lower())
        if not z:
            failures.append(dict(id=p["id"], reason="missing_inputs"))
            continue
        costs = [v for t, v in candidates if t < entry(p)]
        timing = [
            t["decision_to_close_ms"]
            for t in audit["execution"]["rows"]
            if start <= t["entry"] and t["exit_at"] < min(entry(p), end - 6 * HOUR)
        ]
        expected_delay = (
            math.ceil(statistics.median(timing) / 50) * 50 if timing else 600
        )
        if (
            not costs
            or int(statistics.median(costs)) != int(z["gas_wei"] or -1)
            or len(costs) != z["gas_n"]
            or expected_delay != z["delay_ms"]
        ):
            failures.append(dict(id=p["id"], reason="preceding_cost_or_delay_mismatch"))
    return dict(passed=not failures, checked=len(positions), failures=failures)


def run(evaluation, out):
    root, out = Path(evaluation).resolve(), Path(out).resolve()
    if out.exists():
        raise ValueError("validation output already exists; choose a fresh directory")
    limits = read_json(LIMITS)
    d, manifest = validate_dataset(root / "replay")
    raw = read_json(root / "snapshot.json.gz")
    audit, models, comparison, benchmark = [
        read_json(root / f)
        for f in (
            "audit.json",
            "models.json",
            "comparison.json",
            "replay/benchmark.json",
        )
    ]
    start, end = audit["current_start"], audit["captured_at"]
    paths = [
        "snapshot.json.gz",
        "audit.json",
        "models.json",
        "comparison.json",
        "replay/benchmark.json",
        "model-provenance.json",
        "comparison-provenance.json",
        "source-verification.json",
        "replay/dataset.json",
        "replay/manifest.json",
    ]
    hashes = {name: digest(root / name) for name in paths}
    if not (
        hashes["snapshot.json.gz"] == audit["snapshot_sha256"]
        and d["snapshot_at"] == raw["snapshot_at"] == end == comparison["capture"]
        and d["start"] == start == comparison["current_start"]
        and models["dataset_sha256"]
        == benchmark["dataset_sha256"]
        == manifest["dataset_sha256"]
        and comparison["models_sha256"] == hashes["models.json"]
        and read_json(root / "model-provenance.json")["models_sha256"]
        == hashes["models.json"]
        and read_json(root / "comparison-provenance.json")["comparison_sha256"]
        == hashes["comparison.json"]
    ):
        raise ValueError("stale or mismatched evaluation inputs")
    positions = sorted(
        (
            p
            for p in raw["bot_positions"]
            if p["live"]
            and (p.get("cohort") or "main") == "main"
            and start <= entry(p) < end
        ),
        key=entry,
    )
    if not positions or len({p["token"].lower() for p in positions}) != len(positions):
        raise ValueError("nonempty, unique-token actual attempt cohort required")
    stake = min(int(p["spend_wei"]) for p in positions)
    if stake <= 0:
        raise ValueError("positive actual stakes required")
    with Worker() as worker:
        rows = prediction_rows(d, positions, models, worker)
    execution = execution_windows(rows, start, end, stake)
    eras = []
    for p in positions:
        rules = {
            k: v
            for k, v in context(p).get("rules", {}).items()
            if k != "takeProfitMultiple"
        }
        signature = dict(stake_wei=p["spend_wei"], rules=rules, build=p.get("build_id"))
        if not eras or eras[-1]["signature"] != signature:
            eras.append(dict(signature=signature, ids=[], from_ms=entry(p)))
        eras[-1]["ids"].append(p["id"])
    for i, era in enumerate(eras):
        hi = eras[i + 1]["from_ms"] if i + 1 < len(eras) else end
        era_rows = [r for r in rows if r["id"] in era["ids"]]
        execution[f"era_{i + 1}"] = execution_windows(
            era_rows, era["from_ms"], hi, stake
        )["current"]
        execution[f"era_{i + 1}"]["signature"] = era["signature"]
    independent = {r["token"]: r["result"] for r in rows}
    replay_models = {
        **models,
        "tokens": {
            token: {
                **z,
                "results": {
                    **z["results"],
                    "adaptive": independent.get(token, z["results"]["adaptive"]),
                },
            }
            for token, z in models["tokens"].items()
        },
    }
    from .policies import policies

    base = replace(
        policies(raw["state"]["config"]["values"])[0],
        min_creator_tax_bps=50,
        min_exemptions=3,
    )
    inputs = model_account_inputs(raw, d, replay_models, start)
    saved_replay = replay_model_account(models, base, "adaptive", inputs, start, end)
    saved_baseline = comparison["policies"][base.name]
    reproduces_saved = all(
        saved_replay[k] == saved_baseline[k]
        for k in ("cash", "decisions", "actions", "unresolved")
    )
    account_run = replay_model_account(
        replay_models, base, "adaptive", inputs, start, end
    )
    account = account_windows(positions, account_run, start, end, stake)
    calibration = causal_inputs(raw, positions, models, audit, end)
    sources = read_json(root / "source-verification.json")
    source_matches = bool(sources) and all(
        s["match"] and s["live_sha256"] == digest(BOT / s["file"]) for s in sources
    )
    accounting = {r["id"]: r for r in benchmark["accounting"]}
    fills = {r["id"]: r["fill_decision"] for r in rows}
    actual_marks = {r["id"]: r for r in audit["execution"]["rows"]}
    successful = [
        p
        for p in positions
        if p.get("closed") and p.get("exit_reason") not in NON_TRADE
    ]
    matched_reasons = sum(
        fills.get(p["id"], {}).get("status") == "decision"
        and fills[p["id"]].get("reason") == p["exit_reason"]
        for p in successful
    )
    timing_errors = [
        abs(fills[p["id"]]["decisionAt"] - actual_marks[p["id"]]["decision_at"])
        for p in successful
        if fills.get(p["id"], {}).get("status") == "decision"
        and p["id"] in actual_marks
    ]
    coverage = benchmark["coverage"]
    evidence = dict(
        input_hashes_valid=True,
        account_engine_reproduces_saved_run=reproduces_saved,
        receipt_accounting_complete=all(
            accounting.get(p["id"], {}).get("complete", False) for p in positions
        ),
        arithmetic_exact=coverage["checked_transactions"] > 0
        and coverage["exact_matches"] == coverage["checked_transactions"],
        historical_source_matches=source_matches
        and models["model_code_sha256"]["worker.ts"]
        == digest(BOT / "research/core/worker.ts"),
        calibration_is_causal=calibration["passed"],
        wallet_residual_wei=(audit.get("wallet_reconciliation") or {}).get("gap_wei"),
        actual_failures=sum(r["actual_failed"] for r in rows),
        failures_matched=sum(
            r["actual_failed"] and r["simulated_failure"] for r in rows
        ),
        exit_reason_agreement=matched_reasons / len(successful) if successful else None,
        exit_reason_matches=matched_reasons,
        exit_reason_expected=len(successful),
        exit_time_error_ms=describe(timing_errors),
        exit_time_expected=len(successful),
    )
    result = dict(
        schema=1,
        standard=limits["version"],
        limits=limits,
        limits_sha256=digest(LIMITS),
        evaluation=str(root),
        captured_at=end,
        start=start,
        reserved_from=end - 6 * HOUR,
        evidence_label="previously inspected retrospective data; limits introduced after this capture",
        reference_stake_wei=str(stake),
        source_hashes=hashes,
        dataset_sha256=manifest["dataset_sha256"],
        prediction_input_code=models["model_code_sha256"],
        runtime_hashes={
            str(path.relative_to(BOT)): digest(path)
            for path in [
                BOT / "research/core/fidelity.py",
                BOT / "research/core/evaluation.py",
                BOT / "research/core/account.py",
                BOT / "research/core/execution.py",
                BOT / "research/core/worker.ts",
                BOT / "src/strategy/counterfactual.ts",
                BOT / "src/strategy/exit-evaluation.ts",
                BOT / "research/core/policies.py",
                BOT / "research/core/features.py",
                BOT / "research/core/data.py",
                *[BOT / s["file"] for s in sources],
            ]
        },
        current_worker_sha256=digest(BOT / "research/core/worker.ts"),
        evidence=evidence,
        calibration=calibration,
        execution=execution,
        account=account,
        independent_account=account_run,
        predictions=rows,
        verdict=grade(execution, account, evidence, limits),
        limitations=[
            "Independent intent replay conditions on recorded entry intent, target and send clock, not actual fills or actual P&L.",
            "No failure outcome or current-trade gas is copied from actual cash into the independent predictions.",
            "The account benchmark replaces all recorded-attempt outcomes with independent execution predictions, including failed buys.",
            "Cumulative drawdown is closed-cash drawdown, not intratrade mark-to-market drawdown. Epoch resets never erase cash.",
            "Block timestamps do not reconstruct feed arrival or transaction inclusion within a second.",
            "Unknown pool and different-size execution remain unavailable. Historical external order quantities are held fixed.",
            "These engineering tolerances were not fitted to make this capture pass. New observations are required for prospective validation.",
        ],
    )
    out.mkdir(parents=True)
    write_artifact(out / "fidelity.json", result)
    render(out, result)
    write_json(
        root / "fidelity-current.json",
        dict(
            artifact=str(out / "fidelity.json"),
            sha256=digest(out / "fidelity.json"),
            report=str(out / "report.md"),
        ),
    )
    return result


def render(out, result):
    def eth(v):
        return f"{int(v) / 1e18:+.6f}"

    def stats(v):
        return (
            " / ".join(
                "unavailable" if v[k] is None else f"{v[k]:.4f}"
                for k in ("mean", "median", "sd")
            )
            + f" / {v['n']}"
        )

    verdict = result["verdict"]
    lines = [
        f"Simulation status: {verdict['status']}.",
        "",
        f"Capture: {iso(result['captured_at'])}. Actual comparison starts {iso(result['start'])}.",
        "The simulator must reproduce actual earnings and losses before its strategy results can be trusted. No live changes were made.",
        "",
        "```text",
        "Frozen evidence -> receipt and arithmetic proof",
        "                -> independent replay of actual trade intent",
        "                -> full-account replay versus actual account",
        "                -> fidelity checks -> candidate research -> new-data validation",
        "```",
        "",
        "**Actual and simulated account cash**",
        "",
        "Profit is cash from winning attempts. Loss is the magnitude of cash lost on losing attempts. Both include modeled or actual costs.",
        "An unresolved execution truncates both account paths at the same time. Incomplete comparisons cannot pass.",
        "",
        "| Period | Account | Attempts closed | Profit ETH | Loss ETH | Net ETH | Closed-cash DD ETH |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for period in ("current", "fit", "reserved6h", "24h"):
        for label in ("actual", "predicted"):
            row = result["account"][period]["cash"][label]
            lines.append(
                f"| {period} | {label} | {row['n']} | {eth(row['profit_wei'])} | {eth(row['loss_wei'])} | {eth(row['net_wei'])} | {eth(row['drawdown_wei'])} |"
            )
    lines += [
        "",
        "**Cash predicted for actual attempts**",
        "",
        "This replay fixes entry intent and predicts execution independently. The account replay above also chooses which opportunities to enter.",
        "",
        "| Period | Actual net ETH | Predicted profit ETH | Predicted loss ETH | Predicted net ETH |",
        "| --- | --- | --- | --- | --- |",
    ]
    for period in ("current", "fit", "reserved6h", "24h"):
        z = result["execution"][period]["cash"]
        p = z["predicted"]
        lines.append(
            f"| {period} | {eth(z['actual']['net_wei'])} | {eth(p['profit_wei'])} | {eth(p['loss_wei'])} | {eth(p['net_wei'])} |"
        )
    lines += [
        "",
        "**Independent execution predictions on actual attempts**",
        "",
        "Errors are percentage points of each attempt's stake. Every statistics cell is mean / median / sample sd / n. Missing predictions are excluded from both paired cash totals, and prevent validation.",
        "",
        "| Period | Known / expected | Signed error pp | Absolute error pp | Correct profit/loss sign |",
        "| --- | --- | --- | --- | --- |",
    ]
    for period in ["current", "fit", "reserved6h", "24h"] + [
        k for k in result["execution"] if k.startswith("era_")
    ]:
        z = result["execution"][period]["paired"]
        lines.append(
            f"| {period} | {z['known']} / {z['expected']} | {stats(z['signed_error_pp'])} | {stats(z['absolute_error_pp'])} | {z['sign_matches']} / {z['known']} |"
        )
    lines += [
        "",
        "**Acceptance checks**",
        "",
        "These are versioned engineering tolerances, not fitted guarantees. A missing value fails its check.",
        "",
        "| Check | Observed | Required | Pass |",
        "| --- | --- | --- | --- |",
    ]
    for c in verdict["checks"]:
        v = c["observed"]
        observed = f"{v:.6f}" if isinstance(v, float) else str(v)
        lines.append(f"| {c['name']} | {observed} | {c['required']} | {c['passed']} |")
    lines += [
        "",
        "**Required time bins**",
        "",
        "Bins end at capture. Earlier eras outside this validation cohort remain unavailable. ETH cash follows exit times; execution-error cohorts follow entry times.",
        "",
        "| From UTC | To UTC | Actual ETH | Simulated ETH | Actual cash: mean / median / sd / n |",
        "| --- | --- | --- | --- | --- |",
    ]
    for prefix, count in (("24h", 8), ("7d", 7)):
        for i in range(1, count + 1):
            z = result["account"][f"{prefix}_{i}"]
            if not z["available"]:
                lines.append(
                    f"| outside era | {iso(z['to_ms'])} | unavailable | unavailable | unavailable |"
                )
            else:
                lines.append(
                    f"| {iso(z['from_ms'])} | {iso(z['to_ms'])} | {eth(z['cash']['actual']['net_wei'])} | {eth(z['cash']['predicted']['net_wei'])} | {stats(z['cash']['actual']['cash_eth'])} |"
                )
    lines += ["", "**Remaining limits**", ""] + [
        f"- {x}" for x in result["limitations"]
    ]
    lines += [
        "",
        "Full predictions, admission differences, per-window diagnostics and input hashes are in [fidelity.json](fidelity.json). Source archives accompany it under `objects/`.",
        "",
    ]
    (out / "report.md").write_text("\n".join(lines))
