"""Account for every search stage and its chronological selection boundary."""
import json
from pathlib import Path

def supplement(root, scores, accounts):
    root = Path(root)
    read = lambda p: json.loads(Path(p).read_text())
    key = lambda r: (r['policy']['id'], r['lane'], r['exit'], r['memory'])
    order = lambda r, p: (-min(s['net'] for s in r['periods'][p]),
                         max(s['dd'] for s in r['periods'][p]), r['policy']['id'])
    stages = []
    memberships = {}
    input_names = sorted(((Path(i['path']).stem, i) for i in accounts),
                         key=lambda pair: -len(pair[0]))
    for index_path in sorted((root / 'scores').glob('*/index.json')):
        index = read(index_path)
        stage = index_path.parent.name
        members = set()
        groups = {}
        for filename in index['files']:
            stem = Path(filename).stem
            match = next(((prefix, info) for prefix, info in input_names
                          if stem.startswith(prefix + '-')), None)
            if not match:
                raise ValueError('Unknown completed score input: ' + filename)
            prefix, info = match
            group = stem[len(prefix) + 1:]
            if group not in groups:
                groups[group] = read(index_path.parent / f'policies-{group}.json')
            for policy in groups[group]:
                members.add((policy['id'], info['lane'], info['exit'], info['memory']))
        memberships[stage] = members
        stages.append({'stage': stage, 'policies': index['candidates'],
                       'comparisons': index['comparisons'], 'completeFiles': len(index['files'])})
    chronological = []
    for fit, evaluate in [('train3', 'eval4-5'), ('train5', 'eval6-7'), ('train7', 'eval8-9')]:
        allowed = set(memberships.get('core', set()))
        for stage, members in memberships.items():
            if stage.startswith(fit + '-'):
                allowed.update(members)
        eligible = [r for r in scores if key(r) in allowed and
                    all(s['complete'] for s in r['periods'][fit])]
        chosen = min(eligible, key=lambda r: order(r, fit)) if eligible else None
        chronological.append({'fit': fit, 'evaluation': evaluate,
                              'completeTrainingComparisons': len(eligible),
                              'choice': None if chosen is None else
                              {k: chosen[k] for k in ['policy', 'lane', 'exit', 'memory']},
                              'training': None if chosen is None else chosen['periods'][fit],
                              'followingTwoDays': None if chosen is None else chosen['periods'][evaluate]})
    complete = [r for r in scores if all(s['complete'] for s in r['periods']['train7'])]
    leader = min(complete, key=lambda r: order(r, 'train7')) if complete else None
    neighbors = []
    fields = ['n', 'm', 'off', 'freshOn', 'fullOn', 'ageMs']
    steps = dict(n=1, m=1, off=.25, freshOn=.25, fullOn=.25, ageMs=900000)
    if leader:
        a = leader['policy']
        for r in scores:
            if any(r[k] != leader[k] for k in ['lane', 'exit', 'memory']):
                continue
            b = r['policy']
            changed = [k for k in fields if a[k] != b[k]]
            if not 1 <= len(changed) <= 2:
                continue
            if any(abs(a[k] - b[k]) != steps[k] for k in changed):
                continue
            other = (set(a) | set(b)) - set(fields) - {'id'}
            if any(a.get(k) != b.get(k) for k in other):
                continue
            neighbors.append({k: r[k] for k in ['policy', 'lane', 'exit', 'memory', 'periods']})
    result = {'stages': stages, 'chronologicalSelections': chronological,
              'trainingLeaderNeighbors': neighbors,
              'limitations': ['Repeated staged search is not exhaustive over all family combinations.',
                              'No prospective observations are included.',
                              'All cash results remain diagnostic because fidelity has not passed.']}
    (root / 'report' / 'search-audit.json').write_text(json.dumps(result, indent=2))
    lines = ['## Search coverage', '',
             '| Completed stage | Guard definitions | Account comparisons | Output files |',
             '| --- | ---: | ---: | ---: |']
    for stage in stages:
        lines.append(f"| {stage['stage']} | {stage['policies']:,} | {stage['comparisons']:,} | {stage['completeFiles']:,} |")
    lines += ['', 'Each account comparison contains six execution scenarios. Pilot work is listed separately and is not an additional candidate population.', '',
              '## Chronological checks', '',
              'Each cutoff selects from the core grid and only the wider stages fitted at that cutoff. A later cutoff cannot nominate an earlier winner.', '',
              '| Training cutoff | Complete comparisons | Selected guard | Next two days, worst net ETH |',
              '| --- | ---: | --- | ---: |']
    for row in chronological:
        outcomes = row['followingTwoDays']
        net = f"{min(s['net'] for s in outcomes):+.6f}" if outcomes and all(s['complete'] for s in outcomes) else 'Unavailable'
        selected = row['choice']['policy']['id'] if row['choice'] else 'No complete candidate'
        lines.append(f"| {row['fit']} | {row['completeTrainingComparisons']:,} | {selected} | {net} |")
    lines += ['', f'{len(neighbors):,} tested one-step or pairwise neighbors of the training leader are recorded in search-audit.json. No observed neighbor is treated as prospective evidence.', '']
    pilot_path = root / 'parallelism-pilot.json'
    if pilot_path.exists():
        pilot = read(pilot_path)
        lines += ['## Measured scoring throughput', '',
                  '| Workers | Completed comparisons in timed band | Measured seconds | Comparisons per second |',
                  '| ---: | ---: | ---: | ---: |']
        for band in pilot['bands']:
            rate = band['completedCandidates'] / band['seconds'] if band['seconds'] else None
            value = 'Unavailable' if rate is None else f'{rate:.1f}'
            lines.append(f"| {band['workers']} | {band['completedCandidates']:,} | {band['seconds']:.1f} | {value} |")
        lines += ['', 'The bands use disjoint jobs in a content-hash order. Rates measure completed comparisons divided by elapsed time. They are not repeat-trial statistics or a claim about untested worker counts.', '']
    bins_path = root / 'report' / 'period-bins.json'
    if bins_path.exists():
        bins = read(bins_path)
        fmt = lambda value: 'Unavailable' if value is None else f'{value:+.6f}'
        for window in ['September daily', '24h', '7d']:
            lines += [f'## Actual cash: {window}', '',
                      'ETH at historical stakes. Every row reports mean, median, sample standard deviation and count. Guard comparison values remain unavailable.', '',
                      '| UTC interval | Net ETH | Mean ETH | Median ETH | SD ETH | n |',
                      '| --- | ---: | ---: | ---: | ---: | ---: |']
            for row in bins:
                if row['window'] != window:
                    continue
                stats = row['series']['actual']
                interval = row['fromUtc'].replace('T', ' ').replace('+00:00', '') + ' to ' + row['throughUtc'].replace('T', ' ').replace('+00:00', '')
                values = [fmt(stats[k]) for k in ['netEth', 'mean', 'median', 'sd']]
                lines.append('| ' + interval + ' | ' + ' | '.join(values) + f" | {stats['n']} |")
            lines.append('')
    return lines
