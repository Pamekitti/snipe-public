"""Freeze repaired inputs and reuse only byte-identical completed execution jobs."""
import hashlib,json,os,subprocess
from pathlib import Path
from research.core.data import read_json,write_json,digest
from research.core.cloud_inputs import build
ROOT=Path('/work/results');OLD=ROOT/'pre-extension'
oldfreeze=read_json(OLD/'run-freeze.json');oldinputs=read_json(OLD/'input-manifest.json')
source={str(p):digest(p) for base in ['src','research/core','scripts'] for p in Path(base).rglob('*') if p.suffix in ['.ts','.py']}
if source!=oldfreeze['sources']:raise ValueError('Execution job source changed; cache reuse is not authorized')
identity=json.loads(subprocess.check_output(['node','--import','tsx','scripts/execution-worker.ts'],input=b'{"op":"identity"}\n',env={**os.environ,'ENV_FILE':'/dev/null','MODE':'observe','LIVE':'0','DASH':'0','DOTENV_CONFIG_QUIET':'true'}))['result']
if identity['modelHash']!=oldfreeze['modelHash']:raise ValueError('Execution model changed')
if digest(Path('research/core/cloud-exits.json'))!=oldfreeze['exitDescriptorsHash']:raise ValueError('Exit descriptors changed')
build('/work/inputs',ROOT)
new=read_json(ROOT/'input-manifest.json');identical=[]
for c in new['chunks']:
 path=Path(c['path']);oldpath=OLD/'jobs'/path.name
 if not oldpath.exists():continue
 previous=read_json(oldpath);current=read_json(path)
 if len(previous)!=len(current):raise ValueError('Launch ordering changed')
 for a,b in zip(previous,current):
  if a['id']!=b['id']:raise ValueError('Launch identity changed')
  aq,bq=a.get('request'),b.get('request')
  if aq and bq:
   # Keep the original frozen source identity only when every execution input agrees.
   proposed={**bq,'provenance':aq['provenance']}
   if proposed==aq:b['request']=proposed
 write_json(path,current);c['sha256']=digest(path)
 if c['sha256']==digest(oldpath):identical.append(path.name)
new['previousInputManifestHash']=digest(OLD/'input-manifest.json');new['byteIdenticalOldChunks']=identical
write_json(ROOT/'input-manifest.json',new)
freeze={**oldfreeze,'inputManifestHash':digest(ROOT/'input-manifest.json')};write_json(ROOT/'run-freeze.json',freeze)
newfolder=ROOT/'matrices';newfolder.mkdir(exist_ok=True);reused=[]
for c in new['chunks']:
 name=Path(c['path']).name;oldoutput=OLD/'matrices'/name;oldproof=Path(str(oldoutput)+'.checkpoint.json')
 if name not in identical or not oldoutput.exists() or not oldproof.exists():continue
 output=newfolder/name;args=['node','--import','tsx','research/core/cloud_execution.ts',c['path'],str(output)]
 jobhash=lambda frozen:hashlib.sha256(json.dumps({'args':args,'inputKey':c['sha256'],'freeze':frozen}).encode()).hexdigest()
 proof=read_json(oldproof)
 if proof['outputHash']!=digest(oldoutput) or proof['jobHash']!=jobhash(digest(OLD/'run-freeze.json')):raise ValueError('Original cache proof failed '+name)
 os.link(oldoutput,output)
 write_json(Path(str(output)+'.checkpoint.json'),{'jobHash':jobhash(digest(ROOT/'run-freeze.json')),'outputHash':proof['outputHash']})
 reused.append({'chunk':name,'inputHash':c['sha256'],'outputHash':proof['outputHash'],'oldJobHash':proof['jobHash']})
write_json(ROOT/'execution-cache-reuse.json',{'chunks':reused,'sourceUnchanged':True,'modelHash':identity['modelHash'],'oldFreezeHash':digest(OLD/'run-freeze.json'),'newFreezeHash':digest(ROOT/'run-freeze.json'),'rule':'Original input file bytes, execution source, model and exit descriptors must match; original output and checkpoint hashes must verify'})
print(json.dumps({'reusedCompleteChunks':len(reused),'identicalInputChunks':len(identical),'total':len(new['chunks'])}),flush=True)
