"""Frozen indicator experiment. Run from bot with python -m research.core.indicator_study."""

from __future__ import annotations

import argparse
import bisect
import collections
import copy
from dataclasses import asdict, replace
from pathlib import Path

from .account import observations, simulate
from .data import DAY, HOUR, Worker, digest, read_json, write_artifact, write_json
from .evaluation import (
    context,
    current_start,
    entry,
    iso,
    recovery_losses,
    replay_model_account,
    trade_from_model,
)
from .execution import booked, describe, path_request, validate_dataset
from .fidelity import cash_metrics, validation_status
from .guard_visual import build_models, close_cash, difference, flat_boundary, inputs_at
from .indicators import SignalTape, SignalRule, IndicatorGuard, candidates
from .policies import policies

VARIANTS = ("adaptive", "fast_sell", "slow_sell")
PROTOCOL = Path(__file__).parents[1] / "INDICATOR_POLICY_PROTOCOL_20260911.md"


def configured_policy(raw):
    config = raw["state"]["config"]["values"]
    book = raw["state"]["policy"]
    return replace(
        policies(config)[0],
        on=config["venuePauseOn"],
        min_creator_tax_bps=book["minCreatorTaxBps"],
        min_exemptions=book["minExemptionsToEnter"],
    )


def build_sizes(root, previous, tail):
    raw = read_json(root / "snapshot.json.gz")
    policy = configured_policy(raw)
    models = read_json(root / "guard-models.json")
    end = raw["snapshot_at"]
    start = flat_boundary(raw, end - 2 * DAY) - 7 * HOUR
    facts = {f["token"].lower(): f for f in raw["bot_launches"]}
    positions = sorted(
        [p for p in raw["bot_positions"] if p["live"] and context(p).get("rules")],
        key=entry,
    )
    clocks = [entry(p) for p in positions]
    # Reprice every eligible launch at both smaller sizes in each delay scenario.
    # Gas and timing remain the pre-cutoff model assumptions, not realized candidate costs.
    old_d, _ = validate_dataset(previous / "replay")
    tail_d, _ = validate_dataset(tail)
    count = 0
    with Worker() as worker:
        for z in sorted(models["tokens"].values(), key=lambda z: z["entry"]):
            if (
                not start <= z["entry"] < end
                or (z["creator_tax_bps"] or 0) < policy.min_creator_tax_bps
                or (z["exemptions"] or 0) < policy.min_exemptions
            ):
                continue
            token = z["token"]
            d = tail_d if z["entry"] >= tail_d["start"] else old_d
            ctx = context(positions[bisect.bisect_right(clocks, z["entry"]) - 1])
            fake = dict(
                token=token,
                curve=facts[token]["curve"],
                t_decide=z["entry"],
                spend_wei=str(z["size"]),
                take_profit=z["tp"],
                context_json=ctx,
            )
            req, missing = path_request(
                d, fake, int(z["gas_wei"]), lag=z["delay_ms"], poll=50
            )
            sized = {}
            if missing:
                for size in (z["size"] // 4, z["size"] // 2):
                    sized[str(size)] = {v: dict(status=missing) for v in VARIANTS}
            else:
                req.update(
                    buyGasWei=z["buy_gas_wei"],
                    buyAt=z["entry"] + max(0, z["send_delay_ms"]),
                    openedAt=z["entry"] + max(0, z["open_delay_ms"]),
                )
                specs = []
                for size in (z["size"] // 4, z["size"] // 2):
                    specs.extend(
                        [
                            dict(sizeWei=str(size)),
                            dict(sizeWei=str(size), sellDelayMs=600),
                            dict(sizeWei=str(size), sellDelayMs=1200),
                        ]
                    )
                results = worker.call(op="replay_many", request=req, variants=specs)
                z["fixed_net_result"] = worker.call(
                    op="replay_many", request=req, variants=[dict(takeProfit=1.75)]
                )[0]
                for i, size in enumerate((z["size"] // 4, z["size"] // 2)):
                    sized[str(size)] = dict(zip(VARIANTS, results[i * 3 : i * 3 + 3]))
            z["sized_results"] = sized
            if missing:
                z["fixed_net_result"] = dict(status=missing)
            count += 1
            if count % 100 == 0:
                print("repriced smaller stakes", count, flush=True)
    models["indicator_provenance"] = dict(
        base_models_sha256=digest(root / "guard-models.json"),
        tail_dataset_sha256=digest(tail / "dataset.json"),
        old_dataset_sha256=digest(previous / "replay/dataset.json"),
        protocol_sha256=digest(PROTOCOL),
        smaller_stake_launches=count,
    )
    write_artifact(root / "indicator-models.json", models)
    return models


def trades_for(models, variant):
    trades = []
    for z in models["tokens"].values():
        t = trade_from_model(z, variant)
        t["gas_reserve_wei"] = int(z.get("gas_wei") or 0)
        t["variants"] = {}
        for size, results in z.get("sized_results", {}).items():
            small = dict(z, size=int(size), results=results)
            t["variants"][size] = trade_from_model(small, variant)
        trades.append(t)
    return trades


def make_tapes(raw, models, shadow, obs):
    by_obs = {o.token: o for o in obs}
    facts = {f["token"].lower(): f for f in raw["bot_launches"]}
    native = []
    for o in obs:
        value = o.bars.get("1.75", o.bars.get("1.750"))
        if o.market_eligible and isinstance(value, (int, float)):
            native.append(
                dict(
                    token=o.token,
                    launched=o.launched,
                    block=o.block,
                    available=o.scored + 1,
                    value=value,
                )
            )
    closed = {r["id"]: r for r in close_cash(shadow)}
    matched, missing = [], []
    for decision in shadow["decisions"]:
        if decision["reason"] is not None:
            continue
        token = decision["id"]
        r, o = closed.get(token), by_obs.get(token)
        if token in shadow["open_ids"]:
            r = None
        if r is None or o is None:
            missing.append(
                dict(
                    token=token,
                    entry=decision["at"],
                    reason="unclosed" if r is None else "publication_missing",
                )
            )
            continue
        z = models["tokens"][token]
        f = facts[token]
        matched.append(
            dict(
                token=token,
                launched=f["launched_at"] * 1000,
                block=f["block"],
                entry=z["entry"],
                close=r["at"],
                scored=o.scored,
                available=max(r["at"], o.scored) + 1,
                pnl_wei=str(r["pnl"]),
                size=z["size"],
                tp=z["tp"],
                value=r["pnl"] / z["size"],
            )
        )
    fixed_net = []
    shadow_ids = {d["id"] for d in shadow["decisions"] if d["reason"] is None}
    for z in models["tokens"].values():
        result = z.get("fixed_net_result", {})
        if not result:
            continue
        o = by_obs.get(z["token"])
        if o is None or result.get("status") not in (
            "closed",
            "buy_reverted",
            "entry_price_rejected",
        ):
            continue
        # A predicted rejected entry has a known zero return; an unfinished exit does not.
        close = result.get("exitAt", z["entry"])
        fixed_net.append(
            dict(
                token=z["token"],
                launched=o.launched,
                block=o.block,
                available=max(close, o.scored) + 1,
                value=int(result.get("pnlWei", 0)) / z["size"],
            )
        )
    return (
        dict(
            native=SignalTape(native),
            matched=SignalTape(matched),
            fixed_net=SignalTape(fixed_net),
            fixed_matched=SignalTape(
                [x for x in fixed_net if x["token"] in shadow_ids]
            ),
        ),
        missing,
    )


def summarize(run, start, cut, end):
    cash = close_cash(run)
    out = {}
    for name, lo, hi in (
        ("fit", start, cut),
        ("reserved", cut, end),
        ("full", start, end),
    ):
        rows = [r for r in cash if lo <= r["at"] < hi]
        # Recovery cohorts use entry time; they never borrow closes from the next partition.
        episodes = []
        for e in recovery_losses(run, end)["episodes"]:
            if lo <= e["at"] < hi:
                ids = {
                    d["id"]
                    for d in run["decisions"]
                    if d["reason"] is None and e["at"] <= d["at"] < min(e["until"], hi)
                }
                values = [r["pnl"] for r in cash if r["id"] in ids and r["at"] < hi]
                if ids:
                    episodes.append(
                        dict(
                            at=e["at"],
                            n=len(ids),
                            cash_known=len(values),
                            pnl_wei=str(sum(values)),
                            complete=len(values) == len(ids),
                        )
                    )
        losses = [int(e["pnl_wei"]) for e in episodes if int(e["pnl_wei"]) < 0]
        admitted = [
            d for d in run["decisions"] if d["reason"] is None and lo <= d["at"] < hi
        ]
        cash_ids = {r["id"] for r in cash if r["at"] < hi}
        out[name] = dict(
            cash=cash_metrics(rows),
            recovery_episodes=episodes,
            losing_recoveries=len(losses),
            recovery_loss_wei=str(-sum(losses)),
            admitted=len(admitted),
            unclosed_entries=sum(d["id"] not in cash_ids for d in admitted),
            unresolved=[u for u in run["unresolved"] if u["at"] < hi],
            complete=not any(u["at"] < hi for u in run["unresolved"]),
        )
    return out


def qualifies(candidate, baseline):
    c, b = candidate["cash"], baseline["cash"]
    checks = dict(
        complete=candidate["complete"]
        and baseline["complete"]
        and candidate["unclosed_entries"] == baseline["unclosed_entries"] == 0,
        trades=c["n"] > 0,
        net=int(c["net_wei"]) > int(b["net_wei"]),
        drawdown=int(c["drawdown_wei"]) <= int(b["drawdown_wei"]),
        recovery_count=candidate["losing_recoveries"] <= baseline["losing_recoveries"],
        recovery_loss=int(candidate["recovery_loss_wei"])
        <= int(baseline["recovery_loss_wei"]),
    )
    return dict(passed=all(checks.values()), checks=checks)


def starting_funds(run, models):
    """Capital reservation plus separately timed cash costs, with no implicit reset."""
    sizes = {
        d["id"]: d.get("size", models["tokens"][d["id"]]["size"])
        for d in run["decisions"]
        if d["reason"] is None
    }
    events = [
        (d["at"], 1, -sizes[d["id"]]) for d in run["decisions"] if d["reason"] is None
    ]
    events += [
        (r["at"], 0, r["pnl"] + (sizes[r["id"]] if r["kind"] == "close" else 0))
        for r in run["cash"]
    ]
    balance = required = 0
    for _, _, amount in sorted(events):
        balance += amount
        required = max(required, -balance)
    return str(required)


def intent_validation(raw, models, start, end, old_end):
    rows = []
    for p in raw["bot_positions"]:
        if (
            not p["live"]
            or not p.get("closed")
            or not p.get("exit_at")
            or not start <= entry(p) < end
            or p["exit_at"] >= end
        ):
            continue
        z = models["tokens"].get(p["token"].lower())
        result = z["results"]["adaptive"] if z else {}
        known = result.get("status") in (
            "closed",
            "buy_reverted",
            "entry_price_rejected",
        )
        predicted = int(result.get("pnlWei", 0)) if known else None
        actual = booked(p)
        rows.append(
            dict(
                id=p["id"],
                token=p["token"].lower(),
                entry=entry(p),
                close=p["exit_at"],
                actual_wei=str(actual),
                predicted_wei=str(predicted) if known else None,
                error_pp=(
                    100 * (predicted - actual) / int(p["spend_wei"]) if known else None
                ),
                new_since_prior=entry(p) >= old_end,
                status=result.get("status", "missing_model"),
            )
        )
    summaries = {}
    for name, selected in (
        ("all", rows),
        ("new_since_prior", [r for r in rows if r["new_since_prior"]]),
    ):
        paired = [r for r in selected if r["predicted_wei"] is not None]
        summaries[name] = dict(
            n=len(selected),
            paired=len(paired),
            signed_error_pp=describe(r["error_pp"] for r in paired),
            absolute_error_pp=describe(abs(r["error_pp"]) for r in paired),
            actual=cash_metrics(
                [
                    dict(id=r["id"], at=r["close"], pnl=int(r["actual_wei"]))
                    for r in paired
                ]
            ),
            predicted_same_intents=cash_metrics(
                [
                    dict(id=r["id"], at=r["close"], pnl=int(r["predicted_wei"]))
                    for r in paired
                ]
            ),
        )
    return dict(rows=rows, summaries=summaries)


def window_diagnostics(tapes, start, end):
    rule = SignalRule("native20", source="native")
    points = [tapes["native"].estimate(t, rule) for t in range(start, end, 60000)]
    spans = [s["oldest_age_min"] - s["newest_age_min"] for s in points if s["fresh"]]
    changes = []
    previous = {}
    for row in tapes["native"].records:
        at = row["available"]
        if at >= end:
            break
        n = bisect.bisect_right(tapes["native"].times, at)
        selected = sorted(
            tapes["native"].records[:n],
            key=lambda z: (z["block"], z["token"]),
            reverse=True,
        )[:20]
        current = {z["token"]: z["value"] for z in selected}
        if at >= start and len(previous) == len(current) == 20:
            added = sum(v for k, v in current.items() if k not in previous)
            removed = sum(v for k, v in previous.items() if k not in current)
            change = sum(current.values()) - sum(previous.values())
            if change > 1e-12:
                changes.append(
                    dict(at=at, change=change, added_net=added, removed_net=removed)
                )
        previous = current
    matched = [
        r
        for r in tapes["matched"].records
        if start <= r["entry"] < end and r["available"] < end
    ]
    return dict(
        native20_span_minutes=describe(spans),
        rising_updates=len(changes),
        rising_with_nonpositive_new_net=sum(x["added_net"] <= 0 for x in changes),
        changes=changes,
        entry_to_signal_seconds=describe(
            (r["available"] - r["entry"]) / 1000 for r in matched
        ),
        close_to_signal_seconds=describe(
            (r["available"] - r["close"]) / 1000 for r in matched
        ),
    )


def forward_cohorts(tape, models, shadow, start, cut, end, rule=None):
    cash = {r["id"]: r for r in close_cash(shadow)}
    entered = sorted(
        [d for d in shadow["decisions"] if d["reason"] is None], key=lambda d: d["at"]
    )
    times = [d["at"] for d in entered]
    rule = rule or SignalRule("recent_profit", smooth=True, on=0, off=0)
    rows = []
    for at in range(start, end, 15 * 60000):
        hi = cut if at < cut else end
        if at + 15 * 60000 > hi:
            continue
        s = tape.estimate(at, rule)
        j = bisect.bisect_right(times, at)
        for horizon in ("next5", "next15min"):
            ds = (
                entered[j : j + 5]
                if horizon == "next5"
                else [d for d in entered[j:] if d["at"] < at + 15 * 60000]
            )
            valid = (
                bool(ds)
                and (horizon != "next5" or len(ds) == 5)
                and all(
                    d["at"] < hi and d["id"] in cash and cash[d["id"]]["at"] < hi
                    for d in ds
                )
            )
            values = (
                [cash[d["id"]]["pnl"] / models["tokens"][d["id"]]["size"] for d in ds]
                if valid
                else []
            )
            rows.append(
                dict(
                    at=at,
                    partition="fit" if at < cut else "reserved",
                    horizon=horizon,
                    fresh=s["fresh"],
                    signal=s["value"],
                    direction=s["direction"],
                    profitable_signal=bool(s["fresh"] and s["value"] > 0),
                    available=valid,
                    tokens=[d["id"] for d in ds],
                    future_return=describe(values),
                    future_net_wei=(
                        str(sum(cash[d["id"]]["pnl"] for d in ds)) if valid else None
                    ),
                )
            )
    summaries = {}
    for partition in ("fit", "reserved"):
        for horizon in ("next5", "next15min"):
            for label in (
                "positive",
                "nonpositive",
                "unavailable_signal",
                "positive_improving",
                "positive_weakening",
            ):
                selected = [
                    r
                    for r in rows
                    if r["partition"] == partition
                    and r["horizon"] == horizon
                    and r["available"]
                    and (
                        (label == "positive" and r["profitable_signal"])
                        or (
                            label == "nonpositive"
                            and r["fresh"]
                            and not r["profitable_signal"]
                        )
                        or (label == "unavailable_signal" and not r["fresh"])
                        or (
                            label == "positive_improving"
                            and r["profitable_signal"]
                            and r["direction"] >= 0
                        )
                        or (
                            label == "positive_weakening"
                            and r["profitable_signal"]
                            and r["direction"] < 0
                        )
                    )
                ]
                ids = [t for r in selected for t in r["tokens"]]
                summaries[f"{partition}/{horizon}/{label}"] = dict(
                    net_per_cohort_eth=describe(
                        int(r["future_net_wei"]) / 1e18 for r in selected
                    ),
                    mean_return_per_cohort=describe(
                        r["future_return"]["mean"] for r in selected
                    ),
                    positive_cohorts=sum(
                        int(r["future_net_wei"]) > 0 for r in selected
                    ),
                    cohort_n=len(selected),
                    unique_opportunities=len(set(ids)),
                    outcome_memberships=len(ids),
                    repeated_memberships=len(ids) - len(set(ids)),
                )
    return dict(rows=rows, summaries=summaries)


def run(root, previous, out):
    raw = read_json(root / "snapshot.json.gz")
    models = read_json(root / "indicator-models.json")
    end = raw["snapshot_at"]
    start = flat_boundary(raw, end - 2 * DAY)
    cut = end - 6 * HOUR
    if models["extension_provenance"]["new_capture"] != end:
        raise ValueError("models do not match capture")
    if models["indicator_provenance"]["protocol_sha256"] != digest(PROTOCOL):
        raise ValueError("experiment protocol changed after execution model build")
    base = configured_policy(raw)
    facts = {f["token"].lower(): f for f in raw["bot_launches"]}
    obs = [
        replace(
            o,
            market_eligible=(facts.get(o.token, {}).get("creator_tax_bps") or 0)
            >= base.min_creator_tax_bps
            and (facts.get(o.token, {}).get("exemptions") or 0) >= base.min_exemptions,
        )
        for o in observations(
            dict(source=str(root / "snapshot.json.gz"), observations=raw["gate_obs"])
        )
    ]
    inputs = inputs_at(raw, obs, models, start)
    warm = flat_boundary(raw, start - 7 * HOUR)
    continuous = replace(
        base,
        name="continuous",
        market_enabled=False,
        account_pauses_enabled=False,
        touch_enabled=False,
    )
    shadow = replay_model_account(
        models, continuous, "adaptive", inputs_at(raw, obs, models, warm), warm, end
    )
    if shadow["unresolved"]:
        raise ValueError(
            "shadow population stopped on unknown execution: "
            + str(shadow["unresolved"][0])
        )
    tapes, missing = make_tapes(raw, models, shadow, obs)
    definitions = candidates()
    runs, scorecards = {}, {}
    for variant in VARIANTS:
        group = {}
        for p in (base, replace(base, name="stale_hold", stale="hold"), continuous):
            group[p.name] = replay_model_account(models, p, variant, inputs, start, end)
        trades = trades_for(models, variant)
        for rule in definitions:
            guard = IndicatorGuard(
                tapes[rule.source],
                rule,
                base.size_wei,
                halted="venue" in inputs[2].get("halts", []),
            )
            r = simulate(
                obs,
                trades,
                base,
                start,
                end,
                controls=inputs[1],
                initial=inputs[2],
                guard=guard,
            )
            r["indicator_rule"] = asdict(rule)
            r["probe_loss_wei"] = str(guard.probe_loss)
            group[rule.name] = r
        scorecards[variant] = {
            k: summarize(r, start, cut, end) for k, r in group.items()
        }
        runs[variant] = group
        print("account variants complete", variant, flush=True)
    sensitivity = {}
    trades = trades_for(models, "adaptive")
    for original in [r for r in definitions if r.smooth]:
        for label, rule in (
            ("half3", replace(original, half_life=3)),
            ("half12", replace(original, half_life=12)),
            ("late60", replace(original, delay_ms=60000)),
        ):
            guard = IndicatorGuard(
                tapes[rule.source],
                rule,
                base.size_wei,
                halted="venue" in inputs[2].get("halts", []),
            )
            r = simulate(
                obs,
                trades,
                base,
                start,
                end,
                controls=inputs[1],
                initial=inputs[2],
                guard=guard,
            )
            sensitivity[original.name + "/" + label] = summarize(r, start, cut, end)
    # Post-hoc stress after seeing that the capped candidate stopped early.
    # These are separate inception scenarios, not allowable account resets.
    inception = []
    for requested in range(start + 6 * HOUR, end, 6 * HOUR):
        inception_start = flat_boundary(raw, requested)
        ii = inputs_at(raw, obs, models, inception_start)
        reference = replay_model_account(
            models, base, "adaptive", ii, inception_start, end
        )
        row = dict(
            start=inception_start,
            end=end,
            policies={
                base.name: summarize(reference, inception_start, end, end)["full"]
            },
        )
        for rule in [x for x in definitions if x.name in ("staged", "staged_budget")]:
            guard = IndicatorGuard(
                tapes[rule.source],
                rule,
                base.size_wei,
                halted="venue" in ii[2].get("halts", []),
            )
            rr = simulate(
                obs,
                trades,
                base,
                inception_start,
                end,
                controls=ii[1],
                initial=ii[2],
                guard=guard,
            )
            row["policies"][rule.name] = summarize(rr, inception_start, end, end)[
                "full"
            ]
        inception.append(row)
    acceptance = {}
    for name in runs["adaptive"]:
        if name in (base.name, "continuous"):
            continue
        checks = {
            v: {
                w: qualifies(scorecards[v][name][w], scorecards[v][base.name][w])
                for w in ("fit", "reserved", "full")
            }
            for v in VARIANTS
        }
        robustness = {
            label: {
                w: qualifies(
                    sensitivity[name + "/" + label][w],
                    scorecards["adaptive"][base.name][w],
                )
                for w in ("fit", "reserved", "full")
            }
            for label in ("half3", "half12", "late60")
            if name + "/" + label in sensitivity
        }
        acceptance[name] = dict(
            checks=checks,
            sensitivity=robustness,
            passed=all(x["passed"] for v in checks.values() for x in v.values())
            and all(x["passed"] for v in robustness.values() for x in v.values()),
        )
    actual = [
        dict(id=p["id"], at=p["exit_at"], pnl=booked(p))
        for p in raw["bot_positions"]
        if p["live"]
        and (p.get("cohort") or "main") == "main"
        and p.get("closed")
        and p.get("exit_at")
        and p["exit_at"] < end
    ]
    windows = {}
    for prefix, span, count in (("24h", DAY, 8), ("7d", 7 * DAY, 7)):
        for i in range(count):
            lo, hi = (
                end - span + i * span // count,
                end - span + (i + 1) * span // count,
            )
            windows[f"{prefix}_{i+1}"] = dict(
                start=lo,
                end=hi,
                actual=cash_metrics([r for r in actual if lo <= r["at"] < hi]),
                actual_current_era=lo >= current_start(raw),
                scenarios={
                    k: dict(
                        available=lo >= start
                        and not any(u["at"] < hi for u in r["unresolved"]),
                        cash=cash_metrics(
                            [c for c in close_cash(r) if lo <= c["at"] < hi]
                        ),
                    )
                    for k, r in runs["adaptive"].items()
                },
            )
    # A plot highlight is chosen from fit cash only, without consulting reserved cash.
    display = max(
        acceptance,
        key=lambda k: int(scorecards["adaptive"][k]["fit"]["cash"]["net_wei"]),
    )
    result = dict(
        status="diagnostic_only",
        start=start,
        cut=cut,
        end=end,
        era_start=current_start(raw),
        protocol_sha256=digest(PROTOCOL),
        definitions=[asdict(r) for r in definitions],
        source_hashes={
            str(p): digest(p)
            for p in (
                root / "snapshot.json.gz",
                root / "guard-models.json",
                root / "indicator-models.json",
                PROTOCOL,
            )
        },
        inherited_fidelity=validation_status(previous),
        intent_validation=intent_validation(
            raw, models, start, end, models["extension_provenance"]["prior_capture"]
        ),
        window_diagnostics=window_diagnostics(tapes, start, end),
        starting_funds_wei={
            k: starting_funds(v, models) for k, v in runs["adaptive"].items()
        },
        actual=actual,
        actual_cash={
            w: cash_metrics([r for r in actual if lo <= r["at"] < hi])
            for w, lo, hi in (
                ("fit", start, cut),
                ("reserved", cut, end),
                ("full", start, end),
            )
        },
        shadow=dict(
            start=warm,
            complete=shadow["complete"],
            missing_signal_results=missing,
            records=tapes["matched"].records,
            admissions=len([d for d in shadow["decisions"] if d["reason"] is None]),
        ),
        scorecards=scorecards,
        sensitivity=sensitivity,
        inception_stress=inception,
        acceptance=acceptance,
        display_candidate=display,
        runs=runs["adaptive"],
        windows=windows,
        forward=forward_cohorts(tapes["matched"], models, shadow, start, cut, end),
        forward_indicators={
            rule.name: forward_cohorts(
                tapes[rule.source], models, shadow, start, cut, end, rule
            )
            for rule in (
                SignalRule("native20", source="native"),
                SignalRule("matched20"),
                SignalRule("fixed_cost20", source="fixed_net"),
                SignalRule("fixed_shadow20", source="fixed_matched"),
                SignalRule("native_ewma", source="native", smooth=True),
            )
        },
        differences={
            k: difference(r, runs["adaptive"][base.name], start, end)
            for k, r in runs["adaptive"].items()
        },
        attribution_pairs=[
            ("native20_control", "market_plus2"),
            ("native10", "native20_control"),
            ("native40", "native20_control"),
            ("fixed_cost20", "native20_control"),
            ("fixed_shadow20", "fixed_cost20"),
            ("matched20", "fixed_shadow20"),
            ("matched20_zero", "matched20"),
            ("matched_ewma", "matched20"),
            ("recent_profit", "matched_ewma"),
            ("direction_entry", "recent_profit"),
            ("direction_retreat", "direction_entry"),
            ("staged", "recent_profit"),
            ("staged_budget", "staged"),
        ],
        missed_vs_continuous={
            k: difference(runs["adaptive"]["continuous"], r, start, end)
            for k, r in runs["adaptive"].items()
        },
        assumptions=[
            "All compared observations are retrospective, including the reserved six hours.",
            "Signal tape is fixed to central full-stake shadow execution across account delay scenarios.",
            "Native score uses the historical 0.01 ETH observation model; matched score uses independent actual-sized execution.",
            "Shadow population retains entry filters, template cooldown and capacity but removes all account pauses.",
            "Candidate accounts retain manual, touch, drawdown and execution stops; only the market guard changes.",
            "No automatic replenishment of probe allowance; cumulative cash is never reset.",
            "Account exposure cap is not a wallet balance floor; continuous comparison assumes sufficient starting capital.",
            "Unclosed or unknown outcomes are never treated as zero. Drawdown measures closed cash, not intratrade equity.",
        ],
    )
    out.mkdir(parents=True, exist_ok=False)
    write_artifact(out / "comparison.json", result)
    from .indicator_report import render

    render(raw, result, tapes, out)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("models", "sizes", "compare"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument(
        "--previous",
        type=Path,
        default=Path("data/research/20260911-policy-evaluation"),
    )
    parser.add_argument("--tail", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.command == "models":
        build_models(args.root, args.previous, args.tail)
    elif args.command == "sizes":
        build_sizes(args.root, args.previous, args.tail)
    else:
        run(args.root, args.previous, args.out)


if __name__ == "__main__":
    main()
