"""Run frozen quote sensitivities sequentially on one temporary worker."""
import argparse,concurrent.futures,gzip,json,os,shutil,subprocess,sys,time,traceback
from pathlib import Path
from .data import read_json,write_json,digest
from .cloud_run import run as run_grid
from .bounded_pool import acquire
from .bounded_storage import complete, is_complete, restore_partial

def run(root,upstream):
    root=Path(root);m=read_json(root/'input-manifest.json');began=time.time()
    def status(stage,**kw):write_json(root/'bounded-status.json',dict(stage=stage,heartbeat=time.time(),elapsedSeconds=time.time()-began,**kw))
    try:
        status('execution_matrix')
        run_grid(root,16,execution_only=True)
        status('historical_pool_quotes')
        acquire(root,root/'rpc-cache.sqlite',upstream)
        completed=[]
        parent_freeze=digest(root/'run-freeze.json')
        total=len(m['poolScenarios'])*len(m['publicationDelaysMs'])
        # Publication delays alter account evidence, never execution outcomes.
        # Materialize each pool sensitivity once and reuse it across those delays.
        for pool in m['poolScenarios']:
            pending=[extra for extra in m['publicationDelaysMs'] if not is_complete(root/'scenarios'/(pool['id']+f'-pub{extra}'),parent_freeze)]
            if not pending:
                for extra in m['publicationDelaysMs']:
                    name=pool['id']+f'-pub{extra}'
                    completed.append({'scenario':name,'summary':read_json(root/'scenarios'/name/'comparison-summary.json')})
                continue
            hydrated=root/'hydrated'/pool['id'];hydrated.mkdir(parents=True,exist_ok=True)
            def hydrate(path):
                dest=hydrated/path.name;quotes=root/'pool-quotes'/path.name
                identity={'source':digest(path),'quotes':digest(quotes),'pool':pool,
                    'freeze':digest(root/'run-freeze.json')}
                checkpoint=dest.with_suffix('.checkpoint.json')
                if checkpoint.exists() and dest.exists():
                    proof=read_json(checkpoint)
                    if proof['identity']==identity and proof['output']==digest(dest):return path.name,proof['output']
                subprocess.run(['node','--import','tsx','research/core/bounded_hydrate.ts',str(path),str(quotes),str(dest),str(pool['extraDelayMs']),str(pool['haircutBps'])],check=True,stdout=subprocess.DEVNULL)
                value=digest(dest);write_json(checkpoint,{'identity':identity,'output':value})
                return path.name,value
            status('scenario_hydration',scenario=pool['id'],completed=len(completed),total=total)
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
                prepared=dict(workers.map(hydrate,sorted((root/'matrices').glob('[0-9][0-9][0-9][0-9].json'))))
            for extra in m['publicationDelaysMs']:
                name=pool['id']+f'-pub{extra}';runroot=root/'scenarios'/name;runroot.mkdir(parents=True,exist_ok=True)
                if is_complete(runroot,parent_freeze):
                    completed.append({'scenario':name,'summary':read_json(runroot/'comparison-summary.json')})
                    continue
                status('scenario_grid',scenario=name,completed=len(completed),total=total)
                config={**m,'publicationExtraDelayMs':extra,'preparedMatrices':prepared}
                matrixdir=runroot/'matrices';matrixdir.mkdir(exist_ok=True)
                for filename,expected in prepared.items():
                    target=matrixdir/filename
                    if target.exists():
                        if digest(target)!=expected:raise ValueError('Scenario matrix changed')
                    else:os.link(hydrated/filename,target)
                manifest=runroot/'input-manifest.json'
                if manifest.exists() and read_json(manifest)!=config:raise ValueError('Scenario manifest changed')
                write_json(manifest,config)
                restore_partial(runroot)
                run_grid(runroot,16)
                completed.append({'scenario':name,'summary':read_json(runroot/'comparison-summary.json')})
                write_json(root/'scenario-summary.json',{'completed':completed,'total':total,'diagnosticOnly':True})
                # The shared hydrated directory retains every input byte.
                # A path/hash inventory makes the scenario linkage reproducible.
                write_json(runroot/'matrix-inventory.json',{'source':str(hydrated),'files':prepared})
                for path in matrixdir.glob('*.json'):path.unlink()
                complete(runroot,parent_freeze)
            # Keep one lossless copy per pool scenario, with deterministic gzip.
            for path in hydrated.glob('[0-9][0-9][0-9][0-9].json'):
                target=Path(str(path)+'.gz')
                with path.open('rb') as src,target.open('wb') as out:
                    with gzip.GzipFile(filename='',mode='wb',fileobj=out,compresslevel=1,mtime=0) as dest:shutil.copyfileobj(src,dest)
                path.unlink()
        status('scoring_complete',completed=len(completed),total=total)
    except BaseException as e:
        status('failed',error=str(e),traceback=traceback.format_exc());raise

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--upstream',required=True);a=p.parse_args();run(a.root,a.upstream)
