"""Offline lifecycle tests. This file never constructs a signer or calls a network."""
import unittest
from decimal import Decimal as D
from unittest.mock import AsyncMock

from core.short_once import plan, short_once


MARKET = {"symbol": "EXAMPLE", "market_id": 44, "market_type": "perp", "status": "active",
          "market_config": {"force_reduce_only": False}, "supported_size_decimals": 1,
          "supported_price_decimals": 5, "min_base_amount": "20", "min_quote_amount": "10",
          "mark_price": "0.64", "index_price": "0.64"}
BOOK = {"bids": [{"price": "0.63", "remaining_base_amount": "1000"}],
        "asks": [{"price": "0.64", "remaining_base_amount": "1000"}]}


def account(position="0"):
    return {"positions": [{"market_id": 44, "position": str(abs(D(position))), "sign": -1 if D(position) < 0 else 1}],
            "available_balance": "50", "collateral": "50", "pending_order_count": 0, "total_order_count": 0}


def venue(accounts, fills):
    return type("FakeVenue", (), {"account": AsyncMock(side_effect=accounts),
        "active_orders": AsyncMock(return_value=[]), "book": AsyncMock(return_value=BOOK),
        "send": AsyncMock(return_value={"code": 200, "tx_hash": "mock"}),
        "terminal_order": AsyncMock(side_effect=[None if x is None else {"status": "filled", "filled_base_amount": x} for x in fills])})()


class Plans(unittest.TestCase):
    def test_minimum_is_used_instead_of_full_budget(self):
        self.assertEqual(plan(MARKET, BOOK, "20")["quantity"], "20")

    def test_small_budget_is_not_silently_enlarged(self):
        with self.assertRaisesRegex(ValueError, "Venue minimum"):
            plan(MARKET, BOOK, "2.75")

    def test_unknown_opening_permission_is_rejected(self):
        with self.assertRaises(ValueError):
            plan({**MARKET, "market_config": {}}, BOOK, "20")

    def test_cap_and_depth(self):
        for cap in ["NaN", "Infinity", "0", "-1", "21"]:
            with self.subTest(cap=cap), self.assertRaises(ValueError):
                plan(MARKET, BOOK, cap)
        with self.assertRaisesRegex(ValueError, "bid depth"):
            plan(MARKET, {**BOOK, "bids": [{"price": "0.63", "remaining_base_amount": "1"}]}, "20")


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_preview_cannot_send_or_read_account(self):
        v = venue([], [])
        result = await short_once(v, plan(MARKET, BOOK, "20"), None)
        self.assertEqual(result["status"], "preview_only")
        v.send.assert_not_called()
        v.account.assert_not_called()

    async def test_round_trip_closes_only_actual_partial_fill(self):
        v = venue([account(), account("-8"), account(), account()], ["8", "8"])
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "OPEN_AND_CLOSE_CONFIRMED")
        self.assertEqual(v.send.await_args_list[1].args[2], 80)
        self.assertFalse(v.send.await_args_list[0].args[-1])
        self.assertTrue(v.send.await_args_list[1].args[-1])

    async def test_stale_flat_read_does_not_skip_confirmed_close(self):
        v = venue([account(), account(), account(), account()], ["20", "20"])
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "OPEN_AND_CLOSE_CONFIRMED")
        self.assertEqual(v.send.await_count, 2)

    async def test_partial_close_retries_only_remainder(self):
        v = venue([account(), account("-20"), account("-7"), account(), account()], ["20", "13", "7"])
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "OPEN_AND_CLOSE_CONFIRMED")
        self.assertEqual(v.send.await_args_list[2].args[2], 70)
        self.assertTrue(all(c.args[-1] for c in v.send.await_args_list[1:]))

    async def test_no_fill_does_not_create_reverse_position(self):
        v = venue([account(), account(), account()], ["0"])
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "NO_OPEN_FILL")
        self.assertEqual(v.send.await_count, 1)

    async def test_timeout_does_not_retry_open(self):
        v = venue([account(), account(), account()], [None])
        v.send.side_effect = TimeoutError
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "UNRESOLVED_CHECK_ACCOUNT")
        self.assertEqual(v.send.await_count, 1)

    async def test_timeout_with_visible_short_attempts_reduce_only_close(self):
        v = venue([account(), account("-20"), account(), account()], [None, "20"])
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "UNRESOLVED_CHECK_ACCOUNT")
        self.assertEqual(v.send.await_count, 2)
        self.assertTrue(v.send.await_args_list[1].args[-1])

    async def test_unfilled_close_never_reports_success(self):
        v = venue([account(), account(), account(), account(), account()], ["20", "0", "0", "0"])
        result = await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        self.assertEqual(result["status"], "UNRESOLVED_CHECK_ACCOUNT")

    async def test_existing_position_blocks_open(self):
        v = venue([account("-1")], [])
        with self.assertRaises(ValueError):
            await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        v.send.assert_not_called()

    async def test_existing_pending_order_blocks_open(self):
        v = venue([{**account(), "pending_order_count": 1}], [])
        with self.assertRaises(ValueError):
            await short_once(v, plan(MARKET, BOOK, "20"), lambda _: None, True)
        v.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
