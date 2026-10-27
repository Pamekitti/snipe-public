> Historical record. This document describes its dated development or deployment window. Snipe was retired on 25 October 2026.

# Guard strategy audit, 7 September 2026

A faster market pause is the leading candidate. The data does not establish an optimal live strategy.

The candidate selected without the final six hours uses a **20-launch market window**, pauses below **-1 stake**, and reopens above **+1 stake**. Keep the **0.06 ETH drawdown stop** and its **20-launch, above-zero restart rule** as the comparison baseline. One stake means one trade's 0.02 ETH spend. These signal stakes are simulated returns, not money received by the wallet.

A 30-launch pause performed almost identically. The evidence supports a shorter market window more than a precise threshold. I recommend freezing the 20-launch candidate for a prospective comparison against the current policy and the 30-launch alternative. This report does not authorize a live risk change.

## What the comparison found

Snapshot: **2026-09-07 11:24:05 UTC**. Primary era: **2026-09-06 22:06:01 UTC onward**, covering **101 closed main trades at 0.02 ETH**. The final six hours start at **05:24:05 UTC**. All 101 trades have receipt-backed booked P&L.

The table applies each policy consistently from the era start. It retains or removes actual trades and includes wallet costs. It cannot reproduce executions the historical bot never attempted. The current-rules row is therefore a hypothetical comparison, not the actual account result under the settings that changed overnight.

| Policy | Trades retained / 101 | Net P&L, ETH | Worst drawdown, ETH | Final six hours, ETH |
|---|---:|---:|---:|---:|
| Current rules, replayed from the era start | 78 | +0.08225 | 0.13950 | -0.06655 |
| 20-launch pause, stop below -1, reopen above +1 | 46 | +0.15309 | 0.06867 | -0.01904 |
| 30-launch pause, stop below -2, reopen above +1 | 57 | +0.15260 | 0.06916 | -0.01904 |
| Current pause, drawdown restart above +2 | 78 | +0.08225 | 0.13950 | -0.06655 |
| Current pause, no automatic drawdown restart | 67 | +0.14881 | 0.07295 | +0.00000 |
| Recorded trades, no additional exclusions | 101 | +0.03609 | 0.18567 | -0.09037 |

The selected candidate's conditional improvement over the current-rules baseline is **0.07083 ETH**. Its worst drawdown falls from **0.13950 to 0.06867 ETH**, about **51%**. The 30-launch alternative finishes only **0.00049 ETH** below it. Those are comparisons on recorded cash flows, not forecasts of future profit.

Conditional guard comparison (unavailable historical artifact: `research/guard-audit-20260907.png`)

The selected candidate retains 46 trades. Their return has mean **+16.64%**, median **-5.09%**, sample standard deviation **76.87 percentage points**, and **n=46**. The current-rules comparison retains 78: mean **+5.27%**, median **-5.73%**, standard deviation **63.31 points**, **n=78**. Winners and losses cluster in time; 101 trades are not 101 independent market regimes.

## Why the current pause reacts slowly

The current market pause needs 60 qualifying launches inside three hours. In this era it had fresh evidence on only **158 of 1,597 simulated checks, 9.9%**. It never paused in the current-rules replay. The 20-launch version had fresh evidence on **1,398 of 1,597 checks, 87.5%**.

The 20-launch pause first closes at about **01:11 UTC**, then reopens at **08:02 UTC**. The 30-launch version first closes around **02:14 UTC**. Its later reopening partly comes from evidence becoming stale, which is a live behavior the old backtest missed.

This also explains why simply bringing two numbers closer together is not enough. Raising the pause floor stops sooner. Lowering the reopen line makes restarting easier. The selected market-pause pair, -1 and +1, changes both the window and the evidence required on each side.

The drawdown stop has a separate restart rule. Raising that restart threshold from zero to +1 or +2 retained exactly the same recorded trades in the primary comparison. Those changes shift the restart time but do not remove the subsequent observed losing sequence. When missing fills are added as scenarios, the thresholds can matter, which is another reason not to infer equivalence in production.

Every drawdown restart resets its accounting peak. A 0.06 ETH stop does not cap cumulative loss across restarts. Positions already open can also push an episode beyond the threshold while they finish exiting.

## What made the old backtest unreliable

The legacy `guardgrid.py` is now marked unsuitable for policy selection. Its historical claims remain as an experiment record. The replacement addresses these problems:

1. **Selection saw the supposed holdout.** The old rankings used the whole trade list, including the final six hours. The new selector stops at the fitting boundary and carries the selected policy's existing state through evaluation.
2. **Trade populations were mixed.** The old query admitted different sizes and did not explicitly exclude probes or non-live rows. Scaling a 0.0025 ETH result to 0.02 ETH does not reproduce curve impact. No earlier-size profit enters the primary selection.
3. **Recovery timing was wrong.** The old simulator used five-minute ticks and also checked recovery at unrelated trade events. Recovery now runs on a 30-second clock, with timing sensitivities.
4. **Staleness was wrong.** The live venue can release a pause when its window goes stale, while retaining its internal threshold state. The old simulation could keep that pause in place. The replacement evaluates expiry between new observations.
5. **Initial losses were understated.** The old maximum-drawdown calculation initialized the peak at the first cash-flow point. The replacement starts at zero and continues counting losses across accounting resets.
6. **The money missed approval costs.** The audit includes the measured wallet residual described below. It still uses the booked ledger to model the production stop, because that is the ledger the live implementation checks.
7. **Historical observation timestamps were partly invented.** The wide tape assigns a median scoring delay to old reconstructed rows. Primary signals now use actual observer scoring timestamps only.

The replacement still cannot reconstruct historical receipt-correction times, every in-process touch-gate decision, or the market response to different orders. Its cash-flow comparison is conditional. The earlier claim that deleting observed trades gives mathematical upper and lower profit bounds was not justified.

## The replay is not currently twice as optimistic

My earlier answer repeated an old calibration claim. It does **not** describe the current 101-trade sample. At each trade's actual take-profit target:

| Matched measure | n | Mean return, % | Median return, % | Sample sd, percentage points |
|---|---:|---:|---:|---:|
| Actual, including wallet costs | 101 | +1.79 | -6.50 | 57.14 |
| Observer replay, matched exit target | 101 | +1.21 | -6.58 | 56.73 |
| Replay minus actual, percentage points | 101 | -0.58 | -0.61 | 18.06 |

Replay and actual disagree on profit versus loss for **6 of 101 trades**. Replay is positive while actual is non-positive in **3 of 101**. The overall bias is small relative to the **18.06-point** standard deviation of individual replay errors. This supports using the observer as evidence about the venue. It does not certify different exits, sizes, or recovery predictions.

The primary cohort contains **174 screened launches passing the tax and exemption filters**, of which **164 have a usable recorded observer outcome**. Their scoring delay has mean **117.3 seconds**, median **107.5 seconds**, standard deviation **56.3 seconds**, **n=164**. A market pause therefore reacts to delayed outcomes even with a shorter window.

The three existing sequence caches contain **no raw sequences for the 101 primary trades**. Their observer summaries are available, but a full alternate-entry or alternate-exit execution replay at 0.02 ETH cannot be verified from those caches. The old 99% wide-tape coverage claim does not solve this current-era gap.

## Wallet reconciliation

Between matching flat samples at **22:05:50 UTC on 6 September** and **11:24:03 UTC on 7 September**:

| Measure | ETH |
|---|---:|
| Booked P&L, using `COALESCE(onchain_pnl_wei, pnl_wei)` | +0.03772512 |
| Actual wallet change | +0.03608754 |
| Wallet costs absent from the book | -0.00163759 |

All of the residual falls in **88 intervals containing the 101 trades**. There is no residual in intervals without trades. **79 intervals contain one trade**, so that allocation is exact. The other **nine intervals contain 22 trades**; their residual is split evenly within each interval for the comparison.

For position 2001, the approval transaction's fee is **0.00001682882658 ETH**. Its receipt exactly matches the isolated wallet residual. The live receipt-backfill code adds buy, sell, and recorded reverted-sell gas but omits that approval leg. The measured residual is consistent with this omission throughout the era; only the first approval was independently fetched in this audit.

Allocated extra cost per trade has mean **0.000016214 ETH**, median **0.000016524 ETH**, standard deviation **0.000000782 ETH**, **n=101**. These costs are charged in research performance. The production accounting omission remains unresolved by this research change.

## Validation and uncertainty

**The recorded event matches.** At the actual 09:46:33 restart, the reconstructed signal is **+1.81313 stakes over 20 launches**. The live log says +1.81. The subsequent simulated stop lands at 10:51:09, versus the recorded halt at 10:51:33. The 24-second difference is consistent with the missing receipt-correction and reporting times. All 11 post-restart trades are retained in this isolated event check. Their wallet loss is **0.066553 ETH**.

**Selection is separate, but the recent outcome was already known.** The grid contains **144 candidates**. Fitting uses only the first approximately 7.3 hours. **27 candidates tie for best fitting P&L**. The selector breaks that tie by closeness to the current configuration, which preserves the 0.06 ETH stop and 20/0 drawdown restart.

Looking at the whole period afterwards makes a **0.05 ETH stop** with the 20-launch pause look best: about **+0.17113 ETH** and **0.05063 ETH** worst drawdown. Nine restart combinations tie there. Choosing that setting now because it wins the already-known final period would repeat the selection mistake. It is a hindsight result, not an independent recommendation.

**Forward checks are sparse.** There are only two complete three-hour expanding-window evaluations after six hours of training. The selected policy and baseline both sit out the first. Both take the same one losing trade in the second. Their separation in the recent period occurs later, during the remaining partial period. There are not enough independent evaluation days to certify the result.

**Timing tests preserve the direction.** Across check phases, 60/180-second observation delays, immediate venue refresh, and a five-point adverse signal perturbation, the selected candidate's conditional P&L ranges from **+0.15111 to +0.15661 ETH**. Worst drawdown ranges from **0.06515 to 0.07065 ETH**. The adverse perturbation is an assumed stress, not a measured transaction cost.

**The stricter history subset remains negative.** Starting the comparison afresh at the 01:21 deployment boundary gives the current rules **-0.12016 ETH** and the selected candidate **-0.06655 ETH**. The candidate still loses money. The initialization change demonstrates why the full-era positive total must not be confused with evidence that today's market is profitable.

**Missing trades can change the answer.** The real bot rejected 32 qualifying launches at a halt check. The primary candidate could admit 16 of them; its current-rules comparator could admit 17. None has an actual bot fill. Their returns would affect later stops and capacity, so even common missing entries cannot simply cancel out of the comparison.

A separate scenario test adds all 32 opportunities using observer returns at a causally chosen adaptive target. It assumes a 45-second hold and shifts their returns by -20, zero, or +20 percentage points. This uses a 0.01 ETH observer proxy for a 0.02 ETH fill and is explicitly **not a realistic execution forecast**.

| Missing-fill return assumption | Current rules, ETH | 20-launch candidate, ETH | 30-launch alternative, ETH |
|---|---:|---:|---:|
| Proxy minus 20 percentage points | +0.06163 | +0.12525 | +0.12394 |
| Proxy unchanged | +0.12622 | +0.14978 | +0.15247 |
| Proxy plus 20 percentage points | +0.19422 | +0.21037 | +0.21706 |

The shorter pause beats the current pause in these scenarios, but 20 versus 30 swaps places. No automatic restart beats both under some assumptions. This prevents a claim of a unique optimum.

A descriptive resampling of five three-hour blocks puts the candidate-minus-baseline difference in a 90% band of roughly **+0.00097 to +0.14301 ETH**. The blocks are few, dependent, and used after selection. This is **not** a valid significance claim. Backtest selection itself can produce apparent winners, even with conventional holdout methods. [Bailey et al., The Probability of Backtest Overfitting](https://scholarworks.wmich.edu/math_pubs/42/)

## Decision and next evidence

Freeze this challenger for the next prospective comparison:

| Setting | Current | Challenger |
|---|---:|---:|
| `VENUE_PAUSE_WINDOW` | 60 | **20** |
| `VENUE_PAUSE_OFF` | -4 | **-1** |
| `VENUE_PAUSE_ON` | +0.5 | **+1** |
| `VENUE_FRESH_H` | 3 | 3 |
| `MAX_DRAWDOWN_ETH` | 0.06 | 0.06 |
| `DD_RESUME_WINDOW` | 20 | 20 |
| `DD_RESUME_ON` | 0 | 0 |

Use the 30/-2/+1 market pause as the neighboring alternative. Keep current entry filters, adaptive exits, and stake fixed during that comparison. This audit supports advancing a faster pause; it does not establish an optimal full entry/exit/size strategy.

The next evidence must include launches rejected by each policy, raw chain sequences at the current size, observed signal availability, and approval costs. Freeze the policies before collecting that evidence. Evaluate disjoint future periods that include both deteriorations and recoveries. Five complete evaluation days is a minimum collection floor, not a guarantee of statistical power. Do not retune on the evaluation days and continue calling them independent.

No live configuration, accounting epoch, or trading process was changed by this audit.

## Current-era windows ending at the snapshot

Returns below include the allocated wallet costs. Standard deviation is the sample standard deviation. Earlier eras are unavailable in these tables, rather than treated as zero-profit periods.

### Last 24 hours, eight three-hour bins

| UTC interval | n | Net ETH | Mean return, % | Median return, % | sd, percentage points |
|---|---:|---:|---:|---:|---:|
| 09-06 11:24 to 09-06 14:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-06 14:24 to 09-06 17:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-06 17:24 to 09-06 20:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-06 20:24 to 09-06 23:24 (partial era) | 19 | +0.17721 | +46.64 | +38.98 | 86.87 |
| 09-06 23:24 to 09-07 02:24 | 33 | -0.00557 | -0.84 | -9.58 | 59.08 |
| 09-07 02:24 to 09-07 05:24 | 28 | -0.04519 | -8.07 | -4.26 | 22.68 |
| 09-07 05:24 to 09-07 08:24 | 10 | -0.02382 | -11.91 | -18.97 | 24.01 |
| 09-07 08:24 to 09-07 11:24 | 11 | -0.06655 | -30.25 | -21.44 | 23.52 |

### Last seven days, seven daily bins

| UTC interval | n | Net ETH | Mean return, % | Median return, % | sd, percentage points |
|---|---:|---:|---:|---:|---:|
| 08-31 11:24 to 09-01 11:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-01 11:24 to 09-02 11:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-02 11:24 to 09-03 11:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-03 11:24 to 09-04 11:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-04 11:24 to 09-05 11:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-05 11:24 to 09-06 11:24 | unavailable | n/a | n/a | n/a | n/a |
| 09-06 11:24 to 09-07 11:24 (partial era) | 101 | +0.03609 | +1.79 | -6.50 | 57.14 |

## Reproduction and checks

- Protocol: [GUARD_AUDIT_PROTOCOL.md](../v1/research/GUARD_AUDIT_PROTOCOL.md).
- Instrument: [guard_audit.py](../v1/research/guard_audit.py).
- Regression checks: [test_guard_audit.py](../v1/research/test_guard_audit.py), **16 passed**.
- Existing repository suite: **642 tests passed across 45 files**; typecheck passed.
- Frozen inputs, results, and sampled approval receipt: `v1/data/guard-audit-20260907/` on this laptop. Raw data stays outside git.
- Snapshot SHA-256: `4870f4a95db5ff39df932a4877d745a2574fb9f06ef293ecb08787a9fa05806c`.
- Protocol SHA-256: `e7cb465f2af7faff967f650b132b0c7252c34b72dfc44cb2afb762919dad797d`.

From the repository root:

```sh
python3 -m unittest discover -s bot/research -p 'test_guard_audit.py'
python3 v1/research/guard_audit.py \
  --snapshot v1/data/guard-audit-20260907/snapshot.json.gz \
  --out v1/data/guard-audit-20260907/results.json
```
