package com.linea.messenger.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The keystore could not give or keep a secret; `reason` says which step failed and never holds the secret. */
class KeystoreError(val reason: String, cause: Throwable? = null) : Exception(reason, cause)

/** Small secrets of the app: each is encrypted with a key that lives in the system's keystore (AES-256-GCM, the
 *  key never leaves the keystore) and kept as text in the app's private preferences.
 *
 *  The entries are kept exactly where and how the previous app kept them (expo-secure-store 57: preferences
 *  `SecureStore`, the entry `key_v1-<name>`, the keystore key `AES/GCM/NoPadding:key_v1:keystoreUnauthenticated`,
 *  a JSON envelope with `ct`, `iv`, `tlen`), so an update finds the keys of the storage that is already on the
 *  phone — and what is written here can be read by that app as well. They never leave this device. */
object Keystore {
  private const val PREFERENCES = "SecureStore"
  private const val SERVICE = "key_v1"
  private const val PROVIDER = "AndroidKeyStore"
  private const val CIPHER = "AES/GCM/NoPadding"
  /** The key of entries that need no fingerprint or screen lock to be read: the only kind this app writes. */
  private const val ALIAS = "$CIPHER:$SERVICE:keystoreUnauthenticated"
  /** The key of entries written by the first versions of the library, before there were two kinds. */
  private const val OLD_ALIAS = "$CIPHER:$SERVICE"

  private fun preferences(context: Context) = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private fun entry(name: String) = "$SERVICE-$name"

  private fun key(alias: String, make: Boolean): SecretKey? {
    val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
    (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    if (!make) return null
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setUserAuthenticationRequired(false).build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply { init(spec) }.generateKey()
  }

  /** The text kept under `name`; null when there is none. Throws when it is there but cannot be read (the
   *  keystore's key is gone or does not fit): «no secret» and «cannot tell» must not be confused — the first
   *  makes a new key. Nothing is removed in either case. */
  fun get(context: Context, name: String): String? {
    val kept = preferences(context)
    // The second place is where versions of the library before the two kinds of keys wrote.
    val text = kept.getString(entry(name), null) ?: kept.getString(name, null) ?: return null
    try {
      val item = JSONObject(text)
      if (item.optString("scheme") != "aes") throw KeystoreError("unknown scheme")
      if (item.optBoolean("requireAuthentication", false)) throw KeystoreError("needs authentication")
      val bits = item.getInt("tlen")
      if (bits < 96) throw KeystoreError("short tag")
      val secret = key(if (item.optBoolean("usesKeystoreSuffix", false)) ALIAS else OLD_ALIAS, make = false) ?: throw KeystoreError("no keystore key")
      val cipher = Cipher.getInstance(CIPHER)
      cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(bits, Base64.decode(item.getString("iv"), Base64.DEFAULT)))
      return String(cipher.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT)), Charsets.UTF_8)
    } catch (error: KeystoreError) {
      throw error
    } catch (error: Exception) {
      // Only the kind of the failure is kept: a message of the system may quote what it was given.
      throw KeystoreError("cannot read (${error.javaClass.simpleName})")
    }
  }

  fun set(context: Context, name: String, value: String) {
    try {
      val secret = key(ALIAS, make = true) ?: throw KeystoreError("no keystore key")
      val cipher = Cipher.getInstance(CIPHER)
      // The keystore chooses a new random IV for every write.
      cipher.init(Cipher.ENCRYPT_MODE, secret)
      val spec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
      val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      val item = JSONObject()
        .put("ct", Base64.encodeToString(sealed, Base64.NO_WRAP)).put("iv", Base64.encodeToString(spec.iv, Base64.NO_WRAP)).put("tlen", spec.tLen)
        .put("scheme", "aes").put("usesKeystoreSuffix", true).put("keystoreAlias", SERVICE).put("requireAuthentication", false)
      // `commit`, not `apply`: the caller goes on only when the secret is really on the disk.
      if (!preferences(context).edit().putString(entry(name), item.toString()).remove(name).commit()) throw KeystoreError("cannot write")
    } catch (error: KeystoreError) {
      throw error
    } catch (error: Exception) {
      throw KeystoreError("cannot write (${error.javaClass.simpleName})")
    }
  }

  fun remove(context: Context, name: String) {
    preferences(context).edit().remove(entry(name)).remove(name).commit()
  }
}
