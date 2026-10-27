"""Plot the frozen Market +2 comparison without refitting or fetching live data."""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib
matplotlib.use('Agg')
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import FuncFormatter
import numpy as np

import market_guard_longer as longer
import recovery_policy_audit as audit
import recovery_policy_models as models

ROOT = Path(__file__).resolve().parents[1] / 'data/recovery-policy-20260908'
TZ = ZoneInfo('Europe/London')
COLORS = {'baseline': '#BC641E', 'venue_plus2_only': '#086B91'}
LABELS = {'baseline': 'Baseline: market +1', 'venue_plus2_only': 'Market +2'}


def date(at):
    return datetime.fromtimestamp(at / 1000, TZ)


def trajectory(cash, start, end):
    """Keep the cumulative performance account intact across DD resets."""
    total = peak = maximum = 0
    peak_at = start
    excursion = {'peak_at': start, 'trough_at': start, 'dd_wei': 0}
    rows = [[start, 0, 0]]
    for at, _, value in cash:
        total += value
        if total > peak:
            peak, peak_at = total, at
        drawdown = peak - total
        if drawdown > maximum:
            maximum = drawdown
            excursion = {'peak_at': peak_at, 'trough_at': at, 'dd_wei': drawdown}
        rows.append([at, total, drawdown])
    rows.append([end, total, peak - total])
    return rows, excursion


def spans(times, flags, end):
    begin = None
    for at, flag in zip(times, flags):
        if flag and begin is None:
            begin = at
        elif not flag and begin is not None:
            yield begin, at
            begin = None
    if begin is not None:
        yield begin, end


def main():
    data = json.load(gzip.open(ROOT / 'snapshot.json.gz', 'rt'))
    paths = json.loads((ROOT / 'model_paths.json').read_text())['paths']
    saved = json.loads((ROOT / 'ablation_results.json').read_text())
    start, end = data['snapshot_at'] - 14 * audit.DAY, data['snapshot_at']
    usd = data['state']['truth']['priceUsd']
    native = audit.live_observations(data)
    known = {o.token for o in native}
    obs = native + [longer.Observation(token, row['block'], row['launched'],
        longer.scoring_time(row['launched'], 300000), {'1.75': row['observer_return']})
        for token, row in paths.items() if token not in known]
    trades, variants = models.variants(paths, start)
    baseline = audit.policies(data['state']['config']['values'])[0]
    policies = [baseline, replace(baseline, name='venue_plus2_only', on=2)]
    sim = audit.Simulator(obs, trades, start, end, variants=variants)
    runs, curves, checks = {}, {}, {}
    for policy in policies:
        name = policy.name
        run = sim.simulate(policy)
        # Exact equality verifies this is the saved experiment, not a new variant.
        assert [list(x) for x in run['cash']] == saved['zero'][name]['cash']
        assert run['actions'] == saved['zero'][name]['actions']
        assert len({row[1] for row in run['cash']}) == len(run['cash'])
        rows, worst = trajectory(run['cash'], start, end)
        stats = saved['zero'][name]['14d']
        assert abs(rows[-1][1] / 1e18 - stats['pnl_eth']) < 1e-12
        assert abs(worst['dd_wei'] / 1e18 - stats['dd_eth']) < 1e-12
        runs[name], curves[name] = run, rows
        checks[name] = dict(policy=asdict(policy), closed_trades=len(run['cash']),
            profit_eth=rows[-1][1] / 1e18, profit_usd=rows[-1][1] / 1e18 * usd,
            max_dd_eth=worst['dd_wei'] / 1e18, max_dd_usd=worst['dd_wei'] / 1e18 * usd,
            dd_peak_london=date(worst['peak_at']).isoformat(),
            dd_trough_london=date(worst['trough_at']).isoformat(),
            open_ids_at_end=run['open_ids'], exact_saved_cash_and_actions=True)

    # Identify reconstructed contributions per window, including mixed windows.
    provenance = []
    for at, kind, items in sim.events:
        if kind != 1:
            continue
        chosen = audit.outcome(items[:40], 20)
        provenance.append([at, sum(o.token not in known for o, _ in chosen)])
    readings = runs['baseline']['readings']
    assert len(provenance) == len(readings)
    assert all(p[0] == q[0] for p, q in zip(provenance, readings))
    assert [(a, c, d) for a, _, c, d in readings] == [
        (a, c, d) for a, _, c, d in runs['venue_plus2_only']['readings']]

    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 11,
        'axes.labelsize': 11, 'axes.titlesize': 13, 'axes.titleweight': 'bold',
        'xtick.labelsize': 10, 'ytick.labelsize': 10, 'figure.facecolor': 'white',
        'axes.spines.top': False, 'axes.spines.right': False})
    for suffix, lo in [('two_weeks', start), ('last_48h', end - 2 * audit.DAY)]:
        fig, axes = plt.subplots(3, 1, figsize=(15, 12.8), sharex=True,
            gridspec_kw={'height_ratios': [1.35, 1, 1.1]})
        fig.subplots_adjust(left=.08, right=.88, top=.83, bottom=.14, hspace=.31)
        full = lo == start
        fig.text(.08, .957, 'Market +2: more modeled profit, smaller realized drawdown',
                 fontsize=20, weight='bold')
        fig.text(.08, .925, f'{date(lo):%d %b %Y, %H:%M} to {date(end):%d %b %Y, %H:%M} London'
                 + (' | 14 days' if full else ' | Final 48 hours of the same run'),
                 fontsize=12, color='#334155')
        fig.text(.08, .895, 'HYPOTHETICAL MODEL | Fixed 0.02 ETH trades, 1.75x target, modeled costs'
                 f' | ${usd:,.2f}/ETH', fontsize=10, color='#334155')
        fig.text(.08, .866, 'Unresolved execution and graduation errors. These dollar totals are not a live earnings forecast.',
                 fontsize=11, color='#9C4127')

        for name, raw in curves.items():
            before = [r for r in raw if r[0] < lo]
            offset = before[-1][1] if before and not full else 0
            selected = [r for r in raw if lo <= r[0] <= end]
            initial = before[-1] if before else raw[0]
            selected.insert(0, [lo, initial[1], initial[2]])
            x = [date(r[0]) for r in selected]
            y = [(r[1] - offset) / 1e18 * usd for r in selected]
            dd = [-r[2] / 1e18 * usd for r in selected]
            style = '--' if name == 'baseline' else '-'
            axes[0].step(x, y, where='post', color=COLORS[name], ls=style,
                         lw=2.2, label=LABELS[name])
            axes[1].step(x, dd, where='post', color=COLORS[name], ls=style, lw=1.65)
            axes[0].annotate(f'{LABELS[name]}\n${y[-1]:,.0f}', (date(end), y[-1]),
                xytext=(9, 0), textcoords='offset points', fontsize=10,
                va='center', color=COLORS[name], weight='bold')
            lowest = int(np.argmin(dd))
            axes[1].plot(x[lowest], dd[lowest], 'o', color=COLORS[name], ms=5)
            axes[1].annotate(f'${-dd[lowest]:,.0f}', (x[lowest], dd[lowest]),
                xytext=(8, -13 if name == 'baseline' else 12),
                textcoords='offset points', color=COLORS[name], fontsize=11, weight='bold')

        axes[0].set_title('Cumulative net profit' if full else 'Net profit earned during the final 48 hours', loc='left', pad=12)
        axes[0].set_ylabel('Modeled profit (USD)')
        axes[0].legend(loc='upper left', frameon=False)
        axes[1].set_title('Realized drawdown from the full-run profit peak', loc='left', pad=12)
        axes[1].set_ylabel('Below profit peak (USD)')
        axes[1].set_ylim(bottom=min(ax for name in curves for ax in [
            -checks[name]['max_dd_usd']]) * 1.15, top=15)
        for ax in axes[:2]:
            ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f'${value:,.0f}'))
            ax.axhline(0, color='#475569', lw=.65)

        window = [(t, fresh, total) for t, _, fresh, total in readings if lo <= t <= end]
        sx = [date(t) for t, _, _ in window]
        sy = [total if fresh else np.nan for _, fresh, total in window]
        stale = [total if not fresh else np.nan for _, fresh, total in window]
        axes[2].step(sx, sy, where='post', color='#29394B', lw=1, zorder=3)
        axes[2].step(sx, stale, where='post', color='#9BA4B2', lw=.9, ls=':', zorder=3)
        for begin, finish in spans([v[0] for v in provenance], [v[1] > 0 for v in provenance], end):
            if finish >= lo:
                axes[2].axvspan(date(max(begin, lo)), date(finish), color='#E4E8EE', zorder=0)
        for y, color, style, label in [(-1, '#9D313E', ':', 'Pause below -1'),
                (1, COLORS['baseline'], '--', 'Baseline > +1'),
                (2, COLORS['venue_plus2_only'], '-', 'Market +2 > +2')]:
            axes[2].axhline(y, color=color, ls=style, lw=1.15, zorder=2)
        axes[2].set_title('Market indicator: sum of the latest 20 scored launch returns', loc='left', pad=12)
        axes[2].set_ylabel('Stakes (0.01 ETH model)')
        axes[2].legend(handles=[
            Line2D([], [], color=COLORS['baseline'], ls='--', label='Baseline reopens above +1'),
            Line2D([], [], color=COLORS['venue_plus2_only'], label='Market +2 reopens above +2'),
            Line2D([], [], color='#9D313E', ls=':', label='Both pause below -1'),
            Patch(facecolor='#E4E8EE', label='Window includes reconstructed scores'),
        ], loc='upper left', bbox_to_anchor=(0, -.22), ncol=2, frameon=False, fontsize=10)
        axes[2].set_xlabel('London time', labelpad=7)
        if full:
            axes[2].xaxis.set_major_locator(mdates.DayLocator(interval=2, tz=TZ))
            axes[2].xaxis.set_major_formatter(mdates.DateFormatter('%d %b', tz=TZ))
        else:
            axes[2].xaxis.set_major_locator(mdates.HourLocator(interval=6, tz=TZ))
            axes[2].xaxis.set_major_formatter(mdates.DateFormatter('%d %b\n%H:%M', tz=TZ))
        for ax in axes:
            ax.set_xlim(date(lo), date(end))
            ax.grid(axis='y', color='#E4E8EE', lw=.6)
            ax.spines['left'].set_color('#B9C2CD')
            ax.spines['bottom'].set_color('#B9C2CD')
        fig.text(.08, .043, 'DD recovery remains above +1 after 20 post-stop scores. Existing stale-data reopening remains in both policies.',
                 fontsize=10, color='#334155')
        fig.text(.08, .025, 'Drawdown includes repeated restarts; open-position losses are excluded. Grey dotted indicator segments are stale.',
                 fontsize=10, color='#334155')
        for extension in ['png', 'svg']:
            fig.savefig(ROOT / f'market_plus2_{suffix}.{extension}', dpi=150)
        plt.close(fig)

    payload = {'snapshot_utc': audit.iso(end), 'start_utc': audit.iso(start),
        'eth_usd': usd, 'policies': checks,
        'checks': ['cash and actions exactly match saved run', 'cash IDs unique',
            'totals and drawdown independently recomputed in integer wei',
            'both policies share the same indicator', 'indicator provenance per window'],
        'source_sha256': {str(p.relative_to(ROOT.parents[2])): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [ROOT / 'snapshot.json.gz', ROOT / 'model_paths.json',
                ROOT / 'ablation_results.json', Path(__file__).resolve(),
                Path(audit.__file__), Path(models.__file__), Path(longer.__file__)]},
        'curve_columns': ['timestamp_ms', 'cumulative_cash_wei', 'drawdown_wei'],
        'curves': curves, 'indicator_columns': ['timestamp_ms', 'venue_halted_baseline', 'fresh', 'sum_stakes'],
        'indicator': readings, 'reconstructed_score_counts': provenance}
    (ROOT / 'market_plus2_chart_data.json').write_text(json.dumps(payload))
    print(json.dumps({'start': payload['start_utc'], 'end': payload['snapshot_utc'],
        'checks': checks, 'indicator_range': [min(r[3] for r in readings), max(r[3] for r in readings)],
        'artifacts': ['market_plus2_two_weeks.png', 'market_plus2_last_48h.png']}, indent=2))


if __name__ == '__main__':
    main()
