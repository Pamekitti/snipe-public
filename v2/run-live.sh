#!/bin/bash
# Live v2 on the box.
#
# pm2:  pm2 start ./run-live.sh --name snipe-v2-live --interpreter bash
#
# THIS SCRIPT SETS NO SWITCH THAT MOVES MONEY. It used to export MODE and TRADE_SIZE_ETH,
# and main.ts skipped any key already set, so the exports beat the file. MODE and
# TRADE_SIZE_ETH now live in ONE place, the switches file below, and nothing here can
# outvote it. New buys stop from STOP ALL on the dashboard.
set -euo pipefail
cd "$(dirname "$0")"

# The machine's description: the key, the endpoints, the chain. Shared with bot/ until it is
# deleted. Everything except the money switches is read from here.
export ENV_FILE="${ENV_FILE:-/srv/snipe/v1/.env}"
# v2's own switches: MODE and TRADE_SIZE_ETH. If this file is missing, main.ts refuses to boot.
export SWITCHES_FILE="${SWITCHES_FILE:-$PWD/.env}"
export PORT="${PORT:-8787}"
# Bind the tailnet address, not loopback: this page carries the STOP button, and a stop button
# only the box can reach is not a stop button. Falls back to loopback when tailscale is not up,
# and NEVER to 0.0.0.0 -- an internal dashboard that binds every interface is how one ends up on
# the internet. `run-monitor.sh` has done it this way since it was written.
export MONITOR_HOST="${MONITOR_HOST:-$(tailscale ip -4 2>/dev/null | head -1)}"
export MONITOR_HOST="${MONITOR_HOST:-127.0.0.1}"

[ -f "$SWITCHES_FILE" ] || echo "run-live: no switches file at $SWITCHES_FILE; v2 will refuse to boot."

# Keep the bot itself as the supervised process so SIGINT reaches its snapshot handler.
exec node --import tsx main.ts config/strategy.toml data/tape.db
