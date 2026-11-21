package com.linea.messenger.chatlook

import android.content.Context
import android.media.MediaPlayer
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.linea.messenger.R
import com.linea.messenger.app.Messenger
import com.linea.messenger.net.Live
import java.time.Instant

/** The state of the connection in the chat header's status line (the reference's ChatScreen.tsx `headerStatus`):
 *  «соединение…» while the live line is being opened, «ожидание сети…» while the phone has no network at all.
 *  (The reference's «Mesh · без интернета» needs the nearby mesh, which this app does not have.) */
object ChatLookConnection {
  /** Posted when the words may have changed. */
  val changed = Live.Signal<Unit>()
  var networkUp = true
    private set
  private var started = false
  private val main = Handler(Looper.getMainLooper())

  /** Starts watching the phone's network and the live line (once). Main thread. */
  fun start(context: Context) {
    if (started) return
    started = true
    val manager = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    if (manager != null) {
      try {
        val caps = manager.getNetworkCapabilities(manager.activeNetwork)
        networkUp = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) { main.post { set(true) } }
          override fun onLost(network: Network) { main.post { set(false) } }
        })
      } catch (_: Throwable) { networkUp = true }
    }
    // The live line tells its changes as a call event of type «line» (net/Live.kt).
    Live.callEvent.watch { event -> if (event["type"] == "line") changed.post(Unit) }
  }

  private fun set(up: Boolean) {
    if (networkUp == up) return
    networkUp = up
    changed.post(Unit)
  }

  /** The words for the status line while the connection is not up; null when it is (then the usual line shows). */
  fun words(context: Context, messenger: Messenger?): String? {
    LookDemo.line?.let { return if (it == "offline") "ожидание сети…" else if (it == "connecting") "соединение…" else null }
    val messenger = messenger ?: return null
    start(context)
    if (messenger.live.line == "connected") return null
    if (!networkUp) return "ожидание сети…"
    return "соединение…"
  }
}

/** What the list of chats last showed, for the chat header (the reference's ChatScreen.tsx `otherUnread`): the unread
 *  messages of the other chats — not counting chats whose sound is off or that are in the archive — and each chat's
 *  person as the server listed them (their colour, picture, emoji status, Platina). */
object ChatLookUnread {
  val changed = Live.Signal<Unit>()
  private var unread: Map<String, Int> = emptyMap()
  private val peers = HashMap<String, Map<String, Any?>>()

  /** The list of chats as it was just shown (ChatListActions.show). Main thread. */
  fun take(chats: List<Messenger.ChatSummary>) {
    val counts = HashMap<String, Int>()
    for (chat in chats) {
      (chat.chat["peer"] as? Map<*, *>)?.let { peers[chat.id] = com.linea.messenger.core.Core.map(it) ?: emptyMap() }
      val settings = com.linea.messenger.core.Core.map(chat.chat["settings"] as? Map<*, *>).orEmpty()
      if (settings["archived"] == true || muted(settings)) continue
      val count = (chat.chat["unreadCount"] as? Number)?.toInt() ?: 0
      if (count > 0) counts[chat.id] = count
    }
    if (counts == unread) return
    unread = counts
    changed.post(Unit)
  }

  /** The sound is off for good, or until a moment the clock has not reached (the reference's `isMuted`). */
  fun muted(settings: Map<String, Any?>, now: Instant = Instant.now()): Boolean {
    if (settings["muted"] != true) return false
    val until = settings["mutedUntil"] as? String
    if (until.isNullOrEmpty()) return true
    val end = Messenger.date(until) ?: return true
    return end.isAfter(now)
  }

  /** The unread messages of every chat but this one. */
  fun elsewhere(chatId: String): Int = unread.entries.sumOf { if (it.key == chatId) 0 else it.value }

  /** The person of a chat as the list knows them (empty when the list has not shown it). */
  fun peer(chatId: String): Map<String, Any?> = peers[chatId] ?: emptyMap()
}

/** Short chimes in voice rooms (the reference's communities/voiceSounds.ts and its own synthesized sounds,
 *  assets/sounds/voice_*.wav): rising when someone (or you) walks in, falling when someone leaves. Several people at
 *  once give one chime, not a burst (250 ms apart at least). Volume 0.6. A missing sound never breaks the room. */
object VoiceSounds {
  enum class Kind(val raw: Int) { JOIN(R.raw.voice_join), LEAVE(R.raw.voice_leave) }

  private var lastAt = 0L

  /** Main thread. */
  fun play(context: Context?, kind: Kind) {
    val app = context?.applicationContext ?: return
    val now = SystemClock.elapsedRealtime()
    if (lastAt != 0L && now - lastAt < 250) return
    lastAt = now
    try {
      val player = MediaPlayer.create(app, kind.raw) ?: return
      player.setVolume(0.6f, 0.6f)
      player.setOnCompletionListener { it.release() }
      player.start()
    } catch (_: Throwable) { }
  }
}
