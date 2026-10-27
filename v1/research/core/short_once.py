"""One-shot, user-operated Lighter short test. Preview is the default.

Uses a separate, otherwise idle Lighter account and its API signing key.
Never reads Snipe configuration, sends wallet transactions, or transfers funds.
Authenticated execution has not been validated with funds.
"""
from __future__ import annotations

import argparse
import asyncio
from decimal import Decimal as D, ROUND_CEILING, ROUND_FLOOR
import json
import os
from pathlib import Path
import secrets
import ssl
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

HOST = "https://api.rh.lighter.xyz"
MAX_QUOTE = D("20")
TLS = ssl.create_default_context()
try:
    import certifi
    TLS.load_verify_locations(certifi.where())
except ImportError:
    pass


def decimal(value):
    value = D(str(value))
    if not value.is_finite():
        raise ValueError("Non-finite amount")
    return value


def units(amount, decimals, rounding=ROUND_FLOOR):
    return int((amount * D(10) ** decimals).to_integral_value(rounding=rounding))


def plan(market, book, cap, slippage_bps=50):
    """Choose minimum legal quantity; never increase the caller's exposure cap."""
    cap = decimal(cap)
    if not 0 < cap <= MAX_QUOTE or not 0 <= slippage_bps <= 100:
        raise ValueError("Quote cap must be >0 and <=20; slippage must be 0..100 bps")
    if market["market_type"] != "perp" or market["status"] != "active":
        raise ValueError("Market is not an active perpetual")
    if market.get("market_config", {}).get("force_reduce_only") is not False:
        raise ValueError("Opening permission is disabled or unknown")
    bids = sorted([(decimal(x["price"]), decimal(x["remaining_base_amount"]))
                   for x in book["bids"] if decimal(x["remaining_base_amount"]) > 0], reverse=True)
    asks = sorted([(decimal(x["price"]), decimal(x["remaining_base_amount"]))
                   for x in book["asks"] if decimal(x["remaining_base_amount"]) > 0])
    if not bids or not asks or bids[0][0] <= 0 or asks[0][0] < bids[0][0]:
        raise ValueError("Empty or crossed order book")
    size_decimals, price_decimals = market["supported_size_decimals"], market["supported_price_decimals"]
    limit_units = units(bids[0][0] * (1 - D(slippage_bps) / 10000), price_decimals, ROUND_CEILING)
    limit_price = D(limit_units) / D(10) ** price_decimals
    minimum = max(decimal(market["min_base_amount"]), decimal(market["min_quote_amount"]) / limit_price)
    quantity_units = units(minimum, size_decimals, ROUND_CEILING)
    quantity = D(quantity_units) / D(10) ** size_decimals
    # Use the greater of ask/mark/index for the exposure check, not leveraged margin.
    exposure = quantity * max(asks[0][0], decimal(market["mark_price"]), decimal(market["index_price"]))
    if exposure > cap:
        raise ValueError(f"Venue minimum needs about {exposure:.4f} quote units; cap is {cap}. No order.")
    if sum(size for price, size in bids if price >= limit_price) < quantity:
        raise ValueError("Insufficient displayed bid depth within the opening price limit")
    if asks[0][1] < quantity:
        raise ValueError("Insufficient displayed best-ask depth for the initial close check")
    return {"symbol": market["symbol"], "market_id": market["market_id"],
            "base_amount": quantity_units, "quantity": str(quantity), "price": limit_units,
            "size_decimals": size_decimals, "price_decimals": price_decimals,
            "estimated_exposure_quote": str(exposure), "max_quote": str(cap)}


def signed_position(account, market_id):
    positions = account["positions"]
    found = [p for p in positions if p["market_id"] == market_id]
    if len(found) > 1:
        raise ValueError("Duplicate position records")
    if not found:
        return D(0)
    p = found[0]
    size = decimal(p["position"])
    if size < 0 or p["sign"] not in (-1, 0, 1) or (size and p["sign"] == 0):
        raise ValueError("Unexpected position representation")
    return size * p["sign"]


async def short_once(venue, trade_plan, journal, execute=False):
    """One opening attempt, then up to three reduce-only close attempts.

    A timeout is unresolved, never success. Keep this account idle elsewhere.
    Price-limited closes can fail and leave exposure requiring manual attention.
    """
    if not execute:
        return {"status": "preview_only", "plan": trade_plan, "orders_sent": 0}
    if not 0 < decimal(trade_plan["estimated_exposure_quote"]) <= decimal(trade_plan["max_quote"]) <= MAX_QUOTE:
        raise ValueError("Plan exceeds the small-test exposure cap")
    market_id = trade_plan["market_id"]
    before = await venue.account()
    if any(decimal(p["position"]) != 0 for p in before["positions"]):
        raise ValueError("Use a separate account with no existing positions")
    if before["pending_order_count"] or before["total_order_count"] or await venue.active_orders():
        raise ValueError("Account has existing or pending orders")
    # No leverage-setting changes; reserve at least twice the planned exposure.
    if decimal(before["available_balance"]) < 2 * decimal(trade_plan["estimated_exposure_quote"]):
        raise ValueError("Available collateral is below the tester's two-times-exposure reserve")
    journal({"phase": "before", "account": before, "plan": trade_plan})
    client_id = secrets.randbelow(2**46 - 4) + 1
    unresolved = []
    attempted = 0

    async def leg(cid, amount, price, close):
        nonlocal attempted
        journal({"phase": "intent", "client_order_id": cid, "reduce_only": close,
                 "base_amount": amount, "price": price})
        attempted += 1
        try:
            response = await venue.send(market_id, cid, amount, price, close)
            journal({"phase": "submission", "client_order_id": cid, "response": response})
        except Exception as error:
            # The request may have arrived. Do not resubmit an opening order.
            journal({"phase": "submission_unknown", "client_order_id": cid, "error_type": type(error).__name__})
        result = await venue.terminal_order(market_id, cid)
        if result is None:
            unresolved.append(cid)
        else:
            journal({"phase": "terminal_order", "order": result})
        return result

    opening = await leg(client_id, trade_plan["base_amount"], trade_plan["price"], False)
    opened = decimal(opening["filled_base_amount"]) if opening is not None else None
    if opened is not None and not 0 <= opened <= decimal(trade_plan["quantity"]):
        raise RuntimeError("Unexpected opening fill size; inspect account")
    closed = D(0)
    for attempt in range(3):
        account = await venue.account()
        position = signed_position(account, market_id)
        if position > 0 or abs(position) > decimal(trade_plan["quantity"]):
            raise RuntimeError("Unexpected position. Stop and inspect the separate test account.")
        # A stale flat account read cannot erase a confirmed opening fill.
        remaining = opened - closed if opened is not None else abs(position)
        if remaining == 0:
            break
        book = await venue.book(market_id)
        asks = [decimal(x["price"]) for x in book["asks"] if decimal(x["remaining_base_amount"]) > 0]
        if not asks:
            raise RuntimeError("SHORT STILL OPEN: no ask liquidity")
        # Bound each close to 0.5% above the current best ask; never reverse long.
        close_price = units(min(asks) * D("1.005"), trade_plan["price_decimals"], ROUND_FLOOR)
        quantity_units = units(remaining, trade_plan["size_decimals"])
        if D(quantity_units) / D(10) ** trade_plan["size_decimals"] != remaining:
            raise RuntimeError("SHORT STILL OPEN: position precision mismatch")
        result = await leg(client_id + attempt + 1, quantity_units, close_price, True)
        if result is None:
            break
        filled = decimal(result["filled_base_amount"])
        if not 0 <= filled <= remaining:
            raise RuntimeError("Unexpected close fill size; inspect account")
        closed += filled
    after = await venue.account()
    position = signed_position(after, market_id)
    active = await venue.active_orders()
    if position != 0 or active or after["pending_order_count"] or after["total_order_count"] or unresolved or (opened is not None and closed != opened):
        status = "UNRESOLVED_CHECK_ACCOUNT"
    elif not opening or decimal(opening["filled_base_amount"]) == 0:
        status = "NO_OPEN_FILL"
    else:
        status = "OPEN_AND_CLOSE_CONFIRMED"
    result = {"status": status, "remaining_position": str(position), "unresolved_order_ids": unresolved,
              "confirmed_open_quantity": str(opened) if opened is not None else None,
              "confirmed_close_quantity": str(closed),
              "order_attempts": attempted, "before_collateral": before["collateral"],
              "after_collateral": after["collateral"],
              "collateral_delta": str(decimal(after["collateral"]) - decimal(before["collateral"])),
              "note": "Account delta is not a reconciled wallet P&L; funding, fees and external changes need review."}
    journal({"phase": "after", "account": after, "result": result})
    return result


class LighterVenue:
    """Public reads work without the SDK. Signing is enabled only by the caller."""
    def __init__(self, account_index=None, signer=None):
        self.account_index, self.signer = account_index, signer

    async def get(self, endpoint, params=None, private=False):
        headers = {}
        if private:
            auth, error = self.signer.create_auth_token_with_expiry()
            if error:
                raise RuntimeError("Could not create authentication token")
            headers["Authorization"] = auth
        url = HOST + "/api/v1/" + endpoint + "?" + urlencode(params or {})
        def read():
            with urlopen(Request(url, headers=headers), timeout=5, context=TLS) as response:
                body = json.load(response)
            if body.get("code") != 200:
                raise RuntimeError("Venue returned an unsuccessful result")
            return body
        return await asyncio.to_thread(read)

    async def book(self, market_id):
        return await self.get("orderBookOrders", {"market_id": market_id, "limit": 100})

    async def account(self):
        body = await self.get("account", {"by": "index", "value": self.account_index})
        if len(body["accounts"]) != 1 or body.get("next_cursor"):
            raise RuntimeError("Incomplete or ambiguous account response")
        account = body["accounts"][0]
        if account["index"] != self.account_index:
            raise RuntimeError("Account identity mismatch")
        return account

    async def active_orders(self):
        body = await self.get("accountActiveOrders", {"account_index": self.account_index}, private=True)
        if body.get("next_cursor"):
            raise RuntimeError("Incomplete active-order response")
        return body["orders"]

    async def send(self, market_id, cid, amount, price, close):
        _, result, error = await asyncio.wait_for(self.signer.create_order(
            market_index=market_id, client_order_index=cid, base_amount=amount, price=price,
            is_ask=not close, order_type=self.signer.ORDER_TYPE_MARKET,
            time_in_force=self.signer.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=close, order_expiry=self.signer.DEFAULT_IOC_EXPIRY), timeout=10)
        if error or result is None or result.code != 200:
            raise RuntimeError("Submission rejected or unknown; reconcile by client order id")
        return {"code": result.code, "tx_hash": result.tx_hash}

    async def terminal_order(self, market_id, cid):
        for _ in range(15):
            try:
                body = await self.get("accountInactiveOrders", {"account_index": self.account_index,
                    "market_id": market_id, "limit": 100}, private=True)
                for order in body["orders"]:
                    if str(order.get("client_order_id", order.get("client_order_index"))) == str(cid):
                        if order["status"] == "filled" or order["status"].startswith("canceled"):
                            return order
            except Exception:
                pass
            await asyncio.sleep(0.5)
        return None


async def main(args):
    venue = LighterVenue()
    catalog = (await venue.get("orderBookDetails"))["order_book_details"]
    found = [m for m in catalog if m["symbol"].upper() == args.symbol.upper()]
    if len(found) != 1:
        raise ValueError("Exact market symbol not uniquely listed. No order.")
    cap = decimal(args.max_quote) if args.max_quote else decimal(args.max_eth) * decimal(next(m for m in catalog if m["symbol"] == "ETH")["mark_price"])
    trade_plan = plan(found[0], await venue.book(found[0]["market_id"]), cap)
    if not args.execute:
        print(json.dumps(await short_once(venue, trade_plan, None), indent=2))
        return
    if args.account_index is None or args.api_key_index is None or not args.journal:
        raise ValueError("Execution requires an account index, API key index and fresh journal path")
    if not 2 <= args.api_key_index <= 254:
        raise ValueError("Use a dedicated API signing key index 2..254")
    key = os.environ.get("LIGHTER_TEST_API_PRIVATE_KEY")
    if not key:
        raise ValueError("Missing dedicated LIGHTER_TEST_API_PRIVATE_KEY; no Snipe wallet key is read")
    import lighter
    with Path(args.journal).open("x", encoding="utf-8") as handle:
        os.chmod(args.journal, 0o600)
        def journal(entry):
            handle.write(json.dumps({"at_ms": int(time.time() * 1000), **entry}) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        signer = lighter.SignerClient(url=HOST, account_index=args.account_index,
            api_private_keys={args.api_key_index: key}, chain_id=466324)
        try:
            error = signer.check_client()
            if error:
                raise RuntimeError("Dedicated API key/account validation failed")
            venue = LighterVenue(args.account_index, signer)
            # Refresh the quote after local setup; never submit a stale preview.
            trade_plan = plan(found[0], await venue.book(found[0]["market_id"]), cap)
            result = await short_once(venue, trade_plan, journal, execute=True)
            print(json.dumps(result, indent=2))
            if result["status"] != "OPEN_AND_CLOSE_CONFIRMED":
                raise RuntimeError("Test did not confirm a complete round trip; inspect the journal and account")
        except BaseException as error:
            journal({"phase": "ABORT_CHECK_ACCOUNT", "error_type": type(error).__name__})
            raise
        finally:
            await signer.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", required=True)
    budget = parser.add_mutually_exclusive_group(required=True)
    budget.add_argument("--max-quote", help="Maximum position exposure in quote units, <=20")
    budget.add_argument("--max-eth", help="Exposure budget converted using ETH mark price; NOT leveraged collateral")
    parser.add_argument("--execute", action="store_true", help="USER-RUN ONLY: sends real orders")
    parser.add_argument("--account-index", type=int)
    parser.add_argument("--api-key-index", type=int)
    parser.add_argument("--journal", help="New private JSONL file; existing files are never reused")
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments))
    except Exception as error:
        detail = ("Execution stopped. Inspect the journal and test account for possible exposure. "
                  f"Error type: {type(error).__name__}" if arguments.execute else str(error))
        parser.exit(1, detail + "\n")
