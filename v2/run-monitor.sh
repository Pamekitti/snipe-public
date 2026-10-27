#!/bin/bash
# The v2 monitor, read-only. It folds the tape the live bot writes and serves the dashboard.
#
# IT CANNOT TRADE. No signer, no sender, and the tape opens read-only. It also cannot stop the
# bot that IS trading, which is why the page carries no STOP button: a button that cannot do
# what it says is worse than no button.
#
# This file lives in the repo rather than only on the box. It was deleted once by a deploy
# that synced with --delete, and a runner that exists only on the host is a runner that is one
# careless flag away from gone.
set -euo pipefail
cd /srv/snipe-v2
export PORT=8789
export MONITOR_HOST=$(tailscale ip -4 2>/dev/null | head -1)
exec npx tsx tools/monitor.ts /srv/snipe/v1/data/tape.db config/strategy.toml
