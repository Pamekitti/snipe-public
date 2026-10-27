"""Paired fixed-inventory comparisons, separate from entry-policy profit estimates."""
import json,statistics as st,pathlib,datetime as dt,hashlib
root=pathlib.Path(__file__).resolve().parents[1]/'data/graduation-launch-audit'
x=json.loads((root/'snapshot.json').read_text());rows=[json.loads(l)for l in(root/'quotes.jsonl').read_text().splitlines()if l.startswith('{')]
def desc(a):
 a=list(a);return {'n':len(a),'mean':st.mean(a)if a else None,'median':st.median(a)if a else None,'sd':st.stdev(a)if len(a)>1 else None,'sum':sum(a),'positive':sum(v>0 for v in a)}
fast=[r for r in rows if r['scope']=='fast graduation'and r.get('waits')]
for r in fast:r['values']={v['sec']:int(v['proceeds'])/1e18 for v in r['waits']if'proceeds'in v}
comparisons={}
for sec in [5,15,30,60,180,600]:
 rr=[r for r in fast if sec in r['values']and 2 in r['values']]
 comparisons[sec]={'paired_change_pct':desc(100*(r['values'][sec]/r['values'][2]-1)for r in rr),'delta_eth':desc(r['values'][sec]-r['values'][2]for r in rr),'without_best_delta_eth':sum(sorted(r['values'][sec]-r['values'][2]for r in rr)[:-1]),'without_husdp_delta_eth':sum(r['values'][sec]-r['values'][2]for r in rr if r['launch']['symbol']!='HUSDP')}
actual=[p for p in x['positions']if p['closed']and p['exit_reason']not in ['buy-reverted','buy-never-mined','recovered-flat']]
ret=lambda p:100*int(p['onchain_pnl_wei']or p['pnl_wei'])/int(p['spend_wei'])
high=[p for p in actual if(p['entry_mult']or 0)>=3]
now=x['snapshot_at'];era=x['era']['from'];cut=now-3*3600000
iso=lambda t:dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).isoformat()
elig=[r for r in x['launches']if r['passed']==1 and 50<=(r['creator_tax_bps']or 0)<=200 and(r['exemptions']or 0)>=3]
rejected=[r for r in x['launches']if(r['entry_reject']or'').startswith('pumped')]
bins={}
for label,h,n in [('24h',24,8),('7d',168,7)]:
 bins[label]=[];width=h*3600000/n
 for i in range(n):
  a=now-h*3600000+i*width;b=a+width;rs=[r for r in fast if a<=r['gradTime']*1000<b];ps=[p for p in actual if a<=p['t_sent']<b]
  bins[label].append({'from':iso(a),'to':iso(b),'coverage':'outside era'if b<=era else'partial era'if a<era else'in era','eligible':sum(a<=r['detected_at']<b for r in elig),'pumped_rejections':sum(a<=r['entry_reject_at']<b for r in rejected),'actual_return_pct':desc(ret(p)for p in ps),'wait60_change_pct':desc(100*(r['values'][60]/r['values'][2]-1)for r in rs if 60 in r['values'])})
summary={'snapshot':iso(now),'era':iso(era),'cut':iso(cut),'snapshot_sha256':hashlib.sha256((root/'snapshot.json').read_bytes()).hexdigest(),'eligible':len(elig),'guard_rejected':len(rejected),'graduated':len(rows),'fast_usable':len(fast),'before_holdout_n':sum(r['gradTime']*1000<cut for r in fast),'high_actual_returns_pct':desc(ret(p)for p in high),'high_without_husdp':desc(ret(p)for p in high if p['id']!=2167),'comparisons':comparisons,'bins':bins,'rows':rows}
(root/'summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps({k:v for k,v in summary.items()if k not in ['rows','bins']},indent=2))
