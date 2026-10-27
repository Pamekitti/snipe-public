import sqlite3, sys, os
sys.path.insert(0, "scripts")
import chainio
from chainio import BOT_DB
rpc = chainio.make_rpc("recon2", timeout=25, tries=3)
W = chainio.WALLET
E = 2145.0
def iv(x):
    try: return int(x)
    except Exception: return 0
b = sqlite3.connect("file:%s?mode=ro" % BOT_DB, uri=True); b.row_factory = sqlite3.Row
nonce = int(rpc("eth_getTransactionCount", [W, "latest"]), 16)
bal   = int(rpc("eth_getBalance", [W, "latest"]), 16)
print("wallet %s" % W)
print("  nonce now      %d" % nonce)
print("  balance now    %.6f ETH  ($%.2f)" % (bal/1e18, bal/1e18*E))
rows = [r for r in b.execute("select id,buy_hash,exit_hash,buy_ok,spend_wei,proceeds_wei,onchain_pnl_wei,gas_wei,buy_gas_used,sell_gas_used,exit_reason from positions where id>1362")]
print("\nDB rows since the switch: %d" % len(rows))
print("  distinct buy hashes  %d" % len({r["buy_hash"] for r in rows if r["buy_hash"]}))
print("  distinct exit hashes %d" % len({r["exit_hash"] for r in rows if r["exit_hash"]}))
print("  gas_wei booked       $%.2f" % (sum(iv(r["gas_wei"]) for r in rows)/1e18*E))
# nonce at the first buy of this era
first = min((r for r in rows if r["buy_hash"]), key=lambda r: r["id"])
tx = rpc("eth_getTransactionByHash", [first["buy_hash"]])
n0 = int(tx["nonce"], 16) if tx else None
print("\n  nonce at first buy of the era: %s" % n0)
if n0 is not None:
    sent = nonce - n0
    accounted = len({r["buy_hash"] for r in rows if r["buy_hash"]}) + len({r["exit_hash"] for r in rows if r["exit_hash"]})
    print("  transactions SENT since then:      %d" % sent)
    print("  transactions the DB accounts for:  %d  (buys + sells)" % accounted)
    print("  UNACCOUNTED transactions:          %d" % (sent - accounted))
# sample some unaccounted nonces to see what they are
known = {(r["buy_hash"] or "").lower() for r in rows} | {(r["exit_hash"] or "").lower() for r in rows}
print("\n  sampling recent blocks for our txs not in the DB...")
tip = int(rpc("eth_blockNumber", []), 16)
found = {}
gasburn = 0
for blk in range(tip-400, tip):
    try:
        bd = rpc("eth_getBlockByNumber", [hex(blk), True])
    except Exception:
        continue
    if not bd: continue
    for t in bd.get("transactions", []):
        if (t.get("from") or "").lower() != W.lower(): continue
        h = (t.get("hash") or "").lower()
        try:
            rc = rpc("eth_getTransactionReceipt", [t["hash"]])
        except Exception:
            continue
        if not rc: continue
        cost = int(rc["gasUsed"], 16) * int(rc["effectiveGasPrice"], 16)
        gasburn += cost
        key = ("in-db" if h in known else "NOT-in-db", "ok" if int(rc["status"], 16) == 1 else "REVERTED")
        found[key] = found.get(key, [0, 0])
        found[key][0] += 1; found[key][1] += cost
print("  last 400 blocks (40s):")
for k, v in sorted(found.items()):
    print("     %-12s %-9s n=%-4d gas $%.4f" % (k[0], k[1], v[0], v[1]/1e18*E))
