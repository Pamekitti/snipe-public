"""Compare recorded guard cycles with unchanged-TP/filter execution replays. Offline outputs only."""

from __future__ import annotations
import argparse
import bisect
import collections
import copy
import json
from dataclasses import replace
from pathlib import Path
from datetime import datetime, timezone

from .data import Worker, HOUR, DAY, digest, read_json, write_json, write_artifact
from .execution import path_request, booked, describe, validate_dataset
from .account import observations
from .evaluation import (
    entry,
    context,
    current_start,
    controls_and_initial,
    trade_from_model,
    replay_model_account,
    adaptive_at,
    spans,
    rolling_at,
    movement,
    iso,
)
from .policies import policies
from .fidelity import cash_metrics


def close_cash(run):
    values = collections.defaultdict(int)
    times = {}
    for r in run["cash"]:
        values[r["id"]] += int(r["pnl"])
        times[r["id"]] = max(times.get(r["id"], 0), r["at"])
    return sorted(
        [dict(id=k, at=times[k], pnl=v) for k, v in values.items()],
        key=lambda r: (r["at"], str(r["id"])),
    )


def selected_cash(run, models, lo, hi):
    ids = {
        r["id"] for r in run["decisions"] if r["reason"] is None and lo <= r["at"] < hi
    }
    rows = [r for r in close_cash(run) if r["id"] in ids]
    missing = [r for r in run["unresolved"] if r["at"] < hi]
    return dict(
        **cash_metrics(rows), complete=not missing and not (ids & set(run["open_ids"]))
    )


def difference(extra, base, lo, hi):
    a = {r["id"]: r for r in close_cash(extra) if lo <= r["at"] < hi}
    b = {r["id"]: r for r in close_cash(base) if lo <= r["at"] < hi}
    common = a.keys() & b.keys()
    return dict(
        extra_profit_wei=str(sum(max(r["pnl"], 0) for k, r in a.items() if k not in b)),
        extra_loss_wei=str(-sum(min(r["pnl"], 0) for k, r in a.items() if k not in b)),
        displaced_profit_wei=str(
            sum(max(r["pnl"], 0) for k, r in b.items() if k not in a)
        ),
        displaced_loss_wei=str(
            -sum(min(r["pnl"], 0) for k, r in b.items() if k not in a)
        ),
        shared_cash_difference_wei=str(sum(a[k]["pnl"] - b[k]["pnl"] for k in common)),
        net_difference_wei=str(
            sum(r["pnl"] for r in a.values()) - sum(r["pnl"] for r in b.values())
        ),
    )


def flat_boundary(raw, requested):
    start = requested
    # Roll back to before any position crossing the requested boundary.
    while True:
        active = [
            p
            for p in raw["bot_positions"]
            if p["live"]
            and entry(p) < start
            and (not p.get("exit_at") or p["exit_at"] >= start)
        ]
        if not active:
            return start
        start = min(entry(p) for p in active) - 1


def inputs_at(raw, obs, models, start):
    controls, initial = controls_and_initial(raw, start)
    facts = {f["token"].lower(): f for f in raw["bot_launches"]}
    initial["template_loss"] = {}
    for p in raw["bot_positions"]:
        if (
            p["live"]
            and p.get("buy_ok")
            and p.get("exit_at")
            and start - HOUR <= p["exit_at"] < start
            and p.get("exit_reason")
            not in ("buy-reverted", "buy-never-mined", "recovered-flat")
            and booked(p) < 0
        ):
            f = facts.get(p["token"].lower(), {})
            k = f"{f.get('creator_tax_bps')}:{f.get('dev_buy_wei')}:{f.get('exemptions')}"
            initial["template_loss"][k] = max(
                initial["template_loss"].get(k, 0), p["exit_at"]
            )
    return obs, controls, initial, facts, {}, None


def model_request(d, z, p, worker):
    req, missing = path_request(d, p, int(z["gas_wei"]), lag=z["delay_ms"], poll=50)
    if missing:
        return {k: dict(status=missing) for k in ("adaptive", "fast_sell", "slow_sell")}
    req.update(
        buyGasWei=z["buy_gas_wei"],
        buyAt=z["entry"] + max(0, z["send_delay_ms"]),
        openedAt=z["entry"] + max(0, z["open_delay_ms"]),
    )
    results = worker.call(
        op="replay_many",
        request=req,
        variants=[{}, dict(sellDelayMs=600), dict(sellDelayMs=1200)],
    )
    return dict(zip(("adaptive", "fast_sell", "slow_sell"), results))


def build_models(root, previous, tail):
    """Reuse immutable closed paths; extend only after the previous frozen capture."""
    raw = read_json(root / "snapshot.json.gz")
    old = read_json(previous / "models.json")
    old_end = read_json(previous / "audit.json")["captured_at"]
    d, manifest = validate_dataset(tail)
    if d["start"] != old_end:
        raise ValueError("tail must start at previous capture")
    if old["model_code_sha256"]["worker.ts"] != digest(
        Path(__file__).with_name("worker.ts")
    ):
        raise ValueError("execution worker changed; rebuild the full execution model")
    fidelity_path = Path(read_json(previous / "fidelity-current.json")["artifact"])
    fidelity = read_json(fidelity_path)
    if fidelity["source_hashes"]["models.json"] != digest(previous / "models.json"):
        raise ValueError("independent predictions belong to different models")
    models = copy.deepcopy(old)
    for r in fidelity["predictions"]:
        models["tokens"][r["token"]]["results"]["adaptive"] = r["result"]
    live = sorted(
        [p for p in raw["bot_positions"] if p["live"] and context(p).get("rules")],
        key=entry,
    )
    times = [entry(p) for p in live]
    actual = {p["token"].lower(): p for p in live}
    frozen = max(
        (
            z
            for z in old["tokens"].values()
            if z.get("gas_wei")
            and z.get("send_delay_ms") is not None
            and z.get("open_delay_ms") is not None
        ),
        key=lambda z: z["entry"],
    )
    with Worker() as worker:
        # Previous failed-buy outcomes must not be copied into the stress comparisons.
        old_d = None
        for r in fidelity["predictions"]:
            if not r["actual_failed"]:
                continue
            if old_d is None:
                old_d = read_json(previous / "replay/dataset.json")
            z = models["tokens"][r["token"]]
            z["results"].update(model_request(old_d, z, actual[r["token"]], worker))
        del old_d
        for f in sorted(d["launches"], key=lambda f: f["block"]):
            token = f["token"].lower()
            p = actual.get(token)
            at = (
                entry(p)
                if p
                else max(f.get("detected_at") or 0, f["launched_at"] * 1000 + 2000)
            )
            if not f.get("passed") or not old_end <= at < raw["snapshot_at"]:
                continue
            if token in models["tokens"]:
                raise ValueError("overlapping extension token")
            j = bisect.bisect_right(times, at) - 1
            ctx = context(p or live[j]) if j >= 0 else {}
            if not ctx.get("rules"):
                raise ValueError("missing historical rules")
            tp = p.get("take_profit") if p else None
            tp = tp or adaptive_at(raw, at, worker)
            size = (
                int(p["spend_wei"])
                if p
                else round(ctx["entryStrategy"]["tradeSizeEth"] * 1e18)
            )
            z = dict(
                token=token,
                entry=at,
                size=size,
                tp=tp,
                delayed_tp=tp,
                template=f"{f.get('creator_tax_bps')}:{f.get('dev_buy_wei')}:{f.get('exemptions')}",
                creator_tax_bps=f.get("creator_tax_bps"),
                exemptions=f.get("exemptions"),
                **{
                    k: frozen[k]
                    for k in (
                        "gas_wei",
                        "buy_gas_wei",
                        "gas_n",
                        "delay_ms",
                        "send_delay_ms",
                        "open_delay_ms",
                    )
                },
            )
            if p:
                z["send_delay_ms"] = (
                    p["t_sent"] - at if p.get("t_sent") else z["send_delay_ms"]
                )
                z["open_delay_ms"] = context(p).get("at", at) - at
            fake = dict(
                token=token,
                curve=f["curve"],
                t_decide=at,
                t_detect=at,
                spend_wei=str(size),
                take_profit=tp,
                context_json=ctx,
            )
            z["results"] = model_request(d, z, fake, worker)
            # No staged stake changes are requested. Unsupported variants remain explicit.
            z["results"].update(
                {
                    k: dict(status="not_requested")
                    for k in ("probe_quarter", "probe_half")
                }
            )
            models["tokens"][token] = z
    models["extension_provenance"] = dict(
        previous_models_sha256=digest(previous / "models.json"),
        independent_predictions_sha256=digest(fidelity_path),
        tail_dataset_sha256=manifest["dataset_sha256"],
        prior_capture=old_end,
        new_capture=raw["snapshot_at"],
        frozen_cost_and_timing_source_entry=frozen["entry"],
        note="Existing outcomes retained; prior actual failures independently replayed; tail costs frozen at prior capture.",
    )
    write_artifact(root / "guard-models.json", models)
    return models


def funding(run, models, start, end):
    events = []
    for r in run["decisions"]:
        if r["reason"] is not None:
            continue
        z = models["tokens"][r["id"]]
        events.append((r["at"], 1, z["size"]))
        result = z["results"]["adaptive"]
        if result.get("exitAt") is not None and result["exitAt"] < end:
            events.append((result["exitAt"], 0, -z["size"] - int(result["pnlWei"])))
    locked = required = 0
    for _, _, delta in sorted(events):
        locked += delta
        required = max(required, locked)
    return str(required)


def cycle_rows(raw, audit, models, runs, obs, start, end):
    out = []
    positions = {p["id"]: p for p in raw["bot_positions"]}
    for e in audit["episodes"]:
        if not start <= e["at"] < end:
            continue
        lo = max(start, e["pause_from"])
        hi = min(end, e["until"])
        actual = [
            dict(id=i, at=positions[i]["exit_at"], pnl=booked(positions[i]))
            for i in e["position_ids"]
            if positions[i].get("exit_at") and positions[i]["exit_at"] < end
        ]
        out.append(
            dict(
                reopen=e["at"],
                pause_from=lo,
                until=hi,
                kind=e["kind"],
                partial_pause=e["pause_from"] < start,
                movement=movement(rolling_at(obs, lo), rolling_at(obs, e["at"])),
                before={
                    k: selected_cash(r, models, lo, e["at"]) for k, r in runs.items()
                },
                after={
                    k: selected_cash(r, models, e["at"], hi) for k, r in runs.items()
                },
                actual_after=cash_metrics(actual),
            )
        )
    return out


def score_passages(raw, models, runs, obs, start, end):
    """Descriptive passages, never an entry signal chosen with future information."""
    samples = sorted(
        [s for s in raw["bot_guard_samples"] if s["live"] and start <= s["at"] < end],
        key=lambda s: s["at"],
    )
    rows = []
    low = None
    last = None
    for i, s in enumerate(samples):
        if (
            not s["market_fresh"]
            or s["market"] is None
            or (last is not None and s["at"] - last > 60_000)
        ):
            low = None
        last = s["at"]
        if not s["market_fresh"] or s["market"] is None:
            continue
        if s["market"] <= s["market_off"]:
            low = s
            continue
        if s["market"] <= s["market_on"] or low is None:
            continue
        boundary = end
        complete = False
        prior = s["at"]
        for t in samples[i + 1 :]:
            if not t["market_fresh"] or t["market"] is None or t["at"] - prior > 60_000:
                boundary = t["at"]
                break
            prior = t["at"]
            if t["market"] <= t["market_off"]:
                boundary = t["at"]
                complete = True
                break

        def actual(lo, hi):
            return cash_metrics(
                [
                    dict(id=p["id"], at=p["exit_at"], pnl=booked(p))
                    for p in raw["bot_positions"]
                    if p["live"]
                    and lo <= entry(p) < hi
                    and p.get("closed")
                    and p.get("exit_at") < end
                ]
            )

        rows.append(
            dict(
                from_ms=low["at"],
                crossed_ms=s["at"],
                to_ms=boundary,
                fall_complete=complete,
                from_score=low["market"],
                to_score=s["market"],
                halts_at_crossing=json.loads(s["halts"]),
                movement=movement(rolling_at(obs, low["at"]), rolling_at(obs, s["at"])),
                rise={
                    k: selected_cash(r, models, low["at"], s["at"])
                    for k, r in runs.items()
                },
                after={
                    k: selected_cash(r, models, s["at"], boundary)
                    for k, r in runs.items()
                },
                actual_rise=actual(low["at"], s["at"]),
                actual_after=actual(s["at"], boundary),
            )
        )
        low = None
    return rows


def run(root, previous, tail, out):
    root, previous, tail, out = map(
        lambda p: Path(p).resolve(), (root, previous, tail, out)
    )
    if out.exists():
        raise ValueError("choose a fresh output directory")
    raw = read_json(root / "snapshot.json.gz")
    audit = read_json(root / "audit.json")
    models = (
        read_json(root / "guard-models.json")
        if (root / "guard-models.json").exists()
        else build_models(root, previous, tail)
    )
    end = raw["snapshot_at"]
    provenance = models["extension_provenance"]
    if (
        provenance["new_capture"] != end
        or provenance["previous_models_sha256"] != digest(previous / "models.json")
        or provenance["tail_dataset_sha256"] != digest(tail / "dataset.json")
    ):
        raise ValueError("cached guard models belong to different evidence")
    era = current_start(raw)
    start = flat_boundary(raw, max(era, end - 2 * DAY))
    obs = observations(
        dict(source=str(root / "snapshot.json.gz"), observations=raw["gate_obs"])
    )
    inputs = inputs_at(raw, obs, models, start)
    base = replace(
        policies(raw["state"]["config"]["values"])[0],
        min_creator_tax_bps=50,
        min_exemptions=3,
    )
    ps = [
        base,
        replace(base, name="market_off", market_enabled=False),
        replace(
            base,
            name="continuous",
            market_enabled=False,
            account_pauses_enabled=False,
            touch_enabled=False,
        ),
    ]
    runs = {}
    stress = {}
    for variant in ("adaptive", "fast_sell", "slow_sell"):
        group = {
            p.name: replay_model_account(models, p, variant, inputs, start, end)
            for p in ps
        }
        stress[variant] = group
        if variant == "adaptive":
            runs = group
        if not all(r["complete"] for r in group.values()):
            raise ValueError(
                "unresolved execution prevents a complete comparison; narrow the window before plotting"
            )
    actual = [
        dict(id=p["id"], at=p["exit_at"], pnl=booked(p))
        for p in raw["bot_positions"]
        if p["live"]
        and (p.get("cohort") or "main") == "main"
        and era <= entry(p) < end
        and p.get("closed")
        and p.get("exit_at") < end
    ]
    cycles = cycle_rows(raw, audit, models, runs, obs, start, end)
    passages = score_passages(raw, models, runs, obs, start, end)
    passage_sensitivity = {
        variant: score_passages(raw, models, group, obs, start, end)
        for variant, group in stress.items()
    }
    windows = {}
    for name, (lo, hi) in spans(end, era).items():
        a = [r for r in actual if lo <= r["at"] < hi]
        windows[name] = dict(
            from_ms=min(lo, hi), to_ms=hi, actual=cash_metrics(a), scenarios={}
        )
        for k, r in runs.items():
            bound = min([end] + [v["at"] for v in r["unresolved"]])
            available = lo >= start and hi > lo and hi <= bound
            windows[name]["scenarios"][k] = dict(
                available=available,
                cash=cash_metrics(
                    [
                        v
                        for v in close_cash(r)
                        if max(lo, start) <= v["at"] < min(hi, bound)
                    ]
                ),
            )
    result = dict(
        captured_at=end,
        start=start,
        era_start=era,
        actual=actual,
        runs=runs,
        windows=windows,
        cycles=cycles,
        passages=passages,
        passage_sensitivity=passage_sensitivity,
        stress={
            v: {
                k: dict(
                    metrics=r["metrics"],
                    complete=r["complete"],
                    unresolved=r["unresolved"],
                )
                for k, r in group.items()
            }
            for v, group in stress.items()
        },
        difference=difference(runs["continuous"], runs["market_plus2"], start, end),
        funding_required_wei={
            k: funding(r, models, start, end) for k, r in runs.items()
        },
        source_hashes={
            str(p): digest(p)
            for p in (
                root / "snapshot.json.gz",
                root / "audit.json",
                root / "guard-models.json",
                root / "chart.json",
            )
        },
        provenance=models["extension_provenance"],
        status="diagnostic_only",
        assumptions=[
            "TP selector, entry floors, repeat-loss rule and simultaneous exposure limit are unchanged.",
            "Continuous removes account pauses in simulation only, including drawdown, touch, broken and operator stops.",
            "Constant stake and exposure cap assume replenishable funds; required funding is reported separately.",
            "Cash is booked at close; cycle cohorts use entry time. Unknown admitted executions end the comparable path.",
            "The market line is recorded rolling launch return at a fixed 1.75 target, not wallet cash or the adaptive TP.",
            "Execution fidelity previously failed. Shared execution errors may not cancel between policies.",
            "No thresholds fitted; all conclusions retrospective. Final six hours were excluded from old cost calibration.",
        ],
    )
    out.mkdir(parents=True)
    write_artifact(out / "comparison.json", result)
    render(raw, result, read_json(root / "chart.json"), out)
    return result


def render(raw, r, chart, out):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as md
    import numpy as np

    def dt(at):
        return datetime.fromtimestamp(at / 1000, timezone.utc)

    colors = {
        "market_plus2": "#2264a4",
        "market_off": "#d17b16",
        "continuous": "#8542a0",
        "actual": "#343b43",
    }
    names = {
        "market_plus2": "Guard on (simulated)",
        "market_off": "Market guard off; other stops remain",
        "continuous": "Continuous; all account pauses off",
        "actual": "Actual cash",
    }
    start, end = r["start"], r["captured_at"]
    fig, axes = plt.subplots(
        4,
        1,
        figsize=(15, 13),
        sharex=True,
        gridspec_kw={"height_ratios": [2, 2.8, 1.6, 1.2]},
    )
    market = [
        v
        for v in chart["market"]
        if start <= v["t"] <= end and v.get("source") == "recorded"
    ]
    axes[0].plot(
        [dt(v["t"]) for v in market],
        [v["sum"] if v.get("fresh") else np.nan for v in market],
        color="#343b43",
        lw=1,
    )
    for level in (-1, 2):
        axes[0].axhline(level, color="#8a8a8a", ls="--", lw=0.8)
        axes[0].text(dt(end), level, f" {level:+}", va="center", fontsize=10)
    axes[0].set_ylabel("Rolling score\n(stakes, not cash)")
    fig.suptitle(
        "Some pauses miss profit; others avoid losses",
        x=0.07,
        y=0.985,
        ha="left",
        weight="bold",
        fontsize=18,
    )
    fig.text(
        0.07,
        0.958,
        f"{dt(start):%d %b %H:%M} to {dt(end):%d %b %H:%M} UTC | shaded: actual market pause | gaps: stale or missing score",
        fontsize=10,
    )
    for h in chart["recordedStates"]:
        if "venue" in h["kinds"]:
            for ax in axes:
                ax.axvspan(
                    dt(max(start, h["from"])),
                    dt(min(end, h["to"])),
                    color="#8b93a0",
                    alpha=0.12,
                    lw=0,
                )
    for k, run in r["runs"].items():
        rows = [v for v in close_cash(run) if start <= v["at"] < end]
        bound = min([end] + [v["at"] for v in run["unresolved"]])
        xs = [start] + [v["at"] for v in rows] + [bound]
        ys = [0] + list(np.cumsum([v["pnl"] / 1e18 for v in rows]))
        ys.append(ys[-1])
        axes[1].step(
            [dt(v) for v in xs],
            ys,
            where="post",
            color=colors[k],
            lw=1.7,
            ls={"market_plus2": "--", "market_off": ":", "continuous": "-"}[k],
            label=names[k],
        )
    a = [v for v in r["actual"] if start <= v["at"] < end]
    axes[1].step(
        [dt(start)] + [dt(v["at"]) for v in a] + [dt(end)],
        [0]
        + list(np.cumsum([v["pnl"] / 1e18 for v in a]))
        + [sum(v["pnl"] for v in a) / 1e18],
        where="post",
        color=colors["actual"],
        alpha=0.65,
        lw=1,
        label=names["actual"],
    )
    axes[1].axhline(0, color="#aaa", lw=0.7)
    axes[1].set_ylabel("Cumulative net ETH\n(costs included)")
    axes[1].legend(loc="best", fontsize=9)
    width = 3 * HOUR
    bins = list(range(end - 2 * DAY, end, width))
    for j, k in enumerate(("market_plus2", "continuous")):
        rows = close_cash(r["runs"][k])
        vals = [
            sum(v["pnl"] for v in rows if lo <= v["at"] < lo + width) / 1e18
            for lo in bins
        ]
        axes[2].bar(
            [dt(lo + (j + 0.5) * width / 2) for lo in bins],
            vals,
            width=width / 2 / DAY * 0.86,
            color=colors[k],
            label=names[k],
            alpha=0.85,
        )
    axes[2].axhline(0, color="#555", lw=0.7)
    axes[2].set_ylabel("Net ETH per 3 hours")
    axes[2].legend(fontsize=9)
    bands = [
        ("venue", "Market"),
        ("drawdown", "Drawdown"),
        ("stopped", "Operator"),
        ("broken", "Broken"),
        ("gate", "Touch"),
    ]
    for i, (kind, label) in enumerate(bands):
        for h in chart["recordedStates"]:
            lo, hi = max(start, h["from"]), min(end, h["to"])
            if kind in h["kinds"] and hi > lo:
                axes[3].barh(
                    i,
                    (hi - lo) / DAY,
                    left=md.date2num(dt(lo)),
                    height=0.65,
                    color="#65758b",
                )
    axes[3].set_yticks(range(len(bands)), [label for _, label in bands])
    axes[3].set_ylabel("Actual pauses")
    for ax in axes:
        ax.grid(axis="y", alpha=0.16)
        ax.spines[["top", "right"]].set_visible(False)
        ax.set_xlim(dt(start), dt(end))
    axes[-1].xaxis.set_major_locator(md.HourLocator(interval=6, tz=timezone.utc))
    axes[-1].xaxis.set_major_formatter(
        md.DateFormatter("%d Sep\n%H:%M", tz=timezone.utc)
    )
    axes[-1].set_xlabel("UTC")
    fig.text(
        0.07,
        0.015,
        "Diagnostic simulation. TP and filters unchanged. Continuous trading assumes sufficient funding; it is not a live recommendation.",
        fontsize=10,
    )
    fig.tight_layout(rect=(0, 0.03, 1, 0.947))
    fig.savefig(out / "guard-comparison.png", dpi=170)
    fig.savefig(out / "guard-comparison.svg")
    plt.close(fig)
    cycle_plot(r, out)
    passage_plot(r, out)
    report(r, out)


def cycle_plot(r, out):
    import matplotlib.pyplot as plt
    import numpy as np

    rows = [e for e in r["cycles"] if not e["partial_pause"]]
    labels = [
        datetime.fromtimestamp(e["reopen"] / 1000, timezone.utc).strftime(
            "%d Sep %H:%M"
        )
        + "  "
        + e["kind"].replace("_", " ")
        for e in rows
    ]
    y = np.arange(len(rows))
    fig, ax = plt.subplots(figsize=(13, 7))
    for offset, field, color, label in [
        (-0.18, "before", "#8542a0", "During pause: continuous trading (simulated)"),
        (0.18, "actual", "#505b67", "After reopening: actual account"),
    ]:
        values = [
            int(
                e["before"]["continuous"]["net_wei"]
                if field == "before"
                else e["actual_after"]["net_wei"]
            )
            / 1e18
            for e in rows
        ]
        ax.barh(y + offset, values, height=0.32, color=color, label=label)
        for yy, v in zip(y + offset, values):
            ax.text(
                v + (0.001 if v >= 0 else -0.001),
                yy,
                f"{v:+.4f}",
                ha="left" if v >= 0 else "right",
                va="center",
                fontsize=9,
            )
    ax.set_yticks(y, labels)
    ax.invert_yaxis()
    ax.axvline(0, color="#777", lw=0.8)
    ax.set_xlabel(
        "Net ETH including costs; each interval ends at the next stop or reopening"
    )
    ax.set_title(
        "Profit was missed in some pauses, but staying on also incurred losses",
        loc="left",
        weight="bold",
        pad=45,
    )
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1.01), frameon=False, fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="x", alpha=0.15)
    ax.margins(x=0.18)
    fig.text(
        0.03,
        0.012,
        "Rows are labeled by reopening time (UTC). Intervals have different durations. The pause crossing the 48-hour boundary is excluded.",
        fontsize=9,
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out / "recovery-cycles.png", dpi=170)
    plt.close(fig)


def passage_plot(r, out):
    import matplotlib.pyplot as plt
    import numpy as np

    rows = r["passages"]
    y = np.arange(len(rows))
    fig, ax = plt.subplots(figsize=(13, max(6, len(rows) * 0.48)))
    for offset, key, color, label in [
        (-0.18, "rise", "#8542a0", "Entries while score travels from -1 to +2"),
        (0.18, "after", "#dc851c", "Entries after +2, until next -1 or data gap"),
    ]:
        values = [int(e[key]["continuous"]["net_wei"]) / 1e18 for e in rows]
        ax.barh(y + offset, values, height=0.32, color=color, label=label)
        for yy, v in zip(y + offset, values):
            ax.text(
                v + (0.001 if v >= 0 else -0.001),
                yy,
                f"{v:+.4f}",
                ha="left" if v >= 0 else "right",
                va="center",
                fontsize=9,
            )
    labels = [
        datetime.fromtimestamp(e["crossed_ms"] / 1000, timezone.utc).strftime(
            "%d Sep %H:%M"
        )
        + (" *" if not e["fall_complete"] else "")
        for e in rows
    ]
    ax.set_yticks(y, labels)
    ax.invert_yaxis()
    ax.axvline(0, color="#888", lw=0.8)
    ax.set_xlabel("Net ETH from continuous-trading simulation, including costs")
    ax.set_ylabel("Time score first exceeds +2 (UTC)")
    ax.set_title(
        "Test the rise itself, then the period after +2",
        loc="left",
        weight="bold",
        pad=45,
    )
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1.01), frameon=False, fontsize=9)
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="x", alpha=0.15)
    ax.margins(x=0.17)
    fig.text(
        0.03,
        0.01,
        "Each rise starts at the last recorded score <= -1 before > +2. Descriptive hindsight segments, not a tested entry signal. * Following drop is incomplete.",
        fontsize=9,
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out / "score-passages.png", dpi=170)
    plt.close(fig)


def report(r, out):
    def eth(v):
        return f"{int(v)/1e18:+.5f}"

    def stat(s):
        return (
            " / ".join(
                "n/a" if s[k] is None else f"{s[k]:.5f}"
                for k in ("mean", "median", "sd")
            )
            + f" / {s['n']}"
        )

    lines = [
        "The comparison isolates guarding while keeping TP and filters unchanged. All simulated cash remains diagnostic.",
        "",
        f"Capture: {iso(r['captured_at'])}. Common replay starts from actual account state at {iso(r['start'])}.",
        "",
        "![Guard score, cumulative cash, three-hour returns and actual pauses](guard-comparison.png)",
        "",
        "![Cash during pauses and after actual reopening](recovery-cycles.png)",
        "",
        "![Continuous returns during score rises and after crossing +2](score-passages.png)",
        "",
        "| Policy | Winning profit ETH | Losing loss ETH | Net ETH | Cumulative DD ETH | Attempts | Complete |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for k, run in [("actual", None), *r["runs"].items()]:
        s = (
            cash_metrics(
                [v for v in r["actual"] if r["start"] <= v["at"] < r["captured_at"]]
            )
            if run is None
            else cash_metrics(close_cash(run))
        )
        lines.append(
            f"| {k} | {eth(s['profit_wei'])} | {eth(s['loss_wei'])} | {eth(s['net_wei'])} | {eth(s['drawdown_wei'])} | {s['n']} | {run['complete'] if run else True} |"
        )
    lines += [
        "",
        "**What happened while paused, then after reopening**",
        "",
        "These are entry cohorts. Cash includes the eventual close of each known trade. The first pause is clipped at the 48-hour boundary. Scores are reconstructed at interval boundaries; they can differ from the recorded line.",
        "",
        "| Pause UTC | Reopen UTC | Cause | Continuous cash while paused | Continuous cash after reopening | Actual cash after reopening | New score outcomes, net | Old losses removed | Old profits removed |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for e in r["cycles"]:
        m = e["movement"]
        lines.append(
            f"| {iso(e['pause_from'])} | {iso(e['reopen'])} | {e['kind']} | {eth(e['before']['continuous']['net_wei'])} | {eth(e['after']['continuous']['net_wei'])} | {eth(e['actual_after']['net_wei'])} | {m['added_profit']+m['added_losses']:+.3f} | {m['removed_losses']:+.3f} | {m['removed_profit']:+.3f} |"
        )
    lines += [
        "",
        "**The passages from -1 to +2**",
        "",
        "Each rise starts at the last recorded score at or below -1 before the first reading above +2. Stale readings break a passage. These segments are selected in hindsight and are not a causal trading rule.",
        "",
        "| Rise starts UTC | Above +2 UTC | Continuous rise ETH | Following period ETH | Following fall complete | Actual halts at +2 |",
        "| --- | --- | ---: | ---: | --- | --- |",
    ]
    for e in r["passages"]:
        lines.append(
            f"| {iso(e['from_ms'])} | {iso(e['crossed_ms'])} | {eth(e['rise']['continuous']['net_wei'])} | {eth(e['after']['continuous']['net_wei'])} | {e['fall_complete']} | {', '.join(e['halts_at_crossing']) or 'none'} |"
        )
    lines += [
        "",
        "| Execution scenario | Profitable rises / all | Losing following periods / completed | Rise cash mean / median / sd / n ETH |",
        "| --- | --- | --- | --- |",
    ]
    for name, rows in r["passage_sensitivity"].items():
        values = [int(e["rise"]["continuous"]["net_wei"]) / 1e18 for e in rows]
        completed = [e for e in rows if e["fall_complete"]]
        lines.append(
            f"| {name} | {sum(v>0 for v in values)} / {len(values)} | {sum(int(e['after']['continuous']['net_wei'])<0 for e in completed)} / {len(completed)} | {stat(describe(values))} |"
        )
    lines += [
        "",
        "**Execution-delay sensitivity**",
        "",
        "| Scenario | Guard on net ETH | Market off net ETH | Continuous net ETH | All complete |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for k, g in r["stress"].items():
        lines.append(
            "| "
            + k
            + " | "
            + " | ".join(
                eth(g[v]["metrics"]["pnl_wei"])
                for v in ("market_plus2", "market_off", "continuous")
            )
            + f" | {all(v['complete'] for v in g.values())} |"
        )
    lines += [
        "",
        "**Required time bins**",
        "",
        "Every statistics cell is mean / median / sample standard deviation / count in ETH. Older bins outside the common simulation window remain unavailable.",
        "",
        "| Window UTC | Actual ETH | Guard on ETH | Continuous ETH | Continuous cash statistics |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for prefix, n in [("24h", 8), ("7d", 7)]:
        for i in range(1, n + 1):
            w = r["windows"][f"{prefix}_{i}"]
            a = w["scenarios"]["market_plus2"]
            b = w["scenarios"]["continuous"]
            lines.append(
                f"| {iso(w['from_ms'])} to {iso(w['to_ms'])} | {eth(w['actual']['net_wei']) if w['to_ms']>w['from_ms'] else 'unavailable'} | {eth(a['cash']['net_wei']) if a['available'] else 'unavailable'} | {eth(b['cash']['net_wei']) if b['available'] else 'unavailable'} | {stat(b['cash']['cash_eth']) if b['available'] else 'unavailable'} |"
            )
    lines += [
        "",
        "**Capital and evidence limits**",
        "",
        "Minimum modeled starting funding, before an extra gas reserve: "
        + ", ".join(f"{k}: {eth(v)} ETH" for k, v in r["funding_required_wei"].items())
        + ".",
        "",
    ]
    lines += ["- " + v for v in r["assumptions"]]
    lines += [
        "",
        "Full cash events, differences, episodes, coverage and input hashes are in [comparison.json](comparison.json).",
        "",
    ]
    (out / "report.md").write_text("\n".join(lines))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "previous", "tail", "out"):
        p.add_argument("--" + name, required=True, type=Path)
    a = p.parse_args()
    r = run(a.root, a.previous, a.tail, a.out)
    print(json.dumps({k: v["metrics"] for k, v in r["runs"].items()}, indent=2))
