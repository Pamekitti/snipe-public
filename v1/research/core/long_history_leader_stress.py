"""Post-comparison 60-second publication stress for the two automatic leaders."""
from dataclasses import replace
from .data import read_json,write_json,write_artifact,digest
from .long_history import ROOT,OUT,SOURCE,observations_for,summary,compress
from .indicator_study import make_tapes,trades_for,configured_policy
from .indicators import candidates,IndicatorGuard
from .account import simulate
from .evaluation import recovery_losses
from .guard_visual import close_cash
from .fidelity import cash_metrics


def run():
    raw,models=read_json(SOURCE),read_json(ROOT/'models.json')
    passed={f['token'].lower() for f in raw['bot_launches'] if f.get('passed')}
    models={**models,'tokens':{t:z for t,z in models['tokens'].items() if t in passed}}
    index=read_json(OUT/'segments-index.json');base=configured_policy(raw)
    rules=[r for r in candidates() if r.name in ('fixed_shadow20','matched20')]
    records={}
    for mode in ('recorded','reconstructed_early'):
        obs=observations_for(raw,models,mode=='reconstructed_early')
        for i,(a,b) in enumerate(index['intervals']):
            central=read_json(OUT/'segments'/f'{mode}-{i:02}-automatic-adaptive.json')
            tapes,missing=make_tapes(raw,models,central['runs']['continuous'],obs)
            for variant in ('fast_sell','adaptive','slow_sell'):
                path=OUT/'leader-delay'/f'{mode}-{i:02}-{variant}.json'
                if path.exists():records[f'{mode}/{i}/{variant}']=read_json(path);continue
                trades=[t for t in trades_for(models,variant) if a<=t['entry']<b-180000]
                g={}
                for rule in rules:
                    guard=IndicatorGuard(tapes[rule.source],replace(rule,delay_ms=60000),base.size_wei,halted=True)
                    r=simulate(obs,trades,base,a,b,guard=guard)
                    g[rule.name]=dict(score=summary(r,a,b),recovery=recovery_losses(r,b),run=compress(r))
                write_json(path,g);records[f'{mode}/{i}/{variant}']=g
            print('Leader delay stress',mode,i,flush=True)
    agg={}
    original=read_json(OUT/'comparative-scorecards.json')['aggregates']
    for mode in ('recorded','reconstructed_early'):
        for variant in ('fast_sell','adaptive','slow_sell'):
            for rule in rules:
                rr=[records[f'{mode}/{i}/{variant}'][rule.name] for i in range(len(index['intervals']))]
                cash=[dict(row,id=f'{i}/{row["id"]}') for i,r in enumerate(rr) for row in close_cash(r['run']) if row['id'] not in r['run']['open_ids']]
                s=cash_metrics(cash);base_score=original[f'{mode}/automatic/{variant}']['market_plus2']
                dd=max(int(r['score']['drawdown_wei']) for r in rr)
                agg[f'{mode}/{variant}/{rule.name}']=dict(net_wei=s['net_wei'],worst_interval_drawdown_wei=str(dd),
                    extra_eth=(int(s['net_wei'])-int(base_score['net_wei']))/1e18,
                    no_worse_dd=dd<=int(base_score['worst_interval_drawdown_wei']),
                    recovery_loss_eth=sum(r['recovery']['loss_eth'] for r in rr),
                    baseline_recovery_loss_eth=base_score['recovery_loss_eth'],
                    complete=all(r['score']['complete'] for r in rr))
    write_artifact(OUT/'leader-delay-index.json',dict(post_comparison_stress=True,delay_ms=60000,aggregates=agg,
        note='This check was added after identifying the automatic leaders. It changes no original candidate or headline score.',
        frozen_design_sha256=digest(ROOT/'frozen-design.json')))
    print('Leader stress complete',flush=True)

if __name__=='__main__':run()
