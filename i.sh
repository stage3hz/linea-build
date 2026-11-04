#!/usr/bin/env bash
# Short installer for typing in a provider's web console:
#   curl -sL raw.githubusercontent.com/stage3hz/linea-build/main/i.sh | bash -s api2.invizent.com
# Downloads server/, deploy/ and install.sh into /opt/linea and runs install.sh with the given domain(s).
set -euo pipefail
[ -n "${1:-}" ] || { echo "Укажите домен: ... | bash -s api2.invizent.com" >&2; exit 2; }
mkdir -p /opt/linea && cd /opt/linea
curl -fsSL https://codeload.github.com/stage3hz/linea-build/tar.gz/main | tar -xz --strip-components=1 linea-build-main/server linea-build-main/deploy linea-build-main/install.sh
exec bash install.sh "$@"
