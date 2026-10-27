# Indicator experiment: better loss control, no validated replacement

The existing score can rise without new profit. Several replacement guards made money
in the main replay, but their gains depended on capturing its early profitable segment.
Every later-start check of the staged policies lost money. No live code, settings,
stake, stop or accounting period was changed.

The evidence ends at **11 September 2026, 12:44:12.950 UTC**. The common account comparison
starts exactly 48 hours earlier. The final six hours were reserved from selection and
cost fitting. Previously inspected observations remain retrospective.

The full report (unavailable historical artifact: `../data/research/20260911-indicator-results/report.md`) contains every
candidate, execution assumption, time bin, forward cohort and statistics denominator.
The [protocol](INDICATOR_POLICY_PROTOCOL_20260911.md) records the design and the
attribution controls added before inspecting candidate returns. Start-date stress was
added afterward to challenge the best-looking capped result. It did not tune a policy.

## What the indicator gets wrong

The 20-launch window has a changing duration. Its span in minutes, sampled once per
minute when fresh, was **mean 63.95 / median 46.79 / sample SD 41.01 / n 2,780**.
Twenty launches can describe a different market period when activity slows.

Of **563 reconstructed positive score updates, 312 added nonpositive net return**.
An old loss leaving the window can make a new losing outcome look like recovery.
These are reconstructed updates, not 563 recorded live reopenings.

The matched shadow result arrived **97.10 seconds after entry on average**
(median 95.96, sample SD 27.65, n 679). After the modeled trade had already closed,
publication still took **mean 71.87 / median 68.56 / sample SD 31.33 seconds / n 679**.
Reducing a moving window cannot remove that observation delay.

The native score uses fixed 1.75x exits and a broader population than the account
actually admits. The replacement measurements use independently modeled net returns,
the captured stake and book configuration, and each launch's TP frozen at entry.
The actual trading TP and entry filters remain the same across all candidate accounts.

## Main account comparison

These are simulated cash results except for the explicitly labeled actual row.
Gas is included. Drawdown measures cumulative closed cash across accounting resets.

| Account or guard | Attempts | Net ETH | Drawdown ETH |
| --- | ---: | ---: | ---: |
| Actual guarded account | 87 | -0.17073 | 0.17073 |
| Existing guard, simulated | 84 | -0.17948 | 0.17948 |
| Continuous trading, all account stops removed | 686 | -0.10195 | 0.41251 |
| Recent matched profitability above zero | 127 | +0.03574 | 0.10779 |
| Recent profitability with staged exposure | 121 | +0.03582 | 0.05237 |
| Staged exposure with shared probe allowance | 38 | +0.06661 | 0.02943 |

The continuous reference retains filters, template-loss cooldown and capacity. It
removes manual, touch, drawdown and execution stops solely to show available market
opportunities. Every candidate account retains those other stops.

Account cash, indicators, evidence age and actual simulated admissions over 48 hours (unavailable historical artifact: `../data/research/20260911-indicator-results/indicator-48h.png`)

The 24-hour chart (unavailable historical artifact: `../data/research/20260911-indicator-results/indicator-24h.png`)
rebases each account at the beginning of the last day. Pale bands show account stop
permissions. Dark ticks show actual simulated admissions, including the effect of
probe budgets and other entry checks.

## Verdict for each mechanism

| Candidate or control | Net ETH | Verdict |
| --- | ---: | --- |
| Keep an existing stale pause | -0.16794 | Avoided some loss here, but did not improve the reserved net result. |
| Native 20 with candidate freshness/publication | -0.16794 | Matches the stale-hold result in this capture; useful comparison control. |
| Native window 10 | -0.04019 | Less loss, still unprofitable. A shorter window is not enough. |
| Native window 40 | -0.00089 | Only one attempt. Mostly staying stopped is not recovery-capture evidence. |
| Fixed TP with actual-sized net execution | -0.17971 | Execution adjustment alone did not improve this account comparison. |
| Fixed TP on shadow-admitted coins | -0.03812 | Population matching helped this replay, but remained unprofitable. |
| Adaptive TP on the same shadow-admitted coins | -0.18469 | TP matching alone made this guard comparison worse. |
| Matched 20 with a zero-profit boundary | -0.05995 | Better than keeping the old thresholds on matched returns, still negative. |
| Native exponential weighting | -0.02292 | Less loss; adding a publication delay worsened its result. |
| Matched exponential weighting, old thresholds | -0.05987 | Unprofitable centrally; execution assumptions changed its sign. |
| Recent matched profitability above zero | +0.03574 | Promising main result, but a slower half-life turned it negative. |
| Direction required at reopening | +0.03371 | Did not improve on recent profitability alone. |
| Direction also triggers retreat | +0.03138 | An extra minute of publication delay turned it negative. |
| Staged exposure | +0.03582 | Reduced drawdown across tested assumptions; later-start scenarios still lost. |
| Staged exposure plus shared probe allowance | +0.06661 | Strongest main historical result; stopped early and failed later-start profit checks. |

Comparing the fixed and adaptive matched indicators changes the sensor, not the bot's
actual exit rule. It does not establish that switching the trading TP to 1.75x would
improve earnings. Weighting comparisons also change evidence freshness requirements;
they do not identify a pure smoothing effect.

The recent-profit guard had **13 losing recovery episodes**, against **9 for baseline**.
Staging had 15, despite smaller total losses. The capped version had 3, but made no
trades in the reserved period. No candidate passed every registered acceptance check.

## Why the capped result is not a durable profit policy

The staged policy uses quarter size, then half size, then normal size. Each increase
requires three completed probe trades with positive aggregate net cash. Only one probe
can be open at a time. The positive recent-profit signal must still permit entry.

The capped version shares a **0.02 ETH gross probe-loss allowance** across recoveries.
It reserves the next probe's whole stake and estimated gas. Profitable trades and
market restarts do not refill that allowance. Full-size trades remain governed by the
existing account drawdown stop, so the probe allowance is not a total-account loss cap.

Its last main-path admission was **9 September at 17:42:24 UTC**, after about five hours
of the 48-hour interval. It had lost 0.01532 ETH on probes. The remaining allowance
could not fund another 0.005 ETH probe plus gas. It then stayed out for roughly 43 hours.

Both staged versions lost money in all **seven overlapping later-start scenarios**.
The capped losses ranged from 0.00187 to 0.00630 ETH. These are not seven independent
trials; several starts share the same subsequent operator restart. The rows are separate
hypothetical inception dates, not permission to reset the live allowance.

This evidence supports controlled early exposure as a loss-management idea. It does
not establish a repeatable way to profit from every recovery.

## Does a positive reading predict subsequent profit?

For the fit period, the subsequent non-overlapping 15-minute entry cohorts following a
positive recent-profit reading earned **mean +0.00150 ETH / median -0.00002 /
sample SD 0.01906 / n 62**. Thirty of those 62 cohorts were profitable.

In the reserved period, the corresponding result was **mean -0.00345 ETH /
median -0.00413 / sample SD 0.01652 / n 8**. Only 2 of 8 cohorts were profitable.
The indicator's favorable fit-period relationship did not carry into that small
reserved sample. Direction did not resolve the problem.

## Verification and limits

- The fresh preparation covers 437 of 437 launch paths, with all parameters and zero
  timestamp conflicts. Nine of nine requested receipts were available.
- Quarter and half stakes were replayed independently for 1,213 eligible launches under
  three sell delays. No smaller-stake return was obtained by scaling full-size cash.
- All 51 main account paths are complete. Missing signal publication remains explicit
  for 6 of 758 warmup-plus-study shadow admissions. No missing return becomes zero.
- The formal cash-fidelity validation (unavailable historical artifact: `../data/research/20260911-indicator-fidelity-final/report.md`)
  passed 18 of 57 checks. The default account engine still reproduces the archived run
  exactly, but execution prediction and real account selection remain inaccurate.
- For the 87 actual attempts in this 48-hour window, independent predictions totaled
  -0.19725 ETH against actual -0.17073 ETH. Absolute return error in percentage points
  of stake was mean 7.80 / median 0.62 / sample SD 14.85 / n 87.
- The last 24 hours are reported in eight bins and seven days in seven bins. Earlier
  simulated bins are unavailable outside the common complete account interval. Older
  actual cash is labeled outside the current policy era.
- Sell delays, signal half-lives, publication delay and inception dates were stressed.
  There are no prospective predictions or a passing realism certificate.
- The final research suite passed 191 tests. Input hashes, cash identities, causal
  availability and chart checks are recorded in the generated verification artifact.

The practical measurement proposal is to show two explicitly labeled series: the
fixed-target market reference and the configured strategy's net shadow returns.
Replacing the live trigger with a matched 20-trade sum is not supported by this study.
Earlier staged entries remain a research candidate, not an approved live policy.
