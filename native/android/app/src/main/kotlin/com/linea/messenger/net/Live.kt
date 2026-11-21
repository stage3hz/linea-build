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

  // People (people/): who is in the line now and who was when — the server's `presence` items by the person's
  // id, as they come (PresenceWords words them). Main thread only.
  var presence: Map<String, Map<String, Any?>> = emptyMap()
    private set

  // Calls (calls/): whether the line is up — "connecting", "connected" or "offline" — told as `callEvent`
  // (`{"type": "line"}`) when it changes; and the hold a live call puts on the line: while it is held the line
  // is not taken down when the app leaves the screen, and goes down once the call lets go of it.
  var line = "offline"
    private set(value) { if (field != value) { field = value; callEvent.post(mapOf("type" to "line")) } }
  private var sleepWanted = false
  var heldByCall = false
    set(value) { val was = field; field = value; if (was && !value && sleepWanted) sleep() }

  fun start() {
    sleepWanted = false
    stopped = false
    connect()
    main.removeCallbacks(beat)
    main.postDelayed(beat, 15_000)
  }

  /** The app came to the front. */
  fun wake() { sleepWanted = false; if (stopped) start() }

  /** The app left the screen (or the account is being closed): the line is taken down and not retried. */
  fun sleep() {
    // Calls: a live call keeps the line open in the background (its signalling goes through it).
    if (heldByCall) { sleepWanted = true; return }
    sleepWanted = false
    stopped = true
    line = "offline"
    main.removeCallbacks(beat)
    main.removeCallbacks(again)
    socket?.close(1001, null)
    socket = null
  }

  private fun connect() {
    if (stopped || socket != null || !server.base.startsWith("https://")) return
    val request = try { Request.Builder().url("wss://" + server.base.removePrefix("https://") + "/ws").build() } catch (_: IllegalArgumentException) { return }
    lastReceive = SystemClock.elapsedRealtime()
    line = "connecting"
    // The same client as every request: TLS with the system's certificate checks, no redirects.
    socket = Server.client.newWebSocket(request, Listener())
  }

  /** The line's own callbacks come on a background thread; each is carried to the main one and dropped there if
   *  it speaks of a line that is no longer the current one. */
  private inner class Listener : WebSocketListener() {
    private fun onMain(webSocket: WebSocket, work: () -> Unit) { main.post { if (webSocket === socket) work() } }

    override fun onOpen(webSocket: WebSocket, response: Response) = onMain(webSocket) {
      val token = server.token ?: return@onMain
      // A session bound to this device sends its proof with the token; without one the server closes the line.
      val auth = linkedMapOf<String, Any?>("type" to "auth", "token" to token, "lean" to true)
      server.currentProof?.let { auth["proof"] = it }
      val frame = Core.text(auth) ?: return@onMain
      webSocket.send(frame)
    }

    override fun onMessage(webSocket: WebSocket, text: String) = onMain(webSocket) {
      lastReceive = SystemClock.elapsedRealtime()
      val data = Core.map(Core.value(text))
      val type = data?.get("type") as? String
      if (data != null && type != null) handle(type, data)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain(webSocket) { socket = null; line = "offline"; retry() }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onMain(webSocket) { socket = null; line = "offline"; retry() }
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
      this.line = "offline"
      return connect()
    }
    line.send("{\"type\":\"ping\"}")
  }

  private fun handle(type: String, data: Map<String, Any?>) {
    // Channels (channels/): events about communities go to that section as they come.
    if (type == "ready" || type.startsWith("community")) communityEvent.post(data)
    // Calls (calls/): a message may be a call's signal (only its decrypted copy says), `call.reach` says how far
    // an outgoing call got, `ready` — that the line is up again.
    if (type == "ready") line = "connected"
    if (type == "ready" || type == "message" || type == "call.reach") callEvent.post(data)
    // Stories (stories/): somebody's stories or posts changed (`story`), a story of this account was watched
    // (`story.view`), or the line came up again.
    if (type == "ready" || type.startsWith("story")) storyEvent.post(data)
    // Rooms (rooms/): the list of rooms (`room.*`), the voice of the room this phone is in (`voice.*`), and the
    // server's refusal of what was asked of it over the line (`error`).
    if (type == "ready" || type == "error" || type.startsWith("room.") || type.startsWith("voice.")) roomEvent.post(data)
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
      // People (people/): presence and friends.
      "presence.snapshot" -> {
        val all = LinkedHashMap<String, Map<String, Any?>>()
        for (item in (data["items"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }) (item["userId"] as? String)?.let { all[it] = item }
        presence = all
        presenceChanged.post(null)
      }
      "presence" -> {
        val item = Core.map(data["presence"]); val id = item?.get("userId") as? String
        if (item != null && id != null) { presence = presence + (id to item); presenceChanged.post(id) }
      }
      "friends" -> friendsChanged.post(Unit)
    }
  }

  /** Rooms (rooms/RoomVoice.kt): one frame of the line (`voice.join`, `voice.signal`, `voice.auth`, …); false when
   *  the line is not up. */
  fun send(frame: Map<String, Any?>): Boolean {
    val open = socket ?: return false
    if (line != "connected") return false
    val text = Core.text(frame) ?: return false
    return open.send(text)
  }

  /** Tells the other side that the person is typing in a chat (or stopped). */
  fun typing(chatId: String, on: Boolean) {
    val frame = Core.text(mapOf("type" to "typing", "chatId" to chatId, "isTyping" to on)) ?: return
    socket?.send(frame)
  }

  /** What several screens hear of at once (the app's own small notice board). Main thread only. */
  class Signal<T> {
    private val heard = LinkedHashSet<(T) -> Unit>()
    fun watch(watcher: (T) -> Unit) { heard.add(watcher) }
    fun unwatch(watcher: (T) -> Unit) { heard.remove(watcher) }
    fun post(value: T) { for (watcher in heard.toList()) watcher(value) }
  }

  companion object {
    /** Posted on the main thread when `presence` changed: the person's id, or null for everyone. */
    val presenceChanged = Signal<String?>()
    /** Posted on the main thread when friends or requests to be friends changed on the server. */
    val friendsChanged = Signal<Unit>()
    /** Posted on the main thread for every event of the line about communities (its `type` begins with
     *  «community») and when the line is ready again: the event as it came. */
    val communityEvent = Signal<Map<String, Any?>>()
    /** Posted on the main thread for what a call needs from the line: the server's event — a `message`,
     *  `call.reach`, `ready` — or `{"type": "line"}` when the line went up or down (see `line`). */
    val callEvent = Signal<Map<String, Any?>>()
    /** Stories: posted on the main thread when somebody's stories or posts changed, a story of this account was
     *  watched, or the line came up again — the strip reads the feed anew (stories/StoriesModel.kt). */
    val storyEvent = Signal<Map<String, Any?>>()
    /** Rooms: posted on the main thread for what rooms need from the line — `room.created`, `room.updated`,
     *  `room.removed`, `room.state`, `room.ring` (the list and the ring), `voice.joined`, `voice.signal`,
     *  `voice.auth`, `voice.left`, `voice.state`, `voice.kicked` (the voice of the room this phone is in), `error`
     *  and `ready`: the event as it came (rooms/RoomsStore.kt, rooms/RoomVoice.kt). */
    val roomEvent = Signal<Map<String, Any?>>()
  }
}
