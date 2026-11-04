#!/usr/bin/env bash
# Platina by public username (only for the server owner, run on the server):
#   bash deploy/platina.sh @stage @aze @sosison        — бессрочно
#   bash deploy/platina.sh --days 30 @stage            — на 30 дней
#   bash deploy/platina.sh --revoke @stage             — отозвать
set -euo pipefail
cd "$(dirname "$0")/.."
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
mode=permanent; days=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days) mode=grant; days="${2:?укажи число дней}"; shift 2 ;;
    --revoke) mode=revoke; shift ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "Укажи хотя бы один @username."; exit 1; }
for name in "$@"; do
  user="${name#@}"
  id=$("${C[@]}" exec -T api node src/platina-admin.js lookup --data-dir /data --username "$user" | sed -n 's/.*"accountId":"\([0-9a-f-]*\)".*/\1/p') || true
  if [ -z "$id" ]; then echo "✗ @$user — аккаунт не найден"; continue; fi
  case "$mode" in
    permanent) "${C[@]}" exec -T api node src/platina-admin.js grant-permanent --data-dir /data --user-id "$id" --reason "Выдано владельцем сервера" >/dev/null && echo "✓ @$user — Platina бессрочно" ;;
    grant) until=$(date -u -d "+${days} days" +%Y-%m-%dT%H:%M:%SZ); "${C[@]}" exec -T api node src/platina-admin.js grant --data-dir /data --user-id "$id" --reason "Выдано владельцем сервера" --expires-at "$until" >/dev/null && echo "✓ @$user — Platina до $until" ;;
    revoke) "${C[@]}" exec -T api node src/platina-admin.js revoke --data-dir /data --user-id "$id" --reason "Отозвано владельцем сервера" >/dev/null && echo "✓ @$user — Platina отозвана" ;;
  esac
done
