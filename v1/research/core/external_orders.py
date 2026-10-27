"""Recover submitted curve budgets from verified successful transaction call traces."""
import copy
import hashlib
import json

BUY_SELECTOR = '0x59a87bc1'
BUY_TOPIC = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'


def buy_input(log, receipt, trace):
    if not receipt or not trace or trace.get('error'):
        raise ValueError('missing successful transaction evidence')
    if receipt['transactionHash'].lower() != log['transactionHash'].lower() or int(receipt['status'], 16) != 1:
        raise ValueError('receipt identity or status mismatch')
    if int(receipt['blockNumber'], 16) != log['order']['block'] or int(receipt['transactionIndex'], 16) != log['order']['transaction']:
        raise ValueError('receipt order mismatch')
    matching = [x for x in receipt['logs'] if int(x['logIndex'], 16) == int(log['logIndex'], 16)]
    if len(matching) != 1 or any(matching[0][k] != log[k] for k in ['topics', 'data', 'address']):
        raise ValueError('receipt does not prove the source event')
    if log['topics'][0] != BUY_TOPIC:
        raise ValueError('not a curve buy')
    calls = []

    def walk(call):
        if call.get('error'):
            return
        data = call.get('input', '')
        if call.get('type') == 'CALL' and call.get('to', '').lower() == log['address'].lower() and data.startswith(BUY_SELECTOR):
            if len(data) != 202:
                raise ValueError('unexpected buy calldata')
            amount, minimum = int(data[10:74], 16), int(data[74:138], 16)
            recipient = data[138:202][-40:].lower()
            if call.get('from', '').lower()[2:] == log['topics'][1][-40:].lower() and recipient == log['topics'][2][-40:].lower():
                if int(call.get('value', '0x0'), 16) != amount or amount < int(log['data'][2:66], 16):
                    raise ValueError('submitted budget inconsistent with curve fill')
                calls.append((amount, minimum))
        for child in call.get('calls', []):
            walk(child)

    walk(trace)
    if len(calls) != 1:
        raise ValueError('missing or ambiguous curve call')
    amount, minimum = calls[0]
    evidence = json.dumps({'receipt': receipt, 'trace': trace}, sort_keys=True, separators=(',', ':')).encode()
    return dict(quoteInWei=str(amount), minTokensOut=str(minimum), traceHash=hashlib.sha256(evidence).hexdigest())


def enrich(request, evidence):
    """Return a derived request. Never overwrite the frozen capture or actual labels."""
    q = copy.deepcopy(request)
    for log in q['logs']:
        item = evidence.get(log['transactionHash'].lower())
        if item and log['topics'][0] == BUY_TOPIC:
            log['externalBuy'] = buy_input(log, item['receipt'], item['trace'])
    return q


def derive_jobs(source, evidence_path, output):
    from pathlib import Path
    from .data import digest, read_json, write_json
    source, evidence_path, output = map(Path, [source, evidence_path, output])
    output.mkdir(parents=True, exist_ok=False)
    proofs={p.stem:read_json(p) for p in sorted(evidence_path.glob('0x*.json'))}
    files=[]
    for path in sorted(source.glob('[0-9][0-9][0-9][0-9].json')):
        jobs=read_json(path)
        changed=0
        for job in jobs:
            q=job.get('request')
            if q and any(l['transactionHash'].lower() in proofs for l in q['logs']):
                job['request']=enrich(q,proofs)
                changed+=1
        target=output/path.name
        if changed:
            write_json(target,jobs)
        else:
            target.symlink_to(path.resolve())
        files.append(dict(name=path.name,sourceHash=digest(path),derivedHash=digest(target),enrichedJobs=changed))
    write_json(output/'derivation-manifest.json',dict(files=files,evidenceHashes={p.name:digest(p) for p in sorted(evidence_path.glob('0x*.json'))},
        scope='Trace-enriched copies or hash-bound links. Original captures remain unchanged. No pool outcome is supplied by this derivation.'))
    print({'files':len(files),'enrichedJobs':sum(x['enrichedJobs'] for x in files)},flush=True)


def acquire(index_path, out_path, cache_path, upstream):
    import time
    from pathlib import Path
    from .data import Cache, digest, write_json
    index_path, out_path = Path(index_path), Path(out_path)
    out_path.mkdir(parents=True, exist_ok=True)
    index = json.loads(index_path.read_text())['transactions']
    started = time.monotonic()
    completed, failures = 0, []
    with Cache(cache_path, True, url=upstream, headers_url=upstream, logs_url=upstream) as cache:
        for tx_hash, record in index.items():
            path = out_path / (tx_hash + '.json')
            try:
                if path.exists():
                    item = json.loads(path.read_text())
                else:
                    item = {'receipt': cache.get('eth_getTransactionReceipt', [tx_hash]),
                            'trace': cache.get('debug_traceTransaction', [tx_hash, {'tracer': 'callTracer'}])}
                item['input'] = buy_input(record['log'], item['receipt'], item['trace'])
                write_json(path, item)
                completed += 1
            except (ValueError, TypeError, KeyError) as error:
                failures.append({'transactionHash': tx_hash, 'reason': str(error)})
            done = completed + len(failures)
            elapsed = time.monotonic() - started
            status = dict(indexHash=digest(index_path), completed=completed, attempted=done, total=len(index),
                          failures=failures, heartbeat=int(time.time()*1000), elapsedSeconds=elapsed,
                          remainingSeconds=elapsed/done*(len(index)-done), complete=done == len(index))
            write_json(out_path / 'status.json', status)
            if done % 25 == 0 or done == len(index):
                print(json.dumps({k:v for k,v in status.items() if k != 'failures'}), flush=True)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--index', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--upstream', required=True)
    args = parser.parse_args()
    acquire(args.index, args.out, args.cache, args.upstream)
