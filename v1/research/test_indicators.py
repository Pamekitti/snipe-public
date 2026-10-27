"""Availability, staging, accounting and fixed-design inference checks."""

import sys
from dataclasses import replace
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research.core.indicators import SignalTape, SignalRule, IndicatorGuard
from research.core.account import simulate, Observation
from research.core.policies import Policy
from research.core.indicator_study import (
    make_tapes,
    forward_cohorts,
    qualifies,
    configured_policy,
)


class IndicatorTests(unittest.TestCase):
    def test_captured_configuration_sets_policy_size_and_book(self):
        cfg = dict(
            venuePauseWindow=20,
            venuePauseOff=-1,
            venuePauseOn=1.5,
            venueFreshHours=3,
            maxDrawdownEth=0.06,
            tradeSizeEth=0.01,
            bankrollEth=0.08,
            ddResumeWindow=20,
            ddResumeOn=1,
        )
        p = configured_policy(
            dict(
                state=dict(
                    config=dict(values=cfg),
                    policy=dict(minCreatorTaxBps=75, minExemptionsToEnter=4),
                )
            )
        )
        self.assertEqual(
            (p.size_wei, p.on, p.min_creator_tax_bps, p.min_exemptions),
            (10**16, 1.5, 75, 4),
        )

    def tape(self, values, available=None):
        return SignalTape(
            [
                dict(
                    token=str(i),
                    launched=1000 + i,
                    available=(available[i] if available else 2000 + i),
                    value=v,
                )
                for i, v in enumerate(values)
            ]
        )

    def test_future_result_cannot_change_earlier_reading(self):
        rule = SignalRule("test", window=2)
        a = self.tape([0.1, 0.2])
        b = self.tape([0.1, 0.2, 999], available=[2000, 2001, 4000])
        self.assertEqual(a.estimate(3000, rule), b.estimate(3000, rule))

    def test_outdated_backfill_is_not_new_evidence_for_reopening(self):
        records = [
            dict(
                token=str(i),
                launched=20_000_000 + i,
                available=20_001_000 + i,
                value=0.2,
            )
            for i in range(20)
        ]
        records.append(dict(token="old", launched=1, available=20_002_000, value=100))
        tape = SignalTape(records)
        rule = SignalRule("test", smooth=True)
        before = tape.estimate(20_001_100, rule)
        after = tape.estimate(20_002_001, rule)
        self.assertEqual(before["newest_evidence"], after["newest_evidence"])

    def test_delay_moves_publication_without_backdating_age(self):
        tape = self.tape([0.1] * 20)
        rule = SignalRule("test", delay_ms=60000)
        self.assertFalse(tape.estimate(3000, rule)["fresh"])
        self.assertTrue(tape.estimate(63000, rule)["fresh"])

    def test_delayed_cache_keeps_current_evidence_age(self):
        tape = self.tape([0.1] * 20)
        rule = SignalRule("test", smooth=True)
        tape.estimate(30 * 60000, rule)
        delayed = tape.estimate(31 * 60000, replace(rule, delay_ms=60000))
        self.assertFalse(delayed["fresh"])

    def test_open_shadow_entry_cost_is_not_a_completed_outcome(self):
        token = "x"
        raw = {"bot_launches": [dict(token=token, launched_at=1, block=1)]}
        models = {"tokens": {token: dict(entry=1000, size=100, tp=1.75)}}
        shadow = dict(
            decisions=[dict(id=token, at=1000, reason=None)],
            cash=[dict(id=token, at=1000, pnl=-2)],
            open_ids=[token],
        )
        tapes, missing = make_tapes(raw, models, shadow, [])
        self.assertEqual(len(tapes["matched"].records), 0)
        self.assertEqual(missing[0]["reason"], "unclosed")

    def test_expired_loss_can_raise_rolling_sum_despite_new_loss(self):
        tape = self.tape([-0.8, 0.3, -0.1])
        rule = SignalRule("test", window=2)
        self.assertAlmostEqual(
            tape.estimate(2002, rule)["value"] - tape.estimate(2001, rule)["value"],
            0.35,
        )

    def test_exponential_requires_effective_sample_and_fresh_launch(self):
        rule = SignalRule("test", smooth=True)
        self.assertFalse(self.tape([1] * 5).estimate(3000, rule)["fresh"])
        self.assertTrue(self.tape([1] * 20).estimate(3000, rule)["fresh"])
        self.assertFalse(self.tape([1] * 20).estimate(31 * 60000, rule)["fresh"])

    def test_new_scores_get_more_weight(self):
        s = self.tape([-0.1] * 19 + [0.9]).estimate(
            3000, SignalRule("test", smooth=True)
        )
        self.assertGreater(s["value"], -0.05)

    def test_same_positive_profit_can_stay_active_without_acceleration(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, direction="entry"),
            100,
        )
        self.assertTrue(g.read(3000)["allow"])
        self.assertTrue(g.read(4000)["allow"])

    def test_stale_data_blocks_candidate(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20), SignalRule("test", smooth=True, on=0, off=0), 100
        )
        self.assertTrue(g.read(3000)["allow"])
        self.assertFalse(g.read(31 * 60000)["allow"])

    def test_probe_budget_counts_gross_losses_and_reserves_costs(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, staged=True, budget=True),
            100,
        )
        t = dict(id="x", size=25, pnl=-25, gas_reserve_wei=2)
        self.assertEqual(g.entry(3000, t, {}), (25, None))
        g.entered(t)
        g.closed(t)
        self.assertEqual(g.probe_loss, 25)
        t2 = dict(id="y", size=25, pnl=50, gas_reserve_wei=2)
        g.entered(t2)
        g.closed(t2)
        self.assertEqual(g.probe_loss, 25)
        g.probe_loss = 75
        self.assertEqual(g.entry(3001, t2, {})[1], "signal_probe_budget")

    def test_market_restart_does_not_refill_budget(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, staged=True, budget=True),
            100,
        )
        g.read(3000)
        g.probe_loss = 50
        g.stage = 1
        g.read(31 * 60000)
        self.assertEqual(g.stage, 0)
        self.assertEqual(g.probe_loss, 50)

    def test_staging_needs_three_closed_trades_with_positive_net(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, staged=True),
            100,
        )
        g.read(3000)
        for i, pnl in enumerate([-5, 2, 4]):
            t = dict(id=str(i), size=25, pnl=pnl)
            g.entered(t)
            g.closed(t)
        self.assertEqual(g.stage, 1)

    def test_old_generation_close_cannot_promote_new_probe(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, staged=True),
            100,
        )
        g.read(3000)
        t = dict(id="x", size=25, pnl=50)
        g.entered(t)
        g.read(31 * 60000)
        g.closed(t)
        self.assertEqual(g.stage_n, 0)

    def test_custom_guard_cannot_override_manual_stop(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20), SignalRule("test", smooth=True, on=0, off=0), 100
        )
        t = dict(id="x", token="x", entry=3001, exit=4000, size=100, pnl=10)
        r = simulate(
            [],
            [t],
            Policy(touch_enabled=False),
            3000,
            5000,
            initial={"halts": ["manual"]},
            guard=g,
        )
        self.assertEqual(r["decisions"][0]["reason"], "manual")

    def test_signal_publication_does_not_accelerate_drawdown_recovery(self):
        start = 3000
        tape = self.tape([0.2] * 20, available=[4001 + i for i in range(20)])
        guard = IndicatorGuard(tape, SignalRule("test", smooth=True, on=0, off=0), 100)
        obs = [Observation(str(i), i, 3500, 4000, {"1.75": 2}) for i in range(2)]
        t = dict(id="x", token="x", entry=5000, exit=6000, size=100, pnl=10)
        p = Policy(window=2, recovery_window=2, touch_enabled=False)
        r = simulate(
            obs,
            [t],
            p,
            start,
            40000,
            initial={"halts": ["drawdown"], "halt_at": start},
            guard=guard,
        )
        self.assertEqual(r["decisions"][0]["reason"], "drawdown")
        self.assertTrue(
            all(a["at"] >= 33000 for a in r["actions"] if a["action"] == "dd_resume")
        )

    def test_missing_smaller_replay_stops_account(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, staged=True),
            100,
        )
        t = dict(id="x", token="x", entry=3001, exit=4000, size=100, pnl=10)
        r = simulate([], [t], Policy(touch_enabled=False), 3000, 5000, guard=g)
        self.assertEqual(r["unresolved"][0]["reason"], "missing_size_replay")

    def test_smaller_replay_is_used_instead_of_scaling(self):
        g = IndicatorGuard(
            self.tape([0.2] * 20),
            SignalRule("test", smooth=True, on=0, off=0, staged=True),
            100,
        )
        t = dict(
            id="x",
            token="x",
            entry=3001,
            exit=4000,
            size=100,
            pnl=10,
            variants={"25": dict(size=25, pnl=-7)},
        )
        r = simulate([], [t], Policy(touch_enabled=False), 3000, 5000, guard=g)
        self.assertEqual(r["metrics"]["pnl_wei"], "-7")
        self.assertEqual(r["decisions"][0]["size"], 25)

    def test_default_engine_remains_same_without_callback(self):
        t = dict(id="x", token="x", entry=3001, exit=4000, size=100, pnl=10)
        p = Policy(touch_enabled=False, market_enabled=False)
        self.assertEqual(
            simulate([], [t], p, 3000, 5000),
            simulate([], [t], p, 3000, 5000, guard=None),
        )

    def test_no_trade_candidate_cannot_pass(self):
        def m(n, net):
            return dict(
                cash=dict(n=n, net_wei=str(net), drawdown_wei="0"),
                complete=True,
                unclosed_entries=0,
                losing_recoveries=0,
                recovery_loss_wei="0",
            )

        self.assertFalse(qualifies(m(0, 0), m(1, -10))["passed"])


if __name__ == "__main__":
    unittest.main()
