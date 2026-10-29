#!/usr/bin/env bash
# Выход FreeLLMAPI в интернет через Cloudflare Worker (режим fetch-relay).
# Нужен, когда AI-провайдеры отказывают серверу по стране («User location is not supported», 403).
#   bash deploy/relay.sh setup   — проверить связь, развернуть Worker в вашем Cloudflare и подключить его
#   bash deploy/relay.sh check   — только проверить, не режет ли провайдер сервера трафик Cloudflare
#   bash deploy/relay.sh pin     — заново узнать IP Worker'а через DNS-over-HTTPS (если AI вдруг перестал отвечать)
#   bash deploy/relay.sh off     — вернуть прямой выход FreeLLMAPI
# Worker: examples/fetch-relay-worker из FreeLLMAPI (MIT), см. deploy/relay-worker/.
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
WORKER=invizent-ai-relay
API=https://api.cloudflare.com/client/v4
setenv() { # setenv NAME VALUE — заменить или добавить строку в deploy/.env
  local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"
}
need() { command -v "$1" >/dev/null || { echo "Не найдена программа $1. Установите: apt-get install -y $2" >&2; exit 1; }; }

check() {
  # В 2025 г. российские провайдеры начали обрывать соединения с Cloudflare примерно после 16 КБ
  # (https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/).
  # Качаем 200 КБ с Cloudflare: если дойдёт всё — Worker будет работать с этого сервера.
  local got
  got="$(curl -s -o /dev/null -w '%{size_download}' --max-time 25 'https://speed.cloudflare.com/__down?bytes=200000' || true)"
  if [ "${got:-0}" -ge 200000 ] 2>/dev/null; then
    echo "✅ Cloudflare доступен с сервера полностью (скачано $got байт)."; return 0
  fi
  echo "❌ Cloudflare с этого сервера урезан: скачано ${got:-0} из 200000 байт."
  echo "   Worker здесь работать не будет. Нужен сервер за границей — напишите Claude."
  return 1
}

cf() { # cf METHOD PATH [curl-args...] — запрос к API Cloudflare, ответ JSON в stdout
  local method="$1" path="$2"; shift 2
  curl -sS --max-time 60 -X "$method" "$API$path" -H "Authorization: Bearer $CF_TOKEN" "$@"
}
field() { python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("success"):
    errs="; ".join(str(e.get("code"))+": "+str(e.get("message")) for e in d.get("errors",[]))
    print("ERR "+(errs or "неизвестная ошибка")); sys.exit(0)
r=d.get("result")
for k in sys.argv[1].split(".") if sys.argv[1] else []:
    r=(r[int(k)] if isinstance(r,list) else (r or {}).get(k)) if r is not None else None
print("" if r is None else r)' "$1"; }
ok() { case "$1" in ERR*) echo "Cloudflare ответил ошибкой: ${1#ERR }" >&2; exit 1;; esac; }

doh() { # doh HOST — IPv4 адрес через DNS-over-HTTPS (обычный DNS сервера не отдаёт адреса *.workers.dev)
  local u
  for u in "https://1.1.1.1/dns-query?name=$1&type=A" "https://dns.google/resolve?name=$1&type=A"; do
    curl -s --max-time 10 -H 'accept: application/dns-json' "$u" | python3 -c '
import json,sys,ipaddress
try:
    for a in json.load(sys.stdin).get("Answer",[]):
        if a.get("type")==1: ipaddress.IPv4Address(a["data"]); print(a["data"]); sys.exit(0)
except Exception: pass
sys.exit(1)' && return 0
  done
  return 1
}
probe() { # probe URL TOKEN IP — код ответа Worker'а при подключении к указанному IP
  local host="${1#https://}"
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$host:443:$3" "$1" \
    -H "Fetch-Relay-Authorization: Bearer $2" -H 'Fetch-Relay-Target: https://httpbingo.org/get' || true
}
pin() { # pin URL TOKEN — найти рабочий IP, записать его в .env и перезапустить FreeLLMAPI
  local url="$1" token="$2" ip="" code="" i
  for i in $(seq 1 24); do
    ip="$(doh "${url#https://}" || true)"
    [ -n "$ip" ] && code="$(probe "$url" "$token" "$ip")"
    [ "$code" = 200 ] && break; sleep 5
  done
  [ "$code" = 200 ] || { echo "Worker не ответил (IP: ${ip:-не найден}, код: ${code:-нет}). Пришлите это Claude." >&2; exit 1; }
  setenv FREELLMAPI_PROXY_MODE fetch-relay
  setenv FREELLMAPI_PROXY_URL "$url"
  setenv FREELLMAPI_RELAY_TOKEN "$token"
  setenv FREELLMAPI_RELAY_HOST "${url#https://}"
  setenv FREELLMAPI_RELAY_IP "$ip"
  "${C[@]}" up -d freellmapi
  echo "Worker отвечает через $ip."
}

setup() {
  need curl curl; need python3 python3; need openssl openssl
  check || exit 1
  cat <<'TXT'

Теперь нужен API-токен Cloudflare (это не пароль, его можно в любой момент удалить):
  1. dash.cloudflare.com → значок профиля → Profile → API Tokens → Create Token
  2. Шаблон «Edit Cloudflare Workers» → Use template
  3. Account Resources: ваш аккаунт; Zone Resources: All zones → Continue → Create Token
  4. Скопируйте токен и вставьте ниже (ввод не отображается). Claude его не присылайте.
TXT
  read -rsp "Токен Cloudflare: " CF_TOKEN; echo
  [ -n "$CF_TOKEN" ] || { echo "Токен пустой." >&2; exit 2; }

  local account sub relay_token code url
  account="$(cf GET '/accounts?per_page=5' | field 0.id)"; ok "$account"
  [ -n "$account" ] || { echo "Токен не видит ни одного аккаунта. Проверьте Account Resources." >&2; exit 1; }

  sub="$(cf GET "/accounts/$account/workers/subdomain" | field subdomain)"
  if [ -z "$sub" ] || [[ "$sub" == ERR* ]]; then # у нового аккаунта адреса *.workers.dev ещё нет
    sub="invizent-$(openssl rand -hex 3)"
    ok "$(cf PUT "/accounts/$account/workers/subdomain" -H 'Content-Type: application/json' --data "{\"subdomain\":\"$sub\"}" | field subdomain)"
  fi

  relay_token="$(openssl rand -hex 32)"
  local meta; meta="$(mktemp)"
  python3 - "$relay_token" > "$meta" <<'PY'
import json,sys
print(json.dumps({"main_module":"index.js","compatibility_date":"2026-08-22",
  "compatibility_flags":["enable_request_signal","global_fetch_strictly_public"],
  "bindings":[{"type":"secret_text","name":"RELAY_TOKEN","text":sys.argv[1]}]}))
PY
  ok "$(cf PUT "/accounts/$account/workers/scripts/$WORKER" \
      -F "metadata=@$meta;type=application/json" \
      -F "index.js=@deploy/relay-worker/index.js;type=application/javascript+module" | field id)"
  rm -f "$meta"
  ok "$(cf POST "/accounts/$account/workers/scripts/$WORKER/subdomain" -H 'Content-Type: application/json' --data '{"enabled":true,"previews_enabled":false}' | field enabled)"
  unset CF_TOKEN

  url="https://$WORKER.$sub.workers.dev"
  echo "Worker развёрнут: $url — жду, пока адрес заработает…"
  pin "$url" "$relay_token"
  echo
  echo "✅ Готово: FreeLLMAPI ходит к провайдерам через Cloudflare."
  echo "   Откройте панель AI → Keys → «Проверить все»."
}

case "${1:-}" in
  setup) setup ;;
  check) check ;;
  pin)
    url="$(grep -E '^FREELLMAPI_PROXY_URL=' deploy/.env | cut -d= -f2- || true)"
    token="$(grep -E '^FREELLMAPI_RELAY_TOKEN=' deploy/.env | cut -d= -f2- || true)"
    [ -n "$url" ] && [ -n "$token" ] || { echo "Worker ещё не настроен: bash deploy/relay.sh setup" >&2; exit 1; }
    pin "$url" "$token" ;;
  off)
    for v in PROXY_MODE PROXY_URL RELAY_TOKEN RELAY_HOST RELAY_IP; do setenv "FREELLMAPI_$v" ""; done
    "${C[@]}" up -d freellmapi; echo "FreeLLMAPI снова выходит в интернет напрямую." ;;
  *) sed -n '2,6p' "$0"; exit 2 ;;
esac
