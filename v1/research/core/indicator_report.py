"""Charts and complete comparison tables for the registered indicator experiment."""

from datetime import datetime, timezone

from .data import HOUR, DAY, write_json
from .evaluation import iso
from .execution import describe
from .guard_visual import close_cash
from .indicators import SignalRule

LABELS = {
    "native20_control": "Native 20, candidate freshness",
    "fixed_cost20": "Fixed TP, actual-sized net returns",
    "fixed_shadow20": "Fixed TP, shadow-admitted coins",
    "market_plus2": "Existing guard",
    "stale_hold": "Hold stale pause",
    "continuous": "Continuous (all account stops off)",
    "native10": "Native window 10",
    "native40": "Native window 40",
    "matched20": "Matched window 20",
    "matched20_zero": "Matched 20, zero boundary",
    "native_ewma": "Native exponential",
    "matched_ewma": "Matched exponential",
    "recent_profit": "Recent profit > 0",
    "direction_entry": "Direction at entry",
    "direction_retreat": "Direction at entry + retreat",
    "staged": "Staged exposure",
    "staged_budget": "Staged + probe loss cap",
}


def eth(x):
    return f"{int(x)/1e18:+.5f}"


def stats(d):
    def f(v):
        return "n/a" if v is None else f"{v:.5f}"

    return f"{f(d['mean'])} / {f(d['median'])} / {f(d['sd'])} / {d['n']}"


def diagnostic_verdict(result, name):
    tests = result["acceptance"][name]
    if tests["passed"]:
        return "Passes registered diagnostic comparisons; realism and prospective validation still fail."
    c = tests["checks"]["adaptive"]
    fit = [k for k, v in c["fit"]["checks"].items() if not v]
    reserved = [k for k, v in c["reserved"]["checks"].items() if not v]
    stress = not all(x["passed"] for v in tests["checks"].values() for x in v.values())
    details = []
    if fit:
        details.append("Fit fails: " + ", ".join(fit))
    if reserved:
        details.append("Reserved fails: " + ", ".join(reserved))
    if stress and not fit and not reserved:
        details.append("Execution stress fails")
    if tests["sensitivity"] and not all(
        x["passed"] for v in tests["sensitivity"].values() for x in v.values()
    ):
        details.append("Timing/half-life robustness fails")
    return "; ".join(details) or "Full-period comparison fails"


def render(raw, r, tapes, out):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as md
    import numpy as np

    plt.rcParams.update(
        {
            "font.size": 10,
            "axes.titlesize": 12,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "savefig.facecolor": "white",
        }
    )
    dt = lambda t: datetime.fromtimestamp(t / 1000, timezone.utc)
    end, start, cut = r["end"], r["start"], r["cut"]
    highlight = r["display_candidate"]
    colors = {
        "actual": "#202020",
        "market_plus2": "#2465a4",
        "continuous": "#ae6626",
        highlight: "#008d84",
        "recent_profit": "#8b4e9f",
    }
    keys = list(
        dict.fromkeys(["market_plus2", "continuous", highlight, "recent_profit"])
    )
    recent = SignalRule("plot", smooth=True, on=0, off=0)
    plot_rows = []
    for at in range(start, end, 60000):
        s = tapes["matched"].estimate(at, recent)
        plot_rows.append(dict(at=at, **s))
    for hours in (24, 48):
        lo = max(start, end - hours * HOUR)
        fig, axs = plt.subplots(
            6,
            1,
            figsize=(15, 17),
            sharex=True,
            gridspec_kw={"height_ratios": [2.1, 1.3, 1.4, 0.8, 0.8, 1.2]},
        )
        fig.suptitle(
            "Does fresh profitability warn before the rolling guard?",
            fontsize=18,
            x=0.075,
            ha="left",
            y=0.987,
        )
        fig.text(
            0.075,
            0.96,
            f"{iso(lo)} to {iso(end)} | TP and filters fixed | Diagnostic simulation; final six hours shaded",
            fontsize=10,
        )
        for key in ["actual"] + keys:
            rows = r["actual"] if key == "actual" else close_cash(r["runs"][key])
            rows = sorted(
                [x for x in rows if lo <= x["at"] < end],
                key=lambda x: (x["at"], str(x["id"])),
            )
            total = 0
            xx = [dt(lo)]
            yy = [0]
            for row in rows:
                total += row["pnl"]
                xx.append(dt(row["at"]))
                yy.append(total / 1e18)
            xx.append(dt(end))
            yy.append(total / 1e18)
            label = "Actual guarded cash" if key == "actual" else LABELS[key]
            axs[0].step(
                xx,
                yy,
                where="post",
                label=f"{label}: {total/1e18:+.4f} ETH",
                color=colors[key],
                lw=1.8,
                ls="--" if key == "continuous" else "-.",
            )
        axs[0].set_ylabel("Cumulative net ETH\n(rebased at chart start)")
        handles, labels = axs[0].get_legend_handles_labels()
        fig.legend(
            handles,
            labels,
            loc="upper left",
            bbox_to_anchor=(0.17, 0.947),
            fontsize=9,
            ncol=2,
            frameon=False,
        )
        axs[0].set_title(
            "1. Account cash at close; actual and hypothetical remain separate",
            loc="left",
        )
        samples = [
            s for s in raw["bot_guard_samples"] if s.get("live") and lo <= s["at"] < end
        ]
        xs, ys = [], []
        previous = None
        for s in samples:
            if previous is not None and s["at"] - previous > 60000:
                xs.append(dt(previous + 1))
                ys.append(float("nan"))
            xs.append(dt(s["at"]))
            ys.append(
                s["market"]
                if s.get("market_fresh") and s.get("market") is not None
                else float("nan")
            )
            previous = s["at"]
        axs[1].plot(xs, ys, color="#2465a4", lw=1)
        for y in (-1, 2):
            axs[1].axhline(y, color="#777", ls="--", lw=0.8)
        axs[1].set_ylabel("Recorded stakes")
        axs[1].set_title("2. Existing fixed-1.75 score, with recorded gaps", loc="left")
        z = [s for s in plot_rows if s["at"] >= lo]
        xx = [dt(s["at"]) for s in z]
        axs[2].plot(
            xx,
            [100 * s["value"] if s["fresh"] else np.nan for s in z],
            color="#008d84",
            label="Recent matched profitability",
        )
        axs[2].plot(
            xx,
            [100 * s["slow"] if s["fresh"] else np.nan for s in z],
            color="#777",
            ls="--",
            label="Slower context",
        )
        axs[2].axhline(0, color="black", lw=0.7)
        axs[2].set_ylabel("Estimated net return\n(% of stake)")
        axs[2].set_title(
            "3. Results enter only after close and recorded publication", loc="left"
        )
        axs[2].legend(loc="upper left", ncol=2, fontsize=9)
        axs[3].plot(
            xx,
            [
                s["newest_age_min"] if s["newest_age_min"] is not None else np.nan
                for s in z
            ],
            color="#ae6626",
            label="Newest launch age (minutes)",
        )
        axs[4].plot(
            xx,
            [s["effective_n"] for s in z],
            color="#2465a4",
            ls="--",
            label="Effective observation count",
        )
        axs[3].set_ylabel("Minutes")
        axs[3].set_title(
            "4. Newest underlying launch age; gaps never create permission",
            loc="left",
        )
        axs[3].legend(loc="upper left", ncol=2, fontsize=9)
        axs[4].set_ylabel("Effective count")
        axs[4].set_title("5. Effective sample size after weighting", loc="left")
        axs[4].axhline(4, color="#777", ls=":", lw=0.8)
        state_keys = list(dict.fromkeys(["market_plus2", "recent_profit", highlight]))
        for i, key in enumerate(state_keys):
            run = r["runs"][key]
            reads = [v for v in run["readings"] if lo <= v["at"] < end]
            for j, row in enumerate(reads):
                until = reads[j + 1]["at"] if j + 1 < len(reads) else end
                if not row["halts"] and until > row["at"]:
                    axs[5].broken_barh(
                        [(md.date2num(dt(row["at"])), (until - row["at"]) / DAY)],
                        (i - 0.3, 0.6),
                        facecolors=colors.get(key, "#777"),
                        alpha=0.20,
                    )
            entered = [
                d
                for d in run["decisions"]
                if d["reason"] is None and lo <= d["at"] < end
            ]
            axs[5].scatter(
                [dt(d["at"]) for d in entered],
                [i] * len(entered),
                marker="|",
                s=90,
                color=colors.get(key, "#777"),
                linewidths=1.2,
            )
        axs[5].set_yticks(
            range(len(state_keys)),
            [LABELS[k] for k in state_keys],
            fontsize=9,
        )
        axs[5].set_title(
            "6. Stop permissions (pale bands); admitted trades (dark ticks). Probe budget still applies.",
            loc="left",
        )
        for ax in axs:
            ax.axvspan(dt(max(lo, cut)), dt(end), color="#b9b9b9", alpha=0.15)
            ax.grid(axis="y", alpha=0.16)
            ax.set_xlim(dt(lo), dt(end))
        axs[-1].xaxis.set_major_formatter(
            md.DateFormatter("%d %b\n%H:%M", tz=timezone.utc)
        )
        axs[-1].set_xlabel("UTC")
        fig.text(
            0.075,
            0.015,
            f"Highlight: {LABELS[highlight]}, chosen by fit-period net cash only. Full verdict and all candidates are in report.md.",
            fontsize=9,
        )
        fig.subplots_adjust(top=0.89, bottom=0.065, left=0.17, right=0.985, hspace=0.42)
        fig.savefig(out / f"indicator-{hours}h.png", dpi=150)
        plt.close(fig)
    names = [k for k in r["acceptance"]]
    fig, ax = plt.subplots(figsize=(13, 8))
    y = np.arange(len(names))
    width = 0.25
    for i, (variant, label, color) in enumerate(
        (
            ("adaptive", "Central delay", "#2465a4"),
            ("fast_sell", "600 ms sell delay", "#ae6626"),
            ("slow_sell", "1,200 ms sell delay", "#008d84"),
        )
    ):
        vals = [
            int(r["scorecards"][variant][k]["full"]["cash"]["net_wei"]) / 1e18
            for k in names
        ]
        ax.barh(y + (i - 1) * width, vals, height=width, label=label, color=color)
    ax.axvline(0, color="black", lw=0.8)
    ax.set_yticks(y, [LABELS[k] for k in names])
    ax.invert_yaxis()
    ax.set_xlabel("48-hour net ETH, after modeled costs")
    ax.set_title(
        "Every candidate, under three execution assumptions", loc="left", pad=16
    )
    ax.legend(loc="upper right")
    ax.grid(axis="x", alpha=0.15)
    fig.tight_layout()
    fig.savefig(out / "candidate-comparison.png", dpi=150)
    plt.close(fig)
    report(r, out, plot_rows)


def report(r, out, plot_rows):
    lines = [
        "# Indicator policy experiment",
        "",
        "No candidate is approved for live use. These are diagnostic, retrospective comparisons.",
        "",
        f"Capture: {iso(r['end'])}. Common account interval: {iso(r['start'])} to capture.",
        f"Reserved boundary: {iso(r['cut'])}. Earlier current-policy data and previously viewed reserved data remain retrospective.",
        "",
        f"Current strategy era starts {iso(r['era_start'])}. Older weekly bins are historical accounting only.",
        "",
        "## Actual cash and simulated candidates",
        "",
        "Net cash includes gas. Winning profit and losing loss are sums of whole attempts. Drawdown is cumulative closed-cash drawdown across resets. All amounts below are ETH.",
        "",
        "| Policy | Attempts | Winning profit | Losing loss | Net cash | Drawdown | Losing recoveries / all nonempty recoveries | Recovery loss |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    a = r["actual_cash"]["full"]
    lines.append(
        f"| Actual guarded cash | {a['n']} | {eth(a['profit_wei'])} | {eth(a['loss_wei'])} | {eth(a['net_wei'])} | {eth(a['drawdown_wei'])} | See actual guard timeline | n/a |"
    )
    for name, z in r["scorecards"]["adaptive"].items():
        m = z["full"]
        c = m["cash"]
        lines.append(
            f"| {LABELS[name]} | {c['n']} | {eth(c['profit_wei'])} | {eth(c['loss_wei'])} | {eth(c['net_wei'])} | {eth(c['drawdown_wei'])} | {m['losing_recoveries']} / {len(m['recovery_episodes'])} | {eth(m['recovery_loss_wei'])} |"
        )
    lines += [
        "",
        "## Attribution controls",
        "",
        "Each row compares one named step with its reference. Execution adjustment changes stake and cost realism together. Exponential variants also change evidence freshness, so their difference is not a pure smoothing estimate.",
        "",
        "| Change | Reference | Fit net difference ETH | Reserved net difference ETH | Full DD difference ETH |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    for name, reference in r["attribution_pairs"]:
        a, b = r["scorecards"]["adaptive"][name], r["scorecards"]["adaptive"][reference]
        lines.append(
            f"| {LABELS[name]} | {LABELS[reference]} | {eth(int(a['fit']['cash']['net_wei'])-int(b['fit']['cash']['net_wei']))} | {eth(int(a['reserved']['cash']['net_wei'])-int(b['reserved']['cash']['net_wei']))} | {eth(int(a['full']['cash']['drawdown_wei'])-int(b['full']['cash']['drawdown_wei']))} |"
        )
    lines += [
        "",
        "## Fit and reserved results",
        "",
        "The reserved six hours never select thresholds or the chart highlight. Every candidate was specified before its returns were evaluated.",
        "",
        "| Policy | Fit net | Reserved net | Fit DD | Reserved DD | Verdict |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for name, z in r["scorecards"]["adaptive"].items():
        f, h = z["fit"]["cash"], z["reserved"]["cash"]
        verdict = (
            diagnostic_verdict(r, name) if name in r["acceptance"] else "Reference"
        )
        lines.append(
            f"| {LABELS[name]} | {eth(f['net_wei'])} | {eth(h['net_wei'])} | {eth(f['drawdown_wei'])} | {eth(h['drawdown_wei'])} | {verdict} |"
        )
    lines += [
        "",
        "## Execution sensitivity",
        "",
        "Central signal evidence is identical across sell-delay scenarios. Candidate account outcomes, capacity and cooldown can differ.",
        "",
        "| Policy | Central net | 600 ms net | 1,200 ms net | Complete account paths |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for name in r["runs"]:
        ms = [
            r["scorecards"][v][name]["full"]
            for v in ("adaptive", "fast_sell", "slow_sell")
        ]
        lines.append(
            f"| {LABELS[name]} | "
            + " | ".join(eth(m["cash"]["net_wei"]) for m in ms)
            + f" | {sum(m['complete'] and not m['unclosed_entries'] for m in ms)} / 3 |"
        )
    lines += [
        "",
        "## Signal robustness",
        "",
        "These fixed half-life and publication-delay changes are sensitivity checks, not a threshold search.",
        "",
        "| Policy / perturbation | Fit net | Reserved net | Full net | Full DD |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for name, z in r["sensitivity"].items():
        lines.append(
            f"| {name} | {eth(z['fit']['cash']['net_wei'])} | {eth(z['reserved']['cash']['net_wei'])} | {eth(z['full']['cash']['net_wei'])} | {eth(z['full']['cash']['drawdown_wei'])} |"
        )
    lines += [
        "",
        "## Start-date stress",
        "",
        "This post-hoc check asks whether the capped policy benefited from its initial market segment. Each row is a separate hypothetical inception, followed through the same capture. It is not permission to reset the allowance, and the rows must not be added together.",
        "",
        "| Inception UTC | Existing guard net ETH | Staged net ETH | Capped staged net ETH | Capped attempts |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for row in r["inception_stress"]:
        z = row["policies"]
        lines.append(
            f"| {iso(row['start'])} | {eth(z['market_plus2']['cash']['net_wei'])} | {eth(z['staged']['cash']['net_wei'])} | {eth(z['staged_budget']['cash']['net_wei'])} | {z['staged_budget']['cash']['n']} |"
        )
    cap = r["runs"]["staged_budget"]
    admitted = [d for d in cap["decisions"] if d["reason"] is None]
    lines += [
        "",
        f"Main capped path: {len(admitted)} admissions; last admission {iso(admitted[-1]['at']) if admitted else 'none'}. Gross probe losses were {eth(cap['probe_loss_wei'])} ETH. The remaining allowance must cover the next probe's whole stake and estimated gas.",
    ]
    lines += [
        "",
        "## Profit captured, missed and losses avoided",
        "",
        "The next table compares each candidate with continuous trading. Shared trades can have different stake outcomes. Displacement and shared-cash changes are preserved in comparison.json; the columns are not an additive net-profit formula.",
        "",
        "| Policy | Captured winning profit | Missed continuous winning profit | Avoided continuous losing loss |",
        "| --- | ---: | ---: | ---: |",
    ]
    for name, z in r["scorecards"]["adaptive"].items():
        d = r["missed_vs_continuous"][name]
        lines.append(
            f"| {LABELS[name]} | {eth(z['full']['cash']['profit_wei'])} | {eth(d['extra_profit_wei'])} | {eth(d['extra_loss_wei'])} |"
        )
    lines += [
        "",
        "## Does the signal predict subsequent opportunities?",
        "",
        "Anchors are 15 minutes apart. The next-five cohorts can overlap, so their counts are not independent samples. Next-15-minute entry cohorts do not overlap. Only completed outcomes inside the fit or reserved partition contribute. A return is net profit divided by its historical stake.",
        "",
        "| Partition / horizon / signal | Future cohort net ETH: mean / median / sample SD / n | Profitable cohorts / all | Repeated outcome memberships / all |",
        "| --- | --- | ---: | ---: |",
    ]
    for name, z in r["forward"]["summaries"].items():
        lines.append(
            f"| {name} | {stats(z['net_per_cohort_eth'])} | {z['positive_cohorts']} / {z['cohort_n']} | {z['repeated_memberships']} / {z['outcome_memberships']} |"
        )
    lines += [
        "",
        "### Alternative indicators on the same subsequent opportunities",
        "",
        "Positive means the estimate is above zero, independently of each guard's reopening threshold. The comparison separates predictive information from account policy.",
        "",
        "| Indicator / partition / horizon / signal | Future cohort net ETH: mean / median / sample SD / n | Profitable cohorts / all |",
        "| --- | --- | ---: |",
    ]
    for indicator, result in r["forward_indicators"].items():
        for name, z in result["summaries"].items():
            if name.endswith(("positive_improving", "positive_weakening")):
                continue
            lines.append(
                f"| {indicator}/{name} | {stats(z['net_per_cohort_eth'])} | {z['positive_cohorts']} / {z['cohort_n']} |"
            )
    lines += [
        "",
        "## Per-attempt cash distributions",
        "",
        "| Policy | Net ETH: mean / median / sample SD / n |",
        "| --- | --- |",
    ]
    lines.append(f"| Actual | {stats(r['actual_cash']['full']['cash_eth'])} |")
    for name, z in r["scorecards"]["adaptive"].items():
        lines.append(f"| {LABELS[name]} | {stats(z['full']['cash']['cash_eth'])} |")
    ages = describe(
        x["newest_age_min"] for x in plot_rows if x["newest_age_min"] is not None
    )
    effective = describe(x["effective_n"] for x in plot_rows)
    lines += [
        "",
        f"Newest shadow launch age, sampled each minute: mean / median / sample SD / n = {stats(ages)} minutes.",
        f"Effective observation count, sampled each minute: mean / median / sample SD / n = {stats(effective)}.",
        "",
        "## Required time bins",
        "",
        "Unavailable simulated bins are shown as unavailable, including bins that begin before the common complete account interval.",
        "",
        "| Window | UTC start | UTC end | Actual net ETH | Current era throughout |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for name, z in r["windows"].items():
        lines.append(
            f"| {name} | {iso(z['start'])} | {iso(z['end'])} | {eth(z['actual']['net_wei'])} | {z['actual_current_era']} |"
        )
    for group in ("24h", "7d"):
        names = [k for k in r["windows"] if k.startswith(group)]
        lines += [
            "",
            f"### {group} simulated net ETH",
            "",
            "| Policy | " + " | ".join(names) + " |",
            "| --- | " + " | ".join("---:" for _ in names) + " |",
        ]
        for policy in r["runs"]:
            vals = [r["windows"][k]["scenarios"][policy] for k in names]
            lines.append(
                f"| {LABELS[policy]} | "
                + " | ".join(
                    eth(z["cash"]["net_wei"]) if z["available"] else "unavailable"
                    for z in vals
                )
                + " |"
            )
    wd = r["window_diagnostics"]
    lines += [
        "",
        "## Window lag and misleading rises",
        "",
        f"Native 20-launch window span in minutes, mean / median / sample SD / n: {stats(wd['native20_span_minutes'])}.",
        f"Reconstructed positive score updates with nonpositive newly added return: {wd['rising_with_nonpositive_new_net']} / {wd['rising_updates']}. These are reconstruction updates, not recorded live reopenings.",
        f"Entry to matched signal availability in seconds, mean / median / sample SD / n: {stats(wd['entry_to_signal_seconds'])}.",
        f"Close to matched signal availability in seconds, mean / median / sample SD / n: {stats(wd['close_to_signal_seconds'])}.",
        "",
        "## Independent execution versus actual cash",
        "",
        "These predictions replay the same actual intents. They do not copy actual fills or actual failed-buy cash. The formal validate-replay certificate is separate and still governs realism.",
        "",
        "| Cohort | Paired / actual attempts | Actual net ETH | Predicted net ETH | Absolute error pp: mean / median / sample SD / n |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for name, z in r["intent_validation"]["summaries"].items():
        lines.append(
            f"| {name} | {z['paired']} / {z['n']} | {eth(z['actual']['net_wei'])} | {eth(z['predicted_same_intents']['net_wei'])} | {stats(z['absolute_error_pp'])} |"
        )
    lines += [
        "",
        "## Modeled minimum starting funds",
        "",
        "Principal is locked at entry and released at exit. Known transaction costs are charged at their modeled times. This is a path-specific financing requirement, before any extra reserve for execution error; it is not the simultaneous exposure cap.",
        "",
        "| Policy | Required starting ETH |",
        "| --- | ---: |",
    ]
    for name, value in r["starting_funds_wei"].items():
        lines.append(f"| {LABELS[name]} | {eth(value)} |")
    lines += ["", "## Definitions and evidence limits", ""]
    lines += ["- " + a for a in r["assumptions"]]
    lines += [
        f"- Shadow admissions: {r['shadow']['admissions']}; published modeled outcomes: {len(r['shadow']['records'])}; unavailable publications/closes: {len(r['shadow']['missing_signal_results'])}.",
        f"- Inherited realism status: {r['inherited_fidelity']['status']}. {r['inherited_fidelity'].get('reason','')}",
        "- Native and matched populations differ by design. Matching includes a common full-stake shadow account's cooldown and capacity, rather than each candidate's changing admissions.",
        "- A callback consumes the shared signal tape. It cannot clear an operator, drawdown, touch or execution stop.",
        "- Staged entries use independent quarter/half-size curve replays. Stage gains do not refill the gross probe-loss allowance.",
        "- The selected plot highlight is a display choice from fit-period cash, not a deployment recommendation.",
        "",
        "## Artifacts",
        "",
        "- indicator-24h.png and indicator-48h.png: aligned account cash, old score, matched signal, evidence age and admission states.",
        "- candidate-comparison.png: every tested candidate under each sell delay.",
        "- comparison.json: full source hashes, policies, decisions, cash, signals, forward cohorts and checks.",
        "- signal-samples.json: minute-level chart source and missing readings.",
        "",
    ]
    (out / "report.md").write_text("\n".join(lines))
    write_json(out / "signal-samples.json", plot_rows)
