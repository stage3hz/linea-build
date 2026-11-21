#!/bin/sh
# Runs tests/live_local.rs against a fresh LOCAL test server (server/ of this repository) and stops it.
#   NODE=/path/to/node PROTOC=/path/to/protoc native/core/tests/live-local.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../../.."
NODE="${NODE:-node}"; PORT="${PORT:-3996}"
DATA="$(mktemp -d)"
(cd "$ROOT/server" && DATA_DIR="$DATA" PORT="$PORT" HOST=127.0.0.1 "$NODE" src/index.js > "$DATA/server.log" 2>&1 & echo $! > "$DATA/pid")
trap 'kill "$(cat "$DATA/pid")" 2>/dev/null || true' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
(cd "$ROOT" && "$NODE" tools/native-sim-account.mjs "http://127.0.0.1:$PORT" livetester live_check >/dev/null)
cd "$HERE/.." && INVIZENT_LOCAL_SERVER="http://127.0.0.1:$PORT" INVIZENT_LOGIN=livetester INVIZENT_PASSWORD='Synthetic!Native.42' INVIZENT_WORD=ambergardenprism INVIZENT_HANDLE=live_check NODE="$NODE" \
  cargo test --features signal --test live_local -- --nocapture
