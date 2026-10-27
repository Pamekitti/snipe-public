"""Read-only capture of the complete recorded pre-V2 launch denominator."""
import gzip,json,subprocess,hashlib
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'v1/data/research/20260922-market-september-v1'
OUT.mkdir(exist_ok=False)
remote=r'''
import sqlite3,json,gzip,sys
d=sqlite3.connect('file:/srv/snipe/v1/data/bot.db?mode=ro',uri=True)
d.row_factory=sqlite3.Row
z=gzip.GzipFile(fileobj=sys.stdout.buffer,mode='wb',compresslevel=3)
for r in d.execute('select token,curve,deployer,pair_token,block,launched_at,creator_tax_bps,dev_buy_wei,detected_at,exemptions,passed from launches where detected_at>=? and detected_at<? order by detected_at',(1788220800000,1789577091790)):
 z.write((json.dumps(dict(kind='launch',row=dict(r)),separators=(',',':'))+'\n').encode())
for r in d.execute('select buy_hash,exit_hash from positions where t_detect>=?',(1788220800000,)):
 z.write((json.dumps(dict(kind='own',row=dict(r)))+'\n').encode())
z.close()
'''
with open(OUT/'legacy-launches.ndjson.gz','wb') as f:
 subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-i','/path/to/ssh/example-host','operator@localhost','python3 -'],input=remote.encode(),stdout=f,check=True)
print(json.dumps({'path':str(OUT),'sha256':hashlib.file_digest(open(OUT/'legacy-launches.ndjson.gz','rb'),'sha256').hexdigest()}))
