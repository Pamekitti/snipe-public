import unittest
import joint_policy_audit as j

class Profiles(unittest.TestCase):
    def test_weak_market_changes_all_three_controls(self):
        p=j.candidates()[j.PRIMARY]
        self.assertEqual(j.profile(p,.5,True,3.,.02),(.01,1.36,30))
    def test_strong_market_keeps_normal_size_and_45_seconds(self):
        p=j.candidates()[j.PRIMARY]
        self.assertEqual(j.profile(p,1.01,True,1.25,.02),(.02,2.,45))
    def test_unknown_market_does_not_invent_a_weak_signal(self):
        p=j.candidates()[j.PRIMARY]
        self.assertEqual(j.profile(p,-100,False,1.75,.01),(.01,1.75,45))
    def test_exact_hysteresis_boundary_is_not_a_strong_reopening(self):
        self.assertEqual(j.profile(j.candidates()[j.PRIMARY],1,True,3.,.01),(.005,1.36,30))
    def test_size_control_isolates_size(self):
        self.assertEqual(j.profile({'kind':'size'},0,True,2.5,.01),(.005,2.5,45))
    def test_exit_control_does_not_cut_size(self):
        self.assertEqual(j.profile({'kind':'exits'},0,True,2.5,.01),(.01,1.36,30))
    def test_missing_data_diagnostic_uses_cautious_profile(self):
        p={**j.candidates()[j.PRIMARY],'unknown_weak':True}
        self.assertEqual(j.profile(p,3.5,False,3.,.02),(.01,1.36,30))
    def test_missing_only_diagnostic_does_not_change_fresh_weak_market(self):
        self.assertEqual(j.profile({'kind':'unknown_size'},0,True,3.,.02),(.02,3.,45))
        self.assertEqual(j.profile({'kind':'unknown_size'},3.5,False,3.,.02),(.01,3.,45))

if __name__=='__main__':unittest.main()
