"""Predeclare coarse and granular exit timers before outcome inspection."""
from itertools import combinations
from .grid_exits import exits

TIMERS={'fixed':('maxHoldMs','deadCoinAfterMs'),'progress':('initialMs','stepMs','capMs'),'inactivity':('idleMs','capMs')}
def signature(p):return tuple(sorted((k,v) for k,v in p.items() if k!='name'))
def valid(p):
 if p['kind']=='fixed':return 10000<=p['maxHoldMs']<=120000 and 0<=p.get('deadCoinAfterMs',20000)<=120000
 if p['kind']=='progress':return 10000<=p['initialMs']<=p['capMs']<=120000 and p['stepMs']>=5000
 return 5000<=p['idleMs']<=p['capMs']<=120000

def catalog():
 coarse=list(exits());values={signature(p):p for p in coarse};links={}
 for p in coarse:
  edits=[(k,p.get(k,20000)+sign*5000) for k in TIMERS[p['kind']] for sign in (-1,1)]
  neighbors=[]
  for change in [*((x,) for x in edits),*combinations(edits,2)]:
   if len(dict(change))!=len(change):continue
   q={**p,**dict(change)}
   if not valid(q):continue
   sig=signature(q)
   if sig not in values:
    q['name']='fine_'+p['kind']+'_'+'_'.join(str(q[k]) for k in sorted(q) if k not in ('kind','name'))
    values[sig]=q
   neighbors.append(values[sig]['name'])
  links[p['name']]=sorted(set(neighbors))
 # One expansion in the max-hold direction is available for coarse boundary finalists.
 for hold in range(10,121,5):
  q=dict(name=f'fixed_{hold}',kind='fixed',maxHoldMs=hold*1000)
  values.setdefault(signature(q),q)
 # Expand only timer-boundary finalists, preserving their other exit settings.
 # Preprice this menu now so training cannot alter the acquisition requirements.
 expansions={}
 for p in list(values.values()):
  timer='maxHoldMs' if p['kind']=='fixed' else 'capMs'
  low=20000 if p['kind']=='fixed' else 60000
  at=p[timer];targets=[]
  if at in (low-5000,low):targets += range(10000,low-5000,5000)
  if at in (90000,95000):targets += range(100000,120001,5000)
  for value in targets:
   q={**p,timer:value}
   if not valid(q):continue
   sig=signature(q)
   if sig not in values:
    q['name']='expanded_'+p['kind']+'_'+'_'.join(str(q[k]) for k in sorted(q) if k not in ('kind','name'))
    values[sig]=q
   expansions.setdefault(p['name'],[]).append(values[sig]['name'])
 return dict(expansions=expansions,policies=list(values.values()),coarse=[p['name'] for p in coarse]+[f'{kind}_window_{n}' for kind in ('market','joint') for n in (20,40,60)],neighbors=links)
