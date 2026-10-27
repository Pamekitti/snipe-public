"""Receipt accounting and integer replay benchmarks with explicit evidence labels."""

from __future__ import annotations
import collections
from pathlib import Path
import statistics

from .data import write_artifact
from .data import Worker, read_json, write_json, digest, HOUR, DAY

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
WALLET = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"


def describe(xs):
    xs = list(xs)
    return dict(
        n=len(xs),
        sum=sum(xs),
        mean=statistics.mean(xs) if xs else None,
        median=statistics.median(xs) if xs else None,
        sd=statistics.stdev(xs) if len(xs) > 1 else None,
        p95=sorted(xs)[min(len(xs) - 1, int(0.95 * len(xs)))] if xs else None,
    )


def booked(p):
    return int(
        p["onchain_pnl_wei"]
        if p.get("onchain_pnl_wei") is not None
        else p.get("pnl_wei") or 0
    )


def validate_dataset(run):
    if (run / "INVALIDATED.json").exists():
        raise ValueError("run was invalidated; inspect INVALIDATED.json")
    d = read_json(run / "dataset.json")
    m = read_json(run / "manifest.json")
    if digest(run / "dataset.json") != m["dataset_sha256"]:
        raise ValueError("dataset hash mismatch")
    return d, m


def receipt_gas(r):
    return int(r["gasUsed"], 16) * int(r["effectiveGasPrice"], 16) if r else 0


def receipt_accounting(p, receipts, ancillary=(), topics=None, pool_proceeds=None):
    buy = receipts.get(p.get("buy_hash"))
    sell = receipts.get(p.get("exit_hash"))
    recorded_cost = sum(
        int(p.get(k) or 0)
        for k in ["burned_gas_wei", "approval_gas_wei", "graduation_prep_gas_wei"]
    )
    txs = {
        h: receipts[h]
        for h in [p.get("buy_hash"), p.get("exit_hash")]
        if h and receipts.get(h)
    }
    main = sum(receipt_gas(r) for r in txs.values())
    missing = []
    for label, r in [("buy", buy), ("sell", sell)]:
        if (
            p.get("buy_hash" if label == "buy" else "exit_hash")
            and not r
            and p.get("exit_reason") != "buy-never-mined"
        ):
            missing.append(label)
    costs = {
        a["hash"]: receipts.get(a["hash"])
        for a in ancillary
        if a.get("position_id") == p["id"]
        and not a.get("rejected")
        and a["hash"] not in txs
    }
    proven_cost = sum(receipt_gas(r) for r in costs.values() if r)
    ancillary_verified = all(costs.values()) and proven_cost == recorded_cost
    if not ancillary_verified:
        missing.append("ancillary_cost_receipts")

    def amount(receipt, topic, word):
        ls = [
            l
            for l in (receipt or {}).get("logs", [])
            if l["address"].lower() == p["curve"].lower() and l["topics"][0] == topic
        ]
        return (
            int(ls[0]["data"][2 + 64 * word : 2 + 64 * (word + 1)], 16)
            if len(ls) == 1
            else None
        )

    spend = proceeds = None
    if p.get("exit_reason") == "buy-never-mined" or (
        buy and int(buy["status"], 16) == 0
    ):
        spend = proceeds = 0
    elif topics:
        spend = amount(buy, topics["CurveBuy"], 0)
        proceeds = amount(sell, topics["CurveSell"], 1)
        if pool_proceeds is not None:
            proceeds = int(pool_proceeds)
    if spend is None:
        missing.append("buy_principal")
    if proceeds is None:
        missing.append("exit_proceeds")
    # Book-derived arithmetic remains available, but never masquerades as independent proof.
    gross = int(p.get("proceeds_wei") or 0) - int(p.get("spend_wei") or 0)
    if p.get("exit_reason") in ["buy-never-mined", "buy-reverted"]:
        gross = 0
    recorded_reconstruction = gross - main - recorded_cost
    independent = (
        None
        if spend is None or proceeds is None or not ancillary_verified or missing
        else proceeds - spend - main - proven_cost
    )
    return dict(
        id=p["id"],
        booked_wei=str(booked(p)),
        receipt_main_gas_wei=str(main),
        recorded_ancillary_gas_wei=str(recorded_cost),
        ancillary_receipts_verified=ancillary_verified,
        cash_from_recorded_principal_and_proceeds_wei=str(recorded_reconstruction),
        residual_wei=str(booked(p) - recorded_reconstruction),
        missing_receipts=missing,
        independently_reconstructed_wei=(
            str(independent) if independent is not None else None
        ),
        independent_match=independent == booked(p) if independent is not None else None,
        booked_quality=(
            "receipt_booked" if p.get("onchain_pnl_wei") is not None else "fallback"
        ),
        complete=independent is not None and independent == booked(p),
    )


def effective_exit_hash(p, receipts, ancillary, manager):
    """Recover a graduated exit hash without treating that sale as approval gas."""
    if p.get("exit_hash"):
        return p["exit_hash"]
    explicit = [
        row["hash"]
        for row in ancillary
        if row.get("position_id") == p["id"]
        and row.get("kind") == "swap"
        and receipts.get(row["hash"])
    ]
    if len(explicit) == 1:
        return explicit[0]
    inferred = []
    for row in ancillary:
        if row.get("position_id") != p["id"] or not receipts.get(row.get("hash")):
            continue
        receipt = receipts[row["hash"]]
        sent = [
            log
            for log in receipt.get("logs", [])
            if log["address"].lower() == p["token"].lower()
            and log.get("topics", [None])[0] == TRANSFER_TOPIC
            and len(log["topics"]) >= 3
            and log["topics"][1][-40:].lower() == WALLET[2:]
            and log["topics"][2][-40:].lower() == manager[2:].lower()
        ]
        if sent:
            inferred.append(row["hash"])
    return inferred[0] if len(inferred) == 1 else None


def archive_execution_coverage(d, p, end_at):
    """An event list alone does not prove a complete, independently checked interval."""
    token = p['token'].lower()
    coverage = d.get('path_coverage', {}).get(token, {})
    blocks = d.get('blocks', {})
    faults = []
    integer = lambda x: int(x, 0) if isinstance(x, str) and x.startswith('0x') else int(x)
    try:
        lo, hi = integer(coverage['from']), integer(coverage['to'])
        launch = integer(p['entry_block'])
        if not coverage.get('all_topics') or lo > launch or hi < lo:
            faults.append('incomplete_event_interval')
        head = blocks.get(hex(hi))
        if not head:
            candidates = [(integer(number), header) for number, header in blocks.items()
                          if lo <= integer(number) <= hi and header.get('hash')]
            head = max(candidates, default=(0, None), key=lambda item: item[0])[1]
        if not head or integer(head['timestamp']) * 1000 < end_at:
            faults.append('unproved_execution_horizon')
        for log in d.get('paths', {}).get(token, []):
            header = blocks.get(log['blockNumber'])
            if not header or not header.get('hash') or header['hash'] != log.get('blockHash'):
                faults.append('unverified_log_header')
                break
    except (KeyError, ValueError, TypeError):
        faults.append('missing_interval_proof')
    return dict(complete=not faults, independentlyChecked=not faults and coverage.get('independently_checked') is True,
                source='frozen-archive', faults=faults)


def path_request(d, p, gas, lag=600, poll=500):
    token = p["token"].lower()
    params = d["params"].get(token)
    logs = d["paths"].get(token)
    if not params or logs is None:
        return None, "missing_parameters_or_path"
    if not d["path_coverage"].get(token, {}).get("all_topics"):
        return None, "incomplete_event_topics"
    if any(l["blockNumber"] not in d["blocks"] for l in logs):
        return None, "missing_block_timestamps"
    context = p.get("context_json")
    import json

    context = (
        json.loads(context) if isinstance(context, str) and context else context or {}
    )
    rules = context.get("rules")
    required = {"maxHoldMs", "hardStopMultiple", "deadCoinAfterMs", "deadCoinBelowMult"}
    if not rules or not required <= rules.keys():
        return None, "missing_historical_rules"
    if not p.get("take_profit"):
        return None, "missing_historical_target"
    return (
        dict(
            op="replay",
            params=params,
            logs=logs,
            blocks={
                l["blockNumber"]: d["blocks"][l["blockNumber"]]
                for l in logs
                if l["blockNumber"] in d["blocks"]
            },
            token=token,
            curve=p["curve"],
            entryAt=p.get("t_decide") or p["t_detect"],
            entryBlock=p.get("fill_block"),
            sizeWei=p["spend_wei"],
            maxEntryMultiple=context.get("entryStrategy", {}).get(
                "maxEntryPriceMultiple"
            ),
            takeProfit=p["take_profit"],
            rules=rules,
            gasWei=str(gas),
            buyGasWei=str(receipt_gas(d["receipts"].get(p.get("buy_hash")))),
            sellDelayMs=lag,
            pollMs=poll,
            endAt=min(d["snapshot_at"], (p.get("t_decide") or p["t_detect"]) + 180000),
            wallet="0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        ),
        None,
    )


def benchmark(run):
    run = Path(run)
    d, m = validate_dataset(run)
    end = d["snapshot_at"]
    start = d["start"]
    cut = end - 6 * HOUR
    rows = [p for p in d["positions"] if (p.get("t_decide") or p["t_detect"]) >= start]
    accounting = []
    execution = []
    decisions = []
    fill_decisions = []
    pool = []
    jobs = []
    with Worker() as worker:
        meta = worker.call(op="metadata")
        for p in rows:
            if not p["closed"]:
                continue
            exit_hash = effective_exit_hash(
                p, d["receipts"], d.get("ancillary", []), meta["v4"]["manager"]
            )
            accounted = {**p, "exit_hash": exit_hash}
            proceeds = None
            if p.get("exit_reason") == "graduated-swap" and d["receipts"].get(
                exit_hash
            ):
                key = dict(
                    currency0="0x" + "0" * 40,
                    currency1=p["token"],
                    fee=0,
                    tickSpacing=200,
                    hooks=meta["v4"]["hook"],
                )
                try:
                    proceeds = worker.call(
                        op="pool_receipt",
                        logs=d["receipts"][exit_hash]["logs"],
                        key=key,
                        wallet=WALLET,
                    )
                    receipt = d["receipts"][exit_hash]
                    transfers = [
                        l
                        for l in receipt["logs"]
                        if l["address"].lower() == p["token"].lower()
                        and l["topics"][0] == TRANSFER_TOPIC
                        and len(l["topics"]) >= 3
                        and l["topics"][1][-40:].lower() == WALLET[2:]
                        and l["topics"][2][-40:].lower()
                        == meta["v4"]["manager"][2:].lower()
                    ]
                    if len(transfers) == 1:
                        jobs.append(
                            dict(
                                id=p["id"],
                                key=key,
                                tokens=str(int(transfers[0]["data"], 16)),
                                block=hex(int(receipt["blockNumber"], 16) - 1),
                                at=p["exit_at"],
                                mode="actual_exit_before_swap",
                            )
                        )
                    pool.append(
                        dict(
                            id=p["id"],
                            proceeds_wei=proceeds,
                            recorded_wei=p["proceeds_wei"],
                            match=int(proceeds) == int(p["proceeds_wei"]),
                        )
                    )
                except RuntimeError as e:
                    pool.append(dict(id=p["id"], status="unverified", error=str(e)))
            account = receipt_accounting(
                accounted,
                d["receipts"],
                d.get("ancillary", []),
                meta["topics"],
                proceeds,
            )
            account["effective_exit_hash"] = exit_hash
            account["ranking_eligible"] = account["complete"]
            if not account["complete"] and p.get("exit_reason") in [
                "recovered-flat",
                "stranded-graduated",
            ]:
                account["exclusion"] = "historical exit transaction is absent"
            accounting.append(account)
        for token in sorted({p["token"].lower() for p in rows}):
            if token not in d["params"] or not d["path_coverage"].get(token, {}).get(
                "all_topics"
            ):
                execution.append(
                    dict(token=token, status="missing_full_path_or_parameters")
                )
                continue
            result = worker.call(
                op="benchmark",
                params=d["params"][token],
                logs=d["paths"][token],
                blocks={
                    l["blockNumber"]: d["blocks"][l["blockNumber"]]
                    for l in d["paths"][token]
                    if l["blockNumber"] in d["blocks"]
                },
            )
            execution.append(dict(token=token, status="checked", **result))
        for i, p in enumerate(rows):
            if not p["closed"]:
                decisions.append(dict(id=p["id"], status="open_actual_position"))
                continue
            gas = (
                int(p.get("proceeds_wei") or 0)
                - int(p.get("spend_wei") or 0)
                - booked(p)
            )
            request, missing = path_request(d, p, max(0, gas))
            if missing:
                decisions.append(dict(id=p["id"], status=missing))
                continue
            if p.get("buy_ok") and p.get("entry_mark_wei"):
                fill = worker.call(
                    **{
                        **request,
                        "mode": "recorded_fill",
                        "buyHash": p["buy_hash"],
                        "entryMarkWei": p["entry_mark_wei"],
                        "entryAt": (
                            p["exit_at"] - p["hold_ms"]
                            if p.get("hold_ms") is not None
                            else p["t_sent"]
                        ),
                        "endAt": p["exit_at"],
                    }
                )
                fill.update(
                    id=p["id"],
                    actual_reason=p["exit_reason"],
                    reason_match=fill.get("reason") == p["exit_reason"],
                    partition=(
                        "reserved" if request["entryAt"] >= cut else "calibration"
                    ),
                )
                fill_decisions.append(fill)
            result = worker.call(**request)
            result.update(
                id=p["id"],
                actual_pnl_wei=str(booked(p)),
                actual_reason=p["exit_reason"],
                partition="reserved" if request["entryAt"] >= cut else "calibration",
                timing_quality="confirmed_block_seconds_with_assumed_observation_and_execution",
                mode="hypothetical_reentry_at_recorded_decision_time",
            )
            if result["status"] == "closed":
                result["error_pp"] = (
                    100 * (int(result["pnlWei"]) - booked(p)) / int(p["spend_wei"])
                )
            decisions.append(result)
            if result["status"] == "pool_required":
                key = dict(
                    currency0="0x" + "0" * 40,
                    currency1=p["token"],
                    fee=0,
                    tickSpacing=200,
                    hooks=meta["v4"]["hook"],
                )
                times = sorted(
                    (v["timestamp"] * 1000, b) for b, v in d["blocks"].items()
                )
                eligible = [(at, b) for at, b in times if at <= result["at"]]
                if eligible:
                    jobs.append(
                        dict(
                            id=p["id"],
                            key=key,
                            tokens=result["tokens"],
                            block=eligible[-1][1],
                            at=result["at"],
                        )
                    )
            if i % 100 == 0:
                print("decision benchmark", i, "/", len(rows), flush=True)
    checks = [c for r in execution for c in r.get("checks", [])]
    import json
    from .account import observations, outcome

    obs = observations(d)
    sensor = []
    for sample in d.get("guard_samples", []):
        if sample.get("market") is None or not start <= sample["at"] < end:
            continue
        visible = sorted(
            (o for o in obs if o.scored <= sample["at"] and o.market_eligible),
            key=lambda o: (-o.block, o.token),
        )
        selected = outcome(visible[:40], 20)
        if len(selected) == 20:
            sensor.append(sum(v for _, v in selected) - sample["market"])
    eras = {}
    decision_by_id = {r["id"]: r for r in decisions}
    for p in rows:
        context = p.get("context_json")
        context = (
            json.loads(context)
            if isinstance(context, str) and context
            else context or {}
        )
        key = json.dumps(
            {
                "size": p["spend_wei"],
                "rules": context.get("rules"),
                "build": p.get("build_id"),
            },
            sort_keys=True,
        )
        eras.setdefault(key, []).append(p)
    era_summary = []
    for spec, positions in eras.items():
        era_summary.append(
            dict(
                spec=json.loads(spec),
                n=len(positions),
                start=min(p.get("t_decide") or p["t_detect"] for p in positions),
                end=max(p.get("exit_at") or end for p in positions),
                errors_pp=describe(
                    decision_by_id[p["id"]]["error_pp"]
                    for p in positions
                    if "error_pp" in decision_by_id.get(p["id"], {})
                ),
            )
        )
    result = dict(
        schema=1,
        dataset_sha256=m["dataset_sha256"],
        start=start,
        end=end,
        era_summary=era_summary,
        sensor_reconstruction=dict(
            errors_stakes=describe(sensor), exact=sum(abs(x) < 1e-9 for x in sensor)
        ),
        accounting=accounting,
        execution=execution,
        decisions=decisions,
        recorded_fill_decisions=fill_decisions,
        pool_receipts=pool,
        coverage=dict(
            attempts=len(rows),
            receipt_booked=sum(p.get("onchain_pnl_wei") is not None for p in rows),
            independent_accounting=sum(x["complete"] for x in accounting),
            checked_transactions=len(checks),
            exact_matches=sum(c["match"] for c in checks),
            independently_checked_taxes=sum(
                c.get("taxVerified", False) for c in checks
            ),
            decision_status=dict(collections.Counter(x["status"] for x in decisions)),
            historical_rule_partitions=dict(
                pinned=sum(
                    x["status"] != "missing_historical_rules" for x in decisions
                ),
                unavailable=sum(
                    x["status"] == "missing_historical_rules" for x in decisions
                ),
            ),
            accounting_ranking_eligible=sum(x["ranking_eligible"] for x in accounting),
            accounting_excluded=sum(not x["ranking_eligible"] for x in accounting),
        ),
        errors_pp=describe(x["error_pp"] for x in decisions if "error_pp" in x),
        absolute_errors_pp=describe(
            abs(x["error_pp"]) for x in decisions if "error_pp" in x
        ),
        limitations=[
            "Recorded-fill decisions use block timestamps and assumed observation cadence; arrival times are unavailable.",
            "Historical subsecond receive times are missing.",
            "Buy AMM checks condition on emitted fees; unknown exemptions are not validated.",
            "Principal and ancillary gas require complete independent receipt tracing.",
        ],
    )
    write_artifact(run / "benchmark.json", result)
    write_artifact(run / "pool_requests.json", jobs)
    print(result["coverage"], flush=True)
    return result


def opportunities(run, d):
    """Fixed current rules on historical opportunities, never a historical-live claim."""
    import json
    from .account import observations

    contexts = []
    for p in d["positions"]:
        c = p.get("context_json")
        if c:
            c = json.loads(c) if isinstance(c, str) else c
            if c.get("rules") and c.get("entryStrategy"):
                contexts.append((p.get("t_decide") or p["t_detect"], c))
    if not contexts:
        raise ValueError("no pinned current rule context")
    _, context = max(contexts, key=lambda x: x[0])
    strategy = context["entryStrategy"]
    obs = observations(d)
    size = round(strategy["tradeSizeEth"] * 1e18)
    trades = []
    details = []
    calibration = []
    for p in d["positions"]:
        if (
            p.get("buy_ok")
            and p.get("closed")
            and p.get("exit_at")
            and p["exit_at"] < d["snapshot_at"] - 6 * HOUR
        ):
            gas = int(p.get("proceeds_wei") or 0) - int(p["spend_wei"]) - booked(p)
            if gas >= 0:
                calibration.append(
                    (
                        p["exit_at"],
                        gas,
                        receipt_gas(d["receipts"].get(p.get("buy_hash"))),
                    )
                )
    with Worker() as worker:
        for f in sorted(d["launches"], key=lambda x: x["block"]):
            entry = max(f.get("detected_at") or 0, f["launched_at"] * 1000 + 2000)
            if not d["start"] <= entry < d["snapshot_at"]:
                continue
            if not f.get("passed"):
                continue
            visible = sorted(
                (o for o in obs if o.scored < entry), key=lambda o: (-o.block, o.token)
            )
            tp = worker.call(
                op="adaptive",
                rows=[o.bars for o in visible[:40]],
                window=20,
                bars=[1.25, 1.36, 1.5, 1.75, 2, 2.5, 3],
                fallback=1.75,
            )["multiple"]
            fake = dict(
                token=f["token"],
                curve=f["curve"],
                t_decide=entry,
                t_detect=entry,
                spend_wei=str(size),
                take_profit=tp,
                context_json=context,
            )
            known_costs = [gas for at, gas, buy_gas in calibration if at < entry]
            known_buy_costs = [
                buy_gas
                for at, gas, buy_gas in calibration
                if at < entry and buy_gas > 0
            ]
            gas = int(statistics.median(known_costs)) if known_costs else None
            req, missing = path_request(d, fake, gas or 0)
            if req and known_buy_costs:
                req["buyGasWei"] = str(int(statistics.median(known_buy_costs)))
            if gas is None or not known_buy_costs:
                missing = "no_prior_execution_cost_calibration"
            result = {"status": missing} if missing else worker.call(**req)
            if result["status"] == "entry_price_rejected":
                continue
            detail = (
                result["status"]
                if result["status"] not in ("closed", "buy_reverted")
                else None
            )
            variants = {}
            if not missing:
                for amount in [5 * 10**15, 10**16]:
                    variant = worker.call(**{**req, "sizeWei": str(amount)})
                    variants[str(amount)] = dict(
                        size=amount,
                        exit=variant.get("exitAt", d["snapshot_at"]),
                        pnl=int(variant.get("pnlWei", 0)),
                        unsupported=(
                            None
                            if variant["status"] in ("closed", "buy_reverted")
                            else variant["status"]
                        ),
                    )
            trades.append(
                dict(
                    id=f["token"],
                    token=f["token"].lower(),
                    entry=entry,
                    exit=result.get("exitAt", d["snapshot_at"]),
                    pnl=int(result.get("pnlWei", 0)),
                    size=size,
                    tp=tp,
                    template=f'{f["creator_tax_bps"]}:{f["dev_buy_wei"]}:{f["exemptions"]}',
                    unsupported=detail,
                    variants=variants,
                )
            )
            details.append(
                dict(
                    result,
                    token=f["token"],
                    entry=entry,
                    entryAt=result.get("entryAt", entry),
                    exitAt=result.get("exitAt", d["snapshot_at"]),
                    cost_wei=str(gas) if gas is not None else None,
                    cost_calibration=describe(known_costs),
                )
            )
    write_artifact(
        Path(run) / "opportunity-execution.json",
        dict(
            results=details,
            status="diagnostic_only",
            rules=context["rules"],
            limits=[
                "Recorded passed launches condition on historical template screening.",
                "Launch plus two seconds is an assumed entry, not feed receipt timing.",
                "Gas uses only preceding calibration closes. The last six hours never fit costs.",
            ],
        ),
    )
    return trades
