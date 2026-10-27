#!/usr/bin/env python3
"""Render ledger figures from sanitized public tables, with distinct accounting bases."""
from pathlib import Path
import csv,json,datetime
from decimal import Decimal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
ROOT=Path(__file__).resolve().parents[1]
rows=list(csv.DictReader((ROOT/'results/tables/daily-ledger.csv').open()))
plt.rcParams.update({'font.size':11,'axes.titlesize':13,'figure.facecolor':'#fafaf8','axes.facecolor':'#fafaf8','axes.spines.top':False,'axes.spines.right':False,'savefig.facecolor':'#fafaf8'})
fig,axes=plt.subplots(2,1,figsize=(11,8),layout='constrained')
for ax,version,title,color in zip(axes,['v1','v2'],['V1: surviving live net booked cash','V2: surviving position deltas, before separate wallet gas'],['#216b87','#a25420']):
 totals={}
 for r in rows:
  if r['version']==version:totals[r['dateUtc']]=totals.get(r['dateUtc'],Decimal(0))+Decimal(r['pnlEth'])
 dates=[];ys=[];cash=Decimal(0)
 for d,n in sorted(totals.items()):
  cash+=n;dates.append(datetime.date.fromisoformat(d));ys.append(float(cash))
 ax.step(dates,ys,where='post',color=color,lw=2.1,label=f'{version.upper()} cumulative daily closes')
 ax.axhline(0,color='#666',lw=.8);ax.set_title(title,loc='left',weight='bold');ax.set_ylabel('Cumulative ETH');ax.grid(axis='y',alpha=.2)
 ax.annotate(f'{cash:+.6f} ETH',(dates[-1],ys[-1]),xytext=(-8,14),textcoords='offset points',ha='right',color=color,weight='bold')
 locator=mdates.AutoDateLocator(minticks=4,maxticks=7);ax.xaxis.set_major_locator(locator);ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(locator))
fig.suptitle('The surviving ledgers include gains and losses',x=.02,ha='left',fontsize=17,weight='bold')
fig.supxlabel('UTC close date. Each panel starts at zero for its own surviving records. Different bases and periods; do not add them.',fontsize=9)
for ext in ['png','svg']:fig.savefig(ROOT/f'results/figures/surviving-ledgers.{ext}',dpi=170)
plt.close(fig)
profile=json.loads((ROOT/'v1/research/SIMULATION_ERROR_PROFILE_20260913.json').read_text())
print('Ledger figures rendered; historical profile keys:',list(profile))
