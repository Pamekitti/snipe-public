"""Evidence boundaries for policy comparisons, including missing outcomes."""

import json
from pathlib import Path
import sys
import unittest
import sqlite3
import tempfile
import io
import os
from dataclasses import replace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from research.core.evaluation import (
    adaptive_at,
    cash_difference,
    cash_summary,
    movement,
    paired_diagnostics,
    qualifies,
    recovery_losses,
    rolling_at,
    run_windows,
    trade_from_model,
)
from research.core.account import Observation, simulate
from research.core.policies import Policy
from research.core.data import Cache, bounded_logs


class EvaluationTests(unittest.TestCase):
    def test_failed_buy_gas_does_not_define_template_loss_group(self):
        at = 100_000
        raw = dict(
            snapshot_at=200_000,
            state={
                "truth": {
                    "filterChanges": [{"at": 1, "change": "VENUE_PAUSE_ON 1 -> 2"}]
                }
            },
            bot_launches=[
                dict(token="old", creator_tax_bps=100, exemptions=3, dev_buy_wei="10")
            ],
            bot_positions=[
                dict(
                    token="old",
                    live=1,
                    buy_ok=1,
                    exit_at=at - 1,
                    exit_reason="buy-reverted",
                    onchain_pnl_wei="-1",
                )
            ],
        )
        result = dict(status="closed", exitAt=at + 1, pnlWei="5")
        token = dict(
            token="new",
            entry=at,
            size=100,
            tp=1.75,
            delayed_tp=1.75,
            template="100:10:3",
            creator_tax_bps=100,
            exemptions=3,
            results={
                name: result
                for name in [
                    "adaptive",
                    "tp_1.25",
                    "tp_1.36",
                    "tp_1.50",
                    "tp_1.75",
                    "tp_2.00",
                    "tp_2.50",
                    "tp_3.00",
                ]
            },
        )
        value = paired_diagnostics({"tokens": {"new": token}}, raw, {"episodes": []})
        self.assertEqual(value["filters"]["template_loss"]["admitted"]["expected"], 1)
        self.assertEqual(value["filters"]["template_loss"]["rejected"]["expected"], 0)

    def test_historical_timestamp_headers_use_the_header_endpoint(self):
        requests = []

        def opener(request, **kwargs):
            requests.append(request)
            return io.BytesIO(
                json.dumps(
                    dict(id=0, result=dict(number="0x1", timestamp="0x2", hash="0xab"))
                ).encode()
            )

        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "RESEARCH_ALLOW_PAID": "1",
            "RESEARCH_MAX_PAID_REQUESTS": "1",
            "RESEARCH_PAID_BUDGET_PATH": str(Path(folder) / "allowance.sqlite"),
        }, clear=True):
            with Cache(
                Path(folder) / "cache.sqlite",
                fetch=True,
                url="https://archive.invalid",
                headers_url="https://headers.invalid",
                opener=opener,
                sleeper=lambda _: None,
                pace_seconds=0,
            ) as cache:
                value = cache.get("research_getTimestampHeader", ["0x1", False])
        self.assertEqual(value["timestamp"], "0x2")
        self.assertEqual(requests[0].full_url, "https://headers.invalid")
        self.assertEqual(json.loads(requests[0].data)["method"], "eth_getBlockByNumber")

    def test_reading_cached_evidence_does_not_block_retrieval_commits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "cache.sqlite"
            with Cache(path) as cache:
                cache.db.execute("INSERT INTO rpc VALUES ('a','[]','null',1)")
                cache.db.commit()
                reader = sqlite3.connect(path)
                try:
                    reader.execute("BEGIN")
                    self.assertEqual(
                        reader.execute("SELECT count(*) FROM rpc").fetchone()[0], 1
                    )
                    with Cache(path) as writer:
                        writer.db.execute("INSERT INTO rpc VALUES ('b','[]','null',2)")
                        writer.db.commit()
                    self.assertEqual(
                        reader.execute("SELECT count(*) FROM rpc").fetchone()[0], 1
                    )
                    reader.rollback()
                    self.assertEqual(
                        reader.execute("SELECT count(*) FROM rpc").fetchone()[0], 2
                    )
                finally:
                    reader.close()

    def test_bins_after_unknown_execution_are_unavailable(self):
        run = dict(cash=[], unresolved=[dict(at=100)])
        windows = run_windows(run, 0, 30_000_000)
        self.assertIsNone(windows["reserved6h"]["pnl_eth"])
        self.assertFalse(windows["reserved6h"]["available"])
        self.assertFalse(windows["current"]["complete"])

    def test_smaller_probe_can_pass_price_guard_when_full_size_cannot(self):
        p = Policy(
            window=1,
            recovery_window=1,
            size_wei=100,
            bankroll_wei=1000,
            dd_wei=500,
            touch_enabled=False,
            probation=True,
            probe_sizes=(25, 50, 100),
        )
        t = dict(
            id=1,
            token="x",
            entry=101,
            exit=200,
            pnl=0,
            size=100,
            entry_rejected=True,
            variants={"25": dict(size=25, entry_rejected=False, pnl=5)},
        )
        obs = [Observation("score", 1, 80, 90, {"1.75": 3})]
        run = simulate(obs, [t], p, 100, 1000, initial={"halts": ["venue"]})
        self.assertEqual(run["decisions"][0]["reason"], None)
        self.assertEqual(run["cash"][0]["size"], 25)
        self.assertEqual(run["metrics"]["pnl_wei"], "5")

    def test_capped_curve_paths_split_without_losing_boundary_blocks(self):
        class Cache:
            def get(self, method, params):
                request = params[0]
                lo, hi = int(request["fromBlock"], 16), int(request["toBlock"], 16)
                return list(range(lo, hi + 1))[:3]

        self.assertEqual(
            bounded_logs(Cache(), dict(fromBlock="0x0", toBlock="0x7"), limit=3),
            list(range(8)),
        )

    def test_unavailable_subrange_does_not_look_complete(self):
        class Cache:
            def get(self, method, params):
                r = params[0]
                return [1, 2] if r["fromBlock"] == "0x0" else None

        self.assertIsNone(
            bounded_logs(Cache(), dict(fromBlock="0x0", toBlock="0x3"), limit=2)
        )

    def test_window_improvement_can_be_entirely_removed_loss(self):
        a = Observation("old", 1, 1, 1, {"1.75": -3})
        b = Observation("new", 2, 2, 2, {"1.75": 0})
        result = movement([(a, -3)], [(b, 0)])
        self.assertEqual(result["after"] - result["before"], 3)
        self.assertEqual(result["added_profit"], 0)
        self.assertEqual(result["removed_losses"], 3)
        self.assertEqual(
            sum(
                result[k]
                for k in (
                    "added_profit",
                    "added_losses",
                    "removed_losses",
                    "removed_profit",
                    "revisions",
                )
            ),
            3,
        )

    def test_score_availability_precedes_entry(self):
        obs = [
            Observation("late", 3, 0, 101, {"1.75": 50}),
            Observation("same", 2, 0, 100, {"1.75": 20}),
            Observation("known", 1, 0, 99, {"1.75": -1}),
        ]
        self.assertEqual(
            [o.token for o, _ in rolling_at(obs, 100, 1, strict=True)], ["known"]
        )

    def test_adaptive_uses_broader_population_and_sql_limit_before_parsing(self):
        class Worker:
            def call(self, **request):
                self.request = request
                return {"multiple": 1.75}

        worker = Worker()
        rows = [
            dict(at=1, block=i, bars=json.dumps({"1.25": i}), error=None)
            for i in range(25)
        ]
        rows[-1]["bars"] = "malformed"
        rows.append(dict(at=100, block=100, bars=json.dumps({"1.25": 999}), error=None))
        adaptive_at({"gate_obs": rows, "bot_launches": []}, 100, worker)
        self.assertEqual(len(worker.request["rows"]), 19)
        self.assertEqual(min(r["1.25"] for r in worker.request["rows"]), 5)
        self.assertNotIn(999, [r["1.25"] for r in worker.request["rows"]])

    def test_unavailable_outcome_never_becomes_profit(self):
        z = dict(
            token="x",
            entry=100,
            size=100,
            tp=1.75,
            template="t",
            creator_tax_bps=50,
            exemptions=3,
            results={"adaptive": {"status": "pool_required"}},
        )
        t = trade_from_model(z)
        p = Policy(
            window=1,
            recovery_window=1,
            size_wei=100,
            bankroll_wei=1000,
            dd_wei=500,
            touch_enabled=False,
        )
        run = simulate([], [t], p, 100, 1000)
        self.assertFalse(run["complete"])
        self.assertEqual(run["cash"], [])
        self.assertEqual(run["open_ids"], ["x"])

    def test_entry_filters_can_be_removed_independently(self):
        p = Policy(
            window=1,
            recovery_window=1,
            size_wei=100,
            bankroll_wei=1000,
            dd_wei=500,
            touch_enabled=False,
            min_creator_tax_bps=50,
            min_exemptions=3,
        )
        t = dict(
            id=1,
            token="x",
            entry=100,
            exit=200,
            pnl=10,
            size=100,
            creator_tax_bps=0,
            exemptions=3,
        )
        base = simulate([], [t], p, 100, 1000)
        relaxed = simulate([], [t], replace(p, min_creator_tax_bps=0), 100, 1000)
        self.assertEqual(base["decisions"][0]["reason"], "tax")
        self.assertEqual(relaxed["metrics"]["pnl_wei"], "10")
        t["exemptions"] = 2
        blocked = simulate([], [t], replace(p, min_creator_tax_bps=0), 100, 1000)
        self.assertEqual(blocked["decisions"][0]["reason"], "exempt")

    def test_template_loss_survives_start_checkpoint(self):
        p = Policy(
            window=1,
            recovery_window=1,
            size_wei=100,
            bankroll_wei=1000,
            dd_wei=500,
            touch_enabled=False,
        )
        t = dict(
            id=1, token="x", template="farm", entry=100, exit=200, pnl=10, size=100
        )
        initial = {"template_loss": {"farm": 50}}
        base = simulate([], [t], p, 100, 1000, initial=initial)
        relaxed = simulate(
            [], [t], replace(p, template_loss_ms=0), 100, 1000, initial=initial
        )
        self.assertEqual(base["decisions"][0]["reason"], "template_loss")
        self.assertEqual(relaxed["metrics"]["pnl_wei"], "10")

    def test_recovery_losses_assign_by_entry_not_exit(self):
        run = dict(
            actions=[
                dict(at=10, action="venue_resume"),
                dict(at=20, action="dd_stop"),
                dict(at=30, action="dd_resume"),
            ],
            decisions=[dict(at=11, id=1, reason=None), dict(at=31, id=2, reason=None)],
            cash=[dict(at=25, id=1, pnl=-5), dict(at=35, id=2, pnl=-2)],
        )
        result = recovery_losses(run, 40)
        self.assertEqual(result["losing_n"], 2)
        self.assertEqual([e["pnl_wei"] for e in result["episodes"]], ["-5", "-2"])

    def test_differences_reconcile_shared_repriced_trades(self):
        base = {"cash": [dict(id=1, pnl=10), dict(id=2, pnl=-5), dict(id=3, pnl=20)]}
        candidate = {"cash": [dict(id=1, pnl=5), dict(id=4, pnl=12)]}
        d = cash_difference(candidate, base)
        total = (
            d["extra_profit_eth"]
            + d["extra_loss_eth"]
            - d["profit_missed_eth"]
            + d["losses_avoided_eth"]
            + d["changed_shared_cash_eth"]
        )
        self.assertAlmostEqual(total, d["net_change_eth"])

    def test_more_repeated_losses_disqualifies_higher_profit(self):
        def run(profit, losses):
            return dict(
                complete=True,
                windows={
                    name: dict(pnl_eth=profit, dd_eth=0.1)
                    for name in ("current", "fit", "reserved6h")
                },
                recovery=dict(losing_n=losses, loss_eth=0.1),
            )

        self.assertFalse(qualifies(run(2, 2), run(1, 1)))
        self.assertTrue(qualifies(run(2, 1), run(1, 1)))
        tied_holdout = run(2, 1)
        tied_holdout["windows"]["reserved6h"]["pnl_eth"] = 1
        self.assertTrue(qualifies(tied_holdout, run(1, 1)))
        incomplete = run(3, 0)
        incomplete["complete"] = False
        self.assertFalse(qualifies(incomplete, run(1, 1)))

    def test_unknown_cannot_claim_later_baseline_losses_avoided(self):
        base = {"cash": [dict(at=10, id=1, pnl=-5), dict(at=30, id=2, pnl=-100)]}
        incomplete = {
            "cash": [dict(at=10, id=1, pnl=-5)],
            "unresolved": [dict(at=20)],
            "complete": False,
        }
        result = cash_difference(incomplete, base)
        self.assertEqual(result["net_change_eth"], 0)
        self.assertEqual(result["losses_avoided_eth"], 0)
        self.assertEqual(result["known_until_ms"], 20)
        self.assertFalse(result["comparison_complete"])

    def test_empty_current_era_bin_is_unavailable(self):
        cell = cash_summary([], 20, 10)
        self.assertFalse(cell["available"])
        self.assertIsNone(cell["cash_eth"]["mean"])
        self.assertIsNone(cell["cash_eth"]["sd"])


if __name__ == "__main__":
    unittest.main()
