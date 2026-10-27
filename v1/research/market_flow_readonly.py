"""Read-only recorded bonding-curve flows; never treats non-ETH units as ETH."""
import collections
import datetime as dt
import json
import os
import sqlite3
import sys

os.nice(10)
END = int(sys.argv[1])
START = END - 86400000
ZERO = "0x" + "0" * 40
FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"
LAUNCH = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607"
BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455"
SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df"


def db(path):
    d = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    d.execute("PRAGMA query_only=ON")
    return d


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def bucket(fact):
    if fact is None:
        return "unmapped_quote"
    if fact.get("pair") != ZERO:
        return "noneth"
    tax, ex = fact.get("tax"), fact.get("ex")
    if tax is None or tax < 0:
        return "eth_tax_unknown"
    if tax == 0:
        return "untaxed_pass" if ex is not None and ex >= 3 else "untaxed_ex_unknown" if ex is None else "untaxed_ex_lt3"
    return "tax_1_49" if tax <= 49 else "tax_50_200" if tax <= 200 else "tax_gt200"


tape = db("/srv/snipe-v2/data/tape.db")
maxseq = tape.execute("SELECT seq FROM events WHERE at<=? ORDER BY at DESC LIMIT 1", (END,)).fetchone()[0]
curves, meta, flows = {}, {}, {}
seen = set()
duplicates = malformed = 0
cursor = 0
while cursor < maxseq:
    stop = min(cursor + 50000, maxseq)
    for at, kind, body in tape.execute(
        "SELECT at,kind,body FROM events WHERE seq>? AND seq<=? AND "
        "((kind='logs' AND (at>=? OR instr(body,?)>0)) OR "
        "(kind='chain-read' AND instr(body,?)>0)) ORDER BY seq",
        (cursor, stop, START, LAUNCH, '"kind":"meta"')
    ):
        event = json.loads(body)
        if kind == "chain-read":
            r = event.get("result") or {}
            p = r.get("params")
            if p and event["request"]["kind"] == "meta":
                curve = event["request"]["args"][0].lower()
                meta.setdefault(curve, dict(tax=int(p["creatorTaxBps"]) if "creatorTaxBps" in p else None, ex=r.get("exemptions")))
            continue
        for log in event["logs"]:
            topics = log.get("topics", [])
            if not topics:
                continue
            topic, address = topics[0], log["address"].lower()
            if topic == LAUNCH and address == FACTORY:
                curve = "0x" + topics[2][-40:].lower()
                curves.setdefault(curve, dict(token="0x" + topics[1][-40:].lower(), pair="0x" + log["data"][2:66][-40:].lower(), launched=at))
            if at < START or topic not in (BUY, SELL):
                continue
            key = (log["blockHash"], log["logIndex"])
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            data = log["data"][2:]
            if len(data) < 256:
                malformed += 1
                continue
            words = [int(data[i:i+64], 16) for i in range(0, 256, 64)]
            b = min(7, (at - START) // 10800000)
            row = flows.setdefault(address, [collections.Counter() for _ in range(8)])[b]
            side = "buy" if topic == BUY else "sell"
            row[side + "Wei"] += words[0 if topic == BUY else 1]
            row[side + "N"] += 1
            row["feeWei"] += words[2]
            row["creatorTaxWei"] += words[3]
    cursor = stop
for curve, fact in curves.items():
    fact.update(meta.get(curve, {}))
missing = set(flows) - set(curves)
legacy = db("/srv/snipe/v1/data/bot.db")
if missing:
    for curve, token, pair, tax, ex in legacy.execute("SELECT curve,token,pair_token,creator_tax_bps,exemptions FROM launches"):
        if curve and curve.lower() in missing:
            curves[curve.lower()] = dict(token=token, pair=(pair or "").lower(), tax=tax, ex=ex)
legacy.close()
groups = collections.defaultdict(collections.Counter)
bins = [collections.defaultdict(collections.Counter) for _ in range(8)]
noneth = collections.Counter()
percurve = collections.defaultdict(list)
for curve, rows in flows.items():
    group = bucket(curves.get(curve))
    if group in ("noneth", "unmapped_quote"):
        noneth[group + "Curves"] += 1
        noneth[group + "Trades"] += sum(r["buyN"] + r["sellN"] for r in rows)
        continue
    groups[group]["curves"] += 1
    total = collections.Counter()
    for i, row in enumerate(rows):
        groups[group].update(row)
        bins[i][group].update(row)
        total.update(row)
    percurve[group].append(total["buyWei"])


def present(row):
    return {k[:-3] + "Eth" if k.endswith("Wei") else k: v / 1e18 if k.endswith("Wei") else v for k, v in row.items()}


total = collections.Counter()
for value in groups.values():
    total.update(value)
print(json.dumps(dict(start=iso(START), end=iso(END), groups={k:present(v) for k,v in groups.items()},
    total=present(total), excluded=dict(noneth), duplicates=duplicates, malformed=malformed,
    bins=[dict(start=iso(START+i*10800000), end=iso(START+(i+1)*10800000), groups={k:present(v) for k,v in b.items()}) for i,b in enumerate(bins)],
    limits="Observed pre-graduation ETH curve trades only, all launch ages. Amounts are turnover, not unique capital or trader profit. No full Uniswap volume; non-ETH and unmapped curves excluded. Time is event receipt time; metadata uses first successful read."), indent=2))
