package com.linea.messenger.net

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.linea.messenger.core.Core
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.math.min
import kotlin.math.pow

/** The live line to the server: what happens while the app is open comes over it at once — a new message, a
 *  read mark, the other side typing. It carries no message text the app trusts: an event only says «look again»,
 *  and what is shown is read and decrypted the usual way.
 *
 *  Closed in the background (the other side then sees «был(а) только что»), opened again in front — the window
 *  tells it (`sleep`, `wake`); a lost line is retried with growing pauses. The line alone never signs anyone out.
 *  Everything here happens on the main thread. */
class Live(private val server: Server) {
  sealed class Event {
    /** Connected and signed in: everything should be read afresh. */
    object Ready : Event()
    /** Something changed in a chat (a message, an edit, a read mark of ours). */
    class Chat(val id: String?) : Event()
    /** The other side read up to a message. */
    class Read(val chatId: String, val userId: String, val messageId: Long) : Event()
    class Typing(val chatId: String, val userId: String, val on: Boolean) : Event()
  }

  private val main = Handler(Looper.getMainLooper())
  private var socket: WebSocket? = null
  private var attempts = 0
  private var stopped = true
  private var lastReceive = 0L
  private val beat = object : Runnable { override fun run() { tick(); main.postDelayed(this, 15_000) } }
  private val again = Runnable { connect() }
  /** Called on the main thread. */
  var onEvent: ((Event) -> Unit)? = null

  fun start() {
    stopped = false
    connect()
    main.removeCallbacks(beat)
    main.postDelayed(beat, 15_000)
  }

  /** The app came to the front. */
  fun wake() { if (stopped) start() }

  /** The app left the screen (or the account is being closed): the line is taken down and not retried. */
  fun sleep() {
    stopped = true
    main.removeCallbacks(beat)
    main.removeCallbacks(again)
    socket?.close(1001, null)
    socket = null
  }

  private fun connect() {
    if (stopped || socket != null || !server.base.startsWith("https://")) return
    val request = try { Request.Builder().url("wss://" + server.base.removePrefix("https://") + "/ws").build() } catch (_: IllegalArgumentException) { return }
    lastReceive = SystemClock.elapsedRealtime()
    // The same client as every request: TLS with the system's certificate checks, no redirects.
    socket = Server.client.newWebSocket(request, Listener())
  }

  /** The line's own callbacks come on a background thread; each is carried to the main one and dropped there if
   *  it speaks of a line that is no longer the current one. */
  private inner class Listener : WebSocketListener() {
    private fun onMain(webSocket: WebSocket, work: () -> Unit) { main.post { if (webSocket === socket) work() } }

    override fun onOpen(webSocket: WebSocket, response: Response) = onMain(webSocket) {
      val token = server.token
      val frame = if (token != null) Core.text(mapOf("type" to "auth", "token" to token, "lean" to true)) else null
      if (frame != null) webSocket.send(frame)
    }

    override fun onMessage(webSocket: WebSocket, text: String) = onMain(webSocket) {
      lastReceive = SystemClock.elapsedRealtime()
      val data = Core.map(Core.value(text))
      val type = data?.get("type") as? String
      if (data != null && type != null) handle(type, data)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain(webSocket) { socket = null; retry() }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onMain(webSocket) { socket = null; retry() }
  }

  private fun retry() {
    if (stopped) return
    val pause = min(2.0.pow(attempts), 15.0)
    attempts += 1
    main.removeCallbacks(again)
    main.postDelayed(again, (pause * 1000).toLong())
  }

  private fun tick() {
    val line = socket ?: return connect()
    // A line that has been silent for too long is taken down and opened again.
    if (SystemClock.elapsedRealtime() - lastReceive > 45_000) {
      line.cancel()
      socket = null
      return connect()
    }
    line.send("{\"type\":\"ping\"}")
  }

  private fun handle(type: String, data: Map<String, Any?>) {
    when (type) {
      "ready" -> { attempts = 0; onEvent?.invoke(Event.Ready) }
      "message" -> onEvent?.invoke(Event.Chat(Core.map(data["message"])?.get("chatId") as? String))
      "chat" -> onEvent?.invoke(Event.Chat(Core.map(data["chat"])?.get("id") as? String))
      "chat.deleted", "e2ee.devices", "profile" -> onEvent?.invoke(Event.Chat(null))
      "read" -> {
        val chatId = data["chatId"] as? String; val userId = data["userId"] as? String; val id = (data["messageId"] as? Number)?.toLong()
        if (chatId != null && userId != null && id != null) onEvent?.invoke(Event.Read(chatId, userId, id))
      }
      "typing" -> {
        val chatId = data["chatId"] as? String; val userId = data["userId"] as? String
        if (chatId != null && userId != null) onEvent?.invoke(Event.Typing(chatId, userId, data["isTyping"] as? Boolean ?: false))
      }
    }
  }

  /** Tells the other side that the person is typing in a chat (or stopped). */
  fun typing(chatId: String, on: Boolean) {
    val frame = Core.text(mapOf("type" to "typing", "chatId" to chatId, "isTyping" to on)) ?: return
    socket?.send(frame)
  }
}
