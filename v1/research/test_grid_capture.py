import unittest,tempfile,sqlite3,json
from pathlib import Path
from core.stream_capture import capture as streaming
from core.data import capture,read_json

class CaptureParity(unittest.TestCase):
 def test_streaming_matches_standard_and_strips_signed_payload(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)
   for name,tables in [('bot',['launches','positions','approval_transactions']),('gate',['obs'])]:
    c=sqlite3.connect(root/(name+'.db'))
    for table in tables:
     c.execute('create table '+table+'(id integer,raw text)')
     c.execute('insert into '+table+' values (1,?)',('fixture',))
    c.commit();c.close()
   (root/'state.json').write_text(json.dumps({'at':123}))
   capture(root/'bot.db',root/'gate.db',root/'state.json',root/'standard.json.gz')
   streaming(root,root/'stream.json.gz')
   self.assertEqual(read_json(root/'standard.json.gz'),read_json(root/'stream.json.gz'))
