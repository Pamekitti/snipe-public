import json, collections, math, os
# DATASET=fresh switches to the forward window pulled after the research was tuned
# (data/fresh_*.json + fresh_trades.jsonl); default is the original 13-day pull.
FRESH = os.environ.get('DATASET') == 'fresh'
if FRESH:
    L=json.load(open('fresh_launches.json')); launches=L['launches']; latest=L['latest']
    states={s['token']:s for s in json.load(open('fresh_states.json'))}
    anchors={int(k):v for k,v in json.load(open('fresh_anchors.json')).items()}
    _trades_file='../fresh_trades.jsonl'; _bb_file='fresh_buybacks.json'
else:
    L=json.load(open('v2_launches.json')); launches=L['launches']; latest=L['latest']
    states={s['token']:s for s in json.load(open('states.json'))}
    anchors={int(k):v for k,v in json.load(open('anchors.json')).items()}
    _trades_file='trades.jsonl'; _bb_file='buybacks.json'
ak=sorted(anchors)
def ts_of(b):
    # linear interpolate
    import bisect
    i=bisect.bisect_right(ak,b)-1
    if i<0: i=0
    if i>=len(ak)-1: i=len(ak)-2
    b0,b1=ak[i],ak[i+1]; t0,t1=anchors[b0],anchors[b1]
    return t0+(b-b0)*(t1-t0)/(b1-b0)
curve2launch={l['curve'].lower():l for l in launches}
trades=collections.defaultdict(list)
n=0
with open(_trades_file) as f:
    for line in f:
        d=json.loads(line); n+=1
        trades[d['a']].append(d)
for a in trades: trades[a].sort(key=lambda d:(d['b'],d['i']))
bb=collections.defaultdict(list)
if os.path.exists(_bb_file):
    for x in json.load(open(_bb_file)): bb[x['a']].append(x)
ETH0='0x0000000000000000000000000000000000000000'
def h(x): return int(x,16)
