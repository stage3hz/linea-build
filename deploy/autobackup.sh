#!/usr/bin/env bash
# Автоматические зашифрованные бэкапы Инвиза с проверкой восстановления.
#
#   bash deploy/autobackup.sh install      один раз: ключ шифрования + ежедневный запуск (04:17)
#   bash deploy/autobackup.sh run          сделать бэкап сейчас (то же, что делает таймер)
#   bash deploy/autobackup.sh status       последний результат, список архивов, место
#   bash deploy/autobackup.sh key          показать ключ для восстановления (сохрани его ВНЕ сервера)
#   bash deploy/autobackup.sh remote NAME:путь   копировать архивы ещё и в rclone-хранилище
#   bash deploy/autobackup.sh restore ФАЙЛ.age   восстановить базу и файлы из архива
#
# Что в архиве: снимок базы (VACUUM INTO — сервер не останавливается), загруженные файлы,
# deploy/.env и deploy/secrets (ключи пушей, AI и т. п.). Всё шифруется age; ключ лежит в
# deploy/secrets/backup-age.key (600). Без копии ключа вне сервера архив не восстановить.
# После каждого архива скрипт сам расшифровывает его во временную папку и проверяет базу
# (integrity_check, внешние ключи, совпадение числа строк со снимком).
set -euo pipefail
umask 077

DEPLOY="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(dirname "$DEPLOY")"
KEY="$DEPLOY/secrets/backup-age.key"
CONF="$DEPLOY/secrets/backup.conf"
DEST="${INVIZENT_BACKUP_DIR:-/var/backups/invizent}"
KEEP_DAILY="${INVIZENT_BACKUP_KEEP:-14}"
C=(docker compose --env-file "$DEPLOY/.env" -f "$DEPLOY/compose.production.yml")
STATUS="$DEST/last-status.json"

say() { printf '%s\n' "$*"; }
die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "запусти от root"; }
conf() { [ -f "$CONF" ] && grep -E "^$1=" "$CONF" | tail -1 | cut -d= -f2- || true; }
ensure_tools() {
  command -v age >/dev/null && command -v age-keygen >/dev/null || { apt-get update -qq >/dev/null; apt-get install -y -qq age >/dev/null; }
  command -v age >/dev/null || die "не удалось установить age"
}
recipient() { age-keygen -y "$KEY"; }
api_image() { "${C[@]}" config --images 2>/dev/null | grep -m1 -- '-api$' || echo linea-production-api; }
write_status() { # ok|fail, message, archive
  local now; now="$(date -u +%FT%TZ)"
  printf '{"result":"%s","at":"%s","archive":"%s","message":"%s"}\n' "$1" "$now" "${3:-}" "$(printf '%s' "$2" | tr '"\n' "' ")" > "$STATUS"
}

cmd_install() {
  need_root; ensure_tools
  mkdir -p "$DEPLOY/secrets" "$DEST"; chmod 700 "$DEST"
  if [ ! -f "$KEY" ]; then age-keygen -o "$KEY" 2>/dev/null; chmod 600 "$KEY"; say "Создан ключ шифрования бэкапов."; fi
  cat > /etc/systemd/system/invizent-backup.service <<EOF
[Unit]
Description=Invizent encrypted backup with restore check
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $DEPLOY/autobackup.sh run
Nice=10
IOSchedulingClass=idle
EOF
  cat > /etc/systemd/system/invizent-backup.timer <<'EOF'
[Unit]
Description=Daily Invizent backup
[Timer]
OnCalendar=*-*-* 01:17:00 UTC
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now invizent-backup.timer >/dev/null
  say "Готово: бэкап каждую ночь около 04:17 по Москве, хранится $KEEP_DAILY последних, папка $DEST."
  say "Делаю первый бэкап сейчас…"
  cmd_run
  say ""
  say "ВАЖНО: сохрани ключ восстановления вне сервера (менеджер паролей, флешка):"
  say "  bash deploy/autobackup.sh key"
  say "Без него архивы не расшифровать, если сервер пропадёт целиком. Не отправляй ключ в чаты."
}

cmd_run() {
  need_root; ensure_tools
  [ -f "$KEY" ] || die "нет ключа — сначала: bash deploy/autobackup.sh install"
  mkdir -p "$DEST"; chmod 700 "$DEST"
  exec 9>"$DEST/.lock"; flock -n 9 || die "бэкап уже идёт"
  local stamp work archive snap manifest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$(mktemp -d "$DEST/.work-XXXXXX")"
  archive="$DEST/invizent-$stamp.tar.gz.age"
  trap 'rm -rf "$work"; "${C[@]}" exec -T api rm -rf /data/.backup >/dev/null 2>&1 || true' RETURN
  if ! (
    set -e
    "${C[@]}" ps --status running api | grep -q api || { echo "сервер api не запущен"; exit 1; }
    # Не забивать диск сервера: нужно место на архив и на его проверочную распаковку.
    need=$(( $("${C[@]}" exec -T api du -sk /data | cut -f1) * 3 + 1048576 ))
    free=$(df -Pk "$DEST" | awk 'NR==2{print $4}')
    [ "$free" -gt "$need" ] || { echo "мало места на диске: свободно $((free/1024)) МБ, нужно около $((need/1024)) МБ"; exit 1; }
    # 1. Снимок базы без остановки сервера.
    "${C[@]}" exec -T api rm -rf /data/.backup
    "${C[@]}" exec -T api node src/backup.js snapshot /data/.backup/snapshot.sqlite > "$work/manifest.json"
    # 2. Поток tar из контейнера: файлы без живой базы и её WAL, затем снимок под именем linea.sqlite.
    "${C[@]}" exec -T api tar -C /data -cf - --anchored \
      --exclude=./linea.sqlite --exclude=./linea.sqlite-wal --exclude=./linea.sqlite-shm --exclude=./.backup \
      --transform='s|^\./snapshot\.sqlite$|./linea.sqlite|' \
      . -C /data/.backup ./snapshot.sqlite > "$work/data.tar"
    tar -tf "$work/data.tar" | grep -qx './linea.sqlite' || { echo "в архиве нет базы"; exit 1; }
    # 3. Настройки сервера (без них восстановленный сервер не знает своих ключей).
    tar -C "$DEPLOY" -cf "$work/deploy.tar" .env secrets 2>/dev/null || tar -C "$DEPLOY" -cf "$work/deploy.tar" secrets
    tar -C "$work" -czf - manifest.json data.tar deploy.tar | age -r "$(recipient)" > "$archive.part"
    mv "$archive.part" "$archive"
    # 4. Проверка восстановления: расшифровать, распаковать, проверить базу в отдельном контейнере.
    mkdir "$work/restore"
    age -d -i "$KEY" "$archive" | tar -C "$work/restore" -xzf -
    mkdir "$work/restore/data"; tar -C "$work/restore/data" -xf "$work/restore/data.tar"
    chmod -R a+rX "$work/restore"
    docker run --rm --network none -v "$work/restore:/restore:ro" --entrypoint node "$(api_image)" \
      src/backup.js verify /restore/data/linea.sqlite /restore/manifest.json > "$work/verify.json"
  ) > "$work/log" 2>&1; then
    rm -f "$archive.part" "$archive"
    write_status fail "$(tail -3 "$work/log")" "$archive"
    say "Бэкап НЕ удался:"; tail -5 "$work/log"; return 1
  fi
  # 5. Хранить последние N архивов.
  ls -1t "$DEST"/invizent-*.tar.gz.age 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | xargs -r rm -f --
  # 6. Копия вне сервера, если настроена.
  local remote msg
  remote="$(conf REMOTE)"
  msg="ok, $(du -h "$archive" | cut -f1), проверка восстановления пройдена"
  if [ -n "$remote" ]; then
    if command -v rclone >/dev/null && rclone copy --no-traverse "$archive" "$remote" >/dev/null 2>"$work/rclone.log"; then
      rclone delete --min-age "$((KEEP_DAILY + 1))d" --include 'invizent-*.tar.gz.age' "$remote" >/dev/null 2>&1 || true
      msg="$msg, копия в $remote"
    else
      write_status fail "архив проверен, но не скопирован в $remote: $(tail -1 "$work/rclone.log" 2>/dev/null)" "$archive"
      say "Архив сделан и проверен, но копия в $remote не удалась."; return 1
    fi
  fi
  write_status ok "$msg" "$archive"
  say "Бэкап готов: $archive ($msg)"
}

cmd_status() {
  [ -f "$STATUS" ] && cat "$STATUS" || say "Бэкапов ещё не было."
  systemctl list-timers invizent-backup.timer --no-pager 2>/dev/null | sed -n 1,2p || true
  ls -lh "$DEST"/invizent-*.tar.gz.age 2>/dev/null | tail -5 || true
  df -h "$DEST" | tail -1
  [ -n "$(conf REMOTE)" ] && say "Копия вне сервера: $(conf REMOTE)" || say "Копия вне сервера: не настроена (bash deploy/autobackup.sh remote ...)"
}

cmd_key() {
  need_root; [ -f "$KEY" ] || die "ключа ещё нет"
  say "Ключ восстановления бэкапов Инвиза. Сохрани его целиком ВНЕ сервера и никому не отправляй:"
  say ""; grep -v '^#' "$KEY"; say ""
}

cmd_remote() {
  need_root; local target="${1:-}"
  [ -n "$target" ] || die "укажи хранилище rclone, например: bash deploy/autobackup.sh remote r2:invizent-backups"
  command -v rclone >/dev/null || { apt-get update -qq >/dev/null; apt-get install -y -qq rclone >/dev/null; }
  local name="${target%%:*}"
  rclone listremotes | grep -qx "$name:" || die "хранилища «$name» нет. Создай его сам: rclone config (ключи доступа вводишь только ты, на сервере)"
  rclone mkdir "$target" && rclone lsf "$target" >/dev/null || die "нет доступа к $target"
  touch "$CONF"; chmod 600 "$CONF"; grep -v '^REMOTE=' "$CONF" > "$CONF.tmp" || true; echo "REMOTE=$target" >> "$CONF.tmp"; mv "$CONF.tmp" "$CONF"
  say "Готово: архивы будут копироваться в $target. Проверка: bash deploy/autobackup.sh run"
}

cmd_restore() {
  need_root; ensure_tools
  local file="${1:-}"; [ -f "$file" ] || die "укажи файл архива .age"
  [ -f "$KEY" ] || die "нет ключа: положи сохранённый ключ в $KEY (chmod 600)"
  local work; work="$(mktemp -d)"; trap 'rm -rf "$work"' RETURN
  age -d -i "$KEY" "$file" | tar -C "$work" -xzf -
  mkdir "$work/data"; tar -C "$work/data" -xf "$work/data.tar"; chmod -R a+rX "$work"
  "${C[@]}" build api >/dev/null
  docker run --rm --network none -v "$work:/restore:ro" --entrypoint node "$(api_image)" \
    src/backup.js verify /restore/data/linea.sqlite /restore/manifest.json >/dev/null || die "архив не прошёл проверку — восстановление отменено"
  say "Архив проверен: $(cat "$work/manifest.json")"
  say "Восстановление ЗАМЕНИТ текущую базу и файлы сервера. Напиши ВОССТАНОВИТЬ, чтобы продолжить:"
  local answer; read -r answer; [ "$answer" = "ВОССТАНОВИТЬ" ] || die "отменено"
  "${C[@]}" stop api
  "${C[@]}" run --rm --no-deps --user 0 --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --entrypoint sh -v "$work/data:/restore:ro" api -c \
    'find /data -mindepth 1 -delete && cp -a /restore/. /data/ && chown -R node:node /data'
  if [ ! -f "$DEPLOY/.env" ]; then tar -C "$DEPLOY" -xf "$work/deploy.tar"; say "Восстановлены настройки сервера (.env и secrets)."; fi
  "${C[@]}" up -d api
  say "Восстановлено. Проверь: curl -s https://api.invizent.com/health"
}

case "${1:-}" in
  install) cmd_install ;;
  run) cmd_run ;;
  status) cmd_status ;;
  key) cmd_key ;;
  remote) shift; cmd_remote "${1:-}" ;;
  restore) shift; cmd_restore "${1:-}" ;;
  *) sed -n 2,9p "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
