#!/usr/bin/env bash
# Жалобы пользователей (только для администратора сервера). Переписка зашифрована — видны только кто, на кого и причина.
#   bash deploy/reports.sh            — открытые жалобы
#   bash deploy/reports.sh all        — все жалобы
#   bash deploy/reports.sh close ID   — закрыть жалобу
set -euo pipefail
cd "$(dirname "$0")/.."
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
case "${1:-}" in
  all) "${C[@]}" exec -T api node src/reports-admin.js list --all ;;
  close) [ -n "${2:-}" ] || { echo "Укажи ID жалобы."; exit 1; }; "${C[@]}" exec -T api node src/reports-admin.js resolve --id "$2" ;;
  *) "${C[@]}" exec -T api node src/reports-admin.js list ;;
esac
