package com.linea.messenger.chatsplus

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.linea.messenger.net.Live
import java.util.Locale
import kotlin.math.floor

/** ChatsPlus: what the chat list says about the connection, the unread and the tab badge — the reference's
 *  network/offline.ts (`titleState`, `TITLE_TEXT`), unreadBadge.ts (`badgeText`, the total) and the line under the
 *  title in ChatListScreen.tsx (native/ios/Sources/ChatsPlus/ChatListStatus.swift). */
object ChatListStatus {
  /** The title: «Чаты» (or «Архив»), else what is going on with the connection. */
  enum class Title(val words: String) {
    CHATS(""), WAITING("Ожидание сети…"), CONNECTING("Соединение…"), UPDATING("Обновление…"),
  }

  /** The reference's `titleState` (without Mesh, which the phones do not have yet). `line`: the live line —
   *  "connecting", "connected" or "offline" (net/Live.kt); `online`: what the phone says about its network (null =
   *  not known yet); `updating`: the list is being read again after a (re)connect. */
  fun title(line: String, online: Boolean?, updating: Boolean): Title {
    if (line == "connected") return if (updating) Title.UPDATING else Title.CHATS
    if (online == false) return Title.WAITING
    if (online == true) return Title.CONNECTING
    return if (line == "connecting") Title.CONNECTING else Title.WAITING
  }

  /** Under the title: «3 чата ждут ответа», «всё прочитано» (ChatListScreen.tsx `unreadLine`). */
  fun unreadLine(count: Int): String {
    if (count <= 0) return "всё прочитано"
    val last = count % 10; val tens = count % 100
    val words = when {
      last == 1 && tens != 11 -> "чат ждёт"
      last in 2..4 && (tens < 12 || tens > 14) -> "чата ждут"
      else -> "чатов ждут"
    }
    return "$count $words ответа"
  }

  /** The reference's `badgeText`: exact up to 999, then «4,3K», «12K», «1,2M». */
  fun badgeText(n: Int): String {
    if (n < 1) return ""
    if (n < 1000) return n.toString()
    fun short(value: Double, unit: String): String {
      if (value < 10) {
        val tenths = floor(value * 10) / 10
        var words = String.format(Locale.ROOT, "%.1f", tenths).replace('.', ',')
        if (words.endsWith(",0")) words = words.dropLast(2)
        return words + unit
      }
      return floor(value).toInt().toString() + unit
    }
    if (n < 1_000_000) return short(n / 1000.0, "K")
    return short(n / 1_000_000.0, "M")
  }

  /** «Чаты» tab: the unread messages of chats that are neither archived nor muted, plus one for each such chat
   *  marked unread by hand (App.tsx `unreadTotal` + markedUnread.ts `markedExtra`). */
  fun total(items: List<Counted>): Int = items.filter { !it.archived && !it.muted }.sumOf { if (it.unread > 0) it.unread else if (it.marked) 1 else 0 }

  /** A chat as the badges see it. */
  class Counted(val id: String, val unread: Int, val marked: Boolean, val muted: Boolean, val archived: Boolean)
}

/** What the phone says about its network: `online` is null until the first answer. Main thread for readers;
 *  `changed` is posted on the main thread. Only the system's word is read: nothing is contacted. */
object NetworkWatch {
  val changed = Live.Signal<Unit>()
  var online: Boolean? = null
    private set
  private var started = false
  private val main = Handler(Looper.getMainLooper())

  fun start(context: Context) {
    if (started) return
    started = true
    val manager = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    fun say(now: Boolean) = main.post { if (online != now) { online = now; changed.post(Unit) } }
    try {
      val current = manager.activeNetwork?.let { manager.getNetworkCapabilities(it) }
      online = current?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
      manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { say(true) }
        override fun onLost(network: Network) { say(false) }
        override fun onUnavailable() { say(false) }
      })
    } catch (_: Throwable) { /* the title then follows the live line alone */ }
  }
}

/** The number on the «Чаты» tab (ChatListStatus.total). Main thread. */
object UnreadTotal {
  val changed = Live.Signal<Unit>()
  var total = 0
    private set

  fun set(next: Int) {
    if (next == total) return
    total = next
    changed.post(Unit)
  }
}
