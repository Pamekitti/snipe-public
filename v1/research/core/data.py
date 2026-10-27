"""Content-addressed, read-only acquisition and explicit coverage for research."""

from __future__ import annotations
from contextlib import closing
import gzip
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
import sqlite3
import ssl
import shutil
import subprocess
import time
import urllib.request
import urllib.error

from .acquisition_policy import (
    PUBLIC_RPC_URL,
    PaidAllowanceExhausted,
    ResearchEndpointPolicy,
)

BOT = Path(__file__).resolve().parents[2]
HOUR = 3_600_000
DAY = 24 * HOUR
VERSION = "research-v1"


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path):
    p = Path(path)
    with gzip.open(p, "rt") if p.suffix == ".gz" else p.open() as f:
        return json.load(f)


def write_json(path, value):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(value, sort_keys=True, indent=2))
    tmp.replace(p)


class Worker:
    def __init__(self, worker_path=None):
        env = {
            k: os.environ[k]
            for k in ["PATH", "TMPDIR", "SYSTEMROOT"]
            if k in os.environ
        }
        env.update(
            ENV_FILE="/dev/null",
            MODE="observe",
            LIVE="0",
            DASH="0",
            DOTENV_CONFIG_QUIET="true",
        )
        self.p = subprocess.Popen(
            ["node", "--import", "tsx", str(worker_path or BOT / "research/core/worker.ts")],
            cwd=BOT,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def call(self, **request):
        self.p.stdin.write(json.dumps(request) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError(f"worker exited {self.p.poll()}")
        response = json.loads(line)
        if not response["ok"]:
            raise RuntimeError(response["error"])
        return response["value"]

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=20)
        self.p.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Cache:
    def __init__(
        self,
        path,
        fetch=False,
        url=None,
        logs_url=None,
        headers_url=None,
        opener=None,
        sleeper=None,
        pace_seconds=0.25,
        bypass_cache=False,
    ):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.fetch = fetch
        self.url = url or os.environ.get("RESEARCH_RPC_URL") or PUBLIC_RPC_URL
        self.logs_url = (
            logs_url or os.environ.get("RESEARCH_LOGS_RPC_URL") or PUBLIC_RPC_URL
        )
        self.headers_url = (
            headers_url or os.environ.get("RESEARCH_HEADERS_RPC_URL") or PUBLIC_RPC_URL
        )
        self.opener = opener or urllib.request.urlopen
        self.sleep = sleeper or time.sleep
        self.pace_seconds = pace_seconds
        self.bypass_cache = bypass_cache
        self.last = 0
        self.unsupported_methods = set()
        self.cache_hits = 0
        self.network_attempts = 0
        self.missing_results = 0
        self.policy = ResearchEndpointPolicy(
            list({self.url, self.logs_url, self.headers_url})
        )
        self.db = sqlite3.connect(path, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "create table if not exists rpc(key text primary key,request text,value text,at integer)"
        )
        self.db.execute(
            "create table if not exists failures(key text primary key,request text,error text,at integer)"
        )

    def close(self):
        self.policy.close()
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    @staticmethod
    def key(method, params):
        return hashlib.sha256(
            json.dumps([method, params], sort_keys=True).encode()
        ).hexdigest()

    def many(self, requests):
        output = {}
        missing = []
        for method, params in requests:
            key = self.key(method, params)
            row = None if self.bypass_cache else self.db.execute(
                "select value from rpc where key=?", (key,)
            ).fetchone()
            if not self.bypass_cache and not row and method in ('research_getTimestampHeader', 'eth_getBlockByNumber') and len(params)==2 and params[1] is False and str(params[0]).startswith('0x'):
                alias = 'eth_getBlockByNumber' if method=='research_getTimestampHeader' else 'research_getTimestampHeader'
                cached = self.db.execute('select value from rpc where key=?', (self.key(alias,params),)).fetchone()
                if cached:
                    header = json.loads(cached[0])
                    if header and header.get('hash') and int(header.get('number','-1'),16)==int(params[0],16):row=cached
            if row:
                self.cache_hits += 1
                output[key] = json.loads(row[0])
            elif self.fetch and method not in self.unsupported_methods:
                missing.append((method, params))
            else:
                output[key] = None
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())

        def post(body):
            self.sleep(max(0, self.pace_seconds - (time.monotonic() - self.last)))
            try:
                methods = {row["method"] for row in body}
                endpoint = self.url
                if methods == {"eth_getLogs"}:
                    endpoint = self.logs_url
                elif methods in ({"eth_getBlockByNumber"}, {"research_getTimestampHeader"}):
                    endpoint = self.headers_url
                elif methods in [
                    {"research_getTimestampLogs"},
                    {"research_getTransferTimestamps"},
                    {"research_getTransferTimestampsV2"},
                    {"research_getTransferTimestampsV3"},
                ]:
                    endpoint = self.url
                method_map = {
                    "research_getTimestampLogs": "eth_getLogs",
                    "research_getTransferTimestamps": "alchemy_getAssetTransfers",
                    "research_getTransferTimestampsV2": "alchemy_getAssetTransfers",
                    "research_getTransferTimestampsV3": "alchemy_getAssetTransfers",
                    "research_getTimestampHeader": "eth_getBlockByNumber",
                }
                wire_body = [
                    {
                        **row,
                        "method": method_map.get(row["method"], row["method"]),
                    }
                    for row in body
                ]
                self.policy.before_send(endpoint, len(wire_body))
                self.network_attempts += len(wire_body)
                req = urllib.request.Request(
                    endpoint,
                    json.dumps(
                        wire_body[0] if len(wire_body) == 1 else wire_body
                    ).encode(),
                    {
                        "Content-Type": "application/json",
                        "User-Agent": "snipe-research-prepare",
                        **(
                            {"X-Research-Timestamps": "1"}
                            if methods
                            in [
                                {"research_getTimestampLogs"},
                                {"research_getTransferTimestamps"},
                                {"research_getTransferTimestampsV2"},
                                {"research_getTransferTimestampsV3"},
                                {"research_getTimestampHeader"},
                            ]
                            else {}
                        ),
                    },
                )
                with self.opener(req, context=context, timeout=45) as f:
                    response = json.load(f)
                if len(body) == 1 and isinstance(response, dict):
                    response = [response]
                if not isinstance(response, list):
                    raise RuntimeError(str(response)[:180])
                return {x.get("id"): x for x in response}
            finally:
                self.last = time.monotonic()

        def fetch_one(method, params):
            if method in self.unsupported_methods:return None, "RPC method unavailable in this acquisition session"
            body = [dict(jsonrpc="2.0", id=0, method=method, params=params)]
            error = "missing result"
            for attempt in range(4):
                try:
                    row = post(body).get(0, {})
                    if row.get("result") is not None and not row.get("error"):
                        return row["result"], None
                    error = str(row.get("error", error))
                    if isinstance(row.get('error'),dict) and row['error'].get('code') == -32601:
                        self.unsupported_methods.add(method)
                        return None,error
                    if not any(x in error.lower() for x in ("429", "too many requests", "rate limit", "limit exceeded")):
                        break
                except Exception as exc:
                    error = str(exc)[:200]
                    if isinstance(exc, urllib.error.HTTPError):
                        exc.close()
                    if isinstance(exc, urllib.error.HTTPError) and exc.code in (400, 401, 403, 404, 405, 413, 422, 501):
                        return None, error
                if attempt < 3:
                    self.sleep(min(30, 5 * 2**attempt))
            return None, error

        def save(method, params, value, error=None):
            key = self.key(method, params)
            output[key] = value
            if value is not None and self.cacheable(method, params, value) and not self.bypass_cache:
                self.db.execute(
                    "insert or replace into rpc values(?,?,?,?)",
                    (
                        key,
                        json.dumps([method, params]),
                        json.dumps(value),
                        int(time.time() * 1000),
                    ),
                )
                self.db.execute("delete from failures where key=?", (key,))
            elif value is None:
                self.missing_results += 1

        batch_size = (
            10
            if missing
            and all(
                method.startswith("research_getTransferTimestamps")
                for method, _ in missing
            )
            else 100
        )
        acquisition_started = time.monotonic()
        for start in range(0, len(missing), batch_size):
            batch = missing[start : start + batch_size]
            body = [
                dict(jsonrpc="2.0", id=i, method=m, params=p)
                for i, (m, p) in enumerate(batch)
            ]
            byid = None
            batch_error = None
            permanent_error = False
            for attempt in range(4):
                try:
                    byid = post(body)
                    break
                except PaidAllowanceExhausted as exc:
                    batch_error = str(exc)
                    permanent_error = True
                    break
                except Exception as exc:
                    batch_error = str(exc)[:200]
                    if isinstance(exc, urllib.error.HTTPError):
                        exc.close()
                    permanent_error = isinstance(exc, urllib.error.HTTPError) and exc.code in (400, 401, 403, 404, 405, 413, 422, 501)
                    if not any(x in batch_error.lower() for x in ("429", "too many requests", "rate limit", "limit exceeded")) or attempt == 3:
                        break
                    self.sleep(min(30, 5 * 2**attempt))
            if byid is not None:
                for i, (m, p) in enumerate(batch):
                    r = byid.get(i, {})
                    if r.get("result") is not None and not r.get("error"):
                        save(m, p, r["result"])
                    else:
                        if isinstance(r.get('error'),dict) and r['error'].get('code') == -32601:self.unsupported_methods.add(m)
                        value, error = fetch_one(m, p)
                        save(m, p, value, error)
            else:
                for m, p in batch:
                    value, error = (None, batch_error) if permanent_error else fetch_one(m, p)
                    save(m, p, value, error or batch_error)
            self.db.commit()
            progress_path = os.environ.get('RESEARCH_PROGRESS_PATH')
            if progress_path:
                write_json(Path(progress_path), dict(at=int(time.time()*1000),completed=min(start+len(batch),len(missing)),total=len(missing),elapsed=time.monotonic()-acquisition_started,unit='RPC items in current batch group',failures=sum(output.get(self.key(m,p)) is None for m,p in batch),acquisition=self.summary()))
        return [output.get(self.key(m, p)) for m, p in requests]

    @staticmethod
    def cacheable(method, params, value):
        """Only successful, immutable historical answers become evidence."""
        def contains_latest(item):
            if isinstance(item, str):
                return item.lower() in ("latest", "pending", "safe", "finalized")
            if isinstance(item, list):
                return any(contains_latest(x) for x in item)
            if isinstance(item, dict):
                return any(contains_latest(x) for x in item.values())
            return False

        if value is None or contains_latest(params):
            return False
        if method in ("eth_getTransactionReceipt", "eth_getTransactionByHash"):
            if not isinstance(value, dict) or value.get("blockNumber") in (None, "pending"):
                return False
            requested = str(params[0]).lower() if params else ""
            actual = str(value.get("transactionHash") or value.get("hash") or "").lower()
            if requested and actual and requested != actual:
                return False
        return True

    def summary(self):
        return {
            "cache_hits": self.cache_hits,
            "network_attempts": self.network_attempts,
            "paid_allowance_used": self.policy.paid_used,
            "missing_results": self.missing_results,
        }

    def get(self, method, params):
        return self.many([(method, params)])[0]


def event_timestamp(log):
    """Some providers return 0x0 as an unavailable timestamp, not Unix epoch."""
    raw = log.get("blockTimestamp")
    try:
        value = (
            int(raw, 16) if isinstance(raw, str) and raw.startswith("0x") else int(raw)
        )
    except (ValueError, TypeError):
        return None
    return value if value > 0 else None


def timestamp_log_requests(block_ids, topics):
    """Build provider-safe ten-block requests for blocks with relevant events."""
    windows = sorted({int(block, 16) // 10 * 10 for block in block_ids})
    return [
        (
            "research_getTimestampLogs",
            [
                {
                    "fromBlock": hex(start),
                    "toBlock": hex(start + 9),
                    "topics": [topics],
                }
            ],
        )
        for start in windows
    ]


def transfer_timestamp_request(tokens, from_block, to_block, page_key=None):
    if isinstance(tokens, str):
        tokens = [tokens]
    params = {
        "fromBlock": hex(from_block),
        "toBlock": hex(to_block),
        "contractAddresses": tokens,
        "category": ["erc20"],
        "withMetadata": True,
        "excludeZeroValue": False,
        "maxCount": "0x3e8",
    }
    if page_key:
        params["pageKey"] = page_key
    return "research_getTransferTimestampsV3", [params]


def transfer_timestamp_groups(facts, paths, max_weight=900):
    groups = []
    for fact in sorted(facts, key=lambda row: row["block"]):
        token = fact["token"].lower()
        if token not in paths:
            continue
        weight = max(1, 3 * len(paths[token]) + 1)
        if (
            not groups
            or len(groups[-1]["facts"]) >= 15
            or fact["block"] - groups[-1]["facts"][0]["block"] > 8000
            or groups[-1]["weight"] + weight > max_weight
        ):
            groups.append({"facts": [], "weight": 0})
        groups[-1]["facts"].append(fact)
        groups[-1]["weight"] += weight
    return [group["facts"] for group in groups]


def capture(bot_db, gate_db, state_path, out):
    """Create the frozen prepare input from offline, read-only database copies."""
    out = Path(out)
    if out.exists():
        raise ValueError("capture already exists; choose a new output path")
    state = read_json(state_path)
    snapshot_at = state.get("capturedAt") or state.get("at")
    if not isinstance(snapshot_at, (int, float)) or snapshot_at <= 0:
        raise ValueError("dashboard state needs a positive capturedAt or at")

    def rows(path, table, required=False):
        with closing(
            sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
        ) as db:
            db.row_factory = sqlite3.Row
            exists = db.execute(
                "select 1 from sqlite_master where type='table' and name=?", (table,)
            ).fetchone()
            if not exists:
                if required:
                    raise ValueError(f"required table missing: {table}")
                return []
            return [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')]

    value = {
        "snapshot_at": round(snapshot_at),
        "state": state,
        "bot_launches": rows(bot_db, "launches", True),
        "bot_positions": rows(bot_db, "positions", True),
        "bot_guard_samples": rows(bot_db, "guard_samples"),
        "bot_balance": rows(bot_db, "balance"),
        "bot_chain_truth": rows(bot_db, "chain_truth"),
        "bot_health": rows(bot_db, "health"),
        "bot_approval_transactions": rows(bot_db, "approval_transactions"),
        "bot_graduation_transactions": rows(bot_db, "graduation_transactions"),
        "bot_shadow_jobs": rows(bot_db, "shadow_jobs"),
        "bot_shadow_decisions": rows(bot_db, "shadow_decisions"),
        "bot_shadow_meta": rows(bot_db, "shadow_meta"),
        "bot_shadow_headers": rows(bot_db, "shadow_headers"),
        "bot_shadow_coverage": rows(bot_db, "shadow_coverage"),
        "gate_obs": rows(gate_db, "obs", True),
        "gate_state": rows(gate_db, "state"),
        "capture": {
            "bot_db_sha256": digest(bot_db),
            "gate_db_sha256": digest(gate_db),
            "state_sha256": digest(state_path),
        },
    }
    for table in ["bot_graduation_transactions", "bot_approval_transactions"]:
        value[table] = [
            {k: v for k, v in row.items() if k != "raw"} for row in value[table]
        ]
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_suffix(out.suffix + ".tmp")
    temporary.write_bytes(
        gzip.compress(encoded, mtime=0) if out.suffix == ".gz" else encoded
    )
    temporary.replace(out)
    return {
        "snapshot_at": value["snapshot_at"],
        "launches": len(value["bot_launches"]),
        "positions": len(value["bot_positions"]),
        "observations": len(value["gate_obs"]),
        "sha256": digest(out),
    }


def bounded_logs(cache, request, limit=1000):
    """Split a capped single-curve log range until every block is accounted for."""
    logs = cache.get("eth_getLogs", [request])
    if logs is None or len(logs) < limit:
        return logs
    lo, hi = int(request["fromBlock"], 16), int(request["toBlock"], 16)
    if lo >= hi:
        return None
    mid = (lo + hi) // 2
    left = bounded_logs(cache, {**request, "toBlock": hex(mid)}, limit)
    right = bounded_logs(cache, {**request, "fromBlock": hex(mid + 1)}, limit)
    if left is None or right is None:
        return None
    return left + right


def prepare(
    snapshot,
    out,
    cache_path,
    fetch=False,
    days=14,
    scope="benchmark",
    immutable_latest=False,
    population="book",
    since_ms=None,
):
    if population not in ("book", "screened"):
        raise ValueError("population must be book or screened")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    if (out / "dataset.json").exists():
        raise ValueError("run already exists; choose a new run directory")
    # Persist a sanitized source object. A temporary input path is not reproducible.
    raw = read_json(snapshot)
    for table in ["bot_graduation_transactions", "bot_approval_transactions"]:
        raw[table] = [
            {k: v for k, v in r.items() if k != "raw"} for r in raw.get(table, [])
        ]
    encoded = json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()
    object_id = hashlib.sha256(encoded).hexdigest()
    objects = out.parent / "objects"
    objects.mkdir(exist_ok=True)
    snapshot = objects / (object_id + ".json.gz")
    if not snapshot.exists():
        with snapshot.open("wb") as f:
            f.write(gzip.compress(encoded, mtime=0))
    d = raw
    end = d["snapshot_at"]
    start = end - days * DAY
    if since_ms is not None:
        start = max(start, int(since_ms))
    positions = [
        p
        for p in d["bot_positions"]
        if p["live"]
        and (p.get("cohort") or "main") == "main"
        and (p.get("t_decide") or p.get("t_detect") or 0) < end
        and (p.get("exit_at") or end) >= start
    ]
    actual = {p["token"].lower() for p in positions}
    facts = {
        r["token"].lower(): r
        for r in d["bot_launches"]
        if (r.get("launched_at") or 0) * 1000 >= start - 7 * HOUR
        and (r.get("launched_at") or 0) * 1000 < end
        and r.get("block")
        and r.get("curve")
        and (
            r["token"].lower() in actual
            or (population == "screened" and r.get("passed"))
            or (
                50 <= (r.get("creator_tax_bps") or 0) <= 200
                and (r.get("exemptions") or 0) >= 3
                and r.get("pair_token") == "0x" + "0" * 40
                and int(r.get("dev_buy_wei") or 0) >= 10**16
                and r.get("prior_launches") is not None
                and r["prior_launches"] <= 3
            )
        )
    }
    cache = Cache(cache_path, fetch)
    paths = {}
    coverage = {}
    sources = {str(Path(snapshot).resolve()): digest(snapshot)}
    for source in [
        BOT / "data/recovery-policy-20260908/paths.db",
        BOT / "data/market-guard-longer-20260908/paths.db",
    ]:
        if not source.exists():
            continue
        sources[str(source)] = digest(source)
        with closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as db:
            for token, lo, hi, js in db.execute(
                "select token,from_block,to_block,js from paths where error is null"
            ):
                if token in facts and lo <= facts[token]["block"]:
                    paths[token] = json.loads(js)
                    coverage[token] = {"from": lo, "to": hi, "all_topics": False}
    with Worker() as worker:
        topics = worker.call(op="metadata")["topics"]
        groups = []
        for f in sorted(facts.values(), key=lambda x: x["block"]):
            if (
                not groups
                or len(groups[-1]) >= 15
                or f["block"] - groups[-1][0]["block"] > 8000
            ):
                groups.append([])
            groups[-1].append(f)

        # Full-topic paths replace legacy paths only after a successful bounded response.
        def fetch_group(group):
            lo = min(f["block"] for f in group)
            hi = max(f["block"] + 1800 for f in group)
            req = [
                {
                    "fromBlock": hex(lo),
                    "toBlock": hex(hi),
                    "address": [f["curve"] for f in group],
                    "topics": [[v for k, v in topics.items() if k != "TokenLaunched"]],
                }
            ]
            logs = cache.get("eth_getLogs", req)
            if logs is None:
                return
            if len(logs) >= 1000:
                if len(group) > 1:
                    mid = len(group) // 2
                    fetch_group(group[:mid])
                    fetch_group(group[mid:])
                    return
                logs = bounded_logs(cache, req[0])
                if logs is None:
                    return
            for f in group:
                t = f["token"].lower()
                paths[t] = [
                    l
                    for l in logs
                    if l["address"].lower() == f["curve"].lower()
                    and f["block"] <= int(l["blockNumber"], 16) <= f["block"] + 1800
                ]
                coverage[t] = {
                    "from": f["block"],
                    "to": f["block"] + 1800,
                    "all_topics": True,
                }

        for i, group in enumerate(groups):
            fetch_group(group)
            if i % 25 == 0:
                print(f"paths {i+1}/{len(groups)}", flush=True)
        # A fixed historical block, never latest state, supplies immutable parameters.
        anchor = max((f["block"] for f in facts.values()), default=0)
        anchor_header = (
            cache.get("eth_getBlockByNumber", [hex(anchor), False]) if anchor else None
        )
        curves = sorted(facts, key=lambda t: t not in actual)
        parameters = {}
        parameter_sources = {}
        for i in range(0, len(curves), 20):
            ts = curves[i : i + 20]
            addresses = [facts[t]["curve"] for t in ts]
            encoded = worker.call(op="encode_params", curves=addresses)
            raw = (
                cache.get(
                    "eth_call",
                    [
                        {
                            "to": "0xcA11bde05977b3631167028862bE2a173976CA11",
                            "data": encoded,
                        },
                        hex(anchor),
                    ],
                )
                if anchor
                else None
            )
            source = {"mode": "historical", "block": anchor}
            if not raw and immutable_latest:
                raw = cache.get(
                    "eth_call",
                    [
                        {
                            "to": "0xcA11bde05977b3631167028862bE2a173976CA11",
                            "data": encoded,
                        },
                        "latest",
                    ],
                )
                source = {
                    "mode": "immutable_getters_latest",
                    "warning": "Only deployment constants; no price or reserve read. Archive anchor unavailable.",
                }
            if raw:
                for t, result in zip(
                    ts, worker.call(op="decode_params", curves=addresses, data=raw)
                ):
                    p = result["params"]
                    if all(v is not None for v in p.values()):
                        parameters[t] = p
                        parameter_sources[t] = source
            if i % 400 == 0:
                print(f"parameters {i}/{len(curves)}", flush=True)
        ancillary = [
            {k: v for k, v in x.items() if k != "raw"}
            for table in ["bot_graduation_transactions", "bot_approval_transactions"]
            for x in d.get(table, [])
            if x["position_id"] in {p["id"] for p in positions}
        ]
        ancillary = list({x["hash"]: x for x in ancillary}.values())
        print(f"receipts for {len(positions)} positions", flush=True)
        hashes = sorted(
            {p[k] for p in positions for k in ["buy_hash", "exit_hash"] if p.get(k)}
            | {x["hash"] for x in ancillary if not x.get("rejected")}
        )
        receipts = dict(
            zip(
                hashes, cache.many([("eth_getTransactionReceipt", [h]) for h in hashes])
            )
        )
        block_ids = sorted(
            {
                l["blockNumber"]
                for t, ls in paths.items()
                if scope == "opportunities" or t in actual
                for l in ls
            },
            key=lambda x: int(x, 16),
        )
        transfer_groups = transfer_timestamp_groups(list(facts.values()), paths)
        transfer_requests = [
            transfer_timestamp_request(
                [f["token"].lower() for f in group],
                min(f["block"] for f in group),
                max(f["block"] + 1800 for f in group),
            )
            for group in transfer_groups
        ]
        timestamps = {}
        timestamp_sources = {}
        timestamp_conflicts = set()

        def add_timestamp(block, timestamp, source):
            if block in timestamp_conflicts:
                return
            if block in timestamps and timestamps[block]["timestamp"] != timestamp:
                timestamps.pop(block, None)
                timestamp_sources.pop(block, None)
                timestamp_conflicts.add(block)
                return
            timestamps[block] = {"timestamp": timestamp, "hash": None}
            timestamp_sources[block] = source

        block_id_set = set(block_ids)
        for i in range(0, len(transfer_requests), 20):
            requests = transfer_requests[i : i + 20]
            responses = cache.many(requests)
            pending = list(zip(transfer_groups[i : i + 20], responses))
            while pending:
                next_groups, next_requests = [], []
                for group, response in pending:
                    if not response:
                        continue
                    for transfer in response.get("transfers", []):
                        if transfer["blockNum"] not in block_id_set:
                            continue
                        raw_timestamp = (transfer.get("metadata") or {}).get(
                            "blockTimestamp"
                        )
                        if raw_timestamp:
                            timestamp = int(
                                datetime.fromisoformat(
                                    raw_timestamp.replace("Z", "+00:00")
                                ).timestamp()
                            )
                            add_timestamp(
                                transfer["blockNum"],
                                timestamp,
                                "archive_transfer_index",
                            )
                    page_key = response.get("pageKey")
                    if page_key:
                        next_groups.append(group)
                        next_requests.append(
                            transfer_timestamp_request(
                                [f["token"].lower() for f in group],
                                min(f["block"] for f in group),
                                max(f["block"] + 1800 for f in group),
                                page_key,
                            )
                        )
                pending = (
                    list(zip(next_groups, cache.many(next_requests)))
                    if next_requests
                    else []
                )
            print(
                f"transfer timestamps {min(i + 20, len(transfer_requests))}/{len(transfer_requests)}",
                flush=True,
            )

        unresolved_blocks = [b for b in block_ids if b not in timestamps]
        timestamp_requests = [
            ("research_getTimestampHeader", [block, False])
            for block in unresolved_blocks
        ]
        timestamp_headers = []
        for i in range(0, len(timestamp_requests), 1000):
            timestamp_headers.extend(cache.many(timestamp_requests[i : i + 1000]))
            print(
                f"fallback timestamp headers {min(i + 1000, len(timestamp_requests))}/{len(timestamp_requests)}",
                flush=True,
            )
        for block, header in zip(unresolved_blocks, timestamp_headers):
            if header and int(header["number"], 16) == int(block, 16):
                timestamps[block] = {
                    "timestamp": int(header["timestamp"], 16),
                    "hash": header["hash"],
                }
                timestamp_sources[block] = "historical_rpc_header"
        for logs in paths.values():
            for log in logs:
                value = timestamps.get(log["blockNumber"])
                if value and (
                    value["hash"] is None or value["hash"] == log["blockHash"]
                ):
                    log["blockTimestamp"] = hex(value["timestamp"])
        blocks = {}
        conflicts = set()
        block_hashes = {}
        for ls in paths.values():
            for log in ls:
                number = log["blockNumber"]
                h = log["blockHash"]
                if number in block_hashes and block_hashes[number] != h:
                    conflicts.add(number)
                block_hashes[number] = h
        # The provider includes timestamp and hash in each log. Do not re-fetch tens
        # of thousands of headers when those exact block facts are already present.
        for ls in list(paths.values()) + [r["logs"] for r in receipts.values() if r]:
            for log in ls:
                timestamp = event_timestamp(log)
                if timestamp is None:
                    continue
                number = log["blockNumber"]
                value = {
                    "timestamp": timestamp,
                    "hash": log["blockHash"],
                    "source": timestamp_sources.get(number, "event_log"),
                }
                if number in blocks and (
                    blocks[number]["timestamp"] != timestamp
                    or blocks[number]["hash"] != value["hash"]
                ):
                    conflicts.add(number)
                else:
                    blocks[number] = value
        for number in conflicts:
            blocks.pop(number, None)
        total_blocks = len(block_ids)
        block_ids = [b for b in block_ids if b not in blocks]
        for i in range(0, len(block_ids), 300):
            ids = block_ids[i : i + 300]
            values = cache.many([("eth_getBlockByNumber", [b, False]) for b in ids])
            for b, v in zip(ids, values):
                if (
                    v
                    and int(v["number"], 16) == int(b, 16)
                    and (b not in block_hashes or v["hash"] == block_hashes[b])
                ):
                    blocks[b] = {
                        "timestamp": int(v["timestamp"], 16),
                        "hash": v["hash"],
                        "baseFeePerGas": v.get("baseFeePerGas"),
                    }
            if i % 3000 == 0:
                print(f"blocks {i}/{len(block_ids)}", flush=True)
    data = {
        "schema": 1,
        "engine": VERSION,
        "snapshot_at": end,
        "start": start,
        "source": str(Path(snapshot).resolve()),
        "state": d.get("state"),
        "positions": positions,
        "launches": list(facts.values()),
        "observations": d["gate_obs"],
        "guard_samples": d.get("bot_guard_samples", []),
        "health": d.get("bot_health", []),
        "balances": d.get("bot_balance", []),
        "truth": d.get("bot_chain_truth", []),
        "paths": paths,
        "path_coverage": coverage,
        "params": parameters,
        "blocks": blocks,
        "receipts": receipts,
        "ancillary": ancillary,
        "parameter_sources": parameter_sources,
        "scope": scope,
        "population": population,
        "parameter_anchor": {"number": anchor, "header": anchor_header},
        "sources": sources,
        "assumptions": [
            "Parameter provenance is recorded per token; optional latest reads are limited to immutable getters.",
            "subsecond ordering uses log order; absent receive timestamps remain unknown",
        ],
    }
    write_json(out / "dataset.json", data)
    manifest = {
        "schema": 1,
        "engine": VERSION,
        "snapshot_at": end,
        "start": start,
        "sources": sources,
        "dataset_sha256": digest(out / "dataset.json"),
        "coverage": {
            "launches": len(facts),
            "paths": len(paths),
            "full_topic_paths": sum(v["all_topics"] for v in coverage.values()),
            "parameters": len(parameters),
            "blocks": len(blocks),
            "requested_blocks": total_blocks,
            "transfer_timestamp_requests": len(transfer_requests),
            "timestamp_header_requests": len(timestamp_requests),
            "timestamp_conflicts": len(conflicts | timestamp_conflicts),
            "receipts": sum(v is not None for v in receipts.values()),
            "requested_receipts": len(hashes),
        },
        "source_hashes": {
            str(p.relative_to(BOT)): digest(p)
            for p in (BOT / "research/core").glob("*")
            if p.is_file() and p.suffix in [".py", ".ts"]
        },
        "acquisition": cache.summary(),
    }
    write_artifact(out / "manifest.json", manifest)
    cache.close()
    return manifest


def write_artifact(path, value):
    """Keep every result and its executable source, even when the friendly name advances."""
    import io
    import tarfile

    p = Path(path)
    objects = p.parent / "objects"
    objects.mkdir(parents=True, exist_ok=True)
    code = {
        name: hashlib.sha256(content).hexdigest()
        for name, content in _RUN_SOURCES.items()
    }
    for name, content in _RUN_SOURCES.items():
        if (BOT / name).read_bytes() != content:
            raise RuntimeError(
                "source changed during this run; rerun with stable files"
            )
    source_id = hashlib.sha256(json.dumps(code, sort_keys=True).encode()).hexdigest()
    archive = objects / (source_id + ".tar.gz")
    if not archive.exists():
        import tempfile

        with tempfile.TemporaryDirectory(dir=objects) as temporary:
            staged = Path(temporary) / "source.tar.gz"
            with tarfile.open(staged, "w:gz") as tar:
                for name, content in _RUN_SOURCES.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    tar.addfile(info, io.BytesIO(content))
            try:
                os.link(staged, archive)
            except FileExistsError:
                pass
    encoded = json.dumps(value, sort_keys=True, indent=2).encode()
    result_id = hashlib.sha256(encoded).hexdigest()
    object_path = objects / (result_id + ".json")
    if not object_path.exists():
        object_path.write_bytes(encoded)
    meta = dict(
        result_sha256=result_id,
        result_file=object_path.name,
        source_id=source_id,
        source_archive=archive.name,
        source_archive_sha256=digest(archive),
        source_hashes=code,
    )
    write_json(objects / (result_id + "-" + source_id + ".manifest.json"), meta)
    write_json(p, value)


# Capture executable inputs before any long-running acquisition or replay starts.
_RUN_SOURCES = {
    str(p.relative_to(BOT)): p.read_bytes()
    for p in sorted(
        set(
            list((BOT / "research/core").glob("*.py"))
            + list((BOT / "research/core").glob("*.ts"))
            + list((BOT / "research/core").glob("*.mjs"))
            + list((BOT / "research").glob("*.py"))
            + [
                BOT / "research/graduation_fork_check.ts",
                BOT / "package.json",
                BOT / "package-lock.json",
            ]
            + list((BOT / "scripts").glob("*.py"))
            + list((BOT / "src").rglob("*.ts"))
        )
    )
    if p.is_file()
}
