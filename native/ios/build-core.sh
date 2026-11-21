#!/bin/sh
# Builds the shared core for one Apple target and puts the library where the Xcode project looks for it.
#   ./build-core.sh aarch64-apple-ios-sim     (simulator on an Apple-silicon Mac)
#   ./build-core.sh x86_64-apple-ios          (simulator on an Intel Mac)
#   ./build-core.sh aarch64-apple-ios         (the phone)
set -eu
TARGET="${1:?target}"
HERE="$(cd "$(dirname "$0")" && pwd)"
rustup target add "$TARGET"
(cd "$HERE/../core" && cargo build --release --lib --target "$TARGET")
mkdir -p "$HERE/build/core"
cp "$HERE/../core/target/$TARGET/release/libinvizent_core.a" "$HERE/build/core/libinvizent_core.a"
