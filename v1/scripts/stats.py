"""The statistics the research scripts kept re-implementing.

Five copies of med(), four block bootstraps and three max-drawdowns grew up across the
tp* scripts in one afternoon. One implementation also protects a policy decision: every
bootstrap in this project is a BLOCK bootstrap on the launch order, because launches
cluster in time and an iid resample prices that correlation as free precision.
"""

import random


def med(a):
    s = sorted(a)
    n = len(s)
    if not n:
        return float("nan")
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def pct(a, q):
    s = sorted(a)
    if not s:
        return float("nan")
    i = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[i]


def max_dd(pnls):
    """Deepest peak-to-trough dip on the running cumulative, in input units.

    Chronological order is the caller's job: a drawdown only means something in the
    order the trades actually happened.
    """
    peak = cum = worst = 0.0
    for p in pnls:
        cum += p
        peak = max(peak, cum)
        worst = max(worst, peak - cum)
    return worst


def block_boot(vals, stat=sum, n=4000, block=20, seed=11):
    """90% band on stat() under a block bootstrap of contiguous runs."""
    r = random.Random(seed)
    N = len(vals)
    if N < block * 2:
        return (float("nan"), float("nan"))
    out = []
    nb = max(1, N // block)
    for _ in range(n):
        s = []
        for _ in range(nb):
            i = r.randrange(0, N - block)
            s.extend(vals[i:i + block])
        out.append(stat(s))
    out.sort()
    return (out[int(0.05 * n)], out[int(0.95 * n)])
