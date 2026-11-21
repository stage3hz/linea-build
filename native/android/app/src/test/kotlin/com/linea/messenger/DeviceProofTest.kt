package com.linea.messenger

import com.linea.messenger.auth.DeviceKey
import com.linea.messenger.auth.DeviceProof
import com.linea.messenger.core.Core
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64

/** The device proof of a session: the key's two texts in the very shape the server checks (server/src/devicebind.js),
 *  and the whole exchange through JNI with a key made on this machine. No server is spoken to: the "server" here is
 *  a part of the test that keeps the rules of devicebind.js — it takes a key and a signature only as that file does. */
class DeviceProofTest {
  private companion object {
    val BASE64URL = Regex("^[A-Za-z0-9_-]+$")
    val P256: ECParameterSpec = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    val FIELD = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)

    fun pair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    /** `devicePublicKey` of devicebind.js: 87 characters of base64url, 65 bytes, 04 first, a point of the curve. */
    fun serverKey(value: Any?): PublicKey? {
      if (value !is String || value.length != 87 || !BASE64URL.matches(value)) return null
      val raw = Base64.getUrlDecoder().decode(value)
      if (raw.size != 65 || raw[0] != 4.toByte()) return null
      val x = BigInteger(1, raw.copyOfRange(1, 33)); val y = BigInteger(1, raw.copyOfRange(33, 65))
      if (x >= FIELD || y >= FIELD) return null
      // y² = x³ − 3x + b
      if (y.multiply(y).mod(FIELD) != x.pow(3).subtract(x.multiply(BigInteger.valueOf(3))).add(P256.curve.b).mod(FIELD)) return null
      return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), P256))
    }

    /** `deviceSignatureValid` of devicebind.js, for a DER signature: 80…100 characters of base64url, ECDSA / SHA-256. */
    fun serverAccepts(key: PublicKey?, message: String, signature: Any?): Boolean {
      if (key == null || signature !is String || signature.length < 80 || signature.length > 100 || !BASE64URL.matches(signature)) return false
      return try { Signature.getInstance("SHA256withECDSA").apply { initVerify(key); update(message.toByteArray(Charsets.UTF_8)) }.verify(Base64.getUrlDecoder().decode(signature)) } catch (_: Exception) { false }
    }
  }

  /** A device key kept by the test, signing and encoding with the app's own code (`DeviceKey.point`, `.signature`). */
  private class SoftKey(var pair: KeyPair? = pair()) : DeviceProof.Key {
    var signed = 0
    override fun ensure(): Map<String, String> { val held = pair ?: throw DeviceKey.Failure("DEVICE_KEY_UNAVAILABLE"); return mapOf("publicKey" to DeviceKey.point(held.public as ECPublicKey), "kind" to "software") }
    override fun sign(message: String): String { val held = pair ?: throw DeviceKey.Failure("DEVICE_KEY_SIGN_FAILED"); signed += 1; return DeviceKey.signature(held.private, message) }
  }

  /** One session on the server, by the rules of `installDeviceBinding`; answers as the app reads them (`Core.read`). */
  private class BindingServer {
    val sessionId = "session-1"
    var bindKey: String? = null
    var bindKind: String? = null
    var challenge: String? = null
    var proof: String? = null
    val asked = ArrayList<String>()
    private val random = SecureRandom()
    private fun token(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { random.nextBytes(it) })
    private fun refuse(status: Int, code: String?) = Core.read(status, Core.text(if (code == null) mapOf("error" to "нет") else mapOf("error" to "нет", "code" to code))!!)
    private fun issue(): Map<String, Any?> { challenge = null; proof = token(); return Core.read(200, Core.text(mapOf("proof" to proof, "expiresIn" to 600))!!) }

    fun post(path: String, body: String?): Map<String, Any?>? {
      asked.add(path)
      val sent = Core.map(Core.value(body))
      return when (path) {
        "/auth/device/challenge" -> {
          if (body != null) return refuse(400, null)
          challenge = token()
          Core.read(200, Core.text(mapOf("challenge" to challenge, "sessionId" to sessionId, "bound" to (bindKey != null)))!!)
        }
        "/auth/device/bind" -> {
          if (sent == null || sent.keys != setOf("publicKey", "kind", "signature")) return refuse(400, null)
          if (bindKey != null) return refuse(409, "device_bound")
          val key = serverKey(sent["publicKey"])
          if (key == null || sent["kind"] !in setOf("hardware", "software")) return refuse(400, null)
          val current = challenge ?: return refuse(409, "device_challenge")
          if (!serverAccepts(key, "invizent-device-bind-v1\n$sessionId\n$current", sent["signature"])) return refuse(403, "device_signature")
          bindKey = sent["publicKey"] as String; bindKind = sent["kind"] as String
          issue()
        }
        "/auth/device/proof" -> {
          if (sent == null || sent.keys != setOf("signature")) return refuse(400, null)
          val bound = bindKey ?: return refuse(409, "device_unbound")
          val current = challenge ?: return refuse(409, "device_challenge")
          if (!serverAccepts(serverKey(bound), "invizent-device-proof-v1\n$sessionId\n$current", sent["signature"])) return refuse(403, "device_signature")
          issue()
        }
        else -> refuse(404, null)
      }
    }
  }

  @Test fun theKeyAndTheSignatureHaveTheShapeTheServerChecks() {
    var shortSeen = false; var longSeen = false
    var count = 0
    // Keys until both odd cases have been met: a coordinate with a zero first byte (Java gives it shorter than 32
    // bytes) and one with the highest bit set (Java gives it 33 bytes long). Each must still fill exactly 32.
    while (count < 5000 && !(shortSeen && longSeen && count >= 20)) {
      count += 1
      val made = pair()
      val public = made.public as ECPublicKey
      for (coordinate in listOf(public.w.affineX, public.w.affineY)) {
        if (coordinate.toByteArray().size < 32) shortSeen = true
        if (coordinate.toByteArray().size > 32) longSeen = true
      }
      val text = DeviceKey.point(public)
      assertEquals(87, text.length)
      assertTrue(BASE64URL.matches(text))
      val raw = Base64.getUrlDecoder().decode(text)
      assertEquals(65, raw.size)
      assertEquals(4.toByte(), raw[0])
      assertEquals(public.w.affineX, BigInteger(1, raw.copyOfRange(1, 33)))
      assertEquals(public.w.affineY, BigInteger(1, raw.copyOfRange(33, 65)))
      // The server makes its key from the text alone, and with that key the signature holds — for these very
      // bytes of the message, and for no others.
      val key = serverKey(text)
      assertNotNull(key)
      val message = "invizent-device-bind-v1\nсессия-$count\nc_-9"
      val signature = DeviceKey.signature(made.private, message)
      assertTrue(signature.length in 80..100)
      assertTrue(BASE64URL.matches(signature))
      val der = Base64.getUrlDecoder().decode(signature)
      // DER: SEQUENCE { INTEGER r, INTEGER s } — not the raw 64 bytes of r ‖ s.
      assertEquals(0x30.toByte(), der[0])
      assertEquals(der.size - 2, der[1].toInt())
      assertEquals(0x02.toByte(), der[2])
      assertEquals(0x02.toByte(), der[4 + der[3]])
      assertEquals(der.size, 6 + der[3] + der[5 + der[3]])
      assertTrue(serverAccepts(key, message, signature))
      assertFalse(serverAccepts(key, message + " ", signature))
      assertFalse(serverAccepts(serverKey(DeviceKey.point(pair().public as ECPublicKey)), message, signature))
    }
    assertTrue("a short coordinate was met", shortSeen)
    assertTrue("a long coordinate was met", longSeen)
    // What the server would not take as a key is not taken by the test's server either.
    assertNull(serverKey("A".repeat(87)))
    assertNull(serverKey(DeviceKey.point(pair().public as ECPublicKey) + "="))
  }

  @Test fun theWholeExchangeRunsThroughTheCore() {
    assumeTrue(Core.loaded)
    val server = BindingServer()
    val key = SoftKey()
    val proof = DeviceProof(key)
    proof.post = server::post

    // A session just signed in: nothing is held, and it is not known yet whether a proof is needed.
    assertNull(proof.current)
    assertTrue(proof.due)
    assertFalse(proof.known)
    assertEquals(0, proof.generation)

    // Not bound yet: the challenge, the key's signature for binding, the binding — and the proof is held.
    assertEquals(DeviceProof.Outcome.OK, proof.ensure(force = false))
    assertEquals(listOf("/auth/device/challenge", "/auth/device/bind"), server.asked)
    assertEquals(key.ensure()["publicKey"], server.bindKey)
    assertEquals("software", server.bindKind)
    val first = proof.current
    assertNotNull(first)
    assertEquals(server.proof, first)
    assertEquals(43, first!!.length)
    assertTrue(proof.known)
    assertFalse(proof.due)
    assertEquals(1, proof.generation)
    // Held and fresh: asking again costs nothing.
    assertEquals(DeviceProof.Outcome.OK, proof.ensure(force = false))
    assertEquals(2, server.asked.size)
    assertEquals(1, key.signed)

    // The server has refused the proof: a new one is proven with the same key, not bound again.
    server.asked.clear()
    assertEquals(DeviceProof.Outcome.OK, proof.ensure(force = true, seen = 1))
    assertEquals(listOf("/auth/device/challenge", "/auth/device/proof"), server.asked)
    assertEquals(key.ensure()["publicKey"], server.bindKey)
    assertNotEquals(first, proof.current)
    assertEquals(server.proof, proof.current)
    assertEquals(2, proof.generation)
    // Another request refused together with that one (it left with the same old proof) uses the new one.
    assertEquals(DeviceProof.Outcome.OK, proof.ensure(force = true, seen = 1))
    assertEquals(2, server.asked.size)

    // The key is gone and another stands in its place (the app's data on another phone): the server does not
    // take its signature, and the session cannot be used here any more.
    val bound = server.bindKey
    key.pair = pair()
    server.asked.clear()
    assertEquals(DeviceProof.Outcome.LOST, proof.ensure(force = true, seen = 2))
    assertEquals(listOf("/auth/device/challenge", "/auth/device/proof"), server.asked)
    assertEquals(bound, server.bindKey)

    // No key at all on a device whose session is bound: lost as well, and nothing is signed.
    val none = DeviceProof(SoftKey(null))
    none.post = server::post
    assertEquals(DeviceProof.Outcome.LOST, none.ensure(force = false))
    assertNull(none.current)

    // No answer from the server: not lost — it could not be done now.
    val away = DeviceProof(SoftKey())
    away.post = { _, _ -> null }
    assertEquals(DeviceProof.Outcome.FAILED, away.ensure(force = false))
    // A server from before device binding: the session works as before, without a proof.
    val old = DeviceProof(SoftKey())
    old.post = { _, _ -> Core.read(404, """{"error":"Не найдено"}""") }
    assertEquals(DeviceProof.Outcome.OK, old.ensure(force = false))
    assertNull(old.current)
    assertFalse(old.due)
  }

  @Test fun theProofAndTheBuildKeyGoIntoTheRequest() {
    assumeTrue(Core.loaded)
    val headers = Core.prepare("POST", "/chats/1/read", jsonBody = true, token = "t", proof = "p".repeat(43))!!.headers.toMap()
    assertEquals("p".repeat(43), headers.entries.single { it.key.equals("X-Linea-Proof", ignoreCase = true) }.value)
    assertTrue(Core.prepare("POST", "/chats/1/read", jsonBody = true, token = "t")!!.headers.none { it.first.equals("X-Linea-Proof", ignoreCase = true) })
    // This build has no request-signing key (none is ever committed): nothing is signed. With a key the core signs.
    if (BuildConfig.ATTEST_KEY.isEmpty()) assertTrue(Core.prepare("POST", "/chats/1/read", jsonBody = true, token = "t")!!.headers.none { it.first == "X-Linea-Attest" })
    val signed = Core.map(Core.value(Core.httpPrepare("""{"method":"POST","path":"/chats/1/read","jsonBody":true,"platform":"android","version":"1","nowMs":1795244500000,"attestKey":"0123456789abcdef0123456789abcdef"}""")))!!
    assertTrue((signed["headers"] as List<*>).any { (it as List<*>)[0] == "X-Linea-Attest" })
  }
}
