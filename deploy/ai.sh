#!/usr/bin/env bash
# Управление бесплатным AI (FreeLLMAPI) на сервере Линии.
#   bash deploy/ai.sh setup-code      — показать код первой настройки панели
#   bash deploy/ai.sh key КЛЮЧ        — подключить единый ключ FreeLLMAPI к Линии
#   bash deploy/ai.sh off             — вернуть AI в выключенное состояние (OpenRouter без ключа)
#   bash deploy/ai.sh test            — проверить, отвечает ли AI
set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
C=(docker compose --env-file deploy/.env -f deploy/compose.production.yml)
setenv() { # setenv NAME VALUE — заменить или добавить строку в deploy/.env
  local tmp; tmp="$(mktemp)"; grep -v -E "^$1=" deploy/.env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"; install -m 600 "$tmp" deploy/.env; rm -f "$tmp"
}
case "${1:-}" in
  setup-code)
    "${C[@]}" logs --no-color freellmapi 2>/dev/null | grep -i -E "setup|code" | tail -5 || true
    echo "Если кода нет, перезапустите панель: ${C[*]} restart freellmapi — и повторите." ;;
  key)
    key="${2:-}"
    [[ "$key" =~ ^[A-Za-z0-9_.-]{16,256}$ ]] || { echo "Вставьте единый ключ со страницы Keys панели FreeLLMAPI." >&2; exit 2; }
    setenv AI_PROVIDER freellmapi; setenv AI_API_KEY "$key"; setenv AI_MODEL auto
    "${C[@]}" up -d api
    echo "Ключ записан. Проверка: bash deploy/ai.sh test" ;;
  off)
    setenv AI_PROVIDER openrouter; setenv AI_API_KEY ""; "${C[@]}" up -d api; echo "AI выключен." ;;
  test)
    "${C[@]}" exec -T freellmapi node -e "
      const key=process.argv[1];
      fetch('http://127.0.0.1:3001/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
        body:JSON.stringify({model:'auto',messages:[{role:'user',content:'Ответь одним словом: работает?'}],max_tokens:20})})
      .then(async r=>{const t=await r.text();console.log('HTTP',r.status,t.slice(0,300));}).catch(e=>console.log('Ошибка',e.message));
    " "$(grep -E '^AI_API_KEY=' deploy/.env | cut -d= -f2-)" ;;
  *) sed -n '2,6p' "$0"; exit 2 ;;
esac
