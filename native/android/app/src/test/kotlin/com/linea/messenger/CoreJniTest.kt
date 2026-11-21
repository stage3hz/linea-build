package com.linea.messenger

import com.linea.messenger.core.Core
import com.linea.messenger.app.Messenger
import com.linea.messenger.chat.MsgRow
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

  @Test fun aTextIsLaidOutByTheCore() {
    assumeTrue(Core.loaded)
    // Plain words stay as they are, without runs.
    assertEquals(mapOf("text" to "Привет", "fmt" to emptyList<Any?>(), "urls" to emptyList<Any?>()), Core.view("nativeText", listOf("Привет", null)))
    // Bold over «жирный» (flag 1), and an address found in the text itself (flag 64): offsets in UTF-16 units.
    val laid = Core.map(Core.view("nativeText", listOf("😀 жирный и https://example.com/a", listOf(mapOf("type" to "bold", "offset" to 3, "length" to 6)))))!!
    assertEquals("😀 жирный и https://example.com/a", laid["text"])
    assertEquals(listOf(1.0, 3.0, 6.0, 64.0, 12.0, 21.0), laid["fmt"])
    assertEquals(listOf("https://example.com/a"), laid["urls"])
    // The very JSON the core gives, as the JNI function hands it over.
    assertEquals("""{"text":"a","fmt":[2,0,1],"urls":[]}""", Core.view("nativeText", """["a",[{"type":"italic","offset":0,"length":1}]]"""))
    // The app's row takes these as they are.
    val row = MsgRow.parse(Messenger.rows(listOf(mapOf("id" to 1.0, "senderId" to "peer", "clientId" to "c1", "createdAt" to "2026-11-21T06:00:00.000Z",
      "text" to "жирный", "meta" to mapOf("entities" to listOf(mapOf("type" to "bold", "offset" to 0, "length" to 6))))), "me", 0, java.time.Instant.parse("2026-11-21T07:00:00Z"), java.time.ZoneId.of("Europe/Moscow"))).last()
    assertEquals(listOf("жирный", listOf(1, 0, 6), emptyList<String>()), listOf(row.text, row.fmt, row.urls))
    // No answer for an unknown name, arguments of the wrong kind, or a text that is not JSON.
    assertNull(Core.view("no-such-view", listOf("a")))
    assertNull(Core.view("nativeText", listOf(1, null)))
    assertNull(Core.view("nativeText", "not json"))
    assertEquals("Привет", Core.view("chatListText", listOf(mapOf("text" to "Привет"))))
  }

  @Test fun aChatIsFoldedByTheCore() {
    assumeTrue(Core.loaded)
    fun message(id: Int, sender: String, text: String, at: String, action: Map<String, Any?>? = null) =
      mapOf<String, Any?>("id" to id, "senderId" to sender, "clientId" to "c$id", "text" to text, "createdAt" to at) + (if (action == null) emptyMap() else mapOf("meta" to mapOf("action" to action)))
    val raw = listOf(
      message(1, "peer", "Привет", "2026-11-21T06:00:00.000Z"),
      message(2, "me", "Превет", "2026-11-21T06:01:00.000Z"),
      message(3, "me", "", "2026-11-21T06:02:00.000Z", mapOf("type" to "edit", "target" to "c2", "text" to "Привет!")),
      message(4, "peer", "лишнее", "2026-11-21T06:03:00.000Z"),
      message(5, "peer", "", "2026-11-21T06:04:00.000Z", mapOf("type" to "delete", "target" to "c4")),
      message(6, "me", "", "2026-11-21T06:05:00.000Z", mapOf("type" to "react", "target" to "c1", "emoji" to "👍")),
      message(7, "peer", "", "2026-11-21T06:06:00.000Z", mapOf("type" to "react", "target" to "c1", "emoji" to "👍")),
      message(8, "peer", "", "2026-11-21T06:07:00.000Z", mapOf("type" to "react", "target" to "c2", "emoji" to "❤️")),
    )
    val now = 1795245600000L
    // Through the JNI function itself: the core's own JSON.
    val text = Core.view("foldChat", Core.text(listOf(raw.take(3), "me", emptyList<String>(), now))!!)!!
    assertEquals(
      """{"messages":[{"id":1,"senderId":"peer","clientId":"c1","text":"Привет","createdAt":"2026-11-21T06:00:00.000Z","edited":false,"reactions":[]},""" +
        """{"id":2,"senderId":"me","clientId":"c2","text":"Привет!","createdAt":"2026-11-21T06:01:00.000Z","edited":true,"reactions":[]}],""" +
        """"pinned":null,"rules":{"ttl":null,"noCopy":false},"nextExpiry":null}""", text)
    // As the app asks: the edit shows the new text, the deleted message is gone, reactions are gathered.
    val lines = Messenger.folded(raw, "me", now)
    assertEquals(listOf("c1", "c2"), lines.map { it["clientId"] })
    assertEquals(listOf("Привет", "Привет!"), lines.map { it["text"] })
    assertEquals(listOf(false, true), lines.map { it["edited"] })
    assertEquals(listOf(mapOf("emoji" to "👍", "count" to 2.0, "mine" to true)), lines[0]["reactions"])
    assertEquals(listOf(mapOf("emoji" to "❤️", "count" to 1.0, "mine" to false)), lines[1]["reactions"])
    // And the rows of the list from that page.
    val rows = MsgRow.parse(Messenger.rows(lines, "me", 0, java.time.Instant.parse("2026-11-21T07:00:00Z"), java.time.ZoneId.of("Europe/Moscow")))
    assertEquals(listOf("Сегодня", "Привет", "Привет!"), rows.map { it.text })
    assertEquals(listOf("", "09:00", "изм. 09:01"), rows.map { it.time })
    assertEquals(listOf(emptyList(), listOf("👍", "2", "1"), listOf("❤️", "1", "")), rows.map { it.chips })
    // Arguments of the wrong kind have no answer.
    assertNull(Core.view("foldChat", listOf(raw, "me")))
  }

  @Test fun aHostWithoutTheThreeMethodsIsRefused() {
    assumeTrue(Core.loaded)
    val refused = try { Core.cryptoNew("user-1", true, Any()); null } catch (error: NoSuchMethodError) { error }
    assertNotNull(refused)
    assertNull(Core.cryptoCall(0L, "deviceId", "[]"))
    Core.cryptoFree(0L)
  }
}
