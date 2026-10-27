import json
import tempfile
import unittest
from pathlib import Path
from research.cloud_report_supplement import supplement


class ChronologicalReportTest(unittest.TestCase):
    def test_later_selected_candidate_cannot_win_an_earlier_cutoff(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'report').mkdir()
            account = dict(path='/work/results/accounts/fixed-memory20-hold-45.json',
                           lane='fixed', memory=20, exit='hold-45')
            rows = []
            for stage, identity, net in [('core', 'baseline', 1), ('train7-families', 'future-choice', 20)]:
                path = root / 'scores' / stage
                path.mkdir(parents=True)
                policy = dict(id=identity, n=10, m=5, off=-2, freshOn=1,
                              fullOn=2, ageMs=10800000, mode='both')
                (path / 'policies-0.json').write_text(json.dumps([policy]))
                (path / 'index.json').write_text(json.dumps(dict(
                    candidates=1, comparisons=1,
                    files=[str(path / 'fixed-memory20-hold-45-0.json')]
                )))
                rows.append(dict(policy=policy, lane='fixed', memory=20, exit='hold-45',
                                 periods={k: [dict(net=net, dd=.1, complete=True)] for k in
                                          ['train3', 'train5', 'train7', 'eval4-5', 'eval6-7', 'eval8-9']}))
            supplement(root, rows, [account])
            result = json.loads((root / 'report' / 'search-audit.json').read_text())
            choices = result['chronologicalSelections']
            self.assertEqual(choices[0]['choice']['policy']['id'], 'baseline')
            self.assertEqual(choices[1]['choice']['policy']['id'], 'baseline')
            self.assertEqual(choices[2]['choice']['policy']['id'], 'future-choice')
            rows[1]['periods']['train7'][0]['complete'] = False
            supplement(root, rows, [account])
            result = json.loads((root / 'report' / 'search-audit.json').read_text())
            self.assertEqual(result['chronologicalSelections'][2]['choice']['policy']['id'], 'baseline')


if __name__ == '__main__':
    unittest.main()
