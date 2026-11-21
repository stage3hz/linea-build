package com.linea.messenger.auth

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** The key this device's sessions are bound to (server: devicebind.js): ECDSA P-256 in the Android Keystore,
 *  which never gives the private key out — a copy of the app's files or of its session token cannot sign with it.
 *  StrongBox where the phone has it, else the trusted environment; where there is neither (some emulators) the
 *  key is the keystore's own, of this device only.
 *  It is not tied to a fingerprint or the screen lock: it has to sign while the app refreshes in the background.
 *
 *  The alias and the parameters are those of the previous app (its DeviceKey.kt), so an update finds the key its
 *  session is already bound to. */
object DeviceKey : DeviceProof.Key {
  class Failure(val reason: String) : Exception(reason)

  private const val ALIAS = "invizent.device-key.v1"
  private const val STORE = "AndroidKeyStore"
  private val lock = Any()

  private fun store(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

  private fun create(strongBox: Boolean) {
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
    if (strongBox) spec.setIsStrongBoxBacked(true)
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(spec.build()) }.generateKeyPair()
  }

  private fun key(): PrivateKey = synchronized(lock) {
    try {
      if (!store().containsAlias(ALIAS)) {
        // A phone without StrongBox refuses the first; the second is the trusted environment (or what the phone has).
        if (Build.VERSION.SDK_INT >= 28) { try { create(true) } catch (_: Exception) { create(false) } } else create(false)
      }
      store().getKey(ALIAS, null) as? PrivateKey
    } catch (_: Exception) { null } ?: throw Failure("DEVICE_KEY_UNAVAILABLE")
  }

  /** Whether the private key really is inside secure hardware, as the keystore itself says of this very key. */
  private fun inHardware(key: PrivateKey): Boolean = try {
    val info = KeyFactory.getInstance(key.algorithm, STORE).getKeySpec(key, KeyInfo::class.java)
    if (Build.VERSION.SDK_INT >= 31) when (info.securityLevel) {
      KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT, KeyProperties.SECURITY_LEVEL_STRONGBOX, KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> true
      else -> false
    } else @Suppress("DEPRECATION") info.isInsideSecureHardware
  } catch (_: Exception) { false }

  private fun fixed(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    val out = ByteArray(32)
    val take = minOf(32, bytes.size)
    System.arraycopy(bytes, bytes.size - take, out, 32 - take, take)
    return out
  }

  private fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  /** A public key as the server takes it: base64url of the 65-byte point 04 ‖ X ‖ Y. */
  internal fun point(public: ECPublicKey): String = base64url(byteArrayOf(4) + fixed(public.w.affineX) + fixed(public.w.affineY))

  /** ECDSA over SHA-256 of the message's UTF-8 bytes, DER-encoded, base64url. */
  internal fun signature(key: PrivateKey, message: String): String =
    base64url(Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(message.toByteArray(Charsets.UTF_8)) }.sign())

  /** The public key as the server takes it, and where the private one lives: `publicKey`, `kind`. */
  override fun ensure(): Map<String, String> {
    val key = key()
    val public = try { store().getCertificate(ALIAS)?.publicKey as? ECPublicKey } catch (_: Exception) { null } ?: throw Failure("DEVICE_KEY_UNAVAILABLE")
    return mapOf("publicKey" to point(public), "kind" to if (inHardware(key)) "hardware" else "software")
  }

  /** ECDSA over SHA-256 of the message's UTF-8 bytes, DER-encoded, base64url. */
  override fun sign(message: String): String {
    val key = key()
    return try { signature(key, message) } catch (_: Exception) { throw Failure("DEVICE_KEY_SIGN_FAILED") }
  }
}
