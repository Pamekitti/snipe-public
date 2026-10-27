"""Aggregate complete account grids without treating data gaps as wallet continuity."""
import argparse
import json
import sqlite3
from functools import lru_cache
from itertools import groupby
from pathlib import Path
from .data import read_json, write_json, digest
from .fidelity import cash_metrics
from .september_guard_report import ratios


def collect(root, lo=None, hi=None):
    root=Path(root)
    design=read_json(root/'design.json')
    coverage=read_json(root/'coverage.json')
    db=sqlite3.connect('file:'+str(root/'scores.sqlite')+'?mode=ro',uri=True)
    counts=dict(db.execute('select segment,count(*) from scores group by segment'))
    segments=len(coverage['intervals'])
    if any(counts.get(i)!=len(design['rules']) for i in range(segments)):
        raise ValueError('Cannot rank an incomplete grid: '+str(root))
    def in_period(row):
        return (lo is None or row['at']>=lo) and (hi is None or row['at']<hi)
    refs=[read_json(root/f'reference-{i}.json') for i in range(segments)]
    refcash=sorted([r for ref in refs for r in ref['cash'] if in_period(r)],key=lambda r:(r['at'],r['id']))
    denom=cash_metrics(refcash)
    @lru_cache(maxsize=512)
    def account(key):
        value=db.execute('select value from accounts where id=?',(key,)).fetchone()
        if value is None:raise ValueError('Missing account checkpoint: '+key)
        return json.loads(value[0])
    cards={}
    for name,group in groupby(db.execute('select name,rule,value from scores order by name,segment'),key=lambda r:r[0]):
        chunks=[];rule=None
        for _,rule_json,value in group:
            rule=json.loads(rule_json);row=json.loads(value)
            chunks.append(account(row['account_id']) if 'account_id' in row else row)
        cash=sorted([r for chunk in chunks for r in chunk['cash'] if in_period(r)],key=lambda r:(r['at'],r['id']))
        if len({r['id'] for r in cash})!=len(cash):raise ValueError('Duplicate cash across intervals')
        metrics=cash_metrics(cash)
        episodes=[e for chunk in chunks for e in chunk['recovery']['episodes']
                  if (lo is None or e['at']>=lo) and (hi is None or e['until']<=hi)]
        losses=[-int(e['pnl_wei']) for e in episodes if int(e['pnl_wei'])<0]
        cards[name]=dict(rule=rule,metrics=metrics,kpis=ratios(metrics,denom),
                         losing_recoveries=len(losses),recovery_loss_wei=str(sum(losses)),
                         complete=bool(segments) and all(c['complete'] for c in chunks))
    db.close()
    return dict(scope=design['scope'],lo=lo,hi=hi,design_sha256=digest(root/'design.json'),
                coverage=coverage,denominator='Same exits with only the market guard removed',
                reference=denom,reference_complete=bool(segments) and all(r['complete'] for r in refs),cards=cards)


def run(root):
    root=Path(root)
    output=collect(root)
    write_json(root/'scorecards.json',output)
    print('Scorecards',len(output['cards']),root,flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True)
    run(parser.parse_args().root)
