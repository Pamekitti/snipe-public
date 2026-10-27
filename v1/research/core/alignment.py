"""Version 3 independent intent scenarios and September coverage. No live writes."""
import argparse
import collections
import gzip
import hashlib
import json
import pathlib
import shutil
from datetime import datetime, timezone
from .shared_execution import execute_batch, MODEL_VERSION
from .fidelity import execution_windows, grade, cash_metrics, cash_contrast
from .execution import describe, path_request, archive_execution_coverage

BOT = pathlib.Path(__file__).resolve().parents[2]
NAMES = {2522: 'PACT', 2535: 'MID', 2490: 'Anny', 2530: 'EVERYTHINGPAD', 2505: 'PORT', 2525: 'RQTE', 2512: 'FROGE'}

def sha(path):
    h=hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def run(capture, out, dataset=None):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=False)
    source = json.load(gzip.open(capture))
    end = source.get('captured_at')
    if not isinstance(end, int) or end <= 0:
        raise ValueError('explicit captured_at cutoff required')
    month = int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp() * 1000)
    attempts = [p for p in source['positions'] if p['live'] and month <= (p['t_decide'] or p['t_detect']) < end]
    marks = collections.defaultdict(list)
    for m in source['trade_marks']:
        marks[m['position_id']].append(m)
    jobs = {j['token'].lower(): j for j in source['shadow_jobs'] if j['request'] and j['entry'] < end}
    archive=json.load(open(dataset)) if dataset else None
    archive_coverage={}
    if archive:
        for p in attempts:
            token=p['token'].lower()
            archive_coverage[token]=dict(path=token in archive['paths'],params=token in archive['params'],coverage=archive['path_coverage'].get(token))
            if token in jobs:continue
            q,missing=path_request(archive,p,0,poll=50)
            if not missing:
                q['coverage']=archive_execution_coverage(archive,p,q['endAt'])
                jobs[token]={'request':json.dumps(q),'result':'null','archive':True}
    (out/'archive-coverage.json').write_text(json.dumps({'dataset':str(dataset) if dataset else None,'sha256':sha(dataset) if dataset else None,'coverage':archive_coverage},indent=2))
    requests, matched_positions, coverage = [], [], []
    for p in attempts:
        at = p['t_decide'] or p['t_detect']
        j = jobs.get(p['token'].lower())
        faults = []
        if not j:
            faults.append('no complete execution interval in the live capture or supplied source archive')
        if not p['min_tokens_out']:
            faults.append('submitted token minimum unavailable')
        if not p['t_confirmed']:
            faults.append('fill adoption time unavailable; preceding first-mark delay is an upper-bound scenario')
        if p['exit_reason'] == 'graduated-swap':
            faults.append('independent contract replay for this hypothetical holding unavailable')
        record = dict(id=p['id'], token=p['token'], name=NAMES.get(p['id']), entry=at, faults=faults, prediction='unavailable')
        coverage.append(record)
        if not j or not p['min_tokens_out']:
            continue
        legacy = json.loads(j['request'])
        preceding = []
        cost_rows = []
        for prior in source['positions']:
            closed = prior.get('exit_at')
            if not prior['live'] or not prior['buy_ok'] or prior.get('exit_reason') in ('buy-reverted','buy-never-mined') or not closed or closed >= min(at, end-21600000) or (prior.get('updated_at') or closed) >= min(at,end-21600000):
                continue
            mm = sorted(marks[prior['id']], key=lambda m:m['at'])
            triggered = [m['at'] for m in mm if m['reason']]
            if not mm or not triggered or not prior['t_sent'] or not prior['t_decide']:
                continue
            preceding.append(dict(completedAt=closed,availableAt=prior.get('updated_at') or closed,sendMs=prior['t_sent']-prior['t_decide'],confirmationMs=mm[0]['at']-prior['t_sent'],sellMs=closed-triggered[0],observationMs=mm[0]['at']-prior['t_sent']))
            if prior.get('gas_wei') is not None and prior.get('approval_gas_wei') is not None:
                cost_rows.append(prior)
        timing = execute_batch('calibrate',samples=preceding,frozenAt=at,evaluationEnd=end)
        if not timing or not cost_rows:
            record['faults'].append('preceding timing or receipt cost sample unavailable')
            continue
        selected = timing[1]
        selected['label'] += '-adoption-upper-bound'
        selected['sameTimeOrder'] = 'unavailable'
        params = legacy['params']
        logs = []
        for l in legacy['logs']:
            timestamp = l.get('at') or int(legacy['blocks'][l['blockNumber']]['timestamp'])*1000
            logs.append(dict(l, timeResolutionMs=1000, at=timestamp, observedAt=timestamp+selected['observationMs'],observationSource='modeled',order=dict(block=int(l['blockNumber'],16),transaction=0,log=int(l['logIndex'],16))))
        # Relative chain order is fully determined by global block logIndex. Missing absolute
        # transaction index remains declared in the coverage manifest, never called repaired.
        record['faults'].append('historical observation times missing; scenario delay applied to chain timestamps')
        med = lambda a: sorted(a)[len(a)//2]
        total = med([int(p['gas_wei']) for p in cost_rows])
        approval = med([int(p['approval_gas_wei']) for p in cost_rows])
        # This attempt's receipt is a comparison label, never a cost calibration input.
        buy = 0
        if archive:
            prior_receipts=[archive['receipts'].get(row.get('buy_hash')) for row in cost_rows]
            prior_receipts=[rc for rc in prior_receipts if rc and rc.get('gasUsed') and rc.get('effectiveGasPrice')]
            integer=lambda v:int(v,0) if isinstance(v,str) else int(v)
            if prior_receipts:buy=med([integer(rc['gasUsed'])*integer(rc['effectiveGasPrice']) for rc in prior_receipts])
        if buy <= 0 or total < buy:
            record['faults'].append('invalid preceding receipt cost decomposition')
            continue
        first_block = min(int(l['blockNumber'],16) for l in legacy['logs'])
        context = json.loads(p.get('context_json') or '{}')
        rules = context.get('rules')
        quote = legacy.get('entryQuoteTokens')
        if not rules or not quote or not context.get('entryStrategy', {}).get('maxEntryPriceMultiple'):
            record['faults'].append('pinned_actual_rules_or_entry_quote_missing')
            continue
        q = dict(modelVersion=MODEL_VERSION,evidenceVersion='capture-v3',strategyVersion=MODEL_VERSION,id=str(p['id']),token=p['token'],curve=p['curve'],wallet=legacy['wallet'],params=params,
            openedAt=at+selected['sendMs'],sizeWei=p['spend_wei'],entryQuoteTokens=quote,minTokens=p['min_tokens_out'],maxEntryMultiple=context['entryStrategy']['maxEntryPriceMultiple'],takeProfit=p['take_profit'],rules=rules,entryAt=at,endAt=min(end,legacy['endAt']),pollMs=50,
            seed=dict(state=dict(trackedQuote='0',trackedTokens=params['launchSupply'],quoteFeeBalance='0',creatorTaxBalance='0',graduated=False),order=dict(block=first_block-1,transaction=0,log=0),at=int(params['launchedAt'])*1000,observedAt=at),logs=logs,timing=selected,
            costs=dict(buyWei=str(buy),approvalWei=str(approval),sellWei=str(total-buy),failedSellWei=str(total-buy),approvalDelayMs=selected['confirmationMs'],retryMs=500,maxSellAttempts=20,failedSellAttempts=0),
            coverage={'complete':bool(legacy['coverage']['complete']),'from':int(params['launchedAt'])*1000,'through':min(end,legacy['endAt']),'independentlyChecked':(legacy['coverage'].get('source') == 'settled-history-double-scan' or legacy['coverage'].get('independentlyChecked') is True),'gaps':legacy['coverage'].get('faults',[])},
            provenance=dict(kind='reconstruction',source=sha(capture),capturedAt=end))
        requests.append(q)
        matched_positions.append(p)
    predicted = execute_batch('predict', requests=requests)
    scenarios=[]
    for order in ('before','after'):
        variants=[dict(q,timing=dict(q['timing'],label=q['timing']['label']+'-same-second-'+order,sameTimeOrder=order)) for q in requests]
        scenarios.append(dict(order=order,results=execute_batch('predict',requests=variants)))
    (out/'timing-scenarios.json').write_text(json.dumps(scenarios,indent=2))
    by_id = {p['id']:r for p,r in zip(matched_positions,predicted)}
    request_by_id = {p['id']:q for p,q in zip(matched_positions,requests)}
    rows=[]
    for p,record in zip(attempts,coverage):
        r=by_id.get(p['id'],dict(status='unavailable',reason='missing_execution_inputs',pnlWei=None,exitAt=None))
        record['prediction']=r['status'];record['reason']=r['reason']
        rows.append(dict(id=p['id'],token=p['token'],entry=p['t_decide'] or p['t_detect'],size=int(p['spend_wei']),actual_wei=p['onchain_pnl_wei'] or p['pnl_wei'],predicted_wei=r['pnlWei'],actual_at=p['exit_at'],predicted_at=r['exitAt'],status=r['status']))
    stake=min(r['size'] for r in rows if r['size']>0)
    windows=execution_windows(rows,month,end,stake)
    eras=collections.defaultdict(list)
    for p,row in zip(attempts,rows):
        signature=(p['spend_wei'],p['take_profit'],p['dead_after_ms'],p['dead_below'],p['build_id'])
        eras[signature].append(row)
    for i,(sig,cohort) in enumerate(eras.items()):
        windows['era_'+str(i+1)]=execution_windows(cohort,month,end,stake)['current']
        windows['era_'+str(i+1)]['signature']=sig
    # Unknown population and pre-September state prohibit a complete account claim.
    account={k:dict(complete=False,entry_precision=None,entry_recall=None,cash=cash_contrast([],[],stake)) for k in ('current','fit','reserved6h')}
    evidence=dict(receipt_accounting_complete=all(p['onchain_pnl_wei'] is not None for p in attempts),arithmetic_exact=False,historical_source_matches=False,calibration_is_causal=False,input_hashes_valid=True,account_engine_reproduces_saved_run=False,wallet_residual_wei=None,exit_reason_agreement=None,exit_time_error_ms=describe([]),exit_time_expected=sum(p['exit_reason'] not in ('buy-reverted','buy-never-mined') for p in attempts),actual_failures=sum(p['exit_reason'] in ('buy-reverted','buy-never-mined') or not p['buy_ok'] for p in attempts),failures_matched=sum(p['exit_reason']=='buy-reverted' and by_id.get(p['id'],{}).get('status')=='buy_reverted' for p in attempts))
    limits=json.loads((BOT/'research/BACKTEST_LIMITS_V1.json').read_text())
    verdict=grade(windows,account,evidence,limits)
    (out/'objects').mkdir()
    shutil.copy2(capture,out/'objects/capture.json.gz')
    sources={}
    for path in [*sorted((BOT/'src/strategy').glob('*.ts')),*sorted((BOT/'src/simulation').glob('*.ts')),BOT/'scripts/execution-worker.ts',BOT/'research/BACKTEST_LIMITS_V1.json',pathlib.Path(__file__)]:
        name=str(path.relative_to(BOT));sources[name]=sha(path)
        target=out/'objects'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,target)
    fixtures=[dict(name=NAMES[p['id']],actual=p,request=request_by_id.get(p['id']),result=by_id.get(p['id']),legacy=json.loads(jobs[p['token'].lower()]['result'])) for p in attempts if p['id'] in NAMES]
    result=dict(model_version=MODEL_VERSION,captured_at=end,capture_sha256=sha(capture),runtime_hashes=sources,limits_sha256=sha(BOT/'research/BACKTEST_LIMITS_V1.json'),verdict=verdict,execution=windows,account=account,evidence=evidence,rows=rows,
        september=dict(month='2026-09',complete=False,monthToDate=None,attempts=len(attempts),initial_state='pre-September paper holdings, cooldowns and operator controls not established',coverage=coverage),fixtures=fixtures)
    (out/'fidelity.json').write_text(json.dumps(result,indent=2))
    (out/'requests.json').write_text(json.dumps(requests))
    # Every bin retains era partitions, including missing predictions and all distribution fields.
    bins={}
    for name,hours,count in [('24h',24,8),('7d',168,7)]:
        width=hours*3600000/count
        bins[name]=[dict(start=end-(count-i)*width,end=end-(count-i-1)*width,eras=[dict(signature=sig,stats=execution_windows([r for r in cohort if end-(count-i)*width<=r['entry']<end-(count-i-1)*width],month,end,stake)['current']) for sig,cohort in eras.items()]) for i in range(count)]
    (out/'bins.json').write_text(json.dumps(bins,indent=2))
    (out/'coverage.json').write_text(json.dumps(result['september'],indent=2))
    def eth(v):return f'{int(v)/1e18:+.6f}'
    lines=['# September execution alignment','', 'The corrected model remains diagnostic. September paper cash is unavailable because account and execution coverage are incomplete.', '',f"Capture: {datetime.fromtimestamp(end/1000,timezone.utc).isoformat()}. Actual attempts: {len(attempts)}. Independently modeled scenario requests: {len(requests)}.",'','| Window | Matched / attempts | Actual winning profit ETH | Actual losing loss ETH | Actual net ETH | Paper net ETH | Absolute error mean / median / sd / n, pp |','| --- | ---: | ---: | ---: | ---: | ---: | --- |']
    for name in ('current','fit','reserved6h'):
        w=windows[name];a=w['cash']['actual'];p=w['cash']['predicted'];d=w['paired']['absolute_error_pp']
        lines.append(f"| {name} | {w['paired']['known']} / {w['paired']['expected']} | {eth(a['profit_wei'])} | {eth(a['loss_wei'])} | {eth(a['net_wei'])} | {eth(p['net_wei'])} | {d['mean']} / {d['median']} / {d.get('sd',d.get('stdev'))} / {d['n']} |")
    lines+=['','| Cash component | Matched actual ETH | Matched paper ETH |','| --- | ---: | ---: |']
    for field,label in [('profit_wei','Winning profit'),('loss_wei','Losing loss'),('net_wei','Net cash'),('drawdown_wei','Maximum closed-cash drawdown')]:
        contrast=windows['current']['cash']
        lines.append(f"| {label} | {eth(contrast['actual'][field])} | {eth(contrast['predicted'][field])} |")
    lines+=['','Matched cash excludes unavailable predictions on both sides. It is not a monthly account total.','', 'The latest-eight September counterfactual is unavailable from the unknown initial account state. Its prospective implementation reads Continuous Paper publications. No live activation is authorized.','', 'Named regression cases:', '']
    lines += [f"- {f['name']} {f['actual']['id']}: {(f['result'] or {}).get('status','unavailable')}, {(f['result'] or {}).get('reason','missing inputs')}." for f in fixtures]
    lines+=['','Coverage records identify every September actual attempt. Missing opportunity-population coverage, pre-September state, observation times and pool replay evidence remain unresolved.','',f"Acceptance checks failed: {sum(not c['passed'] for c in verdict['checks'])} / {len(verdict['checks'])}. The numerical limits are unchanged.",'','Source verification, arithmetic verification, historical accuracy and prospective validation remain separate gates. New results are in fidelity.json; old outputs are preserved. The eight-bin 24-hour and seven-bin seven-day tables, split by execution era, are in bins.json.']
    lines+=['','| Window / UTC interval end | Execution era | Matched / attempts | Signed error mean / median / sd / n, pp |','| --- | --- | ---: | --- |']
    for window,bb in bins.items():
        for b in bb:
            active=[e for e in b['eras'] if e['stats']['paired']['expected']]
            if not active:
                lines.append(f"| {window} / {datetime.fromtimestamp(b['end']/1000,timezone.utc).isoformat()} | No comparable attempts | 0 / 0 | unavailable |")
            for era in active:
                stat=era['stats']['paired'];dist=stat['signed_error_pp']
                sig=era['signature'];label=f"stake {int(sig[0])/1e18:g}, TP {sig[1]}, dead {sig[2]}, build {sig[-1]}"
                values='unavailable' if not dist['n'] else ' / '.join(('unavailable' if dist[k] is None else f'{dist[k]:.3f}') for k in ('mean','median','sd'))+f" / {dist['n']}"
                lines.append(f"| {window} / {datetime.fromtimestamp(b['end']/1000,timezone.utc).isoformat()} | {label} | {stat['known']} / {stat['expected']} | {values} |")
    (out/'report.md').write_text('\n'.join(lines)+'\n')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--capture',required=True);parser.add_argument('--out',required=True);parser.add_argument('--dataset')
    args=parser.parse_args();result=run(args.capture,args.out,args.dataset);print(result['verdict']['status']);raise SystemExit(0 if result['verdict']['historical_fidelity_passed'] else 2)
