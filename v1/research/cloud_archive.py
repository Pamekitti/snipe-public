"""Preserve completed outputs and new verified cache records before the hard deadline."""
import hashlib,json,os,sqlite3,subprocess,tarfile,time
from pathlib import Path
ROOT=Path('/work/results');BUCKET='general-purpose-compute-20260914-0000-107052598516'
DEADLINE=1789372918
ARCHIVE_RESERVE_SECONDS=1800

def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
while True:
 status=json.loads((ROOT/'status.json').read_text()) if (ROOT/'status.json').exists() else {}
 if status.get('stage')=='scoring_complete' or time.time()>=DEADLINE-ARCHIVE_RESERVE_SECONDS:break
 time.sleep(20)
subprocess.run(['systemctl','stop','compute-progress'],check=False)
if status.get('stage')!='scoring_complete':
 for unit in ['compute-quote-revision','compute-coverage-revision','compute-coverage-extension','compute-grid-v6','compute-grid-v5','compute-grid-v4','compute-grid-v3','compute-acquisition-v2']:subprocess.run(['systemctl','stop',unit],check=False)
 (ROOT/'deadline-incomplete.json').write_text(json.dumps({'at':int(time.time()*1000),'lastStatus':status,'reason':'Archive reserve reached before full experiment completion; preserve evidence before the independent termination deadline'}))
subprocess.run(['/work/venv/bin/python','/work/cloud_report.py','--root',str(ROOT),'--inputs','/work/inputs'],cwd='/work/bot',env={**os.environ,'ENV_FILE':'/dev/null','MODE':'observe','LIVE':'0','DASH':'0'},stdout=open(ROOT/'report-render.log','w'),stderr=subprocess.STDOUT,check=False)
repro=ROOT/'reproduction-inputs';repro.mkdir(exist_ok=True)
for name in ['bot.db','gate.db','simulation.db','state.json','timing-evidence.json','fidelity/rows.json','fidelity/requests.json','fidelity/reference.json']:
 source=Path('/work/inputs')/name;destination=repro/name;destination.parent.mkdir(parents=True,exist_ok=True)
 if source.exists() and not destination.exists():os.link(source,destination)
with tarfile.open(ROOT/'frozen-source.tar.gz','w:gz') as tar:
 for folder in ['src','research','scripts','test']:
  for p in (Path('/work/bot')/folder).rglob('*'):
   if p.is_file() and '__pycache__' not in p.parts and p.suffix in ['.ts','.py','.cjs','.js','.mjs','.css','.html','.svg','.json','.gz','.md']:tar.add(p,arcname=str(p.relative_to('/work/bot')))
 for name in ['README.md','DEPLOY.md','package.json','package-lock.json','tsconfig.json','vitest.config.ts','.env.example']:tar.add('/work/v1/'+name,arcname=name)
(ROOT/'cache-delta.sqlite.tmp').unlink(missing_ok=True)
cache=sqlite3.connect('file:/work/inputs/cache.snapshot.sqlite?mode=ro',uri=True);target=sqlite3.connect(ROOT/'cache-delta.sqlite.tmp')
for table in ['rpc','failures']:
 schema=cache.execute('select sql from sqlite_master where type=\'table\' and name=?',(table,)).fetchone()[0];target.execute(schema)
 columns=len(cache.execute('pragma table_info('+table+')').fetchall());query='insert into '+table+' values ('+','.join('?'*columns)+')'
 target.executemany(query,cache.execute('select * from '+table+' where at>=?',(1789344118000,)))
target.commit();target.close();cache.close()
(ROOT/'cache-delta.sqlite.tmp').replace(ROOT/'cache-delta.sqlite')
for name in ['cloud_report.py','cloud_report_supplement.py','cloud_archive.py']:
 (ROOT/name).write_bytes((Path('/work')/name).read_bytes())
files={str(p.relative_to(ROOT)):sha(p) for p in ROOT.rglob('*') if p.is_file() and p.name!='artifact-manifest.json' and not p.name.endswith('.tmp')}
(ROOT/'artifact-manifest.json').write_text(json.dumps({'at':int(time.time()*1000),'files':files,'experimentComplete':False,'scoringFinished':status.get('stage')=='scoring_complete','remaining':'Local artifact verification and chart review; inspect comparison-summary for blocked wider stages','stage':status.get('stage')},indent=2))
subprocess.run(['aws','s3','sync',str(ROOT),'s3://'+BUCKET+'/results','--exclude','*.tmp','--only-show-errors'],check=True)
listing=Path('/work/archive-file-list');listing.write_bytes(b''.join(name.encode()+b'\0' for name in sorted(files)+['artifact-manifest.json']))
bundle=Path('/work/results-bundle.tar.gz')
with bundle.open('wb') as sink:
 pack=subprocess.Popen(['tar','--hard-dereference','-cf','-','-C',str(ROOT),'--null','-T',str(listing)],stdout=subprocess.PIPE)
 compressed=subprocess.run(['pigz','-p','8','-1'],stdin=pack.stdout,stdout=sink)
 pack.stdout.close()
 if compressed.returncode or pack.wait():raise RuntimeError('Result bundle compression failed')
bundle_proof={'sha256':sha(bundle),'bytes':bundle.stat().st_size,'manifestHash':sha(ROOT/'artifact-manifest.json')}
Path('/work/bundle-proof.json').write_text(json.dumps(bundle_proof))
subprocess.run(['aws','s3','cp',str(bundle),'s3://'+BUCKET+'/archive/results-bundle.tar.gz','--only-show-errors'],check=True)
subprocess.run(['aws','s3','cp','/work/bundle-proof.json','s3://'+BUCKET+'/archive/bundle-proof.json','--only-show-errors'],check=True)
Path('/work/archive-complete').write_text(str(time.time()))
