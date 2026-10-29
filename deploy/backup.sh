#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run from a trusted server operator account. The API is briefly stopped so the
# SQLite database, WAL and uploads are copied from the same quiescent state.
linea_deploy_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
linea_backup_dir="${1:?Usage: deploy/backup.sh /absolute/backup/directory}"
case "$linea_backup_dir" in /*) ;; *) echo 'Backup directory must be absolute.' >&2; exit 2;; esac
mkdir -p -- "$linea_backup_dir"
linea_backup_dir="$(CDPATH= cd -- "$linea_backup_dir" && pwd)"
linea_archive="linea-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
linea_compose=(docker compose --env-file "$linea_deploy_dir/.env" -f "$linea_deploy_dir/compose.production.yml")
linea_restart_needed=0
linea_restart() {
  if [ "$linea_restart_needed" = 1 ]; then "${linea_compose[@]}" start api; fi
}
trap linea_restart EXIT
"${linea_compose[@]}" config --quiet
"${linea_compose[@]}" stop api
linea_restart_needed=1
"${linea_compose[@]}" run --rm --no-deps --user 0 --cap-add DAC_READ_SEARCH --entrypoint tar \
  -v "$linea_backup_dir:/backup" api -czf "/backup/$linea_archive" -C /data .
"${linea_compose[@]}" start api
linea_restart_needed=0
sha256sum "$linea_backup_dir/$linea_archive"
echo 'Backup created. Copy it to separate protected storage and test a restore.'
