#!/bin/sh
# Real data on the running emulator: a test server started on THIS machine, a test account, really encrypted
# chats — and the debug build (already installed by emu-shots.sh) signing in to it, publishing its keys, and
# showing the list and a chat. Nothing here touches the real server.
#   ./emu-live.sh <folder for the pictures> <folder with ca.pem, leaf.pem, leaf.key>
# The app only speaks HTTPS: the server stands behind tools/sim-tls-proxy.mjs with a certificate of a test
# authority made for this run. The debug build trusts that authority for https://10.0.2.2 (the emulator's name
# for this machine) only if it was BUILT with INVIZENT_TEST_CA pointing at ca.pem; the leaf certificate must
# name IP:10.0.2.2. Needs node 24 and `npm ci` done in mobile/, server/ and desktop/.
set -eu
OUT="${1:?folder for the pictures}"
TLS="${2:?folder with ca.pem, leaf.pem and leaf.key}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APP=com.linea.messenger.preview
for perm in CAMERA RECORD_AUDIO READ_MEDIA_IMAGES READ_MEDIA_VIDEO READ_MEDIA_VISUAL_USER_SELECTED POST_NOTIFICATIONS; do
  adb shell pm grant "$APP" "android.permission.$perm" >/dev/null 2>&1 || true
done
WORK="$(mktemp -d)"
mkdir -p "$OUT" "$WORK/srvdata"

(cd "$ROOT/server" && DATA_DIR="$WORK/srvdata" PORT=3999 HOST=127.0.0.1 nohup node src/index.js > "$WORK/server.log" 2>&1 & echo $! > "$WORK/server.pid")
(cd "$ROOT" && nohup node tools/sim-tls-proxy.mjs "$TLS/leaf.pem" "$TLS/leaf.key" 8443 3999 > "$WORK/proxy.log" 2>&1 & echo $! > "$WORK/proxy.pid")
trap 'kill "$(cat "$WORK/server.pid")" "$(cat "$WORK/proxy.pid")" 2>/dev/null || true' EXIT
up=no
for i in $(seq 1 30); do if curl -fsS --cacert "$TLS/ca.pem" https://localhost:8443/health; then up=yes; break; fi; sleep 1; done
echo
[ "$up" = yes ] || { echo "The test server did not come up" >&2; tail -20 "$WORK/server.log" "$WORK/proxy.log" >&2; exit 1; }

echo "== account"
(cd "$ROOT" && node tools/native-sim-account.mjs http://127.0.0.1:3999 nativetester native_check) | sed 's/"password":"[^"]*"/"password":"…"/; s/"word":"[^"]*"/"word":"…"/'

live() { # name, seconds to wait, launch arguments…
  name="$1"; wait="$2"; shift 2
  adb shell am force-stop "$APP"
  adb shell am start -W -n "$APP/com.linea.messenger.MainActivity" --es server https://10.0.2.2:8443 "$@" | grep -E "Status|Error" || true
  sleep "$wait"
  adb shell am force-stop com.google.android.apps.nexuslauncher >/dev/null 2>&1 || true; sleep 1
  adb exec-out screencap -p > "$OUT/$name.png"
  [ "$(wc -c < "$OUT/$name.png")" -gt 2000 ] || { echo "No picture for $name" >&2; exit 1; }
  echo "shot $name"
}
# What the app asked of the server so far (method, path without the query, status): the proof that it was the
# app that spoke, whatever the pictures show.
asked() { grep -cE " $1 " "$WORK/proxy.log" || true; }

echo "== sign in (the app makes its keys and publishes them)"
# Made-up secrets of a made-up account that lives for this run (tools/native-sim-account.mjs).
live 07-signed-in 25 --es login nativetester --es password "'Synthetic!Native.42'" --es word ambergardenprism
echo "sign-in requests: $(asked 'POST /auth/login 200'), keys published: $(asked 'POST /e2ee/devices 20[01]'), chat lists read: $(asked 'GET /chats 200')"
[ "$(asked 'POST /auth/login 200')" -ge 1 ] || { echo "The app did not sign in" >&2; FAILED=1; }
[ "$(asked 'POST /e2ee/devices 20[01]')" -ge 1 ] || { echo "The app did not publish its keys" >&2; FAILED=1; }

echo "== other people write"
# SIM_SEED_FORWARD: also a small, a long (chunked) and a round video, and what the forward check below needs.
(cd "$ROOT" && SIM_SEED_FORWARD="$WORK/forward.json" node tools/sim-seed.mjs http://127.0.0.1:3999 native_check "$WORK/srvdata" nativetester 'Synthetic!Native.42' ambergardenprism) || { echo "seeding failed"; FAILED=1; }

echo "== the list and a chat (the session and the keys are read back from the device's storage)"
before="$(asked 'POST /auth/login 200')"
live 08-real-chats 25
live 09-real-chat 30 --ez openchat true
[ "$(asked 'POST /auth/login 200')" = "$before" ] || { echo "The app signed in again instead of using the kept session" >&2; FAILED=1; }
echo "chat lists read: $(asked 'GET /chats 200'), inbox pages: $(asked 'GET /e2ee/inbox 200'), message pages: $(grep -cE ' GET /chats/[^ ]+/messages 200 ' "$WORK/proxy.log" || true), read marks: $(grep -cE ' POST /chats/[^ ]+/read 20[04] ' "$WORK/proxy.log" || true)"
[ "$(grep -cE ' GET /chats/[^ ]+/messages 200 ' "$WORK/proxy.log" || true)" -ge 1 ] || { echo "The app did not open a chat" >&2; FAILED=1; }

echo "== offline: the test server stopped — the list and the chat come from the vault's copy, at once"
# The list is kept 1.5 s and an open chat's page 2 s after the server answered (offline/ChatCache.kt); the shots
# above waited longer. With the address refusing connections the app must still show the chats (names, lines,
# times) and the chat's messages, not «Загрузка…» or an error.
kill "$(cat "$WORK/proxy.pid")" 2>/dev/null || true
sleep 1
live 09d-offline-chats 12
live 09e-offline-chat 15 --ez openchat true
(cd "$ROOT" && nohup node tools/sim-tls-proxy.mjs "$TLS/leaf.pem" "$TLS/leaf.key" 8443 3999 >> "$WORK/proxy.log" 2>&1 & echo $! > "$WORK/proxy.pid")
for i in $(seq 1 30); do if curl -fsS --cacert "$TLS/ca.pem" https://localhost:8443/health >/dev/null; then break; fi; sleep 1; done

echo "== the other sections, with the same account"
live 09b-photo-open 35 --ez openchat true --es openattachment photo
live 10-people 25 --es tab people
live 11-profile 30 --es profile chat
live 12-people-search 30 --es peoplesearch simpeer
live 17-channels 25 --es tab channels
live 18-community 30 --es channels community
live 19-channel-chat 35 --es channels chat
live 13-settings 25 --es settings root
live 14-settings-profile 25 --es settings profile
live 15-settings-sessions 25 --es settings sessions
live 16-settings-security 25 --es settings security

echo "== forward: every attachment of the first chat (file, photo, voice, small, long and round video) goes on to Анна's chat"
# Last, as it reorders the list. The person there then opens each one with the reference's own code.
live 20-forward-real 60 --ez openchat true --es chataction forwardsend --es forwardto simpeer0
(cd "$ROOT" && node tools/sim-forward-check.mjs http://127.0.0.1:3999 "$WORK/forward.json" 150) || { echo "The forwarded attachments did not arrive whole" >&2; FAILED=1; }
echo "forward uploads: $(asked 'POST /e2ee/files 201') small, $(asked 'POST /e2ee/uploads 201') chunked"
live 21-forward-list 25

echo "== the requests, as the proxy saw them (last 60)"
tail -60 "$WORK/proxy.log" | cut -c1-160
echo "== the server's last words"
tail -5 "$WORK/server.log" || true
adb logcat -d -t 600 '*:E' > "$OUT/logcat-live-errors.txt" 2>/dev/null || true
[ -z "${FAILED:-}" ] || { echo "== live FAILED"; exit 1; }
echo "== live done"
