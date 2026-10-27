"""Build a larger, explicitly reconstructed actual-attempt fidelity cohort."""
import argparse
import collections
import copy
import datetime as dt
import json
from pathlib import Path

from .expanded_sample import integer, read, write
from .shared_execution import execute_batch
from .unified_fidelity import BOT, matched_score, read_database, sha


def median_integer(values):
    values = sorted(values)
    if not values:
        raise ValueError('empty cost sample')
    return (values[(len(values)-1)//2]+values[len(values)//2])//2


def preceding_costs(positions, receipts, at):
    """Same component medians and 100-row selection as the shadow processor."""
    cutoff = at-21600000
    eligible = sorted((p for p in positions if p['closed'] and p['buy_ok']
        and p['exit_reason'] not in ('buy-reverted', 'buy-never-mined')
        and p['exit_at'] is not None and p['exit_at'] < cutoff
        and p['updated_at'] is not None and p['updated_at'] < cutoff
        and p['gas_wei'] is not None), key=lambda p: p['exit_at'], reverse=True)[:100]
    selected = [p for p in eligible if p['buy_hash'] and p['exit_hash'] and p['approval_gas_wei'] is not None]
    if not selected:
        raise ValueError('missing_preceding_cost_samples')
    buys, sells, approvals = [], [], []
    for p in selected:
        for key, target in [('buy_hash', buys), ('exit_hash', sells)]:
            receipt = receipts.get(p[key].lower())
            if not receipt or receipt.get('gasUsed') is None or receipt.get('effectiveGasPrice') is None:
                raise ValueError('missing_preceding_receipt:'+str(p['id'])+':'+key)
            target.append(integer(receipt['gasUsed'])*integer(receipt['effectiveGasPrice']))
        approvals.append(int(p['approval_gas_wei']))
    costs = dict(buyWei=str(median_integer(buys)), sellWei=str(median_integer(sells)),
                 approvalWei=str(median_integer(approvals)), failedSellWei=str(median_integer(sells)),
                 approvalDelayMs=0, retryMs=500, maxSellAttempts=20, failedSellAttempts=0)
    proof = dict(fitThrough=cutoff, ids=[p['id'] for p in selected], n=len(selected),
                 latestAvailable=max(p['updated_at'] for p in selected),
                 rule='preceding 100 successful closes; separate integer component medians')
    return costs, proof


def build_request(job, verified, costs, wallet, input_hash, captured_at):
    if not verified.get('complete') or verified['inputHash'] != input_hash:
        raise ValueError('incomplete_or_incompatible_source')
    if verified['endHeader']['timestamp']*1000 < job['endAt']:
        raise ValueError('incomplete_horizon')
    if verified['fromBlock'] != job['lo']:
        raise ValueError('incomplete_launch_prefix')
    logs = []
    for raw in verified['logs']:
        header = verified['headers'].get(raw['blockNumber'])
        if not header or header['hash'].lower() != raw['blockHash'].lower() or raw.get('removed'):
            raise ValueError('unverified_log_timestamp')
        if raw.get('transactionIndex') is None:
            raise ValueError('missing_transaction_order')
        at = integer(header['timestamp'])*1000
        logs.append(dict(raw, at=at, observedAt=at, observationSource='modeled', timeResolutionMs=1000,
                         order=dict(block=integer(raw['blockNumber']), transaction=integer(raw['transactionIndex']), log=integer(raw['logIndex']))))
    at, params = job['entryAt'], job['params']
    timing = dict(kind='scenario', label='awaiting-preceding-calibration', frozenAt=at, fitThrough=at-21600000,
                  n=0, sendMs=0, confirmationMs=0, sellMs=0, observationMs=0, sameTimeOrder='unavailable')
    return dict(modelVersion='execution-account-v3', evidenceVersion='capture-v3', strategyVersion='execution-account-v3',
        id=str(job['id']), token=job['token'], curve=job['curve'], wallet=wallet, params=params,
        sizeWei=job['sizeWei'], entryQuoteTokens=job['quoteInterval'][0], minTokens=job['minTokens'],
        maxEntryMultiple=job['context']['entryStrategy']['maxEntryPriceMultiple'], takeProfit=job['takeProfit'],
        rules=job['context']['rules'], entryAt=at, openedAt=at, endAt=job['endAt'], pollMs=50,
        seed=dict(state=dict(trackedQuote='0', trackedTokens=params['launchSupply'], quoteFeeBalance='0', creatorTaxBalance='0', graduated=False),
                  order=dict(block=job['lo']-1, transaction=0, log=0), at=integer(params['launchedAt'])*1000, observedAt=at),
        logs=logs, timing=timing, costs=costs,
        coverage={'complete': True, 'independentlyChecked': True, 'from': integer(params['launchedAt'])*1000, 'through': job['endAt'], 'gaps': []},
        provenance=dict(kind='reconstruction', source=input_hash, capturedAt=captured_at))


def build(root, partial=False):
    root = Path(root).resolve(); prep = read(root/'preparation.json'); base_path = Path(prep['baseManifest']); base = read(base_path)
    jobs = read(root/'source-jobs.json')
    if sha(root/'source-jobs.json') != prep['sourceJobsHash'] or execute_batch('identity')['modelHash'] != prep['modelHash']:
        raise ValueError('frozen jobs or engine changed')
    if not partial and read(root/'progress.json')['stage'] != 'source_verification_complete':
        raise ValueError('source_verification_not_complete')
    sources = {n: (base_path.parent/r['path']).resolve() for n, r in base['inputs'].items()}
    receipts_path = sources['legacy_requests'].parents[1]/'receipts.json'
    receipts = {k.lower(): v for k, v in read(receipts_path).items()}
    db = read_database(sources['bot']); positions = [dict(p) for p in db.execute('SELECT * FROM positions WHERE live=1')]
    modern = read(sources['modern_matches']); wallet = modern[0]['request']['wallet']
    marks = collections.defaultdict(list)
    for row in db.execute('SELECT position_id,at,reason FROM trade_marks ORDER BY at'):
        marks[row['position_id']].append(dict(row))
    requests, proofs, missing, calibrations = [], [], [], []
    for job in jobs:
        if job['captured']: continue
        path = root/'verified'/f"{job['id']}.json"
        if not path.exists():
            missing.append(dict(id=job['id'], reason='source_verification_pending')); continue
        try:
            costs, proof = preceding_costs(positions, receipts, job['entryAt'])
            q = build_request(job, read(path), costs, wallet, prep['sourceJobsHash'], base['through'])
            prior_samples = []
            for prior in sorted(positions, key=lambda p: p.get('exit_at') or 0, reverse=True):
                cutoff = job['entryAt']-21600000
                if not prior['closed'] or not prior['buy_ok'] or prior['exit_reason'] in ('buy-reverted','buy-never-mined'): continue
                if not prior.get('exit_at') or prior['exit_at'] >= cutoff or not prior.get('updated_at') or prior['updated_at'] >= cutoff: continue
                observed = marks[prior['id']]; triggers = [m['at'] for m in observed if m['reason']]
                if not observed or not triggers or not prior['t_sent'] or not prior['t_decide'] or prior.get('gas_wei') is None: continue
                confirmation = prior.get('t_confirmed') or observed[0]['at']
                sample = dict(completedAt=prior['exit_at'], availableAt=prior['updated_at'], sendMs=prior['t_sent']-prior['t_decide'],
                    confirmationMs=confirmation-prior['t_sent'], sellMs=prior['exit_at']-triggers[0], observationMs=confirmation-prior['t_sent'])
                if min(sample[k] for k in ('sendMs','confirmationMs','sellMs','observationMs')) < 0: continue
                prior_samples.append(sample)
                if len(prior_samples) == 100: break
            if len(prior_samples) < 20: raise ValueError('fewer_than_20_preceding_timing_samples')
            calibrations.append(dict(samples=prior_samples, frozenAt=job['entryAt'], evaluationEnd=job['entryAt']))
            requests.append(q); proofs.append(dict(id=job['id'], costs=proof, sourceSha256=sha(path), quoteInterval=job['quoteInterval']))
        except ValueError as error:
            missing.append(dict(id=job['id'], reason=str(error)))
    timings = execute_batch('calibrate-many', requests=calibrations)
    for q, timing in zip(requests, timings):
        q['timing'] = next(t for t in timing if t['label'].startswith('preceding-p50'))
        q['timing']['sameTimeOrder'] = 'unavailable'
        q['costs']['approvalDelayMs'] = q['timing']['confirmationMs']
        q['openedAt'] = q['entryAt']+q['timing']['sendMs']
        for log in q['logs']: log['observedAt'] = log['at']+q['timing']['observationMs']
    folder = root/('pilot' if partial else 'built'); folder.mkdir(exist_ok=False)
    write(folder/'historical-requests.json', requests)
    write(folder/'historical-calibrations.json', {q['id']: c for q,c in zip(requests,calibrations)})
    write(folder/'input-proofs.json', dict(rows=proofs, missing=missing, modernCaptured=len(modern), reconstructed=len(requests),
        quoteAssumption='archived 50% slippage rule, interval endpoints must agree',
        calibrationChange='historical gas now uses separate preceding receipt medians matching the shadow processor; old audit subtracted median buy gas from median combined gas',
        timingAssumption='preceding 100 valid samples, six-hour embargo; missing durable availability timestamps excluded'))
    manifest = copy.deepcopy(base)
    for name, path in sources.items(): manifest['inputs'][name]['path'] = str(path)
    for name, path in [('legacy_requests', folder/'historical-requests.json'), ('historical_calibrations', folder/'historical-calibrations.json'), ('expanded_proofs', folder/'input-proofs.json'),
                       ('expanded_inventory', root/'inventory.json'), ('preceding_receipts', receipts_path), ('expanded_preparation', root/'preparation.json')]:
        manifest['inputs'][name] = dict(path=str(path), sha256=sha(path))
    for name in ['research/core/expanded_replay.py', 'research/core/expanded_sample.py', 'research/core/unified_fidelity.py', 'research/core/expanded_report.py']:
        manifest['sourceHashes'][name] = sha(BOT/name)
    manifest['expandedSample'] = dict(partial=partial, reconstructed=len(requests), captured=len(modern), missing=missing)
    write(folder/'manifest.json', manifest)
    db.close()
    return dict(folder=str(folder), reconstructed=len(requests), captured=len(modern), missing=len(missing))


def supplement(root, audit):
    root, audit = Path(root), Path(audit)
    rows, bundles, strict = [read(audit/name) for name in ['rows.json','scenario-bundles.json','strict-results.json']]
    jobs = {j['id']: j for j in read(root/'source-jobs.json')}
    upper, expected, strict_expected = [], [], []
    for row, bundle, result in zip(rows, bundles, strict):
        if row['quality'] != 'inferred_historical_intent': continue
        quote = jobs[row['id']]['quoteInterval'][1]
        for scenario in bundle['scenarios']:
            q = copy.deepcopy(scenario['request']); q['entryQuoteTokens'] = quote
            upper.append(q); expected.append(scenario['result'])
    actual = execute_batch('predict', requests=upper)
    mismatches = [i for i, (a, b) in enumerate(zip(actual, expected)) if a != b]
    base_requests = read(audit/'requests.json')
    strict_upper = []
    for row, q, result in zip(rows, base_requests, strict):
        if row['quality'] != 'inferred_historical_intent': continue
        q = copy.deepcopy(q); q['entryQuoteTokens'] = jobs[row['id']]['quoteInterval'][1]
        strict_upper.append(q); strict_expected.append(result)
    strict_actual = execute_batch('predict', requests=strict_upper)
    strict_mismatches = [i for i, (a,b) in enumerate(zip(strict_actual, strict_expected)) if a != b]
    groups = collections.defaultdict(list)
    for i, row in enumerate(rows):
        groups['day:'+dt.datetime.fromtimestamp(row['entryAt']/1000,dt.timezone.utc).strftime('%Y-%m-%d')].append(i)
        strategy = jobs[row['id']]['context']['entryStrategy']
        # These settings separate recorded policy eras without using outcomes to define them.
        era = {k: strategy.get(k) for k in ['maxHoldMs','venuePauseWindow','venuePauseOff','venuePauseOn','venueIndicator','venueRecoveryPolicy','venueRecoveryWindow','venueRecoveryOn']}
        groups['era:'+json.dumps(era,sort_keys=True)].append(i)
        groups['quality:'+row['quality']].append(i)
    scores = {}
    for group, indices in groups.items():
        selected = [rows[i] for i in indices]
        scores[group] = dict(n=len(indices), strict=matched_score(selected,[strict[i] for i in indices]),
            scenarios={bundles[0]['scenarios'][k]['id']: matched_score(selected,[bundles[i]['scenarios'][k]['result'] for i in indices]) for k in range(6)})
    value = dict(quoteEndpointChecks=len(upper)+len(strict_upper), scenarioMismatches=mismatches, strictMismatches=strict_mismatches,
                 quoteEndpointParity=not mismatches and not strict_mismatches, groups=scores, diagnosticOnly=True, liveChanges=False)
    write(audit/'expanded-scorecards.json', value)
    if mismatches or strict_mismatches: raise ValueError('reconstructed quote endpoints change predictions')
    return dict(quoteEndpointChecks=value['quoteEndpointChecks'], quoteEndpointParity=value['quoteEndpointParity'], groups=len(groups))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('stage',choices=['build','supplement']); parser.add_argument('--root',required=True)
    parser.add_argument('--partial',action='store_true'); parser.add_argument('--audit'); args = parser.parse_args()
    print(json.dumps(build(args.root,args.partial) if args.stage=='build' else supplement(args.root,args.audit)))
