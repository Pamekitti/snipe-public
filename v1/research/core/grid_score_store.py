"""Compact integer references with a backward-compatible logical scores view."""
import json
from dataclasses import asdict

def initialize(db,rules,compact):
 db.execute('create table if not exists accounts(id text primary key,value text)')
 if not compact:
  db.execute('create table if not exists scores(segment integer,name text,rule text,value text,primary key(segment,name))')
  db.execute('create index if not exists scores_name on scores(name)')
  return
 db.execute('create table if not exists rule_defs(id integer primary key,name text unique,definition text)')
 db.execute('create table if not exists score_refs(segment integer,rule_id integer,account_rowid integer,primary key(segment,rule_id)) without rowid')
 db.execute('create index if not exists score_refs_rule on score_refs(rule_id,segment)')
 db.execute("""create view if not exists scores as select s.segment,r.name,r.definition as rule,
 json_object('complete',json_extract(a.value,'$.complete'),'metrics',json_extract(a.value,'$.metrics'),'account_id',a.id) as value
 from score_refs s join rule_defs r on r.id=s.rule_id join accounts a on a.rowid=s.account_rowid""")
 db.executemany('insert or ignore into rule_defs values (?,?,?)',[(i+1,r.name,json.dumps(asdict(r))) for i,r in enumerate(rules)])

def insert(db,segment,rule,ordinal,account_id,value,compact):
 db.execute('insert or ignore into accounts values (?,?)',(account_id,json.dumps(value)))
 if compact:
  account_rowid=db.execute('select rowid from accounts where id=?',(account_id,)).fetchone()[0]
  db.execute('insert into score_refs values (?,?,?)',(segment,ordinal+1,account_rowid))
 else:
  ref=dict(complete=value['complete'],metrics=value['metrics'],account_id=account_id)
  db.execute('insert into scores values (?,?,?,?)',(segment,rule.name,json.dumps(asdict(rule)),json.dumps(ref)))
