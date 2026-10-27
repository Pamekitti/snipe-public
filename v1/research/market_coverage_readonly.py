"""Count observed launches against the current static untaxed screen, read-only."""

import collections
import datetime as dt
import json
import os
import sqlite3
import sys
import time

os.nice(10)
NOW = int(sys.argv[1]) if len(sys.argv) > 1 else int(time.time() * 1000)
DAY = 86_400_000
START = NOW - 7 * DAY
FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"
TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"
ZERO = "0x" + "0" * 40


def connect(path):
    db = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    return db


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def counts(rows):
    result = collections.Counter()
    for r in rows:
        result["all"] += 1
        tax, ex = r["tax"], r["ex"]
        if tax is None or tax < 0:
            result["tax_unknown"] += 1
        elif tax == 0:
            result["untaxed"] += 1
            if ex is None:
                result["untaxed_ex_unknown"] += 1
            elif ex >= 3:
                result["untaxed_ex3"] += 1
                if r["pair"] == ZERO:
                    result["untaxed_static_eligible"] += 1
                else:
                    result["untaxed_ex3_noneth"] += 1
            else:
                result["untaxed_ex_lt3"] += 1
        elif tax <= 49:
            result["tax_1_49"] += 1
        elif tax <= 200:
            result["tax_50_200"] += 1
        else:
            result["tax_gt200"] += 1
        if r["pair"] != ZERO:
            result["noneth"] += 1
        result["source_" + r["source"]] += 1
    return dict(result)


tape = connect("/srv/snipe-v2/data/tape.db")
first_at = tape.execute("SELECT at FROM events ORDER BY seq LIMIT 1").fetchone()[0]
maxseq, maxat = tape.execute("SELECT seq,at FROM events WHERE at<=? ORDER BY at DESC LIMIT 1", (NOW,)).fetchone()
launches = {}
legacy = connect("/srv/snipe/v1/data/bot.db")
for token, at, tax, ex, pair in legacy.execute(
    "SELECT token,detected_at,creator_tax_bps,exemptions,pair_token FROM launches "
    "WHERE detected_at>=? AND detected_at<?", (START, first_at)
):
    launches[token.lower()] = dict(at=at, tax=tax, ex=ex, pair=(pair or "").lower(), source="v1")
legacy.close()
meta = {}
duplicate_logs = 0
meta_failures = 0
meta_conflicts = 0
cursor = tape.execute("SELECT seq FROM events WHERE at>=? ORDER BY at LIMIT 1", (START,)).fetchone()[0] - 1
while cursor < maxseq:
    end = min(cursor + 50000, maxseq)
    for at, kind, body in tape.execute(
        "SELECT at,kind,body FROM events WHERE seq>? AND seq<=? AND "
        "((kind='logs' AND instr(body,?)>0) OR "
        "(kind='chain-read' AND instr(body,?)>0)) ORDER BY seq",
        (cursor, end, TOPIC, '"kind":"meta"')
    ):
        e = json.loads(body)
        if kind == "logs":
            for log in e["logs"]:
                topics = log.get("topics", [])
                if not topics or topics[0] != TOPIC or log["address"].lower() != FACTORY:
                    continue
                token = "0x" + topics[1][-40:].lower()
                if token in launches:
                    duplicate_logs += 1
                    continue
                launches[token] = dict(at=at, tax=None, ex=None,
                    pair="0x" + log["data"][2:66][-40:].lower(), source="v2")
        elif e["request"]["kind"] == "meta":
            args = e["request"]["args"]
            if len(args) < 2:
                continue
            token = args[1].lower()
            r = e.get("result") or {}
            p = r.get("params")
            if not p:
                meta_failures += 1
                continue
            value = (int(p["creatorTaxBps"]) if "creatorTaxBps" in p else None, r.get("exemptions"))
            if token not in meta:
                meta[token] = value
            elif value[0] != meta[token][0]:
                meta_conflicts += 1
    cursor = end
for token, row in launches.items():
    if row["source"] == "v2" and token in meta:
        row["tax"], row["ex"] = meta[token]
rows = list(launches.values())
windows = {}
for days, nbins in [(1, 8), (7, 7)]:
    start = NOW - days * DAY
    subset = [r for r in rows if start <= r["at"] < NOW]
    bins = []
    for i in range(nbins):
        lo = start + i * days * DAY // nbins
        hi = start + (i + 1) * days * DAY // nbins
        bins.append(dict(start=iso(lo), end=iso(hi), counts=counts(r for r in subset if lo <= r["at"] < hi)))
    windows[str(days) + "d"] = dict(start=iso(start), end=iso(NOW), counts=counts(subset), bins=bins)
assert all(c["counts"].get("all", 0) == sum(b["counts"].get("all", 0) for b in c["bins"]) for c in windows.values())
result = dict(asof=iso(NOW), tape_end=iso(maxat), v2_start=iso(first_at),
    duplicate_logs=duplicate_logs, meta_failures=meta_failures, meta_conflicts=meta_conflicts,
    first_seen=iso(min(r["at"] for r in rows)), last_seen=iso(max(r["at"] for r in rows)),
    windows=windows,
    caveat="Observed Pons V2 factory launches, deduplicated by token. Uses first successful metadata. Static eligible means ETH pair, zero creator tax, >=3 exemptions; excludes dynamic template/market/price/execution controls.")
print(json.dumps(result, indent=2))
