"""Causal research signals and optional account guard. No production imports or writes."""

from __future__ import annotations

import bisect
from dataclasses import asdict, dataclass
import math

from .data import HOUR


@dataclass(frozen=True)
class SignalRule:
    name: str
    source: str = "matched"
    window: int = 20
    smooth: bool = False
    off: float = -0.05
    on: float = 0.10
    half_life: float = 6
    direction: str = "none"
    staged: bool = False
    budget: bool = False
    delay_ms: int = 0


def candidates():
    return [
        SignalRule("native20_control", source="native"),
        SignalRule("native10", source="native", window=10),
        SignalRule("native40", source="native", window=40),
        SignalRule("matched20"),
        SignalRule("fixed_cost20", source="fixed_net"),
        SignalRule("fixed_shadow20", source="fixed_matched"),
        SignalRule("matched20_zero", off=0, on=0),
        SignalRule("native_ewma", source="native", smooth=True),
        SignalRule("matched_ewma", smooth=True),
        SignalRule("recent_profit", smooth=True, off=0, on=0),
        SignalRule("direction_entry", smooth=True, off=0, on=0, direction="entry"),
        SignalRule("direction_retreat", smooth=True, off=0, on=0, direction="both"),
        SignalRule("staged", smooth=True, off=0, on=0, staged=True),
        SignalRule("staged_budget", smooth=True, off=0, on=0, staged=True, budget=True),
    ]


class SignalTape:
    def __init__(self, records):
        self.records = sorted(records, key=lambda r: (r["available"], r["token"]))
        if len({r["token"] for r in self.records}) != len(self.records):
            raise ValueError("duplicate signal outcomes")
        if any(
            not math.isfinite(r["value"]) or r["available"] <= r["launched"]
            for r in self.records
        ):
            raise ValueError("invalid signal value or availability clock")
        self.times = [r["available"] for r in self.records]
        self.launch_order = sorted(self.records, key=lambda r: r["launched"])
        self.launch_times = [r["launched"] for r in self.launch_order]
        self.visible_order = []
        self.visible_n = 0
        self.cache = {}

    def estimate(self, at, rule):
        clock = at - rule.delay_ms
        key = (at, rule.delay_ms, rule.window, rule.smooth, rule.half_life)
        if key in self.cache:
            return self.cache[key]
        # Availability is already max(close, recorded publication) + 1 ms.
        n = bisect.bisect_right(self.times, clock)
        if rule.smooth:
            lo = bisect.bisect_left(self.launch_times, at - 3 * HOUR)
            hi = bisect.bisect_left(self.launch_times, clock)
            rows = sorted(
                (r for r in self.launch_order[lo:hi] if r["available"] <= clock),
                key=lambda r: (r.get("block", r["launched"]), r["token"]),
                reverse=True,
            )[:200]
        else:
            if n < self.visible_n:
                self.visible_order = []
                self.visible_n = 0
            for r in self.records[self.visible_n:n]:
                bisect.insort(self.visible_order, (r.get("block", r["launched"]), r["token"], r))
            self.visible_n = n
            rows = [item[2] for item in reversed(self.visible_order[-rule.window:])]
        latest = max(rows, key=lambda r: (r["available"], r["token"])) if rows else None
        # A late backfill outside this estimate cannot authorize a fresh recovery.
        newest_evidence = latest["token"] if latest else None
        ages = [(at - r["launched"]) / 60000 for r in rows]
        values = [r["value"] for r in rows]
        result = dict(
            value=None,
            slow=None,
            direction=None,
            n=len(rows),
            effective_n=0,
            newest_age_min=min(ages) if ages else None,
            oldest_age_min=max(ages) if ages else None,
            publication_age_min=(
                (at - latest["available"]) / 60000 if latest else None
            ),
            fresh=False,
            newest_evidence=newest_evidence,
        )
        if rows:
            if rule.smooth:

                def weighted(half, minutes):
                    weights = [
                        2 ** (-i / half - age / minutes) for i, age in enumerate(ages)
                    ]
                    sw = sum(weights)
                    return sum(
                        w * v for w, v in zip(weights, values)
                    ) / sw, sw * sw / sum(w * w for w in weights)

                value, effective = weighted(rule.half_life, 30)
                slow, _ = weighted(20, 90)
                fresh = len(rows) >= 6 and effective >= 4 and min(ages) <= 30
            else:
                value = sum(values) / len(values)
                slow = value
                effective = len(values)
                fresh = len(rows) == rule.window and max(ages) <= 180
            result.update(
                value=value,
                slow=slow,
                direction=value - slow,
                effective_n=effective,
                fresh=fresh,
            )
        self.cache[key] = result
        return result


class IndicatorGuard:
    """Drop-in research guard; all other account stops retain their own authority."""

    def __init__(self, tape, rule, normal_size, halted=True):
        self.tape, self.rule, self.normal_size = tape, rule, normal_size
        self.times = [t + rule.delay_ms for t in tape.times]
        self.allowed = not halted
        self.stage = self.stage_n = self.stage_cash = 0
        self.probe_loss = 0
        self.reservations = {}
        self.last_evidence = None
        self.last_at = None
        self.last = {}
        self.generation = 0

    def read(self, at):
        if self.last_at == at:
            return self.last
        s = dict(self.tape.estimate(at, self.rule))
        before = self.allowed
        new = s["newest_evidence"] != self.last_evidence
        if not s["fresh"]:
            self.allowed = False
        elif s["value"] < self.rule.off or (
            self.rule.off == self.rule.on == 0 and s["value"] <= 0
        ):
            self.allowed = False
        elif s["value"] > self.rule.on and (before or new):
            self.allowed = True
        if self.rule.direction != "none" and s["fresh"]:
            if s["direction"] < 0 and (not before or self.rule.direction == "both"):
                self.allowed = False
        if self.rule.budget and self.probe_loss >= self.normal_size:
            self.allowed = False
        if before and not self.allowed:
            self.stage = self.stage_n = self.stage_cash = 0
            self.generation += 1
        self.last_evidence = s["newest_evidence"]
        self.last_at = at
        self.last = dict(
            s, allow=self.allowed, stage=self.stage, probe_loss_wei=str(self.probe_loss)
        )
        return self.last

    def entry(self, at, trade, active):
        reading = self.read(at)
        size = self.normal_size
        if not reading["allow"]:
            return size, "venue"
        if self.rule.staged and self.stage < 2:
            size = self.normal_size // (4 if self.stage == 0 else 2)
            if active:
                return size, "signal_probe_capacity"
            if self.rule.budget:
                reserve = size + int(trade.get("gas_reserve_wei", 0))
                if (
                    self.probe_loss + sum(self.reservations.values()) + reserve
                    > self.normal_size
                ):
                    return size, "signal_probe_budget"
        return size, None

    def entered(self, trade):
        probe = self.rule.staged and self.stage < 2
        trade["signal_probe"] = probe
        trade["signal_generation"] = self.generation
        if probe:
            self.reservations[trade["id"]] = trade["size"] + int(
                trade.get("gas_reserve_wei", 0)
            )

    def closed(self, trade):
        if not trade.get("signal_probe"):
            return
        self.reservations.pop(trade["id"], None)
        self.probe_loss += max(0, -trade["pnl"])
        # A late close from a previous recovery cannot promote a new recovery.
        if trade.get("signal_generation") == self.generation:
            self.stage_n += 1
            self.stage_cash += trade["pnl"]
            if self.stage_n >= 3 and self.stage_cash > 0:
                self.stage = min(2, self.stage + 1)
                self.stage_n = self.stage_cash = 0
        self.last_at = None

    def definition(self):
        return asdict(self.rule)
