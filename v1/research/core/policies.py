"""Guard definitions. New thresholds are configurations, not new runners."""

from dataclasses import dataclass, replace, asdict


@dataclass(frozen=True)
class Policy:
    name: str = "market_plus2"
    window: int = 20
    off: float = -1
    on: float = 2
    fresh_ms: int = 10800000
    dd_wei: int = 60000000000000000
    size_wei: int = 20000000000000000
    bankroll_wei: int = 80000000000000000
    recovery_window: int = 20
    recovery_on: float = 1
    daily_lifts: int = 2
    market_updates: int = 1
    dd_updates: int = 1
    stale: str = "open"
    recovery_feature: str | None = None
    entry_feature: str | None = None
    dd_fresh: bool = False
    dd_short: bool = False
    probation: bool = False
    probe_sizes: tuple = ()
    probe_loss_wei: int = 10000000000000000
    rolling_lifts: int = 0
    rolling_dd_wei: int = 0
    max_concurrent: int = 14
    touch_enabled: bool = True
    touch_bar: float = 1.21
    touch_on: float = 25
    touch_off: float = 10
    min_creator_tax_bps: int = 0
    min_exemptions: int = 0
    template_loss_ms: int = 3600000
    market_enabled: bool = True
    account_pauses_enabled: bool = True

    def __post_init__(self):
        import math

        if not self.name or self.window < 1 or self.recovery_window < 1:
            raise ValueError("policy name and positive windows required")
        if not all(math.isfinite(x) for x in [self.off, self.on, self.recovery_on]):
            raise ValueError("finite thresholds required")
        if self.on <= self.off:
            raise ValueError("resume threshold must exceed stop threshold")
        if (
            min(
                self.size_wei,
                self.bankroll_wei,
                self.dd_wei,
                self.fresh_ms,
                self.market_updates,
                self.dd_updates,
                self.max_concurrent,
            )
            <= 0
        ):
            raise ValueError("positive risk limits required")
        if self.stale not in ["open", "hold", "any_age", "fresh_only"]:
            raise ValueError("unknown stale policy")
        if self.probe_sizes and (
            min(self.probe_sizes) <= 0
            or tuple(sorted(self.probe_sizes)) != tuple(self.probe_sizes)
        ):
            raise ValueError("probe sizes must increase")


def policies(config):
    base = Policy(
        window=config["venuePauseWindow"],
        off=config["venuePauseOff"],
        on=2,
        fresh_ms=round(config["venueFreshHours"] * 3600000),
        dd_wei=round(config["maxDrawdownEth"] * 1e18),
        size_wei=round(config["tradeSizeEth"] * 1e18),
        bankroll_wei=round(config["bankrollEth"] * 1e18),
        recovery_window=config["ddResumeWindow"],
        recovery_on=config["ddResumeOn"],
    )
    ps = [base, replace(base, name="market_plus1", on=1)]
    for mode in ["hold", "any_age", "fresh_only"]:
        ps.append(replace(base, name="stale_" + mode, stale=mode))
    for rule in [
        "launch_pace",
        "turnover_per_coin",
        "buyers_per_coin",
        "net_buying",
        "broad_gains",
        "recent_direction",
        "demand_and_pace",
    ]:
        ps.append(replace(base, name=rule, entry_feature=rule))
    ps.extend(
        [
            replace(base, name="market_three_updates", market_updates=3),
            replace(
                base, name="dd_six_updates", dd_updates=6, dd_fresh=True, dd_short=True
            ),
            replace(
                base,
                name="both_six_updates",
                market_updates=6,
                dd_updates=6,
                dd_fresh=True,
                dd_short=True,
            ),
            replace(base, name="both_plus2", recovery_on=2),
            replace(base, name="recovery_breadth", recovery_feature="broad_gains"),
            replace(
                base, name="recovery_direction", recovery_feature="recent_direction"
            ),
            replace(base, name="one_dd_lift_24h", rolling_lifts=1),
            replace(base, name="rolling_dd_006", rolling_dd_wei=60000000000000000),
            replace(base, name="rolling_dd_009", rolling_dd_wei=90000000000000000),
            replace(base, name="restart_allowance", probation=True),
            replace(
                base,
                name="quarter_probe",
                probation=True,
                probe_sizes=(5000000000000000, 10000000000000000, 20000000000000000),
                probe_loss_wei=5000000000000000,
            ),
        ]
    )
    ps.extend(
        [
            replace(
                base,
                name="both_three_updates",
                market_updates=3,
                dd_updates=3,
                dd_fresh=True,
                dd_short=True,
                stale="fresh_only",
                recovery_feature="recent_direction",
            ),
            replace(
                base,
                name="confirm_allowance",
                probation=True,
                rolling_lifts=1,
                market_updates=6,
                dd_updates=6,
                dd_fresh=True,
                dd_short=True,
                stale="fresh_only",
                recovery_feature="recent_direction",
            ),
            replace(
                base,
                name="confirm_probe",
                probation=True,
                rolling_lifts=1,
                market_updates=6,
                dd_updates=6,
                dd_fresh=True,
                dd_short=True,
                stale="fresh_only",
                recovery_feature="recent_direction",
                probe_sizes=(5000000000000000, 10000000000000000, 20000000000000000),
                probe_loss_wei=5000000000000000,
            ),
        ]
    )
    for mode in ["hold", "any_age", "fresh_only"]:
        ps.append(replace(base, name="plus1_stale_" + mode, on=1, stale=mode))
    return ps


def definitions(config):
    return [asdict(p) for p in policies(config)]


def load(config, path=None):
    if path is None:
        return policies(config)
    import json

    values = json.loads(path.read_text())
    result = [Policy(**{**asdict(policies(config)[0]), **row}) for row in values]
    if len({p.name for p in result}) != len(result):
        raise ValueError("duplicate policy names")
    return result
