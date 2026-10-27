#!/bin/bash
# Extend the fresh window to the chain head, then DEDUP.
#
# pull_more appends trades keyed off fresh_launches.latest, but an earlier repair pull may
# already cover blocks past that mark. load.py does not dedup, so an overlap silently
# double-counts trades and every curve replay comes out wrong. Dedup by (block, logIndex)
# after every pull, and say how many dupes were dropped so an overlap is visible rather
# than quiet.
set -e
cd "$(dirname "$0")"
node pull_more.mjs
python3 - <<'PY'
import json
seen=set(); kept=0; dropped=0
with open('fresh_trades.jsonl') as f, open('fresh_trades.dedup.jsonl','w') as o:
    for line in f:
        d=json.loads(line); k=(d['b'],d['i'])
        if k in seen: dropped+=1; continue
        seen.add(k); o.write(line); kept+=1
import os; os.replace('fresh_trades.dedup.jsonl','fresh_trades.jsonl')
print(f"dedup: kept {kept} rows, dropped {dropped} duplicates")
PY
