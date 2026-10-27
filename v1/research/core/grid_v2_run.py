"""Versioned September research orchestration; never controls the live bot."""
import argparse, fcntl, itertools, json, os, signal, subprocess, sys, time, shutil
from pathlib import Path
from dataclasses import asdict, replace
from .data import read_json, write_json, digest, HOUR
from .grid_v2_guard import Rule, core, family_rules, FAMILIES, neighbors
from .grid_jobs import SCENARIOS, complete
from .grid_scorecards import collect
from .grid_select import frontier


def manifest(root):
    return read_json(Path(root)/'run.json')

def source_hashes():
    return {str(p):digest(p) for directory in ('research','src','scripts')
            for p in sorted(Path(directory).rglob('*')) if p.is_file() and p.suffix in ('.py','.ts','.js','.mjs','.cjs')}

def freeze(root):
    root=Path(root);raw=read_json(root/'snapshot.json.gz');capture=raw['snapshot_at']
    from datetime import datetime, timezone
    stamp=lambda d:int(datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp()*1000)
    from .grid_v2_exits import catalog
    exits=catalog()
    if (root/'candidate-exits.json').exists() and read_json(root/'candidate-exits.json')!=exits:raise ValueError('Exit catalog changed before freeze')
    write_json(root/'candidate-exits.json',exits)
    value=dict(python_runtime={'version':sys.version,'executable':sys.executable,'jit':os.environ.get('PYTHON_JIT','0')},entry_timing_assumptions={'reconstructed_early':'launch timestamp + 2 seconds; theoretical early-arrival stress','recorded':'actual decision time where present, otherwise recorded detection; never before launch + 2 seconds','shadow':'independent recorded-timing account for the same exit policy in every execution stress'},entry_timing_models=True,acquisition_source=read_json(root/'acquisition-source.json') if (root/'acquisition-source.json').exists() else None,exit_catalog_sha256=digest(root/'candidate-exits.json'),version=2,start=stamp('2026-09-01'),capture=capture,fit_end=stamp('2026-09-08'),
               reserved_start=capture-6*HOUR,folds=[dict(fit_end=stamp(d),eval_end=stamp(e)) for d,e in [('2026-09-04','2026-09-06'),('2026-09-06','2026-09-08'),('2026-09-08','2026-09-10')]],
               snapshot_sha256=digest(root/'snapshot.json.gz'),configuration_sha256=__import__('hashlib').sha256(json.dumps(raw['state']['config'],sort_keys=True).encode()).hexdigest(),sources=source_hashes(),
               core_count=sum(1 for _ in core()),families=FAMILIES,baseline=asdict(Rule()),
               retrospective=True,live_changes=False,
               prior_dataset='data/research/20260911-long-history-input/dataset.json',
               prior_tail='data/research/20260912-grid/tail/dataset.json',
               prior_capture=1789201226881,scenarios=SCENARIOS)
    value['numpy_runtime']=__import__('numpy').__version__
    if value['reserved_start']<=value['fit_end']:raise ValueError('Capture too short for reserved period')
    if (root/'run.json').exists() and manifest(root)!=value:raise ValueError('Immutable run manifest differs')
    write_json(root/'run.json',value)
    print(json.dumps({k:v for k,v in value.items() if k!='sources'}),flush=True)

def verify(root):
    m=manifest(root)
    if m.get('numpy_runtime') and m['numpy_runtime']!=__import__('numpy').__version__:raise ValueError('NumPy runtime changed after freeze')
    if m.get('python_runtime') and m['python_runtime']!={'version':sys.version,'executable':sys.executable,'jit':os.environ.get('PYTHON_JIT','0')}:raise ValueError('Python runtime changed after freeze')
    if digest(Path(root)/'snapshot.json.gz')!=m['snapshot_sha256']:raise ValueError('Snapshot changed')
    if (Path(root)/'candidate-exits.json').exists() and digest(Path(root)/'candidate-exits.json')!=m['exit_catalog_sha256']:raise ValueError('Exit catalog changed')
    if source_hashes()!=m['sources']:raise ValueError('Research sources changed after freeze; create a new version')
    return m

class Runner:
    def __init__(self,root):
        self.root=Path(root);self.m=verify(root)
        self.lock=(self.root/'v2.lock').open('a+');fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def command(self,stage,module,args):
        verify(self.root)
        if (self.root/'pause.request').exists():raise RuntimeError('Research pause requested')
        record=self.root/stage;record.mkdir(parents=True,exist_ok=True)
        identity=dict(run_sha256=digest(self.root/'run.json'),module=module,args=args)
        ip=record/'command.json'
        if ip.exists() and read_json(ip)!=identity:raise ValueError('Command checkpoint mismatch')
        write_json(ip,identity)
        if (record/'command-completed.json').exists():
            if read_json(record/'command-completed.json')['command_sha256']!=digest(ip):raise ValueError('Command completion identity mismatch')
            stamp=read_json(record/'command-completed.json')
            if stage in ('parity','acquire','models','accounts') or stage.startswith(('models-','accounts-')):
                if stamp.get('outputs') and all(Path(p).exists() and digest(Path(p))==h for p,h in stamp['outputs'].items()):return
        started=time.time()
        with (record/'run.log').open('a') as log:
            child=subprocess.Popen([sys.executable,'-m',module,*args],stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={**os.environ,'RESEARCH_PROGRESS_PATH':str(record/'progress.json')})
            try:
                while child.poll() is None:
                    # Progress is produced by the actual stage, not inferred from PID liveness.
                    progress={}
                    for p in record.rglob('progress.json'):
                        current=read_json(p)
                        if current.get('at',0)>progress.get('at',0):progress=current
                    elapsed=time.time()-started
                    done=progress.get('completed',0);total=progress.get('total')
                    measured=progress.get('elapsed',0)
                    eta=(total-done)*measured/done if total and done and measured else None
                    write_json(self.root/'status.json',dict(stage=stage,state='running',pid=os.getpid(),child_pid=child.pid,
                        heartbeat=int(time.time()*1000),elapsed_seconds=elapsed,progress=progress,
                        estimated_remaining_seconds=eta,estimate_scope='current segment only' if eta else 'unavailable',live_changes=False))
                    time.sleep(5)
                if child.returncode:raise RuntimeError(f'{stage} exited {child.returncode}; see {record}/run.log')
            except BaseException:
                if child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=10)
                raise
        artifact_root=Path(args[args.index('--root')+1]) if '--root' in args else self.root
        output_names=['exit-models.sqlite'] if stage.startswith('models') else ['accounts/index.json','accounts/coverage.json'] if stage.startswith('accounts') else ['dataset.json','manifest.json'] if stage=='acquire' else ['batch-parity.json'] if stage=='parity' else []
        outputs={str(artifact_root/n):digest(artifact_root/n) for n in output_names if (artifact_root/n).exists()}
        if stage.startswith('accounts'):
            outputs.update({str(artifact_root/'accounts'/f'{n}.json'):h for n,h in read_json(artifact_root/'accounts/index.json')['files'].items()})
        write_json(record/'command-completed.json',dict(command_sha256=digest(ip),elapsed=time.time()-started,outputs=outputs))
    def phase(self,phase,**kwargs):
        args=['--root',str(self.root),'--action',phase]
        for k,v in kwargs.items():args.extend(['--'+k.replace('_','-'),str(v)])
        self.command(phase,'research.core.grid_v2_run',args)


def account_path(root,mode,name):
    root=Path(root)
    if manifest(root).get('entry_timing_models'):
        path=root/'timings'/mode/'accounts'/f'{name}.json'
        if not path.exists():raise ValueError('Missing repriced entry-timing model: '+str(path))
        return path
    return root/'accounts'/f'{name}.json'

def coverage_path(root):
    root=Path(root)
    return root/'coverage.json' if manifest(root).get('entry_timing_models') else root/'accounts/coverage.json'

def model_inputs(root,mode):
    root=Path(root);out=root/'timings'/mode;out.mkdir(parents=True,exist_ok=True)
    for name in ('snapshot.json.gz','dataset.json','candidate-exits.json','batch-parity.json'):
        target=out/name
        if not target.exists():target.symlink_to((root/name).resolve())
    return out


def rules_file(path,rules):
    # Deduplicate effective identities before declaring job totals.
    values={r.name:asdict(r) for r in rules}
    values.setdefault(Rule().name,asdict(Rule()))
    value=list(values.values())
    if path.exists() and read_json(path)!=value:raise ValueError('Candidate definitions changed')
    write_json(path,value);return path


def jobs(root,label,by_exit,end):
    root=Path(root);m=verify(root);base=root/label;base.mkdir(parents=True,exist_ok=True)
    index=[]
    for name,rules in by_exit.items():
        rp=rules_file(base/(name+'-rules.json'),rules)
        for mode,variant in SCENARIOS:
            output=base/f'{name}--{mode}--{variant}'
            args=['--snapshot',str(root/'snapshot.json.gz'),'--models',str(account_path(root,mode,name)),'--shadow-models',str(account_path(root,'recorded',name)),
                  '--out',str(output),'--start',str(m['start']),'--end',str(end),'--rules',str(rp),
                  '--engine','expanded','--scenario-mode',mode,'--variant',variant,'--coverage',str(coverage_path(root))]
            index.append(dict(exit=name,mode=mode,variant=variant,output=str(output),args=args))
    identity=dict(run_sha256=digest(root/'run.json'),end=end,jobs=index,accounts_sha256=digest(root/'accounts/index.json'),
                  rules={str(p):digest(p) for p in base.glob('*-rules.json')},coverage_sha256=digest(coverage_path(root)),timing_accounts={mode:digest(root/'timings'/mode/'accounts/index.json') for mode in ('recorded','reconstructed_early')} if m.get('entry_timing_models') else {})
    jp=base/'jobs.json'
    if jp.exists() and read_json(jp)!=identity:raise ValueError('Job manifest mismatch')
    write_json(jp,identity)
    started=time.time()
    for i,job in enumerate(index):
        if shutil.disk_usage(root).free<15*1024**3:raise RuntimeError('Research paused: less than 15 GiB free disk space')
        if (root/'pause.request').exists():raise RuntimeError('Research pause requested')
        out=Path(job['output']);stamp=out/'completed.json'
        if stamp.exists():
            if not complete(out) or read_json(stamp)['design_sha256']!=digest(out/'design.json'):raise ValueError('Invalid completed job')
        else:
            subprocess.run([sys.executable,'-m','research.core.grid_final_sweep',*job['args']],check=True)
            if not complete(out):raise ValueError('Incomplete account grid')
            write_json(stamp,dict(design_sha256=digest(out/'design.json')))
        write_json(base/'progress.json',dict(at=int(time.time()*1000),completed=i+1,total=len(index),elapsed=time.time()-started))
    write_json(base/'completed.json',dict(plan_sha256=digest(jp)))


def selection(root,labels,out):
    root=Path(root);rows={};origins={};m=verify(root)
    for label in labels:
        base=root/label
        if read_json(base/'completed.json')['plan_sha256']!=digest(base/'jobs.json'):raise ValueError('Incomplete selection input')
        plan=read_json(base/'jobs.json');grouped={}
        if plan['end']!=m['fit_end']:raise ValueError('Selection cannot read evaluation outcomes')
        for job in plan['jobs']:
            if read_json(Path(job['output'])/'design.json')['end']!=m['fit_end']:raise ValueError('Selection cannot read evaluation outcomes')
            score=collect(job['output'])
            if not score['reference_complete']:continue
            grouped.setdefault(job['exit'],{})[(job['mode'],job['variant'])]=score
        for name,scenarios in grouped.items():
            if set(scenarios)!=set(SCENARIOS):continue
            common=set.intersection(*(set(s['cards']) for s in scenarios.values()))
            for key in common:
                cards=[s['cards'][key] for s in scenarios.values()]
                if not all(c['complete'] for c in cards):continue
                if not any(c['metrics']['winners']+c['metrics']['losers'] for c in cards):continue
                identity=name+'::'+key
                rows[identity]=dict(exit=name,rule=cards[0]['rule'],worst_net_wei=min(int(c['metrics']['net_wei']) for c in cards),
                    worst_dd_wei=max(int(c['metrics']['drawdown_wei']) for c in cards),
                    worst_recovery_loss_wei=max(int(c['recovery_loss_wei']) for c in cards),
                    worst_losing_recoveries=max(c['losing_recoveries'] for c in cards))
        origins[label]=digest(base/'jobs.json')
    keys=frontier(rows)
    value=dict(candidates={k:rows[k] for k in keys},tested=len(rows),inputs=origins,run_sha256=digest(root/'run.json'))
    if (root/out).exists() and read_json(root/out)!=value:raise ValueError('Frozen selection changed')
    write_json(root/out,value)
    if out=='locked-selection.json' and not (root/'candidate-lock.json').exists():
        write_json(root/'candidate-lock.json',dict(at=int(time.time()*1000),selection_sha256=digest(root/out),retrospective=True))


def selected(root,path):
    return list(read_json(Path(root)/path)['candidates'].values())

def combine_families(candidates):
    # Pair compatible base settings. Union the base settings of both parents so the
    # interaction is tested without arbitrarily choosing one parent's main window.
    fields=('fresh_brake','recovery_floor','new_outcomes','weighting','half_life','win_cap','participation')
    defaults=Rule();output={}
    rules=[Rule(**x['rule']) for x in candidates]
    def mods(r):return {k:getattr(r,k) for k in fields if getattr(r,k)!=getattr(defaults,k)}
    for r in rules:output[r.name]=r
    for a,b in itertools.combinations(rules,2):
        ma,mb=mods(a),mods(b)
        if not ma or not mb or any(k in mb and mb[k]!=v for k,v in ma.items()):continue
        for base in (a,b):
            r=replace(base,**(ma|mb));output[r.name]=r
    return list(output.values())


def stage(root,action):
    root=Path(root);m=verify(root);end=m['fit_end']
    names=read_json(root/'candidate-exits.json')['coarse'] if (root/'candidate-exits.json').exists() else []
    if action=='core':jobs(root,'core',{'fixed_45':list(core())},end)
    elif action=='families':
        for family in FAMILIES:jobs(root,'families/'+family,{'fixed_45':list(family_rules(family))},end)
        selection(root,['core',*('families/'+f for f in FAMILIES)],'family-selection.json')
    elif action=='exits':jobs(root,'exits',{n:[Rule()] for n in names},end)
    elif action=='cross':
        jobs(root,'cross',{n:list(core()) for n in names},end)
        selection(root,['cross'],'core-selection.json')
    elif action=='pairs':
        jobs(root,'pairs',{'fixed_45':combine_families(selected(root,'family-selection.json'))},end)
        selection(root,['pairs'],'pair-selection.json')
    elif action=='pair_cross':
        rr=[Rule(**x['rule']) for x in selected(root,'pair-selection.json')]
        jobs(root,'pair_cross',{n:rr for n in names},end)
        selection(root,['cross','pair_cross'],'combined-selection.json')
    elif action=='refine':
        grouped={'fixed_45':[Rule()]}
        for x in selected(root,'combined-selection.json'):
            r=Rule(**x['rule']);rr=[r,*neighbors(r)];grouped.setdefault(x['exit'],[]).extend(rr)
            for exit_name in read_json(root/'candidate-exits.json')['neighbors'].get(x['exit'],[]):grouped.setdefault(exit_name,[]).extend(rr)
        jobs(root,'refine',grouped,end)
        selection(root,['cross','pair_cross','refine'],'refined-selection.json')
    elif action=='expand':
        from .grid_v2_guard import BOUNDS
        grouped={'fixed_45':[Rule()]}
        for x in selected(root,'refined-selection.json'):
            r=Rule(**x['rule'])
            if any(getattr(r,k) in bounds for k,bounds in BOUNDS.items()):grouped.setdefault(x['exit'],[]).extend([r,*neighbors(r,True)])
            for exit_name in read_json(root/'candidate-exits.json').get('expansions',{}).get(x['exit'],[]):
                grouped.setdefault(exit_name,[]).append(r)
        jobs(root,'expand',grouped,end)
        selection(root,['cross','pair_cross','refine','expand'],'locked-selection.json')
    else:raise ValueError('Unknown stage '+action)


def pipeline(root):
    r=Runner(root)
    def stop(signum,frame):raise InterruptedError('Research process interrupted')
    signal.signal(signal.SIGTERM,stop)
    try:
        proof=read_json(Path(root)/'batch-parity.json') if (Path(root)/'batch-parity.json').exists() else {}
        if not (proof.get('exact_cases')==9936 and proof.get('exit_catalog_sha256')==r.m['exit_catalog_sha256'] and proof.get('expanded_exact_cases',0)>=76320 and all(digest(Path(p))==h for p,h in proof.get('hashes',{}).items())):
            r.command('parity','research.core.grid_batch_verify',['--root',str(root)])
        r.command('acquire','research.core.grid_v2_acquire',['--root',str(root)])
        r.command('cash-fidelity','research.core.grid_v2_fidelity',['--root',str(root)])
        for mode in ('recorded','reconstructed_early'):
            target=model_inputs(root,mode)
            r.command('models-'+mode,'research.core.grid_models',['--root',str(target),'--entry-mode',mode])
            r.command('accounts-'+mode,'research.core.grid_accounts',['--root',str(target)])
        accounts=Path(root)/'accounts'
        if not accounts.exists():accounts.symlink_to((Path(root)/'timings/recorded/accounts').resolve(),target_is_directory=True)
        unknown=sorted({at for mode in ('recorded','reconstructed_early') for at in read_json(Path(root)/'timings'/mode/'accounts/coverage.json')['unknown']})
        write_json(Path(root)/'coverage.json',dict(unknown=unknown,meaning='Common unavailable executions across both repriced entry timings and all exit policies'))
        for phase in ('core','families','exits','cross','pairs','pair_cross','refine','expand'):r.phase(phase)
        r.command('validation','research.core.grid_v2_validate',['--root',str(root)])
        r.command('folds','research.core.grid_v2_folds',['--root',str(root)])
        r.command('prospective-observations','research.core.grid_v2_prospective',['--root',str(root)])
        r.command('report','research.core.grid_v2_report',['--root',str(root)])
        write_json(Path(root)/'status.json',dict(state='report_generated_verification_pending',at=int(time.time()*1000),live_changes=False))
    except BaseException as e:
        write_json(Path(root)/'status.json',dict(state='failed',at=int(time.time()*1000),error=str(e),live_changes=False));raise

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--action',default='run');a=p.parse_args()
    if a.action=='freeze':freeze(a.root)
    elif a.action=='run':pipeline(a.root)
    else:stage(a.root,a.action)
