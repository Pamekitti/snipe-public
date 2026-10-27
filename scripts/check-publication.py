#!/usr/bin/env python3
"""Check the publication tree, relative documentation links, and frozen data hashes."""
from pathlib import Path
from urllib.parse import unquote
import gzip,hashlib,json,re,sys
ROOT=Path(__file__).resolve().parents[1]
errors=[];files=[];links=0
for p in ROOT.rglob('*'):
 if not p.is_file() or any(x in p.relative_to(ROOT).parts for x in ['node_modules','.git','__pycache__']):continue
 files.append(p)
 if p.name=='.env' or p.suffix in ['.db','.sqlite','.pem','.key','.aesgcm','.bundle'] or '.db-' in p.name:errors.append(f'Forbidden operational file: {p.relative_to(ROOT)}')
 try:text=(gzip.decompress(p.read_bytes()) if p.suffix=='.gz' else p.read_bytes()).decode()
 except (UnicodeError,OSError):continue
 if re.search(r'/(?:Users|home)/[A-Za-z][A-Za-z0-9._-]+/',text):errors.append(f'Personal home path: {p.relative_to(ROOT)}')
 if re.search(r'tail[a-z0-9]{5,}\.ts\.net|\bi-[0-9a-f]{17}\b|\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',text):errors.append(f'Infrastructure or credential marker: {p.relative_to(ROOT)}')
 if re.search(r'(?:alchemy\.com|alchemyapi\.io)/v2/[A-Za-z0-9_-]{20,}',text):errors.append(f'Provider credential URL: {p.relative_to(ROOT)}')
 if p.suffix=='.md':
  for m in re.finditer(r'!?\[[^\]\n]*\]\(([^)\n]+)\)',text):
   target=m.group(1).split(' ')[0].strip('<>')
   if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',target) or target.startswith('#'):continue
   target=unquote(target.split('#')[0].split('?')[0])
   if not target:continue
   links+=1
   if not (p.parent/target).exists():errors.append(f'Broken link in {p.relative_to(ROOT)}: {target}')
manifest=json.loads((ROOT/'datasets/manifests/public-inputs.json').read_text())
for name,expected in manifest['sha256'].items():
 if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=expected:errors.append(f'Input hash mismatch: {name}')
client=(ROOT/'demo/client.js').read_text()
if re.search(r'\b(?:fetch|EventSource|WebSocket)\s*\(',client):errors.append('Connection API in static demo client')
html=(ROOT/'demo/index.html').read_text()
if 'data-action=' in html or 'data-size-input=' in html:errors.append('Trading control in demo')
for s in re.findall(r'<script[^>]+src="([^"]+)"',html):
 if s.startswith(('http:','https:','//')):errors.append('Remote demo script')
 if not (ROOT/'demo'/s).exists():errors.append(f'Missing demo asset: {s}')
if "connect-src 'none'" not in html:errors.append('Demo lacks connection-blocking policy')
report={'checkedFiles':len(files),'relativeLinks':links,'publicInputs':len(manifest['sha256']),'errors':errors}
print(json.dumps(report,indent=2))
sys.exit(bool(errors))
