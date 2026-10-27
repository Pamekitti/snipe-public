"""Causal launch activity. Quote amounts use different event words on each side."""

import bisect
from .data import HOUR, Worker
from .account import outcome


def activity(d):
    values = {}
    with Worker() as worker:
        topics = worker.call(op="metadata")["topics"]
    own = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
    for fact in d["launches"]:
        token = fact["token"].lower()
        if not d["path_coverage"].get(token, {}).get("all_topics"):
            continue
        logs = d["paths"].get(token, [])
        if any(l["blockNumber"] not in d["blocks"] for l in logs):
            continue
        launch = fact["launched_at"] * 1000
        # Coverage must extend beyond the complete observation interval.
        if d["snapshot_at"] < launch + 45000:
            continue
        excluded = {own, (fact.get("deployer") or "").lower().removeprefix("0x")}
        buy = sell = 0
        buyers = set()
        for l in logs:
            at = d["blocks"][l["blockNumber"]]["timestamp"] * 1000
            if not launch <= at < launch + 45000:
                continue
            parties = [x[-40:].lower() for x in l["topics"][1:3]]
            if any(x in excluded for x in parties):
                continue
            topic = l["topics"][0]
            if topic not in (topics["CurveBuy"], topics["CurveSell"]):
                continue
            word = 0 if topic == topics["CurveBuy"] else 1
            quote = int(l["data"][2 + word * 64 : 2 + (word + 1) * 64], 16) / 1e18
            if word == 0:
                buy += quote
                if parties:
                    buyers.add(parties[0])
            else:
                sell += quote
        values[token] = dict(buy=buy, sell=sell, gross=buy + sell, buyers=len(buyers))
    return values


class Features:
    def __init__(self, data, obs, activity):
        obs = [o for o in obs if o.market_eligible]
        self.obs = sorted(obs, key=lambda o: (o.scored, o.block, o.token))
        self.score_times = [o.scored for o in self.obs]
        self.activity = activity
        self.mature = sorted((max(o.scored, o.launched + 45_000), o.token) for o in obs)
        self.mature_times = [at for at, _ in self.mature]
        self.detected = sorted(
            r["detected_at"]
            for r in data["bot_launches"]
            if r.get("detected_at")
            and (r.get("creator_tax_bps") or 0) >= 50
            and (r.get("exemptions") or 0) >= 3
        )
        self.history_start = min(self.detected, default=0)

    def at(self, at):
        visible = self.obs[: bisect.bisect_left(self.score_times, at)]
        chosen = outcome(sorted(visible, key=lambda o: (-o.block, o.token))[:40], 20)
        vs = [v for _, v in chosen]
        fresh = len(chosen) == 20 and at - chosen[-1][0].launched <= 3 * HOUR

        def count(lo, hi):
            return bisect.bisect_left(self.detected, hi) - bisect.bisect_left(
                self.detected, lo
            )

        pace_recent, pace_previous = count(at - HOUR, at), count(
            at - 7 * HOUR, at - HOUR
        )

        def bucket(lo, hi):
            a, b = bisect.bisect_left(self.mature_times, lo), bisect.bisect_left(
                self.mature_times, hi
            )
            tokens = [token for _, token in self.mature[a:b]]
            rows = [self.activity[t] for t in tokens if t in self.activity]
            return rows, len(rows) / len(tokens) if tokens else 0, len(tokens)

        recent, coverage, expected = bucket(at - HOUR, at)
        previous, previous_coverage, previous_expected = bucket(
            at - 7 * HOUR, at - HOUR
        )
        volume_valid = (
            len(recent) >= 5
            and len(previous) >= 20
            and min(coverage, previous_coverage) >= 0.8
        )

        def ratio(key):
            if not volume_valid:
                return None
            before = sum(r[key] for r in previous) / len(previous)
            current = sum(r[key] for r in recent) / len(recent)
            return current / before if before > 0 else None

        flow = sum(r["buy"] - r["sell"] for r in recent) if volume_valid else None
        pace_ratio = (
            pace_recent / (pace_previous / 6)
            if pace_previous and at - self.history_start >= 7 * HOUR
            else None
        )
        return dict(
            stakes=sum(vs) if len(vs) == 20 else None,
            fresh=fresh,
            trimmed=sum(vs) - max(vs) if fresh else None,
            short=(
                sum(vs[:5])
                if len(vs) >= 5 and at - chosen[4][0].launched <= 3 * HOUR
                else None
            ),
            pace=pace_ratio,
            launch_n=pace_recent,
            prior_launch_n=pace_previous,
            turnover=ratio("gross"),
            buyers=ratio("buyers"),
            net_buy=flow,
            activity_n=len(recent),
            activity_expected=expected,
            coverage=coverage,
            previous_activity_n=len(previous),
            previous_expected=previous_expected,
            previous_coverage=previous_coverage,
            max_used_score=max((o.scored for o, _ in chosen), default=None),
        )


def accepts(rule, f):
    """None means missing evidence and falls back to the unchanged market guard."""
    if rule == "market_plus2":
        return True, False
    checks = {
        "launch_pace": ("pace", 1, False),
        "turnover_per_coin": ("turnover", 1, False),
        "buyers_per_coin": ("buyers", 1, False),
        "net_buying": ("net_buy", 0, True),
        "broad_gains": ("trimmed", 0, True),
        "recent_direction": ("short", 0, True),
    }
    if rule == "demand_and_pace":
        a, missing_a = accepts("launch_pace", f)
        b, missing_b = accepts("buyers_per_coin", f)
        return a and b, missing_a or missing_b
    key, threshold, strict = checks[rule]
    value = f.get(key)
    if value is None:
        return True, True
    return (value > threshold if strict else value >= threshold), False
