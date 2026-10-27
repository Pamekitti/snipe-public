"""Stateful guard hypotheses on the unchanged adaptive shadow outcome tape."""
from dataclasses import dataclass, asdict
import bisect
import math
import statistics
from .indicators import SignalRule


@dataclass(frozen=True)
class Rule:
    family: str
    scale: float = 1.0
    window: int = 5
    brake: float = 1.0

    @property
    def name(self):
        return f'{self.family}_s{self.scale:g}_w{self.window}_b{self.brake:g}'


def candidates():
    families = ('fresh', 'memory', 'trail', 'permit', 'breadth', 'fast',
                'clock', 'noise', 'earned', 'quarantine', 'divergence',
                'cluster', 'exhaustion', 'pressure', 'regime')
    rules = [Rule(f, s) for f in families for s in (0.5, 1.0, 2.0)]
    rules += [Rule(f, 1, w) for f in ('fresh', 'memory', 'breadth', 'fast') for w in (3, 8)]
    rules += [Rule('trail', s, brake=b) for s in (0.5, 1, 2) for b in (0.5, 2)]
    return rules


class CreativeGuard:
    """Guard interface consumed by the shared account engine, with causal callbacks."""
    def __init__(self, tape, rule, normal_size, start, facts, delay=0):
        self.tape, self.rule, self.normal_size = tape, rule, normal_size
        self.start, self.facts, self.delay = start, facts, delay
        self.times = [t + delay for t in tape.times]
        self.cursor = bisect.bisect_left(self.times, start)
        self.visible = list(tape.records[:self.cursor])
        self.allowed = False
        self.last = {}
        self.last_at = None
        self.total = self.low = self.high = 0.0
        self.failures = self.generation = 0
        self.episodes = {0: dict(cash=0, active=0, entries=0, ended=False, settled=False)}
        self.permits = self.used_evidence = 0
        self.credit = 0.0
        self.pairs = []
        self.by_token = {r['token']: r for r in tape.records}
        self.transitions = []
        self.last_rebound = None
        self.peak_rebound = 0.0

    def _settle(self, gen):
        e = self.episodes[gen]
        if e['ended'] and not e['active'] and not e['settled']:
            if e['entries']:
                self.failures = self.failures + 1 if e['cash'] < 0 else 0
            e['settled'] = True

    def _switch(self, at, allow, reason):
        if allow == self.allowed:
            return
        if not allow:
            self.episodes[self.generation]['ended'] = True
            self._settle(self.generation)
            self.low = self.total
            self.last_rebound = self.peak_rebound
            self.peak_rebound = 0
        else:
            self.generation += 1
            self.episodes[self.generation] = dict(cash=0, active=0, entries=0, ended=False, settled=False)
            self.high = self.total
        self.allowed = allow
        self.transitions.append(dict(at=at, allow=allow, reason=reason, total=self.total, failures=self.failures))

    def read(self, at):
        if at == self.last_at:
            return self.last
        n = bisect.bisect_right(self.times, at)
        new = self.tape.records[self.cursor:n]
        if new:
            # One publication batch is observed atomically. No tradable peak exists
            # between outcomes first revealed at the same clock.
            self.total += sum(row['value'] for row in new)
            self.low = min(self.low, self.total)
            self.high = max(self.high, self.total)
            self.peak_rebound = max(self.peak_rebound, self.total - self.low)
            self.credit = max(0, self.credit + sum(row['value'] for row in new))
        self.visible.extend(new)
        self.visible = [r for r in self.visible if at-r["launched"] <= 3*3600000]
        self.cursor = n
        s = self.tape.estimate(at, SignalRule('matched20', delay_ms=self.delay))
        # Fresh features use recently launched, completed and published results only.
        rows = sorted((r for r in self.visible if at-r['launched'] <= 3*3600000),
                      key=lambda r: (r['launched'], r['token']))
        recent = rows[-self.rule.window:]
        vals = [r['value'] for r in recent]
        fresh_sum = sum(vals)
        short = sum(r['value'] for r in rows[-3:])
        score = s['value']*20 if s['value'] is not None else None
        fresh = s['fresh'] and len(vals) == self.rule.window
        f, k = self.rule.family, self.rule.scale
        reason = 'hold'
        want = self.allowed
        threshold = k
        if f == 'memory':
            threshold += 0.5*k*self.failures
        if f == 'noise':
            threshold = k*max(0.5, statistics.stdev(vals)*math.sqrt(len(vals))) if len(vals)>1 else k
        if not fresh:
            want, reason = False, 'stale_or_warmup'
        else:
            # Default fresh recovery and fixed 20-outcome brake.
            if self.allowed and score < -1:
                want, reason = False, 'score_brake'
            elif not self.allowed and new and fresh_sum > threshold:
                want, reason = True, 'fresh_recovery'
            if f in ('trail', 'exhaustion'):
                needed = k
                if f == 'exhaustion' and self.last_rebound is not None:
                    needed = max(k, 0.5*self.last_rebound)
                want = self.allowed
                if self.allowed and self.high-self.total > 0.75*self.rule.brake*k:
                    want, reason = False, 'shadow_giveback'
                elif not self.allowed and new and self.total-self.low > needed:
                    want, reason = True, 'shadow_rebound'
            elif f == 'permit':
                if self.permits <= 0:
                    want, reason = False, 'permit_exhausted'
                    if new and n-self.used_evidence >= self.rule.window and fresh_sum > k:
                        self.permits = 3
                        self.used_evidence = n
                        want, reason = True, 'new_permit_batch'
            elif f == 'breadth' and want and not self.allowed:
                wins = [r for r in recent if r['value'] > 0]
                creators = {self.facts[r['token']].get('deployer') for r in wins}
                creators.discard(None)
                if len(wins) < math.ceil(0.6*self.rule.window) or len(creators)<2:
                    want, reason = False, 'narrow_recovery'
            elif f in ('fast', 'cluster'):
                bad = short < -k if f == 'fast' else sum(r['value']<0 for r in rows[-5:]) >= 4 and sum(r['value'] for r in rows[-5:]) < -k
                if bad:
                    want, reason = False, 'fast_loss_brake'
            elif f == 'clock':
                if at-rows[-1]['launched'] > 15*60000*k:
                    want, reason = False, 'freshness_expired'
            elif f == 'divergence':
                pairs = [p['actual']-self.by_token[p['token']]['value'] for p in self.pairs
                         if p['token'] in self.by_token and self.by_token[p['token']]['available']+self.delay<=at][-5:]
                if len(pairs)==5 and sum(pairs)/5 < -0.1*k:
                    want, reason = False, 'execution_gap'
            elif f == 'pressure':
                want = self.allowed
                if self.allowed and score < -1:
                    want, reason = False, 'score_brake'
                elif not self.allowed and new and self.credit > k and short > 0:
                    want, reason = True, 'accumulated_fresh_profit'
            elif f == 'regime':
                signs = [r['value']>0 for r in rows[-10:]]
                flips = sum(a!=b for a,b in zip(signs, signs[1:]))
                if flips>=6:
                    want = self.allowed
                    if self.allowed and short < -k:
                        want, reason = False, 'choppy_brake'
                    elif not self.allowed and new and fresh_sum>2*k:
                        want, reason = True, 'choppy_recovery'
                elif score>2 and new:
                    want, reason = True, 'sustained_profit'
        before = self.allowed
        self._switch(at, want, reason)
        if before and not self.allowed:
            self.credit = 0
        self.last_at = at
        self.last = dict(allow=self.allowed, score20=score, fresh_sum=fresh_sum,
                         fresh=fresh, reason=reason, failures=self.failures,
                         permits=self.permits, shadow=self.total, rebound=self.total-self.low,
                         giveback=self.high-self.total, evidence=n)
        return self.last

    def entry(self, at, trade, active):
        s = self.read(at)
        size = self.normal_size
        if not s['allow']:
            return size, 'venue'
        if self.rule.family == 'quarantine':
            creator = self.facts[trade['token']].get('deployer')
            same = [r['value'] for r in self.visible if self.facts[r['token']].get('deployer') == creator
                    and at-r['launched']<=3600000][-5:]
            if creator and len(same)>=2 and sum(same)<-self.rule.scale:
                return size, 'creator_quarantine'
        if self.rule.family == 'earned':
            profit = self.episodes[self.generation]['cash']/self.normal_size
            size //= 4 if profit<0.5*self.rule.scale else 2 if profit<self.rule.scale else 1
        return size, None

    def entered(self, trade):
        trade['creative_generation'] = self.generation
        self.episodes[self.generation]['active'] += 1
        self.episodes[self.generation]['entries'] += 1
        if self.rule.family == 'permit':
            self.permits -= 1
        self.last_at = None

    def closed(self, trade):
        gen = trade['creative_generation']
        e = self.episodes[gen]
        e['active'] -= 1
        e['cash'] += trade['pnl']
        self.pairs.append(dict(token=trade['token'], actual=trade['pnl']/trade['size']))
        self._settle(gen)
        self.last_at = None

    def definition(self):
        return asdict(self.rule)
