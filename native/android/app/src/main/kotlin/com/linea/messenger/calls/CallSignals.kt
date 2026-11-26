package com.linea.messenger.calls

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Live
import com.linea.messenger.people.Person
import java.time.Instant
import java.util.UUID

private val main = Handler(Looper.getMainLooper())

// How a call's signalling travels: every step (offer, answer, end, an ICE restart and its answer) is an ordinary
// end-to-end encrypted message of the chat with `meta.action` of the kind `call` — the server relays ciphertext
// and cannot tell a call from a text. Exactly as the reference does (useMessenger.ts `sendAction`, `onCallSignal`).

/** Sends one step of a call. The server is told only what to do about the notification (`push`: an offer
 *  rings, the caller's «not answered» leaves a missed-call notice, everything else is silent).
 *
 *  A step that carries an SDP is worth nothing later: when it cannot be sent now it is forgotten, so it never
 *  goes out with the unsent messages (a late offer would ring for a call that is long over). The `end` is
 *  kept and goes out later like any message: it is the row the call leaves in both chats.
 *
 *  A call's steps go ahead of the encryption's ordinary work (`runFirst`). `done`: whether the step went out. */
fun Messenger.sendCallSignal(chatId: String, peerId: String, action: Map<String, Any?>, done: ((Boolean) -> Unit)? = null) {
  val clientId = UUID.randomUUID().toString().lowercase()
  val meta = mapOf<String, Any?>("action" to action)
  val fallback = Core.view("actionFallback", listOf(action, "")) as? String ?: ""
  val push = Core.view("callPushKind", listOf(meta)) as? String
  val isEnd = action["step"] as? String == "end"
  crypto.runFirst({ crypto: CryptoService ->
    val result = deliver(crypto, chatId, peerId, clientId, fallback, null, meta, push = push)
    if (result.isFailure && !isEnd) crypto.callNow("forget", listOf(chatId, clientId))
    result.isSuccess
  }, { sent ->
    // The chat on screen shows the call's row at once.
    if (sent && isEnd) noteChanged(chatId)
    done?.invoke(sent)
  })
}

/** The STUN and TURN servers of a call with this account's short-lived relay password, as the server gives
 *  them (`GET /calls/ice`); null when they could not be asked for. Main thread. */
fun Messenger.callIceServers(done: (List<Map<String, Any?>>?) -> Unit) {
  server.op("callIce", emptyList()) { result ->
    val servers = (Core.map(result.getOrNull())?.get("iceServers") as? List<*>)?.mapNotNull { Core.map(it) }
    main.post { done(servers) }
  }
}

/** Whether this account may ring that person (`incoming`: whether that person may ring this account) — the
 *  callee decides in Настройки › Конфиденциальность › Звонки. null: the server could not be asked. Main thread. */
fun Messenger.callAllowed(userId: String, incoming: Boolean, done: (Boolean?) -> Unit) {
  server.op("callPermission", if (incoming) listOf(userId, "incoming") else listOf(userId)) { result ->
    val allowed = Core.map(result.getOrNull())?.get("allowed") as? Boolean
    main.post { done(allowed) }
  }
}

/** The person of a chat, from the server's list of chats; null when the chat is not in it. Main thread. */
fun Messenger.callPeer(chatId: String, done: (Person?) -> Unit) {
  server.op("chats", emptyList()) { result ->
    val list = (Core.map(result.getOrNull())?.get("chats") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
    val found = list.lastOrNull { it["id"] as? String == chatId }?.let { Person.from(it["peer"]) }
    main.post { done(found) }
  }
}

/** Hears the signals of calls. A call's step arrives like any message: the live line says «a message came», the
 *  chat's inbox is read and decrypted the usual way, and only then is the message seen to be a call's step —
 *  the reference's `acceptMessage`. After every (re)connection the chats that just heard from the other side are
 *  looked into as well, so a call that began while the app was closed or the line was down still rings (the
 *  reference's `loadMessages` on «ready»). Main thread. */
class CallSignals(private val messenger: Messenger) {
  private val userId = messenger.userId
  private var closed = false
  /** A decrypted message of the other side whose `meta.action` is a call's step. */
  var onSignal: ((Map<String, Any?>) -> Unit)? = null
  /** The server says how far an outgoing call got: the chat and "online", "push" or "none". */
  var onReach: ((String, String) -> Unit)? = null
  /** The live line went up or down. */
  var onLine: (() -> Unit)? = null

  private val heard: (Map<String, Any?>) -> Unit = { event(it) }

  init { Live.callEvent.watch(heard) }

  /** Hears nothing more (there is no other end to a watcher here). */
  fun close() {
    closed = true
    Live.callEvent.unwatch(heard)
  }

  private fun event(data: Map<String, Any?>) {
    when (data["type"] as? String) {
      "message" -> Core.map(data["message"])?.let { accept(it) }
      "call.reach" -> {
        val chatId = data["chatId"] as? String; val reach = data["reach"] as? String
        if (chatId != null && reach != null) onReach?.invoke(chatId, reach)
      }
      "ready" -> { onLine?.invoke(); catchUp() }
      "line" -> onLine?.invoke()
    }
  }

  /** A message the live line announced: opened here, and handed over when it is a call's step. */
  private fun accept(raw: Map<String, Any?>) {
    if (raw["senderId"] as? String == userId) return
    val chatId = raw["chatId"] as? String ?: return
    val me = userId
    messenger.crypto.runFirst({ crypto: CryptoService ->
      crypto.callNow("sync", listOf(chatId))
      Core.map(crypto.callNow("preview", listOf(raw)).getOrNull())?.takeIf { isSignal(it, me) }
    }, { opened -> if (opened != null && !closed) onSignal?.invoke(opened) })
  }

  /** After a (re)connection: a chat whose last message came from the other side within the last 70 seconds may
   *  hold a call that is still ringing. */
  private fun catchUp() {
    val me = userId
    messenger.server.op("chats", emptyList()) { result ->
      val list = (Core.map(result.getOrNull())?.get("chats") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      for (chatId in recentChats(list, me, Instant.now())) main.post { if (!closed) look(chatId) }
    }
  }

  /** The call steps of a chat's newest page from the last two minutes, in the order they were sent (the offer,
   *  then a hang-up if there was one); the engine itself drops what is stale or already seen. */
  private fun look(chatId: String) {
    val me = userId
    messenger.crypto.runFirst({ crypto: CryptoService ->
      crypto.callNow("sync", listOf(chatId))
      val list = (Core.map(messenger.server.opAndWait("messages", listOf(chatId)).getOrNull())?.get("messages") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      val fresh = Instant.now().minusSeconds(120)
      val found = ArrayList<Pair<Long, Map<String, Any?>>>()
      for (message in list) {
        if (message["senderId"] as? String == me) continue
        val at = Messenger.date(message["createdAt"] as? String) ?: continue
        if (at.isBefore(fresh)) continue
        val opened = Core.map(crypto.callNow("preview", listOf(message)).getOrNull()) ?: continue
        if (isSignal(opened, me)) found.add(Pair((message["id"] as? Number)?.toLong() ?: 0L, opened))
      }
      found.sortedBy { it.first }.map { it.second }
    }, { signals -> if (!closed) for (signal in signals) onSignal?.invoke(signal) })
  }

  companion object {
    /** Whether an opened message is a call's step from the other side. */
    fun isSignal(message: Map<String, Any?>, me: String): Boolean {
      if (message["senderId"] as? String == me || message["cryptoState"] as? String != "decrypted") return false
      return Core.map(Core.map(message["meta"])?.get("action"))?.get("type") as? String == "call"
    }

    /** The chats of the server's list whose last message came from the other side within the last 70 seconds. */
    fun recentChats(list: List<Map<String, Any?>>, me: String, now: Instant): List<String> {
      val recent = now.minusSeconds(70)
      return list.mapNotNull { chat ->
        val chatId = chat["id"] as? String ?: return@mapNotNull null
        val last = Core.map(chat["lastMessage"]) ?: return@mapNotNull null
        if (last["senderId"] as? String == me) return@mapNotNull null
        val at = Messenger.date(last["createdAt"] as? String) ?: return@mapNotNull null
        if (at.isBefore(recent)) null else chatId
      }
    }
  }
}

/** What the phone says about its network, for calls: whether there is one at all («Ожидание сети…»), and when it
 *  became another one (Wi-Fi ↔ mobile) — a live call then restarts ICE at once instead of waiting for the old
 *  path to time out. The system's own word about the default network: nothing is contacted. Main thread. */
class CallNetwork {
  private var key: String? = null
  private var watcher: ConnectivityManager.NetworkCallback? = null
  private var manager: ConnectivityManager? = null
  /** null until the system has said. */
  var online: Boolean? = null
    private set
  /** The phone lost its network, or has one again. */
  var onOnline: (() -> Unit)? = null
  /** The phone switched networks (not when it merely lost one). */
  var onChange: (() -> Unit)? = null

  fun start(context: Context) {
    if (watcher != null) return
    val system = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    val made = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        val kind = when {
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
          else -> "other"
        }
        val words = "$kind|${network.networkHandle}"
        main.post { heard(words) }
      }
      override fun onLost(network: Network) { main.post { heard("offline") } }
    }
    // Without the system's leave to ask (it is given with the install) nothing is known: the line alone decides.
    try { system.registerDefaultNetworkCallback(made) } catch (_: Exception) { return }
    if (system.activeNetwork == null) heard("offline")
    manager = system
    watcher = made
  }

  fun stop() {
    val made = watcher ?: return
    watcher = null
    try { manager?.unregisterNetworkCallback(made) } catch (_: Exception) {}
  }

  /** One word of the system about the network: "offline", or the kind and the network («wifi|12»). */
  fun heard(words: String) {
    val previous = key
    key = words
    val now = words != "offline"
    if (online != now) {
      online = now
      onOnline?.invoke()
    }
    // Going offline is not a change to act on; coming back on another network is.
    if (previous == null || previous == words || words == "offline") return
    onChange?.invoke()
  }
}
