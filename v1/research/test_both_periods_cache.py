import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from research.core.both_periods_cache import verify


class Metadata:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def call(self,**kwargs):return dict(topics=dict(TokenLaunched='launch',CurveBuy='buy'))


class CacheProofTests(unittest.TestCase):
    def run_fixture(self,disagree=False,wrong_header=False,missing_topic=False):
        with tempfile.TemporaryDirectory() as temp:
            parent=Path(temp);root=parent/'study';root.mkdir();(root/'verified').mkdir()
            def write(path,value):path.write_text(json.dumps(value))
            archive=parent/'20260913-shared-refresh';archive.mkdir()
            write(archive/'actual-paths.json',dict(blocks={'0xa':dict(hash='wrong' if wrong_header else 'hash10',timestamp=1),'0x14':dict(hash='hash20',timestamp=2)}))
            write(root/'preparation.json',dict(sourceJobsHash='inputs'))
            log=dict(address='curve',blockNumber='0xa',blockHash='hash10',logIndex='0x0',transactionHash='tx',transactionIndex='0x0',topics=['buy'],data='0x01',removed=False)
            job=dict(id=1,curve='curve',lo=10,hi=10,endAt=1500,logs=[log],headers={})
            write(root/'source-jobs.json',[job])
            scans=[dict(key='a',lo=9,hi=20,at=100,topics=[['sell' if missing_topic else 'buy']],request='request-a'),
                dict(key='b',lo=8,hi=21,at=200,topics=[['buy']],request='request-b')]
            write(root/'cache-index.json',{'curve':scans})
            db=sqlite3.connect(parent/'cache.sqlite');db.execute('create table rpc(key text,value text)')
            db.executemany('insert into rpc values(?,?)',[('a',json.dumps([log])),('b',json.dumps([dict(log,data='0x02') if disagree else log]))]);db.commit();db.close()
            with patch('research.core.both_periods_cache.Worker',Metadata):result=verify(root)
            return result,(root/'verified/1.json').exists()

    def test_distinct_complete_scans_can_supply_proof(self):
        result,exists=self.run_fixture();self.assertEqual(result['reused'],1);self.assertTrue(exists)

    def test_disagreement_cannot_be_hidden(self):
        result,exists=self.run_fixture(disagree=True);self.assertEqual(result['reused'],0);self.assertFalse(exists)

    def test_hash_mismatch_cannot_authorize_replay(self):
        result,exists=self.run_fixture(wrong_header=True);self.assertEqual(result['reused'],0);self.assertFalse(exists)

    def test_partial_event_scope_is_not_complete_coverage(self):
        result,exists=self.run_fixture(missing_topic=True);self.assertEqual(result['reused'],0);self.assertFalse(exists)


if __name__=='__main__':unittest.main()
