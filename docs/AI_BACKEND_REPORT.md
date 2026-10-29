# AI text backend — implementation and verification

Date: 2026-10-28. Runtime verified: Node.js 24.22.1.

## Implemented scope

`server/src/ai.js` provides authenticated text chat and code generation/explanation through the fixed OpenRouter `openrouter/free` model route. It does not execute generated code. Image generation/editing, video generation/editing, 3D and social-network actions have no connected executor and are explicitly disabled in the status response. There is no public single-user proxy, account rotation, paid fallback, browser automation or arbitrary URL forwarding.

The module uses the existing server dependencies and Node's fetch implementation. The application owner registers the routes in `app.js`; this report does not claim deployment or a successful live provider response. No real provider key was read and no live LLM request was sent during development or tests.

## Server integration

```js
import { registerAiRoutes } from './ai.js';

registerAiRoutes(app, {
  authenticate: requireAuth,
  apiKey: process.env.OPENROUTER_API_KEY || '',
  allowedOrigins,
  now,
});
```

`authenticate` must establish `request.auth.user_id` from a valid session. `allowedOrigins` contains exact permitted web origins; native requests without an Origin header remain supported. `fetchImpl`, `now` and `timeoutMs` are dependency injection points for tests, not HTTP parameters. The maximum accepted server deadline is 60 seconds. The HTTP connection timeout must exceed that deadline; the client should allow approximately 65–70 seconds and support cancellation.

An absent key is an ordinary disabled configuration: status reports `configured:false`, and chat returns HTTP 503 / `AI_NOT_CONFIGURED` without making an external request. A configured key only establishes configuration presence; it does not prove quota, current model availability or provider credentials are valid. The key never appears in a response or client bundle.

## HTTP contract

### GET `/ai/status`

Authentication is required. The response is:

```js
{
  configured: true, // false when the server key is absent
  provider: 'openrouter',
  model: 'openrouter/free',
  freeOnly: true,
  capabilities: {
    text: { enabled: true },
    code: { enabled: true, reason: 'Генерация и объяснение кода. Выполнение кода не подключено.' },
    image: { enabled: false, reason: '...' },
    video: { enabled: false, reason: '...' },
    threeD: { enabled: false, reason: '...' },
    social: { enabled: false, reason: '...' }
  }
}
```

Without a key, `text` and `code` also have `enabled:false` and an explanatory reason. Media and social capabilities remain false regardless of key configuration.

### POST `/ai/chat`

```js
{
  messages: [
    { role: 'user', content: 'Explicitly approved task text' }
  ],
  consent: true
}
```

Only `messages` and `consent` are accepted. Each message has only `role` and `content`. Roles are `user` or `assistant`; the first and last messages must be from the user. No client `model`, `provider`, `baseUrl`, `taskType`, system message, tool definition or attachment is accepted. Code mode uses an explicit user prompt, the same endpoint and the same consent requirement.

Response:

```js
{
  text: 'Provider answer',
  model: 'actual/provider-model-id',
  provider: 'openrouter',
  freeOnly: true
}
```

Errors contain a safe Russian `error` and stable `code`. Rate limits may also return `retryAfterSeconds` and a Retry-After header. Raw provider bodies, stack traces, secrets and echoed prompt text are not returned. Both endpoints reject query parameters and return no-store/nosniff headers.

## Fixed routing and privacy

The only outbound endpoint is `https://openrouter.ai/api/v1/chat/completions`, with redirects rejected. Only the server key and JSON content negotiation headers are sent. Client credentials, cookies, origins, referrers and user identifiers are not forwarded.

The provider request sets `model:'openrouter/free'`, `stream:false`, `max_tokens:2048` and:

```js
provider: {
  data_collection: 'deny',
  zdr: true,
  require_parameters: true,
  max_price: { prompt: 0, completion: 0, request: 0 },
  allow_fallbacks: true
}
```

Eligible provider fallback remains inside these free-price and privacy constraints; no alternate paid model list exists. A provider-reported nonzero or malformed `usage.cost` is rejected when present. Price enforcement primarily comes from the fixed free route and zero-price request constraints; inspecting cost after a response is not a substitute for those constraints.

OpenRouter documents `data_collection` and ZDR filters as provider routing policies. These are requested explicitly; the implementation does not claim to independently audit the external provider's retention. If no free endpoint meets the requested policies, the request fails without weakening them. Availability and service limits can change.

The module forwards only the explicitly supplied AI conversation. It does not read messenger conversations, decrypted media, contacts or files. Sending an AI request transmits that selected text through the Linea server, OpenRouter and the selected inference provider; it is distinct from end-to-end encrypted peer messaging. Consent must be shown before sending. This module stores neither prompts nor responses and disables its request logger; deployment-wide logging/proxy settings must preserve that intent.

## Bounds and cancellation

| Resource | Bound |
| --- | --- |
| Request body | 128 KiB |
| Messages | 1–20 |
| Individual content | 8,000 JavaScript UTF-16 code units |
| Total content | 32,000 JavaScript UTF-16 code units |
| Provider response body | 128 KiB, counted during streaming |
| Answer text | 16,000 JavaScript UTF-16 code units |
| Provider generation | 2,048 output tokens requested |
| Deadline | 60 seconds including full response body read |
| Per-user requests | 6 per minute, one in flight |
| Server-wide concurrency | 4 in flight |
| Rate-limit buckets | At most 10,000, expired entries reclaimed |

Invalid Unicode, NUL characters and blank content are rejected. Input whitespace is preserved for code and approved prompts. History is never silently truncated; an over-limit request fails. A model may stop at its output-token limit; the API accepts its `length` finish reason without promising a complete long answer.

The response parser requires one assistant text answer and rejects tool calls. It checks content type, JSON/UTF-8 validity, model identifier shape and streamed bytes even when Content-Length is missing. Deadline, client disconnect and application shutdown abort upstream operations. Reservations are released on success or failure. HTTP 429 responses retain a bounded safe retry hint; other provider failures use generic errors and are not automatically retried.

## Verification

Meaningful tests were written before implementation. Against an empty route installer, ten non-concurrency cases failed as expected because the endpoints were absent; the concurrency case was omitted from that RED run because it waits for a provider call. After implementation, all eleven cases passed. A final rerun also passed 11/11 with no skipped, cancelled or failed tests.

```sh
node --check server/src/ai.js
node --check server/test/ai.test.js
node --test --test-isolation=none server/test/ai.test.js
```

The final test rerun completed with 11 passes in approximately 410 ms. All external calls used injected fake fetch implementations and synthetic text/keys. Covered behavior:

1. Authenticated status, accurate capabilities and no key disclosure.
2. Missing configuration rejects chat without a network call.
3. Exact approved text, fixed endpoint/model, zero-price and privacy constraints.
4. Authentication, origin and consent checks before provider access.
5. Rejection of paid-model/URL overrides, system roles, tools and attachments.
6. Message, character, Unicode, NUL and HTTP body bounds.
7. Safe provider 429 handling without sensitive upstream error disclosure.
8. Provider credential/payment/redirect errors and malformed/empty/nonzero-cost answers; no hidden retry.
9. Deadline abort and subsequent reuse of the released user slot.
10. Cancellation of excessive streamed output without Content-Length.
11. Per-user concurrency/rate enforcement and recovery after the window expires.

The parent subsequently installed these routes in the full application using
server-only `aiApiKey`/`aiFetch` build options and `OPENROUTER_API_KEY` in the server
entry point. Its real application integration test covers registration, session
authentication, a fake-provider answer and logout. The complete pre-refactor
server suite passed 71/71 tests. That snapshot predates the later parent-owned
E2EE-only changes and is kept as historical evidence, not a claim about those
later changes. An actual configured-provider answer and deployment behavior
still require separate verification; fake-provider tests do not establish free
quota availability.

## Scoped quality follow-up

Six more behavior tests pin server configuration rejection, allowed origins and
invalid session subjects, exact text/history limits, provider envelope/header
validation, safe retry bounds and global concurrency/shutdown. All 17 AI tests,
together with three fast in-memory entitlement cases, passed before the
refactor. The refactor separates request parsing, provider response validation,
access checks and the bounded request budget into focused functions/classes;
the fixed endpoint, price/privacy controls and HTTP contract stay the same.

After that refactor, the combined scoped run passed **35/35** tests: 17 AI, three
entitlement, 13 username/administrator and two application integration tests.
Node's actual LCOV coverage for `ai.js` is 99.37% lines and initially 95.65% branches. The
uncovered budget-sweep path is not described as tested. Crapper, using that
coverage, reports a maximum CRAP score of 8.0 across the three new modules
`ai.js`, `entitlements.js` and `username.js`; the route installer is now CC 1.

Dryer does not select `.js` files in this installed version. It was also run on
byte-identical `.ts` copies used only as parser inputs; this produced zero
duplicate candidates at similarity 0.8. These copies are not production files
or a TypeScript build. Mutation verification is scoped to injected-fetch AI and
in-memory entitlement tests; its final results are recorded in the account
report and `docs/evidence-v05` rather than implying that every server file was
mutation-tested. No live provider requests were introduced by any of these
checks.

The final test-only additions raise the AI suite to **21 tests**, with three
entitlement tests passing alongside it (**24/24**). They pin additional exact
limits, UTF-8 rejection, provider flags and early-disconnect cancellation. Final
AI branch coverage is **95.83%**; source remains unchanged after the production
freeze. The application-plus-AI run passed **22/22** separately.

Final mutation results are **165 killed / 10 survived / 1 uncovered** across AI
and entitlement modules; all 20 entitlement sites were killed. The tool returns
exit 3, so the all-mutants-killed gate is **not passed**. Six survivors have
documented equivalence arguments under the private controller/cost/time
invariants; four are explicitly unverified boundaries (the permissive
128-character Retry-After parser guard and three 10,000-user capacity guards).
The one uncovered site is the expiry comparison in rate-bucket sweep at
capacity. The detailed review and frozen hashes are in
`docs/USERNAME_PLATINA_REPORT.md` and `docs/evidence-v05`.

## Primary sources reviewed

- [OpenRouter free model router](https://openrouter.ai/openrouter/free): zero prompt/completion pricing and text output. The implemented client accepts only text input even though the upstream route can accept images.
- [Free router guide](https://openrouter.ai/docs/guides/routing/routers/free-router): selection among available free models.
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection): data collection, ZDR, parameter requirements, price ceilings and fallback controls.
- [Chat completion API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion): request and answer schema.
- [Rate limits](https://openrouter.ai/docs/api_reference/limits): service limits and Retry-After handling; no fixed external daily quota is assumed here.
- [Model catalogue API](https://openrouter.ai/docs/api/api-reference/models/get-models): models expose pricing and input/output modalities. A catalogue entry is not an integrated image/video/3D executor; this implementation does not claim those capabilities or an asynchronous video API.

Sources were checked on 2026-10-28. No model inventory count or future availability guarantee is embedded in the implementation.
