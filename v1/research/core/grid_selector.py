"""Causal hold and joint TP/hold selectors using common complete cohorts."""
import bisect

HOLDS=(20,30,45,60,90)
TARGETS=(1.25,1.36,1.5,1.75,2,2.5,3)

class HoldSelector:
 def __init__(self,rows,keys,window,fallback):
  self.keys,self.window,self.fallback=keys,window,fallback
  self.rows=[]
  for row in rows:
   results=[row['results'].get(k) for k in keys]
   if any(not r or r['status'] not in ('closed','buy_reverted','entry_price_rejected') for r in results):continue
   available=max(row['published'],*(r.get('exitAt',row['entry'])+1 for r in results))
   self.rows.append(dict(row,available=available))
  self.rows.sort(key=lambda r:(r['available'],r['token']))
  self.times=[r['available'] for r in self.rows]
 def select(self,at,fallback=None):
  fallback=fallback or self.fallback
  visible=self.rows[:bisect.bisect_left(self.times,at)]
  selected=sorted(visible,key=lambda r:(r['block'],r['token']),reverse=True)[:self.window]
  if len(selected)<self.window:return fallback,dict(n=len(selected),reason='warmup')
  means={k:sum(int(r['results'][k].get('pnlWei',0))/r['size'] for r in selected)/self.window for k in self.keys}
  best=max(means.values())
  winner=next(k for k in [fallback,*self.keys] if means[k]==best)
  return winner,dict(n=len(selected),reason='highest_preceding_mean',latest=max(r['available'] for r in selected))
