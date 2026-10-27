"""Refuse the large search when no complete training comparison is available."""


def assess(comparisons):
    cutoffs = ['train3', 'train5', 'train7']
    complete = {cutoff: sum(bool(c.get('periods', {}).get(cutoff)) and
                           all(s['complete'] for s in c['periods'][cutoff])
                           for c in comparisons) for cutoff in cutoffs}
    return {'ready': all(complete.values()), 'completeTrainingComparisons': complete,
            'checkedComparisons': len(comparisons), 'profitabilityValidated': False,
            'reason': 'coverage preflight passed' if all(complete.values()) else
            'incomplete training account or reference; repair evidence before grid scoring'}
