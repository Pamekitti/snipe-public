"""Bound historical pool activity through a modeled exit with verified headers."""
import argparse
from .data import Cache, read_json, write_json, digest

MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'


def acquire_orders(coverage_path, cache_path, output, upstream):
    coverage=read_json(coverage_path)
    by_hash={log['transactionHash']:log for log in coverage['logs']}
    orders=[]
    with Cache(cache_path, True, url=upstream, headers_url=upstream, logs_url=upstream) as cache:
        for tx_hash,log in sorted(by_hash.items(),key=lambda item:(int(item[1]['blockNumber'],16),int(item[1]['transactionIndex'],16))):
            tx=cache.get('eth_getTransactionByHash',[tx_hash])
            receipt=cache.get('eth_getTransactionReceipt',[tx_hash])
            header=cache.get('eth_getBlockByNumber',[log['blockNumber'],False])
            if not tx or not receipt or not header:
                raise ValueError('missing external pool transaction')
            if receipt['status']!='0x1' or tx['hash']!=tx_hash or tx['blockHash']!=header['hash'] or receipt['blockHash']!=header['hash']:
                raise ValueError('external transaction provenance mismatch')
            if not any(x['logIndex']==log['logIndex'] and x['data']==log['data'] and x['topics']==log['topics'] for x in receipt['logs']):
                raise ValueError('pool transaction receipt does not match coverage')
            orders.append(dict(transaction=tx,receipt=receipt,at=int(header['timestamp'],16)*1000))
            write_json(output,dict(coverageHash=digest(coverage_path),orders=orders,complete=len(orders)==len(by_hash),total=len(by_hash)))
            if len(orders)%20==0 or len(orders)==len(by_hash):
                print('external pool inputs',len(orders),len(by_hash),flush=True)


def run(request_path, fork_path, key_path, cache_path, output, upstream):
    q, fork, key = map(read_json, [request_path, fork_path, key_path])
    start = fork['handoff']['exitAfter']['block']
    target = fork['executionAt'] // 1000
    headers = {}
    with Cache(cache_path, True, url=upstream, headers_url=upstream, logs_url=upstream) as cache:
        def header(block):
            h = cache.get('eth_getBlockByNumber', [hex(block), False])
            if not h or int(h['number'], 16) != block:
                raise ValueError('missing verified block boundary')
            headers[block] = h
            return int(h['timestamp'], 16)
        low, high = start, start + 256
        if header(low) > target or header(high) <= target:
            raise ValueError('execution outside bounded header bracket')
        while high - low > 1:
            mid = (low + high) // 2
            if header(mid) <= target:
                low = mid
            else:
                high = mid
        logs = cache.get('eth_getLogs', [{'address': MANAGER, 'topics': [None, key['id']],
                                        'fromBlock': hex(start), 'toBlock': hex(low)}])
        if logs is None:
            raise ValueError('pool log coverage unavailable')
    write_json(output, dict(requestHash=digest(request_path), forkHash=digest(fork_path),
        keyHash=digest(key_path), token=q['token'], fromBlock=start, throughBlock=low,
        executionAt=fork['executionAt'], headers=headers, logs=logs, logCount=len(logs),
        historicalSourceCovered=True, externalPoolOrdersReplayed=False,
        scope='Historical pool actions through every block in the modeled exit second. This is coverage evidence, not counterfactual fill parity.'))
    print({'token': q['token'], 'poolLogs': len(logs), 'fromBlock': start, 'throughBlock': low})


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    for name in ['request','fork','key','cache','out','upstream']:
        parser.add_argument('--'+name, required=True)
    args=parser.parse_args()
    run(args.request,args.fork,args.key,args.cache,args.out,args.upstream)
