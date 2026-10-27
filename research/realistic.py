"""Realistic snipe simulator.

Adds to the exact curve replay: exit lag, competing copycat bots, a bankroll
constraint, a haircut on post-entry order flow, and revert/miss rates.
"""

from load import *
# the venue constants, snipe-tax table, Curve, and the path/evaluate machinery all
# moved to engine.py (data-independent, so the box's recon loop can import them
# without the dataset). star-import keeps every old name importable from here.
from engine import *
import statistics as st, datetime, random, json

eth = [l for l in launches if states.get(l["token"], {}).get("pairToken") == ETH0]


def _devbuy(l):
    tr = trades.get(l["curve"].lower(), [])
    d = [t for t in tr if t["tx"] == l["tx"] and t["s"] == "B"]
    return h(d[0]["q"]) / 1e18 if d else 0.0


DEV = {l["token"]: _devbuy(l) for l in eth}
CTAX = {l["token"]: states[l["token"]].get("creatorTaxBps", 0) for l in eth}
DAY = {
    l["token"]: str(
        datetime.datetime.fromtimestamp(ts_of(l["block"]), datetime.UTC).date()
    )
    for l in eth
}
DAYS_ALL = sorted(set(DAY.values()))


def build_seq(l):
    a = l["curve"].lower()
    ev = []
    for t in trades.get(a, []):
        ev.append((t["b"], t["i"], t))
    for x in bb.get(a, []):
        ev.append((x["b"], x["i"], {"s": "BB", "q": x["q"], "t": x["t"], "b": x["b"]}))
    ev.sort(key=lambda e: (e[0], e[1]))
    return [e[2] for e in ev]


def simulate(l, X, cfg):
    """cfg keys: entry_blk, exit_lag, comp, haircut, rule."""
    ctax = CTAX[l["token"]]
    seq = build_seq(l)
    lb = l["block"]
    entry_abs = lb + cfg["entry_blk"]
    lag = cfg["exit_lag"]
    comp = cfg["comp"]
    hc = cfg["haircut"]
    rule = cfg["rule"]
    hold = rule.get("hold", 10**9)
    c = Curve(ctax)
    my_tok = None
    entry_px = None
    peak = None
    graduated = False
    pend = None
    # where I land among the pack of identical bots is luck, not skill
    _sr = random.Random(hash(l["token"]) & 0xFFFFFFFF)
    my_slot_in = _sr.randrange(comp + 1)
    my_slot_out = _sr.randrange(comp + 1)

    def enter():
        nonlocal my_tok, entry_px, graduated
        el = (entry_abs - lb) / 10.0
        sb = snipe_bps(el, ctax)
        n = comp + 1
        mine = my_slot_in
        got = None
        for i in range(n):
            out, g = c.buy(X, sb)
            if g:
                graduated = True
            if i == mine:
                got = out
        if not got:
            return False
        my_tok = got
        entry_px = X / got
        return True

    def do_exit(reason, blk):
        n = comp + 1
        mine = my_slot_out
        proceeds = None
        for i in range(n):
            p = c.sell(my_tok)
            if i == mine:
                proceeds = p
        pnl = proceeds - X - GAS_BUY - GAS_SELL
        return (pnl, proceeds / X, (blk - lb) / 10.0, reason)

    for e in seq:
        blk = e["b"]
        if my_tok is None and blk >= entry_abs:
            if not enter():
                return None
            peak = c.price()
            if graduated:
                return do_exit("grad", entry_abs)
        if my_tok is not None:
            if pend is not None and blk >= pend[0]:
                return do_exit(pend[1], blk)
            if blk - entry_abs >= hold:
                return do_exit("time", entry_abs + hold)
            if graduated:
                return do_exit("grad", blk)
        if e["s"] == "B":
            spent = h(e["q"]) / 1e18
            fee = h(e["f"]) / 1e18
            tax = h(e["x"]) / 1e18
            net = spent - fee - tax
            if my_tok is not None and hc:
                net *= 1 - hc
            sellable = c.t - RES
            if sellable <= 1e-9:
                graduated = True
            else:
                out = c.t * net / (c.q + net)
                if out >= sellable:
                    out = sellable
                    net = c.q * out / (c.t - out)
                    graduated = True
                c.q += net
                c.t -= out
        elif e["s"] == "S":
            tok = h(e["q"]) / 1e18
            gross = c.q * tok / (c.t + tok)
            c.q -= gross
            c.t += tok
        else:
            c.q += h(e["q"]) / 1e18
            c.t -= h(e["t"]) / 1e18
        if my_tok is not None and pend is None:
            p = c.price()
            m = p / entry_px
            if p > peak:
                peak = p
            if graduated:
                return do_exit("grad", blk)
            k = rule["kind"]
            if k == "trail":
                if m >= rule.get("arm", 1.0) and p <= peak * (1 - rule["trail"]):
                    pend = (blk + lag, "trail")
                elif m <= rule.get("sl", 0):
                    pend = (blk + lag, "sl")
            elif k == "tpsl":
                if m >= rule["tp"]:
                    pend = (blk + lag, "tp")
                elif m <= rule["sl"]:
                    pend = (blk + lag, "sl")
            elif k == "time":
                pass

    if my_tok is None:
        if not enter():
            return None
        return do_exit("dead", entry_abs)
    endblk = min(latest, entry_abs + hold)
    return do_exit("time" if endblk < latest else "end", max(endblk, entry_abs))


def cohort(devmin=0.0, ctaxmax=100, days=None):
    out = [l for l in eth if DEV[l["token"]] >= devmin and CTAX[l["token"]] <= ctaxmax]
    if days:
        out = [l for l in out if DAY[l["token"]] in days]
    return out


def run(
    coh, X, cfg, label=None, capital=None, miss=0.0, revert=0.0, seed=7, verbose=True
):
    """capital = ETH bankroll; signals are skipped while fully deployed."""
    rnd = random.Random(seed)
    res = []
    open_pos = []
    skipped = 0
    missed = 0
    reverted = 0
    gasburn = 0.0
    for l in sorted(coh, key=lambda x: x["block"]):
        if rnd.random() < miss:
            missed += 1
            continue
        entry = l["block"] + cfg["entry_blk"]
        if capital is not None:
            open_pos = [p for p in open_pos if p > entry]
            if (len(open_pos) + 1) * X > capital:
                skipped += 1
                continue
        if rnd.random() < revert:
            reverted += 1
            gasburn += GAS_BUY
            continue
        r = simulate(l, X, cfg)
        if not r:
            continue
        res.append((l, r))
        if capital is not None:
            open_pos.append(entry + int(r[2] * 10))
    if not res:
        return dict(n=0, total_usd=0, per_day=0, label=label)
    pn = [r[0] for l, r in res]
    tot = sum(pn) - gasburn
    byday = collections.defaultdict(float)
    for l, r in res:
        byday[DAY[l["token"]]] += r[0] * ETHUSD
    dvals = [byday[d] for d in sorted(byday)]
    o = dict(
        label=label,
        n=len(pn),
        X=X,
        total_usd=tot * ETHUSD,
        mean_usd=tot * ETHUSD / len(pn),
        win=sum(1 for p in pn if p > 0) / len(pn),
        rot=tot / (len(pn) * X),
        days=len(dvals),
        per_day=tot * ETHUSD / max(len(dvals), 1),
        neg_days=sum(1 for v in dvals if v < 0),
        skipped=skipped,
        missed=missed,
        reverted=reverted,
        med_mult=st.median([r[1] for l, r in res]),
        outcomes=dict(collections.Counter(r[3] for l, r in res)),
        byday={d: round(byday[d]) for d in sorted(byday)},
    )
    if verbose:
        print(
            f"{(label or ''):48s} n={o['n']:5d} X={X:<5} ${o['total_usd']:8.0f} ({o['per_day']:7.0f}/day) "
            f"mean=${o['mean_usd']:6.2f} win={o['win']*100:4.1f}% ROT={o['rot']*100:6.2f}% "
            f"negD={o['neg_days']}/{o['days']} skip={skipped}"
        )
    return o


BASE = dict(
    entry_blk=20,
    exit_lag=0,
    comp=0,
    haircut=0.0,
    rule=dict(kind="trail", trail=0.2, arm=1.2, sl=0.6, hold=3000),
)


def cfg(**kw):
    c = dict(BASE)
    c.update(kw)
    return c
