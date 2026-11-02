#!/usr/bin/env bash
# Предложить пользователям обновление INVIZENT (Android и Windows).
#   bash deploy/release.sh v0.14.3            — 3 дня можно отложить (окно со счётчиком при каждом входе), потом обязательно
#   bash deploy/release.sh v0.14.3 24         — то же, но срок 24 часа (любое число часов 0–1440)
#   bash deploy/release.sh v0.14.3 now        — обязательно сразу (срочное исправление)
#   bash deploy/release.sh status             — что сейчас предлагается
#   bash deploy/release.sh off                — ничего не предлагать
# Берёт с GitHub файлы выпуска и их SHA-256 из SHA256SUMS. Приложение скачивает файл
# с GitHub и проверяет его по этой сумме, полученной от нашего сервера.
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REPO=stage3hz/linea-build
OUT=deploy/secrets/release.json
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
setenv() { local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"; }

case "${1:-}" in
  status) if [ -f "$OUT" ]; then cat "$OUT"; echo; else echo "Обновление не предлагается."; fi; exit 0 ;;
  off) rm -f "$OUT"; setenv MIN_CLIENT_VERSION ""; "${C[@]}" up -d api >/dev/null; echo "Обновление больше не предлагается."; exit 0 ;;
  v[0-9]*) ;;
  *) sed -n '2,7p' "$0"; exit 2 ;;
esac
TAG="$1"; GRACE="${2:-72}"
[[ "$TAG" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,5}$ ]] || { echo "Тег вида v0.14.3" >&2; exit 2; }
case "$GRACE" in now|required) GRACE=0 ;; esac
[[ "$GRACE" =~ ^[0-9]{1,4}$ ]] && [ "$GRACE" -le 1440 ] || { echo "Срок — число часов 0–1440 или now" >&2; exit 2; }
VERSION="${TAG#v}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "Читаю выпуск $TAG с GitHub…"
curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/tags/$TAG" -o "$WORK/release.json" \
  || { echo "Выпуск $TAG не найден на GitHub (или GitHub недоступен)." >&2; exit 1; }
SUMS_URL="$(python3 -c 'import json,sys; print(next((a["browser_download_url"] for a in json.load(open(sys.argv[1]))["assets"] if a["name"]=="SHA256SUMS"),""))' "$WORK/release.json")"
[ -n "$SUMS_URL" ] || { echo "В выпуске нет SHA256SUMS — без него обновление не публикуется." >&2; exit 1; }
curl -fsSL --max-time 60 "$SUMS_URL" -o "$WORK/SHA256SUMS"

python3 - "$WORK/release.json" "$WORK/SHA256SUMS" "$VERSION" "$GRACE" "$OUT.tmp" <<'PY'
import json, re, sys, datetime
release = json.load(open(sys.argv[1]))
sums = {}
for line in open(sys.argv[2]):
    m = re.match(r'^([0-9a-f]{64})\s+\*?(\S+)\s*$', line.strip())
    if m: sums[m.group(2)] = m.group(1)
version, grace, out = sys.argv[3], int(sys.argv[4]), sys.argv[5]
def pick(suffix):
    for a in release["assets"]:
        if a["name"].endswith(suffix):
            if a["name"] not in sums: sys.exit(f'Нет суммы для {a["name"]} в SHA256SUMS')
            return {"url": a["browser_download_url"], "sha256": sums[a["name"]], "size": a["size"]}
    return None
released = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
# A requirement that already took effect stays in force for the next release.
def vt(v): return tuple(int(x) for x in v.split("."))
carried = None
try:
    prev = json.load(open(out[:-4]))
    deadline = datetime.datetime.fromisoformat(prev["releasedAt"].replace("Z", "+00:00")) + datetime.timedelta(hours=prev.get("graceHours", 72)) if prev.get("releasedAt") else None
    candidates = [v for v in (prev.get("minVersion"), prev["version"] if deadline and released >= deadline else None) if v]
    carried = max(candidates, key=vt) if candidates else None
    if carried and vt(carried) >= vt(version): carried = None
except (OSError, ValueError, KeyError, TypeError): pass
manifest = {"version": version, "minVersion": carried, "releasedAt": released.isoformat().replace("+00:00", "Z"), "graceHours": grace,
            "page": release["html_url"], "notes": (release.get("body") or "")[:1000],
            "android": pick("-Android-arm64.apk"), "windows": pick("-Windows-x64.exe")}
if not manifest["android"] and not manifest["windows"]: sys.exit("В выпуске нет APK и EXE")
json.dump(manifest, open(out, "w"), ensure_ascii=False, indent=1)
for k in ("android", "windows"):
    print(f'{k}: {"есть, " + str(round(manifest[k]["size"]/1048576)) + " МБ" if manifest[k] else "нет"}')
PY
mkdir -p deploy/secrets
install -m 600 "$OUT.tmp" "$OUT"; rm -f "$OUT.tmp"
chown 1000:1000 "$OUT" 2>/dev/null || true
# The server re-reads the file by itself; no restart needed.
if [ "$GRACE" = 0 ]; then echo "Готово: версия $VERSION обязательна с этой минуты."
else echo "Готово: версия $VERSION предложена. Обязательной станет $(date -u -d "+$GRACE hours" '+%d.%m %H:%M UTC' 2>/dev/null || echo "через $GRACE ч")."; fi
