#!/usr/bin/env bash
# Push-уведомления (Android, Firebase). Ключ сервисного аккаунта остаётся только на этом сервере.
#   bash deploy/push.sh /путь/к/ключу.json    — взять файл
#   bash deploy/push.sh                       — вставить содержимое JSON, затем Ctrl+D
#   bash deploy/push.sh off                   — выключить
set -euo pipefail
cd "$(dirname "$0")/.."
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
setenv() { local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"; }
mkdir -p deploy/secrets
if [ "${1:-}" = off ]; then
  rm -f deploy/secrets/fcm.json; setenv FCM_SERVICE_ACCOUNT ""; "${C[@]}" up -d api; echo "Push выключены."; exit 0
fi
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
if [ -n "${1:-}" ]; then cat "$1" > "$tmp"; else echo "Вставь содержимое JSON-ключа и нажми Ctrl+D:"; cat > "$tmp"; fi
node_check='const k=JSON.parse(require("fs").readFileSync(0,"utf8"));if(k.type!=="service_account"||!k.private_key||!k.client_email||!k.project_id)process.exit(1);console.log(k.project_id)'
if command -v node >/dev/null; then project="$(node -e "$node_check" < "$tmp")" || { echo "Это не ключ сервисного аккаунта Firebase."; exit 1; }
else project="$(docker run --rm -i node:24-slim node -e "$node_check" < "$tmp")" || { echo "Это не ключ сервисного аккаунта Firebase."; exit 1; }; fi
# The API container runs as uid 1000 (user «node»); only it may read the key.
install -m 600 -o 1000 -g 1000 "$tmp" deploy/secrets/fcm.json
chown 1000:1000 deploy/secrets; chmod 700 deploy/secrets
setenv FCM_SERVICE_ACCOUNT /secrets/fcm.json
"${C[@]}" up -d api
echo "Push включены (проект Firebase: $project)."
