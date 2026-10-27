#!/bin/bash
# Deploy this bot/ tree to the box, run the tests THERE, and snapshot the result in the
# box's own git so there is always something to roll back to.
#
# The restart is deliberately NOT part of this script. Deploying code and restarting the
# trading process are two decisions; this prints the restart command and stops.
#
#   ./deploy.sh              tar -> scp -> extract -> npm test -> git commit on the box
#   SNIPE_BOX=user@host      override the target (default: the tailnet box)
#
# Rollback on the box:  cd ~/snipe/bot && git log --oneline | head
#                       git checkout <sha> -- src scripts test && pm2 restart compute-1
set -euo pipefail
BOX="${SNIPE_BOX:-operator@localhost}"
KEY="${SNIPE_KEY:-$HOME/.ssh/example-host}"
SSH=(ssh -o ConnectTimeout=20)
SCP=(scp -o ConnectTimeout=20)
if [ -f "$KEY" ]; then SSH+=(-i "$KEY"); SCP+=(-i "$KEY"); fi

HERE="$(cd "$(dirname "$0")" && pwd)"
SHA=$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo nogit)
DIRTY=$(git -C "$HERE" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
STAMP=$(date -u +%Y%m%d-%H%M%S)
TAR="/tmp/snipe-deploy-$STAMP-$SHA.tgz"

# What the box runs, plus the files the suite reads: configdrift asserts README.md quotes
# the running strategy and that .env.example names every key, and those tests run THERE.
# data/, logs/, .env and node_modules are the box's own and are
# simply not in this list. Do NOT add them as --exclude patterns: tar matches a bare
# pattern against every path component, so --exclude 'logs' silently dropped
# src/logs/subscriber.ts from the very first deploy of this script (2026-09-06) and the
# box ran the old poller while its tests expected the new one.
PATHS=()
for p in src test scripts research package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example README.md DEPLOY.md deploy.sh; do
  [ -e "$HERE/$p" ] && PATHS+=("$p")
done
# COPYFILE_DISABLE stops macOS tar shipping ._* AppleDouble files, which broke vitest on
# the box once; the find on the far side is belt and braces for the same thing.
COPYFILE_DISABLE=1 tar -C "$HERE" --no-xattrs --no-mac-metadata \
  --exclude '__pycache__' --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  --exclude '*.log' --exclude '*.jsonl' --exclude '.DS_Store' --exclude '.push-state.json' \
  -czf "$TAR" "${PATHS[@]}"
echo "packed $(du -h "$TAR" | cut -f1) as $SHA (${DIRTY} uncommitted files on the laptop)"

"${SCP[@]}" "$TAR" "$BOX:/tmp/"
"${SSH[@]}" "$BOX" bash -s -- "$(basename "$TAR")" "$SHA" "$DIRTY" <<'REMOTE'
set -euo pipefail
TAR="$1"; SHA="$2"; DIRTY="$3"
cd ~/snipe/bot
# -m: do NOT keep the laptop's modification times. A shipped file older than vitest's
# cached transform of it is served from the cache, which is how a deploy's tests failed
# twice in a row on the box and passed on every manual rerun (2026-09-06, twice).
tar -xzmf "/tmp/$TAR"
find . -name '._*' -delete
# The extract is an overlay, so a file deleted on the laptop lived on here forever: two
# scripts deleted before 2026-09-06 were still on the box, and one of them was picked up by
# the code map's own inventory test. Remove source the tar no longer carries, code files
# only (data, caches, logs and .env are the box's own and are never in the manifest).
tar -tzf "/tmp/$TAR" | LC_ALL=C sort > /tmp/snipe-manifest.txt
find src test scripts research -type f \( -name '*.ts' -o -name '*.py' -o -name '*.cjs' -o -name '*.mjs' \) \
  ! -path '*__pycache__*' -print | while read -r f; do
  grep -qxF "${f#./}" /tmp/snipe-manifest.txt || { echo "   removing stale $f"; rm -f "$f"; }
done
rm -f /tmp/snipe-manifest.txt
rm -rf node_modules/.vite node_modules/.vitest 2>/dev/null || true
npm install --include=dev --no-audit --no-fund
echo "== tests on the box =="
# one retry: on 2026-09-06 a single test failed once in six box runs and never again, and a
# flake must not cost the rollback point. Two failures in a row is a real failure.
# NO_COLOR: vitest colours its output on the box, the escape codes sit between "FAIL" and
# the file name, and the greps below then match nothing. Under pipefail an empty grep is a
# failed pipeline, which on 2026-09-06 aborted the script before the retry and before the
# snapshot; the `|| true` keeps a report that finds nothing from ending the deploy.
run_suite() { NO_COLOR=1 npm test --silent > /tmp/snipe-test.log 2>&1; local rc=$?; grep -E "Test Files|Tests " /tmp/snipe-test.log || true; return $rc; }
if ! run_suite; then
  echo "   failed:"; { grep -E "^ *(×|✗)|FAIL +test/" /tmp/snipe-test.log | head -5 | sed 's/^/     /'; } || true
  echo "   (running the suite once more)"
  run_suite || { echo "   failed again:"; { grep -E "^ *(×|✗)|FAIL +test/|AssertionError" /tmp/snipe-test.log | head -8 | sed 's/^/     /'; } || true; echo "TESTS FAILED ON THE BOX TWICE; not committing the snapshot"; exit 2; }
fi
if [ -d .git ]; then
  git add -A -- src test scripts research package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example README.md DEPLOY.md deploy.sh >/dev/null
  git -c user.name=snipe -c user.email=snipe@box commit -qm "deploy $SHA (laptop had $DIRTY uncommitted files)" \
    && echo "snapshot: $(git log --oneline | head -1)" \
    || echo "snapshot: nothing changed since the last deploy"
else
  echo "NOTE: ~/snipe/bot is not a git repo yet; no snapshot taken (see the plan, item 11)"
fi
rm -f "/tmp/$TAR"
REMOTE
rm -f "$TAR"
echo
echo "deployed $SHA. restart when ready with:"
echo "  ${SSH[*]} $BOX 'cd ~/snipe/bot && pm2 restart compute-1 --update-env'"
