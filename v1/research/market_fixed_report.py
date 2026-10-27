"""Render the frozen fixed-policy experiment, with explicit unresolved populations."""
import collections
import datetime as dt
import gzip
import hashlib
import html
import json
from pathlib import Path
import statistics
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
from plotly.offline import get_plotlyjs

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT / "v1/data/research/20260922-market-fixed-v1"
doc = json.load(gzip.open(OUT / "results.json.gz", "rt"))
rows = doc["rows"]
end = doc["manifest"]["end"]
first = doc["manifest"]["first"]
WINDOWS = (1, 7, 22) if doc["manifest"].get("start") == 1788220800000 else (1, 7)
STAKE = .0025
COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#6A51A3", "#666666", "#56B4E9", "#999999"]
LABELS = {
    "untaxed_3plus": "Untaxed · ≥3 exemptions", "untaxed_0to2": "Untaxed · 0–2 exemptions",
    "untaxed_unknown": "Untaxed · exemptions unknown", "tax_001_049": "Tax 0.01–0.49%",
    "tax_05_2": "Tax 0.5–2%", "tax_above2": "Tax >2%", "noneth": "Non-ETH pair",
    "unknown_tax": "Tax unknown", "ALL": "All resolved coins",
}
GROUPS = list(LABELS)[:6]
DIMENSIONS = {
    "overview": "Market groups", "tax": "Finer tax bands", "exemptions": "Exempt-wallet count",
    "devbuy": "Creator initial buy", "liquidity": "Entry liquidity", "time": "Launch hour (UTC)",
}
if 22 in WINDOWS:
    DIMENSIONS["matched"] = "Tax bands with the same ≥3 exemption filter"
SCENARIOS = {"central": ("6", "pnlEth", "600 ms exit"), "slow": ("12", "pnlEth", "1,200 ms exit"),
             "raw": ("6", "rawPnlEth", "600 ms, without residual tuning"),
             "gas": ("6", "doubleGasPnlEth", "600 ms, double gas")}


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def eligible(r):
    return all(r["scenarios"].get(k, {}).get("status") == "closed" for k in ("6", "12"))


def category(r, dimension):
    if dimension == "overview": return r["group"]
    if dimension == "matched":
        if r["pair"] != "0x" + "0" * 40: return "Non-ETH pair"
        if r["ex"] is None: return "Exemptions unknown"
        if r["ex"] < 3: return "0–2 exemptions, all tax bands"
        t = r["tax"]
        if t is None or t < 0: return "Tax unknown, ≥3 exemptions"
        return ("Untaxed" if t == 0 else "Tax 0.01–0.49%" if t < 50 else "Tax 0.5–2%" if t <= 200 else "Tax >2%") + " · ≥3 exemptions"
    if dimension == "tax":
        t = r["tax"]
        if t is None or t < 0: return "Unknown"
        for ceiling, label in [(0, "0%"), (49, "0.01–0.49%"), (99, "0.5–0.99%"), (200, "1–2%"),
                               (500, ">2–5%"), (1000, ">5–10%")]:
            if t <= ceiling: return label
        return ">10%"
    if dimension == "exemptions":
        x = r["ex"]
        return "Unknown" if x is None else "0" if x == 0 else "1–2" if x < 3 else "3–5" if x < 6 else "6+"
    if dimension == "devbuy":
        v = r.get("devEth")
        return "Unknown" if v is None else "0 ETH" if v == 0 else "(0, 0.01] ETH" if v <= .01 else "(0.01, 0.05] ETH" if v <= .05 else ">0.05 ETH"
    if dimension == "liquidity":
        v = r.get("entryLiquidityEth")
        return "Unknown" if v is None else "<0.01 ETH" if v < .01 else "0.01–0.05 ETH" if v < .05 else "0.05–0.2 ETH" if v < .2 else "≥0.2 ETH"
    hour = dt.datetime.fromtimestamp(r["at"] / 1000, dt.timezone.utc).hour
    return ["00–06 UTC", "06–12 UTC", "12–18 UTC", "18–24 UTC"][hour // 6]


def stats(population, selected, scenario, total_gains, total_losses, total_population):
    lag, field, _ = SCENARIOS[scenario]
    a = [r["scenarios"][lag][field] for r in selected]
    ret = [v / STAKE * 100 for v in a]
    gains = sum(v for v in a if v > 0)
    losses = -sum(v for v in a if v < 0)
    return dict(population=len(population), populationPct=100 * len(population) / total_population if total_population else 0,
        n=len(a), capitalEth=STAKE * len(a), gainsEth=gains, lossesEth=losses, netEth=sum(a),
        gainShare=100 * gains / total_gains if total_gains else 0, lossShare=100 * losses / total_losses if total_losses else 0,
        returnPct=100 * sum(a) / (STAKE * len(a)) if a else None,
        medianPct=statistics.median(ret) if ret else None, sdPct=statistics.stdev(ret) if len(ret) > 1 else None,
        winPct=100 * sum(v > 0 for v in a) / len(a) if a else None)


def chart_series(selected, key, dimension, scenario, start, step, count):
    lag, field, _ = SCENARIOS[scenario]
    chosen = selected if key == "ALL" else [r for r in selected if category(r, dimension) == key]
    cash = np.zeros(count)
    n = np.zeros(count, dtype=int)
    for r in chosen:
        s = r["scenarios"][lag]
        i = min(count-1, max(0, int((s["exitAt"] - start) // step)))
        cash[i] += s[field]; n[i] += 1
    cum = np.cumsum(cash)
    cn = np.cumsum(n)
    lookback = max(1, 3 * 3600000 // step)
    rolling, ns = [], []
    for i in range(count):
        prior = i - lookback
        pnl = cum[i] - (cum[prior] if prior >= 0 else 0)
        nr = int(cn[i] - (cn[prior] if prior >= 0 else 0))
        rolling.append(100 * pnl / (nr * STAKE) if nr >= 20 else None)
        ns.append(nr)
    return dict(key=key, name=LABELS.get(key, key), cum=[round(float(v), 9) for v in cum], rolling=rolling, n=ns)


frames = {}
summaries = {}
for days in WINDOWS:
    start = doc["manifest"]["start"] if days == 22 else end - days * 86400000
    duration = end - start
    population = [r for r in rows if start <= r["at"] <= end]
    selected = [r for r in population if eligible(r)]
    summaries[str(days)] = dict(start=iso(start), end=iso(end), population=len(population), resolved=len(selected),
        coveragePct=100 * len(selected) / len(population),
        unavailable=dict(collections.Counter(r["reason"] if r["status"] != "closed" else "slow_scenario_unavailable" for r in population if not eligible(r))),
        scenarios={})
    for scenario, (lag, field, title) in SCENARIOS.items():
        gains = sum(max(0, r["scenarios"][lag][field]) for r in selected)
        losses = -sum(min(0, r["scenarios"][lag][field]) for r in selected)
        total = stats(population, selected, scenario, gains, losses, len(population))
        summaries[str(days)]["scenarios"][scenario] = total
        for dimension in DIMENSIONS:
            keys = GROUPS + ["noneth", "unknown_tax"] if dimension == "overview" else sorted(set(category(r, dimension) for r in population))
            table = []
            for key in keys:
                p = [r for r in population if category(r, dimension) == key]
                s = [r for r in selected if category(r, dimension) == key]
                if p:
                    table.append(dict(key=key, name=LABELS.get(key, key), **stats(p, s, scenario, gains, losses, len(population))))
            assert sum(t["population"] for t in table) == len(population)
            assert sum(t["n"] for t in table) == len(selected)
            assert abs(sum(t["netEth"] for t in table) - total["netEth"]) < 1e-10
            step = 5 * 60000 if days == 1 else 30 * 60000 if days == 7 else 3600000
            count = duration // step + 1
            times = [iso(min(end, start + (i+1)*step)) for i in range(count)]
            active_keys = [t["key"] for t in table if t["n"]]
            series = [chart_series(selected, key, dimension, scenario, start, step, count) for key in ["ALL"] + active_keys]
            for i in range(count):
                assert abs(series[0]["cum"][i] - sum(s["cum"][i] for s in series[1:])) < 1e-7
            # Preserve the unsupported prefix as a gap, not a zero-return period.
            for s in series:
                for i, x in enumerate(times):
                    if start + (i+1)*step < first:
                        s["cum"][i] = None; s["rolling"][i] = None
            # Population is attributed at launch time, separately from P&L at close time.
            nbins = 8 if days == 1 else 7 if days == 7 else 22
            pop_bins = []
            for i in range(nbins):
                lo = start + i * duration // nbins if days != 22 else start + i * 86400000
                hi = start + (i+1) * duration // nbins if days != 22 else min(end,lo + 86400000)
                rs = [r for r in population if lo <= r["at"] < hi]
                c = collections.Counter(category(r, dimension) for r in rs)
                pop_bins.append(dict(at=iso(lo), end=iso(hi), n=len(rs), counts=dict(c)))
            frames[f"{days}:{dimension}:{scenario}"] = dict(times=times, series=series, table=table, total=total,
                populationBins=pop_bins, start=iso(start), end=iso(end), scenario=title)

# Coin-level returns and metadata remain available to reproduce every plotted total.
assert len({r["token"] for r in rows}) == len(rows)
checks = dict(uniqueTokens=True,groupsSumToPopulation=True,groupCashSumsToTotal=True,
    everyPlottedPointReconciles=True,sharedCohortAcrossScenarios=True,unknownOutcomesNotZero=True,
    cashFidelityPassed=False,sourceReadOnly=True,liveChanged=False)
(OUT / "summary.json").write_text(json.dumps(dict(windows=summaries,checks=checks),indent=2))

plt.rcParams.update({"font.size":10,"axes.spines.top":False,"axes.spines.right":False,"axes.grid":True,"grid.alpha":.17})
for days in WINDOWS:
    frame = frames[f"{days}:overview:central"]
    fig, axes = plt.subplots(2,1,figsize=(15,10),sharex=True,gridspec_kw={"height_ratios":[1.15,1]})
    xs=[dt.datetime.fromisoformat(x) for x in frame["times"]]
    for i,s in enumerate(frame["series"]):
        color="#17202A" if i==0 else COLORS[(i-1)%len(COLORS)]
        style="-" if i<4 else "--" if i<6 else ":"
        axes[0].plot(xs,s["cum"],label=s["name"],color=color,lw=2.5 if i==0 else 1.6,ls=style)
        axes[1].plot(xs,s["rolling"],label=s["name"],color=color,lw=2.5 if i==0 else 1.6,ls=style)
    for ax in axes:
        ax.axhline(0,color="#555",lw=.7)
        plot_start=dt.datetime.fromisoformat(frame['start'])
        if plot_start.timestamp()*1000<first:
            ax.axvspan(plot_start,dt.datetime.fromtimestamp(first/1000,dt.timezone.utc),color="#ccc",alpha=.4)
    axes[0].set_ylabel("Cumulative net P&L (ETH)")
    axes[0].legend(ncol=3,loc="upper center",bbox_to_anchor=(.5,1.23),frameon=False,fontsize=9)
    axes[1].set_ylabel("Trailing 3h net return (%)\nper ETH traded; minimum 20 trades")
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%d Sep\n%H:%M",tz=dt.timezone.utc))
    axes[1].set_xlabel("UTC · P&L booked at modeled exit · same completed cohort in both delay scenarios")
    total=frame["total"]
    title = "September 1–22" if days == 22 else f"{days}-day window"
    fig.suptitle(f"Fixed 45s / 1.36× TP: {title}\n0.0025 ETH per coin · {total['n']:,} resolved trades · {total['netEth']:+.4f} ETH modeled net",fontsize=16,y=.99)
    footer = "DIAGNOSTIC ONLY · Cash fidelity unvalidated · Non-ETH and unresolved outcomes excluded, not zero.\nNo guard, hard stop, dead-coin exit or price cap. Some curves cannot be simulated through graduation."
    if days != 22: footer += " Gray prefix: price paths unavailable."
    fig.text(.02,.015,footer,fontsize=9,color="#8c3326")
    fig.subplots_adjust(top=.80,bottom=.11,hspace=.14)
    fig.savefig(OUT/f"overview-{days}d.png",dpi=160)
    plt.close(fig)

fig, axes=plt.subplots(3,2,figsize=(16,15))
for ax,dim in zip(axes.flat,list(DIMENSIONS)):
    frame=frames[f"1:{dim}:central"]
    xs=[dt.datetime.fromisoformat(x) for x in frame["times"]]
    for i,s in enumerate(frame["series"]):
        ax.plot(xs,s["cum"],label=s["name"],color="#17202A" if i==0 else COLORS[(i-1)%len(COLORS)],lw=2 if i==0 else 1.3,ls="-" if i<4 else "--")
    ax.set_title(DIMENSIONS[dim]);ax.axhline(0,color="#555",lw=.6)
    ax.set_ylabel("Net ETH");ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M",tz=dt.timezone.utc))
    ax.legend(fontsize=7,ncol=2,frameon=False)
fig.suptitle("24-hour subgroup views · Same fixed policy and resolved trades\nDiagnostic: population differences are not controlled causal effects",fontsize=16)
fig.tight_layout(rect=[0,.03,1,.94]);fig.savefig(OUT/"drilldowns-24h.png",dpi=150);plt.close(fig)

payload=json.dumps(dict(frames=frames,summary=summaries,checks=checks,first=iso(first),end=iso(end),colors=COLORS,dimensions=DIMENSIONS),separators=(",",":"),allow_nan=False).replace("</","<\\/")
page=r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Where the fixed policy makes and loses money</title>
<style>body{margin:0;background:#f5f7fa;color:#18212f;font:15px system-ui,sans-serif}main{max-width:1460px;margin:auto;padding:28px}h1{font-size:30px;margin-bottom:8px}p{line-height:1.55;max-width:1100px}.notice{border-left:4px solid #bc6312;background:#fff4df;padding:14px 18px}.controls{display:flex;gap:16px;flex-wrap:wrap;margin:22px 0}label{font-weight:650}select{display:block;padding:10px;margin-top:6px;border:1px solid #c4cbd4;border-radius:6px;font:inherit;background:white}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card,.panel{background:#fff;border:1px solid #e0e5ec;border-radius:10px;padding:18px;margin:12px 0}.value{font-size:27px;font-weight:700;margin-top:6px}.sub{font-size:12px;color:#586577}.plot{height:510px}.compact{height:310px}.tablebox{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:12px}th,td{text-align:right;padding:10px;border-bottom:1px solid #e2e6eb}th:first-child,td:first-child{text-align:left}th{background:#f1f4f8}tr.unknown{color:#697581}a{color:#006ca8}details{margin:16px 0}summary{cursor:pointer;font-weight:650}.positive{color:#00745a}.negative{color:#a13223}@media(max-width:700px){main{padding:14px}.cards{grid-template-columns:repeat(2,1fr)}.plot{height:600px}h1{font-size:25px}}</style>
<main><h1>Where the fixed policy makes and loses money</h1><p id="asof"></p>
<div class="notice"><b>Diagnostic simulation, not a wallet forecast.</b> The curves sum only resolved hypothetical trades. Missing outcomes remain unavailable. This experiment has no passing cash-fidelity certificate.</div>
<p><b>One rule for every modeled coin:</b> 0.0025 ETH entry at launch + 2 seconds; exit at 1.36× the entry liquidation mark or after 45 seconds. No hard stop, dead-coin exit, market guard, exemption filter, tax filter, template block or entry-price cap. Each trade is simulated independently, with no wallet capacity limit.</p>
<div class="controls"><label>Window<select id="window"><option value="1">Last 24 hours</option><option value="7">Last 7 days (partial path coverage)</option></select></label><label>Group by<select id="dimension"></select></label><label>Execution scenario<select id="scenario"><option value="central">600 ms exit + frozen residual tuning</option><option value="slow">1,200 ms exit + frozen residual tuning</option><option value="raw">600 ms exit, untuned</option><option value="gas">600 ms exit, double gas</option></select></label></div>
<div class="cards" id="cards"></div><div class="panel"><h2>Cumulative net P&L</h2><p class="sub">Click a legend label to hide a line; double-click to isolate it. All resolved coins is the exact sum of the subgroup lines. Any gray shading marks periods without usable price paths.</p><div id="pnl" class="plot"></div></div>
<div class="panel"><h2>Return per ETH traded, trailing three hours</h2><p class="sub">Controls for the number of trades. Line gaps mean fewer than 20 completed trades, not zero return. Hover shows the sample size.</p><div id="roi" class="plot"></div></div>
<div class="panel"><h2>Share of the observed launch population</h2><p class="sub">Includes unresolved and non-ETH launches. These percentages are coin counts, not profit shares. Liquidity is only known for modeled paths; its unknown group is therefore large.</p><div id="population" class="compact"></div></div>
<div class="panel"><h2>Contribution table</h2><p class="sub">Population % uses all observed launches. Gains % and losses % use total positive and total negative simulated cash separately. Mean, median and sample SD are net returns on the 0.0025 ETH stake. Small samples are descriptive only.</p><div class="tablebox"><table><thead><tr><th>Group</th><th>Population</th><th>Pop. %</th><th>Resolved n</th><th>ETH traded</th><th>Gains ETH</th><th>Gains %</th><th>Losses ETH</th><th>Losses %</th><th>Net ETH</th><th>Mean %</th><th>Median %</th><th>SD %</th><th>Win %</th></tr></thead><tbody id="table"></tbody></table></div></div>
<details open><summary>Coverage and assumptions</summary><p id="coverage"></p><ul><li>The seven-day window includes legacy launch counts, but its early price paths are unavailable. No P&L is invented for that prefix.</li><li>Only standard ETH curves supported by the current V2 simulator are modeled. Non-ETH pairs require their own quote currency valuation.</li><li>A graduation-approach exit is deliberately disabled. A required post-graduation pool exit stays unavailable.</li><li>Poll interval is 1.2 seconds. Production replay uses 10 blocks per second. Historical orders remain fixed; reactions to our hypothetical orders are unknown.</li><li>Taxes, curve fees, modeled gas and the existing pooled return calibration are included. Buy and approval gas use declared fallback estimates when no preceding receipt sample exists; sell gas uses preceding receipts. Double-gas is a stress, not a confidence bound.</li><li>Subgroup comparisons are exploratory. Exemptions, tax, creator buys and liquidity are correlated; no policy was optimized or selected from these charts.</li><li>Entry liquidity is the modeled real ETH reserve after our entry, excluding phantom reserve. It is not the market capitalization.</li></ul></details>
<p><a href="overview-1d.png">24-hour chart PNG</a> · <a href="overview-7d.png">Seven-day chart PNG</a> · <a href="drilldowns-24h.png">All subgroup charts PNG</a> · <a href="summary.json">Results JSON</a> · <a href="methodology.md">Methodology</a></p></main>
<script>__PLOTLY__</script><script>const D=__DATA__;
const el=id=>document.getElementById(id),fmt=(v,d=2)=>v==null?'Unavailable':Number(v).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
el('asof').textContent='Frozen through '+new Date(D.end).toISOString().replace('T',' ').slice(0,19)+' UTC. Research only; live trading unchanged.';
for(const [k,v] of Object.entries(D.dimensions)){const o=document.createElement('option');o.value=k;o.textContent=v;el('dimension').appendChild(o)}
function draw(){const w=el('window').value,dim=el('dimension').value,scenario=el('scenario').value,F=D.frames[w+':'+dim+':'+scenario],T=F.total,S=D.summary[w];
el('cards').innerHTML=[['Observed launches',fmt(T.population,0),'All recorded pairs and statuses'],['Resolved common cohort',fmt(T.n,0),fmt(T.n/T.population*100,1)+'% of population'],['Modeled net P&L',fmt(T.netEth,4)+' ETH',F.scenario],['Net / ETH traded',fmt(T.returnPct,2)+'%',fmt(T.capitalEth,3)+' ETH turnover']].map(x=>'<div class="card"><div>'+x[0]+'</div><div class="value">'+x[1]+'</div><div class="sub">'+x[2]+'</div></div>').join('');
const shape=new Date(F.start)<new Date(D.first)?[{type:'rect',xref:'x',yref:'paper',x0:F.start,x1:D.first,y0:0,y1:1,fillcolor:'#d3d7dd',opacity:.35,line:{width:0},layer:'below'}]:[];
const layout={margin:{l:70,r:25,t:80,b:65},paper_bgcolor:'white',plot_bgcolor:'white',hovermode:'x unified',legend:{orientation:'h',y:1.2,x:0,font:{size:11}},xaxis:{title:'UTC',range:[F.start,F.end],gridcolor:'#eef1f5'},yaxis:{gridcolor:'#eef1f5',zerolinecolor:'#717c8c'},shapes:shape};
const traces=F.series.map((s,i)=>({x:F.times,y:s.cum,type:'scatter',mode:'lines',name:s.name,connectgaps:false,line:{color:i===0?'#17202A':D.colors[(i-1)%D.colors.length],width:i===0?3:1.8,dash:i<4?'solid':i<6?'dash':'dot'},hovertemplate:'%{y:.5f} ETH<extra>%{fullData.name}</extra>'}));
Plotly.react('pnl',traces,{...layout,yaxis:{...layout.yaxis,title:'Resolved net P&L (ETH)'}},{responsive:true,displaylogo:false});
Plotly.react('roi',traces.map((t,i)=>({...t,y:F.series[i].rolling,customdata:F.series[i].n,hovertemplate:'%{y:.2f}% · n=%{customdata}<extra>%{fullData.name}</extra>'})),{...layout,yaxis:{...layout.yaxis,title:'Trailing 3h net return (%)'}},{responsive:true,displaylogo:false});
const pt=F.table.map((s,i)=>({name:s.name,x:F.populationBins.map(b=>b.at),y:F.populationBins.map(b=>b.n?100*(b.counts[s.key]||0)/b.n:0),customdata:F.populationBins.map(b=>[b.counts[s.key]||0,b.n]),type:'bar',marker:{color:D.colors[i%D.colors.length]},hovertemplate:'%{y:.1f}% · %{customdata[0]} / %{customdata[1]} coins<extra>%{fullData.name}</extra>'}));
Plotly.react('population',pt,{...layout,shapes:[],barmode:'stack',yaxis:{title:'Share of launches (%)',range:[0,100]},margin:{l:65,r:20,t:80,b:50}},{responsive:true,displaylogo:false});
el('table').innerHTML=F.table.map(r=>'<tr class="'+(r.n?'':'unknown')+'"><td>'+r.name+'</td>'+[fmt(r.population,0),fmt(r.populationPct,1),fmt(r.n,0),fmt(r.capitalEth,3),r.n?fmt(r.gainsEth,4):'Unavailable',r.n?fmt(r.gainShare,1):'n/a',r.n?fmt(r.lossesEth,4):'Unavailable',r.n?fmt(r.lossShare,1):'n/a',r.n?fmt(r.netEth,4):'Unavailable',fmt(r.returnPct),fmt(r.medianPct),fmt(r.sdPct),fmt(r.winPct,1)].map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('');
el('coverage').textContent='Unresolved/excluded launch counts: '+Object.entries(S.unavailable).map(([k,v])=>k.replaceAll('_',' ')+': '+fmt(v,0)).join('; ')+'. Both delay scenarios use the same completed coins. These curves are independent opportunity sums, not a capital-constrained executable wallet.';
}for(const id of ['window','dimension','scenario'])el(id).addEventListener('change',draw);draw();</script></html>'''
page=page.replace('__PLOTLY__',get_plotlyjs()).replace('__DATA__',payload)
if 22 in WINDOWS:
    page=page.replace('<option value="1">Last 24 hours</option>', '<option value="22" selected>September 1–22</option><option value="1">Last 24 hours</option>')
    page=page.replace('Last 7 days (partial path coverage)', 'Last 7 days')
    page=page.replace('The seven-day window includes legacy launch counts, but its early price paths are unavailable. No P&L is invented for that prefix.', 'Earlier paths were rebuilt from archived evidence and fresh historical RPC queries. Unsupported outcomes remain excluded and counted. September 22 ends at the frozen cutoff, so it is a partial day.')
    page=page.replace('Only standard ETH curves supported by the current V2 simulator are modeled.', 'Only standard ETH curves supported by the current V2 simulator are modeled. Where old immutable parameters are absent, the factory-standard model is checked against the first buy; this remains an explicit modeling assumption.')
    page=page.replace('<a href="overview-1d.png">24-hour chart PNG</a>', '<a href="overview-22d.png">September chart PNG</a> · <a href="daily-returns.png">Daily return heatmap</a> · <a href="overview-1d.png">24-hour chart PNG</a>')
(OUT/"index.html").write_text(page)
report=["# Fixed-policy market experiment", "", "Diagnostic only. No current cash-fidelity certificate binds this source and policy.", "",
    f"Frozen UTC end: {iso(end)}. V2 evidence begins {iso(first)}.",
    "", "Policy: 0.0025 ETH per coin, entry at launch +20 modeled blocks, 1.36x entry-liquidation-mark TP, 450-block hold, 12-block polling, 6/12-block exit delays. No other policy exits or entry filters. Unsupported executions remain unavailable.",
    "", "The existing V2 float simulator is reused without production edits. Curve taxes, own price impact and the frozen pooled return residual are included. This is not a new exact-integer execution or actual-wallet fidelity certificate.",
    "", "Every displayed comparison uses the intersection of the two delays' resolved cohorts. P&L is booked at exit. Groups sum to the total at every plotted sample. Mean, median and sample SD use net percentage of entry stake. Population share uses all launches, including excluded and unresolved rows.",
    "", "The whole-window curve omits unresolved cash and assumes independently funded entries, so it is not an executable wallet or a complete-market return. Dark-gray missing-prefix shading is not zero performance.",
    "", "Gas is the median of up to 100 successful prior receipts per leg when at least 20 exist. The final six hours cannot contribute samples. Buy/approval samples are absent in this source; estimates are 2 and 1 microETH. Early sell fallback is 1.6 microETH. Double gas is included as sensitivity.",
    "", "The tape records global confirmed topics but omits empty successful poll coverage. Gaps exceeding 600 blocks are conservatively excluded. Completeness is not independently certified. Legacy pre-V2 outcomes, non-ETH pairs, unavailable entries, immature tails and required pool exits remain named exclusions.",
    "", "The last six hours are an already-viewed retrospective check, not a pristine holdout. No bins or policy parameters were selected to maximize these results.", "", "## Results"]
for days,s in summaries.items():
    report += ["",f"### {days}-day window", "",f"Observed population {s['population']:,}; common resolved cohort {s['resolved']:,}.", "",
        "| Scenario | Net ETH | Mean return % | Median % | SD % | n |", "|---|---:|---:|---:|---:|---:|"]
    for sc,a in s["scenarios"].items():
        report.append(f"| {SCENARIOS[sc][2]} | {a['netEth']:+.6f} | {a['returnPct']:.3f} | {a['medianPct']:.3f} | {a['sdPct']:.3f} | {a['n']} |")
    report += ["", "Excluded/unresolved: " + json.dumps(s["unavailable"])]
report += ["", "## Reproduce", "", "Run from the repository root:", "", "```sh", "node --max-old-space-size=4096 v2/node_modules/tsx/dist/cli.mjs v1/research/market_fixed_run.ts", "python3 v1/research/market_fixed_report.py", "```", "",
    "The capture is immutable and hashed in manifest.json. Re-capturing requires a fresh output directory. Production code, controls, deployment and sizes are unchanged."]
(OUT/"methodology.md").write_text("\n".join(report)+"\n")
if 22 in WINDOWS:
    text=(OUT/'methodology.md').read_text().replace('node --max-old-space-size=4096 v2/node_modules/tsx/dist/cli.mjs v1/research/market_fixed_run.ts','node --max-old-space-size=4096 v2/node_modules/tsx/dist/cli.mjs v1/research/market_september_run.ts').replace('python3 v1/research/market_fixed_report.py','python3 v1/research/market_fixed_report.py v1/data/research/20260922-market-september-v1')
    text=text.replace('Legacy pre-V2 outcomes, non-ETH pairs, unavailable entries, immature tails and required pool exits remain named exclusions.', 'Historical paths were recovered where possible; non-ETH pairs, unavailable entries, missing economics, immature tails and required pool exits remain named exclusions.')
    text += '\nHistorical paths were recovered from the original unfiltered launch denominator. Creator tax missing from metadata is inferred only where the integer fee equations uniquely identify its basis-point value. When all immutable parameters are missing, the shared factory model must match the first buy output within one token wei. This is a limited economic check, not complete independent parameter verification.\n'
    (OUT/'methodology.md').write_text(text)
(OUT/'contribution-tables.json').write_text(json.dumps({k:v['table'] for k,v in frames.items()},separators=(',',':')))
hashes={p.name:hashlib.file_digest(open(p,"rb"),"sha256").hexdigest() for p in OUT.iterdir() if p.is_file() and p.name!="artifact-hashes.json"}
(OUT/"artifact-hashes.json").write_text(json.dumps(hashes,indent=2))
print(json.dumps(dict(windows=summaries,checks=checks),indent=2))
