"""The chain-facing plumbing every operational script had its own copy of.

Three scripts fetch curve events and feed them to engine.path: gatewatch.py (halts real
money on the result), recon.py (grades the bot with it) and tpgrid.py (fits the exit
policy on it). Until 2026-08-19 each carried an identical ~30-line copy of the
getLogs->sequence decoder, which meant a drift in one copy was a silent scoring change in
whichever consumer trusted it. This is the one copy, plus the rpc() helper and the
constants they all shared.
"""

import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# RPC only, never the bot's RPC_URL / LOGS_WS_URL key: the Alchemy free tier caps eth_getLogs
# at 10 blocks and these scripts fetch 500-block curve windows, so the key would refuse every
# call and burn quota doing it. The public endpoint is the right one for batch research.
RPC = os.environ.get("RPC") or "https://rpc.mainnet.chain.robinhood.com"
WALLET = os.environ.get("WALLET", "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1").lower()
BOT_DB = os.path.join(HERE, "..", "data", "bot.db")
GATE_DB = os.path.join(HERE, "..", "data", "gate.db")

TOPIC_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455"
TOPIC_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df"
TOPIC_BB = "0x5feba9b0d52c92ada4b9c571c2bee52390c54f2947208ab250221e6ee32f12ff"
CURVE_TOPICS = [TOPIC_BUY, TOPIC_SELL, TOPIC_BB]

# Closures that never put capital on a curve: they belong in no return-on-turnover, win rate
# or trade count. MUST match NON_TRADE_REASONS in src/telemetry/db.ts, which owns the list and
# publishes it as the `trades` view. Python cannot import from the TS tree, so this is the one
# Python copy and it lives here for the same reason the getLogs decoder does: three scripts
# each carrying their own was a silent scoring change in whichever one drifted. The list grew
# on 2026-08-19 ('buy-never-mined') and that is exactly when a scattered copy goes wrong.
NON_TRADE_REASONS = ("recovered-flat", "buy-reverted", "buy-never-mined")
NON_TRADE_SQL = ",".join(f"'{r}'" for r in NON_TRADE_REASONS)


def make_rpc(ua, timeout=30, tries=4, backoff=2.0, pace_s=0.0):
    """A JSON-RPC caller with this script's name in the user-agent.

    The UA is not cosmetic: cloudflare 403s urllib's default, and a per-script name is
    how the box's RPC budget stays attributable. `pace_s` sleeps AFTER each successful
    call for callers that pace every request (recon); others pace at their own call
    sites.
    """

    def rpc(method, params):
        body = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        ).encode()
        for k in range(tries):
            try:
                req = urllib.request.Request(
                    RPC, body, {"content-type": "application/json", "user-agent": ua}
                )
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    j = json.loads(r.read())
                if "error" in j:
                    raise RuntimeError(str(j["error"])[:120])
                if pace_s:
                    time.sleep(pace_s)
                return j["result"]
            except Exception:
                if k == tries - 1:
                    raise
                time.sleep(backoff * (k + 1))

    return rpc


def decode_seq(logs, wallet=WALLET):
    """Raw getLogs rows -> the (block,logIndex)-ordered event list engine.path consumes.

    Our own fills are dropped so every replay measures the venue rather than our own
    size; gatewatch's reading, recon's grade and tpgrid's fit all depend on that.
    """
    seq = []
    for lg in logs:
        d = lg["data"][2:]
        b, i = int(lg["blockNumber"], 16), int(lg["logIndex"], 16)
        if lg["topics"][0] == TOPIC_BB:
            seq.append(
                (b, i, {"s": "BB", "q": "0x" + d[0:64], "t": "0x" + d[64:128], "b": b})
            )
            continue
        u = "0x" + lg["topics"][1][26:]
        rcp = "0x" + lg["topics"][2][26:]
        if u.lower() == wallet or rcp.lower() == wallet:
            continue
        seq.append(
            (
                b,
                i,
                {
                    "b": b,
                    "i": i,
                    "s": "B" if lg["topics"][0] == TOPIC_BUY else "S",
                    "u": u,
                    "r": rcp,
                    "q": "0x" + d[0:64],
                    "t": "0x" + d[64:128],
                    "f": "0x" + d[128:192],
                    "x": "0x" + d[192:256],
                    "tx": lg["transactionHash"],
                },
            )
        )
    seq.sort(key=lambda e: (e[0], e[1]))
    return [e[2] for e in seq]
