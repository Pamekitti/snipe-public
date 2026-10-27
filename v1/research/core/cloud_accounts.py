"""Pin selectors causally, then materialize inputs for the shared account reducer."""
import argparse,collections,json,math
from pathlib import Path
from .data import read_json,write_json,digest
from .publication import publication_time, validate_policy
TARGETS=[1.25,1.36,1.5,1.75,2,2.5,3]
HOLDS=[20,25,30,35,40,45,50,60]
SPECS=read_json(Path(__file__).with_name('cloud-exits.json'))
EXITS=[s['id'] for s in SPECS[:8]]+['adaptive-hold']+[s['id'] for s in SPECS[8:]]
IDS=['p10-before','p10-after','p50-before','p50-after','p90-before','p90-after']
def missing(at,reason):return dict(modelVersion='execution-account-v3',evidenceVersion='capture-v3',status='unavailable',reason=reason,entryAt=at,exitAt=None,decisionAt=None,tokens=None,spentWei=None,proceedsWei=None,pnlWei=None,costsWei='0',scenario=None,trace=[],assumption='External traders retain historical order quantities')
def append_json(stream,value,state,key):
 if state[key]:stream.write(',')
 stream.write(json.dumps(value,separators=(',',':')));state[key]+=1

def run(root,only_exits=None,output_root=None):
 root=Path(root);destination=Path(output_root) if output_root else root
 active_exits=EXITS if only_exits is None else [e for e in EXITS if e in only_exits]
 if only_exits is not None and (not only_exits or len(set(only_exits))!=len(only_exits) or set(only_exits)-set(EXITS)):raise ValueError('invalid exit subset')
 m=read_json(root/'input-manifest.json');out=destination/'accounts';out.mkdir(exist_ok=True,parents=True);files=[];states=[];total=0;corrected_start=None
 publication_policy=m.get('publicationPolicy');validate_policy(publication_policy)
 def initialize(lane,lane_start,prefix):
  controls=[c for c in m['controls'] if c['at']>=lane_start]
  preceding=[c for c in m['controls'] if c['at']<lane_start and 'halted' in c]
  if preceding:controls.insert(0,{**preceding[-1],'id':'initial-recorded-control','at':lane_start})
  for memory in [10,20,40]:
   for ei,exit in enumerate(active_exits):
    spec=next((s for s in SPECS if s['id']==exit),{'core':True,'changes':0})
    if not spec['core'] and memory!=20:continue
    path=out/f'{lane}-memory{memory}-{exit}.json';pinpath=out/f'{lane}-memory{memory}-{exit}-pinned.json'
    stream=open(str(path)+'.tmp','w');pin=open(str(pinpath)+'.tmp','w')
    base=dict(start=lane_start,through=m['through'],initialKnown=True,config=m['config'],controls=controls)
    stream.write(json.dumps(base,separators=(',',':'))[:-1]+',"opportunities":[');pin.write('[')
    states.append(dict(lane=lane,offset=0 if lane=='fixed' else 6,memory=memory,ei=ei,exit=exit,spec=spec,fixed_index=next((i for i,s in enumerate(SPECS) if s['id']==exit),5),pending=[],visible=[],path=path,pinpath=pinpath,output=stream,pinned=pin,opps=0,pins=0,start=lane_start,prefix=prefix))
 initialize('fixed',m['start'],0)
 previous=None
 for path in sorted((root/'matrices').glob('[0-9][0-9][0-9][0-9].json')):
  rows=read_json(path)
  for row in rows:
   order=(row['at'],row['sequence'])
   if previous and order<previous:raise ValueError('Matrix chunks are not in causal order')
   previous=order
   if corrected_start is None and row.get('matrix') and len(row['matrix'])>=12:
    corrected_start=row['at'];initialize('corrected',corrected_start,total)
   for state in states:
    offset,memory,ei,exit,fixed_index=[state[k] for k in ['offset','memory','ei','exit','fixed_index']]
    pending,visible=state['pending'],state['visible']
    at=row['at'];ready=[r for available,r in pending if available<at];pending=[p for p in pending if p[0]>=at];visible.extend(ready);visible.sort(key=lambda r:(-r['block'],r['token']));visible=visible[:40]
    recent=visible[:memory];fixed=fixed_index
    def valid(r,h):
     cache=r.setdefault('_valid',{});key=(offset,h)
     if key not in cache:
      mat=r.get('matrix');cache[key]=mat is not None and len(mat)>=offset+6 and all(h<len(mat[s]) and mat[s][h][t]['pnlWei'] is not None and mat[s][h][t]['exitAt'] is not None for s in range(offset,offset+6) for t in range(7))
     return cache[key]
    target=3
    if len(recent)==memory and all(valid(r,fixed) for r in recent):target=max(range(7),key=lambda t:sum(int(r['matrix'][offset+3][fixed][t]['pnlWei']) for r in recent))
    hold=fixed
    if exit=='adaptive-hold':
     holdRecent=visible[:20]
     if len(holdRecent)==20 and all(all(valid(r,h) for h in range(8)) for r in holdRecent):
      hold=max(range(8),key=lambda h:(sum(int(r['matrix'][offset+3][h][target]['pnlWei']) for r in holdRecent),h==5,-HOLDS[h]))
    mat=row.get('matrix');results=[mat[s][hold][target] if mat and len(mat)>s and len(mat[s])>hold else missing(at,'source_or_preceding_clock_unavailable') for s in range(offset,offset+6)]
    results=[{'modelVersion':'execution-account-v3','evidenceVersion':'capture-v3','entryAt':at,'trace':[],'scenario':id,'assumption':'External traders retain historical order quantities',**r} for id,r in zip(IDS,results)]
    faults=[dict(id=id,reason=r['reason']) for id,r in zip(IDS,results) if r['pnlWei'] is None or r['exitAt'] is None];closed=None if faults else max(r['exitAt'] for r in results)
    available,publication_evidence=publication_time(row,closed if closed is not None else at+180000,publication_policy)
    minimal={k:row[k] for k in ['id','token','sequence','at','block','launched','creatorTaxBps','exemptions','template','configId','config','sizeWei']}
    available+=m.get('publicationExtraDelayMs',0)
    minimal.update(availableAt=available,bundle={'version':'conservative-six-v1','complete':not faults,'closedThrough':closed,'unavailable':faults,'scenarios':[{'id':id,'request':{'coverage':row.get('coverage',{'complete':False,'independentlyChecked':False,'gaps':['unavailable']})},'result':r} for id,r in zip(IDS,results)]})
    if publication_policy is not None:minimal['publicationEvidence']=publication_evidence
    if row.get('bookEligible',True):append_json(state['output'],minimal,state,'opps')
    append_json(state['pinned'],{'id':row['id'],'at':at,'target':TARGETS[target],'hold':SPECS[hold]['id'],'warmup':len(recent),'availableAt':available},state,'pins')
    if row['selectorPopulation']:
     indices=range(8) if exit=='adaptive-hold' else [fixed]
     allresults=[r for scenario in (mat[offset:offset+6] if mat and len(mat)>=offset+6 else []) for hi in indices if hi<len(scenario) for r in scenario[hi]]
     publication,_=publication_time(row,max([r['exitAt'] or at+180000 for r in allresults] or [at+180000]),publication_policy,selector=True)
     pending.append((publication+m.get('publicationExtraDelayMs',0),row))
    state['pending']=pending;state['visible']=visible

   total+=1
  print('streamed account source',path.name,total,flush=True)
 if corrected_start is None:initialize('corrected',m['through'],total)
 for state in states:
  state['output'].write(']}');state['output'].close();state['pinned'].write(']');state['pinned'].close()
  path,pinpath=state['path'],state['pinpath'];Path(str(path)+'.tmp').replace(path);Path(str(pinpath)+'.tmp').replace(pinpath)
  spec=state['spec']
  files.append({'path':str(path),'sha256':digest(path),'lane':state['lane'],'memory':state['memory'],'exit':state['exit'],'refinementOnly':not spec['core'],'timerChanges':spec['changes'],'start':state['start'],'unavailablePrefixLaunches':state['prefix'],'initialAccountAssumption':'known flat at lane start; corrected lane covers only the causally supported later period'})
 write_json(destination/'account-manifest.json',{'inputs':files,'inputManifestHash':digest(root/'input-manifest.json'),'selector':'same target pinned across six execution stresses; central scenario ranks preceding complete common outcomes in broader observation population; ties choose lower TP','holdSelector':'preceding 20 common complete outcomes; central scenario; tie 45 then shorter','publicationPolicy':publication_policy or {'kind':'recorded'},'publication':'explicit modeled observer scenario' if publication_policy and publication_policy['kind']=='modeled-periodic-v1' else 'strictly after common modeled closure and recorded gate publication; local historical publication modeled','diagnosticOnly':True})
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--exits');p.add_argument('--output-root');a=p.parse_args();run(a.root,a.exits.split(',') if a.exits else None,a.output_root)
