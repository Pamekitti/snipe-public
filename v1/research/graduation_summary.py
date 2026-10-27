"""Summarize the frozen graduation cohort and receipt-based rescue accounting."""
import json,statistics,hashlib,datetime,pathlib
root=pathlib.Path('data/graduation-audit')
c=json.loads((root/'cohort.json').read_text())
rows=[json.loads(l) for l in (root/'archive-quotes.jsonl').read_text().splitlines() if l.startswith('{')]
g=json.loads((root/'graduations.json').read_text());repair=json.loads((root/'husdp-reconciliation.json').read_text())
now=c['snapshot_at'];era=c['era']['from'];cut=now-3*3600000
# Swap approvals and sale, plus actual original buy gas. Original gas includes reverted
# curve sell and curve approval; those do not belong to the post-graduation entry proxy.
p=repair['position'];buygas=int(p['gas_wei'])-int(p['burned_gas_wei'])-int(p['approval_gas_wei'])
cost=buygas+sum(int(t['gas']) for t in repair['tx'])
for r in rows:
 r['net_eth']=(int(r['proceeds'])-20000000000000000-cost)/1e18 if 'proceeds'in r else None
 r['return_pct']=r['net_eth']/.02*100 if r['net_eth'] is not None else None
 r['split']='excluded_latest_3h' if r['gradTime']>=cut else 'earlier'
def stats(a):
 a=[v for v in a if v is not None]
 return {'n':len(a),'mean':statistics.mean(a) if a else None,'median':statistics.median(a) if a else None,'sd':statistics.stdev(a) if len(a)>1 else None,'wins':sum(v>0 for v in a),'sum':sum(a)}
eligible=[r for r in c['launches'] if r['passed']==1 and 50<=(r['creator_tax_bps']or 0)<=200 and (r['exemptions']or 0)>=3]
launches={r['token'].lower():r for r in c['launches']}
grad_tokens={r['args']['token'].lower() for r in g}
def iso(t):return datetime.datetime.fromtimestamp(t/1000,datetime.timezone.utc).isoformat()
def bins(hours,n):
 out=[];step=hours*3600000//n
 for i in range(n):
  a=now-hours*3600000+i*step;b=a+step
  ls=[r for r in eligible if a<=r['detected_at']<b]
  rr=[r for r in rows if a<=r['gradTime']<b]
  out.append({'from':iso(a),'to':iso(b),'coverage':'outside era' if b<=era else 'partial era' if a<era else 'in era','eligible_launches':len(ls),'eventually_graduated':sum(r['token'].lower() in grad_tokens for r in ls),'quote_return_pct':stats([r['return_pct'] for r in rr])})
 return out
valid=[r for r in rows if r['net_eth']is not None]
result={'snapshot':iso(now),'era':iso(era),'excluded_since':iso(cut),'snapshot_sha256':hashlib.sha256((root/'snapshot.json').read_bytes()).hexdigest(),'counts':{'all_launches':len(c['launches']),'screened':sum(r['passed']==1 for r in c['launches']),'eligible':len(eligible),'all_graduation_events':len(g),'graduations_of_era_launches':sum(t in launches for t in grad_tokens),'eligible_graduated':sum(r['token'].lower() in grad_tokens for r in eligible),'actual_live_rows':len(c['positions']),'actual_buys_that_graduated':sum(r['token'].lower() in grad_tokens for r in c['positions'] if r['buy_ok'])},'cost_proxy_eth':cost/1e18,'returns_pct':stats([r['return_pct'] for r in rows]),'net_eth':stats([r['net_eth'] for r in rows]),'without_best_net_eth':sum(r['net_eth'] for r in valid)-max(r['net_eth'] for r in valid),'without_best_two_net_eth':sum(sorted(r['net_eth'] for r in valid)[:-2]),'splits':{k:stats([r['return_pct'] for r in rows if r['split']==k]) for k in ['earlier','excluded_latest_3h']},'last24h':bins(24,8),'last7d':bins(168,7),'rows':rows,'husdp_reconciled_net_eth':int(repair['pnl'])/1e18}
(root/'summary.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k not in ['rows','last24h','last7d']},indent=2))
