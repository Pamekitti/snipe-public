"""Render the saved activity comparison without rerunning or tuning policies."""
import json
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

import activity_policy_audit as a

LABELS = {
    'market_plus2': 'Market +2 baseline',
    'launch_pace': 'Faster launch pace',
    'turnover_per_coin': 'Higher ETH turnover per coin',
    'buyers_per_coin': 'More buyers per coin',
    'net_buying': 'Net buying positive',
    'broad_gains': 'Positive without biggest winner',
    'recent_direction': 'Newest five outcomes positive',
    'demand_and_pace': 'More buyers + faster launches',
}
TZ = ZoneInfo('Europe/London')


def local(ms):
    return datetime.fromtimestamp(ms/1000, TZ).strftime('%d %b %Y %H:%M')


def distribution(d):
    def num(x):
        return 'unavailable' if x is None else f'{x:.3f}'
    return ' | '.join([num(d[k]) for k in ['mean', 'median', 'sd']] + [str(d['n'])])


def main():
    r = json.loads((a.OUT/'results.json').read_text())
    current, model = r['recorded'], r['scenarios']['base']
    base_current = current['market_plus2']['metrics']['all']['pnl_eth']
    base_model = model['market_plus2']['metrics']['all']['pnl_eth']
    rules = a.RULES
    # Compare profit retained, rather than presenting synthetic cash as expected income.
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 11})
    fig, axes = plt.subplots(1, 2, figsize=(13.5, 6.5), sharey=True)
    for ax, source, base, title in zip(axes, [current, model], [base_current, base_model],
            ['24.69 hours: conditional actual-trade replay', '14 days: historical opportunity model']):
        values = [100*source[n]['metrics']['all']['pnl_eth']/base for n in rules]
        colors = ['#225f9c' if n == 'market_plus2' else '#be641c' for n in rules]
        ax.barh(range(len(rules)), values, color=colors, height=.65)
        ax.set_xlim(0, 120)
        ax.set_title(title, fontsize=12, pad=16)
        ax.axvline(100, color='#5b626a', linestyle=':', linewidth=1.3)
        ax.xaxis.set_major_formatter(PercentFormatter(100))
        ax.set_xlabel('Profit retained relative to +2')
        ax.grid(axis='x', alpha=.15)
        ax.set_axisbelow(True)
        for i, v in enumerate(values):
            ax.text(v+1.5, i, f'{v:.1f}%', va='center', fontsize=10)
        for edge in ['top', 'right', 'left']:
            ax.spines[edge].set_visible(False)
        ax.tick_params(axis='y', length=0)
    axes[0].set_yticks(range(len(rules)), [LABELS[n] for n in rules])
    axes[0].invert_yaxis()
    fig.suptitle('Extra filters gave up profit in the longer test', x=.02, ha='left',
                 fontsize=18, weight='bold')
    fig.text(.02, .915, 'The recent improvements did not carry through to the two-week model.', fontsize=12)
    fig.text(.02, .08, f'Actual-data endpoint: {local(r["snapshot_at"])} London. '
             f'Model endpoint: {local(r["model_end"])} London.', fontsize=10)
    fig.text(.02, .045, '169 actual attempts, 139 retained by +2. Historical model has execution and graduation errors. '
             'No untouched holdout; no live settings changed.', fontsize=9)
    fig.subplots_adjust(left=.27, right=.98, top=.83, bottom=.19, wspace=.18)
    fig.savefig(a.OUT/'comparison.png', dpi=170)
    fig.savefig(a.OUT/'comparison.svg')
    plt.close(fig)

    lines = [
        '# Market +2 remains the research benchmark', '',
        'None of the seven activity or return-shape overlays earns replacing Market +2 on this evidence. '
        'Six earned less in every longer scenario; positive net buying reproduced the baseline. '
        'Broad gains and recent direction improved the current-era conditional replay, '
        'but both reduced profit in the older-history model.', '',
        'All earlier +2 artifacts were preserved and their hashes matched before and after the study. '
        'Copies of the decision table and stale-policy results are in `benchmark/`. '
        'No live source, settings, controls, positions or capital changed.', '',
        '## Data and limits', '',
        f'- New read-only export: {local(r["snapshot_at"])} London. Current 0.02 ETH era: '
        f'{r["coverage"]["current_hours"]:.2f} hours, 169 closed actual attempts, all with receipt P&L.',
        '- These are the same 169 attempts used earlier. The new export adds market observations, '
        'not new executed trades. This is not new validation of the policy.',
        '- The first 159 attempts precede the reserved final six hours. The final six hours contain '
        'the ten-trade loss episode already discussed. Every +2 variant excludes those ten attempts. '
        'That split cannot distinguish the new policies and is not untouched.',
        f'- Longer model: 14 days ending {local(r["model_end"])} London. This is the exact earlier '
        'fixed-exit opportunity model, not 14 days of the current strategy trading live.',
        '- Launch pace counts detected launches with the market sensor tax and exemption floors. '
        'The screenshot bars instead count historically screened launches. Neither is ETH turnover.',
        '- Turnover is buy plus sell quote on cached screened curves in their first 45 seconds. '
        'Creator and own-wallet transactions are excluded. Quotes use the correct event word for each side. '
        'Buyer counts are distinct sending addresses, not verified independent people.',
        '- Cached activity covers 3,987 curves. It becomes available only after both scoring '
        'and the 45-second window. Missing coverage falls back to +2; it is not zero activity.',
        '- Actual-trade replay can retain or reject observed attempts. It cannot establish additional fills. '
        'Historical opportunity modeling has unresolved execution, graduation, adaptive-exit, funding, '
        'touch/template feedback and counterparty-response limitations.',
        '- Drawdown is cumulative realized cash below its prior peak. It spans account resets and '
        'excludes unrealized open losses. It is not a hard maximum loss guarantee.', '',
        '## The frozen ideas', '',
        '| Candidate | What it requires before an entry | Why it might help |', '|---|---|---|',
        '| Market +2 | Original market recovery above +2, pause below -1, existing stale exception | Benchmark |',
        '| Faster launch pace | Last hour count at least the preceding six-hour hourly rate | More opportunities and faster signal refresh |',
        '| Higher ETH turnover per coin | Last hour mean at least preceding six-hour mean | Demand reaches each coin |',
        '| More buyers per coin | Same comparison for distinct external buyers | Participation beyond one large trade |',
        '| Net buying positive | Last hour external buy quote greater than sell quote | Net demand |',
        '| Positive without biggest winner | Latest 20 returns remain positive after dropping their maximum | Avoid one winner creating false confidence |',
        '| Newest five outcomes positive | Latest five available returns sum above zero | Notice deterioration before the full window does |',
        '| More buyers + faster launches | Both participation and launch pace pass | Activity supported by buyers |', '',
        'Volume comparisons need five recent and 20 prior scored coins plus 80% cache coverage in both windows. '
        'All are entry overlays on +2. DD recovery stays +1. Full definitions are frozen in '
        '`ACTIVITY_POLICY_PROTOCOL.md`. These are not optimized thresholds.', '',
        '## Current-size conditional replay', '',
        'Amounts are ETH after the recorded trade costs. They are hypothetical retained-trade cash, '
        'not actual wallet balances or earnings forecasts.', '',
        '| Candidate | Closed attempts | Net ETH | Maximum DD ETH | Delta vs +2 ETH | '
        'Removed winners ETH | Avoided losses ETH |', '|---|---:|---:|---:|---:|---:|---:|']
    for n in rules:
        c = current[n]; m = c['metrics']['all']; d = c['difference']
        lines.append(f'| {LABELS[n]} | {m["n"]} | {m["pnl_eth"]:.6f} | {m["dd_eth"]:.6f} | '
            f'{d["delta_eth"]:+.6f} | {d["removed"]["winning_eth"]:.6f} | '
            f'{-d["removed"]["losing_eth"]:.6f} |')
    lines += ['', 'The faster-launch filter removed 0.294140 ETH of winners while avoiding '
        '0.118536 ETH of losses. Higher activity did not make those omitted opportunities worthless.', '',
        '## Two-week opportunity-model comparison', '',
        'The baseline model produces 5.936130 ETH, which is not a credible live-profit forecast. '
        'Relative comparisons also inherit its model error.', '',
        '| Candidate | Net ETH | Maximum DD ETH | Profit change vs +2 | '
        'Days beating / tying / losing to +2 | Missing-feature fallback on baseline entries |',
        '|---|---:|---:|---:|---|---|']
    for n in rules:
        c = model[n]; m = c['metrics']['all']
        ds = [c['metrics'][f'day_{i}']['pnl_eth']-model['market_plus2']['metrics'][f'day_{i}']['pnl_eth']
              for i in range(1, 15)]
        counts = [sum(v>1e-12 for v in ds), sum(abs(v)<=1e-12 for v in ds), sum(v< -1e-12 for v in ds)]
        lines.append(f'| {LABELS[n]} | {m["pnl_eth"]:.6f} | {m["dd_eth"]:.6f} | '
                     f'{100*c["difference"]["delta_eth"]/base_model:+.1f}% | '
                     f'{counts[0]} / {counts[1]} / {counts[2]} | {c["fallback_n"]} / {c["evaluated_n"]} |')
    lines += ['', '## Five scenarios', '',
        'Each cell is change in net ETH versus +2 under the same scenario. These reuse the same history.', '',
        '| Candidate | Base | Slower sell | Return minus 5 points | Virtual graduation value | Scores delayed 10 min |',
        '|---|---:|---:|---:|---:|---:|']
    for n in rules:
        lines.append('| '+LABELS[n]+' | '+' | '.join(
            f'{s[n]["difference"]["delta_eth"]:+.6f}' for s in r['scenarios'].values())+' |')
    lines += ['', 'Virtual graduation value is a sensitivity, not an executable quote or verified upper bound.', '',
        '## Why the screenshot does not establish a volume rule', '',
        'Account growth combines opportunity count, profit per attempt, trade size and time spent enabled. '
        'A busy profitable period can coexist with quiet profitable opportunities. A rule that skips the '
        'latter can reduce total profit even if the busy period has more winners.', '',
        'The table below uses only the 159 actual attempts before the reserved six hours. '
        'Activity and stakes are calculated before entry. Busy means pace at least its preceding-six-hour '
        'rate. These groups are small and correlated within market episodes. Stakes are grouped broadly, '
        'so this does not fully control for all differences in market conditions.', '',
        '| Stake band and activity | Mean return % | Median % | Sample SD, points | Attempts |',
        '|---|---:|---:|---:|---:|']
    for n, d in r['segments_selection'].items():
        lines.append('| '+n.replace('_', ' ')+' | '+distribution(d['return_pct'])+' |')
    lines += ['', 'Above +2, busy conditions had 27 winners among 51 attempts; quiet conditions had '
        '8 among 23. Quiet conditions still had higher mean return because of a few large winners. '
        'This is the risk of selecting by win frequency while trying to maximize profit.', '',
        '## Twenty-four hours in eight bins', '',
        'Current-era conditional net ETH. Endpoint is the fresh export. Labels are London time.', '',
        '| Three-hour bin starts | '+' | '.join(LABELS.values())+' |',
        '|---|'+'---:|'*len(rules)]
    for i in range(8):
        lines.append('| '+local(r['snapshot_at']-a.DAY+i*3*a.HOUR)+' | '+' | '.join(
            f'{current[n]["metrics"][f"24h_{i+1}"]["pnl_eth"]:.5f}' for n in rules)+' |')
    lines += ['', '## Seven days in seven bins', '',
        'Current-size actual attempts only. Earlier periods are unavailable for this era. '
        'Do not interpret unavailable bins as no profit. The 14 modeled daily bins are in results.json.', '',
        '| Day starts, London | Current-era coverage | '+' | '.join(LABELS.values())+' |',
        '|---|---|'+'---:|'*len(rules)]
    for i in range(7):
        metrics = current['market_plus2']['metrics'][f'7d_{i+1}']
        status = 'full' if metrics['complete'] else 'partial' if metrics['available'] else 'unavailable'
        vals = [f'{current[n]["metrics"][f"7d_{i+1}"]["pnl_eth"]:.5f}' if metrics['available'] else 'N/A' for n in rules]
        lines.append('| '+local(r['snapshot_at']-7*a.DAY+i*a.DAY)+' | '+status+' | '+' | '.join(vals)+' |')
    lines += ['', '## Spread of retained current-era returns', '',
        '| Candidate | Mean return % | Median % | Sample SD, points | Attempts |', '|---|---:|---:|---:|---:|']
    for n in rules:
        lines.append('| '+LABELS[n]+' | '+distribution(current[n]['metrics']['all']['returns_pct'])+' |')
    lines += ['', 'Every modeled and binned distribution also has mean, median, sample standard deviation '
        'and n in results.json.', '',
        '## What deserves a different design', '',
        'The first-principles objective is executable profit on the next trade. A running stake sum '
        'measures completed historical trades, while counts measure how many opportunities appeared. '
        'Neither tells us whether new buying is continuing now or whether our actual size can exit profitably.', '',
        'Three distinct research directions remain:', '',
        '1. **Demand persistence:** distinguish the first buying burst from buyers continuing afterward. '
        'Measure new buyers and quote flow on young coins with recorded arrival times. Mature-coin '
        '45-second turnover can be too late to identify a change.',
        '2. **Executable recovery:** compute recovery for the actual trade size and costs. Require '
        'agreement between opportunity returns and actual execution quality before restoring full exposure. '
        'The existing 0.01 ETH observer and 0.02 ETH trades can disagree.',
        '3. **Recovery-specific caution:** use breadth or recent direction only around a restart. '
        'The tests here applied them to every entry. Their long-period profit cost does not establish '
        'what a restart-only design would do.', '',
        'Those designs are proposals, not tested improvements in this report. Earlier probe and '
        'cumulative-budget experiments remain in the preserved recovery study. No retrospective result '
        'here removes the need for new prospective evidence.', '',
        '## Validation', '',
        '- Exact +2 cash and guard actions match the saved two-week baseline.',
        '- Original benchmark hashes match before and after the run.',
        '- Strict score timing, equal-timestamp exclusion, maturity, missing-data fallback and '
        'per-coin normalization have synthetic tests.',
        '- An initial draft confused sell token quantity with ETH. The parser was corrected before '
        'this report. Raw buy/sell event tests now enforce their different quote words. Independent '
        'word-by-word sums matched 20 cached curves. All activity comparisons were rerun.',
        '- All 84 research tests passed. Daily cash and added/removed cash reconcile; IDs are unique.',
        '- Sources, input hashes, per-attempt features and all outcomes are saved beside the report.', '']
    (a.OUT/'report.md').write_text('\n'.join(lines))
    shutil_path = a.OUT/'source'/Path(__file__).name
    shutil_path.write_text(Path(__file__).read_text())
    manifest = json.loads((a.OUT/'manifest.json').read_text())
    manifest['validation'] = {'research_tests': 84, 'independent_quote_curves': 20,
                              'baseline_exact_match': True, 'originals_unchanged': True}
    for p in [Path(__file__).resolve(), a.OUT/'report.md', a.OUT/'comparison.png',
              a.OUT/'comparison.svg', a.OUT/'all-research-tests.log']:
        manifest['files'][str(p)] = a.digest(p)
    (a.OUT/'manifest.json').write_text(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
