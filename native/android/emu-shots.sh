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

shot() { # name, launch arguments…
  name="$1"; shift
  adb shell am force-stop "$APP"
  adb shell am start -W -n "$APP/com.linea.messenger.MainActivity" "$@"
  sleep 6
  adb exec-out screencap -p > "$OUT/$name.png"
  # A PNG of a real screen is far bigger than this; an empty file means the screen was not read.
  [ "$(wc -c < "$OUT/$name.png")" -gt 2000 ] || { echo "No picture for $name" >&2; exit 1; }
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
# What the app itself said while it ran (crashes show here).
adb logcat -d -t 400 '*:E' > "$OUT/logcat-errors.txt" 2>/dev/null || true
adb shell dumpsys package "$APP" | grep -E "versionName|primaryCpuAbi" || true
echo "== done"
shot 33-voice --ez demo true --ez chat true --es voicedemo 1
shot 34-voice-recording --ez demo true --ez chat true --es voicedemo recording
shot 35-video --ez demo true --ez chat true --es videodemo 1
