"""Run production graduation owner-loop tests on disposable localhost forks."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request
from .data import write_artifact
from .data import BOT, write_json, read_json, digest


def run_forks(run, anvil):
    run = Path(run)
    run.mkdir(parents=True, exist_ok=True)
    result = dict(
        status="blocked",
        cases=[],
        block=56954753,
        harness_sha256=digest(BOT / "research/graduation_fork_check.ts"),
    )
    if not os.environ.get("RESEARCH_ARCHIVE_URL"):
        result["reason"] = (
            "Historical archive endpoint unavailable. Set RESEARCH_ARCHIVE_URL; it is used only by the read-only loopback proxy."
        )
        write_artifact(run / "fork-check.json", result)
        return result
    if not Path(anvil).is_file():
        raise ValueError("anvil binary does not exist")
    env = {
        k: os.environ[k]
        for k in ["PATH", "TMPDIR", "RESEARCH_ARCHIVE_URL"]
        if k in os.environ
    }
    env.update(ENV_FILE="/dev/null", MODE="observe", LIVE="0", DASH="0")

    def ready(port):
        for _ in range(150):
            try:
                body = b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
                with urllib.request.urlopen(
                    urllib.request.Request(
                        f"http://127.0.0.1:{port}",
                        body,
                        {"Content-Type": "application/json"},
                    ),
                    timeout=1,
                ) as f:
                    if b"0x1237" in f.read():
                        return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("local fork did not become ready")

    with (run / "archive-proxy.log").open("w") as proxy_log:
        proxy = subprocess.Popen(
            ["node", str(BOT / "research/core/archive-proxy.mjs")],
            env=env,
            stdout=proxy_log,
            stderr=subprocess.STDOUT,
            cwd=BOT,
        )
        try:
            ready(16875)
            for name, adverse in [("missing_pool", False), ("adverse_price", True)]:
                with (run / f"fork-{name}.log").open("w") as log:
                    fork = subprocess.Popen(
                        [
                            str(anvil),
                            "--fork-url",
                            "http://127.0.0.1:16875",
                            "--fork-block-number",
                            "56954753",
                            "--port",
                            "18545",
                            "--host",
                            "127.0.0.1",
                            "--accounts",
                            "0",
                            "--silent",
                        ],
                        env=env,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                    )
                    try:
                        ready(18545)
                        completed = subprocess.run(
                            [
                                "node",
                                "--import",
                                "tsx",
                                "research/graduation_fork_check.ts",
                            ],
                            cwd=BOT,
                            env={**env, "FORK_DUMP": "1" if adverse else "0"},
                            capture_output=True,
                            text=True,
                            timeout=240,
                        )
                        log.write(completed.stdout)
                        log.write(completed.stderr)
                        if completed.returncode:
                            raise RuntimeError(f"{name} fork harness failed; see log")
                        match = re.search(r"evidence (.+)", completed.stdout)
                        if not match:
                            raise RuntimeError(
                                "fork harness did not return evidence path"
                            )
                        evidence = Path(match.group(1).strip()) / "result.json"
                        value = read_json(evidence)
                        write_artifact(run / f"fork-{name}.json", value)
                        result["cases"].append(
                            dict(name=name, verified=True, result=value)
                        )
                    finally:
                        fork.terminate()
                        fork.wait(timeout=15)
            result["status"] = "passed"
            result["reason"] = (
                "Both local contract scenarios passed. Fork elapsed time is not production latency."
            )
        except Exception as e:
            result["reason"] = str(e)
        finally:
            proxy.terminate()
            proxy.wait(timeout=15)
    write_artifact(run / "fork-check.json", result)
    return result
