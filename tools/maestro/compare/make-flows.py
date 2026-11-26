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
# A tap made once: Maestro may tap again when it sees no change on the screen, and on a control that opens a panel
# drawn by the app itself (nothing new for Maestro to read) the second tap shuts what the first one opened.
def tap_once(t, index=None):
    s = f'- tapOn:\n    text: {q(t)}\n'
    if index is not None: s += f'    index: {index}\n'
    return s + '    retryTapIfNoChange: false\n- waitForAnimationToEnd\n'
# A tap that is not followed by a wait for the screen to come to rest: what it opens keeps moving (a story's
# progress line), and by the time Maestro stops waiting the story has played out and closed.
# The tap's own wait for the screen to settle is cut short too (it lasted the whole story on its own: both apps were
# back on the chat list, or on the next person's story, in the run of 00dde8d5).
def tap_now(t, index=None):
    s = f'- tapOn:\n    text: {q(t)}\n'
    if index is not None: s += f'    index: {index}\n'
    return s + '    retryTapIfNoChange: false\n    waitToSettleTimeoutMs: 300\n'
def tapid(i, optional=False):
    return f'- tapOn:\n    id: {q(i)}\n' + ('    optional: true\n' if optional else '')
def hold(t):
    return f'- longPressOn:\n    text: {q(t)}\n- waitForAnimationToEnd\n'
# A scroll to a message. One of its swipes can be taken for a hold on the message under the finger (the native 24 and
# 25 of the run of 00dde8d5 stopped under a photo's menu, which then kept the list from moving): the first try is
# given part of the time, a menu that came is put away by a touch above it, and the scroll is made again.
MENU = 'Переслать'
def center(t, direction='UP', timeout=40000):
    one = (f'- scrollUntilVisible:\n    element:\n      text: {q(t)}\n    direction: {direction}\n    timeout: @T@\n'
           f'    centerElement: true\n')
    again = '- tapOn:\n    point: "50%,8%"\n- waitForAnimationToEnd\n' + one.replace('@T@', str(timeout))
    return (one.replace('@T@', str(min(timeout, 45000))) + '    optional: true\n' + when(MENU, again)
            + when(t, one.replace('@T@', str(timeout)), visible=False) + '- waitForAnimationToEnd\n')
def reveal(t, direction='DOWN', timeout=30000):
    return f'- scrollUntilVisible:\n    element:\n      text: {q(t)}\n    direction: {direction}\n    timeout: {timeout}\n'
def wait(t, timeout=30000, optional=True):
    return f'- extendedWaitUntil:\n    visible: {q(t)}\n    timeout: {timeout}\n' + ('    optional: true\n' if optional else '')
def waitid(i, timeout=30000, optional=True):
    return f'- extendedWaitUntil:\n    visible:\n      id: {q(i)}\n    timeout: {timeout}\n' + ('    optional: true\n' if optional else '')
def typ(t):
    return f'- inputText: {q(t)}\n'
def tap_point(p):
    return f'- tapOn:\n    point: {q(p)}\n- waitForAnimationToEnd\n'
def swipe_up(times=1):
    return '- swipe:\n    start: "50%,78%"\n    end: "50%,30%"\n    duration: 700\n' * times + '- waitForAnimationToEnd\n'
def flow(name):
    return f'- runFlow: @ACT@/{name}\n'
def script(name):
    return f'- runScript: @ACT@/{name}\n'
def pause(ms):
    return f'- extendedWaitUntil:\n    visible: "a text that never shows 7f3k"\n    timeout: {ms}\n    optional: true\n'
SETTLE = '- waitForAnimationToEnd\n'
# A step made only while something is (not) on the screen.
def when(t, steps, visible=True):
    body = ''.join('      ' + line + '\n' for line in steps.rstrip('\n').split('\n'))
    return f"- runFlow:\n    when:\n      {'visible' if visible else 'notVisible'}: {q(t)}\n    commands:\n" + body
# A message of the open chat. The reference keeps its chat list under the chat, and the list's rows («Избранное»,
# Тимур's own row) repeat the words of the newest messages: a hold on «.*Как тебе фото.*» landed on whatever stood
# over such a row (the run of d526af5f held the photo). The reference's bubbles read «<author>: <text>»
# (mobile/src/MessageRow.tsx), which no row of the list does; the native app has only the chat on screen.
THEIRS = '@THEIRS@'
OURS = '@OURS@'
# «Выбрать» of a message's menu. The reference's chat list, still under the chat, has a «Выбрать» of its own in its
# header and Maestro found that one first (the run of d526af5f: the menu shut and nothing was chosen): the menu's
# is the one under «Удалить».
PICK = '- tapOn:\n    text: "Выбрать"\n    below: "Удалить"\n- waitForAnimationToEnd\n'
# The keyboard put away. The reference: Maestro's hideKeyboard. The native sign-in screen has no standard dismiss
# action (hideKeyboard failed there in the third run) but puts the keyboard away on a touch beside its card
# (native/ios/Sources/Auth/AuthViewController.swift, putKeyboardAway / gestureRecognizer(_:shouldReceive:)):
# a touch at the left edge, outside the card (the card keeps 16 pt or more from the edges).
HIDEKB = '@HIDEKB@'
HIDEKB_REF = '- hideKeyboard\n'
HIDEKB_NAT = '- tapOn:\n    point: "2%,35%"\n- waitForAnimationToEnd\n'
# The profile has covered the chat (its newest message is gone from the screen).
PROFILE_UP = '- extendedWaitUntil:\n    notVisible: ".*Как тебе фото.*"\n    timeout: 15000\n    optional: true\n- waitForAnimationToEnd\n'

# Reaching places in the reference (always from its chat list, act/ref-home.yaml first).
# «Настройки» in the tab bar: a tap that lands while the list is still settling after the start is sometimes lost
# (third run: 65, 90, 91 stayed on the chat list and then scrolled it), so it is tapped again when the page did
# not come, and the page must be there before anything else is done.
SETTINGS = (tap('Настройки') + wait('Оформление.*', 10000)
            + '- runFlow:\n    when:\n      notVisible: "Оформление.*"\n    commands:\n      - tapOn:\n          text: "Настройки"\n      - waitForAnimationToEnd\n'
            + wait('Оформление.*', 12000)
            # A third try by the place of the bar's «Настройки» (the reference's setup of the folder stopped on the chat
            # list in the run of fd7a62c4, the app just started and its stories not there yet).
            + '- runFlow:\n    when:\n      notVisible: "Оформление.*"\n    commands:\n      - tapOn:\n          point: "61%,93%"\n      - waitForAnimationToEnd\n'
            + wait('Оформление.*', 30000, optional=False))
def section(name):  # the list of sections (a hold on «Чаты»), then one of them
    return flow('sections.yaml') + tap(f'{name}.*')
def setting(row):
    return reveal(f'{row}.*') + tap(f'{row}.*', index=0)
# A row that a plain reveal leaves at the bottom edge, under the floating tab bar: the tap then lands on the bar's
# «Чаты» (fourth run: ref-89 and ref-92 photographed the chat list, ref-90 and ref-91 then found nothing on it).
# Moved to the middle first; only for rows with more of the page below them (centring needs room to scroll).
def setting_low(row):
    return center(f'{row}.*', 'DOWN') + tap(f'{row}.*', index=0)
# A sideways swipe over a horizontal row of chips or tabs, starting on one of them (the rest is off the screen's edge).
def swipe_left_from(t):
    return f'- swipe:\n    from:\n      text: {q(t)}\n    direction: LEFT\n    duration: 600\n- waitForAnimationToEnd\n'
OPEN_TIMUR = flow('open-timur.yaml')
# The reference's list with its live line up: the title says «Чаты» again («Соединение…» and «Обновление…» before
# that, act/ref-home.yaml goes on under either). Until then the stories strip is not there and the list is still
# being filled: in the run of 0d627ba4 the reference of 20, 43 and 44 was photographed, or stopped, under
# «Соединение…» with no stories. Waited for, not required: a list that never connects is photographed as it is.
REF_LIVE = '- extendedWaitUntil:\n    visible: "Чаты"\n    timeout: 120000\n    optional: true\n' + SETTLE
# Тимур's profile from his chat: the reference's header name pill «Профиль Тимур Богданов» (mobile/src/ChatScreen.tsx).
PROFILE_TIMUR = OPEN_TIMUR + tap('Профиль Тимур Богданов.*') + PROFILE_UP
OWN_PROFILE = tap('Мой профиль', index=0) + wait('Изменить.*', optional=True)
EDITOR = tap('Изменить', index=0) + wait('Имя пользователя.*', optional=True)
# The community's row is read with its avatar's letters first («К«, Клан «Север», упоминаний: 1, …», the row of
# mobile/src/communities/CommunitiesScreen.tsx has no label of its own), so the name is matched anywhere in it.
COMMUNITY = section('Каналы') + wait('.*Клан «Север».*', 60000, optional=False) + tap('.*Клан «Север».*', index=0) + wait('Текстовый канал общий.*', 60000)
CHANNEL = COMMUNITY + tap('Текстовый канал общий.*') + wait('.*глянь, пожалуйста.*', 60000)
# «Слушать микс» (the large play button at the top of «Главная», on both apps: mobile/src/music/MusicScreen.tsx,
# native/ios/Sources/Music/MusicViewController.swift) starts the first track. The «Слушать: <track>» cards are in
# shelves below the screen, not drawn yet in the reference's list (the third run never found them).
MUSIC = section('Музыка') + wait('Слушать микс', 60000)
# A start that did not take (the native 88 of the run of d526af5f stayed on «Главная» with nothing playing) is made again.
PLAYER = (tap('Слушать микс') + wait('Открыть плеер.*', 15000) + when('Открыть плеер.*', tap('Слушать микс'), visible=False)
          + wait('Открыть плеер.*', 30000) + tap('Открыть плеер.*', index=0))

# --- the pairs -----------------------------------------------------------------------------------------------
# (name, shard, phase, look, native wait s, native launch arguments, reference steps, native steps or None, native start)
#   reference steps: after act/ref-home.yaml (phase main), or from the start (phase auth / setup)
#   native steps: None = photographed right after the launch arguments; a string = then these gestures (nat/nat-NAME.yaml);
#                 'same' = the same gestures as the reference's part after `|`-split (see below)
#   native start: 'home' waits for the chat list, 'chat' for Тимур's chat (-openchat 1), '' nothing
P = []
def pair(name, shard, args, wait_s, ref, nat=None, start='', phase='main', look='dark'):
    # `|` splits the reference's steps from those shared with the native app: a selector with `|` of its own (an
    # alternation) must come after an explicit split, or the split would fall inside it.
    if nat == 'same' and '|' in ref:
        head = ref.split('|', 1)[0]
        assert head.count('"') % 2 == 0, f'{name}: put an explicit "|" before the selector with an alternation'
    # Native chat pairs start in Тимур's chat already (-openchat 1): the gestures shared are those after opening it.
    if start == 'chat' and '|' not in ref and ref.startswith(OPEN_TIMUR):
        ref = OPEN_TIMUR + '|' + ref[len(OPEN_TIMUR):]
    P.append(dict(name=name, shard=shard, phase=phase, look=look, wait=wait_s, args=args, ref=ref, nat=nat, start=start))

# The comparison's setup in the reference (shard 1 only; nothing photographed, the native app finds the result:
# the server, the encrypted storage and AsyncStorage carry over).
# Separate flows, so one that stops does not keep the others from running.
# A folder «Работа» with Максим and Анна (AsyncStorage, imported by the native app at its first start).
# The sheet's rows are checkboxes whose label merges the avatar's own label (the name, mobile/src/components.tsx
# Avatar) with the name beside it: «Максим Голубев, Максим Голубев» — which is also what tells them from the chat
# list's rows and the stories strip. «Сохранить» is under the twelve rows and needs a scroll
# (mobile/src/ChatFolders.tsx, FolderEditor; the third run tapped the bare names, found nothing, and «Сохранить»
# stayed disabled and out of sight).
# The name is typed a letter at a time: typed in one go, the reference's field (its text is kept by the page and
# written back on every change) took the letters out of order — the folder of the run of 734fa7cc was «Ротааб», and
# 21-folder-tab found no «Работа» to touch.
pair('00-setup-folder', 1, '', 0, SETTINGS + setting('Папки с чатами') + tap('Создать папку') + tap('Название, например «Работа»') + ''.join(typ(letter) for letter in 'Работа')
     # The keyboard is put away by its Return key. Maestro's hideKeyboard does it by a small swipe in the middle of the
     # screen, which the sheet took for a touch on the row there (the run of 00dde8d5: Dimas ticked, the list moved a
     # little, nothing else done); the sheet then comes down, and is waited for before its rows are looked for.
     + '- pressKey: enter\n' + SETTLE + pause(1500)
     # Nothing else on the screen carries these names (the page under the sheet is «Папки с чатами»), so whatever the
     # row's label joins to the name, the name anywhere in it is the row; without it the rows are touched where the
     # run's picture shows them.
     + when('.*Максим Голубев.*', tap_once('.*Максим Голубев.*', index=0))
     + when('.*Максим Голубев.*', tap_point('50%,62.5%'), visible=False)
     + when('.*Анна Лебедева.*', tap_once('.*Анна Лебедева.*', index=0))
     + when('.*Анна Лебедева.*', tap_point('50%,69.6%'), visible=False)
     # «Сохранить» is under the rows: the sheet's list is moved by swipes that begin on its lower part (a swipe from
     # the middle of the screen moved it by a few points only in that run).
     + '- swipe:\n    start: "50%,85%"\n    end: "50%,35%"\n    duration: 400\n' * 2 + SETTLE
     + reveal('Сохранить') + tap('Сохранить'), phase='setup')
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
pair('00-setup-saved', 1, '', 0, OPEN_TIMUR + hold(THEIRS + 'Как тебе фото.*') + PICK
     + tap('Тимур Богданов: photo.png', optional=True) + tap('Тимур Богданов: Посмотри договор', optional=True)
     + tap('Тимур Богданов: voice-.*', optional=True)
     + center('Тимур Богданов: circle-.*') + tap('Тимур Богданов: circle-.*', optional=True)
     + center('.*Встреча переносится на пятницу.*') + tap('.*Встреча переносится на пятницу.*', optional=True)
     + tap('В Избранное'), phase='setup')
# A message to Вера, who blocked the account: refused by the server, it stays failed.
# The reveal leaves Вера's row at the bottom edge, under the floating tab bar, where the touch is the bar's (the run
# of 00dde8d5 stayed on the list): the list is moved a little further first, and a touch that did not open the chat
# is made once more.
VERA = (reveal('Вера.*') + '- swipe:\n    start: "50%,62%"\n    end: "50%,44%"\n    duration: 400\n' + SETTLE + tap('Вера.*', index=0)
        + waitid('chat-composer', 10000)
        + '- runFlow:\n    when:\n      notVisible:\n        id: "chat-composer"\n    commands:\n      - tapOn:\n          text: "Вера.*"\n          index: 0\n'
        + waitid('chat-composer', 30000))
pair('00-setup-failed', 1, '', 0, VERA + tapid('chat-composer') + typ('Это сообщение не дойдёт') + tapid('chat-send') + pause(6000), phase='setup')

# Shard 1: the chat list, the chat, «Избранное», stories.
pair('01-chatlist', 1, '', 25, '')
# The native app's list is waited for first (as the reference's is by ref-home.yaml): in the run of 34bf134d the swipe
# came while the list was still settling and was taken for a tap on the row under it (Максим's chat opened).
pair('02-chatlist-scrolled', 1, '', 25, flow('list-scroll.yaml'), 'same', start='home')
pair('03-chat-text', 1, '-openchat 1', 30, OPEN_TIMUR + flow('chat-top.yaml'), 'same', start='chat')
pair('04-chat-media', 1, '-openchat 1', 35, OPEN_TIMUR)
pair('05-message-menu', 1, '-openchat 1', 30, OPEN_TIMUR + hold(THEIRS + 'Как тебе фото.*'), 'same', start='chat')
pair('06-chat-avatar-peek', 1, '-openchat 1', 30, OPEN_TIMUR + flow('avatar-peek.yaml'), 'same', start='chat')
pair('17-attach-panel', 1, '-openchat 1', 30, OPEN_TIMUR + flow('paperclip.yaml'), 'same', start='chat')
# The native app is started with its panel open (-chataction emoji, ChatActions/ChatScreenActions.swift simulatorAct):
# three runs of the same touch on «Стикеры и эмодзи» left its panel shut at the shot, and why is not known yet. The
# reference still opens its own by the touch.
# -keyboardheight 334: the panel is as tall as the keyboard last was, and the reference has typed before this shot (in
# the run of fd7a62c4 its card is 290 tall and the keyboard of 30-reply-bar 334: the keyboard, less the home
# indicator's 34 and the 10 under the card; the 326 of the run before left the native card 8 short); the native app, started
# for the picture, has seen no keyboard and would take the height of «never seen» (Composer/ComposerExtras.swift).
# After the scored shot the same native flow shuts the panel and opens it again by ONE plain touch, and photographs
# that as nat-18b-emoji-tap: a picture of its own, kept with the others and not scored (it is in no line of plan.txt),
# which shows whether the touch leaves the panel open.
pair('18-emoji-panel', 1, '-openchat 1 -chataction emoji -keyboardheight 334', 30, OPEN_TIMUR + flow('emoji.yaml'),
     nat=wait('Скрыть эмодзи', 20000) + SETTLE + '@SHOT@'
     + '- tapOn:\n    text: "Скрыть эмодзи"\n    retryTapIfNoChange: false\n    optional: true\n' + SETTLE + pause(1500)
     + '- tapOn:\n    text: "Стикеры и эмодзи"\n    retryTapIfNoChange: false\n    optional: true\n' + pause(2500)
     + '- takeScreenshot: nat-18b-emoji-tap\n', start='chat')
pair('19-chatlist-search', 3, '-chatsearch "Тим"', 30, flow('chat-search.yaml'))
pair('20-sections', 3, '', 25, REF_LIVE + '|' + flow('sections.yaml'), 'same')
# The folder's tab is found by the letters of its name in any order (see 00-setup-folder), should they be mixed again.
pair('21-folder-tab', 1, '', 25, wait('[Рработ]{6}', 15000) + tap('[Рработ]{6}', index=0), 'same', start='home')
# The row is waited for and touched once; the archive is there when its first row («‹ Архив», «Вернуться к чатам») is,
# and a touch that was lost (the native app stayed on «Чаты» in the run of d526af5f) is made once more.
pair('22-archive', 3, '', 25, wait('Архив.*', 30000) + reveal('Архив.*') + tap_once('Архив.*', index=0) + wait('.*Вернуться к чатам.*', 8000)
     + when('.*Вернуться к чатам.*', tap_once('Архив.*', index=0), visible=False) + wait('.*Вернуться к чатам.*', 15000), 'same', start='home')
# The chat's very first message cannot be brought to the middle: both apps are taken to the top of the history by three
# more swipes, so the two rest at the same place whatever the scroll before them did (the reference of the run of
# 734fa7cc had stopped with the message behind the pinned bar).
TO_TOP = '- swipe:\n    start: "50%,40%"\n    end: "50%,75%"\n    duration: 500\n' * 3 + SETTLE
pair('23-chat-top', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Собрал всё, что обещал.*', timeout=120000) + TO_TOP, 'same', start='chat')
pair('24-chat-photo-reply', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Вот здесь, у озера.*', timeout=90000), 'same', start='chat')
pair('25-chat-album', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Три кадра с прогулки.*', timeout=90000), 'same', start='chat')
# The music file's row is read differently by the two apps (the reference: «Тимур Богданов: Северный ветер.wav»;
# the native one: no file name in its spoken words, Voice/MediaRowArt.swift): the video's caption just above is the anchor.
pair('26-chat-round-music', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Короткое видео.*', timeout=90000), 'same', start='chat')
pair('27-chat-link-poll', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Куда идём в субботу.*', timeout=90000), 'same', start='chat')
# Not «Встречаемся в 19:00» itself: the pinned bar at the top says it too, so the scroll would stop at once. The
# declined video call (the last call row, both apps: «Отклонённый видеозвонок») is right above the edited message.
pair('28-chat-calls-edited', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Отклонённый видеозвонок.*', timeout=90000), 'same', start='chat')
# «Сообщение номер 24» is also the row's preview in the list, so it does not tell that the chat is open: the message
# before it does. A tap that was lost (the native app stayed on its list in the run of 34bf134d) is made once more.
pair('29-chat-long', 1, '', 25, tap('Лариса Новикова.*') + wait('.*Сообщение номер 23.*', 15000)
     + '- runFlow:\n    when:\n      notVisible: ".*Сообщение номер 23.*"\n    commands:\n      - tapOn:\n          text: "Лариса Новикова.*"\n      - waitForAnimationToEnd\n'
     + wait('.*Сообщение номер 23.*', 60000), 'same', start='home')
pair('30-reply-bar', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Список покупок.*') + hold('.*Список покупок.*') + tap('Ответить'), 'same', start='chat')
pair('31-edit-bar', 1, '-openchat 1', 30, OPEN_TIMUR + hold('.*Буду через десять минут.*') + tap('Изменить'), 'same', start='chat')
pair('32-selection', 1, '-openchat 1', 30, OPEN_TIMUR + hold(THEIRS + 'Как тебе фото.*') + PICK + wait('Выбрано: .*', 8000)
     + tap(OURS + 'Молоко уже купил.*', optional=True), 'same', start='chat')
pair('33-chat-search', 1, '-openchat 1', 30, OPEN_TIMUR + flow('avatar-peek.yaml') + tap('Поиск') + typ('молоко') + '- pressKey: enter\n' + SETTLE, 'same', start='chat')
# The chat's «Ещё»: on a phone the reference has it in the person's profile (the header's «Ещё» and «Позвонить»
# belong to its wide desktop header, mobile/src/ChatScreen.tsx), the native app too (People/PersonProfileViewController.swift).
pair('34-chat-header-menu', 1, '-profile chat', 40, PROFILE_TIMUR + '|' + wait('Ещё', 30000) + tap('Ещё', index=0), 'same')
# The reference's phone has no mini profile in a private chat (MiniProfile there is the wide header's): the pair is the
# profile reached by the GESTURE on the header's name (07-profile is the native app's launch argument). The reference's
# name pill is one button «Профиль Тимур Богданов», the native one too (namePill, ChatLook/ChatLookScreen.swift).
pair('35-chat-profile', 1, '-openchat 1', 30, OPEN_TIMUR + '|' + tap('Профиль Тимур Богданов.*') + PROFILE_UP, 'same', start='chat')
pair('36-photo-menu', 1, '-openchat 1', 30, OPEN_TIMUR + center('.*Это мы на даче.*') + hold('.*Это мы на даче.*'), 'same', start='chat')
pair('37-photo-viewer', 1, '-openchat 1 -openattachment photo', 40, OPEN_TIMUR + center('Тимур Богданов: photo.png') + tap('Тимур Богданов: photo.png') + pause(3000))
pair('38-saved', 1, '', 25, tap('Избранное.*', index=0) + pause(3000), 'same', start='home')
pair('39-saved-menu', 1, '', 25, tap('Избранное.*', index=0) + wait('.*Как тебе фото.*') + hold('.*Как тебе фото.*'), 'same', start='home')
pair('40-chat-failed', 1, '', 25, reveal('Вера.*') + tap('Вера.*') + pause(3000), 'same', start='home')
pair('41-chat-blocked', 1, '', 25, reveal('Игорь.*') + tap('Игорь.*') + pause(3000), 'same', start='home')
# The first native shot of its shard: in the run of 1fc2c7dd the touch on «Новый чат» opened nothing (the same build's
# button answers every other time it is asked). «Люди» is known by its «Друзья»; a touch that was lost is made once more.
pair('42-new-chat', 2, '', 25, tap('Новый чат', index=0) + wait('Друзья.*', 8000)
     + when('Друзья.*', tap('Новый чат', index=0, optional=True), visible=False) + wait('Друзья.*', 15000), 'same', start='home')
# In the run of 34bf134d both apps were photographed back on the chat list: the story had been opened and had ended
# while Maestro waited for the screen to stop moving.
# In the run of 734fa7cc the reference was photographed still on its chat list, 0.7 s after the touch: its viewer had
# not come yet. No second touch: over an open viewer it would land on «Предыдущее».
# In the run of 1fc2c7dd the native app was photographed in its story and the reference back on its chat list, with
# the circles already grey: its viewer had opened, played out and closed while Maestro waited for «Закрыть» — reading
# the screen of the reference takes as long as a story lasts while one is playing (its progress line never lets the
# app come to rest), and three people's stories had gone by before the picture of 44. So nothing is asked of the
# screen between the touch and the picture: the flow only lets a moment pass (the viewer needs under a second to
# come, a story lasts five) and photographs.
HOLD_STILL = '- evalScript: ${var until = Date.now() + 1800; while (Date.now() < until);}\n'
def story(circle):
    return tap_now(circle, index=0) + HOLD_STILL
pair('43-story-viewer', 3, '', 25, REF_LIVE + '|' + story('Анна Лебедева, (новых историй|истории просмотрены|запись).*'), 'same', start='home')
# The own story is one story of five seconds, and the picture Maestro takes after the touch came later than that on
# both apps in the run of fd7a62c4 (the reference was back on its chat list, the native app at the end of the next
# person's story): what Maestro does around a touch lasts longer than the story. So the picture is not Maestro's:
# before the touch the flow asks the runner (act/shoot-later.js, compare/shot-server.py) for a picture 3.5 seconds
# later, the circle is touched by its place (the first of the strip, the same on both apps — no reading of the screen
# before the touch), and the flow waits until the picture is taken. Maestro's own late picture is kept beside it
# under «…-late», not scored.
SHOOT_LATER = '- runScript:\n    file: @ACT@/shoot-later.js\n    env:\n      NAME: "@NAME@"\n      AFTER: "3500"\n'
OWN_STORY = (wait('Моя история', 20000) + SHOOT_LATER
             + '- tapOn:\n    point: "13%,19%"\n    retryTapIfNoChange: false\n    waitToSettleTimeoutMs: 300\n'
             + HOLD_STILL * 3 + '- takeScreenshot: @NAME@-late\n@NOSHOT@')
pair('44-own-story', 3, '', 25, REF_LIVE + '|' + OWN_STORY, 'same', start='home')
# The account has a story, so its circle reads «Моя история» and its «+» is inside it (not a control of its own to
# Maestro); a hold on the circle adds a story on both apps (mobile/src/stories/StoriesStrip.tsx onLongPress,
# native/ios/Sources/Stories/StoriesStrip.swift heldDown).
pair('45-story-add', 3, '', 25, REF_LIVE + '|' + hold('Моя история') + pause(2500), 'same', start='home')
pair('46-chatlist-light', 2, '', 25, '', look='light')
pair('47-chat-light', 1, '-openchat 1', 35, OPEN_TIMUR, look='light')
# Last of shard 1: the same words the native `-chatlist draft` writes. After the shot the reference's draft is erased:
# the native app takes the previous app's drafts over, and in the run of 34bf134d every native picture of Тимур's
# chat had these words in its composer (a send button for the microphone, a taller field, no emoji panel).
pair('48-draft', 1, '-chatlist draft', 30, OPEN_TIMUR + tapid('chat-composer') + typ('Не забыть спросить про проектор') + tap('Назад к чатам.*') + pause(4000) + flow('ref-home.yaml')
     + '@SHOT@' + OPEN_TIMUR + tapid('chat-composer', optional=True) + '- eraseText: 40\n' + tap('Назад к чатам.*', optional=True) + pause(3000))

# Shard 2: profiles, the profile editor and its sheets, Platina, settings pages, people.
pair('07-profile', 2, '-profile chat', 40, OPEN_TIMUR + tap('Профиль Тимур Богданов.*') + PROFILE_UP)
pair('08-settings', 2, '-settings root', 20, SETTINGS)
pair('09-appearance', 2, '-settings appearance', 20, SETTINGS + tap('Оформление.*'))
pair('10-privacy', 2, '-settings privacy', 20, SETTINGS + setting('Конфиденциальность'))
pair('11-people', 2, '-tab people', 25, section('Люди'))
pair('49-profile-scrolled', 2, '-profile chat', 40, PROFILE_TIMUR + '|' + swipe_up(), 'same')
pair('50-profile-files', 2, '-profile chat', 40, PROFILE_TIMUR + '|' + reveal('Файлы.*') + tap('Файлы.*', index=0), 'same')
pair('51-profile-links', 2, '-profile chat', 40, PROFILE_TIMUR + '|' + reveal('Голосовые') + swipe_left_from('Голосовые') + tap('Ссылки.*', index=0), 'same')
# Анна's profile opened from «Люди» (the native app: `-profile friend`, People/PeopleSimulator.swift). In the reference
# the friend's row is one button that opens the chat, its «Профиль Анна Лебедева» (ⓘ) is inside it and not a
# control of its own to Maestro (mobile/src/PeopleScreen.tsx): it is touched at its place, the first friend's ⓘ
# (measured on the third run's picture: x 897, y 1793 of 1206 × 2622).
pair('52-person-posts', 2, '-profile friend', 30, section('Люди') + wait('.*Анна Лебедева.*', 30000, optional=False) + tap_point('74%,68%') + wait('Написать', 15000) + pause(2000))
pair('53-own-profile', 2, '-settings root', 20, SETTINGS + '|' + OWN_PROFILE, 'same')
pair('54-own-profile-scrolled', 2, '-settings root', 20, SETTINGS + '|' + OWN_PROFILE + swipe_up(), 'same')
pair('55-profile-editor', 2, '-settings profile', 25, SETTINGS + EDITOR)
pair('56-editor-banner', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + tap('Изменить баннер|Установить баннер', index=0), 'same')
# The native app of the run of 734fa7cc stayed on the settings after the touch on the status. The picker is known by
# its first cell («Значок Platina по умолчанию»); should it still not be there, the native flow opens the profile by
# its row and touches the status beside the name there (the picker then hangs from the touch, not from the header).
pair('57-status-sheet', 2, '-settings root', 20, SETTINGS + '|' + tap('Сменить статус рядом с именем'),
     nat=tap('Сменить статус рядом с именем') + wait('Значок Platina по умолчанию', 6000)
     + when('Значок Platina по умолчанию', tap('Мой профиль', index=0, optional=True) + wait('Изменить.*', 8000)
            + '- tapOn:\n    text: "Статус .*"\n    index: 0\n    retryTapIfNoChange: false\n    optional: true\n' + SETTLE, visible=False)
     + pause(1000))
# The editor's page is moved by a finger that starts beside its cards, at the screen's right edge: Maestro's own scroll
# starts in the middle of the screen, on «О себе», and its press before the move put the cursor into the native
# field (the native 61 of the run of 1fc2c7dd was photographed with the keyboard up). One move brings the rows from
# «День рождения» to «Узор фона» to the middle of the screen, clear of the tab bar that stands over the editor.
def edit_down(times=1):
    return '- swipe:\n    start: "98%,72%"\n    end: "98%,48%"\n    duration: 800\n' * times + SETTLE
# A row of the editor that opens a sheet. Every sheet ends in «Готово» and nothing else on the page is called so
# (the header's checkmark is «Сохранить»): the sheet is waited for by it, and a touch that opened nothing — the
# native 59 and 60 of the run of 1fc2c7dd stayed on the editor — is made once more.
def edit_sheet(row):
    return (edit_down() + tap(row, index=0) + wait('Готово', 8000)
            + when('Готово', tap(row, index=0, optional=True), visible=False) + wait('Готово', 8000) + pause(1200))
pair('58-editor-pattern', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + edit_sheet('Узор фона.*'), 'same')
pair('59-editor-color', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + edit_sheet('Персональный цвет.*'), 'same')
pair('60-editor-birthday', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + edit_sheet('День рождения.*'), 'same')
pair('61-editor-studio', 2, '-settings profile', 25, SETTINGS + EDITOR + '|' + edit_down(2), 'same')
pair('62-editor-username', 2, '-settings username', 25, SETTINGS + EDITOR + tap('Имя пользователя.*', index=0))
pair('63-platina-showcase', 2, '-settings root', 20, SETTINGS + '|' + tap('Инвиз Platina', index=0) + pause(2000), 'same')
pair('64-notifications', 2, '-settings notifications', 20, SETTINGS + setting('Уведомления и звуки'))
pair('65-folders-settings', 2, '-settings root', 20, SETTINGS + '|' + setting('Папки с чатами'), 'same')
pair('66-power', 2, '-settings power', 20, SETTINGS + setting('Энергосбережение и анимации'))
pair('67-language', 2, '-settings language', 20, SETTINGS + reveal('Язык.*') + tap('Язык.*', index=0))
pair('68-night', 2, '-settings night', 20, SETTINGS + tap('Оформление.*') + setting('Ночная тема'))
# «Свои цвета» is a group's name, not a row: its first row «Цвет интерфейса» opens the page of colours. Both rows are
# brought to the middle first — left at the bottom edge they were under the tab bar, and neither app opened anything
# in the run of 734fa7cc (69 was the picture of 09 again, 70 the page scrolled).
pair('69-colors', 2, '-settings appearance', 20, SETTINGS + tap('Оформление.*') + '|' + setting_low('Цвет интерфейса') + pause(1500), 'same')
pair('70-wallpapers', 2, '-settings appearance', 20, SETTINGS + tap('Оформление.*') + '|' + setting_low('Обои чатов') + pause(1500), 'same')
pair('71-lastseen', 2, '-settings lastseen', 20, SETTINGS + setting('Конфиденциальность') + setting('Время захода'))
# «Всегда показывать» exists only when «Время захода» is not «Все» (mobile/src/SettingsScreen.tsx; the native
# launch argument opens the list itself): «Мои друзья» is chosen for the shot and «Все» chosen back afterwards, so the
# native app later finds the setting as 71-lastseen showed it.
pair('72-lastseen-allow', 2, '-settings lastseenallow', 20, SETTINGS + setting('Конфиденциальность') + setting('Время захода') + tap('Мои друзья.*') + setting('Всегда показывать') + '@SHOT@'
     + flow('ref-home.yaml') + SETTINGS + setting('Конфиденциальность') + setting('Время захода') + tap('Все', optional=True))
# «Кто может звонить» and its lists stand on «Конфиденциальность» itself in both apps: the page is opened and that
# part brought to the middle by the same gesture (the native side used to be its separate page of the lists alone).
pair('73-call-privacy', 2, '-settings privacy', 20, SETTINGS + setting('Конфиденциальность') + '|' + center('Кто может звонить.*', 'DOWN'), 'same')
pair('74-passcode', 2, '-settings passcode', 20, SETTINGS + setting('Конфиденциальность') + tap('Код-пароль.*', index=0))
# The code entry is photographed and left: the code is never set (it would lock every later start).
pair('75-passcode-entry', 2, '-settings passcode', 20, SETTINGS + setting('Конфиденциальность') + tap('Код-пароль.*', index=0) + '|' + tap('Включить код-пароль'), 'same')
pair('76-people-search', 2, '-tab people', 25, section('Люди') + '|' + tap('Ник или имя пользователя') + typ('Лар') + pause(3000), 'same')
pair('77-settings-light', 2, '-settings root', 20, SETTINGS, look='light')
pair('78-profile-light', 2, '-profile chat', 40, PROFILE_TIMUR, look='light')
pair('79-people-light', 2, '-tab people', 25, section('Люди'), look='light')

# Shard 3: channels, rooms, music, AI, security pages, calls, then signed out: sign-in, registration, recovery.
pair('12-channels', 3, '-tab channels', 25, section('Каналы') + wait('.*Клан «Север».*', 60000))
pair('13-community', 3, '-channels community', 30, COMMUNITY)
pair('14-channel-chat', 3, '-channels chat', 35, CHANNEL)
pair('15-music', 3, '-tab music', 25, section('Музыка'))
pair('16-ai', 3, '-tab ai', 25, section('AI'))
pair('80-channel-mini-profile', 3, '-channels chat', 35, CHANNEL + '|' + tap_point('8%,73%') + pause(1500), nat=wait('.*глянь, пожалуйста.*', 60000)
     # «Профиль Dimas» is on every first message of his, also on those passing under the header, and the first one
     # found was not on the screen's open part (the run of d526af5f: nothing opened). The one right above the newest
     # message is asked for; should the card still not be there, his avatar is touched where it stands.
     + '- tapOn:\n    text: "Профиль Dimas"\n    above: ".*глянь, пожалуйста.*"\n    retryTapIfNoChange: false\n    optional: true\n'
     + wait('Написать', 5000) + when('Написать', tap_point('8%,81%'), visible=False) + pause(1500))
pair('81-channel-message-menu', 3, '-channels chat', 35, CHANNEL + '|' + wait('.*глянь, пожалуйста.*', 60000) + hold('.*глянь, пожалуйста.*'), 'same')
pair('82-blog', 3, '-tab channels', 25, section('Каналы') + '|' + reveal('.*Заметки.*') + tap('.*Заметки.*', index=0) + pause(3000), 'same')
pair('83-room', 3, '-rooms room', 30, section('Каналы') + reveal('.*Вечерний созвон.*') + tap('.*Вечерний созвон.*', index=0) + pause(3000))
pair('84-voice-channel', 3, '-channels community', 30, COMMUNITY + '|' + tap('Голосовой канал Игра.*') + tap('Allow|Разрешить|OK', optional=True) + pause(6000), 'same')
pair('85-music-mini', 3, '-tab music', 25, MUSIC + '|' + tap('Слушать микс') + pause(5000), 'same')
pair('86-music-player', 3, '-tab music', 25, MUSIC + '|' + PLAYER + pause(3000), 'same')
pair('87-music-queue', 3, '-tab music', 25, MUSIC + '|' + PLAYER + tap('Ещё', index=0), 'same')
pair('88-music-equalizer', 3, '-tab music', 25, MUSIC + '|' + PLAYER + swipe_left_from('Перемешать|Перемешано') + tap('Эквалайзер', index=0), 'same')
pair('89-security', 3, '-settings security', 20, SETTINGS + setting_low('Безопасность и устройства'))
pair('90-security-sessions', 3, '-settings sessions', 20, SETTINGS + setting_low('Безопасность и устройства') + center('Сеанс: .*', 'DOWN'))
pair('91-blocked', 3, '-settings blocked', 20, SETTINGS + setting_low('Безопасность и устройства') + center('Заблокированные', 'DOWN'))
pair('92-data', 3, '-settings data', 20, SETTINGS + setting_low('Данные и память'))
pair('95-channels-light', 3, '-tab channels', 25, section('Каналы') + wait('.*Клан «Север».*', 60000), look='light')
# Calls last of the main part: they leave call rows in Анна's and Тимур's chats.
pair('96-call-incoming', 3, '', 25, script('ring.js') + pause(7000) + '@SHOT@' + script('hangup.js'), 'same', start='home')
# The phone's call button is the profile's «Звонок» on both apps (no «Позвонить» in either phone header).
# The native app reaches Тимур's profile by the same gestures here, not by `-profile chat`: that opens the first chat
# the server lists, and after the ring of 96 that is Анна's (the run of 34bf134d photographed a call to her).
# A touch on the row that was lost (the native 98 of the run of d526af5f stayed on the list) is made once more.
NAT_ROW = '- tapOn:\n    text: "Тимур Богданов( [^.,]+)?(\\\\. .*|, непрочитанных.*|, помечен.*)?"\n'
NAT_TIMUR = (NAT_ROW + wait('Профиль Тимур Богданов.*', 10000) + when('Профиль Тимур Богданов.*', NAT_ROW, visible=False)
             + flow('wait-timur.yaml') + tap('Профиль Тимур Богданов.*') + PROFILE_UP)
CALL = wait('Звонок', 30000) + tap('Звонок') + tap('Allow|Разрешить|OK', optional=True)
# The strip of a call put away is photographed over the chat LIST: in Тимур's chat the native app, which comes after
# the reference, always shows more «Отменённый звонок» rows than the reference did (the reference's own earlier calls),
# so the two chats under the strip never were the same.
MINIMIZED = (pause(3000) + tap('Свернуть звонок') + pause(1500) + tap('Назад к чатам.*', optional=True) + pause(1500) + '@SHOT@'
             + tap('Завершить звонок|Завершить', index=0, optional=True))
# The `|` in front: without a split of its own the first `|` of the steps is taken for one and removed, and that was
# the one inside «Allow|Разрешить|OK» (the reference's flows asked for «AllowРазрешить|OK»).
pair('97-call-outgoing', 3, '', 25, '|' + PROFILE_TIMUR + CALL + pause(4000), nat=NAT_TIMUR + CALL + pause(4000), start='home')
pair('98-call-minimized', 3, '', 25, '|' + PROFILE_TIMUR + CALL + MINIMIZED, nat=NAT_TIMUR + CALL + MINIMIZED, start='home')
pair('99-call-history', 3, '-tab people', 25, section('Люди') + '|' + tap('Звонки.*', index=0) + pause(2000), 'same')
# Signed out (the workflow removes the app and the simulator's keychain, then installs it fresh).
SIGNIN = waitid('field-Логин', 300000, optional=False)
NAT_SIGNIN = wait('Логин.*|Войти.*', 120000)
def login_field():
    return ('- runFlow:\n    when:\n      visible:\n        id: "field-Логин"\n    commands:\n      - tapOn:\n          id: "field-Логин"\n')
STEP_PASSWORD = login_field() + typ('${LOGIN}') + '- pressKey: enter\n' + tap('Продолжить', optional=True) + waitid('field-Пароль', 30000) + wait('Пароль.*', 5000)
STEP_WORD = STEP_PASSWORD + tap('Показать: пароль', optional=True) + tapid('field-Пароль', optional=True) + typ('${PASSWORD}') + '- pressKey: enter\n' + tap('Продолжить', optional=True) + waitid('field-Слово подтверждения', 30000) + HIDEKB
pair('100-signin', 3, '-auth 1', 15, SIGNIN + HIDEKB + SETTLE, start='', phase='auth', nat=NAT_SIGNIN + HIDEKB + SETTLE)
pair('101-signin-password', 3, '-auth 1', 15, SIGNIN + '|' + STEP_PASSWORD + HIDEKB, 'same', phase='auth')
pair('102-signin-word', 3, '-auth 1', 15, SIGNIN + '|' + STEP_WORD, 'same', phase='auth')
pair('103-register', 3, '-auth 1 -authmode register', 15, SIGNIN + tap('Создать аккаунт', index=0) + '- hideKeyboard\n', phase='auth')
pair('104-register-profile', 3, '-auth 1 -authmode profile', 15, SIGNIN + tap('Создать аккаунт', index=0) + login_field() + typ('newperson_check') + '- pressKey: enter\n' + tap('Продолжить', optional=True) + wait('Имя.*', 30000) + '- hideKeyboard\n', phase='auth')
pair('105-recover', 3, '-auth 1 -authmode recover', 15, SIGNIN + tap('Забыл пароль?') + '- hideKeyboard\n', phase='auth')

# --- writing -------------------------------------------------------------------------------------------------
for old in glob.glob(os.path.join(ROOT, 'ref-*.yaml')) + glob.glob(os.path.join(ROOT, 'nat', 'nat-*.yaml')):
    os.remove(old)
if os.path.exists(os.path.join(ROOT, 'names.txt')):
    os.remove(os.path.join(ROOT, 'names.txt'))

ASKS = '"Allow Full Access|Allow Access to All Photos|Разрешить доступ ко всем фото"'
# A system question left over a screen by an earlier flow is answered before anything else is done.
ANSWER = f'- runFlow:\n    when:\n      visible: {ASKS}\n    commands:\n      - tapOn: {ASKS}\n'
def body(steps, act, shotname):
    steps = ANSWER + steps
    steps = steps.replace('@ACT@', act).replace(HIDEKB, HIDEKB_NAT if act == '../act' else HIDEKB_REF)
    steps = steps.replace(THEIRS, '.*' if act == '../act' else 'Тимур Богданов: ').replace(OURS, '.*' if act == '../act' else 'Ты: ')
    shot = f'- takeScreenshot: {shotname}\n'
    steps = steps.replace('@NAME@', shotname)
    # @NOSHOT@: the flow's picture is taken for it by the runner (see 44-own-story), not by Maestro.
    if '@NOSHOT@' in steps: return steps.replace('@NOSHOT@', '')
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
        text = APP + head + refsteps.replace('@ACT@', 'act').replace(HIDEKB, HIDEKB_REF).replace(THEIRS, 'Тимур Богданов: ').replace(OURS, 'Ты: ')
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
