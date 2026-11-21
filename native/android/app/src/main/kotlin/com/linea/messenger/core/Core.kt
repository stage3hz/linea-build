package com.linea.messenger.core

import com.linea.core.json.JsonArray
import com.linea.core.json.JsonBool
import com.linea.core.json.JsonNull
import com.linea.core.json.JsonNumber
import com.linea.core.json.JsonObject
import com.linea.core.json.JsonString
import com.linea.core.json.JsonValue
import com.linea.messenger.auth.Account
import com.linea.messenger.net.attestKey

/** What the encryption service asks of the app in the middle of its work (see `Core.cryptoNew`): the private
 *  storage and the server. The three are called on the thread that called `Core.cryptoCall`, one at a time, and
 *  may block. The core finds them by these very names: they must not be renamed or stripped. */
interface CryptoHost {
  /** One record of the private storage; null when there is none. A throw stops the app: «no record» and
   *  «cannot tell» must not be confused. */
  fun vaultGet(key: String): String?
  /** Writes all of the changes or none: `[[key, value|null], …]`, null to remove. A throw stops the app. */
  fun vaultCommit(changesJson: String)
  /** The server. Answer: `{"ok":…}`, `{"network":"…"}` or `{"refused":"…"}`. */
  fun transport(method: String, argsJson: String): String
}

/** The shared core (Rust, native/core), as Kotlin sees it. The library is libinvizent_core.so, built by
 *  native/android/build-core.sh; the functions on its side are in native/core/src/jni.rs. */
object Core {
  /** False when the library is not in the app (a build made without build-core.sh): nothing of the core works. */
  val loaded: Boolean = try { System.loadLibrary("invizent_core"); true } catch (_: UnsatisfiedLinkError) { false }

  /** The version of the core, e.g. `0.1.0`. Throws UnsatisfiedLinkError without the library; see `version`. */
  @JvmStatic external fun coreVersion(): String

  /** The safety code for a pair of devices.
   *  In: `{"own":{"userId","deviceId","identityKey","registrationId"},"other":{…}}`. Out: the code, or null. */
  @JvmStatic external fun safetyCode(pairJson: String): String?

  /** The headers and the time limit of one request (`invizent_http_prepare`); null for a request it cannot read. */
  @JvmStatic external fun httpPrepare(requestJson: String): String?

  /** What the server's answer means (`invizent_http_read`). */
  @JvmStatic external fun httpRead(status: Int, body: String): String?

  /** The request of one server operation by its name (`invizent_api_call`); null for an unknown one. */
  @JvmStatic external fun apiCall(op: String, argsJson: String, deviceJson: String): String?

  /** One session's exchange of device proofs (`invizent_proof_new`); given back with `proofFree`. */
  @JvmStatic external fun proofNew(): Long

  /** One move of the exchange (`invizent_proof_call`); null for a handle of 0 or a move the core cannot read. */
  @JvmStatic external fun proofCall(handle: Long, inputJson: String): String?

  /** Ends the exchange. No call with the handle may be running, and none may follow. */
  @JvmStatic external fun proofFree(handle: Long)

  /** Makes the encryption service of the signed-in person; 0 if it could not be made. `host` is a `CryptoHost`,
   *  kept by the core until `cryptoFree`. */
  @JvmStatic external fun cryptoNew(userId: String, autoTrust: Boolean, host: Any): Long

  /** Runs one operation of the service: `{"ok":…}` or `{"error":{"name":…,"message":…}}`. The host's methods
   *  are called on this very thread before it returns. */
  @JvmStatic external fun cryptoCall(handle: Long, op: String, argsJson: String): String?

  /** Ends the service. No call with the handle may be running, and none may follow. */
  @JvmStatic external fun cryptoFree(handle: Long)

  /** The version of the core, or `?` when the library is missing. */
  val version: String get() = if (loaded) try { coreVersion() } catch (_: UnsatisfiedLinkError) { "?" } else "?"

  data class Device(val userId: String, val deviceId: String, val identityKey: String, val registrationId: Int)

  /** The code two people compare for a pair of devices; null if the pair is not valid. */
  fun safetyCode(own: Device, other: Device): String? {
    if (!loaded) return null
    fun json(device: Device) = JsonObject(linkedMapOf(
      "userId" to JsonString(device.userId), "deviceId" to JsonString(device.deviceId),
      "identityKey" to JsonString(device.identityKey), "registrationId" to JsonNumber(device.registrationId),
    ))
    return safetyCode(JsonObject(linkedMapOf("own" to json(own), "other" to json(other))).stringify())
  }

  // A JSON value in the app is plain Kotlin: Map<String, Any?>, List<Any?>, String, Double, Boolean, null.

  private fun tree(value: Any?): JsonValue? = when (value) {
    null -> JsonNull
    is Boolean -> JsonBool(value)
    is Number -> JsonNumber(value.toDouble())
    is String -> JsonString(value)
    is Map<*, *> -> {
      val fields = LinkedHashMap<String, JsonValue>()
      var whole = true
      for ((key, item) in value) { val made = tree(item); if (key is String && made != null) fields[key] = made else whole = false }
      if (whole) JsonObject(fields) else null
    }
    is List<*> -> value.map { tree(it) }.let { items -> if (items.any { it == null }) null else JsonArray(items.filterNotNull()) }
    else -> null
  }

  private fun plain(value: JsonValue): Any? = when (value) {
    JsonNull -> null
    is JsonBool -> value.value
    is JsonNumber -> value.value
    is JsonString -> value.value
    is JsonArray -> value.items.map { plain(it) }
    is JsonObject -> LinkedHashMap<String, Any?>().also { map -> for ((key, item) in value.fields) map[key] = plain(item) }
  }

  /** A JSON value as text; null when something in it is not JSON. */
  fun text(value: Any?): String? = tree(value)?.stringify()

  /** The value of a JSON text; null for no text or a text that is not JSON (a JSON `null` reads as null too). */
  fun value(text: String?): Any? = if (text == null) null else try { plain(JsonValue.parse(text)) } catch (_: Exception) { null }

  @Suppress("UNCHECKED_CAST")
  fun map(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

  class Prepared(val headers: List<Pair<String, String>>, val timeoutMs: Long)

  /** The headers and the time limit of one request. */
  fun prepare(method: String, path: String, jsonBody: Boolean, token: String?, proof: String? = null): Prepared? {
    if (!loaded) return null
    val request = linkedMapOf<String, Any?>("method" to method, "path" to path, "jsonBody" to jsonBody, "platform" to "android",
      "version" to Account.appVersion, "nowMs" to System.currentTimeMillis())
    if (attestKey.isNotEmpty()) request["attestKey"] = attestKey
    if (token != null) request["token"] = token
    if (proof != null) request["proof"] = proof
    val made = map(value(httpPrepare(text(request) ?: return null))) ?: return null
    val list = made["headers"] as? List<*> ?: return null
    val limit = (made["timeoutMs"] as? Number)?.toLong() ?: return null
    return Prepared(list.mapNotNull { pair -> (pair as? List<*>)?.takeIf { it.size == 2 }?.let { (it[0] as? String ?: return@let null) to (it[1] as? String ?: return@let null) } }, limit)
  }

  /** What the server's answer means (see `invizent_http_read`). */
  fun read(status: Int, body: String): Map<String, Any?> = if (loaded) map(value(httpRead(status, body))) ?: emptyMap() else emptyMap()

  class Call(val method: String, val path: String, val body: String?)

  /** The request of a server operation by its name: method, path and JSON body. */
  fun call(op: String, args: List<Any?>): Call? {
    if (!loaded) return null
    val made = map(value(apiCall(op, text(args) ?: return null, text(Account.deviceFields) ?: return null))) ?: return null
    return Call(made["method"] as? String ?: return null, made["path"] as? String ?: return null, made["body"] as? String)
  }
}
