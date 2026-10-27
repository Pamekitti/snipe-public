"""Full-September sensitivity audit. Orchestrates the shared engine; never trades."""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import os
import time

from .data import Cache
from .expanded_sample import read, write, integer, quote_interval
from .expanded_replay import build_request, median_integer
from .shared_execution import execute_batch
from .unified_fidelity import read_database, sha, matched_score

BOT = Path(__file__).resolve().parents[2]
DATA = BOT/'data/research'
START, END = 1788220800000, 1789313400000


def positions():
    db = read_database(DATA/'20260913-shared-refresh-1530/source/bot.db')
    rows = [dict(p) for p in db.execute('SELECT * FROM positions WHERE live=1 ORDER BY t_decide,id')]
    db.close()
    return rows


def prepare(root):
    protocol = read(root/'protocol.json')
    old = DATA/'20260913-expanded-sample-v1'
    archive_path = DATA/'20260913-shared-refresh/actual-paths.json'
    archive = read(archive_path)
    old_jobs = {j['id']:j for j in read(old/'source-jobs.json')}
    jobs, inventory = [], []
    for p in positions():
        at = p['t_decide'] or p['t_detect']
        if not START <= at < END: continue
        row = dict(id=p['id'], entryAt=at, context=bool(p['context_json']), faults=[])
        inventory.append(row)
        if p['id'] in old_jobs:
            job = copy.deepcopy(old_jobs[p['id']])
        else:
            token = p['token'].lower()
            if token not in archive['paths'] or token not in archive['params']:
                row['faults'].append('missing_archived_path'); continue
            if not p['min_tokens_out'] or not p['take_profit'] or not p['t_sent']:
                row['faults'].append('missing_recorded_intent'); continue
            context = dict(rules=dict(maxHoldMs=45000,hardStopMultiple=.5,
                deadCoinAfterMs=p['dead_after_ms'],deadCoinBelowMult=p['dead_below'],takeProfitMultiple=p['take_profit']),
                entryStrategy=dict(maxEntryPriceMultiple=4.5))
            raw = archive['paths'][token]
            job = dict(id=p['id'],token=token,curve=p['curve'],lo=p['entry_block'],
                hi=archive['path_coverage'][token]['to'],endAt=min(END,at+180000),params=archive['params'][token],
                logs=raw,headers={l['blockNumber']:archive['blocks'].get(l['blockNumber']) for l in raw},
                existingRequest=None,quoteInterval=[str(x) for x in quote_interval(p['min_tokens_out'],5000)],
                context=context,entryAt=at,sizeWei=p['spend_wei'],minTokens=p['min_tokens_out'],
                takeProfit=p['take_profit'],captured=False)
        job['ruleProvenance'] = 'recorded_context' if p['context_json'] else 'historical_rule_assumptions'
        jobs.append(job)
    write(root/'source-jobs.json',jobs)
    jobs_hash = sha(root/'source-jobs.json')
    prep = dict(baseManifest=str(DATA/'20260913-inclusion-timing-v1/standard-manifest.json'),
        modelHash=execute_batch('identity')['modelHash'],sourceJobsHash=jobs_hash,
        sourceHash=sha(BOT/'research/core/expanded_sample.py'),studySourceHash=sha(__file__),
        protocolHash=sha(root/'protocol.json'),inputs={str(archive_path):sha(archive_path),
            str(DATA/'20260913-shared-refresh-1530/source/bot.db'):sha(DATA/'20260913-shared-refresh-1530/source/bot.db')})
    write(root/'preparation.json',prep)
    verified = root/'verified';verified.mkdir(exist_ok=True)
    reused = []
    for job in jobs:
        source = old/'verified'/f"{job['id']}.json"
        if source.exists():
            value=read(source)
            if not value.get('complete'): continue
            value['reusedProof']=dict(path=str(source),sha256=sha(source),originalInputHash=value['inputHash'])
            value['inputHash']=jobs_hash
            write(verified/source.name,value);reused.append(job['id'])
    write(root/'inventory.json',dict(rows=inventory,reusedProofIds=reused,
        actualAttempts=len(inventory),sourceJobs=len(jobs),newSourceChecks=len(jobs)-len(reused)))
    return dict(attempts=len(inventory),sourceJobs=len(jobs),reused=len(reused))


def preceding_candidates(all_rows, at):
    cutoff=at-21600000
    return sorted((p for p in all_rows if p['closed'] and p['buy_ok'] and p['exit_at']
        and p['exit_at']<cutoff and p['buy_hash'] and p['exit_hash']
        and p['exit_reason'] not in ('buy-reverted','buy-never-mined')),
        key=lambda p:p['exit_at'],reverse=True)[:100]


def receipts(root):
    # Persist only required public receipt evidence. No current outcome enters calibration.
    all_rows=positions(); needed={}
    for p in all_rows:
        at=p['t_decide'] or p['t_detect']
        if START<=at<END:
            for prior in preceding_candidates(all_rows,at):
                for key in ('buy_hash','exit_hash'):
                    needed[prior[key].lower()]=prior['id']
    evidence=read(DATA/'20260913-shared-refresh/receipts.json')
    for key,value in read(DATA/'20260913-shared-refresh/actual-paths.json')['receipts'].items(): evidence.setdefault(key.lower(),value)
    destination=root/'cost-receipts.json'
    if destination.exists():evidence.update(read(destination))
    missing=[key for key in needed if not evidence.get(key)]
    started=time.time()
    with Cache(root/'cost-rpc.sqlite',fetch=True,pace_seconds=.35) as cache:
        for i,key in enumerate(missing):
            value=cache.get('eth_getTransactionReceipt',[key])
            if value:evidence[key]=value
            if i%10==0:
                write(destination,{k:evidence[k] for k in needed if evidence.get(k)})
                write(root/'cost-progress.json',dict(completed=i+1,total=len(missing),elapsedSeconds=time.time()-started,heartbeat=int(time.time()*1000)))
    write(destination,{k:evidence[k] for k in needed if evidence.get(k)})
    return dict(required=len(needed),fetched=len(missing),available=sum(bool(evidence.get(k)) for k in needed))


def cost_model(all_rows, receipts_by_hash, at):
    prior=preceding_candidates(all_rows,at)
    samples=[]
    for p in prior:
        pair=[receipts_by_hash.get(p[k].lower()) for k in ('buy_hash','exit_hash')]
        if not all(r and r.get('gasUsed') is not None and r.get('effectiveGasPrice') is not None for r in pair):continue
        samples.append((p,[integer(r['gasUsed'])*integer(r['effectiveGasPrice']) for r in pair]))
    if len(samples)<20:raise ValueError('fewer_than_20_preceding_receipt_pairs')
    approvals=[int(p['approval_gas_wei']) for p,_ in samples if p['approval_gas_wei'] is not None]
    # Old receipts lack an approval ledger. Charge one typical sell's gas as an explicit
    # fixed proxy, rather than silently assign zero. The proxy is not actual current gas.
    sell=median_integer([v[1] for _,v in samples])
    approval=median_integer(approvals) if len(approvals)>=20 else sell
    return dict(buyWei=str(median_integer([v[0] for _,v in samples])),sellWei=str(sell),
        approvalWei=str(approval),failedSellWei=str(sell),approvalDelayMs=600,
        retryMs=500,maxSellAttempts=20,failedSellAttempts=0),dict(ids=[p['id'] for p,_ in samples],
        fitThrough=at-21600000,approvalSource='preceding_ledger_median' if len(approvals)>=20 else 'preceding_sell_gas_proxy',
        publication='modeled_at_receipt_completion; not recorded local availability')


def scenario_defs():
    return [dict(name=f'q{slip}-rank{rank:g}-sell{sell}-{order}',slippageBps=slip,
        rank=rank,sellMs=sell,order=order) for slip in (500,5000) for rank in (0,.5,1)
        for sell in (600,1200,2000) for order in ('before','after')]


def build(root):
    prep=read(root/'preparation.json')
    if sha(root/'protocol.json')!=prep['protocolHash']:raise ValueError('protocol changed')
    if execute_batch('identity')['modelHash']!=prep['modelHash']:raise ValueError('engine changed')
    all_rows=positions();by_id={p['id']:p for p in all_rows}
    wallet=read(DATA/'20260913-expanded-sample-v1/audit/requests.json')[0]['wallet']
    evidence=read(root/'cost-receipts.json');requests=[];proofs=[];missing=[]
    for j in read(root/'source-jobs.json'):
        try:
            p=by_id[j['id']];v=read(root/'verified'/f"{j['id']}.json")
            costs,proof=cost_model(all_rows,evidence,j['entryAt'])
            if j['captured']:
                q=copy.deepcopy(v['request']);q['costs']=costs
            else:q=build_request(j,v,costs,wallet,prep['sourceJobsHash'],END)
            q['id']=str(j['id']);q['entryAt']=j['entryAt'];q['endAt']=min(q['endAt'],j['endAt'])
            q['logs']=[log for log in q['logs'] if log['at']<=q['endAt']]
            q['timing']=dict(kind='scenario',label='fixed_unfitted_sensitivity',frozenAt=q['entryAt'],
                fitThrough=q['entryAt']-21600000,n=0,sendMs=p['t_sent']-q['entryAt'],
                confirmationMs=600,observationMs=600,sellMs=1200,sameTimeOrder='after',buyInclusionMs=300,buyOrderFraction=.5)
            q['openedAt']=p['t_sent']
            for log in q['logs']:log.update(observedAt=log['at']+600,observationSource='modeled')
            if q['timing']['sendMs']<0:raise ValueError('invalid_recorded_send_clock')
            requests.append(q);proofs.append(dict(id=j['id'],costs=proof,rules=j['ruleProvenance'],sourceProof=sha(root/'verified'/f"{j['id']}.json")))
        except (ValueError,FileNotFoundError) as error:missing.append(dict(id=j['id'],reason=str(error)))
    write(root/'requests.json',requests);write(root/'input-proofs.json',dict(rows=proofs,missing=missing))
    write(root/'candidates.json',scenario_defs())
    rows=[]
    for q in requests:
        p=by_id[int(q['id'])]
        value=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei']
        accepted=bool(p['buy_ok']) and p['exit_reason'] not in ('buy-reverted','buy-never-mined')
        actual_costs=int(p['proceeds_wei'] or 0)-(int(p['spend_wei']) if accepted else 0)-int(value) if value is not None else None
        rows.append(dict(id=p['id'],entryAt=q['entryAt'],exitAt=p['exit_at'],sizeWei=p['spend_wei'],
            actualWei=value,actualTokens=p['tokens_held'],actualCostsWei=str(actual_costs) if actual_costs is not None else None,
            actualBuyAccepted=accepted,actualReason=p['exit_reason']))
    write(root/'rows.json',rows)
    write(root/'run-freeze.json',dict(modelHash=prep['modelHash'],hashes={name:sha(root/name) for name in
        ['protocol.json','requests.json','rows.json','input-proofs.json','candidates.json','cost-receipts.json','preparation.json','source-jobs.json']},sourceSha256=sha(__file__)))
    return dict(requests=len(requests),missing=len(missing),scenarios=len(scenario_defs()))


def run(root):
    frozen=read(root/'run-freeze.json')
    if sha(__file__)!=frozen['sourceSha256']:raise ValueError('source changed')
    for name,value in frozen['hashes'].items():
        if sha(root/name)!=value:raise ValueError('input changed: '+name)
    if execute_batch('identity')['modelHash']!=frozen['modelHash']:raise ValueError('model changed')
    requests=read(root/'requests.json'); candidates=read(root/'candidates.json')
    folder=root/'results';folder.mkdir(exist_ok=True);started=time.time()
    worker=subprocess.Popen(['node','--import','tsx','scripts/execution-worker.ts'],cwd=BOT,
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1,
        env={'PATH':os.environ['PATH'],'ENV_FILE':'/dev/null','MODE':'observe','LIVE':'0','DASH':'0','DOTENV_CONFIG_QUIET':'true'})
    for i,c in enumerate(candidates):
        path=folder/(c['name']+'.json')
        if path.exists():
            if read(path)['freezeHash']!=sha(root/'run-freeze.json'):raise ValueError('stale checkpoint')
            continue
        output=[]
        for begin in range(0,len(requests),40):
            batch=copy.deepcopy(requests[begin:begin+40])
            for q in batch:
                q['entryQuoteTokens']=str(quote_interval(q['minTokens'],c['slippageBps'])[0])
                q['timing'].update(label=c['name'],buyOrderFraction=c['rank'],sellMs=c['sellMs'],sameTimeOrder=c['order'])
            worker.stdin.write(json.dumps(dict(op='predict',requests=batch))+'\n');worker.stdin.flush()
            response=json.loads(worker.stdout.readline())
            if not response['ok']:raise ValueError(response['error'])
            output.extend(response['result'])
            write(root/'progress.json',dict(stage='scoring',completed=i*len(requests)+begin+len(batch),
                total=len(candidates)*len(requests),candidate=c['name'],heartbeat=int(time.time()*1000),elapsedSeconds=time.time()-started))
        write(path,dict(freezeHash=sha(root/'run-freeze.json'),results=output))
    worker.stdin.close();worker.wait(timeout=30);worker.stdout.close()
    if execute_batch('identity')['modelHash']!=frozen['modelHash']:raise ValueError('model changed during run')
    write(root/'scoring-complete.json',dict(candidates=len(candidates),attempts=len(requests),elapsedSeconds=time.time()-started))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('stage',choices=['prepare','receipts','build','run']);parser.add_argument('--root',required=True)
    args=parser.parse_args();print(globals()[args.stage](Path(args.root).resolve()),flush=True)
