"""Replay every frozen actual attempt and export unresolved pool handoffs."""
import argparse
import copy
from pathlib import Path
from research.core.data import read_json, write_json, digest
from research.core.expanded_sample import quote_interval
from research.core.shared_execution import ExecutionWorker
from research.core.unified_fidelity import matched_score
from research.core.external_orders import enrich


def run(source, out, external_evidence=None):
    source, out = Path(source), Path(out)
    out.mkdir(parents=True, exist_ok=False)
    paths = [source / name for name in ['requests.json', 'rows.json', 'reference.json']]
    hashes = {str(p): digest(p) for p in paths}
    requests, rows, reference = [read_json(p) for p in paths]
    expected = reference['results']
    evidence = {}
    if external_evidence:
        for path in sorted(Path(external_evidence).glob('0x*.json')):
            evidence[path.stem] = read_json(path)
            hashes[str(path)] = digest(path)
    if len(requests) != len(rows) or len(rows) != len(expected):
        raise ValueError('actual attempt/reference count mismatch')
    results, pool_requests = [], []
    with ExecutionWorker() as worker:
        identity = worker.call('identity')
        for offset in range(0, len(requests), 40):
            batch = copy.deepcopy(requests[offset:offset + 40])
            if evidence:
                batch = [enrich(q, evidence) for q in batch]
            for q in batch:
                q['entryQuoteTokens'] = str(quote_interval(q['minTokens'], 5000)[0])
                q['timing'].update(label='q5000-rank0.5-sell1200-after', buyOrderFraction=.5,
                                   sellMs=1200, sameTimeOrder='after')
            predicted = worker.call('predict', requests=batch)
            if len(predicted) != len(batch):
                raise ValueError('worker omitted attempts')
            results.extend(predicted)
            for q, p in zip(batch, predicted):
                if p.get('poolReplay'):
                    pool_requests.append({'request': q, 'handoff': p['poolReplay']})
            print('replayed', len(results), len(requests), flush=True)
    resolved_changes = [r['id'] for r, before, after in zip(rows, expected, results)
                        if before['pnlWei'] is not None and before != after]
    unavailable_changes = [{'id': r['id'], 'before': before, 'after': after}
                           for r, before, after in zip(rows, expected, results)
                           if before['pnlWei'] is None and before != after]
    if hashes != {str(p): digest(p) for p in hashes}:
        raise ValueError('frozen inputs changed')
    write_json(out / 'predictions.json', results)
    write_json(out / 'pool-requests.json', pool_requests)
    audit = dict(modelHash=identity['modelHash'], inputHashes=hashes, attempts=len(rows),
                 resolvedReferenceChanges=resolved_changes, unavailableChanges=unavailable_changes,
                 actualCash=matched_score(rows, results), diagnosticOnly=True, certified=False)
    write_json(out / 'audit.json', audit)
    if resolved_changes:
        raise ValueError('resolved execution results changed; inspect before scoring')
    return audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--external-evidence')
    args = parser.parse_args()
    run(args.source, args.out, args.external_evidence)
