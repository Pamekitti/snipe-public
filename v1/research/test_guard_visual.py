"""Guard removal preserves entry rules and missing execution evidence."""

import sys
from pathlib import Path
import unittest
from dataclasses import replace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research.core.account import simulate, Observation
from research.core.policies import Policy
from research.core.guard_visual import (
    difference,
    selected_cash,
    close_cash,
    flat_boundary,
    score_passages,
)


class GuardVisualTests(unittest.TestCase):
    def setUp(self):
        self.start = 1_000_000
        self.p = Policy(
            window=2,
            recovery_window=2,
            size_wei=100,
            bankroll_wei=200,
            dd_wei=60,
            touch_enabled=False,
        )
        self.obs = [
            Observation(str(i), i, self.start - 1000, self.start - 1, {"1.75": -1})
            for i in range(2)
        ]

    def trade(self, i, at, pnl=-70, **kw):
        return dict(
            id=str(i), token=str(i), entry=at, exit=at + 1000, pnl=pnl, size=100, **kw
        )

    def test_market_off_keeps_drawdown_stop(self):
        trades = [self.trade(1, self.start + 1), self.trade(2, self.start + 30001)]
        on = simulate(self.obs, trades, self.p, self.start, self.start + 60000)
        off = simulate(
            self.obs,
            trades,
            replace(self.p, market_enabled=False),
            self.start,
            self.start + 60000,
        )
        self.assertEqual(on["metrics"]["n"], 0)
        self.assertEqual(off["metrics"]["n"], 1)
        self.assertEqual(off["decisions"][1]["reason"], "drawdown")

    def test_continuous_ignores_pauses_but_preserves_entry_filters(self):
        trades = [
            self.trade(1, self.start + 1, creator_tax_bps=10),
            self.trade(2, self.start + 30001, creator_tax_bps=100),
            self.trade(3, self.start + 60001, creator_tax_bps=100),
        ]
        p = replace(self.p, account_pauses_enabled=False, min_creator_tax_bps=50)
        r = simulate(
            self.obs,
            trades,
            p,
            self.start,
            self.start + 90000,
            controls=[(self.start, "stop")],
            initial={"halts": ["manual", "venue", "drawdown"]},
        )
        self.assertEqual(r["metrics"]["n"], 2)
        self.assertEqual(r["metrics"]["pnl_wei"], "-140")
        self.assertEqual(r["decisions"][0]["reason"], "tax")
        self.assertFalse(any(x["halts"] for x in r["readings"]))

    def test_continuous_preserves_capacity_and_template_losses(self):
        p = replace(self.p, account_pauses_enabled=False, bankroll_wei=100)
        trades = [
            self.trade(1, self.start + 1, template="t"),
            self.trade(2, self.start + 2),
            self.trade(3, self.start + 30001, template="t"),
        ]
        r = simulate(self.obs, trades, p, self.start, self.start + 60000)
        self.assertEqual(
            [x["reason"] for x in r["decisions"]], [None, "capacity", "template_loss"]
        )

    def test_unknown_is_not_zero_profit(self):
        r = simulate(
            self.obs,
            [self.trade(1, self.start + 1, unsupported="pool_required")],
            replace(self.p, account_pauses_enabled=False),
            self.start,
            self.start + 60000,
        )
        self.assertFalse(r["complete"])
        self.assertFalse(
            selected_cash(r, {}, self.start, self.start + 60000)["complete"]
        )

    def test_difference_accounts_for_displaced_trades(self):
        a = dict(cash=[dict(id="a", at=1, pnl=10), dict(id="c", at=2, pnl=-4)])
        b = dict(cash=[dict(id="a", at=1, pnl=10), dict(id="b", at=2, pnl=-7)])
        z = difference(a, b, 0, 10)
        self.assertEqual(z["net_difference_wei"], "3")
        self.assertEqual(z["extra_loss_wei"], "4")
        self.assertEqual(z["displaced_loss_wei"], "7")

    def test_costs_count_once_at_close(self):
        r = dict(cash=[dict(id="a", at=1, pnl=-3), dict(id="a", at=2, pnl=10)])
        self.assertEqual(close_cash(r), [dict(id="a", at=2, pnl=7)])

    def test_boundary_rolls_back_overlapping_positions(self):
        raw = {
            "bot_positions": [
                dict(live=1, t_decide=10, exit_at=30),
                dict(live=1, t_decide=5, exit_at=12),
            ]
        }
        self.assertEqual(flat_boundary(raw, 20), 4)

    def test_passages_use_last_low_and_mark_unfinished_fall(self):
        samples = [
            dict(
                live=1,
                at=at,
                market=value,
                market_fresh=1,
                market_off=-1,
                market_on=2,
                halts="[]",
            )
            for at, value in [
                (1000, -2),
                (1500, -1.1),
                (2000, 1),
                (2500, 2.1),
                (3000, -1.2),
                (3500, 3),
            ]
        ]
        raw = dict(bot_guard_samples=samples, bot_positions=[])
        run = dict(cash=[], decisions=[], unresolved=[], open_ids=[])
        rows = score_passages(raw, {}, dict(continuous=run), [], 0, 4000)
        self.assertEqual(
            [(r["from_ms"], r["crossed_ms"], r["fall_complete"]) for r in rows],
            [(1500, 2500, True), (3000, 3500, False)],
        )

    def test_stale_reading_breaks_score_passage(self):
        samples = [
            dict(
                live=1,
                at=at,
                market=value,
                market_fresh=fresh,
                market_off=-1,
                market_on=2,
                halts="[]",
            )
            for at, value, fresh in [(1000, -2, 1), (1500, 0, 0), (2000, 3, 1)]
        ]
        raw = dict(bot_guard_samples=samples, bot_positions=[])
        self.assertEqual(score_passages(raw, {}, dict(), [], 0, 3000), [])


if __name__ == "__main__":
    unittest.main()
