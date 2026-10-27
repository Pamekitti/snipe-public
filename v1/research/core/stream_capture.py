"""Bounded-memory export of offline SQLite backups in the standard capture schema."""
import gzip,hashlib,json,sqlite3,sys
from pathlib import Path

def capture(root,out):
 root=Path(root);out=Path(out)
 if out.exists():raise ValueError('capture already exists')
 def digest(path):
  h=hashlib.sha256()
  with open(path,'rb') as f:
   for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
  return h.hexdigest()
 state=json.loads((root/'state.json').read_text())
 tables={'bot':['launches','positions','guard_samples','balance','chain_truth','health','approval_transactions','graduation_transactions','shadow_jobs','shadow_decisions','shadow_meta','shadow_headers','shadow_coverage'],'gate':['obs','state']}
 counts={}
 with gzip.open(out,'wt',compresslevel=1) as f:
  f.write('{"snapshot_at":'+str(state.get('capturedAt') or state['at'])+',"state":')
  json.dump(state,f,separators=(',',':'))
  for source,names in tables.items():
   db=sqlite3.connect('file:'+str(root/(source+'.db'))+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
   for table in names:
    key=source+'_'+table;f.write(','+json.dumps(key)+':[');n=0
    if db.execute('select 1 from sqlite_master where type=? and name=?',('table',table)).fetchone():
     for row in db.execute('SELECT * FROM "'+table+'"'):
      if n:f.write(',')
      value=dict(row)
      if table in ('approval_transactions','graduation_transactions'):value.pop('raw',None)
      json.dump(value,f,separators=(',',':'));n+=1
    f.write(']');counts[key]=n
   db.close()
  f.write(',"capture":')
  json.dump({k+'_sha256':digest(root/v) for k,v in [('bot_db','bot.db'),('gate_db','gate.db'),('state','state.json')]},f)
  f.write('}')
 print(json.dumps(dict(counts=counts,sha256=digest(out))),flush=True)
if __name__=='__main__':capture(*sys.argv[1:])
