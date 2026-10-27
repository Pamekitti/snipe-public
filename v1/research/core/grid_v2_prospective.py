"""Read new baseline observations after candidate lock; never change live controls."""
import argparse,json,subprocess,time
from pathlib import Path
from .data import read_json,write_json,digest
from .grid_v2_run import verify

# Connection details follow v1/DEPLOY.md. This query runs separately from the bot.
def run(root):
    root=Path(root);verify(root);lock=read_json(root/'candidate-lock.json')
    if lock['selection_sha256']!=digest(root/'locked-selection.json'):raise ValueError('Candidate lock changed')
    script='''import json,sqlite3,time
from pathlib import Path
start=START
end=int(time.time()*1000)
db=sqlite3.connect('file:'+str(Path.home()/'snipe/v1/data/bot.db')+'?mode=ro',uri=True,timeout=5)
db.row_factory=sqlite3.Row
db.execute('pragma query_only=on')
data={}
for table,column in [('shadow_jobs','available'),('shadow_decisions','at'),('guard_samples','at'),('positions','exit_at')]:
 data[table]=[dict(r) for r in db.execute('select * from '+table+' where '+column+'>=? and '+column+'<?',(start,end))]
db.close()
print(json.dumps(dict(start=start,end=end,rows=data)))
'''.replace('START',str(lock['at']))
    command=['ssh','-i',str(Path.home()/'.ssh/example-host'),'-o','BatchMode=yes','-o','ConnectTimeout=8','operator@localhost','python3 -']
    try:
        result=subprocess.run(command,input=script,text=True,capture_output=True,timeout=60,check=True)
        capture=json.loads(result.stdout)
        jobs=[j for j in capture['rows']['shadow_jobs'] if j['status']=='published']
        transitions=[];previous=None
        for row in sorted(capture['rows']['shadow_decisions'],key=lambda r:r['at']):
            value=json.loads(row['reading']) if isinstance(row['reading'],str) else row['reading']
            state=value.get('state')
            if state!=previous:transitions.append(dict(at=row['at'],state=state))
            previous=state
        # A first open reading is not proof of a recovery during the new period.
        recoveries=sum(a['state']=='shut' and b['state']=='open' for a,b in zip(transitions,transitions[1:]))
        cash=[p for p in capture['rows']['positions'] if p.get('live') and p.get('closed')]
        write_json(root/'prospective-observations/capture.json',capture)
        value=dict(status='baseline_observations_only',start=lock['at'],end=capture['end'],complete_shadow_outcomes=len(jobs),actual_completed_attempts=len(cash),recorded_baseline_recoveries=recoveries,configurations=sorted({j['config'] for j in jobs}),candidate_performance_assessed=False,limitation='These are new baseline observations. Frozen candidate accounts require price-path acquisition and independent replay before prospective retention can be assessed.')
    except (subprocess.SubprocessError,ValueError,KeyError) as error:
        value=dict(status='unavailable',start=lock['at'],end=int(time.time()*1000),error=str(error),candidate_performance_assessed=False)
    value['selection_sha256']=lock['selection_sha256'];write_json(root/'prospective-observations/summary.json',value)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);run(parser.parse_args().root)
