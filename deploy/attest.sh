#!/usr/bin/env bash
# Защита сервера от поддельных и устаревших клиентов INVIZENT.
#   bash deploy/attest.sh on            — создать ключ подписи запросов, режим warn (только журнал)
#   bash deploy/attest.sh log           — показать запросы с неверной подписью за последние сутки
#   bash deploy/attest.sh enforce       — отклонять неподписанные запросы (403)
#   bash deploy/attest.sh warn | off    — вернуть журнал / выключить проверку подписи
#   bash deploy/attest.sh min 0.15.0    — не пускать клиентов старше версии (min off — снять)
#   bash deploy/attest.sh status        — текущие настройки (ключ не показывается)
# Ключ из шага "on" нужно один раз добавить в GitHub: репозиторий → Settings →
# Secrets and variables → Actions → New repository secret → имя ATTEST_KEY.
# Только сборки, собранные после этого, подписывают запросы, поэтому enforce
# включайте, когда на всех телефонах стоит такая сборка и "log" пуст.
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
setenv() { # setenv NAME VALUE — заменить или добавить строку в deploy/.env
  local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"
}
getenv() { grep -E "^$1=" deploy/.env | tail -1 | cut -d= -f2- || true; }
apply() { "${C[@]}" up -d api >/dev/null; echo "Сервер перезапущен с новыми настройками."; }

case "${1:-}" in
  on)
    key="$(getenv ATTEST_KEY)"
    if [ -z "$key" ]; then key="$(openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48)"; setenv ATTEST_KEY "$key"; fi
    setenv ATTEST_MODE warn; apply
    echo
    echo "Подпись запросов включена в режиме warn: неподписанные запросы пишутся в журнал, но проходят."
    echo "Добавьте этот ключ в GitHub как секрет ATTEST_KEY (Settings → Secrets and variables → Actions):"
    echo
    echo "    $key"
    echo
    echo "Ключ не отправляйте в чаты. Новые сборки после этого будут подписывать запросы." ;;
  enforce)
    [ -n "$(getenv ATTEST_KEY)" ] || { echo "Сначала: bash deploy/attest.sh on" >&2; exit 2; }
    setenv ATTEST_MODE enforce; apply
    echo "Теперь неподписанные запросы отклоняются. Откат: bash deploy/attest.sh warn" ;;
  warn) setenv ATTEST_MODE warn; apply ;;
  off) setenv ATTEST_MODE off; apply; echo "Проверка подписи выключена (ключ сохранён)." ;;
  log)
    "${C[@]}" logs --since 24h --no-color api 2>/dev/null | grep -F 'request signature check failed' | tail -40 || true
    echo "(пусто — значит все запросы за сутки были подписаны)" ;;
  min)
    v="${2:-}"
    if [ "$v" = off ]; then setenv MIN_CLIENT_VERSION ""; apply; echo "Ограничение версии снято."; exit 0; fi
    [[ "$v" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,5}$ ]] || { echo "Укажите версию в виде 0.15.0 или off" >&2; exit 2; }
    setenv MIN_CLIENT_VERSION "$v"; apply; echo "Клиенты старше $v получат «Обновите приложение»." ;;
  status)
    if [ -n "$(getenv ATTEST_KEY)" ]; then state="ключ задан"; else state="ключа нет"; fi
    echo "Подпись запросов: $state, режим $(getenv ATTEST_MODE)"
    echo "Минимальная версия клиента: $(getenv MIN_CLIENT_VERSION)" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
