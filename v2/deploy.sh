#!/bin/bash
# Deploy this v2/ tree to the box, run the tests THERE, and leave restart to the operator.
#
# Cutover is not part of this script. It prints what to run after a green deploy.
#
#   ./deploy.sh              tar -> scp -> extract -> npm test
#   SNIPE_BOX=user@host      override the target (default: the tailnet box)
#   WITH_CONFIG=1            also ship config/, which CHANGES THE STRATEGY (see below)
#
# CONFIG IS NOT SHIPPED BY DEFAULT, AND THAT IS A MONEY RULE, NOT A PREFERENCE. main.ts watches
# `config/strategy.toml` and folds a `config-applied` the moment it changes, so a tar that
# carried the file moved the live bot's bands, guard thresholds and max trade size with no
# restart and nobody deciding anything. It also raced the watcher: the 2026-09-16 deploy logged
# `spec reload refused: missing the [risk] table` because the file was read while tar was still
# writing it. WITH_CONFIG=1 ships it deliberately, and prints the diff first.
set -euo pipefail
BOX="${SNIPE_BOX:-operator@localhost}"
KEY="${SNIPE_KEY:-$HOME/.ssh/example-host}"
SSH=(ssh -o ConnectTimeout=20)
SCP=(scp -o ConnectTimeout=20)
if [ -f "$KEY" ]; then SSH+=(-i "$KEY"); SCP+=(-i "$KEY"); fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)
DIRTY=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
STAMP=$(date -u +%Y%m%d-%H%M%S)
TAR="/tmp/snipe-v2-deploy-$STAMP-$SHA.tgz"

WITH_CONFIG="${WITH_CONFIG:-0}"
PATHS=()
for p in core drivers io projections test tools docs package.json package-lock.json tsconfig.json vitest.config.ts main.ts run-monitor.sh run-live.sh deploy.sh; do
  [ -e "$HERE/$p" ] && PATHS+=("$p")
done
if [ "$WITH_CONFIG" = "1" ]; then
  echo "== the strategy change this will apply, live, within a second of extraction =="
  "${SSH[@]}" "$BOX" 'cat ~/snipe-v2/config/strategy.toml 2>/dev/null' > /tmp/snipe-v2-box-strategy.toml 2>/dev/null || true
  diff -u /tmp/snipe-v2-box-strategy.toml "$HERE/config/strategy.toml" || true
  rm -f /tmp/snipe-v2-box-strategy.toml
  PATHS+=("config")
else
  echo "config/ is not being shipped; the box keeps the strategy it is running. WITH_CONFIG=1 to change it."
fi
COPYFILE_DISABLE=1 tar -C "$HERE" --no-xattrs --no-mac-metadata \
  --exclude '__pycache__' --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  --exclude '*.log' --exclude '.DS_Store' \
  -czf "$TAR" "${PATHS[@]}"
echo "packed $(du -h "$TAR" | cut -f1) as $SHA (${DIRTY} uncommitted files on the laptop)"

"${SCP[@]}" "$TAR" "$BOX:/tmp/"
"${SSH[@]}" "$BOX" bash -s -- "$(basename "$TAR")" "$SHA" "$DIRTY" <<'REMOTE'
set -euo pipefail
TAR="$1"; SHA="$2"; DIRTY="$3"
cd ~/snipe-v2
# THE TREE BEING REPLACED IS KEPT, and it is not a nicety. A change under core/ has to be
# proved against the live tape by replaying the OLD fold and the NEW one and comparing kernel
# ids (v1/DEPLOY.md). On 2026-09-17 this script extracted over the running code and deleted
# its own tarball, so the exact fold that had been holding the wallet no longer existed
# anywhere and the "before" number could not be produced at all. One snapshot per deploy, of
# what was there before it, is what makes that proof possible after the fact.
mkdir -p ~/snipe-v2-rollbacks
PREV="$HOME/snipe-v2-rollbacks/$(date -u +%Y%m%d-%H%M%S)-replaced.tgz"
tar --exclude node_modules --exclude data --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  -czf "$PREV" . 2>/dev/null || true
echo "   kept the replaced tree as $(basename "$PREV")"
# Oldest first, keep the last 20: a month of deploys, a few hundred MB at most.
ls -1t ~/snipe-v2-rollbacks/*.tgz 2>/dev/null | tail -n +21 | xargs -r rm -f

tar -xzmf "/tmp/$TAR"
find . -name '._*' -delete
tar -tzf "/tmp/$TAR" | LC_ALL=C sort > /tmp/snipe-v2-manifest.txt
find core drivers io projections test tools -type f \( -name '*.ts' \) -print 2>/dev/null | while read -r f; do
  grep -qxF "${f#./}" /tmp/snipe-v2-manifest.txt || { echo "   removing stale $f"; rm -f "$f"; }
done
rm -f /tmp/snipe-v2-manifest.txt
rm -rf node_modules/.vite node_modules/.vitest 2>/dev/null || true
npm install --include=dev --no-audit --no-fund
echo "== tests on the box =="
run_suite() { NO_COLOR=1 npm test --silent > /tmp/snipe-v2-test.log 2>&1; local rc=$?; grep -E "Test Files|Tests " /tmp/snipe-v2-test.log || true; return $rc; }
if ! run_suite; then
  echo "   failed:"; { grep -E "^ *(×|✗)|FAIL +test/" /tmp/snipe-v2-test.log | head -5 | sed 's/^/     /'; } || true
  echo "   (running the suite once more)"
  run_suite || { echo "   failed again:"; { grep -E "^ *(×|✗)|FAIL +test/|AssertionError" /tmp/snipe-v2-test.log | head -8 | sed 's/^/     /'; } || true; echo "TESTS FAILED ON THE BOX TWICE"; exit 2; }
fi
rm -f "/tmp/$TAR"
echo "deployed v2 $SHA (laptop had $DIRTY uncommitted files)"
REMOTE
rm -f "$TAR"
echo
echo "deployed v2 $SHA. cutover when flat (see plan step 12); this script does not restart anything."
