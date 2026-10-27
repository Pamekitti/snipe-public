"""Freeze local evidence plus a read-only remote increment for the market experiment."""
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "v1/data/research/20260922-market-fixed-v1"
OUT.mkdir(exist_ok=False)
SOURCE = ROOT / "v1/data/research/20260921-adaptive-size-v1/source/tape-through-20260921.db"
REMOTE = r'''
import gzip,json,sqlite3,sys,time,os
os.nice(10)
d=sqlite3.connect("file:/srv/snipe-v2/data/tape.db?mode=ro",uri=True)
end=d.execute("select seq,at from events order by seq desc limit 1").fetchone()
first=d.execute("select at from events order by seq limit 1").fetchone()[0]
z=gzip.GzipFile(fileobj=sys.stdout.buffer,mode="wb",compresslevel=1)
def emit(obj): z.write((json.dumps(obj,separators=(",",":"))+"\n").encode())
emit(dict(header=dict(maxseq=end[0],end=end[1],first=first)))
cursor=int(sys.argv[1])
while cursor<end[0]:
 stop=min(cursor+50000,end[0])
 rows=d.execute("select seq,at,kind,body from events where seq>? and seq<=? and (kind='logs' or (kind='chain-read' and instr(body,?)>0)) order by seq",(cursor,stop,'"kind":"meta"')).fetchall()
 emit(dict(events=rows));cursor=stop
old=sqlite3.connect("file:/srv/snipe/v1/data/bot.db?mode=ro",uri=True)
q=old.execute("select token,curve,detected_at,creator_tax_bps,exemptions,pair_token,dev_buy_wei from launches where detected_at>=? and detected_at<?",(end[1]-7*86400000,first))
while True:
 rows=q.fetchmany(5000)
 if not rows:break
 emit(dict(legacy=rows))
z.close()
'''

src = sqlite3.connect("file:" + str(SOURCE) + "?mode=ro", uri=True)
maxseq, local_end = src.execute("select seq,at from events order by seq desc limit 1").fetchone()
dst = sqlite3.connect(OUT / "evidence.sqlite")
dst.execute("create table events(seq integer primary key,at integer,kind text,body text)")
dst.execute("create table legacy(token text primary key,curve text,at integer,tax integer,ex integer,pair text,dev text)")
cursor = 0
while cursor < maxseq:
    stop = min(cursor + 50000, maxseq)
    rows = src.execute("select seq,at,kind,body from events where seq>? and seq<=? and (kind='logs' or (kind='chain-read' and instr(body,?)>0)) order by seq", (cursor, stop, '"kind":"meta"')).fetchall()
    dst.executemany("insert into events values(?,?,?,?)", rows)
    dst.commit()
    cursor = stop
    if cursor % 1000000 == 0: print("local source scanned", cursor, flush=True)
src.close()
command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-i", "/path/to/ssh/example-host", "operator@localhost", "python3 - " + str(maxseq)]
proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
proc.stdin.write(REMOTE.encode()); proc.stdin.close()
header = None
with gzip.GzipFile(fileobj=proc.stdout) as stream:
    for line in stream:
        row = json.loads(line)
        if "header" in row: header = row["header"]
        elif "events" in row:
            dst.executemany("insert into events values(?,?,?,?)", row["events"]); dst.commit()
        elif "legacy" in row:
            dst.executemany("insert into legacy values(?,?,?,?,?,?,?)", row["legacy"]); dst.commit()
if proc.wait() != 0 or header is None: raise RuntimeError("Read-only capture failed")
dst.execute("create index events_at on events(at)"); dst.commit(); dst.close()
digest = hashlib.file_digest(open(OUT / "evidence.sqlite", "rb"), "sha256").hexdigest()
manifest = dict(**header, localSource=str(SOURCE), localMaxSeq=maxseq, evidenceSha256=digest,
    policy=dict(stakeEth=0.0025,entryDelayMs=2000,holdMs=45000,takeProfit=1.36,hardStop=0,deadCoinExit=False,
    marketGuard=False,templateBlock=False,entryPriceCap=False,pollMs=1200,exitDelayMs=[600,1200],
    calibration=dict(positiveFactor=0.8844571237124664,negativeFactor=0.9906639095130271)),
    status="diagnostic: no current cash-fidelity certificate; legacy pre-V2 path unavailable")
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest), flush=True)
