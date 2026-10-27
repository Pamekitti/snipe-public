"""Causal account simulation. Market evidence continues while entries are paused."""

from __future__ import annotations
import bisect
import collections
from dataclasses import dataclass
import heapq
import json
import math
from pathlib import Path

from .data import write_artifact
from .data import DAY, HOUR, Worker, read_json, write_json
from .execution import booked, describe, validate_dataset, path_request
from .policies import policies, definitions, load
from dataclasses import asdict


@dataclass(frozen=True)
class Observation:
    token: str
    block: int
    launched: int
    scored: int
    bars: dict
    peak: float | None = None
    market_eligible: bool = True


def outcome(rows, window):
    chosen = []
    for o in rows:
        value = o.bars.get("1.75", o.bars.get("1.750"))
        if (
            isinstance(value, (float, int))
            and not isinstance(value, bool)
            and math.isfinite(value)
        ):
            chosen.append((o, value))
            if len(chosen) == window:
                break
    return chosen


def observations(d, raw=None):
    # Account sweeps already hold this immutable snapshot. Reuse it to avoid
    # decompressing and parsing the complete launch history a second time.
    if raw is None:
        raw = read_json(d["source"])
    facts = {r["token"].lower(): r for r in raw["bot_launches"]}
    result = []
    for r in d["observations"]:
        f = facts.get(r["token"].lower(), {})
        if r.get("error") or not r.get("launched_at"):
            continue
        eligible = (f.get("creator_tax_bps") or 0) >= 50 and (
            f.get("exemptions") or 0
        ) >= 3
        try:
            bars = (
                json.loads(r["bars"]) if isinstance(r["bars"], str) else r["bars"] or {}
            )
        except (ValueError, TypeError):
            continue
        result.append(
            Observation(
                r["token"].lower(),
                r["block"],
                r["launched_at"] * 1000,
                r["at"],
                bars,
                r.get("peak"),
                eligible,
            )
        )
    return result


def metrics(cash, start, end):
    values = [r for r in cash if start <= r["at"] < end]
    total = peak = dd = 0
    for r in values:
        total += r["pnl"]
        peak = max(peak, total)
        dd = max(dd, peak - total)
    return dict(
        pnl_wei=str(total),
        pnl_eth=total / 1e18,
        dd_eth=dd / 1e18,
        n=sum(r.get("kind") != "cost" for r in values),
        returns_pct=describe(
            100 * r.get("trade_pnl", r["pnl"]) / r["size"]
            for r in values
            if r.get("kind") != "cost"
        ),
    )


def simulate(
    obs, trades, p, start, end, features=None, controls=(), initial=None, guard=None, derived_cache=None
):
    initial = initial or {}
    features = features or {}
    shared = derived_cache if derived_cache is not None else {}
    binding = shared.setdefault("_binding", (obs, start, end))
    if binding[0] is not obs or binding[1:] != (start, end):
        raise ValueError("Derived cache must share one immutable observation list and interval")
    observation_version = 0
    unknown = []
    events = [(o.scored, 1, o) for o in obs if o.scored < end]
    events += [(t["entry"], 3, t) for t in trades if start <= t["entry"] < end]
    events += [(t, 2, k) for t, k in controls if start <= t < end]
    events += [(t, 2, "tick") for t in range(start, end, 30000)]
    if guard is not None:
        events += [(t, 2, "signal_tick") for t in guard.times if start <= t < end]
    events.append((end, 2, "end"))
    events.sort(key=lambda x: (x[0], x[1]))
    visible = []
    market_visible = []
    available = {}
    active = {}
    closes = []
    cash = []
    actions = []
    decisions = []
    readings = []
    ever = set(initial.get("entered", []))
    template_loss = dict(initial.get("template_loss", {}))
    halts = set(initial.get("halts", []))
    forced_halts = set()
    if not p.account_pauses_enabled:
        halts.clear()
    elif not p.market_enabled:
        halts.discard("venue")
    realized = int(initial.get("realized", 0))
    peak = int(initial.get("peak", 0))
    total = 0
    daily = initial.get("daily_lifts", 0)
    day = start // DAY
    lift_times = list(initial.get("lift_times", []))
    halt_at = initial.get("halt_at", start)
    market_shut = "venue" in halts
    market_seeded = market_shut
    market_count = dd_count = 0
    last_market = last_dd = None
    operator_pending = initial.get("operator_pending", False)
    probation = False
    stage = stage_n = stage_cash = probe_cash = probe_peak = 0
    curve = [(start, 0)]
    closed_pairs = []
    last_pair = None
    serial = 0
    touch_shut = False
    from .features import accepts

    def log(at, action, **kw):
        actions.append(dict(at=at, action=action, **kw))

    def add_observation(o):
        nonlocal observation_version
        observation_version += 1
        available[o.token] = o
        bisect.insort(visible, (-o.block, o.token, o))
        del visible[p.window :]
        if o.market_eligible:
            bisect.insort(market_visible, (-o.block, o.token, o))
            del market_visible[max(p.window * 2, p.recovery_window * 4) :]

    def native_read(at):
        # A cache belongs to one immutable observation list and account interval.
        # Time-independent arithmetic is shared; freshness still uses this check's clock.
        key = ("native", observation_version, p.window, p.touch_bar)
        value = shared.get(key)
        if value is None:
            selected = outcome([x[2] for x in market_visible][: p.window * 2], p.window)
            vals = [v for _, v in selected]
            total = sum(vals)
            signature = tuple(o.token for o, _ in selected)
            touch = [x[2] for x in visible[: p.window] if x[2].peak is not None]
            rate = 100 * sum(o.peak >= p.touch_bar for o in touch) / p.window if len(touch) == p.window else None
            value = (selected, vals, total, signature, rate)
            shared[key] = value
        selected, vals, total, signature, rate = value
        fresh = len(vals) == p.window and at - selected[-1][0].launched <= p.fresh_ms
        return selected, vals, total, signature, rate, fresh

    def check(at, allow_dd=True):
        nonlocal touch_shut, market_shut, market_seeded, market_count, last_market, dd_count, last_dd, realized, peak, daily, operator_pending, probation, stage, stage_n, stage_cash, probe_cash, probe_peak
        selected, vals, s, signature, rate, fresh = native_read(at)
        f = {
            "trimmed": s - max(vals) if fresh else None,
            "short": sum(vals[:5]) if fresh else None,
        }
        recovery_ok = not p.recovery_feature or accepts(p.recovery_feature, f) == (
            True,
            False,
        )
        if p.account_pauses_enabled and p.touch_enabled and rate is not None:
            touch_shut = rate < p.touch_on if touch_shut else rate <= p.touch_off
            if touch_shut:
                halts.add("gate")
            elif not halts.intersection({"manual", "broken", "drawdown", "stopped"}):
                halts.discard("gate")
        if operator_pending:
            market_shut = True
            market_seeded = True
        valid = len(vals) == p.window and (fresh or p.stale == "any_age")
        if valid:
            if not market_seeded:
                market_shut = s < p.off
                market_seeded = True
            if s < p.off:
                market_shut = True
                market_count = 0
            if s > p.on and recovery_ok:
                if signature != last_market:
                    market_count += 1
                    last_market = signature
                if market_count >= p.market_updates:
                    market_shut = False
            else:
                market_count = 0
                last_market = None
            publish_shut = market_shut
        elif not vals:
            publish_shut = "venue" in halts
        else:
            publish_shut = p.stale == "fresh_only" or (
                p.stale in ["hold", "any_age"] and market_shut
            )
        before = "venue" in halts
        signal = guard.read(at) if guard is not None else None
        if signal is not None:
            publish_shut = not signal["allow"]
        if not p.market_enabled or not p.account_pauses_enabled:
            publish_shut = False
        if publish_shut:
            halts.add("venue")
        elif not halts.intersection(
            {"manual", "broken", "drawdown", "stopped", "gate"}
        ):
            halts.discard("venue")
            operator_pending = False
        if before != ("venue" in halts):
            log(
                at,
                "venue_stop" if "venue" in halts else "venue_resume",
                stakes=s,
                fresh=fresh,
            )
            if "venue" not in halts and p.probation:
                probation = True
                stage = stage_n = stage_cash = probe_cash = probe_peak = 0
        if "drawdown" in halts or "probation" in halts:
            post_key = ("post_halt", observation_version, halt_at, p.window, p.recovery_window)
            post_value = shared.get(post_key)
            if post_value is None:
                post = outcome(
                    [o for o in [x[2] for x in market_visible][: p.recovery_window * 4] if o.scored > halt_at],
                    p.recovery_window,
                )
                signature = tuple(o.token for o, _ in post)
                values = [v for _, v in post]
                post_value = (post, signature, values, sum(values))
                shared[post_key] = post_value
            post, signature, values, post_sum = post_value
            good = len(values) == p.recovery_window and post_sum > p.recovery_on
            if p.dd_fresh:
                good = good and at - post[-1][0].launched <= p.fresh_ms
            if p.dd_short:
                good = good and sum(values[:5]) > 0
            if p.recovery_feature == "broad_gains":
                good = good and bool(values) and sum(values) - max(values) > 0
            if good:
                if signature != last_dd:
                    dd_count += 1
                    last_dd = signature
            else:
                dd_count = 0
                last_dd = None
            permitted = daily < p.daily_lifts and (
                not p.rolling_lifts
                or sum(t > at - DAY for t in lift_times) < p.rolling_lifts
            )
            if (
                allow_dd
                and dd_count >= p.dd_updates
                and permitted
                and not active
                and not halts.intersection({"manual", "broken"})
            ):
                halts.discard("drawdown")
                halts.discard("probation")
                realized = peak = 0
                daily += 1
                lift_times.append(at)
                log(at, "dd_resume", stakes=sum(values))
                if p.probation:
                    probation = True
                    stage = stage_n = stage_cash = probe_cash = probe_peak = 0
        reading = dict(at=at, stakes=s, fresh=fresh, halts=sorted(halts))
        if signal is not None:
            reading["signal"] = signal
        readings.append(reading)

    for at, kind, item in events:
        if at < start:
            if kind == 1:
                add_observation(item)
            continue
        while closes and closes[0][0] < end and closes[0][0] <= at:
            closed_at, _, kind_close, t, value = heapq.heappop(closes)
            if kind_close == "close":
                active.pop(t["id"])
            realized += value
            peak = max(peak, realized)
            total += value
            curve.append((closed_at, total))
            cash.append(
                dict(
                    at=closed_at,
                    id=t["id"],
                    pnl=value,
                    size=t["size"],
                    kind=kind_close,
                    trade_pnl=t["pnl"],
                )
            )
            if guard is not None and kind_close == "close":
                guard.closed(t)
            if (
                kind_close == "close"
                and t.get("is_trade", True)
                and t["pnl"] < 0
                and t.get("template")
            ):
                template_loss[t["template"]] = closed_at
            if (
                p.account_pauses_enabled
                and peak - realized >= p.dd_wei
                and "drawdown" not in halts
            ):
                halts.add("drawdown")
                halt_at = closed_at
                dd_count = 0
                last_dd = None
                log(closed_at, "dd_stop")
            if kind_close == "close" and t.get("is_trade", True):
                closed_pairs.append(t)
                closed_pairs.sort(
                    key=lambda row: (
                        row["id"] if isinstance(row["id"], int) else row["entry"]
                    )
                )
                closed_pairs = closed_pairs[-20:]
            if probation:
                stage_n += int(kind_close == "close")
                stage_cash += value
                probe_cash += value
                probe_peak = max(probe_peak, probe_cash)
                if probe_peak - probe_cash >= p.probe_loss_wei:
                    halts.add("probation")
                    halt_at = closed_at
                    dd_count = 0
                    probation = False
                    log(closed_at, "probation_stop")
                elif stage_n >= 3 and stage_cash > 0:
                    if p.probe_sizes and stage < len(p.probe_sizes) - 1:
                        stage += 1
                        stage_n = stage_cash = 0
                        log(closed_at, "probe_step", stage=stage)
                    else:
                        probation = False
                        log(closed_at, "probation_complete")
        if at // DAY != day:
            day = at // DAY
            daily = 0
        if kind == 1:
            add_observation(item)
            # Market updates are evaluated when a new score becomes available.
            check(at, False)
            continue
        if kind == 2:
            if item == "signal_tick":
                # A new indicator must not accelerate the other guards' polling clocks.
                check(at, False)
                continue
            if isinstance(item, dict):
                forced = item.get("force_halt")
                if forced and p.account_pauses_enabled:
                    if item.get("active", True):
                        forced_halts.add(forced)
                    else:
                        forced_halts.discard(forced)
                h = item.get("halt")
                if h and p.account_pauses_enabled:
                    if item.get("active", True):
                        halts.add(h)
                    else:
                        halts.discard(h)
                item = item.get("action", "tick")
            if not p.account_pauses_enabled:
                item = "tick"
            if item == "stop":
                halts.add("stopped")
                log(at, "operator_stop")
            elif item == "resume":
                if "stopped" in halts and not halts.intersection(
                    {"manual", "broken", "drawdown"}
                ):
                    halts.discard("stopped")
                    halts.add("venue")
                    operator_pending = True
                    log(at, "operator_resume_requested")
            elif item == "legacy_start":
                if not halts.intersection({"manual", "broken", "drawdown"}):
                    halts.discard("stopped")
            elif item == "restart":
                halts.discard("broken")
                halts.discard("gate")
                touch_shut = False
                if not operator_pending:
                    halts.discard("venue")
                market_shut = operator_pending
                market_seeded = operator_pending
                market_count = dd_count = 0
                last_market = last_dd = None
                closed_pairs = []
                last_pair = None
            if (
                p.account_pauses_enabled
                and len(closed_pairs) >= 20
                and last_pair != closed_pairs[-1]["id"]
            ):
                pairs = closed_pairs[-20:]
                last_pair = pairs[-1]["id"]
                bytoken = available
                vals = []
                for t in pairs:
                    o = bytoken.get(t["token"])
                    key = f'{t.get("tp",1.75):.2f}'
                    if o and isinstance(o.bars.get(key), (int, float)):
                        vals.append(t["pnl"] / t["size"] - 0.78 * o.bars[key])
                if len(vals) == 20:
                    if sum(vals) / 20 <= -0.15:
                        halts.add("broken")
                        log(at, "broken_stop")
            check(at)
            continue
        t = dict(item)
        reason = "recorded_" + sorted(forced_halts)[0] if forced_halts else None
        feature_missing = False
        if halts and reason is None:
            reason = next(
                k
                for k in [
                    "manual",
                    "broken",
                    "drawdown",
                    "stopped",
                    "gate",
                    "venue",
                    "probation",
                ]
                if k in halts
            )
        if reason is None and t["token"] in ever:
            reason = "already_entered"
        if (
            reason is None
            and p.min_creator_tax_bps
            and (t.get("creator_tax_bps") or 0) < p.min_creator_tax_bps
        ):
            reason = "tax"
        if (
            reason is None
            and p.min_exemptions
            and (t.get("exemptions") or 0) < p.min_exemptions
        ):
            reason = "exempt"
        if (
            reason is None
            and t.get("template") in template_loss
            and at - template_loss[t["template"]] < p.template_loss_ms
        ):
            reason = "template_loss"
        if reason is None and p.entry_feature:
            feature_ok, feature_missing = accepts(
                p.entry_feature, features.get(t["id"], {})
            )
            if not feature_ok:
                reason = "feature"
        if reason is None and guard is not None:
            size, reason = guard.entry(at, t, active)
            if reason is None and size != t["size"]:
                variant = t.get("variants", {}).get(str(size))
                if variant is None:
                    reason = "missing_size_replay"
                else:
                    t.update(variant)
        recent_peak = (
            max(v for when, v in curve if when >= at - DAY)
            if p.rolling_dd_wei and any(when >= at - DAY for when, _ in curve)
            else total
        )
        if (
            reason is None
            and p.rolling_dd_wei
            and recent_peak - total >= p.rolling_dd_wei
        ):
            reason = "rolling_dd"
        if reason is None and probation and active:
            reason = "probation_capacity"
        if reason is None and p.probe_sizes and probation:
            size = p.probe_sizes[stage]
            if t["size"] != size:
                variant = t.get("variants", {}).get(str(size))
                if variant:
                    t.update(variant)
                else:
                    reason = "missing_size_replay"
        if reason is None and len(active) >= p.max_concurrent:
            reason = "capacity"
        if (
            reason is None
            and sum(x["size"] for x in active.values()) + t["size"] > p.bankroll_wei
        ):
            reason = "capacity"
        if reason is None and t.get("unsupported"):
            reason = "unsupported_execution"
        if reason is None and t.get("entry_rejected"):
            reason = "entry_price"
        decision = dict(
            at=at, id=t["id"], reason=reason, feature_missing=feature_missing
        )
        if guard is not None:
            decision.update(size=t["size"], signal=guard.last)
        decisions.append(decision)
        if reason in ("unsupported_execution", "missing_size_replay"):
            unknown.append(
                dict(at=at, id=t["id"], reason=reason, detail=t.get("unsupported"))
            )
            # The unknown holding occupies capital. Later profit and DD cannot be determined.
            active[t["id"]] = t
            break
        if reason is None:
            if guard is not None:
                guard.entered(t)
            ever.add(t["token"])
            active[t["id"]] = t
            serial += 1
            costs = [
                (max(at, c["at"]), int(c["wei"]))
                for c in t.get("costs", [])
                if c["at"] < t["exit"]
            ]
            heapq.heappush(
                closes,
                (t["exit"], serial, "close", t, t["pnl"] + sum(v for _, v in costs)),
            )
            for when, value in costs:
                serial += 1
                heapq.heappush(closes, (when, serial, "cost", t, -value))
    return dict(
        cash=cash,
        actions=actions,
        decisions=decisions,
        readings=readings,
        open_ids=list(active),
        unresolved=unknown,
        complete=not unknown and not active,
        initial_state=initial
        or {"label": "hypothetical flat checkpoint", "realized": 0, "peak": 0},
        initial_state_provided=bool(initial),
        initial_state_verified=False,
        metrics=metrics(cash, start, end),
    )


def open_costs(d, p):
    costs = []
    for a in d.get("ancillary", []):
        if (
            a["position_id"] != p["id"]
            or a.get("rejected")
            or not a.get("gas_wei")
            or a["hash"] == p.get("exit_hash")
        ):
            continue
        receipt = d["receipts"].get(a["hash"])
        block = d["blocks"].get(receipt["blockNumber"]) if receipt else None
        if block:
            costs.append(
                dict(
                    at=max(a["at"], block["timestamp"] * 1000 + 1000), wei=a["gas_wei"]
                )
            )
    return costs


def policy_diagnostics(result):
    accepted = [row for row in result["decisions"] if row["reason"] is None]
    blocked = collections.Counter(
        row["reason"] for row in result["decisions"] if row["reason"] is not None
    )
    trade_cash = [row for row in result["cash"] if row.get("kind") != "cost"]
    trade_pnl = [row.get("trade_pnl", row["pnl"]) for row in trade_cash]
    total = int(result["metrics"]["pnl_wei"])
    resumes = sorted(
        {
            row["at"]
            for row in result["actions"]
            if row["action"] in ["venue_resume", "dd_resume"]
        }
    )
    stops = sorted(
        row["at"]
        for row in result["actions"]
        if row["action"] in ["venue_stop", "dd_stop", "probation_stop"]
    )
    false_restarts = 0
    for at in resumes:
        stop = next((value for value in stops if value > at), None)
        if stop is None:
            continue
        entered = [row for row in accepted if at < row["at"] < stop]
        cash = [row["pnl"] for row in trade_cash if at < row["at"] < stop]
        if entered and cash and sum(cash) < 0:
            false_restarts += 1
    return dict(
        accepted=len(accepted),
        blocked=dict(sorted(blocked.items())),
        false_restarts=false_restarts,
        dd_stops=sum(row["action"] == "dd_stop" for row in result["actions"]),
        dd_resumes=sum(row["action"] == "dd_resume" for row in result["actions"]),
        venue_resumes=sum(row["action"] == "venue_resume" for row in result["actions"]),
        feature_missing=sum(row.get("feature_missing", False) for row in accepted),
        missed_fill_sensitivity=dict(
            miss_one_best_eth=(total - max([0] + trade_pnl)) / 1e18,
            add_one_worst_eth=(total + min([0] + trade_pnl)) / 1e18,
        ),
    )


def choose_policy(results):
    baseline = results.get("market_plus2")
    qualifying = []
    if baseline and baseline["ranking_eligible"]:
        for name, candidate in results.items():
            if name == "market_plus2" or not candidate["ranking_eligible"]:
                continue
            if (
                candidate["selection"]["pnl_eth"] > baseline["selection"]["pnl_eth"]
                and candidate["reserved6h"]["pnl_eth"]
                > baseline["reserved6h"]["pnl_eth"]
                and candidate["metrics"]["pnl_eth"] > baseline["metrics"]["pnl_eth"]
                and candidate["metrics"]["dd_eth"] <= baseline["metrics"]["dd_eth"]
            ):
                qualifying.append(name)
    qualifying.sort(
        key=lambda name: (
            -results[name]["metrics"]["pnl_eth"],
            results[name]["metrics"]["dd_eth"],
            name,
        )
    )
    selected = qualifying[0] if qualifying else "market_plus2"
    return dict(
        baseline="market_plus2",
        selected=selected,
        replacements=qualifying,
        changed=selected != "market_plus2",
        rule=(
            "A replacement must beat +2 in calibration, reserved six hours, and full-period profit without higher drawdown."
        ),
        reason=(
            "highest qualifying full-period profit"
            if qualifying
            else "no complete candidate passed every replacement condition"
        ),
    )


def executable_partition(trades):
    eligible = [trade for trade in trades if not trade.get("unsupported")]
    unavailable = [trade for trade in trades if trade.get("unsupported")]
    return eligible, unavailable


def compare(run, mode="recorded", policy_file=None):
    run = Path(run)
    if mode == "legacy":
        from .legacy import reproduce

        return reproduce(run)
    d, m = validate_dataset(run)
    obs = observations(d)
    config = d["state"]["config"]["values"]
    ps = load(config, policy_file)
    from .features import Features, activity

    raw = read_json(d["source"])
    feature_tape = Features(raw, obs, activity(d))
    if mode == "recorded":
        # Derive the latest size/rule era from recorded contexts, rather than a date constant.
        ordered = sorted(
            d["positions"], key=lambda p: p.get("t_decide") or p["t_detect"]
        )

        def era(p):
            c = p.get("context_json")
            c = json.loads(c) if isinstance(c, str) and c else c or {}
            spec = c.get("entryStrategy", {})
            # Market threshold is the experiment; hold execution and entry rules fixed.
            keys = [
                "tradeSizeEth",
                "minCreatorTaxBps",
                "minExemptionsToEnter",
                "templateLossBlockMs",
                "maxHoldMs",
                "hardStopMultiple",
                "deadCoinAfterMs",
                "deadCoinBelowMult",
                "maxEntryPriceMultiple",
            ]
            return tuple(spec.get(k) for k in keys) if spec else None

        latest = era(ordered[-1]) if ordered else None
        boundary = len(ordered)
        while (
            boundary > 0 and latest is not None and era(ordered[boundary - 1]) == latest
        ):
            boundary -= 1
        start = (
            max(
                d["start"],
                ordered[boundary].get("t_decide") or ordered[boundary]["t_detect"],
            )
            if boundary < len(ordered)
            else d["snapshot_at"]
        )
        rows = [p for p in ordered[boundary:] if p.get("exit_at") and p["closed"]]
        facts = {f["token"].lower(): f for f in d["launches"]}
        trades = []
        for p in rows:
            f = facts.get(p["token"].lower(), {})
            template = f'{f.get("creator_tax_bps")}:{f.get("dev_buy_wei")}:{f.get("exemptions")}'
            trades.append(
                dict(
                    id=p["id"],
                    token=p["token"].lower(),
                    entry=p.get("t_decide") or p["t_detect"],
                    exit=p["exit_at"],
                    pnl=booked(p),
                    size=int(p["spend_wei"]),
                    template=template,
                    tp=p.get("take_profit") or 1.75,
                    is_trade=bool(p.get("buy_ok"))
                    and p.get("exit_reason")
                    not in ["buy-never-mined", "buy-reverted", "recovered-flat"],
                    costs=open_costs(d, p),
                )
            )
    else:
        from .execution import opportunities

        start = d["start"]
        trades, unavailable_execution = executable_partition(opportunities(run, d))
    if mode == "recorded":
        unavailable_execution = []
    features = {t["id"]: feature_tape.at(t["entry"]) for t in trades}
    end = d["snapshot_at"]
    result = {}
    controls = []
    for h in d.get("health", []):
        if h.get("component") == "operator":
            action = (
                "stop"
                if not h["ok"]
                else (
                    "resume"
                    if "automatic operation" in h.get("detail", "").lower()
                    else "legacy_start"
                )
            )
            controls.append((h["at"], action))
    # Operator events are external inputs; candidate-dependent DD/venue halts are simulated.

    for p in ps:
        r = simulate(obs, trades, p, start, end, features, controls)
        r["selection"] = metrics(r["cash"], start, max(start, end - 6 * HOUR))
        r["reserved6h"] = metrics(r["cash"], max(start, end - 6 * HOUR), end)
        r["bins24"] = [
            metrics(
                r["cash"],
                max(start, end - DAY + i * 3 * HOUR),
                end - DAY + (i + 1) * 3 * HOUR,
            )
            for i in range(8)
        ]
        r["bins7"] = [
            dict(
                **metrics(
                    r["cash"],
                    max(start, end - 7 * DAY + i * DAY),
                    end - 7 * DAY + (i + 1) * DAY,
                ),
                available=end - 7 * DAY + (i + 1) * DAY > start,
            )
            for i in range(7)
        ]
        r["diagnostics"] = policy_diagnostics(r)
        r["ranking_eligible"] = mode == "opportunities" and r["complete"]
        r["limits"] = [
            "initial account is hypothetical",
            "historical touch and process-health state incomplete",
        ]
        if unavailable_execution:
            r["limits"].append(
                "opportunities with incomplete execution paths are excluded before every policy"
            )
        if r["unresolved"]:
            r["limits"].append(
                "simulation stops at the first admitted unresolved execution"
            )
        if mode == "recorded":
            r["limits"].append(
                "cannot establish newly admitted fills or different sizes"
            )
        result[p.name] = r
    baseline = result.get("market_plus2")
    verdict = choose_policy(result)
    output = dict(
        mode=mode,
        start=start,
        end=end,
        dataset_sha256=m["dataset_sha256"],
        policies=[asdict(p) for p in ps],
        results=result,
        coverage=dict(
            attempts=len(trades) + len(unavailable_execution),
            execution_eligible=len(trades),
            execution_unavailable=len(unavailable_execution),
            unavailable_reasons=dict(
                sorted(
                    collections.Counter(
                        trade.get("unsupported") or "unknown"
                        for trade in unavailable_execution
                    ).items()
                )
            ),
            native_scores=len(obs),
        ),
        feature_series=[
            dict(at=t["entry"], id=t["id"], **features[t["id"]]) for t in trades
        ],
        ranking_eligible=bool(baseline and baseline["ranking_eligible"]),
        verdict=verdict,
    )
    write_artifact(run / f"comparison-{mode}.json", output)
    return output
