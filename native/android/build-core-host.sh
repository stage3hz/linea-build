#!/bin/sh
# Builds the core with its JNI layer for THIS machine (not for a phone) and puts it where the unit tests look
# for it: app/build/host-core/. With it, `./gradlew :app:testDebugUnitTest` also runs CoreJniTest — the real
# calls from Kotlin into the core and back (requests, the encryption service with its storage and server
# callbacks). Without it that test is skipped. Needs rustup and `protoc` (on PATH, or $PROTOC).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -n "${PROTOC:-}" ] || command -v protoc >/dev/null 2>&1 || { echo "No protoc found: install it or set PROTOC." >&2; exit 1; }
# The same versions of everything as the core itself, and the core's own build folder (what is built there is reused).
cp "$HERE/../core/Cargo.lock" "$HERE/jni-host/Cargo.lock"
(cd "$HERE/jni-host" && CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HERE/../core/target}" cargo build --lib --offline 2>/dev/null \
  || CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HERE/../core/target}" cargo build --lib)
mkdir -p "$HERE/app/build/host-core"
case "$(uname -s)" in Darwin) EXT=dylib ;; *) EXT=so ;; esac
# Under the name `System.loadLibrary("invizent_core")` looks for.
cp "${CARGO_TARGET_DIR:-$HERE/../core/target}/debug/libinvizent_core_host.$EXT" "$HERE/app/build/host-core/libinvizent_core.$EXT"
ls -l "$HERE/app/build/host-core/libinvizent_core.$EXT"
