"""Checkpointed research jobs. This command has no live trading controls."""
import argparse
import json
import sqlite3
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from .data import read_json, write_json, digest
from .grid_guard import GridRule

FIT_END = 1788825600000
SCENARIOS = [(mode, variant) for mode in ('reconstructed_early', 'recorded')
             for variant in ('adaptive', 'fast_sell', 'slow_sell')]


def complete(path):
    if not (path / 'scores.sqlite').exists():
        return False
    design = read_json(path / 'design.json')
    coverage = read_json(path / 'coverage.json')
    with sqlite3.connect('file:' + str(path / 'scores.sqlite') + '?mode=ro', uri=True) as db:
        counts = dict(db.execute('select segment,count(*) from scores group by segment'))
    return all(counts.get(i) == len(design['rules']) for i in range(len(coverage['intervals'])))


def run(root, phase):
    root = Path(root)
    index = read_json(root / 'accounts/index.json')
    names = index['names']
    for name in names:
        if index.get('files', {}).get(name) != digest(root / 'accounts' / (name + '.json')):
            raise ValueError('Account model hash mismatch: ' + name)
    refined = read_json(root / 'refinement-rules.json') if phase == 'refinement' else None
    if refined is not None:
        refined.setdefault('fixed_45', [asdict(GridRule())])
        names = sorted(refined)
    baseline = root / 'baseline-rule.json'
    write_json(baseline, [asdict(GridRule())])
    plan = []
    for mode, variant in SCENARIOS:
        for name in sorted(names, key=lambda n: (n != 'fixed_45', n)):
            output = root / phase / f'{name}--{mode}--{variant}'
            args = ['--snapshot', str(root / 'snapshot.json.gz'), '--models', str(root / 'accounts' / (name + '.json')),
                    '--out', str(output), '--end', str(FIT_END), '--scenario-mode', mode, '--variant', variant,
                    '--coverage', str(root / 'accounts/coverage.json')]
            if phase == 'exit_axis':
                args += ['--rules', str(baseline)]
            elif refined is not None:
                rules_path = root / phase / (name + '-rules.json')
                write_json(rules_path, refined[name])
                args += ['--rules', str(rules_path)]
            plan.append(dict(exit=name, mode=mode, variant=variant, output=str(output), args=args))
    manifest = root / phase / 'jobs.json'
    identity = dict(phase=phase, fit_end=FIT_END, jobs=plan, refinement=refined,
                    sources={str(p): digest(p) for p in [Path(__file__), *[Path(__file__).with_name(n+'.py') for n in ('grid_final_sweep','grid_guard','grid_clock','account','long_history','indicator_study','indicators','evaluation','fidelity','guard_visual')], root / 'accounts/index.json']})
    if manifest.exists() and read_json(manifest) != identity:
        raise ValueError('Research job plan changed; use a new output directory')
    write_json(manifest, identity)
    for index, job in enumerate(plan):
        if (root/'pause.request').exists():raise RuntimeError('Research pause requested; checkpoints retained')
        output = Path(job['output'])
        stamp = output / 'completed.json'
        if stamp.exists():
            if read_json(stamp)['design_sha256'] != digest(output / 'design.json') or not complete(output):
                raise ValueError(f'Invalid completion checkpoint: {output}')
            continue
        print(f"{phase} job {index+1}/{len(plan)}: {job['exit']} {job['mode']} {job['variant']}", flush=True)
        subprocess.run([sys.executable, '-m', 'research.core.grid_final_sweep', *job['args']], check=True)
        if not complete(output):
            raise ValueError(f'Incomplete job: {output}')
        write_json(stamp, dict(design_sha256=digest(output / 'design.json')))
    write_json(root / phase / 'completed.json', dict(jobs=len(plan), plan_sha256=digest(manifest)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='data/research/20260912-grid')
    parser.add_argument('--phase', choices=['exit_axis', 'joint_coarse', 'refinement'], required=True)
    args = parser.parse_args()
    run(args.root, args.phase)
