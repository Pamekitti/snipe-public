"""Current-era policy evidence from a frozen capture. No trading or write RPCs."""

from __future__ import annotations

import argparse
import bisect
import collections
import json
import math
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path

from .data import (
    DAY,
    HOUR,
    Cache,
    Worker,
    digest,
    read_json,
    write_json,
    write_artifact,
)
from .execution import booked, describe
from .account import Observation, metrics, observations, outcome, simulate

BARS = (1.25, 1.36, 1.5, 1.75, 2, 2.5, 3)
NON_TRADE = {"buy-reverted", "buy-never-mined", "recovered-flat"}


def iso(at):
    return datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(timespec="seconds")


def entry(p):
    return p.get("t_decide") or p.get("t_detect") or 0


def context(p):
    value = p.get("context_json")
    return json.loads(value) if isinstance(value, str) and value else value or {}


def current_start(raw):
    """Latest policy seam, confirmed against pinned trade contexts."""
    changes = raw["state"]["truth"].get("filterChanges", [])
    seams = [r["at"] for r in changes if "VENUE_PAUSE_ON" in r.get("change", "")]
    if not seams:
        raise ValueError("no recorded market policy seam")
    return max(seams)


def spans(end, start):
    result = {
        "current": (start, end),
        "fit": (start, max(start, end - 6 * HOUR)),
        "reserved6h": (max(start, end - 6 * HOUR), end),
        "24h": (max(start, end - DAY), end),
        "48h": (max(start, end - 2 * DAY), end),
        "7d": (max(start, end - 7 * DAY), end),
    }
    for count, width, label in [(8, 3 * HOUR, "24h"), (7, DAY, "7d")]:
        for i in range(count):
            lo, hi = end - (count - i) * width, end - (count - i - 1) * width
            result[f"{label}_{i + 1}"] = (max(lo, start), hi)
    return result


def cash_rows(positions):
    return [
        dict(
            at=p["exit_at"],
            id=p["id"],
            pnl=booked(p),
            size=int(p["spend_wei"]),
            is_trade=bool(p.get("buy_ok")) and p.get("exit_reason") not in NON_TRADE,
        )
        for p in positions
        if p.get("closed")
        and p.get("exit_at")
        and (p.get("onchain_pnl_wei") is not None or p.get("pnl_wei") is not None)
    ]


def cash_summary(rows, lo, hi):
    rows = sorted(
        (r for r in rows if lo <= r["at"] < hi), key=lambda r: (r["at"], str(r["id"]))
    )
    values = [r["pnl"] for r in rows]
    return dict(
        **metrics(rows, lo, hi),
        from_ms=lo,
        to_ms=hi,
        available=hi > lo,
        completed_trades=sum(r.get("is_trade", True) for r in rows),
        winners=sum(r["pnl"] > 0 for r in rows),
        profit_eth=sum(v for v in values if v > 0) / 1e18,
        loss_eth=sum(v for v in values if v < 0) / 1e18,
        cash_eth=describe(v / 1e18 for v in values),
    )


def rolling_at(obs, at, window=20, strict=False):
    visible = sorted(
        (o for o in obs if o.scored < at or (not strict and o.scored == at)),
        key=lambda o: (-o.block, o.token),
    )
    return outcome([o for o in visible if o.market_eligible][: window * 2], window)


def movement(before, after):
    a, b = {o.token: v for o, v in before}, {o.token: v for o, v in after}
    added, removed = b.keys() - a.keys(), a.keys() - b.keys()
    shared = a.keys() & b.keys()
    return dict(
        before=sum(a.values()),
        after=sum(b.values()),
        added_profit=sum(max(b[t], 0) for t in added),
        added_losses=sum(min(b[t], 0) for t in added),
        removed_losses=-sum(min(a[t], 0) for t in removed),
        removed_profit=-sum(max(a[t], 0) for t in removed),
        revisions=sum(b[t] - a[t] for t in shared),
        added_tokens=sorted(added),
        removed_tokens=sorted(removed),
    )


def controls_and_initial(raw, start):
    health = sorted(raw["bot_health"], key=lambda h: (h["at"], h["id"]))
    samples = [s for s in raw["bot_guard_samples"] if s["live"] and s["at"] <= start]
    sample = max(samples, key=lambda s: s["at"]) if samples else None
    if not sample or start - sample["at"] > 60_000:
        raise ValueError("no initial guard sample within 60 seconds")
    active = [
        p
        for p in raw["bot_positions"]
        if p["live"]
        and entry(p) < start
        and (not p.get("exit_at") or p["exit_at"] > start)
    ]
    if active:
        raise ValueError("current-era boundary has an open position")
    halts = json.loads(sample["halts"])
    dd = round(sample["drawdown"] * 1e18)
    initial = dict(
        halts=halts,
        realized=-dd,
        peak=0,
        sampled_at=sample["at"],
        daily_lifts=sum(
            h["component"] == "drawdown"
            and h["ok"]
            and start // DAY == h["at"] // DAY
            and h["at"] < start
            for h in health
        ),
        halt_at=max(
            (
                h["at"]
                for h in health
                if h["at"] < start
                and h["component"] == "halt"
                and h["detail"].startswith("[drawdown]")
            ),
            default=start,
        ),
    )
    controls = []
    for h in health:
        if h["component"] == "operator":
            controls.append(
                (
                    h["at"],
                    (
                        "stop"
                        if not h["ok"]
                        else (
                            "resume"
                            if "automatic operation" in h["detail"]
                            else "legacy_start"
                        )
                    ),
                )
            )
        if h["component"] == "halt" and "before this restart" in h["detail"]:
            controls.append((h["at"], "restart"))
        if h["component"] == "halt" and h["detail"].startswith("[manual]"):
            controls.append((h["at"], {"halt": "manual"}))
    return sorted(controls, key=lambda x: x[0]), initial


def execution_timing(root, raw):
    import sqlite3
    from contextlib import closing

    db_path = root / "raw/bot.db"
    first = {}
    with closing(sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        for row in db.execute(
            "SELECT * FROM trade_marks WHERE reason IS NOT NULL ORDER BY at"
        ):
            first.setdefault(row["position_id"], dict(row))
    rows = []
    for p in raw["bot_positions"]:
        mark = first.get(p["id"])
        if not (p["live"] and p.get("exit_at") and mark and p["exit_at"] >= mark["at"]):
            continue
        rows.append(
            dict(
                id=p["id"],
                entry=entry(p),
                exit_at=p["exit_at"],
                reason=mark["reason"],
                decision_at=mark["at"],
                decision_to_close_ms=p["exit_at"] - mark["at"],
                quoted_profit_eth=(int(mark["mark_wei"]) - int(p["spend_wei"])) / 1e18,
                booked_eth=booked(p) / 1e18,
                marked_value_lost_eth=(
                    int(mark["mark_wei"]) - int(p.get("proceeds_wei") or 0)
                )
                / 1e18,
            )
        )
    current = [r for r in rows if r["entry"] >= current_start(raw)]
    return dict(
        rows=rows,
        current_delay_ms=describe(r["decision_to_close_ms"] for r in current),
        current_tp=[r for r in current if r["reason"] == "tp"],
        source_sha256=digest(db_path),
        limitation="Decision to recorded close includes receipt confirmation; it is a conservative execution-delay proxy.",
    )


def audit(root):
    raw = read_json(root / "snapshot.json.gz")
    end, start = raw["snapshot_at"], current_start(raw)
    live = [
        p
        for p in raw["bot_positions"]
        if p["live"] and (p.get("cohort") or "main") == "main"
    ]
    positions = [p for p in live if start <= entry(p) < end]
    obs = observations(
        dict(source=str(root / "snapshot.json.gz"), observations=raw["gate_obs"])
    )
    obs = [o for o in obs if o.scored <= end]
    rows = cash_rows(positions)
    health = sorted(
        (h for h in raw["bot_health"] if start <= h["at"] < end),
        key=lambda h: (h["at"], h["id"]),
    )
    guards = sorted(
        (s for s in raw["bot_guard_samples"] if s["live"] and start <= s["at"] < end),
        key=lambda s: s["at"],
    )
    # A bounded ordered window is equivalent to the production LIMIT query.
    visible, ordered, cursor, checks = [], sorted(obs, key=lambda o: o.scored), 0, []
    for s in guards:
        while cursor < len(ordered) and ordered[cursor].scored <= s["at"]:
            o = ordered[cursor]
            cursor += 1
            if o.market_eligible:
                bisect.insort(visible, (-o.block, o.token, o))
                del visible[80:]
        chosen = outcome([v[2] for v in visible[:40]], 20)
        if s["market"] is not None and chosen:
            predicted = sum(v for _, v in chosen)
            checks.append(
                dict(
                    at=s["at"],
                    recorded=s["market"],
                    reconstructed=predicted,
                    gap=predicted - s["market"],
                    n=len(chosen),
                )
            )
    controls, initial = controls_and_initial(raw, start)
    arms = [h for h in health if h["component"] == "halt" and h["ok"]]
    episodes = []
    previous_arm = start
    for arm in arms:
        at = arm["at"]
        until = next(
            (
                h["at"]
                for h in health
                if h["component"] == "halt" and not h["ok"] and h["at"] > at
            ),
            end,
        )
        clues = [h for h in health if 0 <= at - h["at"] <= 30_001 and h["ok"]]
        kind = (
            "operator_resume"
            if any(h["component"] == "operator" for h in clues)
            else (
                "drawdown_reset"
                if any(h["component"] == "drawdown" for h in clues)
                else (
                    "stale_reopening"
                    if any(
                        h["component"] == "venue" and "no window" in h["detail"]
                        for h in clues
                    )
                    else (
                        "market_recovery"
                        if any(h["component"] == "venue" for h in clues)
                        else (
                            "touch_recovery"
                            if any(h["component"] == "gate" for h in clues)
                            else "other_recovery"
                        )
                    )
                )
            )
        )
        entered = [p for p in positions if at <= entry(p) < until]
        pause_from = min(
            (
                h["at"]
                for h in health
                if h["component"] == "halt"
                and not h["ok"]
                and previous_arm <= h["at"] < at
            ),
            default=start,
        )
        stop = max(
            (
                h["at"]
                for h in health
                if h["component"] == "venue" and not h["ok"] and h["at"] < at
            ),
            default=start,
        )
        episodes.append(
            dict(
                at=at,
                until=until,
                kind=kind,
                position_ids=[p["id"] for p in entered],
                cash=cash_summary(cash_rows(entered), at, end),
                pause_from=pause_from,
                venue_pause_from=stop,
                movement=movement(rolling_at(obs, stop), rolling_at(obs, at)),
                evidence=[
                    dict(component=h["component"], detail=h["detail"])
                    for h in clues
                    if h["component"] != "halt"
                ],
            )
        )
        previous_arm = at
    resets = [h for h in health if h["component"] == "drawdown" and h["ok"]]
    # All current sizes and pinned settings are retained in the era inventory.
    era_groups = collections.defaultdict(list)
    for p in live:
        if not end - 7 * DAY <= entry(p) < end:
            continue
        spec = context(p).get("entryStrategy", {})
        key = json.dumps(
            {
                k: spec.get(k)
                for k in (
                    "tradeSizeEth",
                    "venuePauseWindow",
                    "venuePauseOff",
                    "venuePauseOn",
                    "ddResumeOn",
                    "minExemptionsToEnter",
                )
            },
            sort_keys=True,
        )
        era_groups[key].append(p)
    eras = [
        dict(
            rules=json.loads(k),
            first=min(entry(p) for p in ps),
            last=max(entry(p) for p in ps),
            cash=cash_summary(cash_rows(ps), end - 7 * DAY, end),
        )
        for k, ps in era_groups.items()
    ]
    flat = sorted(
        (
            b
            for b in raw["bot_balance"]
            if b.get("open_n") == 0 and start <= b["at"] <= end
        ),
        key=lambda b: b["at"],
    )
    wallet = None
    if flat:
        first, last = flat[0], flat[-1]
        balance_key = next(
            (k for k in ("wei", "balance_wei", "wallet_wei") if k in first), None
        )
        if balance_key:
            change = int(last[balance_key]) - int(first[balance_key])
            cash = sum(
                r["pnl"] for r in cash_rows(live) if first["at"] < r["at"] <= last["at"]
            )
            wallet = dict(
                from_ms=first["at"],
                to_ms=last["at"],
                change_wei=str(change),
                booked_wei=str(cash),
                gap_wei=str(change - cash),
            )
    report = dict(
        captured_at=end,
        current_start=start,
        snapshot_sha256=digest(root / "snapshot.json.gz"),
        actual={
            name: cash_summary(rows, lo, hi)
            for name, (lo, hi) in spans(end, start).items()
        },
        all_era_actual={
            name: cash_summary(cash_rows(live), lo, hi)
            for name, (lo, hi) in spans(end, end - 7 * DAY).items()
            if name.startswith(("7d", "24h"))
        },
        cash=rows,
        policy_eras=sorted(eras, key=lambda x: x["first"]),
        positions=len(positions),
        receipt_booked=sum(p.get("onchain_pnl_wei") is not None for p in positions),
        failed_attempts=[
            p["id"] for p in positions if p.get("exit_reason") in NON_TRADE
        ],
        sensor_check=dict(
            n=len(checks),
            exact=sum(abs(r["gap"]) < 1e-9 for r in checks),
            gap=describe(r["gap"] for r in checks),
            mismatches=[r for r in checks if abs(r["gap"]) >= 1e-9],
        ),
        episodes=episodes,
        resets=resets,
        controls=controls,
        initial=initial,
        wallet_reconciliation=wallet,
        execution=execution_timing(root, raw),
        evidence_limits=[
            "Stored score timestamps may reflect later backfills; sensor residuals quantify disagreement.",
            "Recorded halt events identify arming; a sensor recovery under another stop is not an entry reopening.",
            "Seven-day actual cash spans older policy eras; current-policy bins exclude those eras.",
        ],
    )
    write_json(root / "audit.json", report)
    return report


def adaptive_at(raw, at, worker):
    # LIMIT applies before JSON parsing, just as RegimeGate.readBars does.
    rows = sorted(
        (
            r
            for r in raw["gate_obs"]
            if r["at"] < at and r.get("error") is None and r.get("bars") is not None
        ),
        key=lambda r: -r["block"],
    )[:20]
    parsed = []
    for r in rows:
        try:
            value = json.loads(r["bars"]) if isinstance(r["bars"], str) else r["bars"]
            parsed.append(
                {
                    k: v
                    for k, v in value.items()
                    if isinstance(v, (int, float))
                    and not isinstance(v, bool)
                    and math.isfinite(v)
                }
            )
        except (ValueError, TypeError, AttributeError):
            continue
    return worker.call(
        op="adaptive", rows=parsed, window=20, bars=list(BARS), fallback=1.75
    )["multiple"]


def build_models(root):
    """Replay every target on the identical entry. Save progress for interrupted runs."""
    from .execution import (
        path_request,
        receipt_gas,
        receipt_accounting,
        validate_dataset,
    )
    import statistics

    d, _ = validate_dataset(root / "replay")
    raw = read_json(root / "snapshot.json.gz")
    start, end = current_start(raw), raw["snapshot_at"]
    live = sorted(
        (
            p
            for p in raw["bot_positions"]
            if p["live"] and (p.get("cohort") or "main") == "main"
        ),
        key=entry,
    )
    known = [
        p for p in live if context(p).get("rules") and context(p).get("entryStrategy")
    ]
    known_times = [entry(p) for p in known]
    costs = []
    timings = {r["id"]: r for r in execution_timing(root, raw)["rows"]}
    latest_spec = context(known[-1])["entryStrategy"]
    execution_keys = (
        "tradeSizeEth",
        "maxHoldMs",
        "hardStopMultiple",
        "deadCoinAfterMs",
        "deadCoinBelowMult",
        "maxEntryPriceMultiple",
    )
    signature = lambda p: tuple(
        context(p).get("entryStrategy", {}).get(k) for k in execution_keys
    )
    current_signature = tuple(latest_spec.get(k) for k in execution_keys)
    boundary = len(known) - 1
    while boundary > 0 and signature(known[boundary - 1]) == current_signature:
        boundary -= 1
    cost_start = entry(known[boundary])
    receipt_cache = Cache(root.parent / "cache.sqlite", fetch=False)
    for p in live:
        if not (
            p.get("buy_ok")
            and p.get("closed")
            and p.get("exit_at")
            and cost_start <= entry(p)
            and p["exit_at"] < end - 6 * HOUR
            and signature(p) == current_signature
        ):
            continue
        if p.get("onchain_pnl_wei") is None:
            continue
        gas = int(p.get("proceeds_wei") or 0) - int(p["spend_wei"]) - booked(p)
        receipt = d["receipts"].get(p.get("buy_hash"))
        if receipt is None and p.get("buy_hash"):
            receipt = receipt_cache.get("eth_getTransactionReceipt", [p["buy_hash"]])
        buy_gas = receipt_gas(receipt)
        if gas >= 0 and buy_gas > 0:
            costs.append((p["exit_at"], gas, buy_gas))
    receipt_cache.close()
    dataset_hash = digest(root / "replay/dataset.json")
    model_code = {
        name: digest(Path(__file__).parent / name)
        for name in ("evaluation.py", "worker.ts", "execution.py")
    }
    cached = read_json(root / "models.json") if (root / "models.json").exists() else {}
    if cached and cached["dataset_sha256"] != digest(root / "replay/dataset.json"):
        raise ValueError("model checkpoint belongs to another dataset")
    if cached and cached.get("model_code_sha256") != model_code:
        raise ValueError("model checkpoint belongs to another implementation")
    models = cached.get("tokens", {})
    current_positions = [p for p in live if start <= entry(p) < end]
    actual_by_token = {p["token"].lower(): p for p in current_positions}
    calibration, selector = [], []
    with Worker() as worker:
        topics = worker.call(op="metadata")["topics"]
        receipts = [
            receipt_accounting(p, d["receipts"], d["ancillary"], topics=topics)
            for p in current_positions
        ]
        write_json(
            root / "receipt-check.json",
            dict(
                n=len(receipts),
                independent_matches=sum(r["complete"] for r in receipts),
                receipts=len(d["receipts"]),
                missing_receipts=sum(v is None for v in d["receipts"].values()),
                rows=receipts,
            ),
        )
        for i, f in enumerate(sorted(d["launches"], key=lambda f: f["block"])):
            token = f["token"].lower()
            actual_position = actual_by_token.get(token)
            at = (
                entry(actual_position)
                if actual_position
                else max(f.get("detected_at") or 0, f["launched_at"] * 1000 + 2000)
            )
            if not (f.get("passed") and start <= at < end):
                continue
            if token in models:
                continue
            j = bisect.bisect_right(known_times, at) - 1
            ctx = context(known[j]) if j >= 0 else {}
            if actual_position:
                ctx = context(actual_position)
            spec = ctx.get("entryStrategy", {})
            size = round(spec.get("tradeSizeEth", 0) * 1e18)
            tp = (
                actual_position["take_profit"]
                if actual_position and actual_position.get("take_profit")
                else adaptive_at(raw, at, worker)
            )
            delayed_tp = adaptive_at(raw, at - 30_000, worker)
            prior = [(gas, buy) for close, gas, buy in costs if close < at]
            gas = int(statistics.median(g for g, _ in prior)) if prior else None
            buy_gas = int(statistics.median(b for _, b in prior)) if prior else None
            delays = [
                t["decision_to_close_ms"]
                for t in timings.values()
                if cost_start <= t["entry"] and t["exit_at"] < min(at, end - 6 * HOUR)
            ]
            lag = math.ceil(statistics.median(delays) / 50) * 50 if delays else 600
            prior_opens = [
                p
                for p in known
                if cost_start <= entry(p) < min(at, end - 6 * HOUR)
                and p.get("t_sent")
                and p["t_sent"] >= entry(p)
            ]
            send_delay = (
                actual_position["t_sent"] - at
                if actual_position and actual_position.get("t_sent")
                else (
                    round(
                        statistics.median(p["t_sent"] - entry(p) for p in prior_opens)
                    )
                    if prior_opens
                    else None
                )
            )
            open_delay = (
                context(actual_position).get("at", at) - at
                if actual_position
                else (
                    round(
                        statistics.median(
                            context(p).get("at", entry(p)) - entry(p)
                            for p in prior_opens
                        )
                    )
                    if prior_opens
                    else None
                )
            )
            fake = dict(
                token=token,
                curve=f["curve"],
                t_decide=at,
                t_detect=at,
                spend_wei=str(size),
                take_profit=tp,
                context_json=ctx,
            )
            req, missing = path_request(d, fake, gas or 0, lag=lag, poll=50)
            if gas is None:
                missing = "no_prior_current_era_costs"
            if send_delay is None or open_delay is None:
                missing = "no_prior_entry_timing"
            labels = (
                ["adaptive"]
                + [f"tp_{b:.2f}" for b in BARS]
                + ["slow_sell", "cached30", "probe_quarter", "probe_half", "fast_sell"]
            )
            variants = (
                [{}]
                + [dict(takeProfit=b) for b in BARS]
                + [
                    dict(sellDelayMs=1200),
                    dict(takeProfit=delayed_tp),
                    dict(sizeWei=str(size // 4)),
                    dict(sizeWei=str(size // 2)),
                    dict(sellDelayMs=600),
                ]
            )
            if missing:
                results = [{"status": missing} for _ in labels]
            else:
                req["buyGasWei"] = str(buy_gas)
                req["buyAt"] = at + max(0, send_delay)
                req["openedAt"] = at + max(0, open_delay)
                results = worker.call(op="replay_many", request=req, variants=variants)
            if actual_position and actual_position.get("exit_reason") in {
                "buy-reverted",
                "buy-never-mined",
            }:
                results = [
                    (
                        dict(status="recorded_failed_buy_size_counterfactual")
                        if label.startswith("probe_")
                        else dict(
                            status="buy_reverted",
                            pnlWei=str(booked(actual_position)),
                            exitAt=actual_position["exit_at"],
                            reason=actual_position["exit_reason"],
                        )
                    )
                    for label in labels
                ]
            models[token] = dict(
                token=token,
                entry=at,
                size=size,
                tp=tp,
                delayed_tp=delayed_tp,
                creator_tax_bps=f.get("creator_tax_bps"),
                exemptions=f.get("exemptions"),
                template=f'{f.get("creator_tax_bps")}:{f.get("dev_buy_wei")}:{f.get("exemptions")}',
                recorded_reject=f.get("entry_reject"),
                entry_time_source=(
                    "recorded" if actual_position else "assumed_launch_clock"
                ),
                gas_wei=str(gas) if gas is not None else None,
                buy_gas_wei=str(buy_gas) if buy_gas is not None else None,
                gas_n=len(prior),
                delay_ms=lag,
                send_delay_ms=send_delay,
                open_delay_ms=open_delay,
                delay_calibration=describe(delays),
                results=dict(zip(labels, results)),
            )
            if i % 100 == 0:
                write_json(
                    root / "models.json",
                    dict(
                        dataset_sha256=dataset_hash,
                        model_code_sha256=model_code,
                        tokens=models,
                    ),
                )
                print("modeled", len(models), "of", len(d["launches"]), flush=True)
        for p in current_positions:
            actual_tp = p.get("take_profit")
            if not actual_tp:
                continue
            predicted = adaptive_at(raw, entry(p), worker)
            delayed = adaptive_at(raw, entry(p) - 30_000, worker)
            selector.append(
                dict(
                    id=p["id"],
                    actual=actual_tp,
                    predicted=predicted,
                    delayed=delayed,
                    matches=actual_tp == predicted,
                    at=entry(p),
                )
            )
            if not (p.get("buy_ok") and p.get("onchain_pnl_wei") is not None):
                continue
            gas = int(p.get("proceeds_wei") or 0) - int(p["spend_wei"]) - booked(p)
            prior_delays = [
                t["decision_to_close_ms"]
                for t in timings.values()
                if cost_start <= t["entry"]
                and t["exit_at"] < min(entry(p), end - 6 * HOUR)
            ]
            lag = (
                math.ceil(statistics.median(prior_delays) / 50) * 50
                if prior_delays
                else 600
            )
            req, missing = path_request(d, p, gas, lag=lag, poll=50)
            if req:
                req["buyAt"] = max(entry(p), p.get("t_sent") or entry(p))
                req["openedAt"] = context(p).get("at", entry(p))
            result = {"status": missing} if missing else worker.call(**req)
            value = (
                int(result["pnlWei"])
                if result.get("status") in ("closed", "buy_reverted")
                else None
            )
            calibration.append(
                dict(
                    id=p["id"],
                    at=entry(p),
                    exit_at=p["exit_at"],
                    actual_wei=str(booked(p)),
                    modeled_wei=str(value) if value is not None else None,
                    status=result["status"],
                    gap_pp=(
                        100 * (value - booked(p)) / int(p["spend_wei"])
                        if value is not None
                        else None
                    ),
                )
            )
    result = dict(
        dataset_sha256=dataset_hash,
        model_code_sha256=model_code,
        tokens=models,
        calibration=calibration,
        selector=selector,
        gas_calibration_n=len(costs),
        cost_era_start=cost_start,
    )
    write_json(root / "models.json", result)
    write_artifact(
        root / "model-provenance.json",
        dict(
            dataset_sha256=dataset_hash,
            models_sha256=digest(root / "models.json"),
            model_code_sha256=model_code,
        ),
    )
    write_json(
        root / "selector-check.json",
        dict(
            n=len(selector),
            latest_matches=sum(r["matches"] for r in selector),
            either_matches=sum(
                r["actual"] in (r["predicted"], r["delayed"]) for r in selector
            ),
            rows=selector,
        ),
    )
    return dict(
        tokens=len(models), calibration=len(calibration), selector=len(selector)
    )


def trade_from_model(z, variant="adaptive"):
    r = z["results"][variant]
    return dict(
        id=z["token"],
        token=z["token"],
        entry=z["entry"],
        size=z["size"],
        exit=r.get("exitAt", z["entry"] + 180000),
        pnl=int(r.get("pnlWei", 0)),
        tp=(
            float(variant[3:])
            if variant.startswith("tp_")
            else z["delayed_tp"] if variant == "cached30" else z["tp"]
        ),
        template=z["template"],
        creator_tax_bps=z["creator_tax_bps"],
        exemptions=z["exemptions"],
        is_trade=r["status"] != "buy_reverted",
        entry_rejected=r["status"] == "entry_price_rejected",
        costs=(
            [dict(at=z["entry"], wei=z["buy_gas_wei"])]
            if r["status"] == "closed" and z.get("buy_gas_wei")
            else []
        ),
        unsupported=(
            None
            if r["status"] in ("closed", "buy_reverted", "entry_price_rejected")
            else r["status"]
        ),
    )


def recovery_losses(run, end):
    # Disjoint admission episodes: repeated resumes cannot count the same cash twice.
    events = sorted(
        (
            a
            for a in run["actions"]
            if a["action"]
            in (
                "venue_resume",
                "dd_resume",
                "venue_stop",
                "dd_stop",
                "probation_stop",
                "operator_stop",
            )
        ),
        key=lambda a: a["at"],
    )
    cash = collections.defaultdict(int)
    for r in run["cash"]:
        cash[r["id"]] += r["pnl"]
    episodes = []
    for i, a in enumerate(events):
        if a["action"] not in ("venue_resume", "dd_resume"):
            continue
        until = events[i + 1]["at"] if i + 1 < len(events) else end
        ids = {
            r["id"]
            for r in run["decisions"]
            if r["reason"] is None and a["at"] <= r["at"] < until
        }
        if ids:
            values = [cash[t] for t in ids if t in cash]
            episodes.append(
                dict(
                    at=a["at"],
                    until=until,
                    n=len(ids),
                    cash_known=len(values),
                    pnl_wei=str(sum(values)),
                )
            )
    losses = [int(e["pnl_wei"]) for e in episodes if int(e["pnl_wei"]) < 0]
    return dict(
        episodes=episodes,
        losing_n=len(losses),
        loss_eth=-sum(losses) / 1e18,
        returns_eth=describe(int(e["pnl_wei"]) / 1e18 for e in episodes),
    )


def cash_difference(run, reference):
    known_until = min(
        (r["at"] for path in (run, reference) for r in path.get("unresolved", [])),
        default=None,
    )

    def by_id(r):
        result = collections.defaultdict(int)
        for row in r["cash"]:
            if known_until is None or row["at"] < known_until:
                result[row["id"]] += row["pnl"]
        return result

    a, b = by_id(run), by_id(reference)
    added, removed = a.keys() - b.keys(), b.keys() - a.keys()
    shared = a.keys() & b.keys()
    return dict(
        known_until_ms=known_until,
        comparison_complete=run.get("complete", True)
        and reference.get("complete", True),
        added_n=len(added),
        removed_n=len(removed),
        extra_profit_eth=sum(max(a[t], 0) for t in added) / 1e18,
        extra_loss_eth=sum(min(a[t], 0) for t in added) / 1e18,
        profit_missed_eth=sum(max(b[t], 0) for t in removed) / 1e18,
        losses_avoided_eth=-sum(min(b[t], 0) for t in removed) / 1e18,
        changed_shared_cash_eth=sum(a[t] - b[t] for t in shared) / 1e18,
        net_change_eth=(sum(a.values()) - sum(b.values())) / 1e18,
    )


def run_windows(run, start, end):
    known_until = min((r["at"] for r in run["unresolved"]), default=end)
    result = {}
    for name, (lo, hi) in spans(end, start).items():
        cell = cash_summary(run["cash"], lo, min(hi, known_until))
        cell.update(
            requested_to_ms=hi,
            known_until_ms=known_until,
            complete=hi <= known_until and hi > lo,
        )
        if lo >= known_until or hi <= lo:
            cell.update(
                available=False,
                pnl_wei=None,
                pnl_eth=None,
                dd_eth=None,
                profit_eth=None,
                loss_eth=None,
            )
        result[name] = cell
    return result


def qualifies(candidate, baseline):
    if not candidate["complete"] or not baseline["complete"]:
        return False
    for name in ("current", "fit", "reserved6h"):
        a, b = candidate["windows"][name], baseline["windows"][name]
        profit_fails = (
            a["pnl_eth"] < b["pnl_eth"]
            if name == "reserved6h"
            else a["pnl_eth"] <= b["pnl_eth"]
        )
        if profit_fails or a["dd_eth"] > b["dd_eth"]:
            return False
    return (
        candidate["recovery"]["losing_n"] <= baseline["recovery"]["losing_n"]
        and candidate["recovery"]["loss_eth"] <= baseline["recovery"]["loss_eth"]
    )


def paired_diagnostics(models, raw, audit_data):
    start, end = current_start(raw), raw["snapshot_at"]
    zs = list(models["tokens"].values())
    facts = {f["token"].lower(): f for f in raw["bot_launches"]}
    previous_losses = collections.defaultdict(list)
    for p in raw["bot_positions"]:
        if (
            p["live"]
            and p.get("buy_ok")
            and p.get("exit_reason") not in NON_TRADE
            and p.get("exit_at")
            and booked(p) < 0
            and (p.get("cohort") or "main") == "main"
        ):
            f = facts.get(p["token"].lower(), {})
            key = f'{f.get("creator_tax_bps")}:{f.get("dev_buy_wei")}:{f.get("exemptions")}'
            previous_losses[key].append(p["exit_at"])

    def recent_loss(z):
        return any(
            z["entry"] - HOUR < at < z["entry"] for at in previous_losses[z["template"]]
        )

    def summary(group, variant="adaptive"):
        known = [trade_from_model(z, variant) for z in group]
        rows = [
            dict(
                at=t["exit"],
                id=t["id"],
                pnl=t["pnl"],
                size=t["size"],
                is_trade=t["is_trade"],
            )
            for t in known
            if t and not t.get("unsupported") and not t.get("entry_rejected")
        ]
        return dict(
            expected=len(group),
            known=len(rows),
            entry_price_rejected=sum(t.get("entry_rejected", False) for t in known),
            unavailable=sum(bool(t and t.get("unsupported")) for t in known),
            windows={
                name: cash_summary(rows, lo, hi)
                for name, (lo, hi) in spans(end, start).items()
            },
        )

    floors = lambda z: (z["creator_tax_bps"] or 0) >= 50 and (z["exemptions"] or 0) >= 3
    filters = {}
    for name, other, accept in [
        (
            "tax_floor",
            lambda z: (z["exemptions"] or 0) >= 3 and not recent_loss(z),
            lambda z: (z["creator_tax_bps"] or 0) >= 50,
        ),
        (
            "exempt_floor",
            lambda z: (z["creator_tax_bps"] or 0) >= 50 and not recent_loss(z),
            lambda z: (z["exemptions"] or 0) >= 3,
        ),
        ("template_loss", floors, lambda z: not recent_loss(z)),
    ]:
        group = [z for z in zs if other(z)]
        filters[name] = dict(
            admitted=summary([z for z in group if accept(z)]),
            rejected=summary([z for z in group if not accept(z)]),
        )
    # Use one shared complete set for all fixed-target contrasts.
    eligible = [z for z in zs if floors(z)]
    variants = ["adaptive"] + [f"tp_{b:.2f}" for b in BARS]
    paired = [
        z
        for z in eligible
        if all(
            z["results"][v]["status"] in ("closed", "buy_reverted") for v in variants
        )
    ]
    exits = {v: summary(paired, v) for v in variants}
    deltas = {}
    for v in variants[1:]:
        values = []
        for z in paired:
            a, b = z["results"][v], z["results"]["adaptive"]
            values.append(
                dict(
                    at=z["entry"],
                    id=z["token"],
                    pnl=int(a["pnlWei"]) - int(b["pnlWei"]),
                    size=z["size"],
                )
            )
        deltas[v] = {
            name: cash_summary(values, lo, hi)
            for name, (lo, hi) in spans(end, start).items()
        }
    skipped = []
    for e in audit_data["episodes"]:
        group = [
            z
            for z in eligible
            if e["pause_from"] <= z["entry"] < e["at"]
            and (z.get("recorded_reject") or "").startswith("halted:")
        ]
        skipped.append(
            dict(
                at=e["at"],
                pause_from=e["pause_from"],
                kind=e["kind"],
                opportunities=summary(group),
            )
        )
    vanish = []
    for z in eligible:
        r = z["results"]["adaptive"]
        if r["status"] != "closed" or not r.get("trace"):
            continue
        decision = r["trace"][0]
        if decision["reason"] != "tp":
            continue
        mark = int(decision["mark"])
        proceeds = int(r["proceedsWei"])
        vanish.append(
            dict(
                token=z["token"],
                entry=z["entry"],
                decision_at=decision["at"],
                exit_at=r["exitAt"],
                marked_profit_eth=(mark - z["size"]) / 1e18,
                pnl_eth=int(r["pnlWei"]) / 1e18,
                value_lost_eth=(mark - proceeds) / 1e18,
            )
        )
    return dict(
        filters=filters,
        exits=exits,
        exit_deltas=deltas,
        exit_expected=len(eligible),
        exit_paired=len(paired),
        skipped_before_recovery=skipped,
        tp_execution=vanish,
        limits=[
            "Opportunity sums have no capital or guard constraint and are not account cash.",
            "Template grouping uses losses actually recorded before entry; account runs recompute candidate template feedback.",
            "All exit contrasts use the same complete opportunity set; excluded outcomes remain unavailable.",
        ],
    )


def model_account_inputs(raw, d, models, start):
    from .features import Features, activity

    obs = observations(d)
    controls, initial = controls_and_initial(raw, start)
    feature_tape = Features(raw, obs, activity(d))
    model_features = {
        z["token"]: feature_tape.at(z["entry"]) for z in models["tokens"].values()
    }
    facts = {f["token"].lower(): f for f in raw["bot_launches"]}
    # Preserve the template losses already known at the boundary.
    initial["template_loss"] = {}
    for p in raw["bot_positions"]:
        if (
            p["live"]
            and p.get("exit_at")
            and start - HOUR <= p["exit_at"] < start
            and booked(p) < 0
            and p.get("buy_ok")
            and p.get("exit_reason") not in NON_TRADE
        ):
            f = facts.get(p["token"].lower(), {})
            key = f'{f.get("creator_tax_bps")}:{f.get("dev_buy_wei")}:{f.get("exemptions")}'
            initial["template_loss"][key] = max(
                initial["template_loss"].get(key, 0), p["exit_at"]
            )
    return obs, controls, initial, facts, model_features, feature_tape


def replay_model_account(models, p, variant, inputs, start, end):
    obs, controls, initial, facts, model_features, _ = inputs
    policy_obs = [
        replace(
            o,
            market_eligible=(facts.get(o.token, {}).get("creator_tax_bps") or 0)
            >= p.min_creator_tax_bps
            and (facts.get(o.token, {}).get("exemptions") or 0) >= p.min_exemptions,
        )
        for o in obs
    ]
    trades = []
    for z in models["tokens"].values():
        t = trade_from_model(z, variant)
        if t is None:
            continue
        t["variants"] = {}
        for label, size in [
            ("probe_quarter", z["size"] // 4),
            ("probe_half", z["size"] // 2),
        ]:
            v = trade_from_model(z, label)
            if v is not None:
                t["variants"][str(size)] = {**v, "size": size}
        trades.append(t)
    run = simulate(
        policy_obs,
        trades,
        p,
        start,
        end,
        features=model_features,
        controls=controls,
        initial=initial,
    )
    run["windows"] = run_windows(run, start, end)
    run["recovery"] = recovery_losses(run, end)
    run["policy"] = asdict(p)
    run["variant"] = variant
    run["coverage"] = dict(
        total=len(trades),
        unavailable=sum(bool(t.get("unsupported")) for t in trades),
    )
    return run


def compare_models(root):
    from .policies import policies
    from .account import open_costs

    raw = read_json(root / "snapshot.json.gz")
    audit_data = read_json(root / "audit.json")
    d = read_json(root / "replay/dataset.json")
    models = read_json(root / "models.json")
    start, end = current_start(raw), raw["snapshot_at"]
    obs = observations(d)
    all_policies = policies(raw["state"]["config"]["values"])
    baseline = replace(all_policies[0], min_creator_tax_bps=50, min_exemptions=3)
    names = {
        "market_plus2",
        "market_plus1",
        "stale_hold",
        "recovery_direction",
        "recovery_breadth",
        "quarter_probe",
        "buyers_per_coin",
    }
    ps = [
        replace(p, min_creator_tax_bps=50, min_exemptions=3)
        for p in all_policies
        if p.name in names
    ]
    ps += [
        replace(baseline, name="remove_tax_floor", min_creator_tax_bps=0),
        replace(baseline, name="remove_exempt_floor", min_exemptions=1),
        replace(baseline, name="remove_template_loss", template_loss_ms=0),
    ]
    variants = [(p, "adaptive") for p in ps]
    variants += [(replace(baseline, name=f"tp_{b:.2f}"), f"tp_{b:.2f}") for b in BARS]
    variants += [
        (replace(baseline, name="slow_sell"), "slow_sell"),
        (replace(baseline, name="fast_sell"), "fast_sell"),
        (replace(baseline, name="cached30"), "cached30"),
    ]
    inputs = model_account_inputs(raw, d, models, start)
    obs, controls, initial, facts, model_features, feature_tape = inputs
    output = {}
    for p, variant in variants:
        run = replay_model_account(models, p, variant, inputs, start, end)
        output[p.name] = run
        print(
            "compared",
            p.name,
            "complete",
            run["complete"],
            "known closes",
            len(run["cash"]),
            flush=True,
        )
    reference = output["market_plus2"]
    for name, run in output.items():
        run["difference"] = cash_difference(run, reference)
        run["qualifies"] = name != "market_plus2" and qualifies(run, reference)
    # Fixed actual fills show permission differences only; newly admitted fills remain unknown.
    recorded = []
    for p in raw["bot_positions"]:
        if not (
            p["live"]
            and (p.get("cohort") or "main") == "main"
            and start <= entry(p) < end
            and p.get("exit_at")
        ):
            continue
        f = facts.get(p["token"].lower(), {})
        recorded.append(
            dict(
                id=p["id"],
                token=p["token"].lower(),
                entry=entry(p),
                exit=p["exit_at"],
                pnl=booked(p),
                size=int(p["spend_wei"]),
                tp=p.get("take_profit") or 1.75,
                template=f'{f.get("creator_tax_bps")}:{f.get("dev_buy_wei")}:{f.get("exemptions")}',
                creator_tax_bps=f.get("creator_tax_bps"),
                exemptions=f.get("exemptions"),
                costs=open_costs(d, p),
                is_trade=bool(p.get("buy_ok"))
                and p.get("exit_reason") not in NON_TRADE,
            )
        )
    conditional = {}
    recorded_features = {t["id"]: feature_tape.at(t["entry"]) for t in recorded}
    for p in ps:
        if p.name not in names:
            continue
        run = simulate(
            obs,
            recorded,
            p,
            start,
            end,
            features=recorded_features,
            controls=controls,
            initial=initial,
        )
        run["windows"] = run_windows(run, start, end)
        run["recovery"] = recovery_losses(run, end)
        conditional[p.name] = run
    for name, run in conditional.items():
        run["difference"] = cash_difference(run, conditional["market_plus2"])
    result = dict(
        capture=end,
        current_start=start,
        models_sha256=digest(root / "models.json"),
        policies=output,
        recorded_conditional=conditional,
        paired=paired_diagnostics(models, raw, audit_data),
        selected=[name for name, r in output.items() if r["qualifies"]],
    )
    write_json(root / "comparison.json", result)
    write_artifact(
        root / "comparison-provenance.json",
        dict(
            models_sha256=digest(root / "models.json"),
            comparison_sha256=digest(root / "comparison.json"),
        ),
    )
    return dict(selected=result["selected"], policies=len(output))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["audit", "build", "compare"])
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    if args.action != "audit":
        result = (build_models if args.action == "build" else compare_models)(args.root)
        print(json.dumps(result, indent=2))
        return
    result = audit(args.root)
    print(
        json.dumps(
            {
                "capture": iso(result["captured_at"]),
                "actual": result["actual"]["current"],
                "episodes": len(result["episodes"]),
                "sensor_exact": result["sensor_check"]["exact"],
                "sensor_n": result["sensor_check"]["n"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
