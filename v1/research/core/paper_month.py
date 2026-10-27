"""Export a diagnostic monthly paper ledger from frozen execution models.

Never writes to the trading database or publishes recovery evidence.
An unresolved admitted execution stops the ledger.
"""
import argparse
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .account import simulate
from .data import digest, read_json, write_json
from .evaluation import trade_from_model
from .guard_visual import close_cash
from .policies import Policy


def run(args):
    target = Path(args.out)
    if target.exists():
        raise ValueError('Use a new output path to preserve prior runs')
    start = int(datetime.fromisoformat(args.month + '-01').replace(tzinfo=timezone.utc).timestamp() * 1000)
    models = read_json(args.models)
    trades = [trade_from_model(z) for z in models['tokens'].values()]
    policy = Policy(name='paper_continuous', min_creator_tax_bps=50, min_exemptions=3,
                    market_enabled=False, touch_enabled=False, account_pauses_enabled=False)
    result = simulate([], trades, policy, start, args.end)
    cash = close_cash(result)
    total = 0
    points = [dict(at=start, pnl_wei='0')]
    for event in cash:
        total += event['pnl']
        points.append(dict(at=event['at'], pnl_wei=str(total)))
    unavailable = [dict(token=z['token'], entry=z['entry'], status=z['results']['adaptive']['status'])
                   for z in models['tokens'].values()
                   if start <= z['entry'] < args.end
                   and z['results']['adaptive']['status'] not in ('closed', 'buy_reverted', 'entry_price_rejected')]
    output = dict(status='diagnostic_only', month=args.month, requested_end=args.end,
                  model_sha256=digest(args.models), policy=asdict(policy), points=points,
                  cash=cash, admitted_unknowns=result['unresolved'],
                  unavailable_executions=unavailable, modeled_account_complete=result['complete'],
                  population_coverage_verified=False, profitability_validated=False,
                  limitations=['Frozen historical models, not a verified replay under the current source.',
                               'Population coverage must be checked before publishing a monthly total.',
                               'Unknown admitted executions stop the cumulative ledger.'])
    write_json(target, output)
    print(dict(output=str(target), closed=len(cash), complete=result['complete'],
               blocked=result['unresolved'], unavailable=dict(Counter(x['status'] for x in unavailable))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', required=True)
    parser.add_argument('--month', required=True)
    parser.add_argument('--end', required=True, type=int)
    parser.add_argument('--out', required=True)
    run(parser.parse_args())
