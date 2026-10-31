#!/usr/bin/env bash
# Push-уведомления на iPhone (напрямую через Apple, APNs). Ключ .p8 остаётся только на этом сервере.
#   bash deploy/apns.sh /путь/к/AuthKey_XXXXXXXXXX.p8   — взять ключ из файла (Key ID берётся из имени)
#   bash deploy/apns.sh                                 — вставить содержимое .p8, затем Ctrl+D
#   bash deploy/apns.sh off                             — выключить
set -euo pipefail
cd "$(dirname "$0")/.."
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
setenv() { local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"; }
mkdir -p deploy/secrets
if [ "${1:-}" = off ]; then
  rm -f deploy/secrets/apns.json; setenv APNS_CREDENTIALS ""; "${C[@]}" up -d api; echo "Уведомления на iPhone выключены."; exit 0
fi
key="$(mktemp)"; tmp="$(mktemp)"; trap 'rm -f "$key" "$tmp"' EXIT
keyid=""
if [ -n "${1:-}" ]; then
  cat "$1" > "$key"
  base="$(basename "$1")"; [[ "$base" =~ ^AuthKey_([A-Z0-9]{10})\.p8$ ]] && keyid="${BASH_REMATCH[1]}"
else
  echo "Вставь содержимое файла .p8 (вместе со строками BEGIN/END) и нажми Ctrl+D:"; cat > "$key"
fi
grep -q 'BEGIN PRIVATE KEY' "$key" || { echo "Это не ключ .p8 от Apple."; exit 1; }
[ -n "$keyid" ] || read -r -p "Key ID (10 символов, из developer.apple.com → Keys): " keyid
read -r -p "Team ID (10 символов, developer.apple.com → Membership): " team
read -r -p "Bundle ID [com.linea.messenger.preview]: " bundle; bundle="${bundle:-com.linea.messenger.preview}"
[[ "$keyid" =~ ^[A-Z0-9]{10}$ ]] || { echo "Key ID выглядит неправильно."; exit 1; }
[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "Team ID выглядит неправильно."; exit 1; }
[[ "$bundle" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Bundle ID выглядит неправильно."; exit 1; }
js='const fs=require("fs");const [k,i,t,b,o]=process.argv.slice(1);const key=fs.readFileSync(k,"utf8");require("crypto").createPrivateKey(key);fs.writeFileSync(o,JSON.stringify({keyId:i,teamId:t,bundleId:b,key}))'
if command -v node >/dev/null; then node -e "$js" "$key" "$keyid" "$team" "$bundle" "$tmp" || { echo "Ключ не читается."; exit 1; }
else docker run --rm -v "$key:/k:ro" -v "$(dirname "$tmp"):/o" node:24-slim node -e "$js" /k "$keyid" "$team" "$bundle" "/o/$(basename "$tmp")" || { echo "Ключ не читается."; exit 1; }; fi
# The API container runs as uid 1000 (user «node»); only it may read the key.
install -m 600 -o 1000 -g 1000 "$tmp" deploy/secrets/apns.json
chown 1000:1000 deploy/secrets; chmod 700 deploy/secrets
setenv APNS_CREDENTIALS /secrets/apns.json
"${C[@]}" up -d api
echo "Уведомления на iPhone включены ($bundle)."
