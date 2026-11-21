package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.calls.CallEntry
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.design.edges
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.pages
import com.linea.messenger.settings.ThemeStore
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** ChatsPlus: «Люди › Звонки» (the reference's calls/CallHistory.tsx over callLog.ts): recent calls grouped by day,
 *  built only from what this device decrypted and kept — never asked of the server. A call leaves one trace in the
 *  chat, the encrypted `end` action; its words come from the core (`callServiceText`), so both phones name the same
 *  call the same way. Missed calls not read yet are red with a dot, and their number stands on the tab
 *  (native/ios/Sources/ChatsPlus/CallHistory.swift). */
data class CallRecord(
  val key: String, val chat: Messenger.ChatSummary, val at: Instant,
  /** "outgoing", "incoming", "missed", "cancelled", "declined", "busy", "failed". */
  val kind: String, val video: Boolean,
  /** The row's words: «Исходящий звонок · 3:12», «Пропущенный видеозвонок». */
  val label: String, val unseen: Boolean, val count: Int = 1,
)

object CallLog {
  /** The core's labels back to the kind they name (callLog.ts `callLabel`). */
  private val kinds = mapOf(
    "Исходящий звонок" to ("outgoing" to false), "Исходящий видеозвонок" to ("outgoing" to true),
    "Входящий звонок" to ("incoming" to false), "Входящий видеозвонок" to ("incoming" to true),
    "Пропущенный звонок" to ("missed" to false), "Пропущенный видеозвонок" to ("missed" to true),
    "Отменённый звонок" to ("cancelled" to false), "Отменённый видеозвонок" to ("cancelled" to true),
    "Отклонённый звонок" to ("declined" to false), "Отклонённый видеозвонок" to ("declined" to true),
    "Собеседник занят" to ("busy" to false), "Звонок не удался" to ("failed" to false), "Видеозвонок не удался" to ("failed" to true),
  )
  private val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

  /** One `end` action as this account sees it: kind, video, the row's words. The kind is read from the core's own
   *  label of the same action without its length, so the rules stay in one place (calls.rs `classify_call`). */
  fun describe(action: Map<String, Any?>, senderId: String, userId: String): Triple<String, Boolean, String>? {
    val label = Core.view("callServiceText", listOf(action, senderId, userId)) as? String ?: return null
    val plain = Core.view("callServiceText", listOf(action - "duration", senderId, userId)) as? String ?: label
    val found = kinds[plain] ?: return null
    return Triple(found.first, found.second || action["video"] == true, label)
  }

  /** Every call this device knows (the history kept here, newest first). Runs on the encryption thread. */
  fun build(chats: List<Messenger.ChatSummary>, userId: String, crypto: CryptoService): List<CallRecord> {
    val out = ArrayList<CallRecord>()
    for (chat in chats) {
      val pool = (crypto.callNow("history", listOf(chat.id, 400)).getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it) }.toMutableList()
      // The list's last message, for a chat whose history holds nothing yet.
      if (chat.last.isNotEmpty() && pool.none { it["clientId"] == chat.last["clientId"] }) {
        val last = LinkedHashMap(chat.last)
        if (last["sentAt"] == null) last["sentAt"] = last["createdAt"]
        pool.add(last)
      }
      out.addAll(records(chat, pool, userId))
    }
    return out.sortedByDescending { it.at }
  }

  /** The calls of one chat's kept messages. */
  fun records(chat: Messenger.ChatSummary, pool: List<Map<String, Any?>>, userId: String): List<CallRecord> {
    val unread = (chat.chat["unreadCount"] as? Number)?.toInt() ?: 0
    // Theirs, newest first: the newest `unread` of them are the ones not read yet.
    val theirs = pool.filter { it["senderId"] != userId }.sortedByDescending { it["sentAt"] as? String ?: "" }.mapNotNull { it["clientId"] as? String }
    val notRead = theirs.take(unread).toSet()
    val seen = HashSet<String>()
    val out = ArrayList<CallRecord>()
    for (message in pool) {
      val action = Core.map(Core.map(message["meta"])?.get("action")) ?: continue
      if (action["type"] != "call" || action["step"] != "end") continue
      val callId = action["call"] as? String ?: continue
      // Both phones may have sent an `end`: one entry per call (messageMeta.ts `dedupeCallEnds`).
      if (!seen.add(callId)) continue
      val sender = message["senderId"] as? String ?: ""
      val about = describe(action, sender, userId) ?: continue
      val at = Messenger.date(message["sentAt"] as? String ?: message["createdAt"] as? String) ?: continue
      val unseen = about.first == "missed" && sender != userId && notRead.contains(message["clientId"] as? String ?: "")
      out.add(CallRecord(chat.id + ":" + callId, chat, at, about.first, about.second, about.third, unseen))
    }
    return out
  }

  /** «Сегодня», «Вчера», «3 ноября», «3 ноября 2025 г.» (callLog.ts `callDayLabel`). */
  fun dayLabel(date: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val day = date.atZone(zone).toLocalDate(); val today = now.atZone(zone).toLocalDate()
    if (day == today) return "Сегодня"
    if (day == today.minusDays(1)) return "Вчера"
    val words = "${day.dayOfMonth} ${months[day.monthValue - 1]}"
    return if (day.year == today.year) words else "$words ${day.year} г."
  }

  /** Newest first, by day; neighbours of one kind with one person on one day become one «Имя (3)» row. */
  fun group(records: List<CallRecord>, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<Pair<String, List<CallRecord>>> {
    val groups = ArrayList<Pair<String, MutableList<CallRecord>>>()
    var lastDay: LocalDate? = null
    for (record in records) {
      val day = record.at.atZone(zone).toLocalDate()
      if (lastDay != day) { groups.add(dayLabel(record.at, now, zone) to ArrayList()); lastDay = day }
      val calls = groups.last().second
      val previous = calls.lastOrNull()
      if (previous != null && previous.chat.id == record.chat.id && previous.kind == record.kind && previous.video == record.video) {
        calls[calls.size - 1] = previous.copy(count = previous.count + 1, unseen = previous.unseen || record.unseen)
      } else calls.add(record)
    }
    return groups
  }

  /** The red number on «Звонки»: missed calls not read yet. */
  fun unseenCount(records: List<CallRecord>): Int = records.count { it.unseen }
}

/** «Друзья | Звонки» on the «Люди» page and the list of calls under it. The page hands over its views in `install`;
 *  `place` lays the switch out under the caption and gives back where the page's own content starts. */
class CallHistoryPanel(private val context: Context, private val messenger: Messenger?) : Messenger.Watcher {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var host: ViewGroup? = null
  private var caption: TextView? = null
  private val switcher = LinearLayout(context)
  private val friendsTab = context.words("Друзья", 13f, Theme.muted, 700)
  private val callsTab = FrameLayout(context)
  private val callsWords = context.words("Звонки", 13f, Theme.muted, 700)
  private val missedBadge = context.words("", 11f, Color.WHITE, 700)
  private val page = FrameLayout(context)
  private val list = ListView(context)
  private val empty = EmptyStateView(context)
  private var rows: List<Any> = emptyList()
  private var records: List<CallRecord> = emptyList()
  var showingCalls = false
    private set
  private var loading = false
  private val reloadSoon = Runnable { reload() }

  private val adapter = object : BaseAdapter() {
    override fun getCount() = rows.size
    override fun getItem(position: Int) = rows[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getViewTypeCount() = 2
    override fun getItemViewType(position: Int) = if (rows[position] is String) 0 else 1
    override fun areAllItemsEnabled() = false
    override fun isEnabled(position: Int) = rows[position] is CallRecord
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = when (val row = rows[position]) {
      is CallRecord -> (convertView as? CallRowView ?: CallRowView(context)).also { it.show(row) { callBack(row) } }
      else -> (convertView as? TextView ?: context.words("", 10f, Theme.muted, 700).apply {
        letterSpacing = 0.17f; setPadding(dp(26f), dp(8f), dp(26f), 0)
        layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, dp(34f))
      }).also { it.text = (row as String).uppercase() }
    }
  }

  fun install(host: ViewGroup, caption: TextView) {
    this.host = host
    this.caption = caption
    switcher.orientation = LinearLayout.HORIZONTAL
    switcher.setPadding(dp(4f), dp(4f), dp(4f), dp(4f))
    switcher.background = context.plate(if (Theme.dark) 0x14FFFFFF else 0xB8FFFFFF.toInt(), 22f, Theme.veil(0.08f))
    for (tab in listOf(friendsTab, callsWords)) tab.gravity = Gravity.CENTER
    friendsTab.isClickable = true
    friendsTab.setOnClickListener { show(false) }
    callsTab.isClickable = true
    callsTab.setOnClickListener { show(true) }
    callsTab.addView(callsWords, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    missedBadge.gravity = Gravity.CENTER
    missedBadge.visibility = View.GONE
    callsTab.addView(missedBadge, FrameLayout.LayoutParams(dp(18f), dp(18f), Gravity.CENTER_VERTICAL or Gravity.START))
    switcher.addView(friendsTab, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f).apply { rightMargin = dp(4f) })
    switcher.addView(callsTab, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    host.addView(switcher)
    page.setBackgroundColor(Theme.bg)
    page.visibility = View.GONE
    page.isClickable = true
    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Color.TRANSPARENT)
    list.isVerticalScrollBarEnabled = false
    list.clipToPadding = false
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ -> (rows.getOrNull(position) as? CallRecord)?.let { openChat(it) } }
    page.addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    empty.visibility = View.GONE
    page.addView(empty)
    host.addView(page)
    paintTabs()
    reload()
    if (ChatsPlusDemo.calls) host.post { show(true) }
  }

  /** The page is in the window: new messages may carry new calls. */
  fun attached() { messenger?.watch(this) }

  fun detached() {
    messenger?.unwatch(this)
    host?.removeCallbacks(reloadSoon)
  }

  override fun changed(chatId: String?) {
    host?.removeCallbacks(reloadSoon)
    host?.postDelayed(reloadSoon, 600)
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** Lays out the switch under `top`; gives back where the page's own content (the search) starts. The list of calls
   *  covers everything from there down. */
  fun place(width: Int, height: Int, top: Int, safeBottom: Int): Int {
    put(switcher, dp(17f), top + dp(12f), width - dp(34f), dp(44f))
    val below = top + dp(12f + 44f)
    // The badge stands right after the word «Звонки».
    val half = (width - dp(34f) - dp(12f)) / 2
    val wordsWidth = callsWords.paint.measureText(callsWords.text.toString()).toInt()
    (missedBadge.layoutParams as? FrameLayout.LayoutParams)?.let { params ->
      val wide = maxOf(dp(18f), missedBadge.paint.measureText(missedBadge.text.toString()).toInt() + dp(10f))
      val left = (half + wordsWidth) / 2 + dp(6f)
      if (params.leftMargin != left || params.width != wide) { params.leftMargin = left; params.width = wide; missedBadge.layoutParams = params }
    }
    put(page, 0, below + dp(14f), width, maxOf(0, height - below - dp(14f)))
    val barRoom = dp(BarMetrics.bottomGap(safeBottom / d) + BarMetrics.height + 12f)
    if (list.paddingBottom != barRoom + dp(12f)) list.setPadding(0, 0, 0, barRoom + dp(12f))
    (empty.layoutParams as? FrameLayout.LayoutParams)?.let { params ->
      val tall = maxOf(0, page.height - barRoom)
      if (params.height != tall) { params.height = tall; empty.layoutParams = params }
    }
    page.bringToFront()
    switcher.bringToFront()
    return below
  }

  private fun paintTabs() {
    friendsTab.background = if (!showingCalls) context.plate(Theme.accent, 18f) else null
    friendsTab.setTextColor(if (!showingCalls) Theme.onAccent else Theme.muted)
    callsTab.background = if (showingCalls) context.plate(Theme.accent, 18f) else null
    callsWords.setTextColor(if (showingCalls) Theme.onAccent else Theme.muted)
    friendsTab.isSelected = !showingCalls
    callsTab.isSelected = showingCalls
    val missed = CallLog.unseenCount(records)
    missedBadge.visibility = if (missed == 0) View.GONE else View.VISIBLE
    missedBadge.text = if (missed > 99) "99+" else missed.toString()
    missedBadge.background = context.plate(if (showingCalls) Theme.onAccent else Theme.danger, 9f)
    missedBadge.setTextColor(if (showingCalls) Theme.accent else Color.WHITE)
    callsTab.contentDescription = if (missed > 0) "Звонки, пропущенных $missed" else "Звонки"
    host?.requestLayout()
  }

  private fun show(calls: Boolean) {
    if (calls == showingCalls) return
    showingCalls = calls
    host?.let { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(it.windowToken, 0) }
    page.visibility = if (calls) View.VISIBLE else View.GONE
    caption?.text = if (calls) "Недавние звонки" else "Друзья, заявки и поиск по @имени"
    paintTabs()
    if (calls) reload()
  }

  private fun reload() {
    val messenger = messenger
    if (messenger == null) {
      records = ChatsPlusDemo.callRecords()
      refresh()
      return
    }
    if (loading) return
    loading = true
    messenger.chats { result ->
      val chats = result.getOrNull()
      if (chats == null) { loading = false; return@chats }
      val me = messenger.userId
      messenger.crypto.run({ crypto: CryptoService -> CallLog.build(chats, me, crypto) }, { found ->
        loading = false
        records = found
        refresh()
      })
    }
  }

  private fun refresh() {
    val made = ArrayList<Any>()
    for ((label, calls) in CallLog.group(records)) { made.add(label); made.addAll(calls) }
    rows = made
    adapter.notifyDataSetChanged()
    empty.visibility = if (records.isEmpty()) View.VISIBLE else View.GONE
    if (records.isEmpty()) empty.show("phone", "Звонков пока не было", "Здесь появятся входящие, исходящие и пропущенные звонки. Позвонить можно из чата или из профиля человека.")
    paintTabs()
  }

  /** A touch opens the chat with that person. */
  private fun openChat(call: CallRecord) {
    val messenger = messenger ?: return
    val stack = host?.pages() ?: return
    val screen = ChatScreen(context, call.chat.title, messenger, call.chat.id, call.chat.peerId, call.chat.peerLastRead) { stack.pop() }
    screen.actions.opened(call.chat.chat)
    stack.push(screen)
  }

  /** «Перезвонить»: the same kind of call again (a video call for a video one). */
  private fun callBack(call: CallRecord) {
    host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    CallEntry.call(messenger, call.chat.id, call.chat.peerId, call.chat.title, video = call.video)
  }
}

/** One call: avatar, the name (red for a missed one, «(3)» for several), the direction and the words, the time, and
 *  «Перезвонить». */
@SuppressLint("ViewConstructor")
private class CallRowView(context: Context) : LinearLayout(context) {
  private val avatar = SmallAvatarView(context)
  private val name = context.words("", 16f, Theme.text, 600).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
  private val dot = object : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) { paint.color = Theme.danger; canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, paint) }
  }
  private val arrow = PlusIconView(context, "arrow.up.right", 11f, Theme.muted)
  private val words = context.words("", 13f, Theme.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
  private val time = context.words("", 13f, Theme.muted).apply { typeface = Typeface.MONOSPACE; gravity = Gravity.END }
  private val again = PlusIconView(context, "phone", 16f, Theme.accent)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, context.px(80f))
    setPadding(context.px(26f), 0, context.px(26f), 0)
    addView(avatar, LayoutParams(context.px(50f), context.px(50f)).apply { rightMargin = context.px(14f) })
    val column = LinearLayout(context).apply { orientation = VERTICAL }
    val top = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    top.addView(name, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, 1f))
    top.addView(dot, LayoutParams(context.px(8f), context.px(8f)).apply { leftMargin = context.px(6f) })
    val bottom = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    bottom.addView(arrow, LayoutParams(context.px(14f), context.px(18f)).apply { rightMargin = context.px(5f) })
    bottom.addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    column.addView(top)
    column.addView(bottom, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(4f) })
    addView(column, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { rightMargin = context.px(8f) })
    addView(time, LayoutParams(context.px(50f), LayoutParams.WRAP_CONTENT).apply { rightMargin = context.px(14f) })
    again.background = context.plate(ThemeStore.look.accentSoft, 19f, ThemeStore.look.border)
    again.isClickable = true
    addView(again, LayoutParams(context.px(38f), context.px(38f)))
  }

  fun show(call: CallRecord, onCall: () -> Unit) {
    val red = call.kind == "missed" || call.kind == "declined"
    avatar.show(FolderChat(call.chat))
    name.text = call.chat.title + if (call.count > 1) " (${call.count})" else ""
    name.setTextColor(if (call.kind == "missed") Theme.danger else Theme.text)
    dot.visibility = if (call.unseen) View.VISIBLE else View.GONE
    arrow.symbol = when (call.kind) {
      "outgoing", "cancelled", "busy" -> "arrow.up.right"
      "incoming", "missed" -> "arrow.down.left"
      "declined" -> "nosign"
      else -> "exclamation.circle"
    }
    arrow.color = if (red) Theme.danger else Theme.muted
    arrow.invalidate()
    words.text = call.label
    words.setTextColor(if (red) Theme.danger else Theme.muted)
    time.text = Messenger.clock(call.at, ZoneId.systemDefault())
    again.symbol = if (call.video) "video" else "phone"
    again.invalidate()
    again.contentDescription = "Перезвонить: " + call.chat.title
    again.setOnClickListener { onCall() }
    contentDescription = name.text.toString() + ": " + call.label + ", " + time.text
  }
}

@Suppress("unused")
private fun keep(view: View) = view.rootWindowInsets?.edges()
