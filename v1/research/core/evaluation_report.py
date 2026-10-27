"""Render the frozen policy evaluation and validate its accounting identities."""

import argparse
import collections
from pathlib import Path
from datetime import datetime, timezone

from .data import DAY, HOUR, digest, read_json, write_json
from .evaluation import iso
from .execution import describe

LABELS = {
    "market_plus2": "Current −1/+2",
    "market_plus1": "Recover at +1",
    "stale_hold": "Keep pause while stale",
    "recovery_direction": "Positive newest five",
    "recovery_breadth": "Gains without largest winner",
    "quarter_probe": "Staged smaller entries",
    "buyers_per_coin": "Buyer participation",
    "remove_tax_floor": "Remove tax floor",
    "remove_exempt_floor": "Remove exemption floor",
    "remove_template_loss": "Remove template-loss pause",
    "slow_sell": "1,200 ms delay",
    "fast_sell": "600 ms delay",
    "cached30": "30-second selector delay",
    "market_recovery": "Market recovery",
    "stale_reopening": "Stale reopening",
    "drawdown_reset": "DD reset",
    "operator_resume": "Operator resume",
    "touch_recovery": "Touch recovery",
}


def num(x, digits=5):
    return "unavailable" if x is None else f"{x:+.{digits}f}"


def stats(s, digits=4):
    return f'{num(s["mean"],digits)} / {num(s["median"],digits)} / {num(s["sd"],digits)} / {s["n"]}'


def table(headers, rows):
    return [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ] + ["| " + " | ".join(map(str, row)) + " |" for row in rows]


def chart(root, audit):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as dates
    import numpy as np

    raw = read_json(root / "snapshot.json.gz")
    start, end = audit["current_start"], audit["captured_at"]
    date = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc)
    plt.rcParams.update(
        {"font.size": 10, "axes.spines.top": False, "axes.spines.right": False}
    )
    fig, axes = plt.subplots(
        3, 1, figsize=(13, 9), sharex=True, gridspec_kw={"height_ratios": [1.3, 1, 0.8]}
    )
    total = 0
    xs = [date(start)]
    ys = [0]
    for row in sorted(audit["cash"], key=lambda r: r["at"]):
        total += row["pnl"] / 1e18
        xs.append(date(row["at"]))
        ys.append(total)
    xs.append(date(end))
    ys.append(total)
    axes[0].step(
        xs, ys, where="post", color="#236192", lw=2, label="Cumulative booked cash"
    )
    for i, r in enumerate(audit["resets"]):
        axes[0].axvline(
            date(r["at"]),
            color="#666666",
            ls="--",
            lw=0.9,
            label="Accounting reset" if i == 0 else None,
        )
    axes[0].axhline(0, color="#777777", lw=0.6)
    axes[0].set_ylabel("Cumulative cash (ETH)")
    axes[0].set_title(
        f"Current policy lost {abs(total):.5f} ETH across five accounting resets",
        loc="left",
        fontweight="bold",
        fontsize=16,
        pad=20,
    )
    axes[0].legend(loc="lower left", frameon=False, ncol=2)
    axes[0].annotate(
        f"{total:+.5f} ETH",
        xy=(date(end), total),
        xytext=(-6, 10),
        textcoords="offset points",
        ha="right",
        weight="bold",
    )
    guards = [
        r for r in raw["bot_guard_samples"] if r["live"] and start <= r["at"] <= end
    ]
    x = [date(r["at"]) for r in guards]
    values = [r["market"] if r["market_fresh"] else np.nan for r in guards]
    axes[1].plot(x, values, color="#236192", lw=1, label="Recorded fresh market score")
    axes[1].axhline(2, color="#555555", ls="--", lw=1, label="Recovery above +2")
    axes[1].axhline(-1, color="#888888", ls=":", lw=1, label="Pause below −1")
    axes[1].set_ylabel("Market score (stakes)")
    axes[1].legend(loc="upper left", frameon=False, ncol=3, fontsize=9)
    for e in audit["episodes"]:
        stale = e["kind"] == "stale_reopening"
        cash = e["cash"]["pnl_eth"]
        axes[2].bar(
            date(e["at"]),
            cash,
            width=0.018,
            color="#d97732" if stale else "#236192",
            edgecolor="#333333" if stale else None,
            hatch="//" if stale else None,
        )
    axes[2].axhline(0, color="#777777", lw=0.6)
    axes[2].set_ylabel("Cash per reopening (ETH)")
    axes[2].text(
        0.01,
        0.94,
        "Orange hatching: stale reopenings",
        transform=axes[2].transAxes,
        va="top",
        color="#8c451a",
    )
    for ax in axes:
        ax.axvspan(date(end - 6 * HOUR), date(end), color="#808080", alpha=0.10)
        ax.grid(axis="y", alpha=0.15)
        ax.set_xlim(date(start), date(end))
    axes[0].text(
        0.99,
        0.97,
        "Final six hours reserved",
        transform=axes[0].transAxes,
        ha="right",
        va="top",
        fontsize=9,
        color="#555555",
    )
    axes[2].xaxis.set_major_locator(dates.HourLocator(byhour=[0, 12]))
    axes[2].xaxis.set_major_formatter(
        dates.DateFormatter("%d Sep\n%H:%M", tz=timezone.utc)
    )
    axes[2].set_xlabel("UTC, 8–11 September 2026; capture at 09:29:47 on 11 September")
    fig.tight_layout(h_pad=2)
    fig.savefig(root / "cash-recoveries.png", dpi=160, bbox_inches="tight")
    fig.savefig(root / "cash-recoveries.svg", bbox_inches="tight")
    plt.close(fig)


def verify(root, audit, comparison, models):
    checks = {}
    actual = audit["actual"]
    checks["24h_cash_bins"] = sum(
        int(actual[f"24h_{i}"]["pnl_wei"]) for i in range(1, 9)
    ) == int(actual["24h"]["pnl_wei"])
    checks["7d_current_cash_bins"] = sum(
        int(actual[f"7d_{i}"]["pnl_wei"]) for i in range(1, 8)
    ) == int(actual["current"]["pnl_wei"])
    ids = [i for e in audit["episodes"] for i in e["position_ids"]]
    checks["episodes_unique"] = len(ids) == len(set(ids))
    checks["episodes_cover_actual"] = set(ids) == {r["id"] for r in audit["cash"]}
    checks["episodes_cash"] = sum(
        int(e["cash"]["pnl_wei"]) for e in audit["episodes"]
    ) == int(actual["current"]["pnl_wei"])
    checks["all_targets_per_launch"] = all(
        len(z["results"]) == 13 for z in models["tokens"].values()
    )
    checks["positive_stakes"] = all(z["size"] > 0 for z in models["tokens"].values())
    for name, run in comparison["policies"].items():
        checks["difference_" + name] = (
            abs(
                run["difference"]["net_change_eth"]
                - (
                    run["difference"]["extra_profit_eth"]
                    + run["difference"]["extra_loss_eth"]
                    - run["difference"]["profit_missed_eth"]
                    + run["difference"]["losses_avoided_eth"]
                    + run["difference"]["changed_shared_cash_eth"]
                )
            )
            < 1e-12
        )
        checks["unknown_not_ranked_" + name] = not run["qualifies"] or run["complete"]
    result = dict(
        checks=checks,
        passed=all(checks.values()),
        hashes={
            p.name: digest(p)
            for p in [
                root / "snapshot.json.gz",
                root / "audit.json",
                root / "models.json",
                root / "comparison.json",
            ]
        },
    )
    write_json(root / "evaluation-validation.json", result)
    if not result["passed"]:
        raise ValueError(
            "evaluation validation failed: "
            + str([k for k, v in checks.items() if not v])
        )
    return result


def report(root):
    from .fidelity import validation_status

    fidelity = validation_status(root)
    a = read_json(root / "audit.json")
    c = read_json(root / "comparison.json")
    m = read_json(root / "models.json")
    validation = verify(root, a, c, m)
    actual = a["actual"]["current"]
    end = a["captured_at"]
    start = a["current_start"]
    raw = read_json(root / "snapshot.json.gz")
    price = raw["state"]["truth"]["priceUsd"]
    stale = [e for e in a["episodes"] if e["kind"] == "stale_reopening"]
    recovered = [e for e in a["episodes"] if e["kind"] == "market_recovery"]
    baseline = c["policies"]["market_plus2"]
    paired = c["paired"]
    selected = c["selected"]
    lines = [
        f'Simulation realism: **{fidelity["status"]}**. '
        "Arithmetic and accounting checks alone do not validate hypothetical earnings.",
        (
            f'Scorecard: [{fidelity["report"]}]({fidelity["report"]})'
            if fidelity.get("report")
            else f'Scorecard unavailable: {fidelity["reason"]}.'
        ),
        "",
        f'The current policy lost {abs(actual["pnl_eth"]):.5f} ETH between {iso(start)} and {iso(end)}.',
        "",
        f'This is approximately ${abs(actual["pnl_eth"])*price:,.2f} at the captured ETH price of ${price:,.2f}. '
        f'The book contains {actual["completed_trades"]} completed trades and {actual["n"]-actual["completed_trades"]} failed attempts. '
        f'{actual["winners"]} of the {actual["completed_trades"]} trades won. '
        f'Cumulative closed-cash drawdown reached {actual["dd_eth"]:.5f} ETH across {len(a["resets"])} accounting resets.',
        "",
        (
            "No tested replacement meets the complete-account acceptance rule."
            if not selected
            else "These candidates meet the retrospective numerical rule: "
            + ", ".join(selected)
            + "."
        ),
        "No live code, settings, capital, restart, stop or resume was changed during this evaluation. "
        "The final six hours were excluded from fitting. All results remain retrospective.",
        "",
        "![Cumulative losses remain visible across resets, with recorded market scores and the cash after each reopening.](cash-recoveries.png)",
        "",
        "**Actual cash and recovery history**",
        "",
        "Amounts below are booked ETH after costs. Every statistical cell is mean / median / sample standard deviation / n. "
        "A stake is the amount spent on one entry. Target multiples compare the live resale mark with its entry mark, not with the stake.",
        "",
    ]
    lines += table(
        [
            "Period",
            "Trades / attempts",
            "Net ETH",
            "Drawdown ETH",
            "Cash per attempt: mean / median / sd / n",
        ],
        [
            [
                label,
                f'{a["actual"][key]["completed_trades"]} / {a["actual"][key]["n"]}',
                num(a["actual"][key]["pnl_eth"]),
                num(a["actual"][key]["dd_eth"]),
                stats(a["actual"][key]["cash_eth"], 6),
            ]
            for key, label in [
                ("current", "Current +2 era"),
                ("24h", "Last 24 hours"),
                ("48h", "Last 48 hours"),
                ("reserved6h", "Reserved six hours"),
            ]
        ],
    )
    lines += [
        "",
        f'{sum(e["cash"]["pnl_eth"] < 0 for e in recovered)} of {len(recovered)} '
        f"automatic market-recovery episodes lost money. Together they booked "
        f'{num(sum(e["cash"]["pnl_eth"] for e in recovered))} ETH.',
        "",
        f'The {len(stale)} stale reopenings admitted {sum(e["cash"]["n"] for e in stale)} attempts and booked '
        f'{num(sum(e["cash"]["pnl_eth"] for e in stale))} ETH. '
        "They did not require the score to recover above +2.",
        "",
    ]
    lines += table(
        [
            "Armed at, UTC",
            "Cause",
            "Attempts",
            "Net ETH",
            "Added outcome profit",
            "Added outcome losses",
            "Old losses leaving",
            "Old profit leaving",
        ],
        [
            [
                iso(e["at"]).replace("2026-", "").replace("+00:00", ""),
                LABELS.get(e["kind"], e["kind"]),
                e["cash"]["n"],
                num(e["cash"]["pnl_eth"]),
                num(e["movement"]["added_profit"], 3),
                num(e["movement"]["added_losses"], 3),
                num(e["movement"]["removed_losses"], 3),
                num(e["movement"]["removed_profit"], 3),
            ]
            for e in a["episodes"]
        ],
    )
    lines += [
        "",
        "The four score-change columns are observation stakes, not ETH available to the wallet. "
        "They compare the last recorded venue pause with the window at arming. "
        "Removed losses can lift a score without creating a new profitable launch. "
        "A drawdown reset can occur while another stop still prevents entries.",
        "",
        f'The reconstructed score matched {a["sensor_check"]["exact"]:,} of {a["sensor_check"]["n"]:,} guard samples exactly. '
        f'The remaining {a["sensor_check"]["n"]-a["sensor_check"]["exact"]:,} samples constrain timing precision. '
        "Native scoring timestamps and cached live readings are not the same clock.",
        "",
    ]
    lines += [
        "**Priced opportunities skipped before each reopening**",
        "",
        "These are individual book-compatible launches recorded as rejected by a halt. "
        "The sums are hypothetical opportunity returns without account capacity or stops. "
        "They show known profitable opportunities and known losing opportunities inside each actual pause.",
        "",
    ]
    lines += table(
        [
            "Reopened, UTC",
            "Known / expected",
            "Missing",
            "Price guard rejects",
            "Positive outcomes ETH",
            "Negative outcomes ETH",
        ],
        [
            [
                iso(e["at"]),
                f'{e["opportunities"]["known"]} / {e["opportunities"]["expected"]}',
                e["opportunities"]["unavailable"],
                e["opportunities"]["entry_price_rejected"],
                num(e["opportunities"]["windows"]["current"]["profit_eth"]),
                num(e["opportunities"]["windows"]["current"]["loss_eth"]),
            ]
            for e in paired["skipped_before_recovery"]
        ],
    ) + [""]
    lines += [
        "**Entry-filter verdicts**",
        "",
        "These tests isolate the 50 bps tax floor, the three-exemption entry floor and the 60-minute repeat-loss pause. "
        "The 200 bps ceiling, one-exemption screen floor and static template screen remain outside these ablations. "
        "Other entry filters are held fixed in each paired group. "
        "Both groups use the same stake, entry timing, target selector, delays and gas method.",
        "",
    ]
    filter_rows = []
    for name, value in paired["filters"].items():
        rejected = value["rejected"]
        admitted = value["admitted"]
        r = rejected["windows"]["current"]
        b = admitted["windows"]["current"]
        if not r["n"] or not b["n"]:
            verdict = "Insufficient executable outcomes"
        elif (
            r["cash_eth"]["mean"] <= 0
            and r["cash_eth"]["mean"] <= b["cash_eth"]["mean"]
        ):
            verdict = "Rejection supported within the priced sample"
        elif r["cash_eth"]["mean"] > 0:
            verdict = "Rejected launches include profitable opportunities; removal unvalidated"
        else:
            verdict = "No demonstrated benefit from removing this filter"
        filter_rows.append([name, verdict])
        for label, group in [("Admitted", admitted), ("Rejected", rejected)]:
            z = group["windows"]["current"]
            lines += [f"**{name}: {label.lower()} group**", ""]
            lines += table(
                [
                    "Known / expected",
                    "Missing",
                    "Price guard rejects",
                    "Net ETH",
                    "Return %: mean / median / sd / n",
                    "24h ETH",
                    "Reserved 6h ETH",
                ],
                [
                    [
                        f'{group["known"]} / {group["expected"]}',
                        group["unavailable"],
                        group["entry_price_rejected"],
                        num(z["pnl_eth"]),
                        stats(z["returns_pct"]),
                        num(group["windows"]["24h"]["pnl_eth"]),
                        num(group["windows"]["reserved6h"]["pnl_eth"]),
                    ]
                ],
            ) + [""]
    lines += table(["Filter", "Verdict"], filter_rows) + [
        "",
        "These are sums over individual opportunities. They do not apply capital or account stops. "
        "The account comparison below includes those constraints. Missing outcomes are not assigned zero.",
        "",
        "**Profit-exit verdicts**",
        "",
        f'All eight exits share {paired["exit_paired"]} complete paths out of {paired["exit_expected"]} book-compatible opportunities. '
        "This common sample avoids comparing a target with only its surviving outcomes. "
        "Entry-price rejections and unavailable executions are excluded from the common sample. "
        "Their counts remain in the opportunity coverage tables.",
        "",
    ]
    lines += table(
        [
            "Exit",
            "Net ETH",
            "Fit ETH",
            "Reserved 6h ETH",
            "Difference from adaptive ETH",
            "Return %: mean / median / sd / n",
            "Paired verdict",
        ],
        [
            [
                name,
                num(z["windows"]["current"]["pnl_eth"]),
                num(z["windows"]["fit"]["pnl_eth"]),
                num(z["windows"]["reserved6h"]["pnl_eth"]),
                num(
                    z["windows"]["current"]["pnl_eth"]
                    - paired["exits"]["adaptive"]["windows"]["current"]["pnl_eth"]
                ),
                stats(z["windows"]["current"]["returns_pct"]),
                (
                    "Baseline"
                    if name == "adaptive"
                    else (
                        "Higher paired profit"
                        if z["windows"]["current"]["pnl_eth"]
                        > paired["exits"]["adaptive"]["windows"]["current"]["pnl_eth"]
                        else "No paired profit improvement"
                    )
                ),
            ]
            for name, z in paired["exits"].items()
        ],
    )
    selector = m["selector"]
    selector_check = read_json(root / "selector-check.json")
    completed_ids = {r["id"] for r in a["cash"] if r.get("is_trade")}
    cal = [
        r["gap_pp"]
        for r in m["calibration"]
        if r["gap_pp"] is not None and r["id"] in completed_ids
    ]
    tp = a["execution"]["current_tp"]
    modeled_tp = paired["tp_execution"]
    lines += [
        "",
        f'The broader observation population reproduced {sum(r["matches"] for r in selector)} of {len(selector)} recorded adaptive targets. '
        f'All {selector_check["either_matches"]} targets match either the newest window or the 30-second earlier window. '
        "The remaining exact-time differences include cached-read timing and later score updates. "
        "The 30-second cache-delay comparison retains that uncertainty.",
        "",
        f'{sum(r["booked_eth"]<0 for r in tp)} of {len(tp)} actual take-profit exits booked a loss. '
        f'Observed decision-to-close delay, in milliseconds: {stats(a["execution"]["current_delay_ms"],1)}. '
        "That interval includes receipt confirmation. The model fits only preceding delays and tests 600 ms and 1,200 ms separately.",
        "",
        f'{sum(r["pnl_eth"] < 0 for r in modeled_tp)} of {len(modeled_tp)} modeled take-profit exits booked a loss. '
        f'Trigger mark minus executable proceeds, in ETH: {stats(describe(r["value_lost_eth"] for r in modeled_tp),6)}. '
        "Negative values mean proceeds exceeded the trigger mark. A take-profit trigger does not guarantee a profitable fill.",
        "",
        f"Replay minus actual completed-trade cash, in percentage points of stake: {stats(describe(cal))}. "
        "This is a calibration limit, not a correction applied to turn hypothetical profit into cash.",
        "",
        "**Account and recovery-rule verdicts**",
        "",
        "These paths preserve recorded operator controls, the starting drawdown, position capacity, template feedback and account stops. "
        "Cash never resets when an accounting epoch changes. "
        "An admitted unknown execution stops the path and keeps its holding unresolved. "
        "Incomplete rows below show only the known prefix and cannot rank.",
        "Recent direction requires a positive sum for the newest five outcomes before market recovery. "
        "Breadth requires positive gains after removing the largest winner, for market and drawdown recovery. "
        "The existing staged-entry preset uses 0.005, 0.01 and 0.02 ETH. "
        "It advances after at least three completed trades with positive total cash at a stage. "
        "Its separate drawdown stop is 0.005 ETH.",
        "",
    ]
    rows = []
    for name, r in c["policies"].items():
        reason = (
            "Passes retrospective rule"
            if r["qualifies"]
            else (
                "Incomplete evidence"
                if not r["complete"]
                else "Does not pass replacement rule"
            )
        )
        if name == "market_plus2":
            reason = "Baseline" if r["complete"] else "Baseline incomplete"
        elif r["complete"] and not r["qualifies"]:
            if r["recovery"]["losing_n"] > baseline["recovery"]["losing_n"]:
                reason = "More losing recoveries"
            elif (
                r["windows"]["current"]["pnl_eth"]
                < baseline["windows"]["current"]["pnl_eth"]
            ):
                reason = "Lower net profit"
            elif (
                r["windows"]["fit"]["pnl_eth"] == baseline["windows"]["fit"]["pnl_eth"]
            ):
                reason = (
                    "Gain only in reserved period"
                    if r["difference"]["net_change_eth"] > 0
                    else "No change in account results"
                )
        rows.append(
            [
                LABELS.get(name, name),
                r["windows"]["current"]["n"],
                num(r["windows"]["current"]["pnl_eth"]),
                num(r["windows"]["current"]["dd_eth"]),
                r["recovery"]["losing_n"],
                num(r["recovery"]["loss_eth"]),
                reason,
            ]
        )
    lines += table(
        [
            "Policy",
            "Known closes",
            "Known cash ETH",
            "Cumulative DD ETH",
            "Losing recoveries",
            "Recovery losses ETH",
            "Verdict",
        ],
        rows,
    )
    unresolved_rows = [
        [
            LABELS.get(name, name),
            iso(r["unresolved"][0]["at"]),
            r["unresolved"][0].get("detail") or r["unresolved"][0]["reason"],
        ]
        for name, r in c["policies"].items()
        if r["unresolved"]
    ]
    if unresolved_rows:
        lines += [
            "",
            "The first unavailable execution in each path is recorded below.",
            "",
        ]
        lines += table(
            ["Policy", "Evidence ends, UTC", "Missing execution"], unresolved_rows
        )
    lines += [
        "",
        "Profit captured, profit missed and losses avoided relative to the same baseline are listed below. "
        "If either path becomes unresolved, both sides are truncated at the earlier unresolved entry. "
        "Later baseline losses are never called losses avoided.",
        "",
    ]
    lines += table(
        [
            "Policy",
            "Extra profit ETH",
            "Extra losses ETH",
            "Profit missed ETH",
            "Losses avoided ETH",
            "Changed shared cash ETH",
            "Net difference ETH",
        ],
        [
            [LABELS.get(name, name)]
            + [
                num(r["difference"][k])
                for k in (
                    "extra_profit_eth",
                    "extra_loss_eth",
                    "profit_missed_eth",
                    "losses_avoided_eth",
                    "changed_shared_cash_eth",
                    "net_change_eth",
                )
            ]
            for name, r in c["policies"].items()
            if name != "market_plus2"
        ],
    )
    lines += [
        "",
        "**Recorded-fill permission check**",
        "",
        "This check retains actual sizes, fills and costs. It can remove an actual trade. "
        "It cannot price a newly admitted trade or a smaller stake. "
        "Its baseline excludes actual positions 2385 and 2386 because the reconstructed touch gate differs from the recorded gate. "
        "Those two positions account for the 0.01074 ETH difference from actual cash. Historical sensor and process timing remain incomplete.",
        "",
    ]
    lines += table(
        [
            "Policy",
            "Known cash ETH",
            "DD ETH",
            "Losing recoveries",
            "Complete supplied-fill path",
        ],
        [
            [
                LABELS.get(name, name),
                num(r["windows"]["current"]["pnl_eth"]),
                num(r["windows"]["current"]["dd_eth"]),
                r["recovery"]["losing_n"],
                r["complete"],
            ]
            for name, r in c["recorded_conditional"].items()
        ],
    )
    lines += [
        "",
        "**Required time windows**",
        "",
        "All bins end at capture. Earlier policy eras are unavailable for current-policy inference. "
        "The daily table also shows booked cash from all recorded eras of the main book for context.",
        "",
    ]
    for prefix, count in [("24h", 8), ("7d", 7)]:
        rows = []
        for i in range(1, count + 1):
            z = a["actual"][f"{prefix}_{i}"]
            old = a["all_era_actual"][f"{prefix}_{i}"]
            rows.append(
                [
                    iso(old["from_ms"]).replace("+00:00", ""),
                    iso(z["to_ms"]).replace("+00:00", ""),
                    z["n"] if z["available"] else "outside era",
                    num(z["pnl_eth"]) if z["available"] else "unavailable",
                    stats(z["cash_eth"], 6) if z["available"] else "unavailable",
                    num(old["pnl_eth"]),
                ]
            )
        lines += table(
            [
                "From, UTC",
                "To, UTC",
                "Current attempts",
                "Current cash ETH",
                "Current cash: mean / median / sd / n",
                "All-era cash ETH",
            ],
            rows,
        ) + [""]
    lines += [
        "**Remaining evidence limits and reproducibility**",
        "",
        "No prospective validation is claimed. New observations must occur after this capture. "
        "No combination was promoted on the basis of retrospective threshold searches. "
        "Repeated searches can overfit even when a final block is reserved. "
        "[Bailey et al., The Probability of Backtest Overfitting](https://scholarworks.wmich.edu/math_pubs/42/).",
        "",
        "Historical feed arrival within a block is unavailable. The model assumes fixed external order quantities after the hypothetical entry. "
        "Recorded decision-to-send delays and position clock origins are retained. "
        "Untraded entries use preceding same-era timing medians. Send time is a proxy for execution because subsecond inclusion time is unavailable. "
        "A graduated pool or diverging path remains unavailable unless its execution can be established. "
        "The sample cannot establish the value of relaxing the hard screening rules outside the entry-filter tests.",
        "",
    ]
    receipts = read_json(root / "receipt-check.json")
    coverage = collections.Counter(
        z["results"]["adaptive"]["status"] for z in m["tokens"].values()
    )
    lines += table(
        ["Adaptive opportunity status", "Count"], sorted(coverage.items())
    ) + [""]
    benchmark_path = root / "replay/benchmark.json"
    if benchmark_path.exists():
        benchmark = read_json(benchmark_path)["coverage"]
        lines += [
            f'The production arithmetic replay matched {benchmark["exact_matches"]} of '
            f'{benchmark["checked_transactions"]} checked transactions exactly. '
            f'Taxes were independently checked on {benchmark["independently_checked_taxes"]} transactions. '
            "[Execution benchmark](replay/benchmark.json).",
            "",
        ]
    lines += [
        f'{receipts["independent_matches"]} of {receipts["n"]} attempts independently reconcile from '
        f'{receipts["receipts"]} buy, sale and approval receipts. '
        "Failed attempts retain their gas costs. [Receipt verification](receipt-check.json).",
        "",
    ]
    wr = a["wallet_reconciliation"]
    if wr:
        lines += [
            f'The flat wallet samples differ from booked cash by {int(wr["gap_wei"])/1e18:+.12f} ETH. '
            "The discrepancy is localized to positions 2321 and 2336. Their buy, approval and sell receipt gas agrees with historical block-balance changes. "
            "The small remaining interval difference is unresolved and is not added to modeled profit.",
            "",
        ]
    lines += [
        "Inputs and outputs are local, read-only research artifacts:",
        "",
        "- [Frozen input](snapshot.json.gz), [raw SQLite and live-source capture](raw/capture.tar.gz).",
        "- [Loss and recovery reconstruction](audit.json), [all modeled opportunities](models.json).",
        "- [Complete comparisons and per-policy bins](comparison.json), [validation identities](evaluation-validation.json).",
        "- [Model source archive](model-provenance.json), [comparison source archive](comparison-provenance.json).",
        "- [Running-source parity checks](source-verification.json), [receipt and wallet gas checks](wallet-gas-check.json).",
        "",
        f'Snapshot SHA-256: `{a["snapshot_sha256"]}`. All {len(validation["checks"])} output identity checks passed.',
        "",
    ]
    (root / "report.md").write_text("\n".join(lines))
    chart(root, a)
    return root / "report.md"


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    args = p.parse_args()
    print(report(args.root))
