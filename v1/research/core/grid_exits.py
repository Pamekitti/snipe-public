"""Frozen exit descriptors for the September research grid."""
from itertools import product

def exits():
 for hold in (20,30,45,60,90):
  yield dict(name=f'fixed_{hold}',kind='fixed',maxHoldMs=hold*1000)
 for hold,dead in product((20,30,45,60,90),(10,30,0)):
  yield dict(name=f'fixed_{hold}_dead_{dead}',kind='fixed',maxHoldMs=hold*1000,deadCoinAfterMs=dead*1000)
 for initial,step,improvement,cap in product((20,30),(15,30),(300,500),(60,90)):
  yield dict(name=f'progress_{initial}_{step}_{improvement}_{cap}',kind='progress',initialMs=initial*1000,stepMs=step*1000,improvementBps=improvement,capMs=cap*1000)
 for idle,improvement,cap in product((10,20,30),(300,500),(60,90)):
  yield dict(name=f'inactivity_{idle}_{improvement}_{cap}',kind='inactivity',idleMs=idle*1000,improvementBps=improvement,capMs=cap*1000)

def variant(policy,rules):
 changed=dict(rules)
 if policy['kind']=='fixed':
  changed['maxHoldMs']=policy['maxHoldMs']
  if 'deadCoinAfterMs' in policy:changed['deadCoinAfterMs']=policy['deadCoinAfterMs']
  return dict(rules=changed)
 changed['maxHoldMs']=policy['capMs']
 return dict(rules=changed,exitPolicy=policy)
