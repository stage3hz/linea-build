#!/usr/bin/env bash
set -euo pipefail
# Disposable Docker-only lab, not the production VPS.
DIR=$(cd "$(dirname "$0")" && pwd)
command -v docker >/dev/null || { echo "Docker required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL required" >&2; exit 1; }
docker compose version >/dev/null
LAB_CERT_DIR=$(mktemp -d)
export LAB_CERT_DIR
PROJECT="ivzallow${RANDOM}$$"
cleanup() {
  docker compose -p "$PROJECT" -f "$DIR/compose.yml" down --remove-orphans -v >/dev/null 2>&1 || :
  rm -rf "$LAB_CERT_DIR"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -noenc \
  -keyout "$LAB_CERT_DIR/server.key" -out "$LAB_CERT_DIR/ca.crt" \
  -subj '/CN=api.lab.test' -addext 'subjectAltName=DNS:api.lab.test' -days 1 >/dev/null 2>&1
chmod 0600 "$LAB_CERT_DIR/server.key"
docker compose -p "$PROJECT" -f "$DIR/compose.yml" up -d api carrier
for attempt in 1 2 3; do
  if docker compose -p "$PROJECT" -f "$DIR/compose.yml" run --rm client-open; then break; fi
  [ "$attempt" -ne 3 ] || exit 1
  sleep 1
done
docker compose -p "$PROJECT" -f "$DIR/compose.yml" run --rm client-restricted
echo 'ALLOWLIST DOCKER NETWORK LAB: PASS (controlled network isolation only)'
