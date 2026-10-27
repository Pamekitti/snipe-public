"""Calendar-day and matched-filter comparisons for the full September experiment."""
import gzip,json,statistics,datetime as dt,hashlib
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'v1/data/research/20260922-market-september-v1'
d=json.load(gzip.open(OUT/'results.json.gz','rt'))
start=d['manifest']['start'];end=d['manifest']['end'];STAKE=.0025
names={'ALL':'All resolved','untaxed_3plus':'Untaxed, ≥3 exemptions','untaxed_0to2':'Untaxed, 0–2 exemptions',
 'untaxed_unknown':'Untaxed, exemptions unknown','tax_001_049':'Tax 0.01–0.49%','tax_05_2':'Tax 0.5–2%','tax_above2':'Tax >2%',
 'taxed_matched':'Tax 0.5–2%, ≥3 exemptions'}
def selected(r):return all(r['scenarios'].get(k,{}).get('status')=='closed' for k in ['6','12'])
def member(r,g):return g=='ALL' or (g=='taxed_matched' and r['group']=='tax_05_2' and r['ex'] is not None and r['ex']>=3) or r['group']==g
def stats(pop,group,lag='6'):
 cohort=[r for r in pop if member(r,group)];good=[r for r in cohort if selected(r)]
 v=[r['scenarios'][lag]['pnlEth'] for r in good];pct=[x/STAKE*100 for x in v]
 return dict(population=len(cohort),n=len(v),netEth=sum(v),meanPct=statistics.mean(pct) if pct else None,
  medianPct=statistics.median(pct) if pct else None,sdPct=statistics.stdev(pct) if len(v)>1 else None,
  winPct=sum(x>0 for x in v)/len(v)*100 if v else None,
  grossGainsEth=sum(max(0,x) for x in v),grossLossesEth=-sum(min(0,x) for x in v))
daily=[]
for i in range(22):
 lo=start+i*86400000;hi=min(end,lo+86400000)
 pop=[r for r in d['rows'] if lo<=r['at']<hi]
 eth=[r for r in pop if r['pair']=='0x'+'0'*40]
 daily.append(dict(date=dt.datetime.fromtimestamp(lo/1000,dt.timezone.utc).date().isoformat(),partial=hi-lo<86400000,
  population=len(pop),ethPopulation=len(eth),resolved=sum(selected(r) for r in pop),
  ethCoveragePct=100*sum(selected(r) for r in eth)/len(eth) if eth else None,
  central={g:stats(pop,g) for g in names},slow={g:stats(pop,g,'12') for g in names}))
periods={}
for label,a,b in [('Sep 1–7',0,7),('Sep 8–14',7,14),('Sep 15–20',14,20),('Sep 21–22 (22nd partial)',20,22),('Sep 1–20',0,20)]:
 pop=[r for r in d['rows'] if start+a*86400000<=r['at']<min(end,start+b*86400000)]
 periods[label]={g:stats(pop,g) for g in names}
verdict={}
for g in names:
 full=[x for x in daily if not x['partial'] and x['central'][g]['n']>=20]
 verdict[g]=dict(positiveDays=sum(x['central'][g]['netEth']>0 for x in full),comparableFullDays=len(full),
  daysWithUnder20Trades=sum(x['central'][g]['n']<20 for x in daily),
  first20=periods['Sep 1–20'][g],recent=periods['Sep 21–22 (22nd partial)'][g])
out=dict(daily=daily,periods=periods,verdict=verdict,names=names,limits='Same independent 45s / 1.36x / 0.0025 ETH rule. Daily grouping by launch time; September 22 partial. Descriptive returns, not causal or prospective proof.')
(OUT/'daily.json').write_text(json.dumps(out,indent=2))

matrix=np.array([[x['central'][g]['meanPct'] if x['central'][g]['n']>=20 else np.nan for x in daily] for g in names])
fig,(ax,coverage)=plt.subplots(2,1,figsize=(19,8.5),gridspec_kw={'height_ratios':[5,1]},sharex=True)
im=ax.imshow(matrix,cmap='RdBu',vmin=-15,vmax=15,aspect='auto')
ax.set_yticks(range(len(names)),list(names.values()));ax.set_title('Daily net return per ETH traded (%) · same fixed policy across September',pad=16,fontsize=16)
for y,g in enumerate(names):
 for x,day in enumerate(daily):
  s=day['central'][g]
  label=f"{s['meanPct']:+.1f}" if s['n']>=20 else 'n<20'
  ax.text(x,y,label,ha='center',va='center',fontsize=8,color='white' if s['n']>=20 and abs(s['meanPct'])>8 else '#202020')
coverage.bar(range(22),[x['ethCoveragePct'] or 0 for x in daily],color='#657c91')
coverage.set_ylim(0,105);coverage.set_ylabel('ETH coverage %');coverage.set_xticks(range(22),[str(i+1)+('*' if i==21 else '') for i in range(22)])
coverage.set_xlabel('September, UTC · *22 September is partial · gray/blank results have fewer than 20 resolved trades')
fig.text(.015,.015,'DIAGNOSTIC ONLY. Coverage counts are observed launches. Creator-tax and exemption groups are not randomized. See the interactive report for n, median, sample SD and missing outcomes.',fontsize=9,color='#8c3326')
fig.subplots_adjust(left=.20,right=.94,top=.91,bottom=.12,hspace=.17)
fig.colorbar(im,ax=[ax,coverage],label='Net return % (display clipped at ±15%)',pad=.015)
fig.savefig(OUT/'daily-returns.png',dpi=160);plt.close(fig)

# Add the daily evidence to the self-contained interactive artifact.
payload=json.dumps(out,separators=(',',':'),allow_nan=False).replace('</','<\\/')
panel='''<div class="panel"><h2>Was September 21–22 unusually bad?</h2><p class="sub">Fixed September 1–22 comparison, independent of the chart-window controls above. Calendar-day net return per ETH traded. The final row compares taxed coins using the same ≥3 exemption requirement as the selected untaxed group. A blank cell means fewer than 20 resolved trades. The 22nd is partial.</p><div id="dailyheat" style="height:470px"></div><h3>Period comparison</h3><div class="tablebox"><table><thead><tr><th>Period</th><th>Group</th><th>n</th><th>Mean %</th><th>Median %</th><th>SD %</th><th>Net ETH</th></tr></thead><tbody id="periodtable"></tbody></table></div></div>'''
script='''<script>const MONTH=__DATA__;
const gs=Object.keys(MONTH.names);Plotly.newPlot('dailyheat',[{type:'heatmap',x:MONTH.daily.map(x=>x.date+(x.partial?' (partial)':'')),y:gs.map(g=>MONTH.names[g]),z:gs.map(g=>MONTH.daily.map(x=>x.central[g].n>=20?x.central[g].meanPct:null)),customdata:gs.map(g=>MONTH.daily.map(x=>[x.central[g].n,x.central[g].medianPct,x.central[g].sdPct,x.ethCoveragePct])),colorscale:'RdBu',zmin:-15,zmax:15,colorbar:{title:'Net %'},hovertemplate:'%{x}<br>%{y}<br>Mean %{z:.2f}% · n=%{customdata[0]}<br>Median %{customdata[1]:.2f}% · SD %{customdata[2]:.2f}%<br>ETH population coverage %{customdata[3]:.1f}%<extra></extra>'}],{margin:{l:210,r:70,t:10,b:90},yaxis:{autorange:'reversed'},xaxis:{tickangle:-45}},{responsive:true,displaylogo:false});
document.getElementById('periodtable').innerHTML=Object.entries(MONTH.periods).map(([period,rows])=>['ALL','untaxed_3plus','tax_05_2','taxed_matched','tax_above2'].map(g=>{const s=rows[g];return '<tr><td>'+period+'</td><td>'+MONTH.names[g]+'</td><td>'+s.n.toLocaleString()+'</td>'+[s.meanPct,s.medianPct,s.sdPct,s.netEth].map(v=>'<td>'+(v==null?'Unavailable':v.toFixed(3))+'</td>').join('')+'</tr>'}).join('')).join('');</script>'''.replace('__DATA__',payload)
page=(OUT/'index.html').read_text();page=page.replace('<details open>',panel+'<details open>',1);page=page.replace('</html>',script+'</html>')
(OUT/'index.html').write_text(page)
hashes={p.name:hashlib.file_digest(open(p,'rb'),'sha256').hexdigest() for p in OUT.iterdir() if p.is_file() and p.name not in ['artifact-hashes.json'] and not p.name.endswith(('-wal','-shm'))}
(OUT/'artifact-hashes.json').write_text(json.dumps(hashes,indent=2))
print(json.dumps(verdict,indent=2))
