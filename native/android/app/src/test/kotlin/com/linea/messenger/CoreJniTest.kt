package com.linea.messenger

import com.linea.messenger.core.Core
import com.linea.messenger.core.CryptoHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.Executors

/** Kotlin ↔ the core through JNI, for real: the very functions the app calls on a phone, in the core built for
 *  this machine with its Signal library (native/android/build-core-host.sh). Skipped when that library has not
 *  been built. No server is spoken to: the "server" here is a function of the test. */
class CoreJniTest {
  /** The app's side of the encryption service, kept in memory, with everything it was asked written down. */
  private class Host(private val server: (method: String, args: List<Any?>) -> Map<String, Any?>) : CryptoHost {
    val kept = HashMap<String, String>()
    val asked = ArrayList<String>()
    val threads = HashSet<String>()
    override fun vaultGet(key: String): String? { threads.add(Thread.currentThread().name); return kept[key] }
    override fun vaultCommit(changesJson: String) {
      threads.add(Thread.currentThread().name)
      for (pair in Core.value(changesJson) as List<*>) {
        val (key, value) = pair as List<*>
        if (value == null) kept.remove(key as String) else kept[key as String] = value as String
      }
    }
    override fun transport(method: String, argsJson: String): String {
      threads.add(Thread.currentThread().name)
      asked.add(method)
      return Core.text(server(method, Core.value(argsJson) as List<*>))!!
    }
  }

  private fun call(handle: Long, op: String, vararg args: Any?): Map<String, Any?> = Core.map(Core.value(Core.cryptoCall(handle, op, Core.text(args.toList())!!)))!!

  @Test fun requestsAreMadeAndAnswersReadByTheCore() {
    assumeTrue(Core.loaded)
    assertTrue(Regex("\\d+\\.\\d+\\.\\d+").matches(Core.coreVersion()))
    val made = Core.prepare("POST", "/chats/1/read", jsonBody = true, token = "токен-1")!!
    val headers = made.headers.toMap()
    assertEquals("Bearer токен-1", headers["Authorization"])
    assertEquals("application/json", headers["Content-Type"])
    assertTrue(headers.getValue("X-Linea-Client").contains("android"))
    assertTrue(made.timeoutMs > 0)
    assertNull(Core.prepare("GET", "/me", jsonBody = false, token = null)!!.headers.toMap()["Authorization"])
    assertNull(Core.httpPrepare("not json"))

    assertEquals(mapOf("chats" to emptyList<Any?>()), Core.read(200, """{"chats":[]}""")["ok"])
    val refused = Core.map(Core.read(401, """{"error":"Неверный логин","code":"LOGIN_FAILED","attemptsLeft":4}""")["refused"])!!
    assertEquals(listOf("Неверный логин", 401.0, "LOGIN_FAILED", 4.0), listOf(refused["message"], refused["status"], refused["code"], refused["attemptsLeft"]))
    assertEquals(true, Core.read(502, "<html>")["serverDown"])

    val chats = Core.call("chats", emptyList())!!
    assertEquals(listOf("GET", "/chats?lean=1", null), listOf(chats.method, chats.path, chats.body))
    val login = Core.call("login", listOf("native_tester", "пароль", "слово"))!!
    assertEquals(listOf("POST", "/auth/login"), listOf(login.method, login.path))
    val body = Core.map(Core.value(login.body))!!
    assertEquals(listOf("native_tester", "пароль", "слово", "android"), listOf(body["username"], body["password"], body["confirmationWord"], body["platform"]))
    assertNull(Core.call("no-such-operation", emptyList()))
  }

  @Test fun theEncryptionServiceAsksTheAppForItsStorageAndItsServer() {
    assumeTrue(Core.loaded)
    val host = Host { method, _ -> if (method == "registerCryptoDevice") mapOf("network" to "Нет связи с сервером.") else mapOf("refused" to "нет") }
    val handle = Core.cryptoNew("user-1", true, host)
    assertNotEquals(0L, handle)
    var made = ""
    try {
      // Nothing is known of this device yet.
      assertEquals(mapOf("ok" to null), call(handle, "deviceId"))
      // A record goes into the app's storage and comes back out of it, whatever the letters.
      val note = "черновик 😀   \"кавычки\""
      assertEquals(mapOf("ok" to null), call(handle, "storeLocal", "drafts:v1", note))
      assertTrue(host.kept.isNotEmpty())
      assertEquals(mapOf("ok" to note), call(handle, "loadLocal", "drafts:v1"))
      assertEquals("Error", Core.map(call(handle, "loadLocal", "anything")["error"])!!["name"])
      // The first start makes the keys (the Signal library inside the core), keeps them, and goes to the server
      // with them; the server is «away», and the service says so in the server's words.
      val before = host.kept.size
      val started = call(handle, "initialize")
      assertTrue(host.kept.size > before)
      assertTrue(host.asked.contains("registerCryptoDevice"))
      val error = Core.map(started["error"])!!
      assertEquals("NetworkError", error["name"])
      assertEquals("Нет связи с сервером.", error["message"])
      // The keys were made once: the device has its id now, and it is the same when asked again.
      val device = call(handle, "deviceId")["ok"] as String
      assertTrue(device.isNotEmpty())
      assertEquals(device, call(handle, "deviceId")["ok"])
      made = device
      // Every question came on the thread that asked the service.
      assertEquals(setOf(Thread.currentThread().name), host.threads)
      // Called from another thread, the questions come on that one.
      host.threads.clear()
      val other = Executors.newSingleThreadExecutor { work -> Thread(work, "invizent.crypto.test") }
      try { assertEquals(mapOf("ok" to note), other.submit<Map<String, Any?>> { call(handle, "loadLocal", "drafts:v1") }.get()) } finally { other.shutdown() }
      assertEquals(setOf("invizent.crypto.test"), host.threads)
      // An unknown operation and arguments that are not a list are answers, not crashes.
      assertNotNull(call(handle, "no-such-operation")["error"])
      assertNotNull(Core.map(Core.value(Core.cryptoCall(handle, "deviceId", "{}")))!!["error"])
    } finally {
      Core.cryptoFree(handle)
    }
    // A second service over the same storage finds the same device there: no new keys are made.
    val again = Core.cryptoNew("user-1", true, host)
    val size = host.kept.size
    try {
      call(again, "initialize")
      assertEquals(made, call(again, "deviceId")["ok"])
      assertEquals(size, host.kept.size)
    } finally { Core.cryptoFree(again) }
  }

  @Test fun aHostWithoutTheThreeMethodsIsRefused() {
    assumeTrue(Core.loaded)
    val refused = try { Core.cryptoNew("user-1", true, Any()); null } catch (error: NoSuchMethodError) { error }
    assertNotNull(refused)
    assertNull(Core.cryptoCall(0L, "deviceId", "[]"))
    Core.cryptoFree(0L)
  }
}
