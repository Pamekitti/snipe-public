"""Evaluate independent threshold states together using unchanged scalar features.

The scalar guard supplies every score, validity flag and publication clock. NumPy
only applies comparisons and Boolean state changes across candidates sharing those
features; it does not calculate returns or aggregate floating-point scores.
"""
from collections import defaultdict

import numpy as np

from .grid_v2_guard import Guard


def grouped_transitions(tape, rules, size, start, end, entries=(), controls=()):
    """Yield (rule, transitions) without retaining all groups' histories at once."""
    groups = defaultdict(list)
    for rule in rules:
        groups[(rule.n, rule.m, rule.age_min, rule.weighting, rule.half_life, rule.win_cap)].append(rule)
    for group in groups.values():
        representative = Guard(tape, group[0], size, start, entries, controls)
        # Tiny groups cost less with the existing scalar implementation.
        if len(group) < 8:
            for rule in group:
                guard = Guard(tape, rule, size, start, entries, controls)
                for at in sorted(x for x in guard.schedule if start <= x < end):
                    guard.read(at)
                yield rule, guard.transitions
            continue
        histories = [[] for _ in group]
        allowed = np.zeros(len(group), dtype=bool)
        paused_at = np.zeros(len(group), dtype=np.int64)
        off = np.array([r.off*r.n/20 if r.normalized and r.weighting=='sum' else r.off for r in group])
        fresh_on = np.array([r.fresh_on*r.m/8 if r.normalized and r.weighting=='sum' else r.fresh_on for r in group])
        full_on = np.array([r.full_on*r.n/20 if r.normalized and r.weighting=='sum' else r.full_on for r in group])
        floor = np.array([-np.inf if r.recovery_floor is None else r.recovery_floor for r in group])
        brake = np.array([-np.inf if r.fresh_brake is None else r.fresh_brake for r in group])
        participation_floor = np.array([-np.inf if r.participation is None else r.participation for r in group])
        required = np.array([r.new_outcomes for r in group], dtype=np.int64)
        modes = np.array([{'fresh':0,'full':1,'either':2,'both':3}[r.mode] for r in group])
        config = None
        for at in sorted(x for x in representative.schedule if start <= x < end):
            previous_cursor = representative.cursor
            value = representative.read(at)
            hi = value['evidence']
            changed = bool(hi and representative.records[hi-1]['available'] > previous_cursor)
            if at in representative.resumes:
                allowed[:] = False
                paused_at[:] = hi
                changed = False
            new_config = representative.config
            if config is not None and new_config != config:
                allowed[:] = False
                paused_at[:] = hi
                changed = False
            config = new_config
            before = allowed.copy()
            total, short = value['score20'], value['fresh_sum']
            if not value['fresh']:
                allowed[:] = False
            else:
                blocked = before & ((total < off) | (short < brake))
                recovered_fresh = (short > fresh_on) & (total >= floor)
                recovered_full = total > full_on
                recovered = (((modes == 0) & recovered_fresh)
                    | ((modes == 1) & recovered_full)
                    | ((modes == 2) & (recovered_fresh | recovered_full))
                    | ((modes == 3) & recovered_fresh & recovered_full))
                recovered &= value['participation'] >= participation_floor
                reopen = (~before) & changed & (hi-paused_at >= required) & recovered
                allowed[blocked] = False
                allowed[reopen] = True
            paused_at[before & ~allowed] = hi
            for i in np.flatnonzero(before != allowed):
                is_allowed = bool(allowed[i])
                reason = ('fresh_recovery' if group[i].mode == 'fresh' else 'recovery') if is_allowed else ('score_brake' if value['fresh'] else 'stale_or_warmup')
                histories[i].append(dict(at=at, allow=is_allowed, score20=total, fresh_sum=short,
                    fresh=value['fresh'], reason=reason, evidence=hi, participation=value['participation'],
                    new_outcomes=int(hi-paused_at[i])))
        yield from zip(group, histories)
