"""Import preserved paths and backfill all recorded ETH launches with capped RPC reads."""
import collections,gzip,hashlib,json,sqlite3,time,requests,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'v1/data/research/20260922-market-september-v1'
DB=OUT/'history.sqlite'
ZERO='0x'+'0'*40
TOPICS=['0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455','0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df','0x5feba9b0d52c92ada4b9c571c2bee52390c54f2947208ab250221e6ee32f12ff','0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67']
d=sqlite3.connect(DB)
d.execute('pragma journal_mode=WAL')
d.execute('create table if not exists facts(token text primary key,curve text,block integer,at integer,pair text,body text)')
d.execute('create table if not exists paths(curve text primary key,source text,body text)')
d.execute('create table if not exists inputs(path text primary key,sha256 text)')
d.execute('create table if not exists failed(key text primary key,body text,error text)')
d.execute('create table if not exists query_proofs(key text primary key,request text,rows integer,sha256 text,at integer)')
if not d.execute('select count(*) from facts').fetchone()[0]:
 own=[]
 for line in gzip.open(OUT/'legacy-launches.ndjson.gz','rt'):
  row=json.loads(line)
  if row['kind']=='own':own.extend(x for x in row['row'].values() if x);continue
  f=row['row'];d.execute('insert or ignore into facts values(?,?,?,?,?,?)',(f['token'].lower(),(f['curve'] or '').lower(),f['block'],f['detected_at'],(f['pair_token'] or '').lower(),json.dumps(f,separators=(',',':'))))
 d.commit();(OUT/'legacy-own-hashes.json').write_text(json.dumps(own))

if '--import' in sys.argv:
 folders=['20260914-execution-repair-v1/source/jobs','20260914-focused-guard-v1/complete-tail/jobs','20260917-per-book-to-today/pipeline/jobs']
 wanted={r[0] for r in d.execute('select token from facts where pair=?',(ZERO,))}
 for folder in folders:
  for index,p in enumerate(sorted((ROOT/'v1/data/research'/folder).glob('*.json'))):
   if d.execute('select 1 from inputs where path=?',(str(p),)).fetchone():continue
   content=p.read_bytes();jobs=json.loads(content)
   for job in jobs:
    if job['id'].lower() not in wanted:continue
    q=job.get('request')
    if not q:continue
    coverage=q.get('coverage',{})
    launched=int(q['params']['launchedAt'])*1000
    if not coverage.get('complete') or not coverage.get('independentlyChecked') or coverage.get('gaps') or coverage.get('through',0)<launched+55000:continue
    logs=[l for l in q['logs'] if int(l['blockNumber'],0) <= job['block']+600]
    d.execute('insert or replace into paths values(?,?,?)',(q['curve'].lower(),'archived:'+folder,json.dumps(dict(params=q['params'],logs=logs,through=job['block']+600),separators=(',',':'))))
   d.execute('insert into inputs values(?,?)',(str(p),hashlib.sha256(content).hexdigest()));d.commit()
   if index%20==0:print(json.dumps({'folder':folder,'file':index,'paths':d.execute('select count(*) from paths').fetchone()[0]}),flush=True)
 print('IMPORT COMPLETE',d.execute('select count(*) from paths').fetchone()[0],flush=True)

if '--fetch' not in sys.argv:sys.exit(0)
missing=d.execute("select f.curve,f.block from facts f left join paths p on p.curve=f.curve and p.source!='legacy-global-capture' where f.pair=? and p.curve is null and f.block>0 order by f.block",(ZERO,)).fetchall()
groups=[]
for curve,block in missing:
 if not groups or block-groups[-1][0][1]>8000 or len(groups[-1])>=250:groups.append([])
 groups[-1].append((curve,block))
queue=collections.deque(groups)
session=requests.Session()
stats=dict(initialMissing=len(missing),initialGroups=len(groups),resolved=0,requests=0,errors=0,started=time.time())
(OUT/'fetch-progress.json').write_text(json.dumps(stats,indent=2))
def spec(group,rid):
 lo=min(x[1] for x in group);hi=max(x[1] for x in group)+600
 return dict(jsonrpc='2.0',id=rid,method='eth_getLogs',params=[dict(fromBlock=hex(lo),toBlock=hex(hi),address=[x[0] for x in group],topics=[TOPICS])])
last=0
pace=1.4
successes=0
while queue:
 batch=[queue.popleft()]
 batch=[[x for x in g if not d.execute("select 1 from paths where curve=? and source!='legacy-global-capture'",(x[0],)).fetchone()] for g in batch]
 batch=[g for g in batch if g]
 if not batch:continue
 time.sleep(max(0,pace-(time.monotonic()-last)));last=time.monotonic()
 requests_=[spec(g,i) for i,g in enumerate(batch)]
 try:
  response=session.post('https://rpc.mainnet.chain.robinhood.com',json=requests_[0],timeout=45)
  response.raise_for_status();answer=response.json()
  if isinstance(answer,dict):answer=[answer]
  lookup={r.get('id'):r for r in answer}
 except Exception as exc:
  lookup={};print('request failure',str(exc)[:120],flush=True)
 stats['requests']+=len(batch)
 throttled=False
 for i,group in enumerate(batch):
  row=lookup.get(i,{});logs=row.get('result');error=row.get('error')
  if not isinstance(logs,list):
   stats['errors']+=1
   msg=str(error or 'missing reply')
   if '429' in msg or 'Too Many' in msg or not row:
    queue.append(group);throttled=True;continue
   if len(group)>1:
    mid=len(group)//2;queue.appendleft(group[mid:]);queue.appendleft(group[:mid]);continue
   key=group[0][0];d.execute('insert or replace into failed values(?,?,?)',(key,json.dumps(group),msg));continue
  if len(logs)>=8500:
   if len(group)==1:
    d.execute('insert or replace into failed values(?,?,?)',(group[0][0],json.dumps(group),'suspected response cap'))
   else:
    mid=len(group)//2;queue.appendleft(group[mid:]);queue.appendleft(group[:mid])
   continue
  request_json=json.dumps(requests_[i],sort_keys=True,separators=(',',':'))
  d.execute('insert or replace into query_proofs values(?,?,?,?,?)',(hashlib.sha256(request_json.encode()).hexdigest(),request_json,len(logs),hashlib.sha256(json.dumps(logs,sort_keys=True,separators=(',',':')).encode()).hexdigest(),int(time.time()*1000)))
  bycurve=collections.defaultdict(list)
  for log in logs:bycurve[log['address'].lower()].append(log)
  for curve,block in group:
   selected=[l for l in bycurve[curve] if block<=int(l['blockNumber'],0)<=block+600]
   d.execute('insert or replace into paths values(?,?,?)',(curve,'public-rpc-full-window',json.dumps(dict(params=None,logs=selected,through=block+600),separators=(',',':'))));stats['resolved']+=1
 d.commit()
 stats.update(remainingGroups=len(queue),elapsedSeconds=round(time.time()-stats['started'],1),allPaths=d.execute('select count(*) from paths').fetchone()[0])
 (OUT/'fetch-progress.json').write_text(json.dumps(stats,indent=2))
 if stats['requests']%40==0 or throttled:print(json.dumps(stats),flush=True)
 if throttled:
  pace=min(10,pace*1.3);successes=0;time.sleep(5)
 else:
  successes+=1
  if successes>=40:pace=max(1.4,pace*.9);successes=0
print('FETCH COMPLETE',json.dumps(stats),flush=True)
