"""Materialize independent exit accounts concurrently with hash-bound checkpoints."""
import argparse
import concurrent.futures
import hashlib
import importlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from .data import digest, read_json, write_json


def run(root, workers=8, output_root=None, builder_module='research.core.cloud_accounts'):
    root=Path(root);destination=Path(output_root) if output_root else root
    destination.mkdir(parents=True,exist_ok=True);module=importlib.import_module(builder_module)
    groups=[[] for _ in range(workers)];weights=[0]*workers
    core={s['id'] for s in module.SPECS if s['core']}|{'adaptive-hold'}
    for exit_name in sorted(module.EXITS,key=lambda e:(e not in core,module.EXITS.index(e))):
        group=min(range(workers),key=lambda i:weights[i]);groups[group].append(exit_name);weights[group]+=6 if exit_name in core else 2
    groups=[g for g in groups if g];started=time.time();completed=0
    source_hash=digest(root/'input-manifest.json');builder_hash=digest(module.__file__);helper_hash=digest(__file__)
    complete_path=destination/'account-preparation-complete.json'
    if complete_path.exists():
        proof=read_json(complete_path)
        if proof.get('inputManifestHash')!=source_hash or proof.get('builderHash')!=builder_hash or proof.get('orchestratorHash')!=helper_hash:
            raise ValueError('Completed account preparation has different frozen inputs or code')
        if not proof.get('files') or any(not (destination/'accounts'/name).exists() or digest(destination/'accounts'/name)!=sha for name,sha in proof['files'].items()):
            raise ValueError('Completed account payload changed')
        if digest(destination/'account-manifest.json')!=proof['accountManifestHash']:raise ValueError('Completed account manifest changed')
        return
    def build(pair):
        number,exits=pair;folder=destination/'account-batches'/str(number);folder.mkdir(parents=True,exist_ok=True)
        identity=hashlib.sha256(json.dumps({'input':source_hash,'builder':builder_hash,'helper':helper_hash,'exits':exits},sort_keys=True).encode()).hexdigest()
        checkpoint=folder/'checkpoint.json'
        if checkpoint.exists():
            proof=read_json(checkpoint)
            if proof['jobHash']==identity and all((folder/name).exists() and digest(folder/name)==sha for name,sha in proof['files'].items()):return folder
        with (folder/'build.log').open('w') as log:
            subprocess.run([sys.executable,'-u','-m',builder_module,'--root',str(root),'--exits',','.join(exits),'--output-root',str(folder)],stdout=log,stderr=subprocess.STDOUT,check=True)
        files={str(p.relative_to(folder)):digest(p) for p in (folder/'accounts').glob('*.json')}
        files['account-manifest.json']=digest(folder/'account-manifest.json')
        write_json(checkpoint,{'jobHash':identity,'files':files});return folder
    def status():
        elapsed=time.time()-started
        write_json(destination/'account-preparation-status.json',dict(stage='parallel_account_inputs',completed=completed,total=len(groups),workers=workers,
            heartbeat=time.time(),elapsedSeconds=elapsed,estimateRemainingSeconds=(len(groups)-completed)*elapsed/completed if completed else None))
    folders=[];status()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        pending={pool.submit(build,item) for item in enumerate(groups)}
        while pending:
            ready,pending=concurrent.futures.wait(pending,timeout=20,return_when=concurrent.futures.FIRST_COMPLETED)
            for future in ready:folders.append(future.result());completed+=1
            status()
    output=destination/'accounts';output.mkdir(exist_ok=True);inputs=[];manifest=None;payload_hashes={}
    for folder in folders:
        batch=read_json(folder/'account-manifest.json')
        if batch['inputManifestHash']!=source_hash:raise ValueError('Input manifest changed during preparation')
        manifest=manifest or {k:v for k,v in batch.items() if k!='inputs'}
        payload_hashes.update({Path(name).name:sha for name,sha in read_json(folder/'checkpoint.json')['files'].items() if name.startswith('accounts/')})
        for item in batch['inputs']:
            source=Path(item['path']);target=output/source.name
            for original in [source,source.with_name(source.stem+'-pinned.json')]:
                target_file=output/original.name
                if target_file.exists():
                    if digest(target_file)!=digest(original):raise ValueError('Conflicting materialized account')
                else:os.link(original,target_file)
            inputs.append({**item,'path':str(target)})
    inputs.sort(key=lambda i:([ 'fixed','corrected'].index(i['lane']),[10,20,40].index(i['memory']),module.EXITS.index(i['exit'])))
    if len({i['path'] for i in inputs})!=len(inputs):raise ValueError('Duplicate account output')
    write_json(destination/'account-manifest.json',{**manifest,'inputs':inputs})
    # Each payload now has its canonical name. Retain checkpoint metadata and logs.
    for folder in folders:
        for path in (folder/'accounts').glob('*.json'):path.unlink()
        (folder/'accounts').rmdir()
    write_json(destination/'account-preparation-complete.json',dict(accounts=len(inputs),workers=workers,elapsedSeconds=time.time()-started,
        inputManifestHash=source_hash,builderHash=builder_hash,orchestratorHash=helper_hash,
        accountManifestHash=digest(destination/'account-manifest.json'),files=payload_hashes))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--output-root');parser.add_argument('--workers',type=int,default=8)
    parser.add_argument('--builder-module',default='research.core.cloud_accounts');args=parser.parse_args()
    if not 1<=args.workers<=32:parser.error('workers must be between 1 and 32')
    run(args.root,args.workers,args.output_root,args.builder_module)
