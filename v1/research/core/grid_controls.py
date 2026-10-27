"""Common operator controls and an independent recorded-stop stress overlay."""
import json
from dataclasses import replace
from .long_history import external_controls

def experiment_controls(raw, recorded=False):
    controls=[(at,v) for at,v in external_controls(raw) if not isinstance(v,dict)]
    # Health records include HALT=1 transitions before guard_samples existed.
    # A later armed/other-kind reading also records that the manual stop cleared.
    manual=[]
    for h in raw.get('bot_health',[]):
        if h['component']=='halt' and (h['detail']=='armed' or h['detail'].startswith('[')):
            manual.append((h['at'],h['detail'].startswith('[manual]')))
    for row in raw.get('bot_guard_samples',[]):
        if row.get('live'):
            value=row.get('halts') or []
            manual.append((row['at'],'manual' in (json.loads(value) if isinstance(value,str) else value)))
    previous=False
    for at,active in sorted(manual):
        if active!=previous:controls.append((at,dict(halt='manual',active=active)))
        previous=active
    if recorded:
        previous=set()
        for row in sorted(raw.get('bot_guard_samples',[]),key=lambda r:r['at']):
            if not row.get('live'):continue
            value=row.get('halts') or []
            kinds=set(json.loads(value) if isinstance(value,str) else value)-{'venue'}
            for kind in sorted(kinds ^ previous):
                controls.append((row['at'],dict(force_halt=kind,active=kind in kinds)))
            previous=kinds
    return sorted(controls,key=lambda x:x[0])

def interval_controls(controls,start):
    """Carry external stop state through coverage gaps without carrying invented cash."""
    seed={};operator=None
    for at,value in controls:
        if at>=start:break
        if isinstance(value,dict):
            key=('force_halt' if 'force_halt' in value else 'halt',value.get('force_halt',value.get('halt')))
            if value.get('active',True):seed[key]=value
            else:seed.pop(key,None)
        elif value in ('stop','resume','legacy_start'):operator=value
    initial=[(start,v) for v in seed.values()]
    if operator=='stop':initial.append((start,'stop'))
    return initial+[(at,value) for at,value in controls if at>=start]

def opportunity_policy(base,count):
    return replace(base,name='unrestricted_opportunities',market_enabled=False,
                   account_pauses_enabled=False,touch_enabled=False,
                   max_concurrent=max(1,count),bankroll_wei=base.size_wei*max(1,count),
                   template_loss_ms=0)
