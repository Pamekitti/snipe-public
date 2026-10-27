"""Independent saved-cash, causality and baseline-regression checks."""
from collections import defaultdict
from pathlib import Path
from .data import read_json,write_json,digest
from .september_guard_study import OUT,SCENARIOS


def verify():
    d=read_json(OUT/'design.json');coverage=read_json(OUT/'coverage.json')
    checked=0;baseline_matches=0;decisions=0;changes=0;strict={}
    prior=Path('data/research/20260911-long-history-results-v2/segments')
    for s in SCENARIOS:
        for i,(a,b) in enumerate(coverage['intervals']):
            p=OUT/'runs'/f'{s["name"]}-{i:02}.json'
            g=read_json(p)
            assert (g['start'],g['end'])==(a,b)
            bytoken={r['token']:r for r in g['shadow_records']}
            assert all(r['available']>r['close'] and r['available']>r['scored'] for r in bytoken.values())
            for n,r in g['runs'].items():
                assert r['complete'] and not r['unresolved'] and not r['open_ids']
                assert sum(x['pnl'] for x in r['cash'])==int(r['scores']['full']['net_wei'])
                assert len(r['cash'])==len(r['admitted'])
                assert {x['id'] for x in r['cash']}=={x['id'] for x in r['admitted']}
                if not n.startswith('earned_'):
                    assert all(x['size'] in (None,20000000000000000) for x in r['admitted'])
                for t in r.get('guard_transitions',[]):
                    evidence=[x for x in bytoken.values() if a<=x['available']+s['delay']<=t['at']]
                    assert abs(sum(x['value'] for x in evidence)-t['total'])<1e-9
                    changes+=1
                decisions+=len(r['admitted']);checked+=1
            # Earlier independent study uses identical intervals after the first gap.
            if i>0 and s['delay']==0 and not s['controls']:
                old=read_json(prior/f'{s["mode"]}-{i:02}-automatic-{s["variant"]}.json')
                for n in ('continuous','matched20'):
                    totals=defaultdict(int)
                    for r in old['runs'][n]['cash']:totals[r['id']]+=r['pnl']
                    assert totals=={r['id']:r['pnl'] for r in g['runs'][n]['cash']},(s['name'],i,n)
                    baseline_matches+=1
            if i==0:
                strict[s['name']]=dict(start=a,admission_end=b-180000,cash_end=b,
                    scores={n:r['scores']['full'] for n,r in g['runs'].items()},
                    full_september_available=False,first_common_unknown=b)
    write_json(OUT/'strict-prefix.json',strict)
    result=dict(checked_accounts=checked,checked_admissions=decisions,causal_transitions=changes,
                exact_prior_baseline_cash_matches=baseline_matches,strict_complete_prefix_end=coverage['intervals'][0][1],
                full_continuous_september_available=False,all_checks_passed=True,
                source_hashes={str(p):digest(p) for p in [Path(__file__),OUT/'design.json']})
    write_json(OUT/'independent-verification.json',result)
    print(result,flush=True)

if __name__=='__main__':verify()
