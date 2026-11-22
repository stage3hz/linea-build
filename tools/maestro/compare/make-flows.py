#!/usr/bin/env python3
"""The screens of the side-by-side comparison (.github/workflows/native-compare.yml), in one table.

    python3 tools/maestro/compare/make-flows.py

writes plan.txt (what the workflow runs, shard by shard) and the Maestro flows next to it: ref-NAME.yaml for the
previous app (always from its chat list, act/ref-home.yaml) and, where the native app is moved by gestures after its
launch arguments, nat/nat-NAME.yaml with the SAME gestures. Edit the table below and run it again; the act/*.yaml
pieces are shared and written by hand.
"""
import os, json, glob

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = 'appId: com.linea.messenger.preview\n---\n'

def q(s):
    return json.dumps(s, ensure_ascii=False)

# --- steps -------------------------------------------------------------------------------------------------
def tap(t, index=None, optional=False):
    s = f'- tapOn:\n    text: {q(t)}\n'
    if index is not None: s += f'    index: {index}\n'
    if optional: s += '    optional: true\n'
    return s + '- waitForAnimationToEnd\n'
def tapid(i, optional=False):
    return f'- tapOn:\n    id: {q(i)}\n' + ('    optional: true\n' if optional else '')
def hold(t):
    return f'- longPressOn:\n    text: {q(t)}\n- waitForAnimationToEnd\n'
def center(t, direction='UP', timeout=40000):
    return (f'- scrollUntilVisible:\n    element:\n      text: {q(t)}\n    direction: {direction}\n    timeout: {timeout}\n'
            f'    centerElement: true\n- waitForAnimationToEnd\n')
def reveal(t, direction='DOWN', timeout=30000):
    return f'- scrollUntilVisible:\n    element:\n      text: {q(t)}\n    direction: {direction}\n    timeout: {timeout}\n'
def wait(t, timeout=30000, optional=True):
    return f'- extendedWaitUntil:\n    visible: {q(t)}\n    timeout: {timeout}\n' + ('    optional: true\n' if optional else '')
def waitid(i, timeout=30000, optional=True):
    return f'- extendedWaitUntil:\n    visible:\n      id: {q(i)}\n    timeout: {timeout}\n' + ('    optional: true\n' if optional else '')
def typ(t):
    return f'- inputText: {q(t)}\n'
def swipe_up(times=1):
    return '- swipe:\n    start: "50%,78%"\n    end: "50%,30%"\n    duration: 700\n' * times + '- waitForAnimationToEnd\n'
def flow(name):
    return f'- runFlow: @ACT@/{name}\n'
def script(name):
    return f'- runScript: @ACT@/{name}\n'
def pause(ms):
    return f'- extendedWaitUntil:\n    visible: "a text that never shows 7f3k"\n    timeout: {ms}\n    optional: true\n'
SETTLE = '- waitForAnimationToEnd\n'
# The profile has covered the chat (its newest message is gone from the screen).
PROFILE_UP = '- extendedWaitUntil:\n    notVisible: ".*Как тебе фото.*"\n    timeout: 15000\n    optional: true\n- waitForAnimationToEnd\n'

# Reaching places in the reference (always from its chat list, act/ref-home.yaml first).
SETTINGS = tap('Настройки') + wait('Оформление.*')
def section(name):  # the list of sections (a hold on «Чаты»), then one of them
    return flow('sections.yaml') + tap(f'{name}.*')
def setting(row):
    return reveal(f'{row}.*') + tap(f'{row}.*', index=0)
OPEN_TIMUR = flow('open-timur.yaml')
OWN_PROFILE = tap('Мой профиль', index=0) + wait('Изменить.*', optional=True)
EDITOR = tap('Изменить', index=0) + wait('Имя пользователя.*', optional=True)
COMMUNITY = section('Каналы') + wait('Клан «Север».*', 60000, optional=False) + tap('Клан «Север».*') + wait('Текстовый канал общий.*', 60000)
CHANNEL = COMMUNITY + tap('Текстовый канал общий.*') + wait('.*глянь, пожалуйста.*', 60000)
MUSIC = section('Музыка') + wait('Слушать: .*', 60000)
PLAYER = tap('Слушать: .*', index=0) + wait('Открыть плеер.*', 30000) + tap('Открыть плеер.*', index=0)

# --- the pairs -----------------------------------------------------------------------------------------------
# (name, shard, phase, look, native wait s, native launch arguments, reference steps, native steps or None, native start)
#   reference steps: after act/ref-home.yaml (phase main), or from the start (phase auth / setup)
#   native steps: None = photographed right after the launch arguments; a string = then these gestures (nat/nat-NAME.yaml);
#                 'same' = the same gestures as the reference's part after `|`-split (see below)
#   native start: 'home' waits for the chat list, 'chat' for Тимур's chat (-openchat 1), '' nothing
P = []
def pair(name, shard, args, wait_s, ref, nat=None, start='', phase='main', look='dark'):
    # Native chat pairs start in Тимур's chat already (-openchat 1): the gestures shared are those after opening it.
    if start == 'chat' and '|' not in ref and ref.startswith(OPEN_TIMUR):
        ref = OPEN_TIMUR + '|' + ref[len(OPEN_TIMUR):]
    P.append(dict(name=name, shard=shard, phase=phase, look=look, wait=wait_s, args=args, ref=ref, nat=nat, start=start))

# The comparison's setup in the reference (shard 1 only; nothing photographed, the native app finds the result:
# the server, the encrypted storage and AsyncStorage carry over).
# Separate flows, so one that stops does not keep the others from running.
# A folder «Работа» with Максим and Анна (AsyncStorage, imported by the native app at its first start).
pair('00-setup-folder', 1, '', 0, SETTINGS + setting('Папки с чатами') + tap('Создать папку') + tap('Название, например «Работа»') + typ('Работа')
     + '- hideKeyboard\n' + tap('Максим Голубев', optional=True) + tap('Анна Лебедева', optional=True) + tap('Сохранить'), phase='setup')
# Лариса and Игорь are opened once, so their unread state is the same for both apps from here on.
pair('00-setup-read', 1, '', 0, tap('Лариса Новикова.*') + wait('.*Сообщение номер 24.*', 60000) + flow('ref-home.yaml')
     + reveal('Игорь.*') + tap('Игорь.*') + pause(4000), phase='setup')
# The account's own messages in Тимур's chat: a plain one (then edited) and a reply.
pair('00-setup-messages', 1, '', 0, OPEN_TIMUR + tapid('chat-composer') + typ('Буду через десять минут') + tapid('chat-send') + SETTLE
     + center('.*Список покупок.*') + hold('.*Список покупок.*') + tap('Ответить')
     + tapid('chat-composer') + typ('Молоко уже купил') + tapid('chat-send') + SETTLE
     + center('.*Буду через десять минут.*', 'DOWN') + hold('.*Буду через десять минут.*') + tap('Изменить')
     + typ(' или пятнадцать') + tapid('chat-send') + SETTLE, phase='setup')
# «Избранное»: a text, the photo, the file, the voice message, the round video and the forwarded message, chosen
# together and saved (the encrypted storage's saved:v1, which the native app reads after the update).
pair('00-setup-saved', 1, '', 0, OPEN_TIMUR + hold('.*Как тебе фото.*') + tap('Выбрать')
     + tap('Тимур Богданов: photo.png', optional=True) + tap('Тимур Богданов: Посмотри договор', optional=True)
     + tap('Тимур Богданов: voice-.*', optional=True)
     + center('Тимур Богданов: circle-.*') + tap('Тимур Богданов: circle-.*', optional=True)
     + center('.*Встреча переносится на пятницу.*') + tap('.*Встреча переносится на пятницу.*', optional=True)
     + tap('В Избранное'), phase='setup')
# A message to Вера, who blocked the account: refused by the server, it stays failed.
pair('00-setup-failed', 1, '', 0, reveal('Вера.*') + tap('Вера.*') + tapid('chat-composer') + typ('Это сообщение не дойдёт') + tapid('chat-send') + pause(6000), phase='setup')

# Shard 1: the chat list, the chat, «Избранное», stories.
pair('01-chatlist', 1, '', 25, '')
pair('02-chatlist-scrolled', 1, '', 25, flow('list-scroll.yaml'), 'same')
pair('03-chat-text', 1, '-openchat 1', 30, OPEN_TIMUR + flow('chat-top.yaml'), 'same', start='chat')
pair('04-chat-media', 1, '-openchat 1', 35, OPEN_TIMUR)
pair('05-message-menu', 1, '-openchat 1', 30, OPEN_TIMUR + hold('.*Как тебе фото.*'), 'same', start='chat')
pair('06-chat-avatar-peek', 1, '-openchat 1', 30, OPEN_TIMUR + flow('avatar-peek.yaml'), 'same', start='chat')
pair('17-attach-panel', 1, '-openchat 1', 30, OPEN_TIMUR + flow('paperclip.yaml'), 'same', start='chat')
pair('18-emoji-panel', 1, '-openchat 1', 30, OPEN_TIMUR + flow('emoji.yaml'), 'same', start='chat')
pair('19-chatlist-search', 1, '-chatsearch "Тим"', 30, flow('chat-search.yaml'))
pair('20-sections', 1, '', 25, flow('sections.yaml'), 'same')
pair('21-folder-tab', 1, '', 25, tap('Работа.*', index=0), 'same', start='home')
pair('22-archive', 1, '', 25, reveal('Архив.*') + tap('Архив.*', index=0), 'same', start='home')
pair('23-chat-top', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Собрал всё, что обещал.*'), 'same', start='chat')
pair('24-chat-photo-reply', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Это мы на даче.*'), 'same', start='chat')
pair('25-chat-album', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Три кадра с прогулки.*'), 'same', start='chat')
pair('26-chat-round-music', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Северный ветер.*'), 'same', start='chat')
pair('27-chat-link-poll', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Куда идём в субботу.*'), 'same', start='chat')
pair('28-chat-calls-edited', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Встречаемся в 19:00.*'), 'same', start='chat')
pair('29-chat-long', 1, '', 25, tap('Лариса Новикова.*') + wait('.*Сообщение номер 24.*', 60000), 'same', start='home')
pair('30-reply-bar', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Список покупок.*') + hold('.*Список покупок.*') + tap('Ответить'), 'same', start='chat')
pair('31-edit-bar', 1, '-openchat 1', 30, OPEN_TIMUR + hold('.*Буду через десять минут.*') + tap('Изменить'), 'same', start='chat')
pair('32-selection', 1, '-openchat 1', 30, OPEN_TIMUR + hold('.*Как тебе фото.*') + tap('Выбрать') + tap('.*Молоко уже купил.*', optional=True), 'same', start='chat')
pair('33-chat-search', 1, '-openchat 1', 30, OPEN_TIMUR + flow('avatar-peek.yaml') + tap('Поиск') + typ('молоко') + '- hideKeyboard\n' + SETTLE, 'same', start='chat')
pair('34-chat-header-menu', 1, '-openchat 1', 30, OPEN_TIMUR + tap('Ещё', index=0), 'same', start='chat')
pair('35-mini-profile', 1, '-openchat 1', 30, OPEN_TIMUR + tap('Тимур Богданов', index=0), 'same', start='chat')
pair('36-photo-menu', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Это мы на даче.*') + hold('.*Это мы на даче.*'), 'same', start='chat')
pair('37-photo-viewer', 1, '-openchat 1 -openattachment photo', 40, OPEN_TIMUR + center('Тимур Богданов: photo.png', 'DOWN') + tap('Тимур Богданов: photo.png') + pause(3000))
pair('38-saved', 1, '', 25, tap('Избранное.*', index=0) + pause(3000), 'same', start='home')
pair('39-saved-menu', 1, '', 25, tap('Избранное.*', index=0) + wait('.*Как тебе фото.*') + hold('.*Как тебе фото.*'), 'same', start='home')
pair('40-chat-failed', 1, '', 25, reveal('Вера.*') + tap('Вера.*') + pause(3000), 'same', start='home')
pair('41-chat-blocked', 1, '', 25, reveal('Игорь.*') + tap('Игорь.*') + pause(3000), 'same', start='home')
pair('42-new-chat', 1, '', 25, tap('Новый чат'), 'same', start='home')
pair('43-story-viewer', 1, '', 25, tap('Анна Лебедева.*', index=0) + pause(1500), 'same', start='home')
pair('44-own-story', 1, '', 25, tap('Моя история', index=0) + pause(1500), 'same', start='home')
pair('45-story-add', 1, '', 25, tap('Добавить историю', index=0) + pause(2500), 'same', start='home')
pair('46-chatlist-light', 1, '', 25, '', look='light')
pair('47-chat-light', 1, '-openchat 1', 35, OPEN_TIMUR, look='light')
# Last of shard 1 (a draft stays in Тимур's chat): the same words the native `-chatlist draft` writes.
pair('48-draft', 1, '-chatlist draft', 30, OPEN_TIMUR + tapid('chat-composer') + typ('Не забыть спросить про проектор') + '- hideKeyboard\n' + pause(4000) + flow('ref-home.yaml'))

# Shard 2: profiles, the profile editor and its sheets, Platina, settings pages, people.
pair('07-profile', 2, '-profile chat', 40, OPEN_TIMUR + tap('Профиль Тимур Богданов.*') + PROFILE_UP)
pair('08-settings', 2, '-settings root', 20, SETTINGS)
pair('09-appearance', 2, '-settings appearance', 20, SETTINGS + tap('Оформление.*'))
pair('10-privacy', 2, '-settings privacy', 20, SETTINGS + setting('Конфиденциальность'))
pair('11-people', 2, '-tab people', 25, section('Люди'))
PROFILE_TIMUR = OPEN_TIMUR + tap('Профиль Тимур Богданов.*') + PROFILE_UP
pair('49-profile-scrolled', 2, '-profile chat', 40, PROFILE_TIMUR + '|' + swipe_up(), 'same')
pair('50-profile-files', 2, '-profile chat', 40, PROFILE_TIMUR + '|' + reveal('Файлы.*') + tap('Файлы.*', index=0), 'same')
pair('51-profile-links', 2, '-profile chat', 40, PROFILE_TIMUR + '|' + reveal('Ссылки.*') + tap('Ссылки.*', index=0), 'same')
pair('52-person-posts', 2, '-tab people', 25, section('Люди') + '|' + tap('Профиль Анна Лебедева', index=0) + pause(3000), 'same')
pair('53-own-profile', 2, '-settings root', 20, SETTINGS + '|' + OWN_PROFILE, 'same')
pair('54-own-profile-scrolled', 2, '-settings root', 20, SETTINGS + '|' + OWN_PROFILE + swipe_up(), 'same')
pair('55-profile-editor', 2, '-settings profile', 25, SETTINGS + EDITOR)
pair('56-editor-banner', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + tap('Изменить баннер|Установить баннер', index=0), 'same')
pair('57-status-sheet', 2, '-settings root', 20, SETTINGS + '|' + tap('Сменить статус рядом с именем'), 'same')
pair('58-editor-pattern', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + reveal('Узор фона.*') + tap('Узор фона.*'), 'same')
pair('59-editor-color', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + reveal('Персональный цвет.*') + tap('Персональный цвет.*'), 'same')
pair('60-editor-birthday', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + reveal('День рождения.*') + tap('День рождения.*'), 'same')
pair('61-editor-studio', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + center('Рамки и анимации.*', 'DOWN'), 'same')
pair('62-editor-username', 2, '-settings username', 25, SETTINGS + EDITOR + tap('Имя пользователя.*', index=0))
pair('63-platina-showcase', 2, '-settings root', 20, SETTINGS + '|' + tap('Инвиз Platina', index=0) + pause(2000), 'same')
pair('64-notifications', 2, '-settings notifications', 20, SETTINGS + setting('Уведомления и звуки'))
pair('65-folders-settings', 2, '-settings root', 20, SETTINGS + '|' + setting('Папки с чатами'), 'same')
pair('66-power', 2, '-settings power', 20, SETTINGS + setting('Энергосбережение и анимации'))
pair('67-language', 2, '-settings language', 20, SETTINGS + reveal('Язык.*') + tap('Язык', index=0))
pair('68-night', 2, '-settings night', 20, SETTINGS + tap('Оформление.*') + setting('Ночная тема'))
pair('69-colors', 2, '-settings appearance', 20, SETTINGS + tap('Оформление.*') + '|' + setting('Свои цвета'), 'same')
pair('70-wallpapers', 2, '-settings appearance', 20, SETTINGS + tap('Оформление.*') + '|' + setting('Обои чатов'), 'same')
pair('71-lastseen', 2, '-settings lastseen', 20, SETTINGS + setting('Конфиденциальность') + setting('Время захода'))
pair('72-lastseen-allow', 2, '-settings lastseenallow', 20, SETTINGS + setting('Конфиденциальность') + setting('Время захода') + setting('Всегда показывать'))
pair('73-call-privacy', 2, '-settings callrules', 20, SETTINGS + setting('Конфиденциальность') + setting('Звонки'))
pair('74-passcode', 2, '-settings passcode', 20, SETTINGS + setting('Конфиденциальность') + tap('Код-пароль.*', index=0))
# The code entry is photographed and left: the code is never set (it would lock every later start).
pair('75-passcode-entry', 2, '-settings passcode', 20, SETTINGS + setting('Конфиденциальность') + tap('Код-пароль.*', index=0) + '|' + tap('Включить код-пароль'), 'same')
pair('76-people-search', 2, '-tab people', 25, section('Люди') + '|' + tap('Ник или имя пользователя') + typ('Лар') + pause(3000), 'same')
pair('77-settings-light', 2, '-settings root', 20, SETTINGS, look='light')
pair('78-profile-light', 2, '-profile chat', 40, PROFILE_TIMUR, look='light')
pair('79-people-light', 2, '-tab people', 25, section('Люди'), look='light')

# Shard 3: channels, rooms, music, AI, security pages, calls, then signed out: sign-in, registration, recovery.
pair('12-channels', 3, '-tab channels', 25, section('Каналы') + wait('Клан «Север».*', 60000))
pair('13-community', 3, '-channels community', 30, COMMUNITY)
pair('14-channel-chat', 3, '-channels chat', 35, CHANNEL)
pair('15-music', 3, '-tab music', 25, section('Музыка'))
pair('16-ai', 3, '-tab ai', 25, section('AI'))
pair('80-channel-mini-profile', 3, '-channels chat', 35, CHANNEL + '|' + tap('Профиль Dimas', index=0), 'same')
pair('81-channel-message-menu', 3, '-channels chat', 35, CHANNEL + '|' + hold('.*глянь, пожалуйста.*'), 'same')
pair('82-blog', 3, '-tab channels', 25, section('Каналы') + '|' + reveal('Заметки.*') + tap('Заметки.*', index=0) + pause(3000), 'same')
pair('83-room', 3, '-rooms room', 30, section('Каналы') + reveal('Вечерний созвон.*') + tap('Вечерний созвон.*', index=0) + pause(3000))
pair('84-voice-channel', 3, '-channels community', 30, COMMUNITY + '|' + tap('Голосовой канал Игра.*') + tap('Allow|Разрешить|OK', optional=True) + pause(6000), 'same')
pair('85-music-mini', 3, '-tab music', 25, MUSIC + '|' + tap('Слушать: .*', index=0) + pause(5000), 'same')
pair('86-music-player', 3, '-tab music', 25, MUSIC + '|' + PLAYER + pause(3000), 'same')
pair('87-music-queue', 3, '-tab music', 25, MUSIC + '|' + PLAYER + tap('Ещё', index=0), 'same')
pair('88-music-equalizer', 3, '-tab music', 25, MUSIC + '|' + PLAYER + tap('Эквалайзер', index=0), 'same')
pair('89-security', 3, '-settings security', 20, SETTINGS + setting('Безопасность и устройства'))
pair('90-security-sessions', 3, '-settings sessions', 20, SETTINGS + setting('Безопасность и устройства') + center('Сеанс: .*', 'DOWN'))
pair('91-blocked', 3, '-settings blocked', 20, SETTINGS + setting('Безопасность и устройства') + center('Заблокированные', 'DOWN'))
pair('92-data', 3, '-settings data', 20, SETTINGS + setting('Данные и память'))
pair('93-audio', 3, '-settings root', 20, SETTINGS + '|' + setting('Звук и микрофон'), 'same')
pair('94-overlay', 3, '-settings root', 20, SETTINGS + '|' + setting('Оверлей в играх'), 'same')
pair('95-channels-light', 3, '-tab channels', 25, section('Каналы') + wait('Клан «Север».*', 60000), look='light')
# Calls last of the main part: they leave call rows in Анна's and Тимур's chats.
pair('96-call-incoming', 3, '', 25, script('ring.js') + pause(7000) + '@SHOT@' + script('hangup.js'), 'same', start='home')
pair('97-call-outgoing', 3, '-openchat 1', 30, OPEN_TIMUR + '|' + tap('Позвонить', index=0) + tap('Allow|Разрешить|OK', optional=True) + pause(4000), 'same', start='chat')
pair('98-call-minimized', 3, '-openchat 1', 30, OPEN_TIMUR + '|' + tap('Позвонить', index=0) + tap('Allow|Разрешить|OK', optional=True) + pause(3000) + tap('Свернуть звонок') + pause(1500) + '@SHOT@' + tap('Завершить звонок|Завершить', index=0, optional=True), 'same', start='chat')
pair('99-call-history', 3, '-tab people', 25, section('Люди') + '|' + tap('Звонки.*', index=0) + pause(2000), 'same')
# Signed out (the workflow removes the app and the simulator's keychain, then installs it fresh).
SIGNIN = waitid('field-Логин', 300000, optional=False)
NAT_SIGNIN = wait('Логин.*|Войти.*', 120000)
def login_field():
    return ('- runFlow:\n    when:\n      visible:\n        id: "field-Логин"\n    commands:\n      - tapOn:\n          id: "field-Логин"\n')
STEP_PASSWORD = login_field() + typ('${LOGIN}') + '- pressKey: enter\n' + tap('Продолжить', optional=True) + waitid('field-Пароль', 30000) + wait('Пароль.*', 5000)
STEP_WORD = STEP_PASSWORD + tap('Показать: пароль', optional=True) + tapid('field-Пароль', optional=True) + typ('${PASSWORD}') + '- pressKey: enter\n' + tap('Продолжить', optional=True) + waitid('field-Слово подтверждения', 30000) + '- hideKeyboard\n'
pair('100-signin', 3, '-auth 1', 15, SIGNIN + '- hideKeyboard\n' + SETTLE, start='', phase='auth', nat=NAT_SIGNIN + '- hideKeyboard\n' + SETTLE)
pair('101-signin-password', 3, '-auth 1', 15, SIGNIN + '|' + STEP_PASSWORD + '- hideKeyboard\n', 'same', phase='auth')
pair('102-signin-word', 3, '-auth 1', 15, SIGNIN + '|' + STEP_WORD, 'same', phase='auth')
pair('103-register', 3, '-auth 1 -authmode register', 15, SIGNIN + tap('Создать аккаунт', index=0) + '- hideKeyboard\n', phase='auth')
pair('104-register-profile', 3, '-auth 1 -authmode profile', 15, SIGNIN + tap('Создать аккаунт', index=0) + login_field() + typ('newperson_check') + '- pressKey: enter\n' + tap('Продолжить', optional=True) + wait('Имя.*', 30000) + '- hideKeyboard\n', phase='auth')
pair('105-recover', 3, '-auth 1 -authmode recover', 15, SIGNIN + tap('Забыл пароль?') + '- hideKeyboard\n', phase='auth')

# --- writing -------------------------------------------------------------------------------------------------
for old in glob.glob(os.path.join(ROOT, 'ref-*.yaml')) + glob.glob(os.path.join(ROOT, 'nat', 'nat-*.yaml')):
    os.remove(old)
if os.path.exists(os.path.join(ROOT, 'names.txt')):
    os.remove(os.path.join(ROOT, 'names.txt'))

def body(steps, act, shotname):
    steps = steps.replace('@ACT@', act)
    shot = f'- takeScreenshot: {shotname}\n'
    return steps.replace('@SHOT@', shot) if '@SHOT@' in steps else steps + shot

plan = ['# The pairs of .github/workflows/native-compare.yml, one per line, in the order they are photographed:',
        '#   name | shard (matrix job) | phase | look | native wait (s) | native launch arguments',
        '# phase: setup = a reference-only flow before the shots (ref-NAME.yaml, nothing photographed); main = signed in;',
        '#        auth = signed out (the app and the simulator keychain are removed first). look: dark | light (the',
        '#        simulator appearance; the native app also gets -settheme light, and -settheme black after a light pair).',
        '# Reference: ref-NAME.yaml (from its chat list). Native: started with the launch arguments, photographed after',
        '# the wait, or — when nat/nat-NAME.yaml exists — moved on by that flow (the same gestures as the reference).',
        '# Pairs: compare/pair-NAME.jpg (reference left, native right), compare/diff-NAME.jpg and compare/REPORT.md.',
        '# Written by make-flows.py (edit the table there, not this file).', '']
for p in P:
    plan.append(f"{p['name']} | {p['shard']} | {p['phase']} | {p['look']} | {p['wait']} | {p['args']}")
    ref = p['ref']
    common = ref.split('|', 1)[1] if '|' in ref else ''
    refsteps = ref.replace('|', '', 1) if '|' in ref else ref
    head = f"# Comparison {'setup' if p['phase'] == 'setup' else 'shot'} {p['name']} of the reference app (.github/workflows/native-compare.yml, plan.txt).\n"
    if p['phase'] == 'main':
        refsteps = flow('ref-home.yaml') + refsteps
    elif p['phase'] == 'setup':
        refsteps = flow('ref-home.yaml') + refsteps
    else:
        refsteps = '- launchApp\n' + refsteps
    if p['phase'] == 'setup':
        text = APP + head + refsteps.replace('@ACT@', 'act')
    else:
        text = APP + head + body(refsteps, 'act', f"ref-{p['name']}")
    open(os.path.join(ROOT, f"ref-{p['name']}.yaml"), 'w', encoding='utf-8').write(text)
    nat = p['nat']
    if nat is None:
        continue
    if nat == 'same':
        nat = common if '|' in ref else ref
    start = {'home': flow('nat-home.yaml'), 'chat': flow('wait-timur.yaml'), '': ''}[p['start']]
    nhead = f"# Comparison shot {p['name']} of the native app, started by the workflow with: {p['args'] or '(no launch arguments)'}; then these gestures.\n"
    open(os.path.join(ROOT, 'nat', f"nat-{p['name']}.yaml"), 'w', encoding='utf-8').write(APP + nhead + body(start + nat, '../act', f"nat-{p['name']}"))

open(os.path.join(ROOT, 'plan.txt'), 'w', encoding='utf-8').write('\n'.join(plan) + '\n')
print(len([p for p in P if p['phase'] != 'setup']), 'pairs')
for s in (1, 2, 3):
    print('shard', s, len([p for p in P if p['shard'] == s and p['phase'] != 'setup']))
