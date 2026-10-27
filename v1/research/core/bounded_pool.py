"""Single-reader historical pool quote scenarios; never an execution certificate."""
import argparse,hashlib,json,time
from pathlib import Path
from .data import Cache,Worker,read_json,write_json,digest
FACTORY='0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
ZERO='0x'+'0'*40

def latest_header(cache,anchor,at):
    def get(n):
        h=cache.get('eth_getBlockByNumber',[hex(n),False])
        if not h or int(h['number'],16)!=n or not h.get('hash'):raise ValueError('missing_verified_header')
        return h
    low,high=anchor,anchor+512
    if int(get(low)['timestamp'],16)*1000>at:raise ValueError('anchor_after_execution')
    if int(get(high)['timestamp'],16)*1000<=at:raise ValueError('execution_outside_bounded_headers')
    while high-low>1:
        mid=(low+high)//2
        if int(get(mid)['timestamp'],16)*1000<=at:low=mid
        else:high=mid
    return get(low),get(high)

class Quoter:
    def __init__(self,cache,worker):self.cache,self.worker=cache,worker;self.meta=worker.call(op='metadata')['v4'];self.memo={};self.failed={}
    def quote(self,h,costs,end_at,delay):
        key=json.dumps([h['token'],h['tokens'],h['attemptedAt'],costs,end_at,delay],sort_keys=True)
        if key in self.failed:raise ValueError(self.failed[key])
        try:return self._quote(h,costs,end_at,delay)
        except (ValueError,RuntimeError,KeyError) as e:
            self.failed[key]=str(e);raise

    def _quote(self,h,costs,end_at,delay):
        c,w=self.cache,self.worker
        memo_key=json.dumps([h['token'],h['tokens'],h['attemptedAt'],costs,end_at,delay],sort_keys=True)
        if memo_key in self.memo:
            record,proof=self.memo[memo_key];return {**record,'inputHash':h['inputHash']},proof
        before,_=latest_header(c,h['exitAfter']['block'],h['attemptedAt'])
        calldata=w.call(op='encode_pool_context',token=h['token'])
        raw=c.get('eth_call',[{'to':FACTORY,'data':calldata},before['number']])
        if not raw:raise ValueError('historical_factory_state_unavailable')
        info=w.call(op='decode_pool_context',data=raw)
        if not info['exists'] or info['token'].lower()!=h['token'].lower() or info['curve'].lower()!=h['curve'].lower() or info['pairToken'].lower()!=ZERO:raise ValueError('incompatible_factory_state')
        phase=int(info['phase'])
        if phase not in (0,1,2):raise ValueError('unsupported_graduation_phase')
        # Two wallet approvals plus the remaining venue transitions. Historical
        # readiness does not prove our counterfactual preparation would succeed.
        prep=2+(2-phase);execution=h['attemptedAt']+1000*prep+delay
        if execution>end_at:raise ValueError('unresolved_capture_tail')
        header,next_header=latest_header(c,h['exitAfter']['block'],execution)
        key={'currency0':ZERO,'currency1':h['token'],'fee':int(info['poolFee']),'tickSpacing':int(info['tickSpacing']),'hooks':self.meta['hook']}
        data=w.call(op='encode_pool',key=key,tokens=h['tokens'])
        raw=c.get('eth_call',[{'to':self.meta['quoter'],'data':data},header['number']])
        if not raw:raise ValueError('historical_pool_quote_unavailable')
        proceeds,gas_estimate=w.call(op='decode_pool',data=raw)
        if int(proceeds)<=0:raise ValueError('nonpositive_pool_quote')
        # Each preparation operation is priced with the preceding approval cost.
        # Swap cost is at least the preceding sell cost and quoted EVM gas.
        gas=max(int(costs['sellWei']),int(gas_estimate)*int(header['baseFeePerGas'],16))+prep*int(costs['approvalWei'])
        proof={'header':header,'nextHeader':next_header,'factoryBefore':before,'factoryResult':info,'key':key,'rawQuote':raw,'precedingCosts':costs,'quotedGas':gas_estimate,
               'limits':['Historical reserves are not counterfactual reserves.','Preparation success and one-second timing are modeled.','Prior transaction costs approximate chain fee overhead.']}
        record={'kind':'historical-pool-quote-scenario','inputHash':h['inputHash'],'scenarioId':f'pool-d{delay}-h0','attemptedAt':h['attemptedAt'],'executionAt':execution,'tokens':h['tokens'],'proceedsWei':str(proceeds),'gasWei':str(gas),'block':int(header['number'],16),'blockAt':int(header['timestamp'],16)*1000,'nextBlockAt':int(next_header['timestamp'],16)*1000,'evidenceHash':hashlib.sha256(json.dumps(proof,sort_keys=True).encode()).hexdigest(),'extraDelayMs':delay,'haircutBps':0,'preparationTransactions':prep}
        self.memo[memo_key]=(record,proof)
        return record,proof

def acquire(root,cache_path,upstream,actual=False):
    root=Path(root);out=root/'pool-quotes';out.mkdir(exist_ok=True);began=time.time();done=0;failures={}
    source=root/'actual-audit/pool-requests.json' if actual else root/'matrices'
    paths=[source] if actual else sorted(source.glob('[0-9][0-9][0-9][0-9].json'))
    with Cache(cache_path,True,url=upstream,headers_url=upstream,logs_url=upstream) as cache,Worker() as worker:
        q=Quoter(cache,worker)
        for path in paths:
            dest=out/(('actual-' if actual else '')+path.name);source_hash=digest(path)
            if dest.exists() and read_json(dest).get('sourceHash')==source_hash:continue
            rows=read_json(path);requests={}
            if actual:
                for row in rows:requests[row['handoff']['inputHash']]=(row['handoff'],row['request']['costs'],row['request']['endAt'])
            else:
                for row in rows:
                    for lane in row.get('matrix') or []:
                        for exits in lane:
                            for r in exits:
                                if r.get('poolReplay'):requests[r['poolReplay']['inputHash']]=(r['poolReplay'],row['poolCosts'],row['endAt'])
            records={};proofs={}
            for key,(h,costs,end) in requests.items():
                for delay in [0,2000,5000]:
                    name=key+':'+str(delay)
                    try:
                        record,proof=q.quote(h,costs,end,delay);records[name]=record;proofs[record['evidenceHash']]=proof
                    except (ValueError,RuntimeError,KeyError) as e:
                        reason=str(e).split('\n')[0][:160];records[name]={'status':'unavailable','reason':reason};failures[reason]=failures.get(reason,0)+1
                    done+=1
                    if done%20==0:write_json(out/'status.json',{'stage':'pool_quote_acquisition','completed':done,'chunksCompleted':paths.index(path),'chunksTotal':len(paths),'heartbeat':time.time(),'elapsedSeconds':time.time()-began,'failures':failures})
            write_json(dest,{'sourceHash':source_hash,'quotes':records,'proofs':proofs,'diagnosticOnly':True})
            print(path.name,len(requests),'pool requests',flush=True)
    write_json(out/('actual-status.json' if actual else 'status.json'),{'stage':'completed','completed':done,'chunksCompleted':len(paths),'chunksTotal':len(paths),'heartbeat':time.time(),'elapsedSeconds':time.time()-began,'failures':failures})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--cache',required=True);p.add_argument('--upstream',required=True);p.add_argument('--actual',action='store_true');a=p.parse_args();acquire(a.root,a.cache,a.upstream,a.actual)
