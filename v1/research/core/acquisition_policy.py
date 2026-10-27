"""Credential isolation and a cross-process paid-request allowance for research."""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3


PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"


class PaidAllowanceExhausted(RuntimeError):
    """A paid request was refused before any bytes were sent upstream."""


def _positive_int(name: str) -> int:
    raw = os.environ.get(name, "")
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer for a paid research run")
    return value


def is_public_endpoint(url: str) -> bool:
    return url.rstrip("/") == PUBLIC_RPC_URL.rstrip("/")


class PaidAllowance:
    """One SQLite counter shared by every process in an explicitly bounded run."""

    def __init__(self, path: str | Path, maximum: int):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.maximum = maximum
        self.db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        self.db.execute("PRAGMA busy_timeout=30000")
        self.db.execute(
            "create table if not exists paid_allowance("
            "id integer primary key check(id=1), maximum integer not null, used integer not null)"
        )
        with self._write():
            row = self.db.execute(
                "select maximum,used from paid_allowance where id=1"
            ).fetchone()
            if row is None:
                self.db.execute(
                    "insert into paid_allowance values(1,?,0)", (maximum,)
                )
            elif row[0] != maximum:
                raise ValueError(
                    "RESEARCH_MAX_PAID_REQUESTS does not match the shared allowance file"
                )

    @contextmanager
    def _write(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def claim(self, count: int) -> None:
        if count <= 0:
            return
        with self._write():
            used = self.db.execute(
                "select used from paid_allowance where id=1"
            ).fetchone()[0]
            if used + count > self.maximum:
                raise PaidAllowanceExhausted(
                    f"paid research allowance exhausted ({used}/{self.maximum}); "
                    f"refused {count} request(s) before sending"
                )
            self.db.execute(
                "update paid_allowance set used=used+? where id=1", (count,)
            )

    @property
    def used(self) -> int:
        return int(
            self.db.execute("select used from paid_allowance where id=1").fetchone()[0]
        )

    def close(self) -> None:
        self.db.close()


class ResearchEndpointPolicy:
    """Classify routes without ever consulting trading endpoint variables."""

    def __init__(self, endpoints: list[str]):
        paid = [url for url in endpoints if not is_public_endpoint(url)]
        self.allowance = None
        if not paid:
            return
        if os.environ.get("RESEARCH_ALLOW_PAID") != "1":
            raise ValueError(
                "a non-public research endpoint requires RESEARCH_ALLOW_PAID=1"
            )
        maximum = _positive_int("RESEARCH_MAX_PAID_REQUESTS")
        budget_path = os.environ.get("RESEARCH_PAID_BUDGET_PATH", "")
        if not budget_path:
            raise ValueError(
                "a paid research run requires RESEARCH_PAID_BUDGET_PATH so child processes share one allowance"
            )
        self.allowance = PaidAllowance(budget_path, maximum)

    def before_send(self, endpoint: str, members: int) -> bool:
        """Claim every paid batch member before sending. Return whether it was paid."""
        paid = not is_public_endpoint(endpoint)
        if paid:
            assert self.allowance is not None
            self.allowance.claim(members)
        return paid

    @property
    def paid_used(self) -> int:
        return 0 if self.allowance is None else self.allowance.used

    def close(self) -> None:
        if self.allowance is not None:
            self.allowance.close()
