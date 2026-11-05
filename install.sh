#!/usr/bin/env bash
# Линия 0.5.1 — установка сервера на новый VPS (Ubuntu 24.04, root).
# Использование:  bash install.sh api.ваш-домен.ru [api.второй-домен.com]
# Скрипт можно запускать повторно: данные (том linea-data) не удаляются.
set -euo pipefail
umask 022

HOST1="${1:-}"; HOST2="${2:-}"
valid() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]]; }
if [ -z "$HOST1" ] || ! valid "$HOST1" || { [ -n "$HOST2" ] && ! valid "$HOST2"; }; then
  echo "Укажите домен без https:// и без слеша, например:  bash install.sh api.example.ru" >&2; exit 2
fi
[ "$(id -u)" = 0 ] || { echo "Запустите от root." >&2; exit 2; }

DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$DIR"
[ -f deploy/compose.production.yml ] && [ -f server/Dockerfile ] || { echo "Не найдены server/ и deploy/ рядом со скриптом." >&2; exit 2; }

echo "== 1/5 Проверка DNS"
apt-get update -qq >/dev/null
apt-get install -y -qq ca-certificates curl dnsutils >/dev/null
MYIP="$(curl -4 -fsS https://api.ipify.org || true)"
for h in $HOST1 $HOST2; do
  got="$(dig +short A "$h" @1.1.1.1 | tail -1)"
  echo "  $h -> ${got:-нет записи}   (IP сервера: ${MYIP:-?})"
  if [ -z "$got" ] || [ -n "$MYIP" ] && [ "$got" != "$MYIP" ]; then
    echo "  ВНИМАНИЕ: запись A для $h пока не указывает на этот сервер. HTTPS-сертификат не выдастся, пока DNS не обновится." >&2
  fi
done

echo "== 2/5 Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -qq >/dev/null
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi
docker --version; docker compose version

echo "== 3/5 Настройки"
# deploy/Caddyfile.two — исходный шаблон; рабочий Caddyfile каждый раз собирается из него заново.
# Свежий deploy/Caddyfile из репозитория (i.sh только что скачал его, метки нет) обновляет шаблон —
# иначе правки Caddyfile в репозитории никогда не доходили до сервера. Собранный файл помечен
# первой строкой; при повторном запуске без скачивания шаблон остаётся прежним.
CADDY_MARK='# собрано install.sh из deploy/Caddyfile.two — не править вручную'
# (Файлы, собранные прежним install.sh, метки не имеют, но уже содержат блок панели AI.)
if [ ! -f deploy/Caddyfile.two ] || { [ "$(head -n1 deploy/Caddyfile)" != "$CADDY_MARK" ] && ! grep -q 'freellmapi:3001' deploy/Caddyfile; }; then
  cp deploy/Caddyfile deploy/Caddyfile.two
fi
if [ -n "$HOST2" ]; then
  { echo "$CADDY_MARK"; cat deploy/Caddyfile.two; } > deploy/Caddyfile
  H2="$HOST2"
else
  # Один домен: Caddy обслуживает только его.
  { echo "$CADDY_MARK"; sed '1s/.*/{$PUBLIC_HOST_RU} {/' deploy/Caddyfile.two; } > deploy/Caddyfile
  H2="$HOST1"
fi
# Сохраняем уже заданные секреты и настройки AI при повторном запуске.
keep() { [ -f deploy/.env ] && grep -E "^$1=" deploy/.env | tail -1 | cut -d= -f2- || true; }
# Several servers (deploy/cluster.md) and screen sharing (SFU): these lines are kept as they are.
KEEP_EXTRA="$( [ -f deploy/.env ] && grep -E "^(CLUSTER_|LITESTREAM_|SFU_|SUPPORT_EMAIL)[A-Z_]*=" deploy/.env | grep -v "^CLUSTER_BOOTSTRAP=" || true)"
OLDKEY="$(keep OPENROUTER_API_KEY)"
AI_PROVIDER_V="$(keep AI_PROVIDER)"; AI_API_KEY_V="$(keep AI_API_KEY)"; AI_MODEL_V="$(keep AI_MODEL)"
FLK="$(keep FREELLMAPI_ENCRYPTION_KEY)"; [ -n "$FLK" ] || FLK="$(openssl rand -hex 32)"
FCM_V="$(keep FCM_SERVICE_ACCOUNT)"; SC_V="$(keep SOUNDCLOUD_CREDENTIALS)"; APNS_V="$(keep APNS_CREDENTIALS)"; mkdir -p deploy/secrets
TURN_SECRET_V="$(keep TURN_SECRET)"; [ -n "$TURN_SECRET_V" ] || TURN_SECRET_V="$(openssl rand -hex 32)"
# Shared secret of the Cloudflare reserve entrance (deploy/edge.sh).
EDGE_SECRET_V="$(keep EDGE_SECRET)"; [ -n "$EDGE_SECRET_V" ] || EDGE_SECRET_V="$(openssl rand -hex 32)"
# Settings written by deploy/relay.sh and deploy/attest.sh must survive every update.
RELAY_MODE_V="$(keep FREELLMAPI_PROXY_MODE)"; RELAY_URL_V="$(keep FREELLMAPI_PROXY_URL)"; RELAY_TOKEN_V="$(keep FREELLMAPI_RELAY_TOKEN)"
RELAY_HOST_V="$(keep FREELLMAPI_RELAY_HOST)"; RELAY_IP_V="$(keep FREELLMAPI_RELAY_IP)"
MIN_CLIENT_V="$(keep MIN_CLIENT_VERSION)"; REQ_HEADER_V="$(keep REQUIRE_CLIENT_HEADER)"; ATTEST_KEY_V="$(keep ATTEST_KEY)"; ATTEST_MODE_V="$(keep ATTEST_MODE)"
DASH_HOST="${AI_DASHBOARD_HOST:-$(keep AI_DASHBOARD_HOST)}"
case "$HOST1" in *.nip.io|*.sslip.io) [ -n "$DASH_HOST" ] || DASH_HOST="ai.$HOST1";; esac
( umask 077; cat > deploy/.env <<EOF
PUBLIC_HOST_RU=$HOST1
PUBLIC_HOST_COM=$H2
ALLOWED_ORIGINS=
USER_STORAGE_MIB=
OPENROUTER_API_KEY=$OLDKEY
AI_PROVIDER=${AI_PROVIDER_V:-openrouter}
AI_API_KEY=$AI_API_KEY_V
AI_MODEL=${AI_MODEL_V:-auto}
FREELLMAPI_ENCRYPTION_KEY=$FLK
AI_DASHBOARD_HOST=$DASH_HOST
TURN_SECRET=$TURN_SECRET_V
EDGE_SECRET=$EDGE_SECRET_V
TURN_HOST=$HOST1
TURN_EXTERNAL_IP=$MYIP
FCM_SERVICE_ACCOUNT=$FCM_V
SOUNDCLOUD_CREDENTIALS=$SC_V
APNS_CREDENTIALS=$APNS_V
FREELLMAPI_PROXY_MODE=$RELAY_MODE_V
FREELLMAPI_PROXY_URL=$RELAY_URL_V
FREELLMAPI_RELAY_TOKEN=$RELAY_TOKEN_V
FREELLMAPI_RELAY_HOST=$RELAY_HOST_V
FREELLMAPI_RELAY_IP=$RELAY_IP_V
MIN_CLIENT_VERSION=$MIN_CLIENT_V
REQUIRE_CLIENT_HEADER=$REQ_HEADER_V
ATTEST_KEY=$ATTEST_KEY_V
ATTEST_MODE=$ATTEST_MODE_V
EOF
[ -z "$KEEP_EXTRA" ] || printf '%s\n' "$KEEP_EXTRA" >> deploy/.env
)
# Панель FreeLLMAPI: отдельный адрес с HTTPS. Вход защищён её собственным аккаунтом,
# а первый аккаунт создаётся только с одноразовым кодом из логов сервера.
# (Basic auth перед панелью не используется: панель сама шлёт заголовок Authorization.)
if [ -n "$DASH_HOST" ]; then
  cat >> deploy/Caddyfile <<EOF

$DASH_HOST {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}
	# The AI API itself is only for the messenger server (private network). From the internet
	# only the dashboard is reachable, so a leaked unified key cannot be used from outside.
	# (The dashboard's in-browser playground needs /v1 and stops working; use: bash deploy/ai.sh test)
	handle /v1* {
		respond "Not found" 404
	}
	handle {
		reverse_proxy freellmapi:3001
	}
}
EOF
fi
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
"${C[@]}" config --quiet

echo "== 4/5 Сборка и запуск (несколько минут)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 49160:49200/udp >/dev/null
  ufw allow 40000/udp >/dev/null; ufw allow 40000/tcp >/dev/null
fi
"${C[@]}" up -d --build
# Caddy reads its config only at start; restart so new hosts (e.g. the AI dashboard) get certificates.
"${C[@]}" restart caddy
# Calls relay (TURN). Its failure must not stop the messenger.
if [ -n "$MYIP" ]; then docker compose --env-file deploy/.env -f deploy/compose.turn.yml up -d || echo "  ВНИМАНИЕ: TURN для звонков не запустился (звонки через сложный NAT могут не соединяться)."; fi

echo "== 5/5 Проверка"
ok=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 5 "https://$HOST1/health" >/tmp/linea-health 2>/dev/null; then ok=1; break; fi
  sleep 6
done
"${C[@]}" ps
if [ "$ok" = 1 ]; then
  echo; echo "ГОТОВО. Ответ сервера: $(cat /tmp/linea-health)"
  echo "Адрес для приложения:  https://$HOST1"
  if [ -n "$DASH_HOST" ]; then
    echo; echo "Панель бесплатного AI (FreeLLMAPI): https://$DASH_HOST"
    echo "  Код первой настройки:   bash $DIR/deploy/ai.sh setup-code"
    echo "  После добавления ключей: bash $DIR/deploy/ai.sh key ВАШ_КЛЮЧ"
  fi
else
  echo; echo "Сервер запущен, но https://$HOST1/health пока не отвечает. Последние строки журнала:"
  "${C[@]}" logs --tail=40 caddy api
  echo "Частая причина — DNS ещё не обновился. Повторите позже:  bash $DIR/install.sh $HOST1 $HOST2"
fi
