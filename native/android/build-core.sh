#!/bin/sh
# Builds the shared core (native/core, Rust) for Android and puts the libraries where Gradle packs them from:
# app/src/main/jniLibs/<abi>/libinvizent_core.so (not committed).
#   ./build-core.sh                       (both: arm64-v8a for phones, x86_64 for the emulator)
#   ./build-core.sh x86_64                (one or more of: arm64-v8a, x86_64)
# Needs rustup and an Android NDK: $ANDROID_NDK_HOME, or the newest one under the SDK's ndk/ directory (the SDK
# from $ANDROID_HOME / $ANDROID_SDK_ROOT, or sdk.dir in local.properties).
# The Signal library is built into the core (feature `signal`); its build needs `protoc`: on PATH, or $PROTOC.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
# The lowest Android the app runs on (minSdk in gradle/libs.versions.toml).
API=26

NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [ -z "$NDK" ]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  if [ -z "$SDK" ] && [ -f "$HERE/local.properties" ]; then SDK="$(sed -n 's/^sdk\.dir=//p' "$HERE/local.properties" | tail -1)"; fi
  [ -n "$SDK" ] && [ -d "$SDK/ndk" ] && NDK="$(ls -d "$SDK"/ndk/*/ 2>/dev/null | sort -V | tail -1)"
  NDK="${NDK%/}"
fi
[ -n "$NDK" ] && [ -d "$NDK" ] || { echo "No Android NDK found: set ANDROID_NDK_HOME or install one (sdkmanager 'ndk;27.1.12297006')." >&2; exit 1; }
case "$(uname -s)" in Darwin) HOST=darwin-x86_64 ;; *) HOST=linux-x86_64 ;; esac
BIN="$NDK/toolchains/llvm/prebuilt/$HOST/bin"
[ -x "$BIN/llvm-strip" ] || { echo "The NDK at $NDK has no toolchain for this machine ($HOST)." >&2; exit 1; }
echo "NDK: $NDK"
[ -n "${PROTOC:-}" ] || command -v protoc >/dev/null 2>&1 || { echo "No protoc found: install it (apt-get install protobuf-compiler / brew install protobuf) or set PROTOC." >&2; exit 1; }

[ "$#" -gt 0 ] || set -- arm64-v8a x86_64
for ABI in "$@"; do
  # The flags are those of the Signal library's own Android build (java/build_jni.sh): on arm64 the AES of the
  # processor is used when it is there (`aes_armv8`). Its third flag, curve25519_dalek_bits="64", only changes
  # 32-bit targets, and none is built here.
  case "$ABI" in
    arm64-v8a) TARGET=aarch64-linux-android; CFG="--cfg aes_armv8 " ;;
    x86_64) TARGET=x86_64-linux-android; CFG="" ;;
    *) echo "Unknown ABI: $ABI (arm64-v8a or x86_64)" >&2; exit 1 ;;
  esac
  rustup target add "$TARGET"
  UPPER="$(echo "$TARGET" | tr 'a-z-' 'A-Z_')"
  LOWER="$(echo "$TARGET" | tr '-' '_')"
  # The NDK's clang links (and compiles any C a dependency brings). Pages of 16 KB: new phones need them, old
  # ones do not mind.
  (cd "$HERE/../core" && env \
    "CARGO_TARGET_${UPPER}_LINKER=$BIN/$TARGET$API-clang" \
    "CARGO_TARGET_${UPPER}_RUSTFLAGS=${CFG}-C link-arg=-Wl,-z,max-page-size=16384" \
    "CC_$LOWER=$BIN/$TARGET$API-clang" "AR_$LOWER=$BIN/llvm-ar" \
    cargo build --release --lib --features signal --target "$TARGET")
  mkdir -p "$HERE/app/src/main/jniLibs/$ABI"
  "$BIN/llvm-strip" --strip-unneeded -o "$HERE/app/src/main/jniLibs/$ABI/libinvizent_core.so" "$HERE/../core/target/$TARGET/release/libinvizent_core.so"
  ls -l "$HERE/app/src/main/jniLibs/$ABI/libinvizent_core.so"
done
