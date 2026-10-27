"""Previous-era guard-only test of correlation-capped positive recovery evidence.

The baseline is the era's fixed-1.75, trailing-20 market guard: pause below -1 and
reopen above +2. The candidate leaves the raw pause unchanged. While shut, it groups
the same trailing 20 launches when they arrive within 60 seconds and share a deployer,
name/symbol, or exact entry template. Negative outcomes retain their full sum. Positive
outcomes contribute at most +1 stake per connected cluster.

This is an opportunity replay, not wallet accounting. It holds the frozen 0.02 ETH
execution model fixed across historical market periods and does not model capacity,
cash drawdown, operator controls, or fills that the frozen opportunity model lacks.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

HOUR = 3_600_000
DAY = 24 * HOUR
CLUSTER_MS = 60_000
WINDOW = 20
FRESH_MS = 3 * HOUR
PAUSE_BELOW = -1.0
REOPEN_ABOVE = 2.0


@dataclass(frozen=True)
class Signal:
    token: str
    block: int
    launched: int
    available: int
    value: float
    deployer: str
    label: str
    template: str


@dataclass(frozen=True)
class Trade:
    token: str
    entry: int
    exit: int
    pnl: int
    size: int


ERAS = (
    ("older_0.02", 1_788_732_360_262, 1_788_783_965_627),
    ("intervening_0.01", 1_788_783_965_627, 1_788_789_327_189),
    ("later_0.02", 1_788_789_327_189, 1_788_905_393_024),
)


def load_json(path: Path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt") as handle:
        return json.load(handle)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def normalize(value):
    return " ".join(str(value or "").lower().split())


def build_signals(raw):
    facts = {row["token"].lower(): row for row in raw["bot_launches"]}
    result = []
    for row in raw["gate_obs"]:
        token = row["token"].lower()
        fact = facts.get(token)
        if fact is None or row.get("error") or not row.get("launched_at"):
            continue
        if (fact.get("creator_tax_bps") or 0) < 50 or (fact.get("exemptions") or 0) < 3:
            continue
        try:
            bars = json.loads(row["bars"]) if isinstance(row.get("bars"), str) else row.get("bars") or {}
        except (TypeError, ValueError):
            continue
        value = bars.get("1.75", bars.get("1.750"))
        if not finite(value):
            continue
        name = normalize(fact.get("name"))
        symbol = normalize(fact.get("symbol"))
        label = f"{name}|{symbol}" if name or symbol else ""
        template = f'{fact.get("creator_tax_bps")}:{fact.get("dev_buy_wei")}:{fact.get("exemptions")}'
        result.append(
            Signal(
                token=token,
                block=int(row["block"]),
                launched=int(row["launched_at"]) * 1000,
                available=int(row["at"]),
                value=float(value),
                deployer=normalize(fact.get("deployer")),
                label=label,
                template=template,
            )
        )
    return sorted(result, key=lambda row: (row.available, row.token))


def build_trades(details):
    rows = []
    for row in details["results"]:
        if row.get("status") not in ("closed", "buy_reverted"):
            continue
        if row.get("pnlWei") is None or row.get("entryAt") is None or row.get("exitAt") is None:
            continue
        rows.append(
            Trade(
                token=row["token"].lower(),
                entry=int(row["entryAt"]),
                exit=int(row["exitAt"]),
                pnl=int(row["pnlWei"]),
                size=int(row.get("spent") or 20_000_000_000_000_000),
            )
        )
    return sorted(rows, key=lambda row: (row.entry, row.token))


def related(a: Signal, b: Signal):
    if abs(a.launched - b.launched) > CLUSTER_MS:
        return False
    return bool(
        (a.deployer and a.deployer == b.deployer)
        or (a.label and a.label == b.label)
        or (a.template and a.template == b.template)
    )


def clusters(rows):
    parent = list(range(len(rows)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i, row in enumerate(rows):
        for j in range(i - 1, -1, -1):
            if row.launched - rows[j].launched > CLUSTER_MS:
                break
            if related(row, rows[j]):
                join(i, j)
    grouped = defaultdict(list)
    for i, row in enumerate(rows):
        grouped[find(i)].append(row)
    return list(grouped.values())


def bounded_recovery_score(rows):
    total = 0.0
    for group in clusters(sorted(rows, key=lambda row: (row.launched, row.token))):
        negative = sum(min(0.0, row.value) for row in group)
        positive = sum(max(0.0, row.value) for row in group)
        total += negative + min(1.0, positive)
    return total


def replay(signals, candidate=False):
    visible = []
    spans = []
    readings = []
    allowed = True

    def note(at, reason):
        if not spans or spans[-1]["open"] != allowed:
            spans.append({"at": at, "open": allowed, "reason": reason})

    i = 0
    while i < len(signals):
        at = signals[i].available
        while i < len(signals) and signals[i].available == at:
            visible.append(signals[i])
            i += 1
        chosen = sorted(visible, key=lambda row: (row.block, row.token), reverse=True)[:WINDOW]
        raw = sum(row.value for row in chosen)
        fresh = len(chosen) == WINDOW and at - chosen[-1].launched <= FRESH_MS
        recovery = bounded_recovery_score(chosen) if candidate and chosen else raw
        before = allowed
        if not fresh:
            allowed = True  # the previous era's stale=open behavior
        elif allowed and raw < PAUSE_BELOW:
            allowed = False
        elif not allowed and recovery > REOPEN_ABOVE:
            allowed = True
        reason = (
            f"raw {raw:.3f}, recovery {recovery:.3f}, fresh {fresh}, "
            f"{'candidate' if candidate else 'baseline'}"
        )
        if before != allowed:
            note(at, reason)
        readings.append(
            {
                "at": at,
                "raw": raw,
                "recovery": recovery,
                "fresh": fresh,
                "open": allowed,
                "n": len(chosen),
                "clusters": len(clusters(sorted(chosen, key=lambda row: (row.launched, row.token)))),
            }
        )
    return {"spans": spans, "readings": readings}


def open_at(spans, at):
    state = True
    for row in spans:
        if row["at"] > at:
            break
        state = row["open"]
    return state


def describe(values):
    values = list(values)
    if not values:
        return {"mean": None, "median": None, "sd": None, "n": 0, "sum": 0}
    return {
        "mean": statistics.mean(values),
        "median": statistics.median(values),
        "sd": statistics.stdev(values) if len(values) > 1 else 0.0,
        "n": len(values),
        "sum": sum(values),
    }


def metrics(trades, spans, start, end):
    taken = [row for row in trades if start <= row.entry < end and open_at(spans, row.entry)]
    closed = sorted(taken, key=lambda row: (row.exit, row.token))
    total = peak = drawdown = 0
    for row in closed:
        total += row.pnl
        peak = max(peak, total)
        drawdown = max(drawdown, peak - total)
    returns = [100 * row.pnl / row.size for row in taken if row.size > 0]
    return {
        "trades": len(taken),
        "wins": sum(row.pnl > 0 for row in taken),
        "losses": sum(row.pnl < 0 for row in taken),
        "pnlWei": str(total),
        "pnlEth": total / 1e18,
        "drawdownEth": drawdown / 1e18,
        "returnsPct": describe(returns),
        "tokens": [row.token for row in taken],
    }


def false_opens(trades, replayed, start, end):
    spans = replayed["spans"]
    result = []
    for i, span in enumerate(spans):
        if not span["open"] or not start <= span["at"] < end:
            continue
        stop = next((row["at"] for row in spans[i + 1 :] if not row["open"]), end)
        selected = [row for row in trades if span["at"] < row.entry < min(stop, end)]
        pnl = sum(row.pnl for row in selected)
        if selected and pnl < 0:
            result.append(
                {
                    "at": span["at"],
                    "until": min(stop, end),
                    "trades": len(selected),
                    "pnlEth": pnl / 1e18,
                }
            )
    return result


def compare(base, candidate):
    a, b = set(base["tokens"]), set(candidate["tokens"])
    return {
        "avoided": len(a - b),
        "added": len(b - a),
        "common": len(a & b),
        "pnlDeltaEth": candidate["pnlEth"] - base["pnlEth"],
        "drawdownDeltaEth": candidate["drawdownEth"] - base["drawdownEth"],
    }


def bins(trades, spans, start, end, count):
    width = (end - start) / count
    result = []
    for i in range(count):
        lo, hi = round(start + i * width), round(start + (i + 1) * width)
        row = metrics(trades, spans, lo, hi)
        result.append({"from": lo, "to": hi, "pnlEth": row["pnlEth"], "trades": row["trades"]})
    return result


def iso(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def run(source, execution):
    raw = load_json(source)
    details = load_json(execution)
    signals = build_signals(raw)
    trades = build_trades(details)
    baseline = replay(signals, False)
    candidate = replay(signals, True)
    output = {
        "methodology": {
            "source": str(source),
            "execution": str(execution),
            "snapshotAt": raw["snapshot_at"],
            "signals": len(signals),
            "trades": len(trades),
            "baseline": "fixed 1.75, trailing 20, pause below -1, reopen above +2, stale=open",
            "candidate": "same pause; while shut cap positive correlated-cluster contribution at +1",
            "clusterProxy": "within 60s and same deployer, normalized name/symbol, or exact tax/dev-buy/exemption template",
            "limits": [
                "historical snapshots do not carry creator-fee-recipient addresses",
                "0.02 ETH opportunity execution model is held fixed across market eras",
                "guard-only replay omits capacity, cash drawdown, operator controls and receipt-backed wallet accounting",
            ],
        },
        "eras": {},
    }
    for name, start, end in ERAS:
        end = min(end, raw["snapshot_at"])
        if end <= start:
            continue
        base = metrics(trades, baseline["spans"], start, end)
        cand = metrics(trades, candidate["spans"], start, end)
        base_false = false_opens(trades, baseline, start, end)
        cand_false = false_opens(trades, candidate, start, end)
        output["eras"][name] = {
            "from": iso(start),
            "to": iso(end),
            "hours": (end - start) / HOUR,
            "baseline": {**base, "falseOpens": len(base_false), "falseOpenLossEth": sum(x["pnlEth"] for x in base_false)},
            "candidate": {**cand, "falseOpens": len(cand_false), "falseOpenLossEth": sum(x["pnlEth"] for x in cand_false)},
            "difference": compare(base, cand),
            "baselineFalseOpenEpisodes": base_false,
            "candidateFalseOpenEpisodes": cand_false,
            "bins": {
                "baseline": bins(trades, baseline["spans"], start, end, 8 if end - start >= DAY else 4),
                "candidate": bins(trades, candidate["spans"], start, end, 8 if end - start >= DAY else 4),
            },
        }
        del output["eras"][name]["baseline"]["tokens"]
        del output["eras"][name]["candidate"]["tokens"]
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("data/research/objects/744c80b44a930178cc87ffe2893ffe178cfc41f46aa6501b3cd9cf74b344c467.json.gz"),
    )
    parser.add_argument(
        "--execution",
        type=Path,
        default=Path("data/research/20260909-guard-engine-final-v12/opportunity-execution.json"),
    )
    args = parser.parse_args()
    print(json.dumps(run(args.source, args.execution), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
