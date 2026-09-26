#!/bin/sh
# Platform emu tests on private ports (a foreign emulator may hold the defaults).
#   node orch/tm.mjs lock emulators -- sh backend/test/platform/run-emu.sh [vitest filters…]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/opt/openjdk@21/bin:/usr/local/opt/openjdk@21/bin:$PATH"
cd "$HERE"
exec firebase emulators:exec --project demo-taskmanager --config "$HERE/firebase.json" --only auth,firestore,database,storage \
  "cd $HERE/../.. && pnpm exec vitest run --config test/harness/vitest.config.ts --project emu ${*:-test/platform}"
