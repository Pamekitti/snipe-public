"""Combine disjoint study shards without rerunning or changing any account."""
from .data import read_json,write_artifact,digest
from .long_history import OUT
from pathlib import Path

def run():
    shards=[read_json(OUT/f'index-shard-{i}.json') for i in range(3)]
    first=shards[0]
    for i,s in enumerate(shards):
        assert s['shard']==i and s['shards']==3
        for k in ('start','end','starts','design','source_hashes'):
            assert s[k]==first[k],k
    groups=[g for s in shards for g in s['groups']]
    assert len(groups)==len(set(groups))==len(first['starts'])*12
    evidence={k:v for s in shards for k,v in s['signal_evidence'].items()}
    assert len(evidence)==sum(len(s['signal_evidence']) for s in shards)==len(first['starts'])*2
    assert all(digest(Path(p))==h for p,h in first['source_hashes'].items())
    assert len(list((OUT/'groups').glob('*.json')))==len(groups)
    result={k:first[k] for k in ('start','end','starts','design','source_hashes')}
    result.update(groups=sorted(groups),signal_evidence=evidence,
        shard_files={f'index-shard-{i}.json':digest(OUT/f'index-shard-{i}.json') for i in range(3)})
    write_artifact(OUT/'index.json',result)
    print('Verified and combined',len(groups),'groups',flush=True)

if __name__=='__main__':run()
