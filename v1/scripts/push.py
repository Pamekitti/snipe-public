#!/usr/bin/env python3
"""Outbound-only alarm push for the snipe bot.

The box never listens for this. It reads the dashboard on 127.0.0.1, decides whether
anything is worth waking someone for, and makes one outbound HTTPS request if so.
That is the whole security story: there is no inbound surface to attack.

Fires on a NEW flag (not every tick, or a stuck alarm becomes wallpaper) plus a
heartbeat summary every HEARTBEAT_H hours so silence still means "alive", not "dead
timer". State lives in scripts/.push-state.json.

Config in bot/.env, all optional except picking one channel:
  PUSH_CHANNEL   ntfy | telegram | pushover | none    (default none = log only)
  NTFY_TOPIC     random string; the topic IS the secret for ntfy.sh
  NTFY_SERVER    default https://ntfy.sh
  TG_TOKEN       BotFather token          TG_CHAT   your chat id
  PO_TOKEN       pushover app token       PO_USER   pushover user key
  HEARTBEAT_H    hours between summaries, default 6
"""

import json, os, sqlite3, ssl, statistics, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BOT = os.path.dirname(HERE)
STATE = os.path.join(HERE, ".push-state.json")
DASH = "http://127.0.0.1:8787/api/state"


def env():
    e = dict(os.environ)
    p = os.path.join(BOT, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                e.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return e


E = env()
CH = E.get("PUSH_CHANNEL", "none")
HEARTBEAT_S = float(E.get("HEARTBEAT_H", 6)) * 3600


def send(title, body, priority="default"):
    """One outbound HTTPS POST. Never raises; a dead push channel must not kill the timer."""
    try:
        if CH == "ntfy":
            url = (
                E.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
                + "/"
                + E["NTFY_TOPIC"]
            )
            req = urllib.request.Request(
                url,
                data=body.encode(),
                method="POST",
                headers={"Title": title, "Priority": priority},
            )
        elif CH == "telegram":
            url = f"https://api.telegram.org/bot{E['TG_TOKEN']}/sendMessage"
            data = urllib.parse.urlencode(
                {"chat_id": E["TG_CHAT"], "text": f"{title}\n{body}"}
            ).encode()
            req = urllib.request.Request(url, data=data, method="POST")
        elif CH == "pushover":
            data = urllib.parse.urlencode(
                {
                    "token": E["PO_TOKEN"],
                    "user": E["PO_USER"],
                    "title": title,
                    "message": body,
                    "priority": 1 if priority == "high" else 0,
                }
            ).encode()
            req = urllib.request.Request(
                "https://api.pushover.net/1/messages.json", data=data, method="POST"
            )
        else:
            print(f"[push:{CH}] {title}\n{body}")
            return True
        urllib.request.urlopen(
            req, timeout=15, context=ssl.create_default_context()
        ).read()
        return True
    except Exception as ex:
        print(f"push failed via {CH}: {ex}", file=sys.stderr)
        return False


def recon_gap():
    """Median recon gap in pp, read straight from recon.db. None when there is no data.

    This used to shell out to `node scripts/livewatch.cjs` and regex the gap out of its
    printed line. Two problems with that, both fixed here. It forked a whole Node
    process that opens two databases and computes hold percentiles, on every 5-minute tick,
    purely to recover one float: 288 spawns a day on a t4g.small instead of the ~5 it used
    to do lazily. And it made an alert depend on another script's HUMAN-READABLE output, so
    a cosmetic wording change in reconstat.cjs would have silently stopped SIM DRIFT from
    ever firing, with no error anywhere.

    The dashboard is not the source either: it used to carry this as recon.gapLast50Pp, the
    schema was rewritten on 2026-08-19, and this script kept dereferencing the old key and
    raised on every tick for 18 hours. recon.db is the thing that actually owns the number.
    """
    try:
        db = sqlite3.connect(
            "file:%s?mode=ro" % os.path.join(BOT, "data", "recon.db"), uri=True
        )
        rows = db.execute(
            "SELECT gap_pp FROM recon WHERE ok=1 AND gap_pp IS NOT NULL "
            "ORDER BY position_id DESC LIMIT ?",
            (RECON_TAIL,),
        ).fetchall()
        db.close()
    except Exception:
        return None  # recon.db not created yet is normal, not an alarm
    gaps = [r[0] for r in rows]
    return statistics.median(gaps) if gaps else None


def main():
    try:
        d = json.load(urllib.request.urlopen(DASH, timeout=10))
    except Exception as ex:
        # the dashboard being down IS an alarm: the bot process serves it
        st = load()
        if fire(
            st,
            "dashboard-down",
            "BOT DOWN",
            f"dashboard unreachable on 127.0.0.1:8787\n{ex}",
            "high",
        ):
            save(st)
        return

    # .get() the whole way down. Every field below is a schema this script does not own, and
    # a monitor that crashes on a schema change is worse than one that prints less.
    if not isinstance(d, dict):
        print(
            f"[push] dashboard returned {type(d).__name__}, not an object",
            file=sys.stderr,
        )
        return
    t = d.get("truth") or {}
    k = d.get("risk") or {}
    st = load()
    changed = False

    # THE FLAG LIST COMES FROM THE BOT, NOT FROM HERE.
    #
    # This used to re-derive halted / recon / dd60 / plumbing / size from raw fields, which
    # duplicated buildAlerts in dashboard.ts and meant an alert added there did not page. It
    # also meant a renamed field silently dropped a whole condition. Now the bot decides what
    # is wrong and this decides whether to wake someone, which is the only split that keeps
    # the two from drifting. Anything added to buildAlerts pages automatically.
    flags = []
    alerts = d.get("alerts")
    # a list of dicts, or we want nothing to do with it. Being defensive about the CONTAINER
    # as well as the keys is the difference between a degraded tick and a dead one.
    for a in alerts if isinstance(alerts, list) else []:
        if not isinstance(a, dict):
            continue
        aid = a.get("id")
        msg = a.get("msg") or ""
        if not aid:
            continue
        prio = "high" if a.get("sev") == "crit" else "default"
        flags.append((aid, f"SNIPE {aid.upper()}", msg, prio))

    # The one alarm the dashboard cannot raise: recon lives in its own database, not in the
    # page. Read directly; the heartbeat uses the dashboard accounting fields.
    gap = recon_gap()
    if gap is not None and abs(gap) > RECON_LIMIT_PP:
        flags.append(
            (
                "recon",
                "SIM DRIFT",
                f"recon gap {gap:+.2f}pp past the {RECON_LIMIT_PP}pp alarm",
                "high",
            )
        )

    # Operator-visible config drift. Not an alert in the bot's sense (nothing is wrong), but
    # worth a line, because "who changed the size" cost an hour once.
    if st.get("size") is not None and st["size"] != k.get("tradeSizeEth"):
        flags.append(
            (
                "size",
                "TRADE SIZE CHANGED",
                f"{st['size']} -> {k.get('tradeSizeEth')} ETH",
                "high",
            )
        )
    if st.get("mode") is not None and st["mode"] != d.get("mode"):
        flags.append(
            ("mode", "MODE CHANGED", f"{st['mode']} -> {d.get('mode')}", "high")
        )

    for key, title, body, prio in flags:
        changed |= fire(st, key, title, body, prio)
    # clear resolved conditions so the next occurrence pushes again
    live = {f[0] for f in flags}
    for key in list(st.get("fired", {})):
        if key not in live:
            st["fired"].pop(key)
            changed = True

    if time.time() - st.get("heartbeat_at", 0) > HEARTBEAT_S:
        # The UTC-day headline is the same quantity as the dashboard and report.
        today = (d.get("money") or {}).get("today")
        today_text = (f"{today.get('n', 0)} main trades, booked {money_text(today.get('bookUsd'))}"
                      if today else "UTC-day total unavailable")
        epoch = (d.get("money") or {}).get("epoch")
        epoch_text = (f"{epoch.get('n', 0)} main trades, booked {money_text(epoch.get('bookUsd'))}"
                      if epoch else "accounting-period total unavailable")
        body = (
            f"{money_text(t.get('netWorthUsd'))} estimated ({money_text(t.get('walletEth'), ' ETH', 6)} cash), "
            f"{k.get('open')} open\n"
            f"today (UTC): {today_text}\n"
            f"since accounting reset: {epoch_text}\n"
            f"dd ${num(k.get('drawdownUsd')):.2f}/{num(k.get('drawdownLimitUsd')):.0f}  "
            f"recon {'n/a' if gap is None else f'{gap:+.2f}pp'}"
        )
        if send("snipe", body):
            st["heartbeat_at"] = time.time()
            changed = True

    st["size"], st["mode"] = k.get("tradeSizeEth"), d.get("mode")
    if changed or "size" not in st:
        save(st)


def money_text(value, suffix="", digits=2):
    if value is None:
        return "unavailable"
    try:
        return ("$" if not suffix else "") + f"{float(value):.{digits}f}" + suffix
    except (TypeError, ValueError):
        return "unavailable"


def num(v, default=0.0):
    """a missing or non-numeric field must not take the whole monitor down over a format spec"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def fire(st, key, title, body, prio):
    st.setdefault("fired", {})
    if key in st["fired"]:
        return False
    if send(title, body, prio):
        st["fired"][key] = time.time()
        return True
    return False


def load():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}


def save(st):
    tmp = STATE + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, STATE)


if __name__ == "__main__":
    # Exit 0 whatever happens. systemd marks the unit failed on a non-zero exit, and a unit
    # stuck in `failed` is how this script spent 18 hours not alerting anybody: the crash was
    # visible only to someone already running systemctl status. Log loudly, leave the timer
    # healthy, and let the next tick try again.
    try:
        main()
    except Exception:
        import traceback

        print("[push] MONITOR ITSELF FAILED, alerting is degraded:", file=sys.stderr)
        traceback.print_exc()
