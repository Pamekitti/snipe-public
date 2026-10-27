"""Frozen actual-attempt audit through the shared TypeScript engine. Never trades."""
import argparse
import collections
import copy
import hashlib
import json
import pathlib
import shutil
import sqlite3

from .shared_execution import execute_batch
from .execution import describe
from .fidelity import cash_metrics, cash_contrast, execution_windows, grade

BOT = pathlib.Path(__file__).resolve().parents[2]


def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def read_database(path):
    db = sqlite3.connect('file:' + str(path) + '?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    return db


def matched_score(rows, predictions):
    pairs = [(row, prediction) for row, prediction in zip(rows, predictions)
             if prediction.get('pnlWei') is not None and prediction.get('exitAt') is not None and row['actualWei'] is not None]
    errors = [100 * (int(p['pnlWei']) - int(r['actualWei'])) / int(r['sizeWei']) for r, p in pairs]
    actual = [dict(id=r['id'], at=r['exitAt'], pnl=r['actualWei']) for r, _ in pairs]
    predicted = [dict(id=r['id'], at=p['exitAt'], pnl=p['pnlWei']) for r, p in pairs]
    sign = lambda n: (n > 0) - (n < 0)
    quantities = [100 * (int(p['tokens']) - int(r['actualTokens'])) / int(r['actualTokens']) for r, p in pairs
                  if int(r['actualTokens'] or 0) > 0 and p.get('tokens') is not None]
    costs = [(int(p['costsWei']) - int(r['actualCostsWei'])) / 1e18 for r, p in pairs if p.get('costsWei') is not None and r['actualCostsWei'] is not None]
    return dict(expected=len(rows), known=len(pairs), missing=len(rows)-len(pairs), actual=cash_metrics(actual), predicted=cash_metrics(predicted),
                signedErrorPp=describe(errors), absoluteErrorPp=describe(abs(e) for e in errors),
                quantityErrorPct=describe(quantities), costsErrorEth=describe(costs),
                entryAcceptanceAgreement=sum(r['actualBuyAccepted'] == (int(p.get('tokens') or 0) > 0) for r, p in pairs)/len(pairs) if pairs else None,
                signAgreement=sum(sign(int(r['actualWei'])) == sign(int(p['pnlWei'])) for r, p in pairs)/len(pairs) if pairs else None,
                falseWinners=[r['id'] for r, p in pairs if int(r['actualWei']) < 0 < int(p['pnlWei'])],
                exitReasonAgreement=sum(r['actualReason'] == p['reason'] for r, p in pairs)/len(pairs) if pairs else None,
                exitTimingErrorMs=describe(p['exitAt']-r['exitAt'] for r, p in pairs),
                unavailableReasons=dict(collections.Counter(p.get('reason') for p in predictions if p.get('pnlWei') is None)))


def run(manifest_path, output):
    manifest_path, output = pathlib.Path(manifest_path), pathlib.Path(output)
    manifest = json.loads(manifest_path.read_text())
    start, end = manifest['from'], manifest['through']
    if not start < end or not start <= manifest['londonDayStart'] < end:
        raise ValueError('invalid frozen time range')
    frozen_manifest_hash = sha(manifest_path)
    source_hashes = manifest['sourceHashes']
    if 'research/core/unified_fidelity.py' not in source_hashes:
        raise ValueError('audit source must be frozen')
    for name, expected in source_hashes.items():
        if sha(BOT/name) != expected:
            raise ValueError('source hash mismatch: ' + name)
    output.mkdir(parents=True, exist_ok=False)
    sources = {}
    for name, source in manifest['inputs'].items():
        path = (manifest_path.parent / source['path']).resolve()
        if sha(path) != source['sha256']:
            raise ValueError('input hash mismatch: ' + name)
        sources[name] = path
    identity = execute_batch('identity')
    if identity['modelHash'] != manifest['modelHash']:
        raise ValueError('frozen model hash mismatch')
    db, captures = read_database(sources['bot']), read_database(sources['simulation'])
    all_positions = [dict(r) for r in db.execute('SELECT * FROM positions WHERE live=1 AND coalesce(t_decide,t_detect)<?', (end,))]
    positions = [p for p in all_positions if start <= (p['t_decide'] or p['t_detect']) < end]
    positions.sort(key=lambda p: (p['t_decide'] or p['t_detect'], p['id']))
    by_id = {p['id']: p for p in positions}
    marks = collections.defaultdict(list)
    for row in db.execute('SELECT position_id,at,reason FROM trade_marks WHERE at<? ORDER BY at', (end,)):
        marks[row['position_id']].append(dict(row))
    arrival = {}
    for row in captures.execute("SELECT at,payload FROM captures WHERE kind='chain-log' AND at<? ORDER BY at", (end,)):
        log = json.loads(row['payload'])
        arrival.setdefault((log['transactionHash'].lower(), int(str(log['logIndex']), 0) if isinstance(log['logIndex'], str) else log['logIndex']), row['at'])
    modern = json.loads(sources['modern_matches'].read_text())
    legacy = json.loads(sources['legacy_requests'].read_text())
    historical_calibrations = json.loads(sources['historical_calibrations'].read_text()) if 'historical_calibrations' in sources else None
    requests, rows, calibration = [], [], []
    for raw, actual, quality in [(r, by_id[int(r['id'])], 'inferred_historical_intent') for r in legacy] + [(r['request'], by_id[r['id']], 'captured_preexecution_intent') for r in modern]:
        q = copy.deepcopy(raw)
        # Decision time, target and submitted limits existed before the transaction. Fills and cash never enter q.
        at = actual['t_decide'] or actual['t_detect']
        q['entryAt'] = at; q['endAt'] = min(end, q['endAt']); q['openedAt'] = at + q['timing']['sendMs']
        q['logs'] = [log for log in q['logs'] if log['at'] < end]
        for log in q['logs']:
            key = (log['transactionHash'].lower(), int(log['logIndex'], 16))
            recorded = arrival.get(key) if quality == 'captured_preexecution_intent' else None
            log['observationSource'] = 'recorded' if recorded is not None else 'modeled'
            log['observedAt'] = recorded if recorded is not None else log['at'] + q['timing']['observationMs']
        preceding = []
        cutoff = min(at-21600000, end-21600000)
        for prior in sorted(all_positions, key=lambda p: p.get('exit_at') or 0, reverse=True):
            if not prior['closed'] or not prior['buy_ok'] or prior['exit_reason'] in ('buy-reverted', 'buy-never-mined'):
                continue
            if not prior.get('exit_at') or prior['exit_at'] >= cutoff or (prior.get('updated_at') or prior['exit_at']) >= cutoff:
                continue
            observed = marks[prior['id']]; triggers = [m['at'] for m in observed if m['reason']]
            if not observed or not triggers or not prior['t_sent'] or not prior['t_decide'] or prior.get('gas_wei') is None:
                continue
            confirmation = prior.get('t_confirmed') or observed[0]['at']
            preceding.append(dict(completedAt=prior['exit_at'], availableAt=prior['updated_at'], sendMs=prior['t_sent']-prior['t_decide'],
                                  confirmationMs=confirmation-prior['t_sent'], sellMs=prior['exit_at']-triggers[0], observationMs=confirmation-prior['t_sent']))
            if len(preceding) == 100:
                break
        if historical_calibrations is not None and quality == 'inferred_historical_intent':
            frozen = historical_calibrations[str(actual['id'])]
            if frozen['frozenAt'] != at or frozen['evaluationEnd'] != at or len(frozen['samples']) < 20:
                raise ValueError('incompatible historical calibration')
            if any(not s.get('availableAt') or s['availableAt'] >= at-21600000 or s['completedAt'] >= at-21600000 for s in frozen['samples']):
                raise ValueError('unproved historical calibration availability')
            calibration.append(frozen)
        else:
            calibration.append(dict(samples=preceding, frozenAt=at, evaluationEnd=at))
        requests.append(q)
        value = actual['onchain_pnl_wei'] if actual['onchain_pnl_wei'] is not None else actual['pnl_wei']
        accepted = bool(actual['buy_ok']) and actual['exit_reason'] not in ('buy-reverted', 'buy-never-mined')
        costs = int(actual['proceeds_wei'] or 0) - (int(actual['spend_wei']) if accepted else 0) - int(value) if value is not None else None
        rows.append(dict(id=actual['id'], token=actual['token'], entryAt=at, exitAt=actual['exit_at'], sizeWei=actual['spend_wei'],
                         actualWei=value, actualReason=actual['exit_reason'], actualTokens=actual['tokens_held'],
                         actualBuyAccepted=accepted, actualCostsWei=str(costs) if costs is not None else None, quality=quality))
    timings = execute_batch('calibrate-many', requests=calibration)
    if 'timing_overrides' in sources:
        overrides=json.loads(sources['timing_overrides'].read_text())
        for i,row in enumerate(rows):
            proposed=overrides[str(row['id'])]
            if len(proposed)!=3 or any(t['frozenAt']!=row['entryAt'] or t['fitThrough']>row['entryAt']-21600000 or t['n']<20 for t in proposed):
                raise ValueError('noncausal experimental timing override')
            timings[i]=proposed
    bundles = execute_batch('scenarios', requests=[dict(request=q, timings=t) for q, t in zip(requests, timings)])
    strict = execute_batch('predict', requests=requests)
    cohorts = {}
    for name, choose in [('all_matched_diagnostic', lambda r: True), ('captured_intents', lambda r: r['quality'] == 'captured_preexecution_intent'),
                         ('today_diagnostic', lambda r: r['entryAt'] >= manifest['londonDayStart'])]:
        selected = [i for i, row in enumerate(rows) if choose(row)]
        rr = [rows[i] for i in selected]
        scenarios = {}
        for k in range(6):
            predictions = [bundles[i]['scenarios'][k]['result'] for i in selected]
            scenarios[bundles[0]['scenarios'][k]['id']] = matched_score(rr, predictions)
        cohorts[name] = dict(rows=rr, strict=matched_score(rr, [strict[i] for i in selected]), scenarios=scenarios)
    known_modern = {row['id']: result for row, result in zip(rows, strict) if row['quality'] == 'captured_preexecution_intent'}
    coverage, graded_rows = [], []
    for p in positions:
        result = known_modern.get(p['id'], {})
        faults = []
        if not p.get('context_json'): faults.append('historical_strategy_context_missing')
        if not p.get('min_tokens_out'): faults.append('submitted_limit_missing')
        if p['id'] not in known_modern: faults.append('captured_preexecution_intent_missing')
        if result.get('pnlWei') is None: faults.append(result.get('reason', 'complete_prediction_unavailable'))
        if not p['closed'] or not p['exit_at'] or p['exit_at'] >= end: faults.append('unresolved_at_cutoff')
        coverage.append(dict(id=p['id'], faults=faults))
        graded_rows.append(dict(id=p['id'], token=p['token'], entry=p['t_decide'] or p['t_detect'], size=int(p['spend_wei']),
                                actual_wei=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei'], actual_at=p['exit_at'],
                                predicted_wei=result.get('pnlWei'), predicted_at=result.get('exitAt'), status=result.get('status', 'unavailable')))
    stake = min(row['size'] for row in graded_rows if row['size'] > 0)
    windows = execution_windows(graded_rows, start, end, stake)
    account = {name: dict(complete=False, entry_precision=None, entry_recall=None, cash=cash_contrast([], [], stake)) for name in ('current', 'fit', 'reserved6h')}
    arithmetic_exact = False
    if 'arithmetic_proof' in sources and 'arithmetic_log' in sources:
        proof = json.loads(sources['arithmetic_proof'].read_text())
        arithmetic_exact = (proof.get('passed') is True and proof.get('kind') == 'laptop_curve_arithmetic'
                            and proof.get('logSha256') == sha(sources['arithmetic_log'])
                            and proof.get('sourceHashes', {}).get('src/state/curve.ts') == sha(BOT/'src/state/curve.ts')
                            and all(sha(BOT/name) == expected for name, expected in proof['sourceHashes'].items()))
    evidence = dict(receipt_accounting_complete=False, arithmetic_exact=arithmetic_exact, historical_source_matches=False, calibration_is_causal=True,
                    input_hashes_valid=True, account_engine_reproduces_saved_run=False, wallet_residual_wei=None, exit_reason_agreement=None,
                    exit_time_error_ms=describe([]), exit_time_expected=len(positions),
                    actual_failures=sum(p['exit_reason'] in ('buy-reverted', 'buy-never-mined') for p in positions), failures_matched=0)
    limits = json.loads(sources['limits'].read_text())
    verdict = grade(windows, account, evidence, limits)
    actual = [dict(id=p['id'], at=p['exit_at'], pnl=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei']) for p in positions
              if p['closed'] and p['exit_at'] and p['exit_at'] < end and (p['onchain_pnl_wei'] is not None or p['pnl_wei'] is not None)]
    bins = {}
    for name, duration, count in [('24h', 86400000, 8), ('7d', 604800000, 7)]:
        bins[name] = [dict(start=end-duration+i*duration/count, end=end-duration+(i+1)*duration/count,
                          actual=cash_metrics([p for p in actual if end-duration+i*duration/count <= p['at'] < end-duration+(i+1)*duration/count])) for i in range(count)]
    receipts = {}
    if 'receipt_old' in sources and 'receipt_new' in sources:
        receipts = {row['id']: row for row in json.loads(sources['receipt_old'].read_text())['rows']}
        receipts.update({row['id']: row for row in json.loads(sources['receipt_new'].read_text())})
    receipt_summary = dict(expected=len(positions), exact=sum(receipts.get(p['id'], {}).get('complete', False) for p in positions),
                           missingIds=[p['id'] for p in positions if not receipts.get(p['id'], {}).get('complete', False)])
    result = dict(**identity, datasetHash=frozen_manifest_hash, fromUtc=manifest['fromUtc'], throughUtc=manifest['throughUtc'], fromMs=start, throughMs=end,
                  verdict=verdict, actualAttempts=len(positions), actualCash=cash_metrics(actual), actualRows=actual, cohorts=cohorts, coverage=coverage,
                  missingInputs=dict(collections.Counter(f for row in coverage for f in row['faults'])), execution=windows, account=account, evidence=evidence,
                  bins=bins, receiptReconstruction=receipt_summary, guardGridStarted=False, guardCandidates=2160, timingPolicies=10, liveChanges=False)
    if execute_batch('identity') != identity or sha(manifest_path) != frozen_manifest_hash:
        raise ValueError('model or manifest changed during audit')
    for name, source in manifest['inputs'].items():
        if sha(sources[name]) != source['sha256']:
            raise ValueError('input changed during audit: ' + name)
    for name, expected in source_hashes.items():
        if sha(BOT/name) != expected:
            raise ValueError('source changed during audit: ' + name)
    for name, value in [('fidelity.json', result), ('requests.json', requests), ('scenario-bundles.json', bundles), ('rows.json', rows), ('strict-results.json', strict)]:
        (output/name).write_text(json.dumps(value, indent=2))
    shutil.copy2(manifest_path, output/'run-manifest.json')
    objects = output/'objects'
    for folder in ['src/strategy', 'src/simulation', 'src/telemetry']:
        for path in sorted((BOT/folder).glob('*.ts')):
            target = objects/path.relative_to(BOT); target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(path, target)
    for name in ['scripts/execution-worker.ts', 'src/bot.ts', 'src/state/curve.ts', 'src/abi.ts', 'research/core/unified_fidelity.py', 'research/core/fidelity.py', 'research/BACKTEST_LIMITS_V1.json']:
        target = objects/name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(BOT/name, target)
    for name in source_hashes:
        target = objects/name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(BOT/name, target)
    from .unified_report import report
    report(output)
    (output/'artifact-hashes.json').write_text(json.dumps({str(path.relative_to(output)): sha(path) for path in output.rglob('*') if path.is_file()}, indent=2))
    db.close(); captures.close()
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--manifest', required=True); parser.add_argument('--out', required=True)
    args = parser.parse_args(); result = run(args.manifest, args.out)
    print(json.dumps(dict(status=result['verdict']['status'], actualAttempts=result['actualAttempts'], liveChanges=False)))
    raise SystemExit(0 if result['verdict']['historical_fidelity_passed'] else 2)
