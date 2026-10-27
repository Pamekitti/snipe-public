"""Retrospective rolling-cohort calibration, separate from the causal guard grid."""
import argparse
import datetime as dt
import statistics
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.dates as dates
import matplotlib.pyplot as plt

from research.core.data import read_json, write_json, digest


def describe(values):
    return dict(mean=statistics.mean(values) if values else None,
                median=statistics.median(values) if values else None,
                sd=statistics.stdev(values) if len(values) > 1 else None, n=len(values))


def render(root):
    root = Path(root)
    actual_path = root.parent / '20260914-execution-repair-v1/source/reproduction-inputs/fidelity/rows.json'
    prediction_path = root / 'actual-scenarios/pool-d0-h0/predictions.json'
    actual, predicted = read_json(actual_path), read_json(prediction_path)
    # The bounded-actual writer preserves the frozen actual-input array order.
    if len(actual) != len(predicted) or any(a['entryAt'] != p['entryAt'] for a, p in zip(actual, predicted)):
        raise ValueError('Actual/prediction array alignment differs')
    pairs = sorted(zip(actual, predicted), key=lambda pair: (pair[0]['entryAt'], pair[0]['id']))
    report = root / 'report'
    report.mkdir(exist_ok=True)
    summary = dict(diagnosticOnly=True, causalIndicator=False, fittedThresholds=False,
                   interpretation='Eventual outcomes of identical actual-attempt cohorts, ordered by entry. '
                   'Overlapping windows are not independent samples. This is not a live indicator reconstruction.',
                   sourceHashes={str(actual_path): digest(actual_path), str(prediction_path): digest(prediction_path)},
                   windows={})
    fig, axes = plt.subplots(2, 1, figsize=(13, 8), sharex=True, layout='constrained')
    for n, ax in zip([10, 20], axes):
        points = []
        missing = 0
        for end in range(n, len(pairs) + 1):
            cohort = pairs[end-n:end]
            if any(a['actualWei'] is None or p['pnlWei'] is None or int(a['sizeWei']) <= 0 for a, p in cohort):
                missing += 1
                continue
            real = sum(int(a['actualWei']) / int(a['sizeWei']) for a, p in cohort)
            sim = sum(int(p['pnlWei']) / int(a['sizeWei']) for a, p in cohort)
            points.append(dict(at=cohort[-1][0]['entryAt'], actual=real, simulated=sim,
                               firstId=cohort[0][0]['id'], lastId=cohort[-1][0]['id']))
        positive = [p for p in points if p['simulated'] > 0]
        false_positive = [p for p in positive if p['actual'] < 0]
        summary['windows'][str(n)] = dict(complete=len(points), unavailable=missing,
            simulatedPositive=len(positive), simulatedPositiveActualNegative=len(false_positive),
            falsePositiveFraction=len(false_positive)/len(positive) if positive else None,
            absoluteSumErrorStakes=describe([abs(p['simulated']-p['actual']) for p in points]),
            signedSumErrorStakes=describe([p['simulated']-p['actual'] for p in points]), points=points)
        time = [dt.datetime.fromtimestamp(p['at']/1000, dt.timezone.utc) for p in points]
        ax.step(time, [p['actual'] for p in points], where='post', color='#26364a', label='Actual eventual outcomes', linewidth=1.15)
        ax.step(time, [p['simulated'] for p in points], where='post', color='#3574aa', label='Simulated eventual outcomes', linewidth=1.15, alpha=.85)
        ax.scatter([dt.datetime.fromtimestamp(p['at']/1000, dt.timezone.utc) for p in false_positive],
                   [p['simulated'] for p in false_positive], color='#bd583b', s=10,
                   label='Model positive, actual negative', zorder=3)
        ax.axhline(0, color='grey', linewidth=.7)
        ax.set_title(f'{n}-attempt sums: {len(false_positive)}/{len(positive)} model-positive windows actually lost')
        ax.set_ylabel('Net return / pinned stake, summed')
        ax.grid(alpha=.2)
        ax.spines[['top', 'right']].set_visible(False)
    axes[0].legend(loc='upper left', ncols=3, fontsize=9)
    axes[1].xaxis.set_major_formatter(dates.DateFormatter('%d %b', tz=dt.timezone.utc))
    axes[1].set_xlabel('Latest entry in each cohort, UTC. Outcomes use later closures; this is NOT a causal indicator.')
    fig.suptitle('Same actual trades, same windows: retrospective model calibration', fontsize=15)
    fig.savefig(report / 'rolling-cohort-errors.png', dpi=160)
    plt.close(fig)
    write_json(report / 'rolling-cohort-errors.json', summary)
    return {n: {k: v for k, v in values.items() if k != 'points'} for n, values in summary['windows'].items()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    print(render(parser.parse_args().root))
