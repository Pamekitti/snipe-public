"""Historical official-router quotes. No transaction signing or broadcasting."""

from pathlib import Path
from .data import write_artifact
from .data import Cache, Worker, read_json, write_json
from .execution import validate_dataset


def quote(run, cache_path, fetch=False):
    run = Path(run)
    d, m = validate_dataset(run)
    jobs = read_json(run / "pool_requests.json")
    cache = Cache(cache_path, fetch)
    results = []
    with Worker() as w:
        quoter = w.call(op="metadata")["v4"]["quoter"]
        for job in jobs:
            encoded = w.call(op="encode_pool", key=job["key"], tokens=job["tokens"])
            raw = cache.get("eth_call", [{"to": quoter, "data": encoded}, job["block"]])
            row = {
                **job,
                "status": "archive_quote_unavailable",
                "ranking_eligible": False,
            }
            if raw:
                try:
                    amount, gas = w.call(op="decode_pool", data=raw)
                    row.update(
                        status="historical_quote",
                        net_proceeds_wei=amount,
                        quoter_gas_estimate=gas,
                        limits=[
                            "Exact historical pool, but candidate pool-state compatibility is unproved.",
                            "Quote excludes approval and graduation-preparation transaction gas.",
                        ],
                    )
                except RuntimeError as e:
                    row["error"] = str(e)
            results.append(row)
    cache.close()
    output = dict(dataset_sha256=m["dataset_sha256"], results=results)
    write_artifact(run / "pool-quotes.json", output)
    return output
