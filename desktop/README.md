# INVIZENT for Windows

The Windows client uses the existing Expo/React Native Web interface inside Electron.
The production API and WebSocket endpoints remain HTTPS/WSS; no server deployment is required.

## Build

Use Node 24 on Windows x64:

```sh
cd mobile
npm ci
npm run typecheck
npm run test:ui
cd ../desktop
npm ci
npm test
npm run build:ui
npm run test:electron
npm run dist:win
```

The installer is `desktop/release/INVIZENT-0.14.0-Windows-x64.exe`.
The GitHub workflow **Windows desktop EXE** builds on Windows and uploads `invizent-windows`.
No Windows signing certificate is configured, so the installer is unsigned.

## Local data and isolation

The renderer has no Node integration. Context isolation, sandboxing and web security stay enabled.
The preload exposes bounded IPC operations, with sender and main-frame checks.
The official Signal SDK runs in the main process. Existing native clients retain their implementation.
Messages and session tokens are saved in an authenticated encrypted vault; its random key is protected
with Windows DPAPI. There is no unencrypted-storage fallback. Media cache operations are restricted
to the application's media directory. Saving outside it requires a native Save dialog.

## Screen sharing

Join a gaming community's voice channel and choose **720p · 60 FPS** or **1080p · 60 FPS**.
On Windows, choose a display or application window in the capture picker. On Android, confirm
system screen-capture permission. Capture stops on exit, reconnect, cancellation or Stop.
The existing microphone stays connected. Screen audio is not captured.

Video uses the room's existing authenticated peer mesh and DTLS-SRTP connections. A video
transceiver is reserved in the initial SDP; starting and stopping a share replaces its track.
Preset bitrates are 4 and 8 Mbps **per peer**. A large room increases upload and encoding load.
The presets request up to 60 FPS; delivered resolution and FPS depend on device, content and network.
Phone displays keep their aspect ratio with a maximum long edge of 1280 or 1920 pixels.

For iPhone, the IPA includes a ReplayKit Broadcast Upload Extension. Signing must preserve
`group.com.linea.messenger.preview.screen` (or `IOS_SCREEN_APP_GROUP`) on both the application
and `com.linea.messenger.preview.ScreenBroadcast`, with matching provisioning profiles.
Developer Mode alone is insufficient. Appneza's support for these entitlements is unverified.
The unsigned build cannot demonstrate that a third-party signing service will provision them.
The App Group carries the frame socket and capture settings only, never chat keys or session tokens.

## Current validation limits

Automated tests cover Signal exchange, encrypted persistence, isolation, cache boundaries and
screen-sharing lifecycle. The Windows Electron smoke test also checks DPAPI and actual capture;
it runs a loopback WebRTC receiver for each preset. It does not measure sustained 60 FPS.
A multi-device call, actual Windows installation, POCO X6 Pro performance and signed ReplayKit
capture still need device testing. The browser media adapter supports JPEG/PNG/GIF and MP4;
native photo-editor tools and video-note recording do not yet have full desktop parity.
