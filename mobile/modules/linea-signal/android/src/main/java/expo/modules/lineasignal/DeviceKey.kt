package expo.modules.lineasignal

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The key this device's sessions are bound to (server: devicebind.js): ECDSA P-256 in the Android Keystore, which
 * never gives the private key out — a copy of the app's files or of its session token cannot sign with it.
 * StrongBox where the phone has it, else the trusted environment. Not tied to the screen lock: it has to sign while
 * the app refreshes in the background.
 */
object DeviceKey {
  private const val ALIAS = "invizent.device-key.v1"
  private const val STORE = "AndroidKeyStore"
  private val lock = Any()

  private fun store(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

  private fun create(strongBox: Boolean) {
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (strongBox && Build.VERSION.SDK_INT >= 28) spec.setIsStrongBoxBacked(true)
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(spec.build()) }.generateKeyPair()
  }

  private fun privateKey(): PrivateKey = synchronized(lock) {
    val keys = store()
    if (!keys.containsAlias(ALIAS)) {
      try { create(true) } catch (_: Exception) { create(false) }
    }
    store().getKey(ALIAS, null) as? PrivateKey ?: throw SignalFailure("DEVICE_KEY_UNAVAILABLE")
  }

  private fun inHardware(key: PrivateKey): Boolean = try {
    val info = KeyFactory.getInstance(key.algorithm, STORE).getKeySpec(key, KeyInfo::class.java)
    if (Build.VERSION.SDK_INT >= 31) info.securityLevel == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT || info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    else @Suppress("DEPRECATION") info.isInsideSecureHardware
  } catch (_: Exception) { false }

  private fun fixed(value: java.math.BigInteger): ByteArray {
    val bytes = value.toByteArray()
    val out = ByteArray(32)
    val take = minOf(32, bytes.size)
    System.arraycopy(bytes, bytes.size - take, out, 32 - take, take)
    return out
  }

  private fun base64url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  /** The public key as the server takes it: base64url of the 65-byte point 04 ‖ X ‖ Y. */
  fun ensure(): Map<String, String> {
    val key = privateKey()
    val public = store().getCertificate(ALIAS)?.publicKey as? ECPublicKey ?: throw SignalFailure("DEVICE_KEY_UNAVAILABLE")
    val point = byteArrayOf(4) + fixed(public.w.affineX) + fixed(public.w.affineY)
    return mapOf("publicKey" to base64url(point), "kind" to if (inHardware(key)) "hardware" else "software")
  }

  /** ECDSA over SHA-256 of the message's UTF-8 bytes, DER-encoded, base64url. */
  fun sign(message: String): String {
    val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(privateKey()); update(message.toByteArray(Charsets.UTF_8)) }.sign()
    return base64url(signature)
  }
}
