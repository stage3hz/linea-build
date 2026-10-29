package expo.modules.lineasignal

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class SignalCoreTest {
  private val alice = "11111111-1111-4111-8111-111111111111.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  private val bob = "22222222-2222-4222-8222-222222222222.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  private fun state(result: Map<String, Any>) = result["state"] as String
  @Suppress("UNCHECKED_CAST")
  private fun bundle(result: Map<String, Any>) = result["bundle"] as Map<String, Any>
  @Suppress("UNCHECKED_CAST")
  private fun remote(result: Map<String, Any>): Map<String, Any?> = bundle(result).toMutableMap().also {
    it["preKey"] = (it.remove("preKeys") as List<Map<String, Any>>).first()
  }
  private fun pin(state: String, name: String, result: Map<String, Any>) = state(SignalCore.trustIdentity(state, name, 1, bundle(result)["identityKey"] as String))
  private inline fun rejects(body: () -> Unit) { try { body(); fail("Operation must reject") } catch (_: Exception) {} }
  private fun altered(base64: String): String {
    val bytes = Base64.getDecoder().decode(base64);bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
    return Base64.getEncoder().encodeToString(bytes)
  }

  @Test fun roundTripRatchetAndPersistedReplayProtection() {
    val a = SignalCore.createState(alice, 1);val b = SignalCore.createState(bob, 1)
    var aState = pin(state(a), bob, b);var bState = pin(state(b), alice, a)
    val first = SignalCore.encrypt(aState, bob, 1, "Привет, Signal 👋", remote(b));aState = state(first)
    assertEquals(3, first["type"])
    val received = SignalCore.decrypt(bState, alice, 1, 3, first["body"] as String);bState = state(received)
    assertEquals("Привет, Signal 👋", received["plaintext"])
    val stored = JSONObject(bState)
    assertEquals(19, stored.getJSONObject("preKeys").length())
    assertEquals(1, stored.getJSONObject("kyberPreKeys").length())
    assertEquals(1, stored.getJSONObject("kyberUsed").length())
    rejects { SignalCore.decrypt(bState, alice, 1, 3, first["body"] as String) }
    val reply = SignalCore.encrypt(bState, alice, 1, "Ответ после сохранения", null);bState = state(reply)
    val receivedReply = SignalCore.decrypt(aState, bob, 1, reply["type"] as Int, reply["body"] as String);aState = state(receivedReply)
    assertEquals("Ответ после сохранения", receivedReply["plaintext"])
    val next = SignalCore.encrypt(aState, bob, 1, "Следующий шаг ratchet", null)
    assertEquals("Следующий шаг ratchet", SignalCore.decrypt(bState, alice, 1, next["type"] as Int, next["body"] as String)["plaintext"])
  }

  @Test fun tamperedMessageDoesNotConsumeValidState() {
    val a = SignalCore.createState(alice, 1);val b = SignalCore.createState(bob, 1)
    val aState = pin(state(a), bob, b);val bState = pin(state(b), alice, a)
    val message = SignalCore.encrypt(aState, bob, 1, "authenticated", remote(b))
    rejects { SignalCore.decrypt(bState, alice, 1, message["type"] as Int, altered(message["body"] as String)) }
    assertEquals("authenticated", SignalCore.decrypt(bState, alice, 1, message["type"] as Int, message["body"] as String)["plaintext"])
  }

  @Test fun explicitIdentityTrustAndChangedKeyAreEnforced() {
    val a = SignalCore.createState(alice, 1);val b = SignalCore.createState(bob, 1);val changedB = SignalCore.createState(bob, 1)
    rejects { SignalCore.encrypt(state(a), bob, 1, "blocked", remote(b)) }
    val aState = pin(state(a), bob, b)
    assertEquals(aState, pin(aState, bob, b))
    rejects { pin(aState, bob, changedB) }
    rejects { SignalCore.encrypt(aState, bob, 1, "blocked changed identity", remote(changedB)) }
    val encrypted = SignalCore.encrypt(aState, bob, 1, "requires receiver trust", remote(b))
    rejects { SignalCore.decrypt(state(b), alice, 1, encrypted["type"] as Int, encrypted["body"] as String) }
  }

  @Test fun signaturesRejectTamperAndKyberReplayCannotMoveToAnotherAddress() {
    val a = SignalCore.createState(alice, 1);val b = SignalCore.createState(bob, 1)
    val aState = pin(state(a), bob, b)
    val invalid = JSONObject(remote(b));val signed = invalid.getJSONObject("signedPreKey")
    signed.put("signature", altered(signed.getString("signature")))
    rejects { SignalCore.encrypt(aState, bob, 1, "bad signature", invalid.toMap()) }
    val message = SignalCore.encrypt(aState, bob, 1, "last-resort Kyber replay", remote(b).filterKeys { it != "preKey" })
    val received = SignalCore.decrypt(pin(state(b), alice, a), alice, 1, message["type"] as Int, message["body"] as String)
    assertEquals("last-resort Kyber replay", received["plaintext"])
    val wrongName = "33333333-3333-4333-8333-333333333333.cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    val bState = pin(state(received), wrongName, a)
    rejects { SignalCore.decrypt(bState, wrongName, 1, message["type"] as Int, message["body"] as String) }
  }

  @Test fun replenishingRetainsDelayedPrivateKeysAndOnlyPublishesFreshOnes() {
    val a = SignalCore.createState(alice, 1);val b = SignalCore.createState(bob, 1)
    val refreshed = SignalCore.replenish(state(b), 20)
    assertEquals(40, JSONObject(state(refreshed)).getJSONObject("preKeys").length())
    val fresh = JSONObject(bundle(refreshed)).getJSONArray("preKeys")
    assertEquals(20, fresh.length());assertEquals(21, fresh.getJSONObject(0).getInt("id"))
    val message = SignalCore.encrypt(pin(state(a), bob, b), bob, 1, "delayed old prekey", remote(b))
    val received = SignalCore.decrypt(pin(state(refreshed), alice, a), alice, 1, message["type"] as Int, message["body"] as String)
    assertEquals("delayed old prekey", received["plaintext"])
    assertEquals(39, JSONObject(state(received)).getJSONObject("preKeys").length())
  }

  @Test fun prekeyCapacityRejectsWithoutDeletingUnconsumedKeys() {
    var current = state(SignalCore.createState(alice, 1))
    repeat(9) { current = state(SignalCore.replenish(current, 100)) }
    current = state(SignalCore.replenish(current, 80))
    assertEquals(1000, JSONObject(current).getJSONObject("preKeys").length())
    rejects { SignalCore.replenish(current, 1) }
    assertTrue(JSONObject(current).getJSONObject("preKeys").has("1"))
    rejects { SignalCore.createState(alice, 2) }
  }

  @Test fun authenticatedFilesRoundTripAndRejectTamperOrWrongAssociatedData() {
    val key = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
    val nonce = Base64.getEncoder().encodeToString(ByteArray(12) { (it + 50).toByte() })
    val ad = Base64.getEncoder().encodeToString("file-id+chat-id".toByteArray())
    val original = Base64.getEncoder().encodeToString("Файл: проверка без временных копий".toByteArray())
    val cipher = SignalCore.seal(original, key, nonce, ad)
    assertEquals(original, SignalCore.open(cipher, key, nonce, ad))
    rejects { SignalCore.open(altered(cipher), key, nonce, ad) }
    rejects { SignalCore.open(cipher, key, nonce, "") }
    rejects { SignalCore.seal(original, key, "", ad) }
  }
}
