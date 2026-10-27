"""Render the frozen recovery experiment and verify its aggregate cash."""
import collections
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT=Path('v1/data/recovery-policy-20260908')


def rolling_dd(cash,hours):
    q=collections.deque([(cash[0][0]-1,0)]) if cash else collections.deque()
    balance=worst=0
    for at,_,v in cash:
        while len(q)>1 and q[1][0]<=at-hours*3600000:q.popleft()
        balance+=v;q.append((at,balance))
        worst=max(worst,max(x for _,x in q)-balance)
    return worst/1e18


def main():
    a=json.load(open(ROOT/'recorded_results.json'));b=json.load(open(ROOT/'model_results.json'))
    c=json.load(open(ROOT/'ablation_results.json'));d=json.load(gzip.open(ROOT/'snapshot.json.gz','rt'))
    usd=b['eth_usd'];base=b['scenarios']['zero_recovery']['baseline'];best=c['zero']['venue_plus2_only']
    names={'baseline':'Current rules','market_3':'Three market updates','both_confirm_6':'Six updates + short window',
           'restart_plus2':'+2 for both recovery rules','restart_allowance':'Restart loss allowance',
           'quarter_probe':'Quarter-size probes','rolling_dd_006':'Rolling 0.06 ETH budget',
           'confirm_probe':'Six updates + probes'}
    for scope in [a['recorded'],*b['scenarios'].values()]:
        for name,z in scope.items():
            if '14d' in z:
                days=[z[f'day_{i:02}']['pnl_eth'] for i in range(1,15) if f'day_{i:02}' in z]
                assert abs(sum(days)-z['14d']['pnl_eth'])<1e-10
            assert len({i for _,i,_ in z['cash']})==len(z['cash'])
    lines=['# Recovery research: stricter market reopening is the leading candidate','',
        'The live false recovery was a normal market reopening, not a drawdown recovery. '
        'It reopened at +1.393 stakes at 12:30:33 London time on 8 September, then paused '
        'at -2.313 at 12:53:03. Ten receipt-reconciled trades lost $105.76 net. '
        'The operator stopped the bot separately at 13:29:01. No live setting changed in this research.','',
        f'Inputs end at {a["snapshot"]}, or 13:32 London time. Dollar conversion is ${usd:,.2f}/ETH. '
        'The current-size period starts 7 September at 14:55 London, giving 22.62 hours. '
        'The actual 169 closed attempts booked $'+f'{a["actual"]["all_current"]["sum"]*usd:,.2f}. '
        'The conditional replay starts fresh at that boundary and applies the current +1 DD setting uniformly, '
        'so its baseline is not an exact replay of the historical account.','',
        '## The live episode, starting from the same actual halt','',
        'These comparisons end at the observed market re-halt. Zero means no retained recorded trades in this '
        'episode, not a guarantee of zero losses afterward. The reported episode was known before testing.','',
        '| Rule | Trades retained | Net loss in episode |','|---|---:|---:|']
    for n in ['baseline','market_3','both_confirm_6','restart_plus2','restart_allowance','quarter_probe']:
        z=b['isolated_live_episode'][n]['episode']
        suffix=' (modeled smaller fills)' if n=='quarter_probe' else ''
        lines.append(f'| {names[n]}{suffix} | {z["n"]} | ${max(0,-z["pnl_eth"])*usd:,.2f} |')
    lines += ['', 'The sampled indicator never exceeded +1.393 during this episode. Both +1.5 and +2 therefore '
        'would have avoided its recorded entries. This episode cannot identify +2 as the optimal threshold. '
        'DD-only changes do not protect it when starting from the actual account state.','',
        '## Current-era conditional cash comparison','',
        'Receipt-based trades are retained or removed at their actual sizes and exits. Additional hypothetical '
        'entries cannot be established from this comparison. All periods and parameters are retrospective.','',
        '| Rule | Retained attempts | Net cash | Maximum drawdown |', '|---|---:|---:|---:|']
    for n in ['baseline','market_3','both_confirm_6','restart_plus2','restart_allowance','rolling_dd_006']:
        z=a['recorded'][n]['all_current']
        lines.append(f'| {names[n]} | {z["n"]} | ${z["pnl_eth"]*usd:,.2f} | ${z["dd_eth"]*usd:,.2f} |')
    lines += ['', 'Requiring +2 only for normal market recovery ties the +2-both-rules result in this current-era '
        'comparison. Three market updates look better over the entire account path, but did not prevent the '
        'new live episode when its actual starting halt is held fixed.','',
        '## Longer opportunity model: useful for comparisons, not an earnings forecast','',
        'The model uses fixed 1.75 exits at 0.02 ETH over 14 days. Smaller probes are repriced through their own '
        'curve paths at 0.005 and 0.01 ETH. Profit retention is relative to this model baseline. '
        'Drawdown is cumulative peak-to-trough across accounting resets, not a per-stop limit.','',
        '| Rule | Modeled profit retained | Modeled maximum drawdown |', '|---|---:|---:|']
    for n in ['baseline','market_3','both_confirm_6','restart_plus2','restart_allowance','quarter_probe','rolling_dd_006','confirm_probe']:
        z=b['scenarios']['zero_recovery'][n]['14d']
        lines.append(f'| {names[n]} | {100*z["pnl_eth"]/base["14d"]["pnl_eth"]:.1f}% | ${z["dd_eth"]*usd:,.0f} |')
    lines.append(f'| +2 market recovery, DD unchanged | {100*best["14d"]["pnl_eth"]/base["14d"]["pnl_eth"]:.1f}% | ${best["14d"]["dd_eth"]*usd:,.0f} |')
    lines += ['', 'The small-probe schemes were too restrictive in this experiment. Their requirement for at least five '
        'completed trades and positive stage P&L, one-position capacity, and loss budget left them parked for many modeled profitable '
        'opportunities. This rejects these particular probe policies, not every possible sizing policy.','',
        '## Stress tests for +2 normal market recovery','',
        'The DD recovery threshold remains +1. Each row compares against its own baseline. These are correlated '
        'scenarios over reused history, not independent validation samples.','',
        '| Scenario | Extra modeled profit over 14 days | Baseline DD | Candidate DD |','|---|---:|---:|---:|']
    labels={'zero':'Main model','slower':'1.2-second sell latency','phase15':'Clock shifted 15 seconds',
            'delay_120000':'Older scores reconstructed at 2 minutes','delay_600000':'Older scores reconstructed at 10 minutes',
            'trade_minus5pp':'Every trade return reduced by 5 percentage points'}
    for k,label in labels.items():
        x=c[k]['baseline']['14d'];y=c[k]['venue_plus2_only']['14d']
        lines.append(f'| {label} | ${(y["pnl_eth"]-x["pnl_eth"])*usd:+,.0f} | ${x["dd_eth"]*usd:,.0f} | ${y["dd_eth"]*usd:,.0f} |')
    lines += ['', '| Main model rule | Worst rolling 24-hour drawdown | Worst rolling 48-hour drawdown |',
        '|---|---:|---:|']
    for name,label in [('baseline','Current'),('venue_plus2_only','Market +2'),('venue2_dd_once24','Market +2 and one DD retry/24h')]:
        cash=c['zero'][name]['cash']
        lines.append(f'| {label} | ${rolling_dd(cash,24)*usd:,.0f} | ${rolling_dd(cash,48)*usd:,.0f} |')
    lines += ['', 'Restricting the +2 candidate to one automatic DD recovery per rolling 24 hours gives up '
        'about $2,433 of modeled two-week profit. It reduces worst 24-hour drawdown by about $77, '
        'but worst 48-hour drawdown by only $3. That is a risk preference tradeoff. '
        'Adjacent thresholds and separate market-only/DD-only results are saved in ablation_results.json.','',
        '## Validation and remaining uncertainty','',
        f'- The reconstructed live reading matched {a["sensor_check"]["exact"]:,} of {a["sensor_check"]["n"]:,} '
        'recorded guard samples exactly within 1e-9. Sampling and scoring availability are not perfectly reproduced.',
        '- The new baseline matches the previous state machine on the full current dataset for cash, entry '
        'decisions and market readings. This validates implementation continuity, not the historical account assumptions.',
        '- All 42 additional requested curve ranges were fetched without errors. There are 3,862 usable paths '
        'including warmup; 49 primary targets had no enterable native path.',
        '- The modeled 20-pair execution-underperformance halt did not change the six principal policy comparisons. '
        'Its inclusion therefore does not explain away the modeled drawdowns.',
        '- Graduation remains unresolved. A zero-recovery stress and a virtual-curve-value stress were tested. '
        'The latter is neither an executable V4 quote nor a proven upper bound. Full adaptive targets, actual '
        'touch/template feedback, funding history, and other traders responding to our changed fills remain incomplete.',
        '- Fees use the median of 155 current-size fills before the final six-hour boundary. There are no '
        'current-era small-size receipts with which to validate probe execution costs.','']
    cal=b['calibration'];g=cal['gap_pp']
    lines += [f'On {cal["n"]} matched current-size fills, the model books ${cal["modeled_eth"]*usd:,.2f} '
        f'against ${cal["actual_eth"]*usd:,.2f} actual cash. Return-error mean is {g["mean"]:.2f} percentage points, '
        f'median {g["median"]:.2f}, sample sd {g["sd"]:.2f}, n={g["n"]}. '
        'For the 10 latest live trades, modeled net loss was $108.83 versus $105.76 actual. '
        'Good agreement on this episode does not resolve the older graduation errors.','',
        'The current study baseline differs from the earlier $571 drawdown table because the endpoint, '
        'signal universe and fee calibration changed. Compare candidates within this experiment. '
        'Do not count the changed baseline as a policy improvement.','',
        '## Decision','',
        'The leading research candidate reopens a normal market pause strictly above +2 stakes. The '
        'current -1 pause threshold and separate DD recovery stay as they are. It performed better than the tested '
        'persistence and probe combinations for retaining profit while reducing drawdown. This is a candidate '
        'for prospective validation, not a proven optimum or authorization to change the live bot. '
        'A +2 reading can still be followed by losses.','',
        'The 24-hour eight-bin and seven-day seven-bin tables, full distributions, account events, ablations '
        'and stress outputs are retained in the JSON files. Older-era bins are diagnostics. '
        'No new live entries after the operator stop are available to validate future recoveries.','',
        '![Recovery policy comparison](recovery_comparison.png)','',
        'Reproduce from the repository root with `PYTHONHASHSEED=0 python3 v1/research/recovery_policy_audit.py`, '
        '`recovery_policy_models.py build`, `recovery_policy_models.py run`, `recovery_policy_followup.py`, '
        'and `recovery_policy_report.py` using the same `v1/research/` prefix.']
    (ROOT/'report.md').write_text('\n'.join(lines)+'\n')
    selected=['baseline','market_3','both_confirm_6','restart_allowance','quarter_probe']
    fig,axs=plt.subplots(1,2,figsize=(13,5.5),layout='constrained')
    labels_short=['Current','3 updates','6 + short','Loss allowance','Small probes','Market +2']
    losses=[max(0,-b['isolated_live_episode'][n]['episode']['pnl_eth']*usd) for n in selected]+[0]
    axs[0].barh(labels_short,losses,color=['#8396ad']*5+['#218c74'])
    axs[0].invert_yaxis();axs[0].set_xlabel('Net loss in the observed episode ($)')
    axs[0].set_title('Live episode: same starting halt\nSmall probes use modeled fills',fontsize=11)
    for i,v in enumerate(losses):axs[0].text(v+1,i,f'${v:.0f}',va='center')
    axs[0].set_xlim(0,125)
    for i,n in enumerate(selected):
        z=b['scenarios']['zero_recovery'][n]['14d'];x=100*z['pnl_eth']/base['14d']['pnl_eth'];y=z['dd_eth']*usd
        axs[1].scatter(x,y,s=65,color='#8396ad');axs[1].annotate(labels_short[i],(x,y),xytext=(5,6),textcoords='offset points',fontsize=9)
    x=100*best['14d']['pnl_eth']/base['14d']['pnl_eth'];y=best['14d']['dd_eth']*usd
    axs[1].scatter(x,y,s=90,color='#218c74');axs[1].annotate('Market +2',(x,y),xytext=(-55,12),textcoords='offset points',color='#146653')
    axs[1].set_xlabel('Modeled net profit retained (% of baseline)');axs[1].set_ylabel('Modeled peak-to-trough drawdown ($)')
    axs[1].set_title('14-day opportunity model: diagnostic only');axs[1].set_xlim(0,135);axs[1].set_ylim(0,600)
    for ax in axs:ax.spines[['top','right']].set_visible(False);ax.grid(axis='x',alpha=.15);ax.set_axisbelow(True)
    fig.suptitle('Recovery policy comparison',fontsize=16)
    fig.savefig(ROOT/'recovery_comparison.png',dpi=160);fig.savefig(ROOT/'recovery_comparison.svg');plt.close(fig)
    risks={}
    for n,z in c['zero'].items():
        risks[n]={f'worst_{h}h_dd_eth':rolling_dd(z['cash'],h) for h in [24,48]}
    (ROOT/'rolling_risk.json').write_text(json.dumps(risks,indent=2))
    source=[Path('bot/research')/n for n in ['recovery_policy_audit.py','recovery_policy_models.py',
        'recovery_policy_followup.py','recovery_policy_report.py','test_recovery_policy_audit.py','RECOVERY_POLICY_PROTOCOL.md']]
    source += [Path('bot/research')/n for n in ['market_guard_audit.py','guard_audit.py','market_guard_longer.py','market_guard_longer_fetch.py','exit_policy_audit.py']]
    source += [Path('v1/scripts/engine.py'),Path('v1/scripts/chainio.py')]
    frozen=ROOT/'source';frozen.mkdir(exist_ok=True)
    for p in source:(frozen/p.name).write_bytes(p.read_bytes())
    manifest=dict(snapshot=a['snapshot'],tests=69,checks=['daily cash reconciles','unique cash IDs','baseline real-data parity'],
                  files={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in source+[ROOT/'snapshot.json.gz',ROOT/'paths.db',ROOT/'recorded_results.json',ROOT/'model_paths.json',ROOT/'model_results.json',ROOT/'ablation_results.json']})
    (ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print('saved report and figures; aggregate checks passed')


if __name__=='__main__':main()
