"""Recover historical intent evidence without borrowing the attempt's execution result."""
import argparse
import collections
import copy
import datetime as dt
import fcntl
import json
import math
from pathlib import Path
import sqlite3
import time

from .data import Cache, Worker
from .execution import describe, receipt_accounting
from .shared_execution import execute_batch
from .unified_fidelity import sha, read_database

BOT = Path(__file__).resolve().parents[2]


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def integer(value):
    return int(value, 16) if isinstance(value, str) and value.startswith('0x') else int(value)


def quote_interval(minimum, slippage_bps):
    """Invert floor(quote * retained / 10000), preserving every possible integer."""
    minimum, retained = int(minimum), 10000-int(slippage_bps)
    if minimum <= 0 or not 0 < retained <= 10000:
        raise ValueError('invalid submitted minimum or slippage')
    return ((minimum*10000+retained-1)//retained,
            ((minimum+1)*10000+retained-1)//retained-1)


def canonical(logs):
    return sorted((integer(l['blockNumber']), integer(l['logIndex']),
                   l['blockHash'].lower(), l['transactionHash'].lower(), l['address'].lower(),
                   tuple(t.lower() for t in l['topics']), l['data'].lower()) for l in logs)


def prepare(manifest_path, output):
    manifest_path, output = Path(manifest_path).resolve(), Path(output).resolve()
    base = read(manifest_path)
    sources = {name: (manifest_path.parent/ref['path']).resolve() for name, ref in base['inputs'].items()}
    if any(sha(sources[name]) != ref['sha256'] for name, ref in base['inputs'].items()):
        raise ValueError('base input changed')
    if execute_batch('identity')['modelHash'] != base['modelHash']:
        raise ValueError('base engine is stale')
    output.mkdir(parents=True, exist_ok=False)
    old = sources['legacy_requests'].parents[1]
    archive_path = old/'actual-paths.json'
    missing_path = old/'missing-path/dataset.json'
    archive, patch = read(archive_path), read(missing_path)
    for key in ('paths', 'params', 'blocks', 'receipts', 'path_coverage'):
        archive[key].update(patch.get(key, {}))
    db = read_database(sources['bot'])
    positions = [dict(p) for p in db.execute('SELECT * FROM positions WHERE live=1 AND coalesce(t_decide,t_detect)>=? AND coalesce(t_decide,t_detect)<? ORDER BY id', (base['from'], base['through']))]
    historical = {int(q['id']): q for q in read(sources['legacy_requests'])}
    modern = {r['id']: r['request'] for r in read(sources['modern_matches'])}
    jobs, inventory = [], []
    for p in positions:
        context = json.loads(p['context_json']) if p['context_json'] else None
        token = p['token'].lower()
        lo, end = p['entry_block'], min(base['through'], (p['t_decide'] or p['t_detect'])+180000)
        record = dict(id=p['id'], token=token, context=bool(context), entryAt=p['t_decide'] or p['t_detect'],
                      build=p['build_id'], cashWei=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei'], faults=[])
        inventory.append(record)
        if not context:
            record['faults'].append('historical_strategy_context_missing'); continue
        if not p['min_tokens_out']:
            record['faults'].append('submitted_minimum_missing'); continue
        lower, upper = quote_interval(p['min_tokens_out'], 5000)
        record['quoteInterval'] = [str(lower), str(upper)]
        record['quoteProvenance'] = 'captured' if p['id'] in modern else 'submitted_minimum_with_archived_50pct_rule'
        record['historicalSlippageRuleAssumption'] = p['id'] not in modern
        q = copy.deepcopy(modern.get(p['id']) or historical.get(p['id']))
        if q:
            params, raw = q['params'], q['logs']
            headers = {l['blockNumber']: {'hash': l['blockHash'], 'timestamp': l['at']//1000} for l in raw}
            hi = max(integer(l['blockNumber']) for l in raw)
        elif token in archive['params'] and token in archive['paths']:
            params, raw = archive['params'][token], archive['paths'][token]
            headers = {l['blockNumber']: archive['blocks'].get(l['blockNumber']) for l in raw}
            hi = archive['path_coverage'][token]['to']
        else:
            record['faults'].append('path_or_parameters_missing'); continue
        if p['id'] in modern and not lower <= int(q['entryQuoteTokens']) <= upper:
            record['faults'].append('captured_quote_disagrees_with_historical_slippage_rule'); continue
        if not context.get('rules') or not context.get('entryStrategy', {}).get('maxEntryPriceMultiple'):
            record['faults'].append('pinned_rule_fields_missing'); continue
        jobs.append(dict(id=p['id'], token=token, curve=p['curve'], lo=lo, hi=hi, endAt=end, params=params, logs=raw,
                         headers=headers, existingRequest=q, quoteInterval=[str(lower), str(upper)], context=context,
                         entryAt=p['t_decide'] or p['t_detect'], sizeWei=p['spend_wei'], minTokens=p['min_tokens_out'],
                         takeProfit=p['take_profit'], captured=p['id'] in modern))
    inventory_summary = dict(actualAttempts=len(positions), withContext=sum(r['context'] for r in inventory),
                             sourceJobs=len(jobs), captured=sum(j['captured'] for j in jobs),
                             faults=dict(collections.Counter(f for r in inventory for f in r['faults'])))
    write(output/'inventory.json', dict(summary=inventory_summary, rows=inventory))
    write(output/'source-jobs.json', jobs)
    dependencies = {str(manifest_path): sha(manifest_path), str(archive_path): sha(archive_path), str(missing_path): sha(missing_path),
                    str(old/'frozen/v1/src/config.ts'): sha(old/'frozen/v1/src/config.ts'),
                    str(old/'frozen/v1/src/bot.ts'): sha(old/'frozen/v1/src/bot.ts')}
    write(output/'preparation.json', dict(baseManifest=str(manifest_path), modelHash=base['modelHash'], inputs=dependencies,
                                         sourceJobsHash=sha(output/'source-jobs.json'), sourceHash=sha(__file__),
                                         quoteRule='minTokens=floor(expectedTokens*5000/10000); check both integer endpoints',
                                         quoteRuleStatus='supported historical reconstruction, not a captured quote', liveChanges=False))
    db.close()
    return inventory_summary


def verify_sources(root):
    root = Path(root).resolve(); prep = read(root/'preparation.json'); jobs = read(root/'source-jobs.json')
    jobs_hash = sha(root/'source-jobs.json')
    if jobs_hash != prep['sourceJobsHash'] or sha(__file__) != prep['sourceHash']:
        raise ValueError('verification inputs or code changed')
    base = Path(prep['baseManifest']).parent.parent
    first, delta = base/'20260913-shared-refresh', base/'20260913-shared-refresh-1530'
    started = time.time()
    def progress(stage, completed=0, detail=None):
        write(root/'progress.json', dict(stage=stage, completed=completed, total=len(jobs), heartbeat=int(time.time()*1000),
              elapsedSeconds=time.time()-started, detail=detail, liveChanges=False))
    while any(read(p/'acquisition-progress.json')['state'] != 'complete' for p in (first, delta)):
        states = {p.name: read(p/'acquisition-progress.json')['state'] for p in (first, delta)}
        if any(s == 'failed' for s in states.values()):
            raise RuntimeError('existing shared acquisition failed: '+str(states))
        progress('queued_after_shared_acquisition', detail=states)
        time.sleep(5)
    lock = (first/'acquisition.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    completed_dir = root/'verified'; completed_dir.mkdir(exist_ok=True)
    with Worker() as worker:
        topics = list(worker.call(op='metadata')['topics'].values())
    completed = 0
    with Cache(root/'verification-rpc.sqlite', fetch=True, pace_seconds=.35) as cache:
        for job in jobs:
            destination = completed_dir/(str(job['id'])+'.json')
            if destination.exists():
                if read(destination)['inputHash'] != jobs_hash:
                    raise ValueError('source checkpoint belongs to another input')
                completed += 1; continue
            progress('verifying_actual_paths', completed, {'id': job['id']})
            if job['captured']:
                write(destination, dict(inputHash=jobs_hash, id=job['id'], complete=True,
                                       reused='frozen captured request with verified coverage', request=job['existingRequest']))
                completed += 1; continue
            lo, hi = job['lo'], max(job['hi'], job['lo']+1800)
            headers = dict(job['headers'])
            header = cache.get('eth_getBlockByNumber', [hex(hi), False])
            for _ in range(5):
                if not header: raise RuntimeError('required horizon header missing')
                if integer(header['timestamp'])*1000 >= job['endAt']: break
                hi += max(20, math.ceil((job['endAt']/1000-integer(header['timestamp']))*12))
                if hi-lo > 10000: raise RuntimeError('source horizon exceeded bounded search')
                header = cache.get('eth_getBlockByNumber', [hex(hi), False])
            if integer(header['timestamp'])*1000 < job['endAt']: raise RuntimeError('unproved source horizon')
            logs = []
            for begin in range(lo, hi+1, 2000):
                rows = cache.get('eth_getLogs', [{'address': job['curve'], 'fromBlock': hex(begin), 'toBlock': hex(min(begin+1999, hi)), 'topics': [topics]}])
                if rows is None: raise RuntimeError('missing verification log response')
                logs.extend(rows)
            overlap = [l for l in logs if integer(l['blockNumber']) <= job['hi']]
            original = [l for l in job['logs'] if lo <= integer(l['blockNumber']) <= job['hi']]
            matches = canonical(overlap) == canonical(original)
            # A distinct range bypasses the first scan's cache key when a second proof is required.
            if not matches or hi > job['hi']:
                second = []
                for begin in range(lo, hi+1, 997):
                    rows = cache.get('eth_getLogs', [{'address': job['curve'], 'fromBlock': hex(begin), 'toBlock': hex(min(begin+996, hi)), 'topics': [topics]}])
                    if rows is None: raise RuntimeError('missing second verification scan')
                    second.extend(rows)
                if canonical(logs) != canonical(second): raise RuntimeError('independent scans disagree')
            for log in logs:
                key = log['blockNumber']; known = headers.get(key)
                if not known or known['hash'].lower() != log['blockHash'].lower():
                    raw = cache.get('eth_getBlockByNumber', [key, False])
                    if not raw or raw['hash'].lower() != log['blockHash'].lower():
                        raise RuntimeError('log and verified header disagree')
                    known = dict(hash=raw['hash'], timestamp=integer(raw['timestamp']))
                    headers[key] = known
            if any(l.get('removed') for l in logs): raise RuntimeError('removed log in historical proof')
            write(destination, dict(inputHash=jobs_hash, id=job['id'], complete=True, archiveAgreed=matches,
                                   fromBlock=lo, throughBlock=hi, endHeader=dict(hash=header['hash'], timestamp=integer(header['timestamp'])),
                                   logs=logs, headers=headers, verifiedAt=int(time.time()*1000)))
            completed += 1; progress('verifying_actual_paths', completed, {'id': job['id'], 'archiveAgreed': matches})
    progress('source_verification_complete', completed)
    fcntl.flock(lock, fcntl.LOCK_UN); lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('stage', choices=['prepare', 'verify']); parser.add_argument('--manifest'); parser.add_argument('--out', required=True)
    args = parser.parse_args()
    print(prepare(args.manifest, args.out) if args.stage == 'prepare' else verify_sources(args.out), flush=True)
