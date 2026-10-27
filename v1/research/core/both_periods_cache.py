"""Reuse distinct cached RPC scans only when their complete execution logs agree."""
import argparse
import bisect
import hashlib
import itertools
import math
import json
from pathlib import Path
import sqlite3
import time
from .data import Cache, Worker
from .expanded_sample import read,write,integer,canonical


def verify(root,fetch_headers=False):
    root=Path(root).resolve();jobs=read(root/'source-jobs.json');index=read(root/'cache-index.json')
    prep=read(root/'preparation.json');cache_path=root.parent/'cache.sqlite'
    archived_headers=read(root.parent/'20260913-shared-refresh/actual-paths.json')['blocks']
    header_blocks=sorted(integer(k) for k,v in archived_headers.items() if v and v.get('hash') and v.get('timestamp'))
    db=sqlite3.connect('file:'+str(cache_path)+'?mode=ro',uri=True)
    extra=Cache(root/'cached-proof-headers.sqlite',fetch=fetch_headers,pace_seconds=.35)
    with Worker() as worker:required=set(v for k,v in worker.call(op='metadata')['topics'].items() if k!='TokenLaunched')
    fetched={};head_cache={};reused=[];missing=[];started=time.time()
    def response(key):
        if key not in fetched:
            row=db.execute('select value from rpc where key=?',(key,)).fetchone()
            if not row:raise ValueError('cached_response_missing')
            fetched[key]=(json.loads(row[0]),hashlib.sha256(row[0].encode()).hexdigest())
        return fetched[key]
    def header(block):
        known=archived_headers.get(hex(block))
        if known and known.get('hash') and known.get('timestamp'):
            return dict(hash=known['hash'],timestamp=integer(known['timestamp']))
        if block not in head_cache:
            for method in ('eth_getBlockByNumber','research_getTimestampHeader'):
                row=db.execute('select value from rpc where key=?',(Cache.key(method,[hex(block),False]),)).fetchone()
                if row:
                    h=json.loads(row[0])
                    if h and integer(h.get('number',-1))==block and h.get('hash') and h.get('timestamp'):
                        head_cache[block]=dict(hash=h['hash'],timestamp=integer(h['timestamp']));break
            else:
                h=extra.get('eth_getBlockByNumber',[hex(block),False]) if fetch_headers else None
                head_cache[block]=dict(hash=h['hash'],timestamp=integer(h['timestamp'])) if h and integer(h.get('number',-1))==block else None
        return head_cache[block]
    for ji,job in enumerate(jobs):
        dest=root/'verified'/f"{job['id']}.json"
        if dest.exists():continue
        candidates=[x for x in index[job['curve'].lower()] if x['lo']<=job['lo'] and x['hi']>=job['hi']
            and x['topics'] and isinstance(x['topics'][0],list) and required<=set(x['topics'][0])]
        target=job['hi'];target_header=header(target) if fetch_headers else None
        if fetch_headers:
            for _ in range(5):
                if not target_header or target_header['timestamp']*1000>=job['endAt']:break
                target+=max(20,math.ceil((job['endAt']/1000-target_header['timestamp'])*12))
                target_header=header(target)
        success=False
        for a,b in itertools.combinations(candidates,2):
            if a['key']==b['key'] or (a['lo'],a['hi'])==(b['lo'],b['hi']):continue
            hi=min(a['hi'],b['hi'])
            if target_header and target<=hi and target_header['timestamp']*1000>=job['endAt']:
                hi=target;end=target_header
            else:end=header(hi)
            if not end:
                # An already verified interior header can prove the time horizon.
                # Both independent queries still cover every block through that header.
                n=bisect.bisect_right(header_blocks,hi)-1
                if n>=0 and header_blocks[n]>=job['hi']:
                    hi=header_blocks[n];end=archived_headers.get(hex(hi))
            if not end or integer(end['timestamp'])*1000<job['endAt']:continue
            av,ah=response(a['key']);bv,bh=response(b['key'])
            select=lambda vv:[l for l in vv if l['address'].lower()==job['curve'].lower()
                and job['lo']<=integer(l['blockNumber'])<=hi and l['topics'][0] in required]
            al,bl=select(av),select(bv)
            if canonical(al)!=canonical(bl):continue
            heads={};bad=False
            for log in al:
                h=job['headers'].get(log['blockNumber']) or header(integer(log['blockNumber']))
                if not h or h['hash'].lower()!=log['blockHash'].lower() or log.get('removed'):
                    bad=True;break
                heads[log['blockNumber']]=h
            if bad:continue
            original=[l for l in job['logs'] if l['topics'][0] in required and job['lo']<=integer(l['blockNumber'])<=job['hi']]
            overlap=[l for l in al if integer(l['blockNumber'])<=job['hi']]
            if canonical(original)!=canonical(overlap):continue
            proof=[dict(request=x['request'],key=x['key'],responseSha256=h,cachedAt=x['at']) for x,h in [(a,ah),(b,bh)]]
            write(dest,dict(inputHash=prep['sourceJobsHash'],id=job['id'],complete=True,archiveAgreed=True,
                fromBlock=job['lo'],throughBlock=hi,endHeader=end,logs=al,headers=heads,verifiedAt=int(time.time()*1000),
                cachedIndependentScans=proof,topicScope='All six execution events; deployment parameters supplied separately'))
            reused.append(job['id']);success=True;break
        if not success:missing.append(job['id'])
        if ji%20==0:write(root/'cache-progress.json',dict(checked=ji,total=len(jobs),reused=len(reused),missing=len(missing),heartbeat=int(time.time()*1000)))
    db.close();extra.close();value=dict(reusedIds=reused,missingIds=missing,elapsedSeconds=time.time()-started,fetchHeaders=fetch_headers)
    destination=root/f'cache-reuse-{int(time.time()*1000)}.json'
    write(destination,value);write(root/'cache-reuse.json',value);return dict(reused=len(reused),missing=len(missing))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--fetch-headers',action='store_true');a=p.parse_args();print(verify(a.root,a.fetch_headers),flush=True)
