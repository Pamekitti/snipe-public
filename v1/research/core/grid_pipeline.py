"""Run the approved September research stages sequentially with durable status."""
import argparse
import fcntl
import os
import subprocess
import sys
import time
from pathlib import Path
from .data import read_json, write_json, digest


def run(root,wait_pid=None):
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    lock=(root/'pipeline.lock').open('a+')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    status=root/'pipeline-status.json'
    def stage(name,state='running',**extra):
        write_json(status,dict(stage=name,state=state,at=int(time.time()*1000),pid=os.getpid(),live_changes=False,**extra))
        print(name,state,flush=True)
    def command(name,module,*args):
        if (root/'pause.request').exists():raise RuntimeError('Research pause requested; completed checkpoints retained')
        stage(name)
        with (root/(name+'.log')).open('a') as log:
            subprocess.run([sys.executable,'-m',module,*args],stdout=log,stderr=subprocess.STDOUT,check=True)
    try:
        if wait_pid:
            stage('waiting_for_existing_acquisition',wait_pid=wait_pid)
            while True:
                try:os.kill(wait_pid,0)
                except ProcessLookupError:break
                if (root/'pause.request').exists():raise RuntimeError('Research pause requested')
                time.sleep(20)
        if not (root/'tail/manifest.json').exists():
            # Acquisition archives every research source. Rebuild from its durable cache
            # after development is frozen if the earlier process rejects changed sources.
            command('prepare_tail','research','prepare','--snapshot',str(root/'snapshot.json.gz'),'--out',str(root/'tail'),
                    '--days','12','--since-ms','1789130652950','--population','screened','--scope','opportunities','--fetch-missing','--immutable-latest')
        if not (root/'dataset.json').exists():command('acquire','research.core.grid_acquire','--root',str(root))
        if read_json(root/'manifest.json')['dataset_sha256']!=digest(root/'dataset.json'):raise ValueError('Merged dataset hash mismatch')
        command('exit_models','research.core.grid_models','--root',str(root))
        command('account_inputs','research.core.grid_accounts','--root',str(root))
        command('exit_axis','research.core.grid_jobs','--root',str(root),'--phase','exit_axis')
        command('joint_coarse','research.core.grid_jobs','--root',str(root),'--phase','joint_coarse')
        command('coarse_selection','research.core.grid_select','--root',str(root),'--phase','joint_coarse')
        command('refinement','research.core.grid_jobs','--root',str(root),'--phase','refinement')
        command('locked_selection','research.core.grid_select','--root',str(root),'--phase','refinement')
        command('validation','research.core.grid_validate','--root',str(root))
        command('report','research.core.grid_final_report','--root',str(root))
        stage('research_outputs','complete',visual_review='pending',profitability_status='diagnostic_only')
    except Exception as error:
        stage('pipeline','failed',error=str(error),failed_stage=read_json(status)['stage'])
        raise


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',default='data/research/20260912-grid');parser.add_argument('--wait-pid',type=int)
    args=parser.parse_args();run(args.root,args.wait_pid)
