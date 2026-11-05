#!/usr/bin/env bash
# Запасной вход в Инвиз через Cloudflare Worker — для тех, у кого VPN или сеть не пускают к
# адресу сервера напрямую. Приложение само переходит сюда, только если прямой адрес недоступен.
# Переписка остаётся сквозь зашифрованной: Worker лишь пересылает байты.
#   bash deploy/edge.sh setup   — развернуть Worker в вашем Cloudflare и проверить его
#   bash deploy/edge.sh check   — проверить, что запасной вход отвечает
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
WORKER=invizent-api
API=https://api.cloudflare.com/client/v4
SECRET="$(grep -E '^EDGE_SECRET=' deploy/.env | tail -1 | cut -d= -f2- || true)"
[ "${#SECRET}" -ge 32 ] || { echo "Нет EDGE_SECRET. Сначала обновите сервер (i.sh), затем повторите." >&2; exit 1; }

cf() { local method="$1" path="$2"; shift 2; curl -sS --max-time 60 -X "$method" "$API$path" -H "Authorization: Bearer $CF_TOKEN" "$@"; }
field() { python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("success"):
    print("ERR "+"; ".join(str(e.get("code"))+": "+str(e.get("message")) for e in d.get("errors",[]))); sys.exit(0)
r=d.get("result")
for k in sys.argv[1].split(".") if sys.argv[1] else []:
    r=(r[int(k)] if isinstance(r,list) else (r or {}).get(k)) if r is not None else None
print("" if r is None else r)' "$1"; }
ok() { case "$1" in ERR*) echo "Cloudflare ответил ошибкой: ${1#ERR }" >&2; exit 1;; esac; }

check() {
  local url="$1" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url/health" || true)"
  [ "$code" = 200 ] && { echo "✅ Запасной вход отвечает: $url"; return 0; }
  echo "Запасной вход пока не отвечает ($url, код ${code:-нет})."; return 1
}

setup() {
  cat <<'TXT'
Нужен API-токен Cloudflare с шаблоном «Edit Cloudflare Workers» (можно тот же, что для relay.sh).
Вставьте его ниже (ввод не отображается). Claude его не присылайте.
TXT
  read -rsp "Токен Cloudflare: " CF_TOKEN; echo
  [ -n "$CF_TOKEN" ] || { echo "Токен пустой." >&2; exit 2; }
  local account sub meta url i
  account="$(cf GET '/accounts?per_page=5' | field 0.id)"; ok "$account"
  [ -n "$account" ] || { echo "Токен не видит ни одного аккаунта." >&2; exit 1; }
  sub="$(cf GET "/accounts/$account/workers/subdomain" | field subdomain)"; ok "$sub"
  [ -n "$sub" ] || { echo "У аккаунта нет адреса *.workers.dev. Сначала выполните bash deploy/relay.sh setup." >&2; exit 1; }
  meta="$(mktemp)"
  python3 - "$SECRET" > "$meta" <<'PY'
import json,sys
print(json.dumps({"main_module":"index.js","compatibility_date":"2026-08-22",
  "bindings":[{"type":"secret_text","name":"EDGE_SECRET","text":sys.argv[1]}]}))
PY
  ok "$(cf PUT "/accounts/$account/workers/scripts/$WORKER" -F "metadata=@$meta;type=application/json" \
      -F "index.js=@deploy/edge-worker/index.js;type=application/javascript+module" | field id)"
  rm -f "$meta"
  ok "$(cf POST "/accounts/$account/workers/scripts/$WORKER/subdomain" -H 'Content-Type: application/json' --data '{"enabled":true,"previews_enabled":false}' | field enabled)"
  unset CF_TOKEN
  url="https://$WORKER.$sub.workers.dev"
  docker compose --env-file deploy/.env -f deploy/compose.production.yml up -d api >/dev/null
  echo "Worker развёрнут: $url"
  if [ "$url" != "https://invizent-api.invizent-8165e2.workers.dev" ]; then
    echo "⚠️  Адрес отличается от встроенного в приложение. Пришлите эту строку Claude: $url"
  fi
  # С российского сервера Cloudflare может отвечать урезанно — это не мешает пользователям с VPN.
  for i in 1 2 3 4 5 6; do check "$url" && break; sleep 10; done || true
}

case "${1:-}" in
  setup) setup ;;
  check) check "https://invizent-api.invizent-8165e2.workers.dev" ;;
  *) sed -n '2,6p' "$0"; exit 2 ;;
esac
