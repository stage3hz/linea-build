# Experimental iOS Transport B

Default builds have a disabled session bridge and no Go framework. Explicit
`INVIZENT_TRANSPORT_B=1` at pod install requires the pinned xcframework and shared
Swift source; missing artifacts fail closed. Framework/source preparation and
unsigned app builds in both modes are covered by `stage-b-native-proof.yml`.

The session ABI remains protocol 1. `startSession` starts negotiation, not a ready
application route. `transportState` is fenced by session identity/generation.
`sessionConnected` is only the upstream event, not proof of SOCKS/TLS/API/WSS.

On iOS 17+ the opt-in module also exposes `networkProtocol: 1` and
`sessionNetworking: true`. Requests and text WebSockets use a session-owned
URLSession through authenticated loopback SOCKS5, with direct failover disabled,
standard TLS trust, fixed INVIZENT service origins, no cookies, no redirects,
limits and cancellation. Per-session SOCKS credentials stay native and ephemeral.
The listener port is selected per attempt; a bind race fails validation safely.
There is no device VPN, global fetch replacement or new Network Extension.

`TransportBSessionRoute` validates TLS health, the actual signed-in account and an
authenticated WSS `ready` frame before publishing. The message route registry
fences account changes, network loss and late callbacks, does not retry uncertain
writes, and reconnects the existing messenger socket when the route changes.
Automatic recovery uses a separately deployed owned bootstrap and durable lease
sequence watermark; direct return also requires authenticated API/WSS validation.

`capabilities().appRouting` deliberately remains false: ordinary production
bootstrap origins and verification keys are EMPTY. Explicit experimental public
trust injection is supported, but configuration itself proves no reachability.
Coverage is foreground JSON/text API + text message WSS. Native media loaders,
large/streamed transfers, calls, push and background operation are not covered.
Unsupported request body/size is refused rather than silently routed directly.

`stage-b-network-proof.yml` runs the actual Swift networking class against a
local TLS/WSS service through a real authenticated SOCKS5 listener. It verifies
credentials, TLS rejection, origin policy, redirects, cancellation and no direct
fallback. This is NOT WB Stream, a real Creator/Joiner session, a physical iPhone,
or a test of an operator's allowlist. The test CA exists only on the disposable
runner; application trust is never overridden. See `docs/TRANSPORT_B_NETWORKING.md`.
