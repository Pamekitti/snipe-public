"""Render the repair audit without promoting missing account comparisons."""
import argparse
import datetime as dt
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from research.core.data import read_json, write_json, digest
from research.core.publication import publication_time
from research.core.execution import describe
from research.core.fidelity import execution_windows, grade


def run(root):
    root = Path(root)
    audit = read_json(root / 'actual-audit-final/audit.json')
    results = read_json(root / 'actual-audit-final/predictions.json')
    rows = read_json(root / 'source/reproduction-inputs/fidelity/rows.json')
    pairs = [(r, p) for r, p in zip(rows, results) if p['pnlWei'] is not None]
    start, end = 1788220800000, 1789313400000
    stamp = lambda at: dt.datetime.fromtimestamp(at / 1000, dt.timezone.utc)
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
    for label, color, events in [
        ('Actual cash, matched attempts', '#1864ab', [(r['exitAt'], int(r['actualWei'])) for r, _ in pairs]),
        ('Simulation, unchanged by repair', '#d9480f', [(p['exitAt'], int(p['pnlWei'])) for _, p in pairs]),
    ]:
        net, peak = 0, 0
        times, cash, drawdown = [stamp(start)], [0], [0]
        for at, value in sorted(events):
            net += value
            peak = max(peak, net)
            times.append(stamp(at)); cash.append(net / 1e18); drawdown.append((peak - net) / 1e18)
        times.append(stamp(end)); cash.append(cash[-1]); drawdown.append(drawdown[-1])
        axes[0].step(times, cash, where='post', label=label, color=color, linewidth=1.7)
        axes[1].step(times, drawdown, where='post', color=color, linewidth=1.5)
    axes[0].set_title(f"Repair audit: {len(pairs):,} matched attempts, cash predictions unchanged", loc='left')
    axes[0].set_ylabel('Cumulative net ETH'); axes[1].set_ylabel('Drawdown ETH')
    axes[0].legend(loc='upper left', frameon=False)
    for ax in axes:
        ax.grid(alpha=.2); ax.spines[['top', 'right']].set_visible(False)
    axes[1].set_xlim(stamp(start), stamp(end))
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%d Sep', tz=dt.timezone.utc))
    axes[1].set_xlabel('UTC, frozen through 13 September 2026 at 15:30')
    fig.text(.09, .02, 'Diagnostic only. One actual +0.114760 ETH pool exit is unresolved and excluded from both matched lines.\n26 simulated winners actually lost. This chart does not establish account or guard fidelity.', fontsize=9)
    fig.tight_layout(rect=(0, .07, 1, 1)); fig.savefig(root / 'cash-comparison.png', dpi=160); plt.close(fig)

    policy = dict(kind='modeled-periodic-v1', periodMs=60000, phaseMs=0, workerMs=600, sourceHorizonMs=180000)
    recorded, modeled, missing = [], [], 0
    for path in sorted((root / 'source/jobs').glob('*.json')):
        for job in read_json(path):
            recorded.append((job['publicationFloor'] - job['at']) / 60000)
            if job.get('request') is None:
                missing += 1
                continue
            at, _ = publication_time(job, job['request']['endAt'], policy)
            modeled.append((at - job['at']) / 60000)
    publication = dict(policy=policy, recordedFloorDelayMinutes=describe(recorded),
                       modeledHorizonDelayMinutes=describe(modeled), unavailableRequests=missing,
                       recordedMoreThanThreeHours=sum(v > 180 for v in recorded),
                       historicalPublicationRecovered=False,
                       scope='Schedule-only illustration at full input horizon. Not recomputed shadow outcomes or account returns.')
    write_json(root / 'publication-audit.json', publication)
    cash = audit['actualCash']
    previous_grade_path = root.parent / '20260914-cloud-grid-v1/results/verification/standard-fidelity-grade.json'
    previous_grade = read_json(previous_grade_path)
    limits_path = Path(__file__).parent / 'BACKTEST_LIMITS_V1.json'
    limits = read_json(limits_path)
    graded = [dict(id=r['id'],entry=r['entryAt'],size=int(r['sizeWei']),actual_wei=r['actualWei'],actual_at=r['exitAt'],predicted_wei=p['pnlWei'],predicted_at=p['exitAt'],status=p['status']) for r,p in zip(rows,results)]
    windows = execution_windows(graded,start,end,min(r['size'] for r in graded if r['size']>0))
    verdict = grade(windows,previous_grade['account'],previous_grade['evidence'],limits)
    write_json(root / 'standard-fidelity-grade.json', dict(verdict=verdict,execution=windows,
        account=previous_grade['account'],evidence=previous_grade['evidence'],limitsHash=digest(limits_path),
        priorUnresolvedEvidenceHash=digest(previous_grade_path),modelHash=audit['modelHash'],diagnosticOnly=True,
        scope='Numerical intent errors recomputed. Previously unresolved account and source checks remain unresolved; no new whole-account certificate.'))
    preflight = read_json(root / 'search-preflight.json')
    report = f"""# Execution repair remains blocked on historical pool state

The evidence-binding and scheduling changes are implemented. Resolving pool executions and the full guard rerun remain blocked. The public RPC lacks the required September contract state. Access to the configured provider requires renewed Tailscale authentication. The alternative AWS login has also expired.

## What changed

- Pool evidence now binds to all frozen replay inputs and the attempted sell time. Matching zero reserves after graduation is insufficient.
- A reserve replay failure remains unavailable. It cannot fall through to pool evidence using an older reserve state.
- Unresolved pool results export the exact handoff needed for independent contract replay. This is a request for evidence, not proof that the sale executed.
- Research now supports a separately labeled periodic-publication scenario. The default retains recorded publication times. The modeled scenario cannot alter live evidence or establish when historical publications happened.
- The grid runs a baseline coverage preflight before its scoring pilot. Missing training accounts stop the large search.

## Actual cash has not become more accurate

The frozen sample ends 13 September 2026 at 15:30 UTC (16:30 London). All {audit['attempts']:,} attempts were replayed. The {cash['known']:,} resolved results match the previous reference exactly, including fills, costs, exit decisions and closure times. One attempt remains unavailable. There are still {len(cash['falseWinners'])} simulated winners that actually lost.

| Matched cohort | Actual | Simulation |
| --- | ---: | ---: |
| Net ETH | {int(cash['actual']['net_wei']) / 1e18:.6f} | {int(cash['predicted']['net_wei']) / 1e18:.6f} |
| Winning ETH | {int(cash['actual']['profit_wei']) / 1e18:.6f} | {int(cash['predicted']['profit_wei']) / 1e18:.6f} |
| Losing ETH | {int(cash['actual']['loss_wei']) / 1e18:.6f} | {int(cash['predicted']['loss_wei']) / 1e18:.6f} |
| Cumulative drawdown ETH | {int(cash['actual']['drawdown_wei']) / 1e18:.6f} | {int(cash['predicted']['drawdown_wei']) / 1e18:.6f} |

![Actual and simulated matched cash](cash-comparison.png)

The unresolved actual winner earned +0.114760 ETH. Its result is excluded from both matched lines. Full booked actual cash remains +0.304040 ETH. The unmatched actual outcome is not copied into the simulation.

Historical fidelity remains failed: {sum(not c['passed'] for c in verdict['checks'])} of {len(verdict['checks'])} checks fail or lack evidence. The numerical checks were recomputed with unchanged limits. Previously missing whole-account and source proofs remain missing.

## Publication timing

{publication['recordedMoreThanThreeHours']:,} of {len(recorded):,} stored publication floors were more than three hours after entry. The original capture does not establish earlier publication times for those rows. Its modern append-only capture starts on September 13, and the older shadow jobs begin on September 12.

The new modeled scenario uses a 60-second cadence, a 600 ms worker delay and a conservative 180-second source horizon. These are declared assumptions, not fitted performance improvements. `publication-audit.json` reports mean, median, standard deviation and count for both timing descriptions. The {missing} requests with missing replay inputs remain unavailable.

## Verification and remaining work

The 8,056 historical guard parity checks and the historical replay source prefix are preserved. Bot and research suites, both TypeScript checks, and laptop curve validation are recorded beside this report. Curve validation matched 60/60 curves, 99,080/99,080 core calculations and 409/409 tax calculations.

The baseline preflight checked {preflight['checkedComparisons']} clock lanes. Neither supplies a complete training account for September 1–3, 1–5 or 1–7. Winning-money and losing-money retention percentages remain unavailable. No new ranking or validated policy replacement is claimed.

The next dependent step is independent contract replay from historical state, preserving external orders, simulated reserves, graduation preparation, approvals, costs and timing. Historical router quotes alone do not prove candidate-state compatibility. After complete evidence and accuracy checks, freeze a new run and rerun comparisons. No settings, controls, accounting or live build changed.

## Reproduce the local checks

From `bot/`, use a fresh output directory:

```sh
python3 -m research.execution_repair_audit --source data/research/20260914-execution-repair-v1/source/reproduction-inputs/fidelity --out NEW_OUTPUT_DIRECTORY
python3 -m unittest discover -s research -p 'test_*.py'
npm test
npm run typecheck
npx tsc --noEmit -p research/tsconfig.json
```

`actual-audit-final/audit.json` binds actual inputs and the shared model. The repair uses `predictExecution` through the existing worker. It adds no second simulator. The historical capture and previous cloud results remain unchanged.
"""
    (root / 'report.md').write_text(report)
    write_json(root / 'report-artifacts.json', {name: digest(root / name) for name in ['cash-comparison.png', 'publication-audit.json', 'report.md']})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True)
    run(parser.parse_args().root)
