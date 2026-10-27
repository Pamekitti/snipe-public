"""Static audit charts. Missing predictions never appear as zero-return trades."""
import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from .fidelity import cash_metrics


def report(output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as dates

    output = Path(output)
    read = lambda name: json.loads((output/name).read_text())
    data, rows, bundles = read('fidelity.json'), read('rows.json'), read('scenario-bundles.json')
    manifest = read('run-manifest.json')
    start, end, today = data['fromMs'], data['throughMs'], manifest['londonDayStart']
    utc = lambda at: dt.datetime.fromtimestamp(at/1000, dt.timezone.utc)
    eth = lambda wei: int(wei)/1e18
    actual = data['actualRows']
    day_rows = [r for r in actual if today <= r['at'] < end]
    modern = data['cohorts']['captured_intents']
    modern_n = len(modern['rows'])
    day_n = len(data['cohorts']['today_diagnostic']['rows'])
    day_ids = {r['id'] for r in data['cohorts']['today_diagnostic']['rows']}
    missing_day = [r for r in day_rows if r['id'] not in day_ids]
    cutoff = utc(end).strftime('%B %d, %H:%M UTC')+' / '+utc(end).astimezone(ZoneInfo('Europe/London')).strftime('%H:%M London')
    by_id = {r['id']: r for r in actual}
    scenario_ids = list(data['cohorts']['captured_intents']['scenarios'])
    colors = ['#b25d16', '#b25d16', '#8053b0', '#8053b0', '#287d83', '#287d83']
    plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False})

    def curve(ax, points, begin, label, color, style='-', width=1.5):
        total = 0
        xx, yy = [utc(begin)], [0]
        for at, value in sorted(points):
            total += int(value)
            xx.append(utc(at)); yy.append(eth(total))
        xx.append(utc(end)); yy.append(eth(total))
        ax.step(xx, yy, where='post', label=label, color=color, ls=style, lw=width)

    fig, axes = plt.subplots(2, 1, figsize=(12, 8), constrained_layout=True, sharex=True)
    curve(axes[0], [(r['at'], r['pnl']) for r in actual], start, 'Actual booked cash', '#243746', width=2)
    total = peak = 0; xx, yy = [utc(start)], [0]
    for r in sorted(actual, key=lambda r: (r['at'], r['id'])):
        total += int(r['pnl']); peak = max(peak, total)
        xx.append(utc(r['at'])); yy.append(eth(peak-total))
    axes[1].step(xx, yy, where='post', color='#b3423a', lw=2)
    axes[1].fill_between(xx, yy, step='post', color='#b3423a', alpha=.12)
    axes[0].set_title(f"September actual cash: {eth(data['actualCash']['net_wei']):+.5f} ETH net", loc='left')
    axes[1].set_title(f"Cumulative closed-cash drawdown: {eth(data['actualCash']['drawdown_wei']):.5f} ETH", loc='left')
    axes[0].set_ylabel('Net ETH'); axes[1].set_ylabel('ETH below cash peak')
    axes[1].xaxis.set_major_formatter(dates.DateFormatter('%b %d', tz=dt.timezone.utc))
    axes[1].set_xlabel('UTC; accounting resets do not erase losses')
    for ax in axes: ax.grid(axis='y', alpha=.2)
    fig.suptitle('September 1 through '+cutoff+'\nActual cash only. A complete September simulation is unavailable.', fontsize=14)
    fig.savefig(output/'september-cash.png', dpi=150); plt.close(fig)

    fig, axes = plt.subplots(2, 1, figsize=(12, 10), constrained_layout=True)
    for ax, cohort_name, begin, title in [
        (axes[0], 'today_diagnostic', today, f'Whole day: {len(day_rows)} actual attempts, {day_n} matched diagnostics'),
        (axes[1], 'captured_intents', min(r['entryAt'] for r in rows if r['quality'] == 'captured_preexecution_intent'),
         f'New interval: {modern_n} captured pre-execution intents')]:
        cohort = data['cohorts'][cohort_name]
        selected = {r['id'] for r in cohort['rows']}
        if cohort_name == 'today_diagnostic':
            full = [r for r in actual if today <= r['at'] < end]
            curve(ax, [(r['at'], r['pnl']) for r in full], begin, 'Actual, all '+str(len(full)), '#243746', width=2.4)
        curve(ax, [(by_id[i]['at'], by_id[i]['pnl']) for i in selected], begin,
              'Actual, matched '+str(len(selected)), '#555555', ':', 2)
        for k, name in enumerate(scenario_ids):
            points = [(b['scenarios'][k]['result']['exitAt'], b['scenarios'][k]['result']['pnlWei'])
                      for r, b in zip(rows, bundles) if r['id'] in selected and b['scenarios'][k]['result'].get('pnlWei') is not None]
            curve(ax, points, begin, 'Sim '+name, colors[k], '--' if k % 2 == 0 else '-.')
        ax.set_title(title, loc='left'); ax.set_ylabel('Cumulative net ETH')
        ax.xaxis.set_major_formatter(dates.DateFormatter('%H:%M', tz=ZoneInfo('Europe/London')))
        ax.set_xlabel('London time; matched attempts, not a complete account replay')
        ax.grid(axis='y', alpha=.2); ax.legend(loc='lower left', fontsize=8, ncol=2)
        ax.set_xlim(utc(begin), utc(end))
    fig.suptitle('Corrected replay still understates the measured loss\nSix timing/order stresses through one engine. These are not confidence bounds.', fontsize=14)
    fig.savefig(output/'actual-vs-simulation.png', dpi=150); plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 8), constrained_layout=True)
    worst, false_winners = [], {}
    for k, name in enumerate(scenario_ids):
        points = []
        for row, bundle in zip(rows, bundles):
            p = bundle['scenarios'][k]['result']
            if p.get('pnlWei') is None: continue
            a, s = eth(row['actualWei']), eth(p['pnlWei'])
            points.append((a, s))
            if a < 0 < s and s > false_winners.get(row['id'], (0, float('-inf')))[1]:
                false_winners[row['id']] = (a, s)
            worst.append(dict(id=row['id'], scenario=name, actual=a, simulated=s, optimism=s-a))
        ax.scatter([p[0] for p in points], [p[1] for p in points], s=22, alpha=.55, color=colors[k],
                   marker='o' if k % 2 == 0 else 'x', label=name)
    bound = max(abs(p[q]) for p in worst for q in ('actual', 'simulated'))*1.08
    ax.plot([-bound, bound], [-bound, bound], color='#555555', ls=':', label='Exact agreement')
    ax.axhline(0, color='#777777', lw=.6); ax.axvline(0, color='#777777', lw=.6)
    for index, (trade_id, point) in enumerate(sorted(false_winners.items())):
        ax.annotate(str(trade_id), point, xytext=(-35, 12+index*10), textcoords='offset points',
                    fontsize=9, color='#a33129', arrowprops={'arrowstyle': '-', 'color': '#a33129', 'lw': .6})
    ax.set_xlim(-bound, bound); ax.set_ylim(-bound, bound); ax.set_aspect('equal')
    ax.set_xlabel('Actual net ETH'); ax.set_ylabel('Simulated net ETH')
    ax.set_title('Above the diagonal: simulation is more optimistic\nUpper left: simulated winners that actually lost', loc='left')
    ax.legend(fontsize=8, ncol=2); ax.grid(alpha=.15)
    fig.savefig(output/'trade-errors.png', dpi=150); plt.close(fig)

    lines = ['# Shared simulation fidelity through '+cutoff, '',
             '**No validated replacement is supported.** The corrected replay still understates the losing period. No grid or live change was made.', '',
             f"The frozen range is {data['fromUtc']} through {data['throughUtc']}. It contains {data['actualAttempts']:,} actual attempts.", '',
             '![September actual cash and drawdown](september-cash.png)', '',
             '## Actual cash and coverage', '',
             '| Period ending at cutoff | Attempts | Wins | Losses | Net ETH | Closed-cash drawdown ETH |',
             '| --- | ---: | ---: | ---: | ---: | ---: |']
    periods = {}
    for name, lo in [('Today London', today), ('Last 24 hours', end-86400000), ('Last 7 days', end-604800000), ('September', start)]:
        m = cash_metrics([r for r in actual if lo <= r['at'] < end]); periods[name] = m
        lines.append(f"| {name} | {m['n']} | {m['winners']} | {m['losers']} | {eth(m['net_wei']):+.6f} | {eth(m['drawdown_wei']):.6f} |")
    receipt = data['receiptReconstruction']
    lines += ['', f"Receipt reconstruction agrees for {receipt['exact']} of {receipt['expected']} attempts. Missing or unresolved IDs: {', '.join(map(str, receipt['missingIds']))}.", '',
              f"Only {modern_n} attempts have the newer captured pre-execution inputs. Strict ordering resolves {modern['strict']['known']} of those {modern_n}. The other {len(rows)-modern_n} diagnostic requests infer historical intent and do not establish predictive fidelity.", '',
              f"The same-day matched set excludes {len(missing_day)} attempts: {', '.join(str(r['id']) for r in missing_day)}. Their actual net cash, {sum(eth(r['pnl']) for r in missing_day):+.6f} ETH, remains in the full actual curve. A recovered price path does not establish missing intent and execution evidence.", '',
              '| Missing evidence category | Attempts |', '| --- | ---: |']
    lines += [f'| {name} | {count} |' for name, count in sorted(data['missingInputs'].items())]
    lines += ['', 'Categories overlap. Missing predictions remain unavailable.', '', '## Matched execution comparisons', '',
              '![Actual cash against six corrected scenarios](actual-vs-simulation.png)', '',
              'All scenarios pin adaptive TP and exit rules at entry. Timing samples precede the attempt and retain the existing six-hour embargo. Same-second execution order varies before/after; external traders keep their recorded order quantities.', '',
              '| Cohort | Scenario | Matched / expected | Actual net ETH | Simulated net ETH | Loss understated | False winners |',
              '| --- | --- | ---: | ---: | ---: | ---: | --- |']
    for label, cohort in data['cohorts'].items():
        for name, score in cohort['scenarios'].items():
            a, p = eth(score['actual']['net_wei']), eth(score['predicted']['net_wei'])
            understatement = f'{100*(p-a)/(-a):.1f}%' if a < 0 else 'Unavailable'
            lines.append(f"| {label} | {name} | {score['known']} / {score['expected']} | {a:+.6f} | {p:+.6f} | {understatement} | {', '.join(map(str, score['falseWinners'])) or 'None'} |")
    lines += ['', 'Exit times are compared with booked closure, which can include confirmation delay. Quantity labels are the saved position quantities. Costs use the booked cash identity. These labels are never supplied to the prediction for the same attempt.', '',
              '### Captured-intent behavior errors', '',
              '| Scenario | Correct entry acceptance | Correct exit reason | Quantity error mean / median / sd (%) | n | Exit-time error mean / median / sd (ms) | n |',
              '| --- | ---: | ---: | --- | ---: | --- | ---: |']
    for name, score in modern['scenarios'].items():
        q, t = score['quantityErrorPct'], score['exitTimingErrorMs']
        distribution = lambda d: ' / '.join('Unavailable' if d[k] is None else f'{d[k]:.2f}' for k in ('mean', 'median', 'sd'))
        lines.append(f"| {name} | {round(score['entryAcceptanceAgreement']*score['known'])} / {score['known']} | {round(score['exitReasonAgreement']*score['known'])} / {score['known']} | {distribution(q)} | {q['n']} | {distribution(t)} | {t['n']} |")
    lines += ['',
              '![Individual trade errors](trade-errors.png)', '',
              '## Largest optimistic discrepancies', '',
              '| Trade | Scenario | Actual ETH | Simulated ETH | Overstatement ETH |', '| ---: | --- | ---: | ---: | ---: |']
    lines += [f"| {r['id']} | {r['scenario']} | {r['actual']:+.6f} | {r['simulated']:+.6f} | {r['optimism']:+.6f} |" for r in sorted(worst, key=lambda r: r['optimism'], reverse=True)[:12]]
    lines += ['', '## Guard comparison and four retention KPIs', '',
              '| KPI | Definition | Result |', '| --- | --- | --- |',
              '| Wins retained | Policy wins / matching-exit always-on wins | Unavailable |',
              '| Losses retained | Policy losses / matching-exit always-on losses | Unavailable |',
              '| Winning money retained | Policy gross profit / always-on gross profit | Unavailable |',
              '| Losing money retained | Policy gross loss / always-on gross loss | Unavailable |', '',
              'The 2,160 guards and ten timing policies remain frozen. No earnings grid was run against this failed fidelity audit. Profit missed, losses avoided and losing recoveries require complete account comparisons. Zero denominators remain unavailable.', '',
              '## Distributions and chronological coverage', '',
              '| Period | Mean ETH | Median ETH | Sample sd ETH | n |', '| --- | ---: | ---: | ---: | ---: |']
    for name, m in periods.items():
        d = m['cash_eth']; lines.append(f"| {name} | {d['mean']:.8f} | {d['median']:.8f} | {d['sd']:.8f} | {d['n']} |")
    for name, bins in data['bins'].items():
        lines += ['', f'### {name} bins', '', '| UTC start | UTC end | Net ETH | Mean ETH | Median ETH | Sample sd ETH | n |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |']
        for b in bins:
            d = b['actual']['cash_eth']; fmt = lambda v: 'Unavailable' if v is None else f'{v:.8f}'
            lines.append(f"| {utc(b['start']):%m-%d %H:%M} | {utc(b['end']):%m-%d %H:%M} | {eth(b['actual']['net_wei']):+.6f} | {fmt(d['mean'])} | {fmt(d['median'])} | {fmt(d['sd'])} | {d['n']} |")
    lines += ['', '### September UTC days', '', '| UTC day | Net ETH | Mean ETH | Median ETH | Sample sd ETH | n |', '| --- | ---: | ---: | ---: | ---: | ---: |']
    for lo in range(start, end, 86400000):
        m = cash_metrics([r for r in actual if lo <= r['at'] < min(lo+86400000, end)])
        d = m['cash_eth']; fmt = lambda v: 'Unavailable' if v is None else f'{v:.8f}'
        lines.append(f"| {utc(lo):%Y-%m-%d} | {eth(m['net_wei']):+.6f} | {fmt(d['mean'])} | {fmt(d['median'])} | {fmt(d['sd'])} | {d['n']} |")
    lines += ['', 'Full quantity, cost, exit reason, entry acceptance and timing errors are in `fidelity.json`. Each distribution includes mean, median, sample standard deviation and count.', '',
              '## What is implemented, and what remains unproved', '',
              'Research and the new indicator use one TypeScript execution engine. Each of six scenarios has an independent paper account. The guard pauses if any scenario crosses its brake and recovers only when all meet the selected conditions. Durable publication, source coverage, configuration identity and prospective certification gate entries.', '',
              'Those engineering changes do not repair missing historical inputs or prove future earnings. The new path defaults off. No release certificate was created, and live controls were not changed.', '',
              'The observed losses are retrospective evidence. They influenced this work. The final six hours remain excluded from fitting, but they are not untouched validation. New observations after a model and candidate lock are still required.', '',
              'Run from `bot/`: `python3 -m research validate-replay --manifest PATH_TO_ORIGINAL_MANIFEST --out NEW_DIRECTORY`. The original manifest binds source and input hashes. Its copied paths are relative to its original directory. Preserve that directory or resolve each path explicitly when relocating the archive.', '',
              f"Model hash: `{data['modelHash']}`. Manifest hash: `{data['datasetHash']}`. `artifact-hashes.json` inventories these outputs and the source snapshot."]
    (output/'report.md').write_text('\n'.join(lines)+'\n')
