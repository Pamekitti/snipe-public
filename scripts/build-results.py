#!/usr/bin/env python3
"""Build public tables solely from sanitized, frozen ledger exports. No network calls."""
import csv,json,collections,statistics,datetime,hashlib
from decimal import Decimal
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ETH=Decimal(10)**18
read=lambda name:json.loads((ROOT/'datasets/samples'/name).read_text())
def eth(x):return format(Decimal(x)/ETH,'.18f')
def day(ms):return datetime.datetime.fromtimestamp(ms/1000,datetime.UTC).date().isoformat()
def summarize(values):
 return {'n':len(values),'sumWei':str(sum(values)),'meanEth':str(sum(Decimal(x)/ETH for x in values)/len(values)) if values else None,'medianEth':str(statistics.median([Decimal(x)/ETH for x in values])) if values else None,'sampleSdEth':str(statistics.stdev([Decimal(x)/ETH for x in values])) if len(values)>1 else None,'wins':sum(x>0 for x in values),'losses':sum(x<0 for x in values),'zeros':sum(x==0 for x in values)}
v1=read('v1-closed-positions.json')['positions'];v2=read('v2-closed-positions.json')['positions'];ret=read('retirement-state.json')
groups=collections.defaultdict(list);missing=0
for p in v1:
 if not p['live'] or not p['closed']:continue
 val=p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei']
 if val is None or p['exit_at'] is None:missing+=1;continue
 groups[(day(p['exit_at']),'v1','all')].append(int(val))
for p in v2:
 at=p['abandonedAt'] or p['closedAt'] or p['openedAt']
 groups[(day(at),'v2',p['book'])].append(int(p['proceedsWei'])-int(p['spendWei']))
rows=[]
for (date,version,book),values in sorted(groups.items()):
 s=summarize(values);rows.append({'dateUtc':date,'version':version,'book':book,'basis':'net_booked_cash' if version=='v1' else 'position_delta_excluding_separate_wallet_gas','n':s['n'],'pnlEth':eth(s['sumWei']),'meanEth':s['meanEth'],'medianEth':s['medianEth'],'sampleSdEth':s['sampleSdEth'],'wins':s['wins'],'losses':s['losses'],'zeros':s['zeros']})
with (ROOT/'results/tables/daily-ledger.csv').open('w',newline='') as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
summary={'source':'Sanitized retirement ledger exports, 2026-10-25','v1':summarize([int(p['onchain_pnl_wei'] if p['onchain_pnl_wei'] is not None else p['pnl_wei']) for p in v1 if p['live'] and p['closed'] and (p['onchain_pnl_wei'] is not None or p['pnl_wei'] is not None)]),'v1MissingCashOrTime':missing,'v2PositionDeltaExcludingWalletGas':summarize([int(p['proceedsWei'])-int(p['spendWei']) for p in v2]),'v2Abandonments':sum(p['abandonedAt'] is not None for p in v2),'retirement':{'walletWei':ret['walletWei'],'openPositions':ret['openN'],'recordedRisk':ret['recordedRisk']},'warning':'V1 and V2 use different accounting bases and periods. Do not add these totals or label position deltas as wallet profit. Recorded risk is an accounting epoch, not lifetime cash.'}
(ROOT/'results/tables/ledger-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
manifest={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/'datasets/samples').glob('*.json'))}
(ROOT/'datasets/manifests/public-inputs.json').write_text(json.dumps({'schema':1,'sha256':manifest},indent=2)+'\n')
print(json.dumps({'v1CashRows':summary['v1']['n'],'v2PositionRows':len(v2),'v1MissingCashOrTime':missing,'dailyRows':len(rows)}))
