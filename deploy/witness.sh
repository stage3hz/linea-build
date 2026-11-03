#!/usr/bin/env bash
# Sets up the witness server (deploy/cluster.md) on a fresh Ubuntu VPS, as root:
#   bash deploy/witness.sh w.invizent.com
# Asks for the cluster token (input hidden) and writes deploy/.env.witness (only root can read it).
set -euo pipefail
HOST="${1:-}"
[[ "$HOST" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "Укажите домен свидетеля, например: bash deploy/witness.sh w.invizent.com" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "Запустите от root." >&2; exit 2; }
cd "$(dirname -- "$0")/.."
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq ca-certificates curl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc; chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi
ENV=deploy/.env.witness
keep() { [ -f "$ENV" ] && grep -E "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
TOKEN="$(keep CLUSTER_TOKEN)"; PEERS="$(keep CLUSTER_PEERS)"
if [ -z "$TOKEN" ]; then read -rsp "Токен кластера (тот же, что в deploy/.env серверов; ввод скрыт): " TOKEN; echo; fi
[ ${#TOKEN} -ge 32 ] || { echo "Токен короче 32 символов." >&2; exit 2; }
[ -n "$PEERS" ] || PEERS='[{"id":"msk","url":"https://api.invizent.com"},{"id":"spb","url":"https://api2.invizent.com"}]'
( umask 077; printf 'WITNESS_HOST=%s\nCLUSTER_SELF=w\nCLUSTER_PEERS=%s\nCLUSTER_TOKEN=%s\n' "$HOST" "$PEERS" "$TOKEN" > "$ENV" )
docker compose --env-file "$ENV" -f deploy/compose.witness.yml up -d
sleep 8
echo "Проверка (503 и \"role\":\"witness\" — это нормально, приложения его пропускают):"
curl -s "https://$HOST/health" || true; echo
