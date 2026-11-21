#!/bin/sh
# Installs the debug build on the running emulator (or the one connected phone) and photographs its pages,
# driving the app with launch arguments as the iOS simulator check does (the arguments: Demo.start in src/debug).
# The pages with real data from a local test server are emu-live.sh.
#   ./emu-shots.sh <folder for the pictures> [apk]
# Each line of the progress goes to the terminal; a page that could not be photographed fails the script.
set -eu
OUT="${1:?folder for the pictures}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APK="${2:-$HERE/app/build/outputs/apk/debug/app-debug.apk}"
APP=com.linea.messenger.preview
mkdir -p "$OUT"

adb wait-for-device
adb install -r "$APK"
# A calm status bar: 9:41, full battery, no notifications. (Best effort: not every system image has the demo mode.)
adb shell settings put global sysui_demo_allowed 1 || true
adb shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null || true
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null || true
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null || true
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null || true
# The emulator's own launcher sometimes stops answering on a slow runner; its "isn't responding" window would cover the shots.
adb shell settings put global hide_error_dialogs 1 >/dev/null 2>&1 || true

shot() { # name, launch arguments…
  name="$1"; shift
  adb shell am force-stop "$APP"
  adb shell am start -W -n "$APP/com.linea.messenger.MainActivity" "$@"
  sleep 6
  # The emulator's own launcher stalls on a slow runner and its "isn't responding" window covers the app: stop it.
  adb shell am force-stop com.google.android.apps.nexuslauncher >/dev/null 2>&1 || true
  sleep 1
  adb exec-out screencap -p > "$OUT/$name.png"
  # A PNG of a real screen is far bigger than this; an empty file means the screen was not read.
  [ "$(wc -c < "$OUT/$name.png")" -gt 2000 ] || { echo "No picture for $name" >&2; exit 1; }
  # What crashed during this launch, if anything, under the shot's name.
  { echo "== $name"; adb logcat -d -b crash 2>/dev/null | tail -60; } >> "$OUT/crashes.txt" || true
  adb logcat -b crash -c 2>/dev/null || true
  echo "shot $name"
}
# The shell with sample chats (`demo`), then the first thing a person without an account sees.
shot 01-chats --ez demo true
shot 02-sections --ez demo true --ez sections true
shot 03-settings --ez demo true --es tab profile
shot 04-chat --ez demo true --ez chat true
shot 05-auth
shot 06b-register --ez auth true --es authmode register
shot 06c-recover --ez auth true --es authmode recover
shot 06d-waiting --ez auth true --es authmode waiting
shot 09c-attach-demo --ez demo true --ez chat true --es attachdemo 1
shot 20-channels-demo --es channelsdemo 1
shot 20b-channels-demo-chat --es channelsdemo chat
shot 25-chat-menu --ez demo true --ez chat true --es chatdemo menu
shot 26-chat-reply --ez demo true --ez chat true --es chatdemo reply
shot 27-chat-quotes --ez demo true --ez chat true --es chatdemo quotes
shot 28-chat-select --ez demo true --ez chat true --es chatdemo select
shot 31-list-archive --ez demo true --es chatlist archive
shot 21-ai-demo --es aidemo 1
shot 22-music-demo --es musicdemo 1
shot 23-music-player --es musicdemo player
shot 33-voice --ez demo true --ez chat true --es voicedemo 1
shot 34-voice-recording --ez demo true --ez chat true --es voicedemo recording
shot 35-video --ez demo true --ez chat true --es videodemo 1
shot 36-link-cards --ez demo true --ez chat true --es linkdemo 1
shot 37-link-composer --ez demo true --ez chat true --es linkdemo composer
shot 38-call-outgoing --es calldemo outgoing
shot 39-call-incoming --es calldemo incoming
shot 40-call-active --es calldemo active
shot 41-call-video --es calldemo video
shot 42-call-retry --es calldemo retry
shot 43-call-bar --es calldemo bar
# Settings: «Оформление» in the app's own look, in «Графит», «Цвет интерфейса» with an orange accent; the last
# one puts the look back (the choice is kept on the emulator between launches).
shot 44-appearance --ez demo true --es settings appearance
shot 45-appearance-graphite --ez demo true --es settings appearance --es settheme graphite
shot 47-accent --ez demo true --es settings accent --es settheme black --es setaccent FF9500
shot 49b-reset --ez demo true --es setaccent none --es settheme black
# Stories and profile posts: the strip above the chats, a friend's story, «Просмотры» of the account's own story,
# the screen before publishing, a person's profile with its posts, «Публикации и истории».
shot 50-stories-strip --es storiesdemo strip
shot 51-stories-viewer --es storiesdemo viewer
shot 52-stories-viewers --es storiesdemo viewers
shot 53-stories-compose --es storiesdemo compose
shot 54-stories-posts --es storiesdemo posts
shot 55-own-posts --es storiesdemo own
# Rooms: «КОМНАТЫ» on top of «Каналы», a room this phone is inside, the same with music for everyone, the ring over
# the chats, the bar of a room whose screen is closed, «Выбрать» with three people marked.
shot 56-rooms-list --es roomsdemo list
shot 57-room --es roomsdemo room
shot 58-room-music --es roomsdemo music
shot 59-room-ring --es roomsdemo ring
shot 60-room-bar --es roomsdemo bar
shot 61-room-picker --es roomsdemo picker

# Every section follows the theme (design/Theme.kt `page`/`raised`/`panel`, light glass in shell/TabBar.kt); the last shot puts «Чёрная» back.
shot 63-light-chats --ez demo true --es settheme light
shot 64-light-chat --ez demo true --ez chat true --es settheme light
shot 65-light-channels --es channelsdemo 1 --es settheme light
shot 66-light-music --es musicdemo 1 --es settheme light
shot 67-light-room --es roomsdemo room --es settheme light
shot 68-reset --ez demo true --es settheme black
# ChatsPlus: the chat list's extras (chatsplus/), the same numbers as the iOS check.
shot 140-chats-waiting --ez demo true --es chatsdemo waiting
shot 141-chats-connecting --ez demo true --es chatsdemo connecting
shot 142-chats-updating --ez demo true --es chatsdemo updating
shot 143-chats-skeleton --ez demo true --es chatsdemo skeleton
shot 144-chats-empty --ez demo true --es chatsdemo empty
shot 145-chats-folders --ez demo true --es chatsdemo folders
shot 146-chats-folder --ez demo true --es chatsdemo folder
shot 147-folder-editor --ez demo true --es chatsdemo foldereditor
shot 148-folder-settings --ez demo true --es chatsdemo foldersettings
shot 149-saved-menu --ez demo true --es chatsdemo savedmenu
shot 150-saved --ez demo true --es chatsdemo saved
shot 151-saved-search --ez demo true --es chatsdemo savedsearch
shot 152-people-calls --ez demo true --es tab people --es chatsdemo calls
shot 153-bar-hint --ez demo true --es chatsdemo hint
shot 154-chats-unread-badge --ez demo true
# Shell: the mini-player, the player strip, the swipe back, the update screen (shell/), and more of the chat list.
shot 290-mini-player-people --ez demo true --es shelldemo mini
shot 291-chat-player-strip --ez demo true --es shelldemo chatstrip
shot 292-swipe-back-half --ez demo true --es shelldemo swipe
shot 293-long-swipe-to-chats --ez demo true --es shelldemo long
shot 294-section-home-swipe --ez demo true --es shelldemo home
shot 295-update-required --ez demo true --es updatedemo required
shot 296-update-optional --ez demo true --es updatedemo optional
shot 297-chats-select --ez demo true --es chatsdemo select
shot 298-chat-peek --ez demo true --es chatlist menu
shot 299-archive-pulled --ez demo true --es chatlist archive --es chatsdemo archivepull
shot 300-mute-custom --ez demo true --es chatsdemo mutecustom
shot 301-search-people --ez demo true --es chatsearch мар
shot 302-saved-composer --ez demo true --es chatsdemo saved
shot 303-mute-sheet-custom-row --ez demo true --es chatlist mute

# Avatars / Profile / Platina: frames, art, Platina's marks, profiles, gifts, the showcase and the studio, the mini
# profile, the photo viewer, the cropper, the pickers (avatars/, profile/, platina/), the same numbers as the iOS check.
shot 100-avatar-rings --es profiledemo rings
shot 101-avatar-code-frames --es profiledemo code
shot 102-avatar-art --es profiledemo art
shot 103-avatar-list-sizes --es profiledemo list
shot 104-platina-marks --es profiledemo marks
shot 105-fonts --es profiledemo fonts
shot 106-profile-platina --es profiledemo person
shot 107-profile-birthday --es profiledemo birthday
shot 108-own-profile --es profiledemo own
shot 109-gifts --es profiledemo gifts
shot 110-platina-showcase --es profiledemo showcase
shot 111-platina-studio --es profiledemo studio
shot 112-platina-confetti --es profiledemo confetti
shot 113-settings-offer --es profiledemo offer
shot 114-settings-head --ez demo true --es tab profile --ez profilelook true
shot 115-mini-profile --es profiledemo mini
shot 116-mini-profile-chat --es profiledemo mini-chat
shot 117-profile-media --es profiledemo media
shot 118-avatar-cropper --es profiledemo cropper
shot 119-banner-preview --es profiledemo banner
shot 120-profile-pattern --es profiledemo pattern
shot 121-status-picker --es profiledemo status
shot 122-gift-sheet --es profiledemo giftsheet

# ChatLook: the glass header, the light, bubbles, wallpapers, the swipe to answer, arrivals (chatlook/LookDemo.kt of src/debug).
shot 170-chatlook-header --ez demo true --ez chat true --es chatlook header
shot 171-chatlook-peek --ez demo true --ez chat true --es chatlook peek
shot 172-chatlook-bubbles --ez demo true --ez chat true --es chatlook bubbles
shot 173-chatlook-wallpaper --ez demo true --ez chat true --es chatlook wallpaper
shot 174-chatlook-swipe --ez demo true --ez chat true --es chatlook swipe
shot 175-chatlook-reply --ez demo true --ez chat true --es chatlook reply
shot 176-chatlook-arrive --ez demo true --ez chat true --es chatlook arrive
shot 177-chatlook-picker --ez demo true --ez chat true --es chatlook picker
shot 178-chatlook-preview --ez demo true --ez chat true --es chatlook preview
shot 179-chatlook-bubblecolor --ez demo true --ez chat true --es chatlook bubblecolor
shot 180-chatlook-offline --ez demo true --ez chat true --es chatlook header --es chatlookline offline
shot 181-chatlook-connecting --ez demo true --ez chat true --es chatlook header --es chatlookline connecting
shot 182-chatlook-light-theme --ez demo true --ez chat true --es chatlook header --es settheme light
shot 183-chatlook-reset --ez demo true --es settheme black
shot 184-chatlook-plain --ez demo true --ez chat true
shot 185-chatlook-appearance --ez demo true --es settings appearance
shot 186-chatlook-profile-light --ez demo true --es profile chat
# Composer and Polls: send options, scheduled messages, emoji, formatting, polls, the search, forwarding.
shot 200-composer-silent --ez demo true --ez chat true --es composerdemo silent
shot 201-composer-later --ez demo true --ez chat true --es composerdemo later
shot 202-composer-scheduled-pill --ez demo true --ez chat true --es composerdemo scheduled
shot 203-composer-scheduled-list --ez demo true --ez chat true --es composerdemo list
shot 204-composer-emoji --ez demo true --ez chat true --es composerdemo emoji
shot 205-composer-format --ez demo true --ez chat true --es composerdemo format
shot 206-chat-features --ez demo true --ez chat true --es chatdemo features
shot 207-poll-new --ez demo true --ez chat true --es chatdemo newpoll
shot 208-chat-search --ez demo true --ez chat true --es chatdemo search
shot 213-forward-saved --ez demo true --ez chat true --es chatdemo forward
shot 360-forward-many --ez demo true --ez chat true --es chatdemo forwardmany
shot 375-gift-from-chat --ez demo true --ez chat true --es chatdemo gift

# What the app itself said while it ran (crashes show here).
adb logcat -d -t 400 '*:E' > "$OUT/logcat-errors.txt" 2>/dev/null || true
adb shell dumpsys package "$APP" | grep -E "versionName|primaryCpuAbi" || true
echo "== done"
