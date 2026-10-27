"""Behavioral checks for the consolidated offline workflow."""

import json
import io
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from research.core.account import (
    Observation,
    choose_policy,
    executable_partition,
    metrics,
    policy_diagnostics,
    simulate,
)
from research.core.policies import Policy, policies
from research.core.features import Features, accepts
from research.core.data import (
    Worker,
    Cache,
    capture,
    read_json,
    write_json,
    digest,
    timestamp_log_requests,
    transfer_timestamp_request,
    transfer_timestamp_groups,
)
from research.core.acquisition_policy import PaidAllowanceExhausted, PaidAllowance
from research.core.execution import (
    booked,
    effective_exit_hash,
    path_request,
    receipt_accounting,
    validate_dataset,
)

START = 1_000_000


def trade(i, entry, pnl=-10, size=100, **kw):
    return dict(
        id=i, token=str(i), entry=entry, exit=entry + 1000, pnl=pnl, size=size, **kw
    )


def scores(value, at=START - 1):
    return [
        Observation(str(i), i, START - 1000, at, {"1.75": value}, 2) for i in range(2)
    ]


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.p = Policy(
            window=2,
            recovery_window=2,
            size_wei=100,
            bankroll_wei=1000,
            dd_wei=60,
            touch_enabled=False,
        )

    def test_booked_zero_overrides_fallback(self):
        self.assertEqual(booked({"onchain_pnl_wei": "0", "pnl_wei": "-9"}), 0)

    def test_unavailable_execution_is_a_common_partition(self):
        eligible, unavailable = executable_partition(
            [{"id": 1}, {"id": 2, "unsupported": "pool_required"}]
        )
        self.assertEqual([row["id"] for row in eligible], [1])
        self.assertEqual([row["id"] for row in unavailable], [2])

    def test_cash_peak_survives_epoch_lift(self):
        obs = scores(2) + [
            Observation("n" + str(i), 5 + i, START + 2000, START + 2001, {"1.75": 2})
            for i in range(2)
        ]
        r = simulate(
            obs,
            [trade(1, START + 1, -70), trade(2, START + 60001, -20)],
            self.p,
            START,
            START + 90000,
        )
        self.assertEqual(r["metrics"]["pnl_wei"], "-90")
        self.assertEqual(r["metrics"]["dd_eth"], 90 / 1e18)
        self.assertTrue(any(a["action"] == "dd_resume" for a in r["actions"]))

    def test_drawdown_lifts_above_venue_but_not_broken(self):
        initial = {"halts": ["drawdown", "venue"], "halt_at": START - 10}
        a = simulate(scores(2), [], self.p, START, START + 1, initial=initial)
        b = simulate(
            scores(2),
            [],
            self.p,
            START,
            START + 1,
            initial={**initial, "halts": ["drawdown", "broken"]},
        )
        self.assertTrue(any(x["action"] == "dd_resume" for x in a["actions"]))
        self.assertFalse(any(x["action"] == "dd_resume" for x in b["actions"]))

    def test_unknown_keeps_capital_and_stops(self):
        r = simulate(
            scores(2),
            [
                trade(1, START + 1, unsupported="pool_required"),
                trade(2, START + 2, 100),
            ],
            self.p,
            START,
            START + 10000,
        )
        self.assertEqual(r["open_ids"], [1])
        self.assertEqual(r["metrics"]["n"], 0)
        self.assertEqual(len(r["unresolved"]), 1)

    def test_capacity_reserves_until_exit(self):
        r = simulate(
            scores(2),
            [trade(1, START + 1), trade(2, START + 2)],
            replace(self.p, bankroll_wei=100),
            START,
            START + 10000,
        )
        self.assertEqual(r["decisions"][1]["reason"], "capacity")
        self.assertEqual(r["metrics"]["n"], 1)

    def test_template_loss_only_after_close(self):
        ts = [
            trade(1, START + 1, template="same"),
            trade(2, START + 2, template="same"),
            trade(3, START + 2000, template="same"),
        ]
        r = simulate(scores(2), ts, self.p, START, START + 10000)
        self.assertIsNone(r["decisions"][1]["reason"])
        self.assertEqual(r["decisions"][2]["reason"], "template_loss")

    def test_resume_is_strictly_above_two(self):
        r = simulate(
            scores(1),
            [trade(1, START + 1)],
            self.p,
            START,
            START + 10000,
            initial={"halts": ["venue"]},
        )
        self.assertEqual(r["decisions"][0]["reason"], "venue")

    def test_operator_resume_waits_for_evidence(self):
        r = simulate(
            scores(0.75),
            [trade(1, START + 2000)],
            self.p,
            START,
            START + 10000,
            controls=[(START + 1, "resume")],
            initial={"halts": ["stopped"]},
        )
        self.assertEqual(r["decisions"][0]["reason"], "venue")

    def test_missing_read_does_not_clear_pause(self):
        r = simulate([], [], self.p, START, START + 1, initial={"halts": ["venue"]})
        self.assertIn("venue", r["readings"][-1]["halts"])

    def test_stale_exception_and_hold_differ(self):
        old = [Observation(str(i), i, 1, 2, {"1.75": -2}) for i in range(2)]
        a = simulate(
            old,
            [],
            replace(self.p, fresh_ms=100),
            START,
            START + 1,
            initial={"halts": ["venue"]},
        )
        b = simulate(
            old,
            [],
            replace(self.p, fresh_ms=100, stale="hold"),
            START,
            START + 1,
            initial={"halts": ["venue"]},
        )
        self.assertNotIn("venue", a["readings"][-1]["halts"])
        self.assertIn("venue", b["readings"][-1]["halts"])

    def test_touch_guard_hysteresis(self):
        obs = [replace(o, peak=1) for o in scores(2)]
        r = simulate(
            obs,
            [trade(1, START + 1)],
            replace(self.p, touch_enabled=True),
            START,
            START + 10000,
        )
        self.assertEqual(r["decisions"][0]["reason"], "gate")

    def test_distinct_updates_do_not_count_ticks(self):
        r = simulate(
            scores(2),
            [],
            replace(self.p, market_updates=3),
            START,
            START + 90000,
            initial={"halts": ["venue"]},
        )
        self.assertIn("venue", r["readings"][-1]["halts"])

    def test_future_scores_cannot_change_earlier_entry(self):
        early = simulate(
            scores(-1), [trade(1, START + 1)], self.p, START, START + 10000
        )
        future = simulate(
            scores(-1) + [Observation("future", 10, START, START + 5000, {"1.75": 99})],
            [trade(1, START + 1)],
            self.p,
            START,
            START + 10000,
        )
        self.assertEqual(early["decisions"][0], future["decisions"][0])

    def test_missing_feature_falls_back(self):
        self.assertEqual(accepts("buyers_per_coin", {}), (True, True))

    def test_daily_recovery_budget_rolls_at_utc_midnight(self):
        from research.core.data import DAY

        start = DAY - 30000
        obs = [
            Observation(str(i), i, start - 1000, start - 1, {"1.75": 2})
            for i in range(2)
        ]
        r = simulate(
            obs,
            [],
            self.p,
            start,
            DAY + 1,
            initial={"halts": ["drawdown"], "halt_at": start - 10, "daily_lifts": 2},
        )
        lifts = [a for a in r["actions"] if a["action"] == "dd_resume"]
        self.assertEqual(len(lifts), 1)
        self.assertEqual(lifts[0]["at"], DAY)

    def test_stop_keeps_exits_running(self):
        r = simulate(
            scores(2),
            [trade(1, START + 1, 30)],
            self.p,
            START,
            START + 5000,
            controls=[(START + 2, "stop")],
        )
        self.assertEqual(r["metrics"]["pnl_wei"], "30")
        self.assertFalse(r["open_ids"])

    def test_probe_uses_repriced_sizes_then_steps_up(self):
        ts = []
        for i in range(7):
            entry = START + 1 + i * 2000
            ts.append(
                trade(
                    i,
                    entry,
                    20,
                    variants={
                        str(n): dict(size=n, pnl=10, exit=entry + 1000)
                        for n in [25, 50]
                    },
                )
            )
        p = replace(
            self.p, probation=True, probe_sizes=(25, 50, 100), probe_loss_wei=1000
        )
        r = simulate(
            scores(2), ts, p, START, START + 20000, initial={"halts": ["venue"]}
        )
        self.assertEqual([c["size"] for c in r["cash"]], [25, 25, 25, 50, 50, 50, 100])
        self.assertEqual(r["metrics"]["pnl_wei"], "80")

    def test_placeholder_log_time_is_missing(self):
        from research.core.data import event_timestamp

        for raw in ["0x0", 0, None, "garbage"]:
            self.assertIsNone(event_timestamp({"blockTimestamp": raw}))
        self.assertEqual(event_timestamp({"blockTimestamp": "0x64"}), 100)

    def test_invalidated_run_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_json(root / "INVALIDATED.json", {"reason": "bad timing"})
            with self.assertRaisesRegex(ValueError, "invalidated"):
                validate_dataset(root)

    def test_dataset_tamper_detected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_json(root / "dataset.json", {})
            write_json(
                root / "manifest.json",
                {"dataset_sha256": digest(root / "dataset.json")},
            )
            validate_dataset(root)
            write_json(root / "dataset.json", {"changed": True})
            with self.assertRaises(ValueError):
                validate_dataset(root)

    def test_open_cost_can_halt_and_is_not_double_counted(self):
        t = trade(1, START + 1, -80, costs=[{"at": START + 10, "wei": 70}])
        t["exit"] = START + 5000
        r = simulate(
            scores(2), [t, trade(2, START + 1000)], self.p, START, START + 10000
        )
        self.assertEqual(r["decisions"][1]["reason"], "drawdown")
        self.assertEqual(r["metrics"]["pnl_wei"], "-80")
        self.assertEqual(r["metrics"]["n"], 1)

    def test_receipt_independent_accounting(self):
        topic_buy = "buy"
        topic_sell = "sell"

        def rc(amount, topic, word):
            words = [0, 0, 0, 0]
            words[word] = amount
            return {
                "gasUsed": "0x2",
                "effectiveGasPrice": "0x3",
                "status": "0x1",
                "logs": [
                    {
                        "address": "curve",
                        "topics": [topic],
                        "data": "0x" + "".join(f"{x:064x}" for x in words),
                    }
                ],
            }

        p = dict(
            id=1,
            curve="curve",
            buy_hash="a",
            exit_hash="b",
            spend_wei="100",
            proceeds_wei="130",
            onchain_pnl_wei="18",
        )
        r = receipt_accounting(
            p,
            {"a": rc(100, topic_buy, 0), "b": rc(130, topic_sell, 1)},
            topics={"CurveBuy": topic_buy, "CurveSell": topic_sell},
        )
        self.assertTrue(r["complete"])
        self.assertEqual(r["independently_reconstructed_wei"], "18")

    def test_unverified_burned_gas_blocks_accounting(self):
        p = dict(
            id=1,
            curve="curve",
            spend_wei="0",
            proceeds_wei="0",
            burned_gas_wei="9",
            pnl_wei="-9",
            exit_reason="buy-never-mined",
        )
        self.assertFalse(receipt_accounting(p, {})["complete"])

    def test_cache_offline_never_queries(self):
        with tempfile.TemporaryDirectory() as td, Cache(Path(td) / "cache.db") as cache:
            self.assertIsNone(cache.get("eth_call", []))

    def test_inherited_trading_endpoint_is_never_used(self):
        calls = []

        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): self.close()

        def opener(request, **_):
            calls.append(request.full_url)
            return Response(json.dumps({"jsonrpc": "2.0", "id": 0, "result": "0x1"}).encode())

        with tempfile.TemporaryDirectory() as td, patch.dict(
            os.environ,
            {"RPC_URL": "https://paid.invalid/key", "RPC_KEY_URL": "https://paid.invalid/key"},
            clear=False,
        ):
            with Cache(Path(td) / "cache.db", fetch=True, opener=opener, sleeper=lambda _: None) as cache:
                self.assertEqual(cache.get("eth_blockNumber", []), "0x1")
        self.assertEqual(calls, ["https://rpc.mainnet.chain.robinhood.com"])

    def test_unknown_endpoint_requires_explicit_bounded_paid_run(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "RESEARCH_ALLOW_PAID"):
                Cache(Path(td) / "cache.db", fetch=True, url="https://paid.invalid/key")

    def test_paid_batches_and_retries_share_one_allowance(self):
        calls = []

        def opener(request, **_):
            calls.append(len(json.loads(request.data)))
            raise RuntimeError("HTTP Error 429: Too Many Requests")

        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {
            "RESEARCH_ALLOW_PAID": "1",
            "RESEARCH_MAX_PAID_REQUESTS": "3",
            "RESEARCH_PAID_BUDGET_PATH": str(Path(td) / "allowance.sqlite"),
        }, clear=True):
            with Cache(
                Path(td) / "cache.db", fetch=True, url="https://paid.invalid/key",
                logs_url="https://paid.invalid/key", headers_url="https://paid.invalid/key",
                opener=opener, sleeper=lambda _: None,
            ) as cache:
                self.assertEqual(cache.many([("one", []), ("two", [])]), [None, None])
                self.assertEqual(cache.summary(), {
                    "cache_hits": 0, "network_attempts": 2,
                    "paid_allowance_used": 2, "missing_results": 2,
                })
        self.assertEqual(calls, [2])

    def test_paid_allowance_is_shared_between_clients(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "allowance.sqlite"
            first = PaidAllowance(path, 2)
            second = PaidAllowance(path, 2)
            first.claim(1)
            second.claim(1)
            with self.assertRaises(PaidAllowanceExhausted):
                first.claim(1)
            self.assertEqual(first.used, 2)
            second.close()
            first.close()

    def test_only_successful_historical_transactions_are_cached(self):
        replies = iter([
            {"hash": "0xabc", "blockNumber": None},
            {"hash": "0xabc", "blockNumber": "0x10"},
            {"hash": "0xabc", "blockNumber": "0x10"},
        ])
        calls = 0

        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): self.close()

        def opener(request, **_):
            nonlocal calls
            calls += 1
            body = json.loads(request.data)
            return Response(json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": next(replies)}).encode())

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "cache.db"
            with Cache(path, fetch=True, opener=opener, sleeper=lambda _: None) as cache:
                self.assertIsNone(cache.get("eth_getTransactionByHash", ["0xabc"])["blockNumber"])
                self.assertEqual(cache.get("eth_getTransactionByHash", ["0xabc"])["blockNumber"], "0x10")
                self.assertEqual(cache.get("eth_getTransactionByHash", ["0xabc"])["blockNumber"], "0x10")
                self.assertEqual(cache.get("eth_getBlockByNumber", ["latest", False])["blockNumber"], "0x10")
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("select count(*) from rpc").fetchone()[0], 1)
                self.assertEqual(db.execute("select count(*) from failures").fetchone()[0], 0)
        self.assertEqual(calls, 3)

    def test_independent_verification_bypasses_cache(self):
        values = iter(["first", "verified"])

        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): self.close()

        def opener(request, **_):
            body = json.loads(request.data)
            return Response(json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": next(values)}).encode())

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "cache.db"
            with Cache(path, fetch=True, opener=opener, sleeper=lambda _: None) as cache:
                self.assertEqual(cache.get("historical", ["0x1"]), "first")
            with Cache(path, fetch=True, bypass_cache=True, opener=opener, sleeper=lambda _: None) as cache:
                self.assertEqual(cache.get("historical", ["0x1"]), "verified")
            with Cache(path) as cache:
                self.assertEqual(cache.get("historical", ["0x1"]), "first")

    def test_partial_rate_limit_retries_only_failed_item(self):
        calls = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def opener(request, **_):
            body = json.loads(request.data)
            calls.append(body)
            if isinstance(body, list):
                result = [
                    {"jsonrpc": "2.0", "id": 0, "result": "first"},
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "error": {"code": 429, "message": "rate limited"},
                    },
                ]
            else:
                result = {"jsonrpc": "2.0", "id": 0, "result": "second"}
            return Response(json.dumps(result).encode())

        with tempfile.TemporaryDirectory() as td, Cache(
            Path(td) / "cache.db",
            fetch=True,
            opener=opener,
            sleeper=lambda _: None,
        ) as cache:
            self.assertEqual(
                cache.many([("one", []), ("two", [])]), ["first", "second"]
            )
        self.assertEqual([len(x) if isinstance(x, list) else 1 for x in calls], [2, 1])

    def test_whole_batch_rate_limit_retries_as_batch(self):
        calls = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def opener(request, **_):
            body = json.loads(request.data)
            calls.append(body)
            if len(calls) == 1:
                raise RuntimeError("HTTP Error 429: Too Many Requests")
            return Response(
                json.dumps(
                    [
                        {"jsonrpc": "2.0", "id": row["id"], "result": row["id"]}
                        for row in body
                    ]
                ).encode()
            )

        with tempfile.TemporaryDirectory() as td, Cache(
            Path(td) / "cache.db",
            fetch=True,
            opener=opener,
            sleeper=lambda _: None,
        ) as cache:
            self.assertEqual(cache.many([("one", []), ("two", [])]), [0, 1])
        self.assertEqual([len(body) for body in calls], [2, 2])

    def test_transfer_timestamp_batches_are_capped_at_ten(self):
        sizes = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def opener(request, **_):
            body = json.loads(request.data)
            rows = body if isinstance(body, list) else [body]
            sizes.append(len(rows))
            value = [
                {"jsonrpc": "2.0", "id": row["id"], "result": {"transfers": []}}
                for row in rows
            ]
            return Response(
                json.dumps(value if isinstance(body, list) else value[0]).encode()
            )

        with tempfile.TemporaryDirectory() as td, Cache(
            Path(td) / "cache.db",
            fetch=True,
            opener=opener,
            sleeper=lambda _: None,
        ) as cache:
            requests = [("research_getTransferTimestamps", [i]) for i in range(11)]
            self.assertEqual(len(cache.many(requests)), 11)
        self.assertEqual(sizes, [10, 1])

    def test_log_scans_and_historical_state_use_separate_endpoints(self):
        urls = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def opener(request, **_):
            urls.append(request.full_url)
            body = json.loads(request.data)
            request_id = body[0]["id"] if isinstance(body, list) else body["id"]
            return Response(
                json.dumps({"jsonrpc": "2.0", "id": request_id, "result": []}).encode()
            )

        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {
            "RESEARCH_ALLOW_PAID": "1",
            "RESEARCH_MAX_PAID_REQUESTS": "6",
            "RESEARCH_PAID_BUDGET_PATH": str(Path(td) / "allowance.sqlite"),
        }, clear=True):
            with Cache(
                Path(td) / "cache.db",
                fetch=True,
                url="http://archive",
                logs_url="http://logs",
                headers_url="http://headers",
                opener=opener,
                sleeper=lambda _: None,
            ) as cache:
                cache.get("eth_getLogs", [{}])
                cache.get("research_getTimestampLogs", [{}])
                cache.get("research_getTransferTimestamps", [{}])
                cache.get("research_getTimestampHeader", ["0x1", False])
                cache.get("eth_getBlockByNumber", ["0x1", False])
                cache.get("eth_call", [{}, "0x1"])
        self.assertEqual(
            urls,
            [
                "http://logs",
                "http://archive",
                "http://archive",
                "http://headers",
                "http://headers",
                "http://archive",
            ],
        )

    def test_timestamp_log_requests_are_bounded_and_deduplicated(self):
        requests = timestamp_log_requests(["0x64", "0x65", "0x6e"], ["topic"])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0][0], "research_getTimestampLogs")
        self.assertEqual(requests[0][1][0]["fromBlock"], "0x64")
        self.assertEqual(requests[0][1][0]["toBlock"], "0x6d")

    def test_transfer_timestamp_request_is_pinned_and_pageable(self):
        method, params = transfer_timestamp_request(
            ["0xtoken", "0xother"], 100, 200, "next"
        )
        self.assertEqual(method, "research_getTransferTimestampsV3")
        self.assertEqual(params[0]["fromBlock"], "0x64")
        self.assertEqual(params[0]["toBlock"], "0xc8")
        self.assertEqual(params[0]["contractAddresses"], ["0xtoken", "0xother"])
        self.assertEqual(params[0]["pageKey"], "next")

    def test_transfer_timestamp_groups_isolate_high_activity(self):
        facts = [
            {"token": "a", "block": 100},
            {"token": "b", "block": 110},
            {"token": "c", "block": 120},
        ]
        paths = {"a": [1] * 10, "b": [1] * 400, "c": [1] * 10}
        groups = transfer_timestamp_groups(facts, paths, max_weight=100)
        self.assertEqual(
            [[f["token"] for f in group] for group in groups], [["a"], ["b"], ["c"]]
        )

    def test_graduated_swap_hash_is_separated_from_approval_costs(self):
        position = {"id": 7, "token": "0x" + "1" * 40}
        ancillary = [
            {"position_id": 7, "hash": "approval", "kind": "token-approval"},
            {"position_id": 7, "hash": "swap", "kind": "swap"},
        ]
        self.assertEqual(
            effective_exit_hash(
                position, {"swap": {"logs": []}}, ancillary, "0x" + "2" * 40
            ),
            "swap",
        )

    def test_policy_diagnostics_counts_false_restart(self):
        result = {
            "actions": [
                {"at": 10, "action": "venue_resume"},
                {"at": 20, "action": "venue_stop"},
            ],
            "decisions": [{"at": 11, "id": 1, "reason": None}],
            "cash": [{"at": 15, "id": 1, "pnl": -5, "trade_pnl": -5, "kind": "close"}],
            "metrics": {"pnl_wei": "-5"},
        }
        value = policy_diagnostics(result)
        self.assertEqual(value["false_restarts"], 1)
        self.assertEqual(value["accepted"], 1)

    def test_replacement_must_pass_all_four_gates(self):
        def result(full, dd, selection, reserved, eligible=True):
            return {
                "ranking_eligible": eligible,
                "metrics": {"pnl_eth": full, "dd_eth": dd},
                "selection": {"pnl_eth": selection},
                "reserved6h": {"pnl_eth": reserved},
            }

        values = {
            "market_plus2": result(10, 3, 8, 2),
            "winner": result(12, 2, 9, 3),
            "higher_dd": result(20, 4, 15, 5),
            "bad_holdout": result(20, 2, 15, 1),
        }
        verdict = choose_policy(values)
        self.assertEqual(verdict["selected"], "winner")
        self.assertEqual(verdict["replacements"], ["winner"])

    def test_missing_historical_rules_remain_unavailable(self):
        token = "0x" + "1" * 40
        data = {
            "params": {token: {"known": True}},
            "paths": {token: []},
            "path_coverage": {token: {"all_topics": True}},
            "blocks": {},
            "receipts": {},
            "snapshot_at": START + 1000,
        }
        position = {
            "token": token,
            "curve": "0x" + "2" * 40,
            "t_detect": START,
            "spend_wei": "100",
            "take_profit": 1.75,
            "context_json": None,
        }
        _, reason = path_request(data, position, 0)
        self.assertEqual(reason, "missing_historical_rules")


class WorkflowTests(unittest.TestCase):
    def test_historical_pool_quote_keeps_ranking_disabled(self):
        from research.core.pools import quote

        class FakeCache:
            def __init__(self, *_args, **_kwargs):
                pass

            def get(self, *_args):
                return "0xquote"

            def close(self):
                pass

        class FakeWorker:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def call(self, op, **_kwargs):
                if op == "metadata":
                    return {"v4": {"quoter": "0xquoter"}}
                if op == "encode_pool":
                    return "0xcall"
                if op == "decode_pool":
                    return ("123", "45")
                raise AssertionError(op)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_json(
                root / "pool_requests.json",
                [{"id": 1, "key": {}, "tokens": "7", "block": "0x1"}],
            )
            with patch(
                "research.core.pools.validate_dataset",
                return_value=({}, {"dataset_sha256": "hash"}),
            ), patch("research.core.pools.Cache", FakeCache), patch(
                "research.core.pools.Worker", FakeWorker
            ), patch(
                "research.core.pools.write_artifact"
            ):
                result = quote(root, root / "cache.db", True)
            self.assertEqual(result["results"][0]["status"], "historical_quote")
            self.assertFalse(result["results"][0]["ranking_eligible"])

    def test_capture_reads_offline_database_copies(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bot = root / "bot.db"
            gate = root / "gate.db"
            with closing(sqlite3.connect(bot)) as db:
                db.execute("create table launches(token text)")
                db.execute("insert into launches values ('token')")
                db.execute("create table positions(id integer)")
                db.execute("insert into positions values (1)")
                db.execute("create table graduation_transactions(raw text, hash text)")
                db.execute(
                    "insert into graduation_transactions values ('secret','hash')"
                )
                db.commit()
            with closing(sqlite3.connect(gate)) as db:
                db.execute("create table obs(token text)")
                db.execute("insert into obs values ('token')")
                db.execute("create table state(value text)")
                db.commit()
            state = root / "state.json"
            write_json(state, {"at": START, "config": {"values": {}}})
            out = root / "capture.json.gz"
            result = capture(bot, gate, state, out)
            value = read_json(out)
            self.assertEqual(result["positions"], 1)
            self.assertEqual(value["snapshot_at"], START)
            self.assertEqual(value["gate_obs"][0]["token"], "token")
            self.assertNotIn("raw", value["bot_graduation_transactions"][0])
            with self.assertRaisesRegex(ValueError, "already exists"):
                capture(bot, gate, state, out)

    def test_parallel_results_share_a_complete_source_archive(self):
        from concurrent.futures import ThreadPoolExecutor
        from research.core.data import write_artifact, read_json
        import tarfile

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(
                    pool.map(
                        lambda n: write_artifact(root / f"{n}.json", {"n": n}), range(4)
                    )
                )
            archives = list((root / "objects").glob("*.tar.gz"))
            self.assertEqual(len(archives), 1)
            with tarfile.open(archives[0]) as archive:
                self.assertGreater(len(archive.getmembers()), 66)
            for path in (root / "objects").glob("*.manifest.json"):
                m = read_json(path)
                self.assertEqual(
                    digest(root / "objects" / m["source_archive"]),
                    m["source_archive_sha256"],
                )

    def test_offline_workflow_reports_missing_evidence(self):
        from research.core.data import prepare, read_json
        from research.core.execution import benchmark
        from research.core.account import compare
        from research.core.reporting import report

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            token = "0x" + "a" * 40
            curve = "0x" + "b" * 40
            config = dict(
                venuePauseWindow=20,
                venuePauseOff=-1,
                venueFreshHours=3,
                maxDrawdownEth=0.06,
                tradeSizeEth=0.02,
                bankrollEth=0.08,
                ddResumeWindow=20,
                ddResumeOn=1,
            )
            context = dict(
                rules=dict(
                    maxHoldMs=45000,
                    hardStopMultiple=0.5,
                    deadCoinAfterMs=20000,
                    deadCoinBelowMult=1.03,
                ),
                entryStrategy={"tradeSizeEth": 0.02},
            )
            position = dict(
                id=1,
                token=token,
                curve=curve,
                live=1,
                closed=1,
                t_detect=START,
                t_decide=START + 1,
                exit_at=START + 5000,
                spend_wei="20000000000000000",
                proceeds_wei="20100000000000000",
                pnl_wei="100000000000000",
                buy_ok=1,
                exit_reason="time",
                context_json=json.dumps(context),
                take_profit=1.75,
            )
            data = dict(
                snapshot_at=START + 10000,
                state={"config": {"values": config}},
                bot_positions=[position],
                bot_launches=[
                    dict(
                        token=token,
                        curve=curve,
                        block=1,
                        launched_at=START // 1000,
                        detected_at=START,
                        creator_tax_bps=100,
                        dev_buy_wei="10000000000000000",
                        exemptions=3,
                    )
                ],
                gate_obs=[],
                bot_graduation_transactions=[
                    dict(
                        position_id=1,
                        hash="h",
                        at=START,
                        raw="sensitive",
                        rejected=True,
                    )
                ],
            )
            write_json(root / "capture.json", data)
            run = root / "run"
            prepare(root / "capture.json", run, root / "cache.db", days=3)
            self.assertNotIn(
                "raw",
                read_json(read_json(run / "dataset.json")["source"])[
                    "bot_graduation_transactions"
                ][0],
            )
            with self.assertRaises(ValueError):
                prepare(root / "capture.json", run, root / "cache.db")
            b = benchmark(run)
            self.assertEqual(b["coverage"]["checked_transactions"], 0)
            c = compare(run)
            self.assertFalse(c["ranking_eligible"])
            self.assertTrue(report(run).is_file())
            self.assertTrue(list((run / "objects").glob("*.manifest.json")))


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = Worker()
        cls.topics = cls.w.call(op="metadata")["topics"]
        cls.params = dict(
            phantomQuote=str(168 * 10**16),
            reservedTokens=str(285714285714285714285714285),
            launchSupply=str(10**27),
            feeBps="100",
            creatorTaxBps="100",
            snipeTaxStartBps="9900",
            snipeTaxSeconds="3",
            launchedAt="1000",
        )

    @classmethod
    def tearDownClass(cls):
        cls.w.close()

    def test_integer_roundtrip_pays_fees(self):
        b = self.w.call(
            op="math", params=self.params, side="buy", amount=str(2 * 10**16), at=1002
        )
        s = self.w.call(
            op="math",
            params=self.params,
            state=b["next"],
            side="sell",
            amount=b["tokensOut"],
        )
        self.assertLess(int(s["quoteOut"]), int(b["spent"]))

    def test_tax_decay_and_exemption(self):
        taxed = self.w.call(
            op="math", params=self.params, side="buy", amount=str(10**16), at=1000
        )
        exempt = self.w.call(
            op="math",
            params=self.params,
            side="buy",
            amount=str(10**16),
            at=1000,
            exempt=True,
        )
        self.assertGreater(int(exempt["tokensOut"]), int(taxed["tokensOut"]))

    def test_adaptive_tie_uses_lowest(self):
        r = self.w.call(
            op="adaptive",
            rows=[{"1.25": 1, "1.75": 1}] * 20,
            window=20,
            bars=[1.25, 1.75],
            fallback=1.75,
        )
        self.assertEqual(r["multiple"], 1.25)

    def test_entry_execution_and_hold_clock_follow_recorded_send_time(self):
        expected = self.w.call(
            op="math", params=self.params, side="buy", amount=str(10**16), at=1003
        )
        r = self.w.call(
            op="replay",
            params=self.params,
            logs=[],
            sizeWei=str(10**16),
            entryAt=1002900,
            buyAt=1003100,
            openedAt=1003100,
            endAt=1005000,
            sellDelayMs=50,
            pollMs=50,
            takeProfit=10,
            token="0x" + "a" * 40,
            curve="0x" + "b" * 40,
            rules=dict(
                maxHoldMs=500,
                hardStopMultiple=0.01,
                deadCoinAfterMs=0,
                deadCoinBelowMult=1,
            ),
        )
        self.assertEqual(r["status"], "closed")
        self.assertEqual(r["tokens"], expected["tokensOut"])
        self.assertEqual(r["exitAt"], 1003650)

    def test_actual_fill_uses_event_once(self):
        buy = self.w.call(
            op="math", params=self.params, side="buy", amount=str(10**16), at=1002
        )
        data = "0x" + "".join(
            f"{int(v):064x}"
            for v in [
                buy["spent"],
                buy["tokensOut"],
                int(buy["fee"]) + int(buy["snipeTax"]),
                buy["tax"],
            ]
        )
        wallet = "0x" + "a" * 40
        log = dict(
            blockNumber="0x1",
            logIndex="0x0",
            transactionHash="0xabc",
            topics=[self.topics["CurveBuy"], "0x" + wallet[2:].zfill(64)],
            data=data,
            address="0x" + "b" * 40,
            at=1002000,
        )
        r = self.w.call(
            op="replay",
            mode="recorded_fill",
            params=self.params,
            logs=[log],
            wallet=wallet,
            buyHash="0xabc",
            entryMarkWei=buy["spent"],
            sizeWei=buy["spent"],
            entryAt=1002000,
            endAt=1003000,
            takeProfit=10,
            token=wallet,
            curve=log["address"],
            rules=dict(
                maxHoldMs=500,
                hardStopMultiple=0.01,
                deadCoinAfterMs=0,
                deadCoinBelowMult=1,
            ),
        )
        self.assertEqual(r["status"], "decision")
        self.assertEqual(r["tokens"], buy["tokensOut"])
        self.assertEqual(r["reason"], "time")


if __name__ == "__main__":
    unittest.main()
