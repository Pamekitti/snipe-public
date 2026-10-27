"""Independently check quote files against frozen matrices and decoded RPC evidence."""
import argparse
import collections
import hashlib
import json
import sqlite3
from pathlib import Path
from research.core.data import Cache, Worker, digest, read_json, write_json


def audit(root):
    root = Path(root)
    errors, counts = [], collections.Counter()
    decoded = {}
    cache = sqlite3.connect(f'file:{root / "rpc-cache.sqlite"}?mode=ro', uri=True)
    def cached(method, params):
        row = cache.execute('SELECT value FROM rpc WHERE key=?', (Cache.key(method, params),)).fetchone()
        if not row:
            raise ValueError('missing_cached_rpc_evidence')
        return json.loads(row[0])
    with Worker() as worker:
        venue = worker.call(op='metadata')['v4']
        for path in sorted((root / 'pool-quotes').glob('[0-9][0-9][0-9][0-9].json')):
            source = root / 'matrices' / path.name
            artifact = read_json(path)
            counts['chunks'] += 1
            if digest(source) != artifact['sourceHash']:
                errors.append([path.name, 'source_hash'])
                continue
            requests = {}
            for row in read_json(source):
                for lane in row.get('matrix') or []:
                    for exits in lane:
                        for result in exits:
                            h = result.get('poolReplay')
                            if h:
                                requests[h['inputHash']] = (h, row['poolCosts'], row['endAt'])
            expected_keys = {h + ':' + str(d) for h in requests for d in (0, 2000, 5000)}
            if expected_keys != set(artifact['quotes']):
                errors.append([path.name, 'quote_inventory'])
            for key, quote in artifact['quotes'].items():
                if quote.get('status') == 'unavailable':
                    counts['unavailable'] += 1
                    continue
                counts['quotes'] += 1
                try:
                    identity, delay = key.split(':')
                    handoff, costs, end = requests[identity]
                    proof = artifact['proofs'][quote['evidenceHash']]
                    assert hashlib.sha256(json.dumps(proof, sort_keys=True).encode()).hexdigest() == quote['evidenceHash'], 'proof_hash'
                    header, next_header = proof['header'], proof['nextHeader']
                    assert quote['inputHash'] == identity, 'input_hash'
                    assert quote['tokens'] == handoff['tokens'], 'tokens'
                    assert quote['attemptedAt'] == handoff['attemptedAt'], 'attempt_time'
                    assert quote['extraDelayMs'] == int(delay) and quote['haircutBps'] == 0, 'scenario'
                    assert quote['executionAt'] == handoff['attemptedAt'] + quote['preparationTransactions'] * 1000 + int(delay), 'preparation_time'
                    assert quote['executionAt'] <= end, 'capture_tail'
                    assert int(header['number'], 16) == quote['block'], 'block_number'
                    assert int(next_header['number'], 16) == quote['block'] + 1, 'next_block_number'
                    assert next_header['parentHash'] == header['hash'], 'header_chain'
                    assert int(header['timestamp'], 16) * 1000 == quote['blockAt'], 'block_time'
                    assert int(next_header['timestamp'], 16) * 1000 == quote['nextBlockAt'], 'next_block_time'
                    assert quote['blockAt'] <= quote['executionAt'] < quote['nextBlockAt'], 'availability'
                    assert proof['precedingCosts'] == costs, 'cost_inputs'
                    info = proof['factoryResult']
                    assert info['token'].lower() == handoff['token'].lower(), 'factory_token'
                    assert info['curve'].lower() == handoff['curve'].lower(), 'factory_curve'
                    assert quote['preparationTransactions'] == 4 - int(info['phase']), 'preparation_count'
                    if quote['evidenceHash'] not in decoded:
                        factory_data = worker.call(op='encode_pool_context', token=handoff['token'])
                        factory_raw = cached('eth_call', [{'to':'0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', 'data':factory_data}, proof['factoryBefore']['number']])
                        assert worker.call(op='decode_pool_context', data=factory_raw) == info, 'factory_cached_evidence'
                        expected_key = dict(currency0='0x'+'0'*40, currency1=handoff['token'], fee=int(info['poolFee']), tickSpacing=int(info['tickSpacing']), hooks=venue['hook'])
                        assert proof['key'] == expected_key, 'pool_key'
                        quote_data = worker.call(op='encode_pool', key=expected_key, tokens=handoff['tokens'])
                        assert cached('eth_call', [{'to':venue['quoter'], 'data':quote_data}, header['number']]) == proof['rawQuote'], 'official_cached_quote'
                        assert cached('eth_getBlockByNumber', [header['number'], False]) == header, 'cached_header'
                        assert cached('eth_getBlockByNumber', [next_header['number'], False]) == next_header, 'cached_next_header'
                        decoded[quote['evidenceHash']] = worker.call(op='decode_pool', data=proof['rawQuote'])
                    proceeds, gas = decoded[quote['evidenceHash']]
                    assert int(proceeds) == int(quote['proceedsWei']), 'quote_proceeds'
                    expected_gas = max(int(costs['sellWei']), int(gas) * int(header['baseFeePerGas'], 16)) + quote['preparationTransactions'] * int(costs['approvalWei'])
                    assert expected_gas == int(quote['gasWei']), 'modeled_gas'
                except (AssertionError, KeyError, ValueError) as error:
                    errors.append([path.name, key, str(error)])
    cache.close()
    expected_chunks = len(read_json(root / 'input-manifest.json')['chunks'])
    if counts['chunks'] != expected_chunks:
        errors.append(['incomplete_chunk_inventory', counts['chunks'], expected_chunks])
    result = {'passed': not errors, 'counts': dict(counts), 'errors': errors,
              'scope': 'Artifact integrity and calculation inputs. Historical pool quotes remain research approximations.'}
    write_json(root / 'verification' / 'pool-artifact-audit.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    result = audit(args.root)
    print(json.dumps(result))
    raise SystemExit(0 if result['passed'] else 1)
