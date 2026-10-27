import json
import tempfile
import unittest
from pathlib import Path

from core.unified_fidelity import run, matched_score


class FrozenAuditTests(unittest.TestCase):
    def test_changed_source_cannot_produce_a_fidelity_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root/'manifest.json'
            manifest.write_text(json.dumps({'from': 0, 'through': 20, 'londonDayStart': 10,
                                           'sourceHashes': {'research/core/unified_fidelity.py': 'wrong'}}))
            with self.assertRaisesRegex(ValueError, 'source hash mismatch'):
                run(manifest, root/'out')
            self.assertFalse((root/'out').exists())

    def test_invalid_cutoff_cannot_begin_an_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root/'manifest.json'
            manifest.write_text(json.dumps({'from': 20, 'through': 10, 'londonDayStart': 0}))
            with self.assertRaisesRegex(ValueError, 'invalid frozen time range'):
                run(manifest, root/'out')
            self.assertFalse((root/'out').exists())

    def test_missing_predictions_keep_the_denominator_and_false_winners(self):
        row = dict(id=1, actualWei='-100', exitAt=1, sizeWei='1000', actualTokens='100',
                   actualCostsWei='1', actualBuyAccepted=True, actualReason='dead')
        result = matched_score([row, {**row, 'id': 2}],
                               [dict(pnlWei='50', exitAt=1, tokens='110', costsWei='1', reason='dead'),
                                dict(status='unavailable', reason='missing_source')])
        self.assertEqual((result['known'], result['expected'], result['missing']), (1, 2, 1))
        self.assertEqual(result['falseWinners'], [1])
        self.assertEqual(result['quantityErrorPct']['mean'], 10)
        self.assertEqual(result['unavailableReasons'], {'missing_source': 1})


if __name__ == '__main__':
    unittest.main()
