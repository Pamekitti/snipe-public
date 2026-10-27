"""Explicit historical publication scenarios. Never overwrite recorded evidence."""
import math


def validate_policy(policy):
    if policy is None:
        return
    if policy.get('kind') == 'recorded':
        return
    if policy.get('kind') != 'modeled-periodic-v1':
        raise ValueError('unknown publication policy')
    for key in ['periodMs', 'phaseMs', 'workerMs', 'sourceHorizonMs']:
        value = policy.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError('invalid publication ' + key)
    if policy['periodMs'] == 0 or policy['phaseMs'] >= policy['periodMs']:
        raise ValueError('invalid publication cadence')


def publication_time(row, closed, policy=None, selector=False):
    """Return a labeled availability time, including durable completion ordering.

    The modeled lane asks how a continuously operating observer would behave.
    It does not recover a lost historical publication or certify live evidence.
    Invalid executions remain unavailable in the calling account reducer.
    """
    validate_policy(policy)
    if not isinstance(closed, (float, int)) or not math.isfinite(closed):
        raise ValueError('missing modeled closure')
    recorded = row['publicationFloor']
    if policy is None or policy['kind'] == 'recorded':
        at = max(recorded, closed) + 1 if selector else max(recorded, closed + 1)
        return at, {'kind': 'recorded-gate-floor', 'recordedFloor': recorded}
    ready = max(closed, row['at'] + policy['sourceHorizonMs'])
    phase, period = policy['phaseMs'], policy['periodMs']
    tick = math.ceil((ready - phase) / period) * period + phase
    at = tick + policy['workerMs'] + 1
    return at, {'kind': policy['kind'], 'recordedFloor': recorded,
                'modeledSourceReadyAt': ready, 'modeledTickAt': tick,
                'historicalPublicationRecovered': False}
