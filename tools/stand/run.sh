#!/bin/bash
# Runs a command inside a private D-Bus session with an unlocked test keyring (so Electron's safeStorage works like on a desktop).
export XDG_RUNTIME_DIR=${STAND:-/tmp/invizent-stand}/runtime; mkdir -p -m 700 $XDG_RUNTIME_DIR
export HOME_KEYRING=${STAND:-/tmp/invizent-stand}/keyring; mkdir -p $HOME_KEYRING
exec dbus-run-session -- bash -c 'export XDG_DATA_HOME=$HOME_KEYRING; eval $(printf "stand-test" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null); export GNOME_KEYRING_CONTROL; sleep 1; exec "$@"' _ "$@"
