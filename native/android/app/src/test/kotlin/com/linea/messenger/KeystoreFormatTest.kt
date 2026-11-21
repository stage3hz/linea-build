package com.linea.messenger

import android.content.Context
import android.util.Base64
import com.linea.messenger.storage.Keystore
import com.linea.messenger.storage.KeystoreError
import com.linea.messenger.storage.Vault
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The app installed over the previous one (same package) must open the secrets that app kept, and that app must
 *  still open what this one writes. The previous app kept them through expo-secure-store 57; the two functions
 *  below are that library's own writing and reading, line by line
 *  (mobile/node_modules/expo-secure-store/android/src/main/java/expo/modules/securestore/encryptors/AESEncryptor.kt:
 *  createEncryptedItemWithCipher, decryptItem; SecureStoreModule.kt: saveEncryptedItem, createKeychainAwareKey,
 *  readJSONEncodedItem). The keystore itself is not on the JVM: a software AES key stands in for its key. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KeystoreFormatTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private fun aesKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  /** expo-secure-store 57 writing `value` with no options (keychainService `key_v1`, no authentication). */
  private fun libraryWrites(secret: SecretKey, value: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secret)
    val gcmSpec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
    val ciphertextBytes = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
    val encryptedItem = JSONObject()
      .put("ct", Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP))
      .put("iv", Base64.encodeToString(gcmSpec.iv, Base64.NO_WRAP))
      .put("tlen", gcmSpec.tLen)
    encryptedItem.put("scheme", "aes")
    encryptedItem.put("usesKeystoreSuffix", true)
    encryptedItem.put("keystoreAlias", "key_v1")
    encryptedItem.put("requireAuthentication", false)
    return encryptedItem.toString()
  }

  /** expo-secure-store 57 reading an item: which keystore key, then AESEncryptor.decryptItem. */
  private fun libraryReads(keyFor: (String) -> SecretKey, text: String): String {
    val encryptedItem = JSONObject(text)
    assertEquals("aes", encryptedItem.optString("scheme"))
    val requireAuthentication = encryptedItem.optBoolean("requireAuthentication", false)
    val usesKeystoreSuffix = encryptedItem.optBoolean("usesKeystoreSuffix", false)
    val alias = if (usesKeystoreSuffix) "AES/GCM/NoPadding:key_v1:" + (if (requireAuthentication) "keystoreAuthenticated" else "keystoreUnauthenticated") else "AES/GCM/NoPadding:key_v1"
    val gcmSpec = GCMParameterSpec(encryptedItem.getInt("tlen"), Base64.decode(encryptedItem.getString("iv"), Base64.DEFAULT))
    assertTrue(encryptedItem.getInt("tlen") >= 96)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, keyFor(alias), gcmSpec)
    return String(cipher.doFinal(Base64.decode(encryptedItem.getString("ct"), Base64.DEFAULT)), StandardCharsets.UTF_8)
  }

  @Test fun theNamesAreTheLibrarys() {
    assertEquals("SecureStore", Keystore.PREFERENCES)
    assertEquals("key_v1-linea.session.v1", Keystore.entry("linea.session.v1"))
    assertEquals("key_v1-linea.passcode.v1", Keystore.entry("linea.passcode.v1"))
    assertEquals("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated", Keystore.ALIAS)
    assertEquals("AES/GCM/NoPadding:key_v1", Keystore.OLD_ALIAS)
    val scope = Vault.scope("https://api.invizent.com", "00000000-0000-4000-8000-00000000c0de")
    assertEquals("key_v1-linea.e2ee.v1.d861a9301dc1bf7ce549649b946fb099185eab2ee6c331affc75ef99299d261c", Keystore.entry(Vault.keyName(scope)))
    // The earlier address the same account may have its storage under (mobile/src/serverConfig.ts LEGACY_SERVER_URLS).
    assertEquals("ff13a42bb0406be8e6f2918db450bf8830d573285619c3ad07f0e94645c2d685", Vault.scope("https://141-133-194-51.nip.io", "00000000-0000-4000-8000-00000000c0de"))
  }

  @Test fun whatTheLibraryWroteIsReadHere() {
    val secret = aesKey()
    val vaultKey = "0123456789abcdef".repeat(4)
    val text = libraryWrites(secret, vaultKey)
    assertEquals(Keystore.ALIAS, Keystore.aliasOf(text))
    assertEquals(vaultKey, Keystore.open(secret, text))
    // A session token with every kind of character the server may give.
    val token = "eyJhbGciOi.J9-_~+/=ä€😀"
    assertEquals(token, Keystore.open(secret, libraryWrites(secret, token)))
  }

  @Test fun whatIsWrittenHereTheLibraryReads() {
    val secret = aesKey()
    val sealed = Keystore.seal(secret, "secret-ä-😀")
    val item = JSONObject(sealed)
    assertEquals(setOf("ct", "iv", "tlen", "scheme", "usesKeystoreSuffix", "keystoreAlias", "requireAuthentication"), item.keys().asSequence().toSet())
    assertEquals("key_v1", item.getString("keystoreAlias"))
    assertEquals(128, item.getInt("tlen"))
    assertFalse(item.getString("ct").contains("\n"))
    assertEquals("secret-ä-😀", libraryReads({ alias -> assertEquals(Keystore.ALIAS, alias); secret }, sealed))
    // A fresh IV every time.
    assertFalse(JSONObject(Keystore.seal(secret, "x")).getString("iv") == JSONObject(Keystore.seal(secret, "x")).getString("iv"))
  }

  @Test fun anEntryOfTheLibrarysFirstVersionsUsesItsOldKey() {
    val secret = aesKey()
    val old = JSONObject(libraryWrites(secret, "old")).apply { remove("usesKeystoreSuffix"); remove("keystoreAlias"); remove("requireAuthentication") }.toString()
    assertEquals(Keystore.OLD_ALIAS, Keystore.aliasOf(old))
    assertEquals("old", Keystore.open(secret, old))
  }

  @Test fun anEntryBehindAuthenticationOrDamagedIsNeverTakenForNone() {
    val secret = aesKey()
    val behind = JSONObject(libraryWrites(secret, "x")).put("requireAuthentication", true).toString()
    try { Keystore.open(secret, behind); fail() } catch (_: KeystoreError) {}
    val short = JSONObject(libraryWrites(secret, "x")).put("tlen", 64).toString()
    try { Keystore.open(secret, short); fail() } catch (_: KeystoreError) {}
    try { Keystore.open(aesKey(), libraryWrites(secret, "x")); fail() } catch (_: KeystoreError) { fail() } catch (_: Exception) { /* a wrong key: the caller reports «cannot read» */ }
  }

  @Test fun theEntryIsFoundWhereTheLibraryKeepsIt() {
    val kept = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
    kept.edit().clear().commit()
    assertNull(Keystore.stored(Keystore.preferences(context), "linea.session.v1"))
    kept.edit().putString("linea.session.v1", "bare").commit()
    assertEquals("bare", Keystore.stored(Keystore.preferences(context), "linea.session.v1"))     // the oldest versions' place
    kept.edit().putString("key_v1-linea.session.v1", "current").commit()
    assertEquals("current", Keystore.stored(Keystore.preferences(context), "linea.session.v1"))  // the current place first
    Keystore.remove(context, "linea.session.v1")
    assertNull(Keystore.stored(Keystore.preferences(context), "linea.session.v1"))
  }

  @Test fun theStorageFileIsWhereExpoSqliteKeepsIt() {
    // expo-sqlite 57 (android SQLiteModule.kt): defaultDatabaseDirectory = filesDir.canonicalPath + "/SQLite".
    val scope = Vault.scope("https://api.invizent.com", "00000000-0000-4000-8000-00000000c0de")
    val expected = File(context.filesDir.canonicalPath + File.separator + "SQLite", "linea-e2ee-$scope.db")
    assertEquals(expected.canonicalPath, Vault.file(context, scope).canonicalPath)
  }
}
