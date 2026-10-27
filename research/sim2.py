"""Path-level simulator built on realistic.py's exact curve replay.

Instead of baking the exit rule into the replay, record the post-entry price path
(one point per event, plus a synthetic point every second so a rule can act between
events) and let a rule function decide. Rules can exit fully or partially.

Same frictions as realistic.py: N rival bots of my size enter in my block ahead/behind
me at random, a haircut on post-entry buy flow, and an exit lag in blocks.
"""
from realistic import *
import engine
import random

def path(l, X, entry_blk=20, comp=2, haircut=0.10, horizon=3000, tick=10, rival_x=None):
    """Thin wrapper binding the data-independent engine to the loaded dataset."""
    return engine.path(l, X, build_seq(l), CTAX[l["token"]], entry_blk=entry_blk,
                       comp=comp, haircut=haircut, horizon=horizon, tick=tick, rival_x=rival_x)




def trail_rule(trail=0.3, arm=1.2, sl=0.6):
    def r(c):
        if c["m"] >= arm and c["m"] <= c["peak"] * (1 - trail): return (c["held"], "trail")
        if c["m"] <= sl: return (c["held"], "sl")
        return None
    return r

def run_paths(paths, rule, exit_lag=2, hold=1200, capital=None, X=None, miss=0.05, revert=0.05, seed=7):
    """Bankroll-aware aggregation, same conventions as realistic.run."""
    rnd = random.Random(seed)
    res = []; open_pos = []; skipped = missed = reverted = 0; gasburn = 0.0
    for P in sorted(paths, key=lambda p: p["l"]["block"]):
        if rnd.random() < miss: missed += 1; continue
        entry = P["l"]["block"] + 20
        Xp = P["X"]
        if capital is not None:
            open_pos = [p for p in open_pos if p > entry]
            if (len(open_pos) + 1) * Xp > capital: skipped += 1; continue
        if rnd.random() < revert: reverted += 1; gasburn += GAS_BUY; continue
        r = evaluate(P, rule, exit_lag=exit_lag, hold=hold)
        res.append((P["l"], r))
        if capital is not None: open_pos.append(entry + r["off"])
    if not res: return dict(n=0, rot=0, per_day=0, win=0, outcomes={})
    tot = sum(r["pnl"] for l, r in res) - gasburn
    Xs = sum(P["X"] for P in paths) / len(paths)
    byday = collections.defaultdict(float)
    for l, r in res: byday[DAY[l["token"]]] += r["pnl"] * ETHUSD
    return dict(n=len(res), rot=tot / sum(1 for _ in res) / Xs, total_usd=tot * ETHUSD,
                per_day=tot * ETHUSD / max(1, len(byday)), win=sum(1 for l, r in res if r["pnl"] > 0) / len(res),
                outcomes=dict(collections.Counter(r["reason"] for l, r in res)), byday=dict(byday),
                skipped=skipped, missed=missed, reverted=reverted, res=res)
