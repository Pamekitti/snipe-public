"""Recover globally captured pre-V2 logs, avoiding duplicate historical RPC work."""
import collections,gzip,json,sqlite3,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'v1/data/research/20260922-market-september-v1'
dest=OUT/'legacy-global-logs.ndjson.gz'
script=r'''
import sqlite3,json,gzip,sys,os
os.nice(10)
d=sqlite3.connect('file:/srv/snipe/v1/data/bot.simulation.db?mode=ro',uri=True)
z=gzip.GzipFile(fileobj=sys.stdout.buffer,mode='wb',compresslevel=1)
lo,hi=d.execute('select min(at),max(at) from captures').fetchone()
z.write((json.dumps(dict(header=dict(lo=lo,hi=hi,gaps=d.execute('select lo,hi,reason from gaps').fetchall())))+'\n').encode())
for at,payload in d.execute('select at,payload from captures where kind=? order by at',('chain-log',)):
 z.write((json.dumps([at,json.loads(payload)],separators=(',',':'))+'\n').encode())
z.close()
'''
if not dest.exists():
 with open(dest,'wb') as f:subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-i','/path/to/ssh/example-host','operator@localhost','python3 -'],input=script.encode(),stdout=f,check=True)
d=sqlite3.connect(OUT/'history.sqlite',timeout=60)
facts={r[0]:(r[1],r[2]) for r in d.execute('select f.curve,f.block,f.at from facts f left join paths p on p.curve=f.curve where f.pair=? and p.curve is null',('0x'+'0'*40,))}
paths=collections.defaultdict(list);maxblock=0
with gzip.open(dest,'rt') as f:
 header=json.loads(next(f))['header']
 for line in f:
  at,log=json.loads(line);block=log['blockNumber'];maxblock=max(maxblock,block)
  key=log['address'].lower();fact=facts.get(key)
  if fact and fact[0]<=block<=fact[0]+600:paths[key].append(log)
n=0
for curve,(block,at) in facts.items():
 if at<header['lo']+60000 or at+60000>header['hi'] or block+600>maxblock:continue
 if any(lo<=at+60000 and hi>=at for lo,hi,_ in header['gaps']):continue
 logs=paths.get(curve,[])
 # No observed trade is not proof of a flat path; retain it as unresolved for RPC retrieval.
 if not logs:continue
 d.execute('insert or ignore into paths values(?,?,?)',(curve,'legacy-global-capture',json.dumps(dict(params=None,logs=logs,through=block+600),separators=(',',':'))));n+=1
 if n%1000==0:d.commit()
d.commit()
print(json.dumps(dict(imported=n,capture=header,maxBlock=maxblock)))
