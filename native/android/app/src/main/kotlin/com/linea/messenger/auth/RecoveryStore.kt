package com.linea.messenger.auth

import android.content.Context
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.storage.Keystore
import com.linea.messenger.storage.KeystoreError

/** The server's permission to set a new password after the waiting period: a short-lived credential. */
class RecoveryGrant private constructor(val resetToken: String, val requestId: String, val readyAt: String, val expiresAt: String, val serverTime: String) {
  val readyMs: Double get() = ms(readyAt) ?: 0.0
  val expiresMs: Double get() = ms(expiresAt) ?: 0.0
  val serverMs: Double get() = ms(serverTime) ?: 0.0

  val fields: Map<String, Any?>
    get() = linkedMapOf("resetToken" to resetToken, "requestId" to requestId, "readyAt" to readyAt, "expiresAt" to expiresAt, "serverTime" to serverTime)

  /** The same permission with the times the server gave later; null unless each of them is a time. */
  fun updated(readyAt: String, expiresAt: String, serverTime: String): RecoveryGrant? =
    if (ms(readyAt) == null || ms(expiresAt) == null || ms(serverTime) == null) null else RecoveryGrant(resetToken, requestId, readyAt, expiresAt, serverTime)

  companion object {
    /** Milliseconds since 1970 of a date as the server writes it (`2026-11-21T07:00:00.000Z`); null when it is not one. */
    fun ms(text: String?): Double? = Messenger.date(text)?.toEpochMilli()?.toDouble()

    /** Read from a server answer or from what was kept; null unless every part is there and well-formed. */
    fun from(value: Any?): RecoveryGrant? {
      val fields = Core.map(value) ?: return null
      val token = (fields["resetToken"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
      val request = (fields["requestId"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
      val ready = (fields["readyAt"] as? String)?.takeIf { ms(it) != null } ?: return null
      val expires = (fields["expiresAt"] as? String)?.takeIf { ms(it) != null } ?: return null
      val server = (fields["serverTime"] as? String)?.takeIf { ms(it) != null } ?: return null
      return RecoveryGrant(token, request, ready, expires, server)
    }
  }
}

/** The pending recovery request, kept so that the waiting period survives closing the app
 *  (`mobile/src/auth/recoveryStorage.ts`): in the keystore under the name and in the form the previous app used
 *  (see `Keystore`), so a request started there is picked up here. On this device only. Never in settings,
 *  addresses or logs. */
object RecoveryStore {
  private const val NAME = "linea.recovery.pending.v1"

  class Saved(val base: String, val username: String, val grant: RecoveryGrant)

  /** What a kept text says; null when it is not a request in the form the previous app wrote. */
  fun decode(raw: String?): Saved? {
    val value = Core.map(Core.value(raw)) ?: return null
    if ((value["version"] as? Number)?.toDouble() != 1.0) return null
    val base = (value["base"] as? String)?.takeIf { it.length <= 512 } ?: return null
    val username = (value["username"] as? String)?.takeIf { it == AuthRules.name(it) && AuthRules.validName(it) } ?: return null
    val grant = RecoveryGrant.from(value["challenge"]) ?: return null
    if (grant.requestId.length > 128 || grant.expiresMs <= grant.readyMs) return null
    // The token is 43 symbols of the URL-safe base64 alphabet.
    val token = grant.resetToken
    if (token.length != 43 || !token.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-' }) return null
    return Saved(base, username, grant)
  }

  /** The text that is kept; null when the request is not one that `decode` would take back. */
  fun encode(base: String, username: String, grant: RecoveryGrant): String? {
    val raw = Core.text(linkedMapOf("version" to 1, "base" to base, "username" to username, "challenge" to grant.fields)) ?: return null
    return if (decode(raw) != null) raw else null
  }

  /** The request kept for this server; null when there is none. What is kept but cannot be understood is removed.
   *  Throws `KeystoreError` when the keystore cannot be read at all. */
  fun read(context: Context, base: String): Saved? {
    val raw = Keystore.get(context, NAME)
    val saved = decode(raw)
    if (raw != null && saved == null) Keystore.remove(context, NAME)
    return saved?.takeIf { it.base == base }
  }

  /** Throws `KeystoreError` when the request could not be kept. */
  fun save(context: Context, base: String, username: String, grant: RecoveryGrant) {
    val raw = encode(base, username, grant) ?: throw KeystoreError("not a recovery request")
    Keystore.set(context, NAME, raw)
  }

  /** Removes the request kept for this server — only the one with `resetToken` when it is given. */
  fun clear(context: Context, base: String, resetToken: String? = null) {
    val raw = try { Keystore.get(context, NAME) } catch (_: Exception) { return }
    val saved = decode(raw) ?: return
    if (saved.base != base) return
    if (resetToken != null && saved.grant.resetToken != resetToken) return
    Keystore.remove(context, NAME)
  }
}
