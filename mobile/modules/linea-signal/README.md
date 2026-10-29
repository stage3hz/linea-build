# Linea Signal native module

This local Expo module links **official libsignal 0.106.0**. It implements protocol stores and a narrow bridge; it does not implement cryptographic primitives or a replacement Signal protocol. Android uses `org.signal:libsignal-client` plus `org.signal:libsignal-android` from Signal's Maven repository. iOS uses the official `LibSignalClient` pod at Git tag `v0.106.0` and the release's pinned FFI archive checksum.

## Contract and ownership

`index.ts` defines the public types. The native module name is `LineaSignal`.

- `createState(localAddressName, deviceId)` creates the identity, 20 classical one-time prekeys, one signed classical prekey, and one signed last-resort Kyber prekey.
- `replenish(state, count)` retains older private prekeys and returns **only newly generated public prekeys** in `bundle.preKeys`.
- `trustIdentity(state, addressName, deviceId, identityKeyBase64)` pins a key after the application's explicit verification gate. An already pinned different identity is rejected. Both sending and receiving reject missing trust.
- `encrypt(state, addressName, deviceId, plaintext, bundle?)` returns `{state, type: 2 | 3, body}`. A remote bundle has one optional `preKey`, not a `preKeys` array.
- `decrypt(state, addressName, deviceId, type, body)` returns `{state, plaintext}`. Plaintext is UTF-8 text; ciphertext is canonical standard base64.
- `seal(plaintextBase64, keyBase64, nonceBase64, adBase64)` and `open(cipherBase64, keyBase64, nonceBase64, adBase64)` call official `Aes256GcmSiv` and return base64 strings. The caller generates the 32-byte key and 12-byte nonce with the OS-backed random API.

Protocol `deviceId` is always **1**. The actual account UUID and device UUID form the address name, `userUUID.deviceUUID`. The local address is fixed when state is created and has no mutation method.

Every operation starts with an isolated in-memory store. Failed operations return no updated state. Record loads deserialize copies, so SDK mutation cannot change persisted records without a store operation. The module has no shared mutable protocol store, file cache, temporary plaintext file, or logging of arguments and results.

**The returned `state` contains private keys.** Treat it as opaque. The application must serialize access to its own state and commit the updated state plus the corresponding message atomically in its encrypted database before sending/acknowledging it. The module intentionally does not write to disk. The module cannot enforce caller transaction ordering.

The app must separately authenticate and validate chat ID, message ID, sender/recipient account IDs, and sender/recipient device IDs inside its encrypted payload. Passing a protocol address does not make an arbitrary application envelope authenticated.

## Limits

| Boundary | Limit |
| --- | --- |
| Pending classical private prekeys | 1,000; exhaustion rejects without deleting delayed keys |
| One replenishment | 1–100 new prekeys |
| Serialized state | 16 MiB |
| Plaintext protocol message | 1 MiB UTF-8 |
| File plaintext | 20 MiB, plus 16-byte authentication tag in ciphertext |
| File associated data | 64 KiB |
| Sessions / trusted identities | 10,000 each |
| Retained last-resort Kyber replay tuples | 50,000; exhaustion rejects |

Consuming a classical one-time key removes that private key. Consuming a last-resort Kyber key retains the key and records `(kyberPreKeyId, signedPreKeyId, senderBaseKey)`. Those replay records survive serialization. No age-based purge or long-term signed/Kyber key rotation is implemented by this minimal bridge.

## Build

Android requires JDK 21, Android SDK 36, and minimum Android API **26**. The app config includes `./plugins/withLineSignal`, which adds the official Maven repository, Java/Kotlin 17 wrapper targets compatible with React Native, JDK 21 for the Signal dependency, desugaring, and desktop JNI resource exclusions. It also pins the iOS pod and FFI checksum. Existing SQLCipher and manifest configuration is preserved.

After dependencies are installed:

```sh
npx expo prebuild --platform android --no-install
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=2
```

The JVM suite compiles the **same `SignalCore.kt`** as the Android module:

```sh
./gradlew -p ../modules/linea-signal/jvm-tests test interopClasspath
```

`jvm-tests/build/interop-classpath.txt` provides the classpath for the test-only `expo.modules.lineasignal.SignalInteropKt` JSON-lines driver. This driver is under test sources and is not included in the APK. It intentionally exchanges generated test state over stdin/stdout for interoperability tests; production code never logs this state.

## Verified and unverified

The JVM suite verifies two-way Signal sessions, ratchet persistence, replay and tamper rejection, explicit identity trust, identity changes, prekey signatures, retained Kyber replay records, delayed classical keys after replenishment, key-pool capacity, and AES-GCM-SIV authentication.

The separate Node interoperability test exercises the native Kotlin core against official Node libsignal 0.106.0, including out-of-order delivery and equal AES-GCM-SIV outputs across languages.

The Swift implementation follows the matching official 0.106.0 interfaces. **An iOS/Xcode build and on-device tests are still required**; a Linux source review is not an iOS build. Expo Go cannot load this custom module. A missing native module must fail closed; the web app must not claim this module is available.
