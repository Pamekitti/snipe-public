"""One report for coverage, reproduction and policy comparisons."""

from datetime import datetime, timezone
import html
import math
from pathlib import Path
from .data import read_json, write_json, digest


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def context_chart(run, comparison):
    """Render cash, market score, halt transitions, and activity on one time axis."""
    baseline = comparison["results"].get("market_plus2")
    if not baseline:
        return None
    selected = comparison.get("verdict", {}).get("selected", "market_plus2")
    names = list(dict.fromkeys(["market_plus2", selected]))
    start, end = comparison["start"], comparison["end"]
    x = lambda at: 75 + 1065 * (at - start) / max(1, end - start)

    def sample(rows, limit=1400):
        step = max(1, math.ceil(len(rows) / limit))
        return rows[::step]

    cash_series = []
    cash_values = [0]
    for name in names:
        total = 0
        points = [(start, 0)]
        for row in comparison["results"][name]["cash"]:
            total += row["pnl"] / 1e18
            points.append((row["at"], total))
        cash_series.append((name, points))
        cash_values += [value for _, value in points]
    cash_lo, cash_hi = min(cash_values), max(cash_values)
    cash_span = max(0.001, cash_hi - cash_lo)
    score_rows = sample(baseline["readings"])
    scores = [row["stakes"] for row in score_rows if math.isfinite(row["stakes"])]
    score_lo, score_hi = min(scores + [-1]), max(scores + [2])
    score_span = max(1, score_hi - score_lo)
    feature_rows = sample(comparison.get("feature_series", []))
    activity = [
        (row["at"], key, min(5, max(0, row[key])))
        for row in feature_rows
        for key in ["turnover", "buyers"]
        if isinstance(row.get(key), (int, float)) and math.isfinite(row[key])
    ]
    svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720" role="img" aria-label="Policy cash, market score, halts, and activity">',
        '<rect width="1200" height="720" fill="#111827"/>',
    ]
    reading_pairs = zip(score_rows, score_rows[1:])
    for row, following in reading_pairs:
        if row.get("halts"):
            svg.append(
                f'<rect x="{x(row["at"]):.1f}" y="35" width="{max(0.5, x(following["at"])-x(row["at"])):.1f}" height="620" fill="#7f1d1d" opacity="0.16"/>'
            )
    for y, title in [
        (40, "Conditional closed cash, ETH"),
        (255, "Market return, stakes"),
        (470, "Activity ratios, capped at 5x"),
    ]:
        svg.append(f'<text x="75" y="{y}" fill="#e5e7eb" font-size="17">{title}</text>')
    for y in [55, 270, 485]:
        svg.append(
            f'<rect x="75" y="{y}" width="1065" height="155" fill="none" stroke="#374151"/>'
        )
    for index, (name, points) in enumerate(cash_series):
        color = ["#34d399", "#60a5fa"][index]
        coords = " ".join(
            f"{x(at):.1f},{200-135*(value-cash_lo)/cash_span:.1f}"
            for at, value in sample(points)
        )
        svg.append(
            f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="2"/>'
        )
        svg.append(
            f'<text x="{75+index*220}" y="232" fill="{color}" font-size="14">{html.escape(name)}</text>'
        )
    score_coords = " ".join(
        f'{x(row["at"]):.1f},{415-135*(row["stakes"]-score_lo)/score_span:.1f}'
        for row in score_rows
        if math.isfinite(row["stakes"])
    )
    svg.append(
        f'<polyline points="{score_coords}" fill="none" stroke="#a5b4fc" stroke-width="1.5"/>'
    )
    for threshold, color in [(-1, "#fb7185"), (2, "#34d399")]:
        y = 415 - 135 * (threshold - score_lo) / score_span
        svg.append(
            f'<line x1="75" x2="1140" y1="{y:.1f}" y2="{y:.1f}" stroke="{color}" stroke-dasharray="5 5"/>'
        )
    grouped = {"turnover": [], "buyers": []}
    for at, key, value in activity:
        grouped[key].append((at, value))
    for index, key in enumerate(["turnover", "buyers"]):
        color = ["#fbbf24", "#22d3ee"][index]
        coords = " ".join(
            f"{x(at):.1f},{640-145*value/5:.1f}" for at, value in grouped[key]
        )
        svg.append(
            f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="1.3" opacity="0.9"/>'
        )
        svg.append(
            f'<text x="{75+index*180}" y="680" fill="{color}" font-size="14">{key}</text>'
        )
    for action in baseline["actions"]:
        if action["action"] not in [
            "venue_resume",
            "dd_resume",
            "venue_stop",
            "dd_stop",
        ]:
            continue
        color = "#34d399" if action["action"].endswith("resume") else "#fb7185"
        svg.append(
            f'<line x1="{x(action["at"]):.1f}" x2="{x(action["at"]):.1f}" y1="55" y2="655" stroke="{color}" opacity="0.45"/>'
        )
    svg.append(
        f'<text x="75" y="708" fill="#9ca3af" font-size="13">{html.escape(stamp(start))} to {html.escape(stamp(end))}. Red shading means +2 was halted. Green and red lines mark resume and stop actions.</text></svg>'
    )
    target = Path(run) / "chart-market-context.svg"
    target.write_text("".join(svg))
    return target.name


def report(run):
    run = Path(run)
    if (run / "INVALIDATED.json").exists():
        raise ValueError("run was invalidated; inspect INVALIDATED.json")
    m = read_json(run / "manifest.json")
    lines = [
        "# Research replay audit",
        "",
        "Simulation realism: diagnostic only. This report does not issue an actual-versus-predicted cash certificate. Follow research/BACKTEST_STANDARD.md and run validate-replay before trusting hypothetical earnings.",
        "",
        "The verdict below applies only to the frozen historical replay. Live trading is unchanged.",
        "",
        f"Snapshot: {stamp(m['snapshot_at'])}. Dataset SHA-256: `{m['dataset_sha256']}`.",
        "",
        "| Evidence | Available |",
        "|---|---:|",
    ]
    lines += [f"| {k} | {v} |" for k, v in m["coverage"].items()]
    if (run / "benchmark.json").exists():
        b = read_json(run / "benchmark.json")
        lines += [
            "",
            "## Execution benchmark",
            "",
            "Recorded accounting, actual-fill decisions and hypothetical reentry are reported separately.",
            "",
            "| Check | Count |",
            "|---|---:|",
        ]
        for k, v in b["coverage"].items():
            lines.append(f"| {k} | {html.escape(str(v))} |")
        fill = b.get("recorded_fill_decisions", [])
        comparable_fill = [row for row in fill if row.get("status") == "decision"]
        matching_fill = sum(row.get("reason_match", False) for row in comparable_fill)
        disagreeing_fill = len(comparable_fill) - matching_fill
        lines += [
            "",
            f"Actual-fill exit reason agreement: {matching_fill} of {len(comparable_fill)} comparable decisions. Disagreement: {disagreeing_fill} of {len(comparable_fill)} ({100 * disagreeing_fill / max(1, len(comparable_fill)):.2f}%). Another {len(fill) - len(comparable_fill)} attempts lacked a comparable path or buy event.",
            f"Independent cash verification: {sum(r['complete'] for r in b['accounting'])} of {len(b['accounting'])} closed attempts.",
        ]
        lines += [
            "",
            "Pinned-rule hypothetical reentry P&L error versus booked actual, in percentage points:",
            "",
            "| Signed P&L error | Value |",
            "|---|---:|",
        ]
        lines += [f"| {k} | {v} |" for k, v in b["errors_pp"].items()]
        lines += [
            "",
            "| Absolute P&L error | Value |",
            "|---|---:|",
        ]
        lines += [f"| {k} | {v} |" for k, v in b["absolute_errors_pp"].items()]
        excluded = [row for row in b["accounting"] if not row["ranking_eligible"]]
        if excluded:
            lines += [
                "",
                "### Accounting evidence excluded from ranking",
                "",
                "| Position | Recorded quality | Missing evidence | Reason |",
                "|---:|---|---|---|",
            ]
            for row in excluded:
                lines.append(
                    f"| {row['id']} | {row['booked_quality']} | {', '.join(row['missing_receipts']) or 'none'} | {row.get('exclusion','independent reconstruction did not match')} |"
                )
        lines += [
            "",
            "The final six hours were excluded from calibration. Previously viewed data is not an untouched holdout.",
            "",
        ]
        lines += ["- " + x for x in b["limitations"]]
    if (run / "legacy-reproduction.json").exists():
        old = read_json(run / "legacy-reproduction.json")
        lines += [
            "",
            "## Preserved comparisons",
            "",
            old["label"],
            "",
            f"Original artifacts unchanged: {old['originals_unchanged']}. Reproduction: {old['status']}.",
        ]
    if (run / "fork-check.json").exists():
        fork = read_json(run / "fork-check.json")
        lines += [
            "",
            "## Graduated-pool verification",
            "",
            f"Fresh fork test: {fork['status']}. {fork.get('reason','')}",
        ]
        if fork.get("cases"):
            lines += [
                "",
                "| Fork case | Verified | Wallet exact | Remaining tokens | Preparation gas wei |",
                "|---|---|---|---:|---:|",
            ]
            for case in fork["cases"]:
                result = case.get("result", {})
                lines.append(
                    f"| {case['name']} | {case.get('verified',False)} | {result.get('walletAccountingExact',False)} | {result.get('remainingTokens','unavailable')} | {result.get('prepGas','unavailable')} |"
                )
    if (run / "pool-quotes.json").exists():
        quotes = read_json(run / "pool-quotes.json")["results"]
        lines += [
            "",
            f"Historical pool quotes: {sum(q['status']=='historical_quote' for q in quotes)} of {len(quotes)} requested exits available.",
            "",
            "| Position | Status | Net proceeds wei | Quoter gas estimate |",
            "|---:|---|---:|---:|",
        ]
        for quote in quotes:
            lines.append(
                f"| {quote['id']} | {quote['status']} | {quote.get('net_proceeds_wei','unavailable')} | {quote.get('quoter_gas_estimate','unavailable')} |"
            )
    if (run / "validation.json").exists():
        validation = read_json(run / "validation.json")
        lines += ["", "## Workflow validation", "", "| Check | Result |", "|---|---|"]
        lines += [f"| {k} | {html.escape(str(v))} |" for k, v in validation.items()]
    for path in sorted(run.glob("comparison-*.json")):
        c = read_json(path)
        verdict = c.get("verdict", {})
        lines += [
            "",
            f"## {c['mode']} account comparison",
            "",
            f"Window: {stamp(c['start'])} to {stamp(c['end'])}.",
            f"Verdict: {verdict.get('selected','unavailable')}. {verdict.get('reason','')}",
            f"Execution coverage: {c.get('coverage',{}).get('execution_eligible',0)} eligible of {c.get('coverage',{}).get('attempts',0)} attempts; {c.get('coverage',{}).get('execution_unavailable',0)} unavailable before every policy.",
            "",
            "Amounts below are conditional simulated cash, not expected future profit. Incomplete paths show only the known prefix.",
            "",
            "| Policy | Net ETH | DD ETH | Calibration ETH | Reserved 6h ETH | Accepted | Blocked | False restarts | DD resumes | Unresolved | Eligible |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
        for name, r in c["results"].items():
            z = r["metrics"]
            diagnostic = r["diagnostics"]
            lines.append(
                f"| {name} | {z['pnl_eth']:.6f} | {z['dd_eth']:.6f} | {r['selection']['pnl_eth']:.6f} | {r['reserved6h']['pnl_eth']:.6f} | {diagnostic['accepted']} | {sum(diagnostic['blocked'].values())} | {diagnostic['false_restarts']} | {diagnostic['dd_resumes']} | {len(r['unresolved'])} | {r['ranking_eligible']} |"
            )
        selected = c["results"].get(verdict.get("selected"))
        if selected:
            stress = selected["diagnostics"]["missed_fill_sensitivity"]
            lines += [
                "",
                f"Selected-policy one-fill sensitivity: {stress['miss_one_best_eth']:+.6f} ETH if its best fill is missed; {stress['add_one_worst_eth']:+.6f} ETH after one extra copy of its worst fill.",
                "",
                "### Latest 24 hours, three-hour bins",
                "",
                "| Bin | Net ETH | DD ETH | Trades |",
                "|---:|---:|---:|---:|",
            ]
            lines += [
                f"| {index + 1} | {row['pnl_eth']:.6f} | {row['dd_eth']:.6f} | {row['n']} |"
                for index, row in enumerate(selected["bins24"])
            ]
            lines += [
                "",
                "### Latest seven daily bins",
                "",
                "| Day | Available | Net ETH | DD ETH | Trades |",
                "|---:|---|---:|---:|---:|",
            ]
            lines += [
                f"| {index + 1} | {row['available']} | {row['pnl_eth']:.6f} | {row['dd_eth']:.6f} | {row['n']} |"
                for index, row in enumerate(selected["bins7"])
            ]
        limits = sorted({x for r in c["results"].values() for x in r["limits"]})
        lines += [""] + ["- " + x for x in limits]
    text = "\n".join(lines) + "\n"
    (run / "report.md").write_text(text)
    # Standalone SVG charts need no CDN or extra package. Every run keeps its raw arrays.
    charts = []
    for path in sorted(run.glob("comparison-*.json")):
        c = read_json(path)
        series = []
        for name, r in c["results"].items():
            if name not in (
                "market_plus2",
                "market_plus1",
                "broad_gains",
                "recent_direction",
            ):
                continue
            points = [(c["start"], 0)]
            value = 0
            for cash in r["cash"]:
                value += cash["pnl"] / 1e18
                points.append((cash["at"], value))
            series.append((name, points))
        if not series:
            continue
        allv = [v for _, points in series for _, v in points]
        lo = min(allv)
        hi = max(allv)
        span = max(hi - lo, 0.001)
        svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 400" role="img" aria-label="Conditional cash comparison"><rect width="1100" height="400" fill="#111827"/>'
        ]
        for j, (name, points) in enumerate(series):
            color = ["#34d399", "#fb7185", "#60a5fa", "#fbbf24"][j]
            coords = " ".join(
                f'{70+960*(t-c["start"])/max(1,c["end"]-c["start"]):.1f},{310-250*(v-lo)/span:.1f}'
                for t, v in points
            )
            svg.append(
                f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="2"/><text x="{70+j*245}" y="365" fill="{color}" font-size="14">{html.escape(name)}</text>'
            )
        svg.append(
            f'<text x="15" y="35" fill="white" font-size="17">{c["mode"]}: conditional closed cash, ETH. Unresolved paths stop.</text><text x="10" y="65" fill="white">{hi:.4f}</text><text x="10" y="310" fill="white">{lo:.4f}</text></svg>'
        )
        target = run / f'chart-{c["mode"]}.svg'
        target.write_text("".join(svg))
        charts.append(target.name)
        if c["mode"] == "opportunities":
            context = context_chart(run, c)
            if context:
                charts.append(context)
    (run / "report.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Research audit</title><style>body{max-width:1100px;margin:30px auto;background:#111827;color:#e5e7eb;font:15px system-ui}pre{white-space:pre-wrap}img{width:100%}</style>'
        + "".join(f'<img src="{name}">' for name in charts)
        + "<pre>"
        + html.escape(text)
        + "</pre>"
    )
    write_json(
        run / "outputs.json",
        {
            p.name: digest(p)
            for p in run.iterdir()
            if p.is_file() and p.name != "outputs.json"
        },
    )
    return run / "report.html"
