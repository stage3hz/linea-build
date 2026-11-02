#!/bin/bash
# Local test stand for INVIZENT desktop: own server + TLS front + trusted local CA.
# Test-only: never run on a real user's machine or the production server.
set -euo pipefail
STAND=${STAND:-/tmp/invizent-stand}; ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$STAND" && cd "$STAND"
if [ ! -f ca.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 30 -subj "/CN=Invizent Local Test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
  openssl req -newkey rsa:2048 -nodes -keyout srv.key -out srv.csr -subj "/CN=api.invizent.com"
  printf "subjectAltName=DNS:api.invizent.com\nextendedKeyUsage=serverAuth\n" > ext.cnf
  openssl x509 -req -in srv.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out srv.crt -days 30 -extfile ext.cnf
fi
mkdir -p ~/.pki/nssdb; certutil -d sql:$HOME/.pki/nssdb -L >/dev/null 2>&1 || certutil -d sql:$HOME/.pki/nssdb -N --empty-password
certutil -d sql:$HOME/.pki/nssdb -L | grep -q invizent-test-ca || certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n invizent-test-ca -i ca.crt
grep -q "api.invizent.com" /etc/hosts || echo "127.0.0.1 api.invizent.com # invizent test stand" >> /etc/hosts
echo "Next: start server (DATA_DIR=$STAND/data PORT=3001 HOST=127.0.0.1 node $ROOT/server/src/index.js),"
echo "      STAND=$STAND node tls-front.mjs (port 443), STAND=$STAND node seed-accounts.mjs,"
echo "      (cd $ROOT/desktop && node build-ui.mjs), then: xvfb-run -a ./run.sh node e2ee-walk.cjs"
