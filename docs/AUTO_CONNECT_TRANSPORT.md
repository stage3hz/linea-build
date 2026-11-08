# INVIZENT: automatic reserve connection

Status: design and source-review findings only. No new transport is implemented, no relay has been deployed, and no allowlist bypass has been verified by this document. No claim of being indistinguishable from an allowlisted application is made.

## Product requirement

When ordinary connectivity to INVIZENT stops working, the open application should automatically try trusted alternative routes. Users should not need a separate VPN application, a subscription link, or manual protocol configuration. Preserve the current account, encryption keys, drafts, and pending messages. Show a discreet reserve-connection indicator and allow the user to disable automatic reserve mode in connection settings.

This is resilience for INVIZENT's own traffic, not a system-wide VPN. Do not inspect other applications, request geolocation, install trust-all certificates, or weaken TLS, authentication, or personal-message E2EE.

## Existing foundation (reviewed at 9679fec2094c7b15053b4046210121b15186c576)

- `mobile/src/servers/pool.ts` already measures server health, preserves the fixed account realm, verifies signed endpoint lists, remembers a selected endpoint, and falls back to a Cloudflare edge when no direct candidate answers.
- `mobile/src/serverConfig.ts` already contains direct and edge candidates. Configuration alone does not establish that these candidates are reachable in a restricted network.
- `mobile/src/api.ts` reports `NetworkError` to the pool, but its `RequestTimeoutError` does not take this path. Silent connection failures can therefore miss this particular failover trigger; periodic pool probes and other reconnect paths are separate.
- The same API handler currently marks HTTP 502/503/504 as `notDelivered=true`. An upstream timeout is not evidence that a write was never applied. Do not broaden retries based on that assumption.
- `/health` probing currently accepts any successful HTTP status. Route validation should also verify the expected service response; a generic successful page is not enough. A health response does not prove that the authenticated message channel or media transfers work.

These are source-review observations, not results of a device test.

## Architecture

Keep account identity independent of the current route:

`message/outbox -> authenticated INVIZENT API and E2EE -> route adapter -> trusted ingress -> INVIZENT service`

An in-app native adapter is required for any selected nonstandard transport. Preserve an authenticated inner connection to the intended service through opaque tunneling relays. A relay terminating application TLS is instead part of the trusted service boundary and must be treated accordingly; E2EE does not hide authentication headers or plaintext community content from such a TLS terminator.

Candidate transports for a separate feasibility prototype include VLESS with REALITY and XHTTP with TLS. They are candidates, not a verified selection. Use maintained implementations rather than custom cryptography. Examine licensing, supported iOS deployment targets, native-library size, and compatibility with all network clients before inclusion.

Only use owned or explicitly authorized ingress infrastructure. The ingress must actually be reachable in the user's network. Naming a third-party allowed domain, sharing a hosting provider, or changing a TLS fingerprint does not itself grant access to an allowlisted destination. Do not embed a user's personal VPN subscription or a universal shared client credential in public source or general releases.

## Connection state machine

- DIRECT: use the normal route while it is healthy.
- CHECKING_RESERVE: bounded probes test trusted alternatives following repeated transport failures or a failed service-channel handshake. No assertion that DPI has been identified.
- RESERVE: use the validated alternative, reconnect the message channel, and drain the outbox safely.
- OFFLINE_WAIT: no candidate succeeds; keep drafts and pending work, apply backoff, and retry on network changes or foreground activation.
- RETURNING_DIRECT: validate sustained direct recovery before switching back. Avoid oscillation between routes.

These are proposed states, not exports currently present in the application.

### Classification and retry requirements

1. Distinguish user cancellation, normal slow links, loss of a network interface, unreachable service routes, authentication errors, server overload, and failed certificate validation. A timeout alone must not be labelled confirmed censorship.
2. A bad certificate makes that route untrusted; never fix it by disabling validation. A separately authenticated trusted route may still be tested.
3. Explicit caller cancellation stops the operation; it must not trigger a hidden resend. HTTP authentication and authorization errors do not start a protocol roulette.
4. Coalesce simultaneous connection recovery requests. Bound parallel probes and total retry work. Add backoff and jitter; stop unnecessary polling when suspended or disconnected.
5. GET/HEAD may be retried when safe. Writes whose outcome is unknown require operation-specific idempotency or reconciliation. Reuse existing message client IDs and encrypted envelopes; never create duplicate logical sends merely because a response was lost.
6. Keep validated bootstrap routes in the installed app and a previously authenticated cached configuration. Do not make recovery depend exclusively on downloading configuration from an already unreachable API. Verify signatures, versions, expiration rules, and allowed destinations before use.
7. Validate a real service exchange and reconnect the actual message channel, not only `/health`. Do not treat a captive-portal page as success.
8. Preserve per-network recovery state without SSID/location collection, and reset inappropriate failure penalties on network changes. Do not claim universal timings before measurement.

## Traffic coverage

Changing JavaScript `fetch` alone is insufficient. Review API requests, WebSockets, native upload/download tasks, image and video loaders, and desktop adapters. Every supported operation must either use the selected route or explicitly report that it is unavailable in reserve mode.

Stage the work: first authentication, personal and community text delivery, history synchronization, and attachments; then live calls, video, and screen sharing with their own media-transport tests. A successful HTTP request does not prove a usable WebRTC path.

For iOS, scope the initial guarantee to the open app. App-scoped fallback must not be advertised as restoring Apple push delivery when the device cannot reach APNs. Background execution constraints and signing requirements remain applicable. Do not abuse unrelated background modes to keep a tunnel alive.

## Verification required before enabling by default

### Deterministic controlled tests

- Direct route works: normal traffic stays direct.
- Direct DNS failure, connection reset, handshake timeout, and silent packet loss: a reachable trusted reserve is selected without manual settings.
- Slow but functional network: bounded behavior without rapid route switching.
- A successful HTML page instead of the expected service response: reject as an invalid health result.
- Invalid TLS certificate: reject the route without weakening validation.
- 401/403, 429, and service errors: preserve their real meaning.
- A write is accepted but its response is lost: no duplicated message, subscription operation, registration, or upload-completion action.
- Failure of every route: durable pending queue, no false delivered indicator, no endless tight loop.
- Network switch and foreground return: reconnect without changing account identity or encryption state.
- Direct recovery: return only after the stability rule is met.
- Tampered or rolled-back route list: reject it according to the configuration policy.

### Real-network acceptance

Test on both iPhone and Android in the same actual restricted mobile-network conditions: direct connection fails, the candidate ingress succeeds, and messages are delivered bidirectionally through the chosen route. Record operator/network conditions, app version, ingress configuration version, outcomes and timings without collecting message text, tokens, personal subscription URLs, or precise location. Separately test attachments, calls, and closed-app notifications. A local emulation of filtering proves client behavior, not real-world bypass of a particular operator's allowlist.

## Definition of done

Do not label this feature ready until native transport integration, owned ingress deployment, controlled regression tests, and real-network acceptance are all complete. Report these stages separately. No promise of access under every possible allowlist or total connectivity shutdown.

## Primary references

- IRTF RFC 9505, A Survey of Worldwide Censorship Techniques: https://www.rfc-editor.org/rfc/rfc9505.html
- HTTP Semantics RFC 9110, idempotency/retries and gateway errors: https://www.rfc-editor.org/rfc/rfc9110.html
- Xray REALITY transport: https://xtls.github.io/en/config/transports/reality.html
- Xray XHTTP documentation: https://xtls.github.io/en/config/transports/xhttp.html
- Apple, Preparing your UI to run in the background: https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background
- Apple, If your Apple devices aren't receiving Apple push notifications: https://support.apple.com/en-ie/102266
