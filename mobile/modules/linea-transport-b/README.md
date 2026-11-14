# Stage B: local iOS Expo module

The source now exposes `LineaTransportB` to Expo autolinking. The normal build
contains only a disabled bridge: no Go library, no automatic session, no traffic
redirect. `INVIZENT_TRANSPORT_B=1` at **pod install** opts into the pinned library.
Missing artifacts make pod installation fail instead of silently shipping a stub.

CI places the checksummed `Mobile.xcframework` in `ios/Frameworks/` and copies our
existing `prototype/transport-b/ios/StageBProofJoiner.swift` into `ios/Generated/`.
Both generated directories are gitignored. No binary or third-party credential is
committed. The upstream MIT license is included with the experimental build.

`startSession(id, link)` starts native negotiation; its resolved Promise does NOT
mean connected. Listen for `transportState` for that exact id. `sessionConnected`
means the upstream session emitted its connected status, NOT that a SOCKS listener,
TLS request, message socket, or app-scoped route has been verified. Status events
are sanitized. Commands run on one serial queue; late callbacks and stale stops
are fenced by the session identity/generation. Setup times out after 45 seconds.

`capabilities().appRouting` is deliberately always false. The TypeScript loader
rejects absent, disabled and incompatible modules. It does not call start and is
not imported by the production server pool. A caller must validate the signed,
device-bound lease before passing the secret link; never log or persist the link.

The CI workflow now attempts a full unsigned iOS app **link build**, not merely a
Swift typecheck. Its actual result must be checked in the run; configuration is not
proof of success. The IPA is experimental and cannot yet carry chat traffic using
Stage B. Next steps remain: an authenticated app-scoped request/WS adapter, reachable
bootstrap, server-side egress controls, device testing and real-network validation.
