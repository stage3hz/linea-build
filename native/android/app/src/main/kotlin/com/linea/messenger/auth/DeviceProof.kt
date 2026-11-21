package com.linea.messenger.auth

import com.linea.messenger.core.Core

/** The proof that a session is used on the device it was bound to.
 *
 *  At sign-in the session is bound to a key that lives in this phone's secure chip and never leaves it; from then
 *  on the server asks for a short-lived proof signed with that key. A copied session token is useless on another
 *  device. The rules of the exchange are the core's; this class only carries its steps out.
 *  The proof is kept in memory only (inside the core) and is never written anywhere. */
class DeviceProof(private val key: Key = DeviceKey) {
  /** The device's key, as the exchange needs it (`DeviceKey` on a phone). Both throw when the key cannot do it. */
  interface Key {
    /** `publicKey` (base64url of the 65-byte point 04 ‖ X ‖ Y) and `kind` (`hardware` or `software`). */
    fun ensure(): Map<String, String>
    /** ECDSA over SHA-256 of the message's UTF-8 bytes, DER-encoded, base64url. */
    fun sign(message: String): String
  }

  enum class Outcome { OK, LOST, FAILED }

  private var handle = if (Core.loaded) Core.proofNew() else 0L
  private val exchange = Any()
  /** Sends one request of the exchange: path, JSON body → the server's answer as `Core.read` gives it, null when none came. */
  @Volatile var post: ((String, String?) -> Map<String, Any?>?)? = null

  /** The core's side is given back with the object. A move in progress holds the object, so this never runs under one. */
  protected fun finalize() { synchronized(this) { if (handle != 0L) Core.proofFree(handle); handle = 0L } }

  private fun call(input: Map<String, Any?>): Map<String, Any?> {
    val text = Core.text(input + ("now" to System.currentTimeMillis())) ?: return emptyMap()
    return synchronized(this) { if (handle == 0L) null else Core.map(Core.value(Core.proofCall(handle, text))) } ?: emptyMap()
  }

  private val state: Map<String, Any?> get() = call(mapOf("op" to "state"))
  /** The proof to send with a request, if one is held and still good. */
  val current: String? get() = state["proof"] as? String
  val generation: Int get() = (state["generation"] as? Number)?.toInt() ?: 0
  /** Whether a request should first wait for a fresh proof / whether this session is known to need one. */
  val due: Boolean get() = state["due"] as? Boolean ?: false
  val known: Boolean get() = state["known"] as? Boolean ?: false

  private fun has(): Map<String, String>? = try { key.ensure() } catch (_: Exception) { null }

  /** Gets a proof (binding the session first, if it has no key yet). Waits for the answer: never on the main thread.
   *  `force`: the server has just refused the proof we hold; `seen`: the generation when that request left. */
  fun ensure(force: Boolean, seen: Int? = null): Outcome = synchronized(exchange) {
    var step = call(mapOf("op" to "refresh", "force" to force, "seen" to seen))
    repeat(12) {
      if (step["refresh"] != null) return Outcome.OK
      val done = step["done"] as? String
      if (done != null) return if (done == "held" || done == "notUsed") Outcome.OK else if (done == "lost") Outcome.LOST else Outcome.FAILED
      val request = Core.map(step["post"])
      val path = request?.get("path") as? String
      val message = Core.map(step["sign"])?.get("message") as? String
      if (request != null && path != null) {
        val body = request["body"]?.let { Core.text(it) }
        val hasKey = has() != null
        val answer = post?.invoke(path, body)
        val refused = Core.map(answer?.get("refused"))
        step = if (answer != null && answer.containsKey("ok")) call(mapOf("op" to "reply", "hasKey" to hasKey, "ok" to answer["ok"]))
        else if (refused != null) call(mapOf("op" to "reply", "hasKey" to hasKey, "refused" to mapOf("status" to (refused["status"] ?: 0), "code" to (refused["code"] ?: ""))))
        else call(mapOf("op" to "reply", "hasKey" to hasKey, "failed" to true))
      } else if (message != null) {
        val signature = try { key.sign(message) } catch (_: Exception) { null }
        val held = if (signature != null) has() else null
        val publicKey = held?.get("publicKey"); val kind = held?.get("kind")
        step = if (signature != null && publicKey != null && kind != null) call(mapOf("op" to "signed", "signature" to signature, "publicKey" to publicKey, "kind" to kind))
        else call(mapOf("op" to "signed", "failed" to true, "keyChanged" to false))
      } else {
        return Outcome.FAILED
      }
    }
    Outcome.FAILED
  }
}
