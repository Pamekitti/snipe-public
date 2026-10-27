"""Read-only reproduction of preserved experiments, isolated from corrected replay."""

import sys
from dataclasses import replace
from pathlib import Path
from .data import write_artifact
from .data import BOT, read_json, write_json, digest


def reproduce(run):
    sys.path.insert(0, str(BOT / "research"))
    import recovery_policy_audit as audit
    import recovery_policy_models as models
    import stale_policy_audit as stale
    import activity_policy_audit as activity
    import market_guard_longer as longer

    root = BOT / "data/recovery-policy-20260908"
    ar = BOT / "data/activity-policy-20260908"
    original = [
        root / "snapshot.json.gz",
        root / "model_paths.json",
        root / "stale-policy/results.json",
        ar / "results.json",
    ]
    hashes = {str(p): digest(p) for p in original}
    d = read_json(root / "snapshot.json.gz")
    end = d["snapshot_at"]
    start = end - 14 * audit.DAY
    native = audit.live_observations(d)
    known = {o.token for o in native}
    paths = read_json(root / "model_paths.json")["paths"]
    saved = read_json(root / "stale-policy/results.json")
    base = replace(
        audit.policies(d["state"]["config"]["values"])[0], on=2, name="venue_plus2_only"
    )
    actual = audit.recorded(d, audit.ERA)
    results = {}
    for label, obs, trades, lo, reference in [
        ("recorded", native, actual, audit.ERA, saved["recorded"]),
        (
            "two_week_model",
            native
            + [
                longer.Observation(
                    t,
                    z["block"],
                    z["launched"],
                    longer.scoring_time(z["launched"], 300000),
                    {"1.75": z["observer_return"]},
                )
                for t, z in paths.items()
                if t not in known
            ],
            models.variants(paths, start, 0.6, "zero")[0],
            start,
            saved["scenarios"]["base"],
        ),
    ]:
        runs = {}
        for p in stale.policy_set(audit.policies(d["state"]["config"]["values"])[0]):
            r = audit.Simulator(obs, trades, lo, end).simulate(p)
            expected = reference[p.name]
            assert [list(x) for x in r["cash"]] == expected["cash"], (
                label,
                p.name,
                "cash",
            )
            assert r["actions"] == expected["actions"], (label, p.name, "actions")
            runs[p.name] = dict(
                exact_cash=True, exact_actions=True, metrics=audit.stats(r, lo, end)
            )
        results[label] = runs
    recovery = read_json(root / "recorded_results.json")["recorded"]
    recovery_checks = {}
    for p in audit.policies(d["state"]["config"]["values"]):
        if p.small_probe:
            continue
        r = audit.Simulator(native, actual, audit.ERA, end).simulate(p)
        assert [list(x) for x in r["cash"]] == recovery[p.name]["cash"], p.name
        assert r["actions"] == recovery[p.name]["actions"], p.name
        recovery_checks[p.name] = dict(exact_cash=True, exact_actions=True)
    results["recovery_recorded"] = recovery_checks
    fresh = read_json(ar / "snapshot.json.gz")
    fobs = audit.live_observations(fresh)
    comparison, _ = activity.compare(
        fresh,
        fobs,
        audit.recorded(fresh, audit.ERA),
        activity.load_activity(fresh),
        audit.ERA,
        fresh["snapshot_at"],
        base,
    )
    expected = read_json(ar / "results.json")["recorded"]
    for name, r in comparison.items():
        assert [list(x) for x in r["cash"]] == expected[name]["cash"], name
        assert r["actions"] == expected[name]["actions"], name
    results["activity_recorded"] = {
        k: dict(exact_cash=True, exact_actions=True) for k in comparison
    }
    assert hashes == {str(p): digest(p) for p in original}
    result = dict(
        status="reproduced",
        originals_unchanged=True,
        inputs=hashes,
        results=results,
        label="Legacy assumptions retained for compatibility only. These are not corrected profit forecasts.",
    )
    write_artifact(Path(run) / "legacy-reproduction.json", result)
    return result
