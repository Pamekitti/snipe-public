"""Fetch complete public curve logs for the frozen longer guard study.

Run from the repo root. Local cache writes only; no trading or provider key.
"""
from __future__ import annotations
import argparse
import gzip
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import certifi

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import chainio

DAY = 86_400_000


def eligible(r):
    return bool(r.get('passed') and r.get('block') and r.get('curve')
                and 50 <= (r.get('creator_tax_bps') or 0) <= 200
                and (r.get('exemptions') or 0) >= 3)


def targets(data, include_template_rejects=False):
    now = data['snapshot_at']
    def accepted(r):
        static = (r.get('block') and r.get('curve') and r.get('pair_token') == '0x0000000000000000000000000000000000000000'
                  and 50 <= (r.get('creator_tax_bps') or 0) <= 200 and (r.get('exemptions') or 0) >= 3
                  and int(r.get('dev_buy_wei') or 0) >= 10**16
                  and r.get('prior_launches') is not None and r['prior_launches'] <= 3)
        return eligible(r) or (include_template_rejects and static)
    rows = {r['token'].lower(): r for r in data['bot_launches']
            if accepted(r) and now - 15*DAY <= (r['launched_at'] or 0)*1000 < now - 100_000}
    # Actual-fill calibration needs complete paths for the same eligible universe.
    return rows


def sufficient(row, fact):
    return row[1] <= fact['block'] and row[2] >= fact['block'] + 950 and row[4] is not None and row[5] is None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=Path, default=Path('v1/data/market-guard-longer-20260908'))
    ap.add_argument('--pace', type=float, default=1.)
    ap.add_argument('--limit', type=int)
    ap.add_argument('--include-template-rejects', action='store_true')
    args = ap.parse_args()
    os.environ['SSL_CERT_FILE'] = certifi.where()
    data = json.load(gzip.open(args.root / 'snapshot.json.gz', 'rt'))
    facts = targets(data, args.include_template_rejects)
    db = sqlite3.connect(args.root / 'paths.db')
    db.execute('create table if not exists paths(token text primary key, from_block integer, to_block integer, fetched_at integer, js text, error text)')
    for source in ('paths.db', 'postfreeze_paths.db'):
        old = Path('v1/data/exit-policy-audit') / source
        if not old.exists():
            continue
        with sqlite3.connect(f'file:{old}?mode=ro', uri=True) as c:
            columns = {r[1] for r in c.execute('pragma table_info(paths)')}
            if not {'from_block', 'to_block', 'fetched_at', 'error'} <= columns:
                continue
            for row in c.execute('select token,from_block,to_block,fetched_at,js,error from paths'):
                token = row[0].lower()
                if token in facts and sufficient(row, facts[token]):
                    db.execute('insert or ignore into paths values(?,?,?,?,?,?)', (token, *row[1:]))
    db.commit()
    done = {r[0] for r in db.execute('select * from paths') if r[0] in facts and sufficient(r, facts[r[0]])}
    pending = sorted((r for t, r in facts.items() if t not in done), key=lambda r: r['block'])
    if args.limit is not None:
        pending = pending[:args.limit]
    groups = []
    for row in pending:
        if not groups or len(groups[-1]) >= 12 or row['block']-groups[-1][0]['block'] > 9_000:
            groups.append([])
        groups[-1].append(row)
    print(f'{len(facts)} targets; {len(done)} complete cached; {len(pending)} pending in {len(groups)} batches', flush=True)
    rpc = chainio.make_rpc('market-guard-longer-readonly', timeout=25, tries=1)

    def fetch(group):
        try:
            logs = rpc('eth_getLogs', [{
                'fromBlock': hex(min(r['block'] for r in group)),
                'toBlock': hex(max(r['block'] for r in group)+950),
                'address': [r['curve'] for r in group], 'topics': [chainio.CURVE_TOPICS]}])
            time.sleep(args.pace)
            if len(logs) >= 1000:
                if len(group) == 1:
                    raise RuntimeError('Possible RPC truncation on individual curve')
                mid = len(group)//2
                return fetch(group[:mid]) + fetch(group[mid:])
            return [(r, json.dumps([x for x in logs if x['address'].lower() == r['curve'].lower()
                        and r['block'] <= int(x['blockNumber'], 16) <= r['block']+950]), None) for r in group]
        except Exception as exc:
            message = str(exc)
            time.sleep(60 if '429' in message or 'rate limit' in message.lower() else args.pace)
            if len(group) > 1:
                mid = len(group)//2
                return fetch(group[:mid]) + fetch(group[mid:])
            return [(r, None, str(exc)[:300]) for r in group]

    completed = errors = 0
    for i, group in enumerate(groups):
        for row, js, error in fetch(group):
            db.execute('insert or replace into paths values(?,?,?,?,?,?)',
                       (row['token'].lower(), row['block'], row['block']+950, int(time.time()*1000), js, error))
            completed += 1
            errors += error is not None
        db.commit()
        if i % 5 == 0 or errors:
            print(f'{completed}/{len(pending)} fetched; {errors} errors; batch {i+1}/{len(groups)}', flush=True)
    print(f'complete: {completed} fetched, {errors} errors', flush=True)


if __name__ == '__main__':
    main()
