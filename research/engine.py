"""The curve engine, extracted from realistic.py/sim2.py so it runs without the dataset.

Pure by construction: no file I/O at import, no module-level data. Everything operates
on explicit inputs (an event seq, a ctax) plus the venue constants. Three consumers:
the research stack (realistic.py star-imports this and keeps its old public names),
the sim dashboard (through sim2's thin wrappers), and the live recon loop on the box
(v1/scripts/recon.py imports this directly, with no data files present).

Moved verbatim on 2026-08-18 and parity-checked: the L45 preset reproduced
+5.4525% ROT / n=517 byte-identically across the split.
"""
import os
import random


def h(x):
    return int(x, 16)


PH = 1.68
SUP = 1e9
THR = 4.2
FEE = 100
RES = SUP * PH / (PH + THR)
# One ETH price everywhere. The tree used to carry three (1885 twice, 2145 once) and the
# same trade showed different dollars in different places. The bot's config reads the
# same env var, so the sim and the live dashboard can only disagree if you make them.
ETHUSD = float(os.environ.get("ETHUSD", 2145))
# Gas actually burned, in ETH, from 40 live receipts on 2026-08-18: buy p50 100,161 gas,
# sell p50 77,276, at an effectiveGasPrice of 0.0200 gwei. The old values divided USD
# guesses by a stale price and came out ~2.3x the real burn.
GAS_BUY = 2.0e-6
GAS_SELL = 1.6e-6


# The snipe tax as the chain actually charges it, not as the whitepaper reads.
#
# Measured 2026-08-18 over every Buy event in the fresh cohort (1,742 launches), by
# taking the fee field above the flat 100bps curve fee and bucketing on block offset
# from the launch block. It is NOT a smooth decay. It is three plateaus:
#
# It charges four discrete levels, never anything between them: 9700 / 618 / 19 / 0,
# one per whole elapsed second. Share of non-exempt buys landing on each, by block
# offset from the launch block (launch tx excluded, so no deployer buys):
#
#   blk   0- 4   ~9700 bps  (rare: almost everyone here is a tax-exempt bundled wallet)
#   blk   5-10     618 bps  (36-83% at 618, the rest exempt or still at 9700)
#   blk  11-19      19 bps  (71-98% at 19, with a 2-26% tail still paying 618)
#   blk  20-23      19 bps  (98% at 19, and max = 19: the band with no tail risk)
#   blk  24+         0 bps  (crossing into whole-second 3)
#
# The contract keys on whole elapsed SECONDS, and a launch block sits at an unknown
# phase inside its second, so block offset maps to a second-bucket only probabilistically
# - which is the whole reason the bands overlap. The live bot sidesteps this by timing
# off observed block timestamps rather than block counts, and landed on 19 bps in 21 of
# 21 fills on 2026-08-18 despite filling anywhere from blk 13 to blk 25.
#
# The old formula (9900 >> (elapsed*14//3)) interpolated a smooth decay through all of
# this: 309bps at 1.2s, 154 at 1.4s, 77 at 1.7s, against a true 19. It happened to be
# right at exactly blk 20, which is where every backtest ran, so the headline numbers
# survive. Any result that VARIED entry timing does not.
_SNIPE_BY_BLK = {}
for _b in range(0, 5):
    _SNIPE_BY_BLK[_b] = 9700
for _b in range(5, 11):
    _SNIPE_BY_BLK[_b] = 618
for _b in range(11, 24):
    _SNIPE_BY_BLK[_b] = 19
del _b


def snipe_bps(elapsed_s, ctax):
    blk = int(round(elapsed_s * 10))
    raw = _SNIPE_BY_BLK.get(blk, 9690 if blk < 0 else 0)
    return min(raw, 10000 - FEE - ctax - 100)


class Curve:
    def __init__(s, ctax):
        s.q = PH
        s.t = SUP
        s.ff = (FEE + ctax) / 10000

    def price(s):
        return s.q / s.t

    def buy(s, spent, snipe=0):
        net = spent * (1 - s.ff - snipe / 10000)
        sellable = s.t - RES
        if sellable <= 1e-9:
            return 0.0, True
        out = s.t * net / (s.q + net)
        if out > sellable:
            out = sellable
            net = s.q * out / (s.t - out)
        s.q += net
        s.t -= out
        return out, (s.t - RES) <= 1e-9

    def sell(s, tok):
        gross = s.q * tok / (s.t + tok)
        s.q -= gross
        s.t += tok
        return gross * (1 - s.ff)


def path(l, X, seq, ctax, entry_blk=20, comp=2, haircut=0.10, horizon=3000, tick=10, rival_x=None):
    """Return None if entry impossible, else dict with entry info and a list of
    (blk_offset_from_entry, price_multiple, curve_snapshot) sampled at every event
    and every `tick` blocks up to `horizon` blocks after entry."""
    lb = l["block"]
    entry_abs = lb + entry_blk
    c = Curve(ctax)
    _sr = random.Random(hash(l["token"]) & 0xFFFFFFFF)
    slot_in = _sr.randrange(comp + 1); slot_out = _sr.randrange(comp + 1)
    my_tok = None; entry_px = None; graduated = False
    pts = []   # (off, mult, q, t, graduated)
    def enter():
        nonlocal my_tok, entry_px, graduated
        el = (entry_abs - lb) / 10.0
        sb = snipe_bps(el, ctax)
        got = None
        rx = X if rival_x is None else rival_x
        for i in range(comp + 1):
            out, g = c.buy(X if i == slot_in else rx, sb)
            if g: graduated = True
            if i == slot_in: got = out
        if not got: return False
        my_tok = got; entry_px = X / got
        return True
    dep = l["deployer"].lower()
    early = set()
    cur_ev = [None]
    def snap(off):
        pts.append((off, c.price() / entry_px, c.q, c.t, graduated, cur_ev[0]))
        cur_ev[0] = None
    last_off = 0
    for e in seq:
        blk = e["b"]
        if my_tok is None and blk >= entry_abs:
            if not enter(): return None
            snap(0); last_off = 0
        if my_tok is not None:
            off = blk - entry_abs
            if off > horizon: break
            # synthetic ticks between events so time-based rules see the flat stretches
            k = last_off // tick + 1
            while k * tick < off:
                snap(k * tick); k += 1
        w = e.get("r", "").lower() if e["s"] in ("B", "S") else ""
        if my_tok is not None:
            if e["s"] == "B":
                cur_ev[0] = dict(s="B", eth=h(e["q"]) / 1e18, creator=(w == dep), early=(w in early), n_early=len(early))
            elif e["s"] == "S":
                cur_ev[0] = dict(s="S", tok=h(e["q"]) / 1e18, creator=(w == dep), early=(w in early), n_early=len(early))
        if e["s"] == "B" and blk <= lb + 30 and e.get("tx") != l["tx"] and w:
            early.add(w)
        if e["s"] == "B":
            spent = h(e["q"]) / 1e18; fee = h(e["f"]) / 1e18; tax = h(e["x"]) / 1e18
            net = spent - fee - tax
            if my_tok is not None and haircut: net *= 1 - haircut
            sellable = c.t - RES
            if sellable <= 1e-9: graduated = True
            else:
                out = c.t * net / (c.q + net)
                if out >= sellable:
                    out = sellable; net = c.q * out / (c.t - out); graduated = True
                c.q += net; c.t -= out
        elif e["s"] == "S":
            tok = h(e["q"]) / 1e18
            gross = c.q * tok / (c.t + tok); c.q -= gross; c.t += tok
        else:
            c.q += h(e["q"]) / 1e18; c.t -= h(e["t"]) / 1e18
        if my_tok is not None:
            off = blk - entry_abs
            snap(off); last_off = off
    if my_tok is None:
        # no event at/after entry: enter into the final state, nothing follows
        if not enter(): return None
        snap(0)
    # pad ticks to horizon
    k = last_off // tick + 1
    while k * tick <= horizon:
        snap(k * tick); k += 1
    return dict(l=l, X=X, tok=my_tok, entry_px=entry_px, ctax=ctax, slot_out=slot_out, comp=comp, pts=pts, rival_x=X if rival_x is None else rival_x)

def sell_value(P, q, t, frac=1.0):
    """Proceeds for selling frac of my tokens with `comp` rivals selling the same
    size in the same block, my position among them = slot_out."""
    ctax = P["ctax"]; ff = (FEE + ctax) / 10000
    tok = P["tok"] * frac
    # rivals sell a position sized like theirs (rival_x at entry price), not like mine
    rtok = tok * (P.get("rival_x", P["X"]) / P["X"])
    proceeds = None
    for i in range(P["comp"] + 1):
        tk = tok if i == P["slot_out"] else rtok
        gross = q * tk / (t + tk); q -= gross; t += tk
        if i == P["slot_out"]: proceeds = gross * (1 - ff)
    return proceeds

def evaluate(P, rule, exit_lag=2, hold=1200):
    """rule(ctx) -> None | (frac_to_sell, reason). ctx has off, m, peak, held_frac,
    sold_frac. Selling is executed exit_lag blocks after the trigger, at that state.
    Returns dict(pnl, mult, hold_off, reason)."""
    pts = P["pts"]; X = P["X"]
    peak = 1.0; held = 1.0; proceeds = 0.0
    pending = []  # (exec_off, frac, reason)
    reason = None; last_off = 0
    n = len(pts)
    i = 0
    exits = []
    def do_sell(off, frac, why, q, t):
        nonlocal held, proceeds
        frac = min(frac, held)
        if frac <= 0: return
        # scale sell_value: it sells P.tok*frac
        p = sell_value(P, q, t, frac)
        proceeds += p; held -= frac
        exits.append((off, frac, why))
    for (off, m, q, t, grad, ev) in pts:
        # execute pending sells whose time has come
        while pending and pending[0][0] <= off:
            eo, fr, why = pending.pop(0)
            do_sell(off, fr, why, q, t)
        if held <= 1e-12: break
        if off >= hold:
            do_sell(off, held, "time", q, t); break
        if grad:
            do_sell(off, held, "grad", q, t); break
        if m > peak: peak = m
        if not pending:
            r = rule(dict(off=off, m=m, peak=peak, held=held, ev=ev, tok=P["tok"], t=t))
            if r:
                fr, why = r
                pending.append((off + exit_lag, fr, why))
        last_off = off
    if held > 1e-12:
        off, m, q, t, grad, ev = pts[-1]
        do_sell(off, held, "end", q, t)
    pnl = proceeds - X - GAS_BUY - GAS_SELL * max(1, len(exits))
    return dict(pnl=pnl, mult=proceeds / X, off=exits[-1][0] if exits else 0, reason=exits[-1][2] if exits else "?", exits=exits)
