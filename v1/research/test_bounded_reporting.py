"""Selection stays chronological and archived revisions stay separate."""
import gzip
import io
import json
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from research.bounded_io import active_results
from research.bounded_rank import nominate, score_files, joint_clock_rows, key_for, BASELINE, aggregate


class BoundedReportingTest(unittest.TestCase):
    def test_fixed_diagnostic_preserves_failed_joint_clock_qualification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);name='pool-d0-h0-pub0';folder=root/'scenarios'/name;folder.mkdir(parents=True)
            (folder/'scenario-complete.json').write_text('{}')
            (root/'comparison-scope.json').write_text(json.dumps({'scenarios':[name]}))
            values=[]
            for lane,complete in [('fixed',True),('corrected',False)]:
                metric=dict(id='stress',complete=complete,net=1,dd=.1,recoveryLoss=0,losingRecoveries=0,n=10)
                row=dict(policy=BASELINE,periods={cutoff:[metric] for cutoff in ['train3','train5','train7']})
                values.append((name,Path(f'scores/core/{lane}-memory20-hold-45-0.json'),{'results':[row]}))
            with patch('research.bounded_rank.score_files',side_effect=lambda *a:iter(values)):
                joint=aggregate(root)
                original=(root/'report/cross-scenario-ranking.json').read_bytes()
                fixed=aggregate(root,fixed_clock_diagnostic=True)
            self.assertIsNone(joint['nominations']['train7']['choice'])
            self.assertIsNotNone(fixed['nominations']['train7']['choice'])
            self.assertTrue(fixed['diagnosticOnly'])
            self.assertFalse(fixed['validatedReplacement'])
            self.assertEqual((root/'report/cross-scenario-ranking.json').read_bytes(),original)

    def test_explicit_reduced_scope_excludes_omitted_scenario(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'comparison-scope.json').write_text(json.dumps({'scenarios':['pool-d0-h0-pub0']}))
            # Omitted rows are intentionally invalid: they must never enter ranking.
            with patch('research.bounded_rank.score_files',return_value=iter([
                    ('pool-d0-h1000-pub0',Path('scores/core/fixed-memory20-hold-45-0.json'),{'results':[None]})])):
                result=aggregate(root)
            self.assertEqual(result['expectedScenarios'],1)
            self.assertEqual(result['originalExpectedScenarios'],27)
            self.assertEqual(result['scenarioDirectories'],0)
            self.assertIsNone(result['nominations']['train7']['choice'])
            self.assertFalse(result['validatedReplacement'])

    def test_duplicate_scope_scenarios_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'comparison-scope.json').write_text(json.dumps({'scenarios':['same','same']}))
            with self.assertRaisesRegex(ValueError,'distinct'):aggregate(root)

    def test_clock_assumption_cannot_be_selected_for_its_higher_profit(self):
        rows=[]
        for lane,net in [('fixed',5),('corrected',-1)]:
            rows.append(dict(key=key_for(BASELINE,lane,20,'hold-45'),policy=BASELINE,lane=lane,memory=20,exit='hold-45',
                fitEligible={'train3':27},periods={'train3':dict(completeScenarios=27,net=net,dd=.2,recoveryLoss=.1,losingRecoveries=2)},
                deltas={'train3':dict(completeScenarios=27,net=net,dd=0,recoveryLoss=0,losingRecoveries=0)}))
        combined=joint_clock_rows(rows)
        self.assertEqual(len(combined),1)
        self.assertEqual(combined[0]['periods']['train3']['net'],-1)
        self.assertEqual(nominate(combined,'train3',27)['trainingRiskGatePasses'],0)
        self.assertEqual(rows[0]['periods']['train3']['net'],5)
        self.assertEqual(joint_clock_rows(rows[:1])[0]['fitEligible']['train3'],0)

    def test_held_out_profit_cannot_change_training_nomination(self):
        def row(key, fit_net, later_net):
            return dict(key=key, fitEligible={'train3':27},
                        periods={'train3':dict(completeScenarios=27, net=fit_net, dd=.1, recoveryLoss=.1, losingRecoveries=1),
                                 'reserved6h':dict(net=later_net)},
                        deltas={'train3':dict(completeScenarios=27,net=fit_net,dd=0,recoveryLoss=0,losingRecoveries=0)})
        rows=[row('training-choice',2,-100),row('later-winner',1,100)]
        self.assertEqual(nominate(rows,'train3',27)['choice']['key'],'training-choice')
        rows[1]['periods']['reserved6h']['net']=10000
        self.assertEqual(nominate(rows,'train3',27)['choice']['key'],'training-choice')
        rows[0]['fitEligible']['train3']=26
        self.assertEqual(nominate(rows,'train3',27)['choice']['key'],'later-winner')

    def test_compressed_score_reader_excludes_superseded_run_and_sidecars(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive=Path(temporary)/'bundle.tar.gz'
            with tarfile.open(archive,'w:gz') as tar:
                for prefix,filename,value in [('', 'fixed-memory20-hold-45-0.json', 'old'),
                        ('optimized-v2/', 'fixed-memory20-hold-45-0.json.gz','current'),
                        ('optimized-v2/', 'fixed-memory20-hold-45-0.json.checkpoint.json','sidecar')]:
                    data=json.dumps({'results':[value]}).encode()
                    if filename.endswith('.gz'):data=gzip.compress(data)
                    item=tarfile.TarInfo(prefix+'scenarios/pool-d0-h0-pub0/scores/core/'+filename)
                    item.size=len(data);tar.addfile(item,io.BytesIO(data))
            rows=list(score_files(Path(temporary),archive,'optimized-v2'))
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0][2]['results'],['current'])

    def test_active_pointer_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder=Path(temporary)
            (folder/'active-run.json').write_text(json.dumps({'path':'../other'}))
            with self.assertRaisesRegex(ValueError,'Unsafe'):active_results(folder)


if __name__=='__main__':unittest.main()
