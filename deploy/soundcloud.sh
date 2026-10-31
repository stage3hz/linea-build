#!/usr/bin/env bash
# SoundCloud (официальный API, приложение на аккаунте Artist Pro). Ключи остаются только на этом сервере.
#   bash deploy/soundcloud.sh        — ввести Client ID и Client Secret (секрет не отображается)
#   bash deploy/soundcloud.sh off    — выключить SoundCloud (останется Audius)
set -euo pipefail
cd "$(dirname "$0")/.."
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
setenv() { local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"; }
mkdir -p deploy/secrets
if [ "${1:-}" = off ]; then
  rm -f deploy/secrets/soundcloud.json; setenv SOUNDCLOUD_CREDENTIALS ""; "${C[@]}" up -d api; echo "SoundCloud выключен."; exit 0
fi
read -r -p "Client ID: " id
read -r -s -p "Client Secret (не отображается): " secret; echo
[[ "$id" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || { echo "Client ID выглядит неправильно."; exit 1; }
[[ "$secret" =~ ^[A-Za-z0-9_-]{8,256}$ ]] || { echo "Client Secret выглядит неправильно."; exit 1; }
# Check the keys with SoundCloud before saving them (the secret goes only to secure.soundcloud.com).
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST https://secure.soundcloud.com/oauth/token \
  -u "$id:$secret" -H 'content-type: application/x-www-form-urlencoded' --data 'grant_type=client_credentials')"
[ "$code" = 200 ] || { echo "SoundCloud не принял ключи (код $code). Проверь Client ID и Secret в кабинете SoundCloud."; exit 1; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
printf '{"client_id":"%s","client_secret":"%s"}\n' "$id" "$secret" > "$tmp"
# The API container runs as uid 1000 (user «node»); only it may read the keys.
install -m 600 -o 1000 -g 1000 "$tmp" deploy/secrets/soundcloud.json
chown 1000:1000 deploy/secrets; chmod 700 deploy/secrets
setenv SOUNDCLOUD_CREDENTIALS /secrets/soundcloud.json
"${C[@]}" up -d api
echo "SoundCloud включён."
