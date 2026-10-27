#!/usr/bin/env python3
"""Fetch missing approval receipts, then apply their exact costs idempotently.

Fetch on the laptop: --input exported-positions.json --out approvals.json
Apply after review: --apply approvals.json --db data/bot.db
The input supplies the explicit position set. No wallet key is read or used.
"""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
import sqlite3
import ssl
import time
import urllib.request

TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
RPC = 'https://rpc.mainnet.chain.robinhood.com'


def fetch(source, out):
    data=json.loads(source.read_text())
    context=ssl.create_default_context(cafile='/etc/ssl/cert.pem')
    def rpc(method,params):
        for attempt in range(3):
            try:
                req=urllib.request.Request(RPC,data=json.dumps(dict(jsonrpc='2.0',id=1,method=method,params=params)).encode(),
                                           headers={'Content-Type':'application/json','User-Agent':'approval-backfill/1'})
                result=json.load(urllib.request.urlopen(req,context=context,timeout=25))
                if 'error' in result:raise RuntimeError(result['error'])
                return result['result']
            except Exception:
                if attempt==2:raise
                time.sleep(2*(attempt+1))
            finally:
                time.sleep(1)
    pad=lambda x:'0x'+x.lower().removeprefix('0x').zfill(64)
    rows=[]
    if out.exists():rows=json.loads(out.read_text())['positions']
    done={r['id'] for r in rows}
    for p in data['positions']:
        if p['id'] in done:continue
        if not p['buy_ok'] or not p['fill_block']:
            raise ValueError(f"position {p['id']} needs separate buy-failure reconciliation")
        block=p['fill_block']
        logs=rpc('eth_getLogs',[{'address':p['token'],'fromBlock':hex(block),
              'toBlock':hex(block+max(600,math.ceil((p['hold_ms'] or 0)/100)+100)),
              'topics':[TOPIC,pad(data['wallet']),pad(p['curve'])]}])
        if not logs:raise ValueError(f"position {p['id']} has no matching approval log")
        approvals=[]
        for h in sorted({r['transactionHash'] for r in logs}):
            rc=rpc('eth_getTransactionReceipt',[h])
            if not rc or rc['transactionHash'].lower()!=h.lower():raise ValueError('receipt mismatch')
            if rc.get('from','').lower()!=data['wallet'].lower():raise ValueError('approval sender mismatch')
            if rc.get('to','').lower()!=p['token'].lower():raise ValueError('approval token mismatch')
            approvals.append({'hash':h,'gas_wei':str(int(rc['gasUsed'],16)*int(rc['effectiveGasPrice'],16)),
                              'block':int(rc['blockNumber'],16),'receipt':rc})
        rows.append({'id':p['id'],'token':p['token'],'buy_hash':p['buy_hash'],
                     'approval_gas_wei':str(sum(int(a['gas_wei']) for a in approvals)),
                     'approvals':approvals})
        out.write_text(json.dumps({'wallet':data['wallet'],'positions':rows},indent=2)+'\n')
        if len(rows)%10==0:print(f"verified {len(rows)}/{len(data['positions'])} positions",flush=True)
    print('verified total',len(rows),'approval gas ETH',sum(int(r['approval_gas_wei']) for r in rows)/1e18,flush=True)


def apply(source, dbfile):
    data=json.loads(source.read_text())
    db=sqlite3.connect(dbfile);db.row_factory=sqlite3.Row
    stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=Path(str(dbfile)+'.before-approvals-'+stamp+'-'+str(time.time_ns()))
    with sqlite3.connect(backup) as dst:db.backup(dst)
    total=0;changed=0
    with db:
        for r in data['positions']:
            p=db.execute('select * from positions where id=?',(r['id'],)).fetchone()
            if not p or not p['live'] or not p['closed'] or p['token']!=r['token'] or p['buy_hash']!=r['buy_hash']:
                raise ValueError(f"position {r['id']} changed or is not a closed live trade")
            if p['onchain_pnl_wei'] is None:raise ValueError(f"position {r['id']} lacks its base receipt accounting")
            new=int(r['approval_gas_wei']);old=int(p['approval_gas_wei'] or 0);delta=new-old
            if new!=sum(int(a['gas_wei']) for a in r['approvals']):raise ValueError('approval sum mismatch')
            for a in r['approvals']:
                rc=a['receipt']
                if rc['from'].lower()!=data['wallet'].lower() or rc['to'].lower()!=r['token'].lower():raise ValueError('receipt owner mismatch')
                if rc['transactionHash'].lower()!=a['hash'].lower():raise ValueError('receipt hash mismatch')
                if int(rc['gasUsed'],16)*int(rc['effectiveGasPrice'],16)!=int(a['gas_wei']):raise ValueError('receipt fee mismatch')
                prior=db.execute('select position_id from approval_transactions where hash=?',(a['hash'],)).fetchone()
                if prior and prior['position_id']!=r['id']:raise ValueError('approval belongs to another position')
                db.execute('insert or replace into approval_transactions(hash,position_id,at,rejected,gas_wei) values (?,?,?,0,?)',
                           (a['hash'],r['id'],p['t_sent'] or p['t_detect'],a['gas_wei']))
            db.execute('update positions set approval_gas_wei=?,gas_wei=?,onchain_pnl_wei=? where id=?',
                       (str(new),str(int(p['gas_wei'] or 0)+delta),str(int(p['onchain_pnl_wei'])-delta),r['id']))
            changed+=delta!=0;total+=delta
        db.execute('insert or replace into chain_truth(key,value) values (?,?)',('approval_backfill',json.dumps(
            {'at':int(time.time()*1000),'positions':len(data['positions']),'delta_wei':str(total),'backup':str(backup)})))
    print(json.dumps({'positions':len(data['positions']),'changed':changed,'charged_eth':total/1e18,'backup':str(backup)}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',type=Path);p.add_argument('--out',type=Path)
    p.add_argument('--apply',type=Path);p.add_argument('--db',type=Path)
    a=p.parse_args()
    if a.apply and a.db:apply(a.apply,a.db)
    elif a.input and a.out:fetch(a.input,a.out)
    else:p.error('use --input/--out or --apply/--db')
