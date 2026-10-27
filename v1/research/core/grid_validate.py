"""Replay frozen training choices through later September data, without retuning."""
import argparse
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path
from .data import read_json, write_json, digest
from .grid_guard import GridRule
from .grid_jobs import SCENARIOS, complete


def run(root):
    root=Path(root);selection=root/'refinement-selection.json'
    frozen=read_json(selection)
    grouped={'fixed_45':{GridRule().name:asdict(GridRule())}}
    for candidate in frozen['candidates'].values():
        rule=GridRule(**candidate['rule'])
        grouped.setdefault(candidate['exit'],{})[rule.name]=asdict(rule)
    scenarios=[dict(mode=m,variant=v,delay=0,controls=False) for m,v in SCENARIOS]
    scenarios += [dict(mode='reconstructed_early',variant='adaptive',delay=60000,controls=False),
                  dict(mode='reconstructed_early',variant='adaptive',delay=0,controls=True)]
    index=[]
    for name,rules in grouped.items():
        rules_path=root/'validation'/(name+'-rules.json')
        write_json(rules_path,list(rules.values()))
        for s in scenarios:
            for scope in ('conditional','strict_prefix'):
                scenario=f"{s['mode']}--{s['variant']}--delay{s['delay']}--controls{int(s['controls'])}"
                output=root/'validation'/f'{name}--{scenario}--{scope}'
                args=['--snapshot',str(root/'snapshot.json.gz'),'--models',str(root/'accounts'/f'{name}.json'),
                      '--out',str(output),'--scenario-mode',s['mode'],'--variant',s['variant'],
                      '--rules',str(rules_path),'--coverage',str(root/'accounts/coverage.json'),
                      '--scope',scope,'--publication-delay',str(s['delay'])]
                if s['controls']:args.append('--recorded-controls')
                index.append(dict(exit=name,scenario=scenario,scope=scope,output=str(output),args=args))
    manifest=root/'validation/jobs.json'
    value=dict(selection_sha256=digest(selection),jobs=index,source_sha256=digest(Path(__file__)),
               runner_sources={n:digest(Path(__file__).with_name(n+'.py')) for n in ('grid_final_sweep','grid_guard','grid_clock','account','long_history','indicator_study','indicators','evaluation','fidelity','guard_visual')},
               accounts_sha256=digest(root/'accounts/index.json'))
    if manifest.exists() and read_json(manifest)!=value:raise ValueError('Frozen validation job plan changed')
    write_json(manifest,value)
    for i,job in enumerate(index):
        output=Path(job['output']);stamp=output/'completed.json'
        if stamp.exists():
            if read_json(stamp)['design_sha256']!=digest(output/'design.json') or not complete(output):raise ValueError('Invalid validation checkpoint')
            continue
        print('Validation',i+1,'/',len(index),job['exit'],job['scenario'],job['scope'],flush=True)
        subprocess.run([sys.executable,'-m','research.core.grid_final_sweep',*job['args']],check=True)
        if not complete(output):raise ValueError('Validation job incomplete')
        write_json(stamp,dict(design_sha256=digest(output/'design.json')))
    write_json(root/'validation/completed.json',dict(plan_sha256=digest(manifest),jobs=len(index)))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',default='data/research/20260912-grid');run(p.parse_args().root)
