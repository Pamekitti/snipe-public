import concurrent.futures
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import certifi

os.environ['SSL_CERT_FILE'] = certifi.where()

ROOT = Path(os.environ.get('SNIPE_EXIT_AUDIT_DIR', Path(__file__).resolve().parents[1] / 'data/exit-policy-audit')).resolve()
sys.path.insert(0, str(ROOT / 'live/scripts'))
import chainio

snapshot = json.load(gzip.open(ROOT / 'snapshot.json.gz', 'rt'))
facts = {r['token']: r for r in snapshot['tables']['bot.launches']}
obs = [r for r in snapshot['tables']['gate.obs'] if r['bars'] and not r['error']]
start = min(r['at'] for r in obs)
targets = {t: r for t, r in facts.items() if start <= (r['launched_at'] or 0)*1000 < snapshot['now']-100_000
           and r['passed'] and 50 <= (r['creator_tax_bps'] or 0) <= 200 and (r['exemptions'] or 0) >= 3}
for p in snapshot['tables']['bot.positions']:
    if p['id'] >= 2001 and p['token'] in facts:
        targets[p['token']] = facts[p['token']]
db = sqlite3.connect(ROOT / 'paths.db')
db.execute('create table if not exists paths(token text primary key, from_block integer, to_block integer, fetched_at integer, js text, error text)')
done = {r[0] for r in db.execute('select token from paths where error is null')}
pending = sorted((r for t,r in targets.items() if t not in done), key=lambda r: r['block'])
print(f'{len(targets)} targets, {len(pending)} missing', flush=True)

def fetch(group):
    rpc = chainio.make_rpc('snipe-exit-policy-audit-readonly', timeout=25, tries=2, backoff=60)
    try:
        logs = rpc('eth_getLogs', [{'fromBlock':hex(min(r['block'] for r in group)),
                                  'toBlock':hex(max(r['block'] for r in group)+950),
                                  'address':[r['curve'] for r in group], 'topics':[chainio.CURVE_TOPICS]}])
        if len(logs)>=1000 and len(group)>1:
            time.sleep(3)
            mid=len(group)//2
            return fetch(group[:mid])+fetch(group[mid:])
        return [(r,json.dumps([l for l in logs if l['address'].lower()==r['curve'].lower()
                               and r['block']<=int(l['blockNumber'],16)<=r['block']+950]),None) for r in group]
    except Exception as e:
        return [(r,None,str(e)) for r in group]
    finally:
        time.sleep(3)

groups=[]
for r in pending:
    if not groups or len(groups[-1])>=6 or r['block']-groups[-1][0]['block']>9000:
        groups.append([])
    groups[-1].append(r)
print(f'{len(groups)} address batches, 3 seconds between requests',flush=True)
i=0
for group in groups:
    for r,js,error in fetch(group):
        i+=1
        db.execute('insert or replace into paths values(?,?,?,?,?,?)',
                   (r['token'],r['block'],r['block']+950,int(time.time()*1000),js,error))
        db.commit()
        if i%25==0 or error: print(f'{i}/{len(pending)} error={error}',flush=True)
print('complete', db.execute('select count(*),sum(error is not null) from paths').fetchone(),flush=True)
db.close()
for name in ('snapshot.json.gz','state.json','live-source.tar.gz','protocol.md'):
    print(name, hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),flush=True)
