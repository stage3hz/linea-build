# Stage B: experimental app-scoped networking and bootstrap

Work is isolated to `transport-b-integration`. No production deployment, merge,
`ipa-output` update or signing-material change is authorized by these tools.

## Implemented source

- The experimental stand can select `wbstream` or `telemost`. The provider is
  chosen by private server configuration, signed into each lease and checked
  against its exact link format on mobile. A client request cannot select an
  arbitrary provider or destination. Telemost uses the pinned upstream's VP8
  transport, a full canonical `https://telemost.yandex.ru/j/<numeric-id>` link
  and a server-side Yandex session; WB uses its existing room ID/DC path.
  These are protocol adapters, not proof of a real platform connection.
- Native iOS 17+ URLSession HTTPS/WSS over per-session authenticated loopback SOCKS5.
  Direct fallback is explicitly disabled; system TLS validation is retained.
  Session IDs/generations fence cancellation and stale callbacks. Network requests
  are bounded to 1 MiB upload / 8 MiB response; text socket frames to 256 KiB.
- API dispatch and message socket creation use the selected app-owned route.
  Account realm, auth/device proof, Signal keys and original outbox IDs remain intact.
  A failed write is not secretly repeated through the direct network.
  A socket that opens but never reaches authenticated ready has a bounded setup
  deadline (longer on slow links); foreground reserve is stopped on background
  and re-established after foreground return without borrowing an audio mode.
- Ready means expected TLS health, matching authenticated `/me` identity and WSS
  `ready`, not a resolved native start Promise. Direct recovery uses the same checks.
- Independent owned bootstrap forwards ONLY `/auth/device/challenge`, `/auth/device/bind`,
  `/auth/device/proof`, and allocates signed leases after the existing API confirms a bound
  current session. Here lease `deviceId` is that authenticated bound session ID;
  it is not a hardware fingerprint. No asserted identity is accepted from a body.
  There are per-token/global limits, strict response/body limits, no redirects or
  logging of tokens, cookies, signatures, proofs or room links.
- Creator egress gateway is loopback-only SOCKS, TCP/443 to `api.invizent.com` only.
  Other hosts, literal addresses, UDP and private/special DNS addresses are denied.
  Resolution is bounded/coalesced and the selected public address is dialed directly
  to prevent a second DNS lookup. Inner application TLS stays end-to-end to the API.
  Pinned Creator code has no direct fallback when its upstream SOCKS dial fails;
  **actual Creator wiring and namespace isolation still need real-session proof**.
- An expired lease or disabled reserve stops the owned route. New networks reset
  the previous attempt. Cold bootstrap uses its independent hostname, not the
  unreachable main API. A reachable deployed ingress still must actually exist.

## Enablement boundary

`TRANSPORT_B_BOOTSTRAPS` and `TRANSPORT_B_LEASE_KEYS` are empty in normal source.
Native `appRouting` remains false. Do NOT enable for ordinary users until an owned
reachable ingress, real platform session, server isolation and device/network
acceptance are verified. Public configuration alone proves none of those things.
Current coverage: foreground JSON/text API and message WSS. Native image/video
loaders, streamed/large attachments, calls, SFU, APNs/push and background recovery
are separate unfinished coverage. The iOS 17 networking API is not enabled on 16.4.

## Separate authorized test stand (agent-operated)

The offered RUVDS host was confirmed to be the **working** messenger server;
it is not an authorized separate stand. See `TRANSPORT_B_SERVER_HANDOFF.md`.
Read-only-first helpers for a future empty host are documented in
`../prototype/transport-b/stand/README.md`; they do not deploy this service or
automatically provision its browser/display.

No commands below are a request to change the working VPS. Before exposure, use a
separate authorized host, owned HTTPS name, private platform credential file and
verified isolation. Never send cookies/private keys in chat, PRs or Actions logs.

1. Build `headless/telemost` (or `headless/wbstream`) from pinned upstream
   `kulikov0/whitelist-bypass@a26b5555728e5b3e990b8204f7663cc742c9de3b`, Go 1.26.1.
   Keep its MIT license. No floating main or universal room URL.
2. Prepare private paths and owned ingress trust (creates files, deploys nothing):

   `node prototype/transport-b/prepare-stand.mjs /absolute/private/stand https://reserve-test.invizent.com /absolute/bin/wbstream /absolute/private/cookies.json`

   For Telemost, use its Creator binary and add the final argument `telemost`:

   `node prototype/transport-b/prepare-stand.mjs /absolute/private/stand https://reserve-test.invizent.com /absolute/bin/telemost /absolute/private/cookies-yandex.json telemost`

   The default remains `wbstream` for existing private stand configurations.
   The account used by the owner was refused by WB Stream with the message
   that access is limited to employees. Guest UI visibility did not demonstrate
   Creator permission. Do not keep asking the owner to register there.
   Telemost Creator requires a real Yandex `Session_id`; a public meeting link
   alone cannot replace its server-side session. No real Yandex login, credential
   import or Telemost Creator/Joiner connection has been performed here.

   It creates an Ed25519 key (0600), durable sequence DB path, bootstrap config,
   PUBLIC app trust JSON and owned TLS ingress config. Existing files are not overwritten.
3. Once access/isolation are authorized, the stand process command is:

   `node prototype/transport-b/src/serve-bootstrap.mjs /absolute/private/stand/bootstrap.json`

   It binds HTTP to 127.0.0.1:9047 and its restricted egress to an ephemeral
   loopback port. Creator capacity is 2, room TTL 10 minutes. A trusted HTTPS
   reverse proxy uses the generated owned-domain Caddyfile. Provisioning this
   ingress, DNS and platform credentials has NOT been performed by this code.
4. Experimental iOS workflow input `transport_b_public_config` accepts ONLY the
   generated PUBLIC JSON. `mobile/scripts/inject-transport-b.mjs` validates exact
   owned origins and Ed25519 public keys, rejecting credentials and extra fields.
   Disabled builds and normal source stay off; signing is separate.
5. Acceptance must exercise actual Creator ↔ Joiner traffic on iPhone, cold start
   while direct access is unavailable, cancellation/network changes, direct return,
   unchanged account and no duplicated messages. Calls/media/push require separate
   verification. Do not advertise an operator-specific result from a local fixture.

## Checks

- `npx tsc --noEmit` in mobile.
- `node --test mobile/test/transport-b-*.test.mjs` with mobile dependencies installed.
- `node --test prototype/transport-b/test/*.test.mjs`.
- The reusable `stage-b-network-proof.yml` compiles the real Swift adapter and
  tests real TLS GET/POST and WSS auth/ready/message through authenticated SOCKS.
  Its reserved test hostname is mapped ONLY on the disposable CI runner. Counters
  prove proxy traversal; bad credentials/certificate, redirects, foreign origins,
  cancellation and dead proxy with a directly reachable service must fail closed.
- `stage-b-native-proof.yml` requires that proof plus real Go binding before full
  iPhone Release build/link/package in both opt-in modes. An artifact name does
  not prove an IPA exists: inspect contents, checksums and device architecture.
