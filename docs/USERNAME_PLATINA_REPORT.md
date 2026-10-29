# Public username, stable identity and Platina server controls

Date: 2026-10-28. This is implementation evidence for the 0.5 iteration, not a claim of production deployment or live billing.

## Account model

An account keeps its existing `users.id` UUID for sessions, contacts, chat membership, message ownership and encryption devices. The public `username` is a separate mutable handle. Migration 4 adds `login_name`, copies each existing username into it, indexes it uniquely and prevents later changes to it. It also prevents changing the account UUID. The initial registration body stays compatible: `{username,password,displayName,confirmationWord,recoveryWord,deviceName?}` creates an immutable login and initial public username with the same normalized value.

The login and recovery HTTP request field is still named `username` for client compatibility, but lookup now uses `login_name`. After a public rename, the original login is required for login and recovery. The new public handle is not an alternate login. Authentication, password changes, recovery-word changes, recovery cancellation and credential invalidation all use the immutable login where a login-derived key or secret comparison is required.

Public username and login values use the existing canonical rule: 3–24 Latin letters, digits or underscores, lowercased, without `@` in stored data. Both the current public-name and immutable-login namespaces are reserved against another account. A registration or rename cannot take another user's login after that user changes their public handle. The current username remains unique through the existing unique index; transaction checks and database triggers also protect cross-namespace reservations.

`login_name` is returned only to its authenticated owner by the new private status endpoint. Public user objects do not include it, subscription details, credential hashes or administrative notes. An initial public username naturally matches that account's chosen login until it is changed; this design does not promise that historically public information becomes secret afterward.

## One free rename

`username_change_used` is a persisted 0/1 flag. Registration leaves it at zero. The first actual public-name change sets it to one in the same `BEGIN IMMEDIATE` transaction as the name update. Further changes require a currently active server entitlement.

A normalized request for the already-current username is idempotent: it succeeds without consuming the free change or requiring Platina. Invalid inputs and collisions also leave the flag unchanged. Two concurrent different-name requests on separate server database connections can consume at most one free change. A failed request cannot reset the flag. Restarting the server or renewing/expiring Platina does not restore the free change.

Changing a username does not revoke sessions, alter password hashes, update encryption keys or reset recovery timing. Existing recovery grants and attempts remain attached to the same UUID and immutable login.

## Private API

`installUsernameRoutes({app,db,now,authOptions,emitUser,emitChat})` is installed by the application. All routes require the existing valid session. Mutation handlers recheck the session inside the write transaction.

### GET `/me/username`

```js
{
  accountId: 'existing-account-uuid',
  loginName: 'original_login',
  username: 'current_public_handle',
  freeChangeAvailable: true,
  canChangeUsername: true,
  platina: { active: false, expiresAt: null },
  canSetStatusEmoji: false,
  statusEmoji: null,
  statusEmojiChoices: ['✨','⭐','🌙','☀️','🌊','🌿','🔥','💎','🪐','🎧','🎮','🦋']
}
```

An expired or revoked grant may still have a finite `expiresAt` in this private status object, while `active` is false. The server derives capability booleans from the free-change flag and current entitlement time. It does not trust a client-supplied capability or payment flag.

### PATCH `/me/username`

Input is exactly `{username:string}`. Success returns `{user,status}`, where `status` has the shape above and `user` is the ordinary public user object. Collisions return HTTP 409 / `USERNAME_TAKEN`; a second actual change without active Platina returns HTTP 403 / `PLATINA_REQUIRED`. Invalid or extra body fields return HTTP 400.

### PATCH `/me/status-emoji`

Input is exactly `{statusEmoji:string|null}`. Non-null values must exactly match one of the server-provided static Unicode choices. Installing or changing a non-null emoji requires active Platina. Setting null clears the stored choice and remains permitted after expiry or revocation. The default is null. Arbitrary text, URLs, custom uploaded files, animations, repeated emoji and unknown variants are rejected.

Successful responses also use `{user,status}`. Actual profile changes send existing `profile` events to the account's sessions and its chat peers, and refresh their chat serialization. Idempotent retries do not generate an additional profile change.

## Public emoji serialization

`publicUser(row,{db,now=Date.now}={})` returns `statusEmoji` and `statusEmojiExpiresAt` in addition to the former public fields. It reads the server entitlement each time. Both fields are null if there is no active entitlement or no valid selected emoji. An active selected emoji always has a finite ISO expiry; null does not mean a perpetual entitlement. Omitting the database context produces null values rather than trusting a stored emoji.

The application wraps publicUser calls explicitly, including the `/users` array mapping; it does not accidentally pass Array.map's numeric index as the serialization context. `publicChat` receives the database and injected time through its existing options. Client code can hide an already-cached emoji at its expiry without waiting for another response. Administrative revocation is reflected on subsequent server serialization; this CLI does not itself maintain a live WebSocket connection to push a revocation event.

No Platina wordmark is inserted into chat data. The client owns the profile-only membership presentation. Animated/custom emoji packs are not implemented by this static Unicode endpoint.

## Trusted entitlements and administrator CLI

`platina_entitlements` stores one current grant per account, with a grant UUID, `source:'admin'`, grant time, finite expiry and optional revocation time. `platina_audit` records actual grants/revocations with the administrator's reason. A grant is active only when its trusted source is recognized, its stored timestamps are valid, it has not been revoked, its start is not in the future and its expiry is strictly after the server's current time. The exact expiry instant is inactive.

The current version has no purchase, receipt verification, subscription webhook or public grant endpoint. No mobile flag, profile patch, HTTP body or claimed transaction can activate Platina. The only implemented writer is the local administrator tool, used by someone who already has trusted filesystem access to the server database. This supports controlled preview/testing; it is not a live App Store/Google Play billing system.

Example commands, to be run deliberately by the server owner with an actual account UUID and existing data directory:

```sh
node server/src/platina-admin.js grant \
  --data-dir /srv/linea/data \
  --user-id 11111111-1111-4111-8111-111111111111 \
  --expires-at 2027-01-01T00:00:00Z \
  --reason 'Approved preview membership'

node server/src/platina-admin.js revoke \
  --data-dir /srv/linea/data \
  --user-id 11111111-1111-4111-8111-111111111111 \
  --reason 'Preview membership ended'
```

These are examples, not commands executed against real accounts. The tool requires an existing regular database file, a real account UUID, a finite future UTC expiry for grants and a nonempty administrative reason. It rejects unknown/duplicate arguments. Grant and audit writes are atomic. Repeating a revocation does not add another audit event. JSON output contains only account ID and derived membership status. Tests use synthetic accounts in disposable temporary databases.

## Migration and verification log

1. Fixed the owner/private API and public serialization contract with the parent/UI before implementation.
2. Wrote eleven behavior tests against the old implementation. All eleven failed for the expected missing routes or schema version 3. Implemented migration 4, immutable-login auth lookups, transactional rename/status routes and trusted entitlement storage.
3. A standalone migration regression passed, including two consecutive opens of a version-3 database, preservation of UUID/session/recovery rows and rejection of login/UUID mutation.
4. The parent integrated application routes and serializers. The first combined AI/username run passed all 22 tests (11 AI plus 11 account cases).
5. Added two focused trusted-administrator checks: validation/audit/idempotent revocation, and real CLI invocation in a child Node process against a disposable database.
6. The initial full server run had 69 tests: 59 passed and 10 failed. Nine failures were explicit `listen EPERM` from the sandbox blocking local WebSocket listeners. The CLI failure was empty child-process output. A separate minimal spawn probe reproduced `spawnSync ... EPERM`; this was an execution-environment restriction, not accepted as CLI success.
7. With local subprocess execution permitted, the CLI returned JSON and exposed a test-clock mismatch: the injected HTTP clock was frozen before the real CLI's grant timestamp. The test now advances its fixture clock to wall time after the grant. The production grant code was not weakened; future-dated grants still fail closed. The targeted CLI test then passed.

The final complete server run and source manifest are recorded in the evidence section below. Android photo module metadata was independently aligned to 0.5.0 without changing its Kotlin/Swift production code. No iOS build or device execution is implied by these server tests.

8. With local loopback/subprocess execution permitted, the complete server run
   passed **71/71**, with zero failures/skips/cancellations, in 206,825 ms. It
   includes the parent's AI application and `@username` search integration tests.
   Its source hashes and log are retained as the pre-refactor snapshot. The
   parent later tightened global E2EE-only behavior separately; this historical
   result does not claim to validate those subsequent edits.
9. Split the new AI request/response/configuration/budget responsibilities and
   the account status/mutation/notification responsibilities after pinning their
   behavior. Removed redundant optional auth fallbacks inside the account
   transaction: the shared auth middleware owns parsing the session, while the
   transaction still rechecks the stored session for expiry/revocation.
10. The post-refactor scoped run passed **35/35** (17 AI, three in-memory
    entitlement, 13 username/administrator and two application integration
    tests), with no failures/skips/cancellations, in 27,071 ms. These are actual
    request/response, time-boundary, database and CLI behaviors, not empty
    wrapper tests.

## Scoped quality evidence

| Module | Line coverage | Branch coverage |
| --- | --- | --- |
| `ai.js` | 99.37% | 95.83% |
| `entitlements.js` | 100.00% | 100.00% |
| `username.js` | 100.00% | 97.22% |

Node's LCOV was consumed by Crapper. Every measured function in these three
modules is below CRAP 10; the highest is 8.0. This gate does not cover all
pre-existing authentication/application code or the separate administrator CLI.

The installed Dryer does not discover JavaScript directly. On byte-identical
TypeScript-extension parser copies of these three modules, it reported no
duplicate candidate at similarity 0.8. No production extension, build or source
content was changed for that analysis.

After mutation feedback, four more AI tests and stronger existing assertions
covered exact byte/configuration/session/time boundaries, malformed UTF-8,
required provider flags and cancellation on early client disconnect. These are
test-only additions after the production freeze. The final **21 AI + 3
entitlement tests passed 24/24**, with no live provider calls, in approximately
757 ms with coverage enabled. AI application integration plus the final 21 AI
tests also passed **22/22** in approximately 2,579 ms. A contact-free
registration/security smoke test passed separately. No production source was
changed for these final assertions.

The final Crapper input combines the latest AI/entitlement LCOV with the
username LCOV from the 35-test run. Each trace refers to the same unchanged
production file bytes recorded in the source manifest. Coverage is not claimed
for unrelated server files.

### Mutation result and remaining gaps

The first scoped mutation run killed 141 of 175 executed sites. After the
additional assertions, the final result is **165 killed, 10 survived and 1
uncovered**, across 176 discovered sites (94.3% of executed sites killed).
All **20 entitlement-module sites were killed**. The mutation command returned
exit code 3 because survivors remain; **the all-mutants-killed gate did not
pass**. Username mutation testing was not run; its HTTP/database behavior is
covered by the separate request tests.

| Surviving mutation | Count | Review |
| --- | --- | --- |
| `checkZeroCost`: one of the two `||` operators becomes `&&` | 2 | Equivalent for the supported cost values: the final strict `cost !== 0` still rejects every defined value except numeric zero, and undefined is returned earlier. |
| `withDeadline`: AbortSignal listener `once:true` becomes false | 1 | Equivalent under the standard one-shot AbortSignal lifecycle; the listener is also removed in `finally`. |
| `reserve`: retry lower clamp 1 becomes 0 | 1 | Equivalent while the bucket is active: its positive remaining duration rounds up to at least one second before the clamp. Expired buckets are replaced. |
| `release`: controller ownership guard `&&` becomes `||` | 1 | Equivalent under the private one-in-flight-per-user invariant: the stored controller is the current controller, or no reservation was acquired and deleting an absent entry has no effect. |
| `chatHandler`: event callback's optional `controller?.abort()` becomes direct access | 1 | Equivalent because those callbacks are installed only after a controller has been reserved; this does not apply to the separate catch-path optional abort. |
| `retryAfter`: the 128-character input guard changes `>` to `>=` | 1 | **Unverified boundary**, not declared equivalent for every string accepted by Date.parse. Canonical numeric/HTTP-date retry values are shorter, but the exact permissive-parser boundary is not pinned. |
| `bucketFor`: three mutations to the 10,000-user capacity/sweep guards | 3 | **Unverified stress boundaries**, not equivalent. The tests do not fill all 10,000 rate buckets; these mutations can change capacity/backpressure behavior. Current source explicitly keeps the bound, but this high-cardinality behavior was not mutation-verified. |

The single **uncovered** mutation is the expiry comparison in `AiBudget.sweep`
(`entry.until <= time` becoming `<`). The sweep body is reached when the rate
map fills to 10,000 users. That stress case was not executed. It is a coverage
gap in expiry-at-capacity cleanup, not a demonstrated production defect. It is
retained explicitly rather than counted as killed or dismissed as equivalent.

The boundary/disconnect assertions killed the meaningful survivors affecting
first/last history roles, exact byte limits, cumulative response chunks, UTF-8
strictness, provider error envelopes, required provider flags, session/config
bounds, window rollover and client-disconnect cancellation. No current-source
authorization bypass, paid fallback or unintended outbound request was found by
these checks. That statement does not convert the remaining gaps into a full
mutation pass.

### Reproducible evidence

Evidence is under `docs/evidence-v05`:

- `server-pre-refactor-71-pass.txt` and its source manifest: historical complete
  suite, before scoped refactoring and later parent-owned E2EE-only changes.
- `server-scoped-35-pass.txt`: post-refactor account/AI/application behaviors and
  actual coverage.
- `server-ai-entitlements-final-24-pass.txt`: final AI/entitlement test additions
  and coverage.
- `server-ai-app-22-pass.txt` and `server-auth-smoke-pass.txt`: final application
  integration and authentication smoke evidence.
- `server-scope-lcov.info`, `server-crapper-final.txt` and
  `server-dryer-final.txt`: measured quality scope.
- `server-mutator-final.txt` and `server-mutator-survivors.json`: observed counts
  and explicit survivor classifications.
- `account-server-source-sha256.json`: frozen owned source/test hashes and
  relevant shared dependencies, with scope labels.

The parent's final E2EE-only full-suite/build report is separate. An incomplete
or interrupted global run is not counted as a pass in this report. No iOS
compilation, live billing, live AI answer, real purchase or production grant is
claimed.
