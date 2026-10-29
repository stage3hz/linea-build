package expo.modules.lineasignal

import org.json.JSONObject
import org.signal.libsignal.crypto.Aes256GcmSiv
import org.signal.libsignal.protocol.*
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.groups.state.SenderKeyRecord
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.kem.KEMPublicKey
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.*
import org.signal.libsignal.protocol.util.KeyHelper
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import java.util.Base64
import java.util.UUID

/** The core is shared by the Expo adapter and real JVM integration tests.
 * All protocol operations and key generation belong to official libsignal.
 * State is an opaque, sensitive value: the caller must commit it atomically to
 * its encrypted database before transmitting or acknowledging a message.
 * Nothing in this module writes to disk or logs input, keys, or plaintext. */
object SignalCore {
  const val VERSION = "0.106.0"
  const val MAX_STATE = 16 * 1024 * 1024
  const val MAX_MESSAGE = 1024 * 1024
  const val MAX_FILE = 20 * 1024 * 1024
  const val MAX_PREKEYS = 1000
  private const val MAX_AD = 64 * 1024

  fun createState(localAddressName: String, deviceId: Int): Map<String, Any> {
    address(localAddressName, deviceId)
    val identity = IdentityKeyPair.generate()
    val json = JSONObject().put("version", 1).put("libsignalVersion", VERSION)
      .put("localAddressName", localAddressName).put("localDeviceId", deviceId)
      .put("identityKeyPair", encode(identity.serialize()))
      .put("registrationId", KeyHelper.generateRegistrationId(false))
      .put("nextPreKeyId", 1).put("signedPreKeyId", 1).put("kyberPreKeyId", 1)
    listOf("preKeys", "signedPreKeys", "kyberPreKeys", "sessions", "trustedIdentities", "kyberUsed", "senderKeys").forEach { json.put(it, JSONObject()) }
    val store = StateStore(json)
    val timestamp = System.currentTimeMillis()
    val signed = ECKeyPair.generate()
    store.storeSignedPreKey(1, SignedPreKeyRecord(1, timestamp, signed, identity.privateKey.calculateSignature(signed.publicKey.serialize())))
    val kyber = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
    store.storeKyberPreKey(1, KyberPreKeyRecord(1, timestamp, kyber, identity.privateKey.calculateSignature(kyber.publicKey.serialize())))
    return generated(store, 20)
  }

  fun replenish(state: String, count: Int): Map<String, Any> = generated(StateStore.parse(state), count)

  private fun generated(store: StateStore, count: Int): Map<String, Any> {
    check(count in 1..100, "INVALID_PREKEY_COUNT")
    check(store.records("preKeys").length() + count <= MAX_PREKEYS, "PREKEY_CAPACITY")
    val first = store.json.getInt("nextPreKeyId")
    check(first in 1..(Int.MAX_VALUE - count), "PREKEY_ID_EXHAUSTED")
    val fresh = (first until first + count).map { id ->
      val record = PreKeyRecord(id, ECKeyPair.generate())
      store.storePreKey(id, record)
      mapOf("id" to id, "publicKey" to encode(record.keyPair.publicKey.serialize()))
    }
    store.json.put("nextPreKeyId", first + count)
    return mapOf("state" to store.export(), "bundle" to publicBundle(store, fresh))
  }

  private fun publicBundle(store: StateStore, fresh: List<Map<String, Any>>): Map<String, Any> {
    val signed = store.loadSignedPreKey(store.json.getInt("signedPreKeyId"))
    val kyber = store.loadKyberPreKey(store.json.getInt("kyberPreKeyId"))
    return mapOf(
      "registrationId" to store.localRegistrationId,
      "identityKey" to encode(store.identityKeyPair.publicKey.serialize()),
      "signedPreKey" to mapOf("id" to signed.id, "publicKey" to encode(signed.keyPair.publicKey.serialize()), "signature" to encode(signed.signature)),
      "kyberPreKey" to mapOf("id" to kyber.id, "publicKey" to encode(kyber.keyPair.publicKey.serialize()), "signature" to encode(kyber.signature)),
      "preKeys" to fresh
    )
  }

  fun trustIdentity(state: String, addressName: String, deviceId: Int, identityKey: String): Map<String, Any> {
    val store = StateStore.parse(state)
    val remote = address(addressName, deviceId)
    val identity = IdentityKey(decode(identityKey, 33).also { check(it.size == 33, "INVALID_IDENTITY") })
    store.pin(remote, identity)
    return mapOf("state" to store.export())
  }

  fun encrypt(state: String, addressName: String, deviceId: Int, plaintext: String, bundle: Map<String, Any?>?): Map<String, Any> {
    val store = StateStore.parse(state)
    val remote = address(addressName, deviceId)
    check(store.getIdentity(remote) != null, "TRUST_REQUIRED")
    val bytes = plaintext.toByteArray(Charsets.UTF_8)
    check(bytes.size <= MAX_MESSAGE, "MESSAGE_TOO_LARGE")
    if (bundle != null) {
      val preKeyBundle = remoteBundle(JSONObject(bundle), deviceId)
      check(store.isTrustedIdentity(remote, preKeyBundle.identityKey, IdentityKeyStore.Direction.SENDING), "IDENTITY_CHANGED")
      if (store.loadSession(remote)?.hasSenderChain(Instant.now()) != true) {
        SessionBuilder(store, remote, store.localAddress).process(preKeyBundle)
      }
    }
    val cipher = SessionCipher(store, store.localAddress, remote).encrypt(bytes)
    check(cipher.type == 2 || cipher.type == 3, "UNSUPPORTED_MESSAGE_TYPE")
    return mapOf("state" to store.export(), "type" to cipher.type, "body" to encode(cipher.serialize()))
  }

  fun decrypt(state: String, addressName: String, deviceId: Int, type: Int, body: String): Map<String, Any> {
    val store = StateStore.parse(state)
    val remote = address(addressName, deviceId)
    check(store.getIdentity(remote) != null, "TRUST_REQUIRED")
    val bytes = decode(body, MAX_MESSAGE + 64 * 1024)
    val cipher = SessionCipher(store, store.localAddress, remote)
    val plaintext = when (type) {
      2 -> cipher.decrypt(SignalMessage(bytes))
      3 -> cipher.decrypt(PreKeySignalMessage(bytes))
      else -> throw SignalFailure("UNSUPPORTED_MESSAGE_TYPE")
    }
    check(plaintext.size <= MAX_MESSAGE, "MESSAGE_TOO_LARGE")
    val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plaintext)).toString()
    return mapOf("state" to store.export(), "plaintext" to text)
  }

  private fun remoteBundle(json: JSONObject, deviceId: Int): PreKeyBundle {
    val registrationId = integer(json, "registrationId", 1, 16383)
    val signed = json.getJSONObject("signedPreKey")
    val kyber = json.getJSONObject("kyberPreKey")
    val oneTime = json.optJSONObject("preKey")
    val identity = decode(json.getString("identityKey"), 33).also { check(it.size == 33, "INVALID_IDENTITY") }
    fun ec(value: JSONObject): ECPublicKey = ECPublicKey(decode(value.getString("publicKey"), 33).also { check(it.size == 33, "INVALID_PUBLIC_KEY") })
    fun signature(value: JSONObject): ByteArray = decode(value.getString("signature"), 64).also { check(it.size == 64, "INVALID_SIGNATURE") }
    return PreKeyBundle(registrationId, deviceId, oneTime?.let { integer(it, "id") } ?: -1,
      oneTime?.let(::ec), integer(signed, "id"), ec(signed), signature(signed), IdentityKey(identity),
      integer(kyber, "id"), KEMPublicKey(decode(kyber.getString("publicKey"), 8192)), signature(kyber))
  }

  fun seal(plaintextBase64: String, keyBase64: String, nonceBase64: String, adBase64: String): String {
    val key = decode(keyBase64, 32).also { check(it.size == 32, "INVALID_KEY") }
    val nonce = decode(nonceBase64, 12).also { check(it.size == 12, "INVALID_NONCE") }
    return encode(Aes256GcmSiv(key).encrypt(decode(plaintextBase64, MAX_FILE), nonce, decode(adBase64, MAX_AD)))
  }
  fun open(cipherBase64: String, keyBase64: String, nonceBase64: String, adBase64: String): String {
    val key = decode(keyBase64, 32).also { check(it.size == 32, "INVALID_KEY") }
    val nonce = decode(nonceBase64, 12).also { check(it.size == 12, "INVALID_NONCE") }
    val cipher = decode(cipherBase64, MAX_FILE + 16).also { check(it.size >= 16, "INVALID_CIPHERTEXT") }
    return encode(Aes256GcmSiv(key).decrypt(cipher, nonce, decode(adBase64, MAX_AD)))
  }

  internal fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
  internal fun decode(text: String, limit: Int): ByteArray {
    check(text.length <= ((limit + 2) / 3) * 4 && text.length % 4 == 0, "INVALID_BASE64")
    val result = try { Base64.getDecoder().decode(text) } catch (_: IllegalArgumentException) { throw SignalFailure("INVALID_BASE64") }
    check(result.size <= limit && encode(result) == text, "INVALID_BASE64")
    return result
  }
  internal fun check(condition: Boolean, code: String) { if (!condition) throw SignalFailure(code) }
  internal fun integer(json: JSONObject, key: String, min: Int = 1, max: Int = Int.MAX_VALUE): Int {
    val value = json.get(key)
    check(value is Number, "INVALID_NUMBER")
    val number = (value as Number).toDouble()
    check(number.isFinite() && number >= min && number <= max && number == number.toInt().toDouble(), "INVALID_NUMBER")
    return number.toInt()
  }
  internal fun address(name: String, deviceId: Int): SignalProtocolAddress {
    check(deviceId == 1 && name.matches(Regex("[A-Za-z0-9._:-]{1,160}")), "INVALID_ADDRESS")
    return SignalProtocolAddress(name, deviceId)
  }
}

class SignalFailure(val reason: String) : Exception(reason)

/** Each SDK load returns a fresh deserialized record. Failed operations discard
 * this entire store; partially mutated state never escapes the native call. */
internal class StateStore(val json: JSONObject) : SignalProtocolStore {
  val localAddress = SignalCore.address(json.getString("localAddressName"), SignalCore.integer(json, "localDeviceId", 1, 1))
  private val identity = IdentityKeyPair(SignalCore.decode(json.getString("identityKeyPair"), 256))
  private val registration = SignalCore.integer(json, "registrationId", 1, 16383)

  init {
    SignalCore.check(json.getInt("version") == 1 && json.getString("libsignalVersion") == SignalCore.VERSION, "UNSUPPORTED_STATE")
    listOf("preKeys", "signedPreKeys", "kyberPreKeys", "sessions", "trustedIdentities", "kyberUsed", "senderKeys").forEach { records(it) }
    SignalCore.check(records("preKeys").length() <= SignalCore.MAX_PREKEYS, "PREKEY_CAPACITY")
    SignalCore.check(records("signedPreKeys").length() <= 64 && records("kyberPreKeys").length() <= 64, "KEY_CAPACITY")
    SignalCore.check(records("sessions").length() <= 10000 && records("trustedIdentities").length() <= 10000, "SESSION_CAPACITY")
    SignalCore.check(records("kyberUsed").length() <= 50000, "REPLAY_RECORD_CAPACITY")
  }
  companion object {
    fun parse(state: String): StateStore {
      SignalCore.check(state.length <= SignalCore.MAX_STATE, "STATE_TOO_LARGE")
      return StateStore(JSONObject(state))
    }
  }
  fun records(name: String): JSONObject = json.getJSONObject(name)
  fun export(): String = json.toString().also { SignalCore.check(it.length <= SignalCore.MAX_STATE, "STATE_TOO_LARGE") }
  private fun key(address: SignalProtocolAddress): String = "${address.name}#${address.deviceId}"
  private fun load(map: String, id: String, limit: Int = 65536): ByteArray? = records(map).optString(id, "").takeIf { it.isNotEmpty() }?.let { SignalCore.decode(it, limit) }
  private fun save(map: String, id: String, bytes: ByteArray, cap: Int) {
    val target = records(map)
    SignalCore.check(target.has(id) || target.length() < cap, "STATE_CAPACITY")
    target.put(id, SignalCore.encode(bytes))
  }
  fun pin(address: SignalProtocolAddress, identity: IdentityKey) {
    val old = getIdentity(address)
    SignalCore.check(old == null || old == identity, "IDENTITY_CHANGED")
    save("trustedIdentities", key(address), identity.serialize(), 10000)
  }
  override fun getIdentityKeyPair(): IdentityKeyPair = identity
  override fun getLocalRegistrationId(): Int = registration
  override fun saveIdentity(address: SignalProtocolAddress, identityKey: IdentityKey): IdentityKeyStore.IdentityChange {
    SignalCore.check(isTrustedIdentity(address, identityKey, IdentityKeyStore.Direction.SENDING), "IDENTITY_CHANGED")
    return IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED
  }
  override fun isTrustedIdentity(address: SignalProtocolAddress, identityKey: IdentityKey, direction: IdentityKeyStore.Direction): Boolean = getIdentity(address)?.let { it == identityKey } ?: false
  override fun getIdentity(address: SignalProtocolAddress): IdentityKey? = load("trustedIdentities", key(address), 33)?.let { IdentityKey(it) }
  override fun loadPreKey(preKeyId: Int): PreKeyRecord = load("preKeys", preKeyId.toString())?.let { PreKeyRecord(it) } ?: throw InvalidKeyIdException("Missing prekey")
  override fun storePreKey(preKeyId: Int, record: PreKeyRecord) = save("preKeys", preKeyId.toString(), record.serialize(), SignalCore.MAX_PREKEYS)
  override fun containsPreKey(preKeyId: Int): Boolean = records("preKeys").has(preKeyId.toString())
  override fun removePreKey(preKeyId: Int) { records("preKeys").remove(preKeyId.toString()) }
  override fun loadSignedPreKey(signedPreKeyId: Int): SignedPreKeyRecord = load("signedPreKeys", signedPreKeyId.toString())?.let { SignedPreKeyRecord(it) } ?: throw InvalidKeyIdException("Missing signed prekey")
  override fun loadSignedPreKeys(): MutableList<SignedPreKeyRecord> = records("signedPreKeys").keys().asSequence().map { loadSignedPreKey(it.toInt()) }.toMutableList()
  override fun storeSignedPreKey(signedPreKeyId: Int, record: SignedPreKeyRecord) = save("signedPreKeys", signedPreKeyId.toString(), record.serialize(), 64)
  override fun containsSignedPreKey(signedPreKeyId: Int): Boolean = records("signedPreKeys").has(signedPreKeyId.toString())
  override fun removeSignedPreKey(signedPreKeyId: Int) { records("signedPreKeys").remove(signedPreKeyId.toString()) }
  override fun loadKyberPreKey(kyberPreKeyId: Int): KyberPreKeyRecord = load("kyberPreKeys", kyberPreKeyId.toString())?.let { KyberPreKeyRecord(it) } ?: throw InvalidKeyIdException("Missing Kyber prekey")
  override fun loadKyberPreKeys(): MutableList<KyberPreKeyRecord> = records("kyberPreKeys").keys().asSequence().map { loadKyberPreKey(it.toInt()) }.toMutableList()
  override fun storeKyberPreKey(kyberPreKeyId: Int, record: KyberPreKeyRecord) = save("kyberPreKeys", kyberPreKeyId.toString(), record.serialize(), 64)
  override fun containsKyberPreKey(kyberPreKeyId: Int): Boolean = records("kyberPreKeys").has(kyberPreKeyId.toString())
  override fun markKyberPreKeyUsed(kyberPreKeyId: Int, signedPreKeyId: Int, baseKey: ECPublicKey) {
    loadKyberPreKey(kyberPreKeyId)
    val id = "$kyberPreKeyId:$signedPreKeyId:${SignalCore.encode(baseKey.serialize())}"
    val used = records("kyberUsed")
    if (used.has(id)) throw ReusedBaseKeyException()
    SignalCore.check(used.length() < 50000, "REPLAY_RECORD_CAPACITY")
    used.put(id, true) // Last-resort Kyber key stays, replay tuple survives persistence.
  }
  override fun loadSession(address: SignalProtocolAddress): SessionRecord? = load("sessions", key(address), SignalCore.MAX_MESSAGE)?.let { SessionRecord(it) }
  override fun loadExistingSessions(addresses: MutableList<SignalProtocolAddress>): MutableList<SessionRecord> = addresses.map { loadSession(it) ?: throw NoSessionException(it, "Missing session") }.toMutableList()
  override fun getSubDeviceSessions(name: String): MutableList<Int> = mutableListOf() // This bridge fixes numeric deviceId to 1; UUID is part of name.
  override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) = save("sessions", key(address), record.serialize(), 10000)
  override fun containsSession(address: SignalProtocolAddress): Boolean = records("sessions").has(key(address))
  override fun deleteSession(address: SignalProtocolAddress) { records("sessions").remove(key(address)) }
  override fun deleteAllSessions(name: String) { records("sessions").remove("$name#1") }
  override fun storeSenderKey(sender: SignalProtocolAddress, distributionId: UUID, record: SenderKeyRecord) = save("senderKeys", "${key(sender)}:$distributionId", record.serialize(), 10000)
  override fun loadSenderKey(sender: SignalProtocolAddress, distributionId: UUID): SenderKeyRecord? = load("senderKeys", "${key(sender)}:$distributionId")?.let { SenderKeyRecord(it) }
}
