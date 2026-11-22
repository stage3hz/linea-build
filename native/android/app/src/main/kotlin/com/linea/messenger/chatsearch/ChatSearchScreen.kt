package com.linea.messenger.chatsearch

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.ChannelsStore
import com.linea.messenger.channels.CommunityAvatarView
import com.linea.messenger.channels.CommunitySummary
import com.linea.messenger.chatactions.ChatHistory
import com.linea.messenger.chatactions.ChatIcons
import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.chatactions.ChatLocal
import com.linea.messenger.chatlook.Bouncy
import com.linea.messenger.chatlook.GlassPill
import com.linea.messenger.chatlook.Haptic
import com.linea.messenger.chatsplus.ChatsPlusDemo
import com.linea.messenger.chatsplus.SavedMessages
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PeopleIcons
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.findPeople
import com.linea.messenger.people.pages
import com.linea.messenger.people.personAvatarAddress
import com.linea.messenger.shell.Screen
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** The search of the chat list as a screen of its own (mobile/src/ChatSearch.tsx; the iPhone's
 *  Sources/ChatSearch/ChatSearchScreen.swift): the heading and the bar give way to a glass field with a round ✕,
 *  «Недавние» (kept only on this device) while the field is empty, results by scope as plain rows (the name and
 *  @имя), and a glass strip of scopes — «Чаты · Сообщения · Люди · Каналы» — riding above the keyboard where the bar
 *  was. A swipe to the right closes it, as the ✕ does.
 *
 *  «Сообщения» looks in the decrypted history kept on this device only: nothing about it is sent to the server. */
@SuppressLint("ViewConstructor")
class ChatSearchScreen(
  context: Context,
  private val messenger: Messenger?,
  private val chats: List<ChatListActions.Chat>,
  private var query: String,
) : Screen(context) {
  enum class Scope { CHATS, MESSAGES, PEOPLE, CHANNELS }

  /** One line of the results. */
  class Row(
    val key: String, val title: String, val sub: String,
    val person: Person? = null, val community: CommunitySummary? = null, val saved: Boolean = false,
    /** «Сообщения»: the chat a group of found messages belongs to. */
    val header: Boolean = false,
    /** «Сообщения»: a found message (with its date at the right). */
    val date: String? = null,
    val run: () -> Unit,
  )

  private class Hit(val chatId: String, val clientId: String, val senderId: String, val text: String, val sentAt: String)

  companion object {
    val scopes = listOf(Scope.CHATS to "Чаты", Scope.MESSAGES to "Сообщения", Scope.PEOPLE to "Люди", Scope.CHANNELS to "Каналы")
    const val RECENT_LIMIT = 15
    private const val PREFS = "linea.recent-search"
    private val ru = Locale.forLanguageTag("ru-RU")

    /** The reference's key of «Недавние» for an account. */
    fun recentKey(userId: String?): String = "linea.recent-search.v1:" + (userId ?: "sample")

    /** The words around the first place the needle stands (at most 90 letters; «…» when the start is cut). */
    fun snippet(text: String, needle: String): String {
      val flat = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
      val at = flat.lowercase(ru).indexOf(needle)
      if (at < 0) return flat.take(90)
      if (at > 24) return "…" + flat.drop(at - 20).take(90)
      return flat.take(90)
    }

    /** The id an item of «Недавние» is known by: «u:<id>» for a person, «c:<id>» for a community. */
    fun recentId(item: Map<String, Any?>): String {
      if (item["kind"] == "user") return "u:" + ((Core.map(item["user"] as? Map<*, *>)?.get("id") as? String) ?: "")
      return "c:" + ((Core.map(item["community"] as? Map<*, *>)?.get("id") as? String) ?: "")
    }

    /** `item` first, without an older copy of it, at most 15. */
    fun remembered(recent: List<Map<String, Any?>>, item: Map<String, Any?>): List<Map<String, Any?>> {
      val id = recentId(item)
      return (listOf(item) + recent.filter { recentId(it) != id }).take(RECENT_LIMIT)
    }

    /** The words shown when there are no rows. */
    fun emptyWords(wanted: String, scope: Scope): String =
      if (wanted.isNotEmpty()) {
        if (scope == Scope.PEOPLE && wanted.length < 2) "Введи хотя бы 2 буквы @имени."
        else if (scope == Scope.MESSAGES) "В сохранённой на этом устройстве переписке такого нет." else "Ничего не нашли."
      } else {
        if (scope == Scope.MESSAGES) "Поиск по тексту сообщений и имени отправителя. История хранится только на этом устройстве."
        else "Здесь появятся чаты и каналы, которые ты открывал из поиска."
      }
  }

  /** Opens a chat after the search has closed (`focus`: the message to stand at; empty: none). */
  var openChat: ((String, String) -> Unit)? = null
  /** Opens the chat with a person who has none here yet (it is made). */
  var openPerson: ((Person) -> Unit)? = null
  var openSaved: (() -> Unit)? = null
  var openCommunity: ((String) -> Unit)? = null

  private val main = Handler(Looper.getMainLooper())
  private var scope = Scope.CHATS
  private var rows: List<Row> = emptyList()
  private var recent: List<Map<String, Any?>> = emptyList()
  private var people: List<Person>? = null
  private var peopleFor = ""
  private var peopleSoon: Runnable? = null
  private var hits: List<Hit> = emptyList()
  private var hitsFor = ""
  private var historyRun = 0
  private var closed = false

  private val page = GlassSource(context)
  private val fieldPill = GlassPill(context, page).apply { radius = 22f * d; placesChildren = false }
  private val searchIcon = ChatIconView(context, "search", 17f, Theme.muted)
  private val field = EditText(context)
  private val erase = object : View(context) {
    init { isClickable = true; isFocusable = true; contentDescription = "Стереть" }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun onDraw(canvas: Canvas) = PeopleIcons.draw(canvas, "clear", width / 2f, height / 2f, 18f * d, Theme.muted)
  }
  private val closePill = GlassPill(context, page).apply { radius = 22f * d }
  private val closeButton = ChatIconView(context, "xmark", 18f, Theme.text)
  private val list = ListView(context)
  private val recentHead = FrameLayout(context)
  private val recentWords = TextView(context)
  private val recentClear = TextView(context)
  private val emptyLabel = TextView(context)
  private val spinner = ProgressBar(context)
  private val scopeBar = GlassPill(context, page).apply { radius = 21f * d }
  private val scopeButtons = ArrayList<TextView>()
  private val channelsWatcher: (Unit) -> Unit = { if (scope == Scope.CHANNELS) refresh() }

  /** A small drawn picture (ChatIcons), as the chat's own parts use. */
  private class ChatIconView(context: Context, val symbol: String, private val size: Float, private val color: Int) : View(context) {
    private val d = resources.displayMetrics.density
    override fun getAccessibilityClassName(): CharSequence = if (isClickable) "android.widget.Button" else "android.view.View"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
    override fun onDraw(canvas: Canvas) = ChatIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed) Theme.alpha(color, 0.5f) else color)
  }

  private val adapter = object : BaseAdapter() {
    override fun getCount() = rows.size
    override fun getItem(position: Int) = rows[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val cell = convertView as? ChatSearchCell ?: ChatSearchCell(context)
      val row = rows[position]
      cell.show(row, messenger?.personAvatarAddress(row.person?.avatarId ?: "") ?: "")
      return cell
    }
  }

  init {
    setBackgroundColor(Theme.bg)
    addView(page)
    loadRecent()

    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Theme.alpha(Theme.accent, 0.14f))
    list.cacheColorHint = Color.TRANSPARENT
    list.isVerticalScrollBarEnabled = false
    list.clipToPadding = false
    list.setOnItemClickListener { _, _, position, _ -> rows.getOrNull(position - list.headerViewsCount)?.run?.invoke() }
    list.setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView?, state: Int) { if (state == AbsListView.OnScrollListener.SCROLL_STATE_TOUCH_SCROLL) hideKeyboard() }
      override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {}
    })
    page.addView(list)

    recentWords.text = "НЕДАВНИЕ"
    recentWords.textSize = 13f
    recentWords.typeface = Theme.weight(600)
    recentWords.letterSpacing = 0.3f / 13f
    recentWords.setTextColor(Theme.muted)
    recentWords.gravity = Gravity.CENTER_VERTICAL
    recentHead.addView(recentWords, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(20f)).apply { leftMargin = dp(16f); topMargin = dp(4f) })
    recentClear.text = "Очистить"
    recentClear.textSize = 14f
    recentClear.setTextColor(Theme.accent)
    recentClear.gravity = Gravity.CENTER_VERTICAL or Gravity.END
    recentClear.isClickable = true
    recentClear.isFocusable = true
    recentClear.setOnClickListener { clearRecent() }
    recentHead.addView(recentClear, FrameLayout.LayoutParams(dp(80f), dp(28f), Gravity.END).apply { rightMargin = dp(16f) })
    recentHead.layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, dp(4f + 20f + 6f))

    emptyLabel.textSize = 14f
    emptyLabel.setTextColor(Theme.muted)
    emptyLabel.gravity = Gravity.CENTER_HORIZONTAL
    page.addView(emptyLabel)
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent)
    spinner.visibility = View.GONE
    page.addView(spinner)

    addView(fieldPill)
    fieldPill.addView(searchIcon)
    field.setText(query)
    field.hint = "Поиск"
    field.setHintTextColor(Theme.muted)
    field.textSize = 17f
    field.setTextColor(Theme.text)
    field.background = null
    field.setPadding(0, 0, 0, 0)
    field.isSingleLine = true
    field.gravity = Gravity.CENTER_VERTICAL
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    field.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    field.contentDescription = "Поиск"
    field.setOnEditorActionListener { _, _, _ -> hideKeyboard(); true }
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) { typed() }
    })
    fieldPill.addView(field)
    erase.setOnClickListener { field.setText("") }
    fieldPill.addView(erase)
    addView(closePill)
    closeButton.contentDescription = "Закрыть поиск"
    closeButton.isClickable = true
    closeButton.isFocusable = true
    closeButton.setOnClickListener { close(null) }
    closePill.addView(closeButton)
    Bouncy.attach(closeButton, 0.84f, closePill)

    for ((index, item) in scopes.withIndex()) {
      val button = TextView(context)
      button.text = item.second
      button.textSize = 14f
      button.gravity = Gravity.CENTER
      button.maxLines = 1
      button.isClickable = true
      button.isFocusable = true
      button.setOnClickListener { scopeTapped(index) }
      scopeBar.addView(button)
      scopeButtons.add(button)
    }
    addView(scopeBar)
    // The emulator check: `--es chatsearchscope messages|people|channels` opens that scope.
    when (com.linea.messenger.chatactions.ChatActionsDemo.chatsearchscope) {
      "messages" -> scope = Scope.MESSAGES
      "people" -> scope = Scope.PEOPLE
      "channels" -> scope = Scope.CHANNELS
    }
    showScopes()
    list.adapter = adapter
    refresh()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ChannelsStore.changed.watch(channelsWatcher)
    // The emulator check (`--es chatsearch <words>`): the words are in, the keyboard stays away.
    if (query.isEmpty() && com.linea.messenger.chatactions.ChatActionsDemo.chatsearch == null) {
      field.requestFocus()
      field.post { keyboard()?.showSoftInput(field, 0) }
    }
  }

  override fun onDetachedFromWindow() {
    ChannelsStore.changed.unwatch(channelsWatcher)
    peopleSoon?.let { main.removeCallbacks(it) }
    super.onDetachedFromWindow()
  }

  // Layout

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(page, 0, 0, width, height)
    // ChatSearch.tsx: a row of the field (flex) and the ✕ (44), gap 10, 16 from the sides, 6 above, 10 under.
    val closeLeft = width - dp(16f) - dp(44f)
    put(closePill, closeLeft, top + dp(6f), dp(44f), dp(44f))
    closeButton.layout(0, 0, dp(44f), dp(44f))
    val pillWidth = maxOf(0, closeLeft - dp(10f) - dp(16f))
    put(fieldPill, dp(16f), top + dp(6f), pillWidth, dp(44f))
    val hasWords = field.text.isNotEmpty()
    erase.visibility = if (hasWords) View.VISIBLE else View.GONE
    fun inner(view: View, left: Int, w: Int) {
      view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, w), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(44f), MeasureSpec.EXACTLY))
      view.layout(left, 0, left + maxOf(0, w), dp(44f))
    }
    inner(searchIcon, dp(13f), dp(19f))
    val fieldLeft = dp(13f + 19f + 8f)
    val fieldRight = if (hasWords) pillWidth - dp(13f + 18f + 8f) else pillWidth - dp(13f)
    inner(field, fieldLeft, fieldRight - fieldLeft)
    inner(erase, pillWidth - dp(13f + 26f), dp(30f))
    val y = top + dp(6f + 44f + 10f)

    // The scopes ride on top of the keyboard (8 above it), else 8 above the bottom's safe edge.
    val sizes = scopeButtons.map { button ->
      button.paint.typeface = Theme.weight(700)
      Math.ceil(button.paint.measureText(button.text.toString()).toDouble()).toInt() + dp(32f)
    }
    showScopes() // the measuring above used the bold face for every one
    val barWidth = minOf(width - dp(16f), sizes.sum() + dp(2f) * maxOf(0, scopeButtons.size - 1) + dp(8f))
    val floor = if (edges.keyboard > 0) height - edges.keyboard - dp(8f) else height - edges.bottom - dp(8f)
    put(scopeBar, (width - barWidth) / 2, floor - dp(42f), barWidth, dp(42f))
    var x = dp(4f)
    for ((index, button) in scopeButtons.withIndex()) {
      button.measure(MeasureSpec.makeMeasureSpec(sizes[index], MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(34f), MeasureSpec.EXACTLY))
      button.layout(x, dp(4f), x + sizes[index], dp(38f))
      x += sizes[index] + dp(2f)
    }

    list.setPadding(0, 0, 0, dp(90f) + edges.bottom)
    put(list, 0, y, width, maxOf(0, height - y))
    val emptyWidth = width - dp(80f)
    emptyLabel.measure(MeasureSpec.makeMeasureSpec(maxOf(0, emptyWidth), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    emptyLabel.layout(dp(40f), y + dp(40f), dp(40f) + emptyWidth, y + dp(40f) + emptyLabel.measuredHeight)
    put(spinner, width / 2 - dp(14f), y + dp(26f), dp(28f), dp(28f))
  }

  // Touches

  private fun keyboard() = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
  private fun hideKeyboard() { keyboard()?.hideSoftInputFromWindow(field.windowToken, 0) }

  /** Leaves the search (the list and the bar come back), then runs `then`. */
  private fun close(then: (() -> Unit)?) {
    if (closed) return
    closed = true
    hideKeyboard()
    val stack = pages()
    if (stack != null && parent != null) stack.pop(animated = false)
    then?.invoke()
  }

  private fun typed() {
    query = field.text.toString()
    refresh()
    requestLayout()
  }

  private fun scopeTapped(index: Int) {
    val chosen = scopes.getOrNull(index)?.first ?: return
    Haptic.light(this)
    scope = chosen
    showScopes()
    refresh()
  }

  private fun showScopes() {
    for ((index, button) in scopeButtons.withIndex()) {
      val chosen = scopes[index].first == scope
      button.typeface = Theme.weight(if (chosen) 700 else 500)
      button.setTextColor(if (chosen) Theme.text else Theme.muted)
      button.background = if (chosen) GradientDrawable().apply { setColor(Theme.alpha(Theme.accent, 0.14f)); cornerRadius = 17f * d } else null
      button.isSelected = chosen
    }
  }

  // Recent

  private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun loadRecent() {
    val raw = try { prefs().getString(recentKey(messenger?.userId), null) } catch (_: Exception) { null }
    recent = (Core.value(raw) as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }.take(RECENT_LIMIT)
  }

  private fun saveRecent() {
    val text = Core.text(recent) ?: return
    prefs().edit().putString(recentKey(messenger?.userId), text).apply()
  }

  private fun remember(item: Map<String, Any?>) {
    recent = remembered(recent, item)
    saveRecent()
  }

  private fun remember(person: Person) {
    val hex = String.format(Locale.ROOT, "#%06X", person.avatarColor and 0xFFFFFF)
    remember(mapOf("kind" to "user", "user" to mapOf("id" to person.id, "displayName" to person.displayName, "username" to person.username, "avatarId" to person.avatarId, "avatarColor" to hex)))
  }

  private fun remember(community: CommunitySummary) {
    remember(mapOf("kind" to "community", "community" to mapOf("id" to community.id, "name" to community.name, "kind" to community.kind, "avatarId" to community.avatarId)))
  }

  private fun clearRecent() {
    Haptic.light(this)
    recent = emptyList()
    prefs().edit().remove(recentKey(messenger?.userId)).apply()
    refresh()
  }

  // Opening

  private fun person(chat: ChatListActions.Chat): Person {
    Person.from(chat.chat["peer"])?.let { return it }
    val color = ((chat.row["avatarColor"] as? Number)?.toInt() ?: 0x4B73BB) and 0xFFFFFF
    return Person(chat.peerId, "", chat.title, "", "", color, "")
  }

  private fun open(person: Person) {
    remember(person)
    val chat = chats.firstOrNull { it.peerId == person.id }
    if (chat != null) {
      val go = openChat
      close { go?.invoke(chat.id, "") }
      return
    }
    val make = openPerson
    close { make?.invoke(person) }
  }

  private fun open(community: CommunitySummary) {
    remember(community)
    val go = openCommunity
    close { go?.invoke(community.id) }
  }

  private fun open(chatId: String, peer: Person, clientId: String) {
    remember(peer)
    val go = openChat
    close { go?.invoke(chatId, clientId) }
  }

  private fun goSaved() {
    val go = openSaved
    close { go?.invoke() }
  }

  // The rows

  private val needle: String get() = query.trim().lowercase(ru)

  private fun refresh() {
    val wanted = needle
    val made = ArrayList<Row>()
    var loading = false
    if (wanted.isEmpty()) {
      for (item in recent) {
        val user = Core.map(item["user"] as? Map<*, *>)
        val found = if (item["kind"] == "user") Person.from(user) else null
        if (found != null) {
          made.add(Row(recentId(item), found.displayName, "@" + found.username, person = found) { open(found) })
          continue
        }
        val fields = Core.map(item["community"] as? Map<*, *>) ?: continue
        val id = fields["id"] as? String ?: continue
        val name = fields["name"] as? String ?: ""
        val kind = fields["kind"] as? String ?: "server"
        val summary = ChannelsStore.list?.firstOrNull { it.id == id }
          ?: CommunitySummary(id, kind, "", false, name, "", fields["avatarId"] as? String ?: "", "", 0, true, 0, "", false, 0, 0)
        made.add(Row(recentId(item), name, if (kind == "blog") "канал" else "сервер", community = summary) { open(summary) })
      }
    } else when (scope) {
      Scope.CHATS -> {
        if ("избранное".contains(wanted)) made.add(Row("saved", "Избранное", "Заметки и сохранённое", saved = true) { goSaved() })
        for (chat in chats) {
          val peer = person(chat)
          if ((peer.displayName + " " + peer.username).lowercase(ru).contains(wanted)) {
            made.add(Row(chat.id, peer.displayName, if (peer.username.isEmpty()) "" else "@" + peer.username, person = peer) { open(peer) })
          }
        }
        // Words in the last message of each chat and in the notes of «Избранное» (both already decrypted here).
        if (wanted.length >= 2) {
          for (chat in chats) {
            val line = chat.row["preview"] as? String ?: ""
            if (line.isEmpty() || !line.lowercase(ru).contains(wanted)) continue
            val peer = person(chat)
            made.add(Row("m:" + chat.id, peer.displayName, snippet(line, wanted), person = peer) { open(peer) })
          }
          val notes = SavedMessages.shared(messenger)?.items ?: emptyList()
          for (item in notes.asReversed()) {
            if (made.size > 60) break
            val text = item["text"] as? String ?: continue
            if (!text.lowercase(ru).contains(wanted)) continue
            made.add(Row("s:" + made.size, "Избранное", snippet(text, wanted), saved = true) { goSaved() })
          }
        }
      }
      Scope.MESSAGES -> {
        if (hitsFor != wanted) {
          searchHistory(wanted)
          loading = messenger != null
        }
        val order = ArrayList<String>()
        val groups = HashMap<String, ArrayList<Hit>>()
        for (hit in hits) {
          if (!groups.containsKey(hit.chatId)) order.add(hit.chatId)
          val group = groups.getOrPut(hit.chatId) { ArrayList() }
          if (group.size < 30) group.add(hit)
        }
        val now = Instant.now(); val zone = ZoneId.systemDefault()
        for (chatId in order) {
          val chat = chats.firstOrNull { it.id == chatId } ?: continue
          val peer = person(chat)
          made.add(Row("h:$chatId", peer.displayName, "", person = peer, header = true) { open(peer) })
          for (hit in groups[chatId].orEmpty()) {
            val who = if (hit.senderId == messenger?.userId) "Ты" else peer.displayName
            made.add(Row("g:" + hit.chatId + ":" + hit.clientId, who, snippet(hit.text, wanted), date = Messenger.listTime(hit.sentAt, now, zone)) {
              open(hit.chatId, peer, hit.clientId)
            })
          }
        }
      }
      Scope.PEOPLE -> {
        if (wanted.length >= 2) {
          if (peopleFor != wanted) askPeople(wanted)
          val found = people
          if (found != null && peopleFor == wanted) {
            for (person in found) if (person.id != messenger?.userId) made.add(Row(person.id, person.displayName, "@" + person.username, person = person) { open(person) })
          } else loading = true
        }
      }
      Scope.CHANNELS -> {
        val all = ChannelsStore.list
        if (all != null) {
          for (item in all) if (item.name.lowercase(ru).contains(wanted)) {
            val sub = if (item.blog) "канал · ${item.memberCount} подписч." else "сервер · ${item.memberCount} участн."
            made.add(Row(item.id, item.name, sub, community = item) { open(item) })
          }
        } else {
          loading = messenger != null
          ChannelsStore.reload()
        }
      }
    }
    rows = made
    val wantsHead = wanted.isEmpty() && made.isNotEmpty()
    if (wantsHead && list.headerViewsCount == 0) list.addHeaderView(recentHead, null, false)
    if (!wantsHead && list.headerViewsCount > 0) list.removeHeaderView(recentHead)
    spinner.visibility = if (loading && made.isEmpty()) View.VISIBLE else View.GONE
    emptyLabel.text = emptyWords(wanted, scope)
    emptyLabel.visibility = if (made.isEmpty() && !loading) View.VISIBLE else View.GONE
    adapter.notifyDataSetChanged()
    requestLayout()
  }

  /** «Люди»: the server's people search, 300 ms after the last letter. */
  private fun askPeople(wanted: String) {
    peopleFor = wanted
    people = null
    peopleSoon?.let { main.removeCallbacks(it) }
    val work = Runnable {
      if (peopleFor != wanted) return@Runnable
      val messenger = messenger
      if (messenger == null) {
        // The debug build's sample people; none in a release build.
        val plain = wanted.replace("@", "")
        people = ChatsPlusDemo.people().filter { (it.displayName + " " + it.username).lowercase(ru).contains(plain) }
        refresh()
        return@Runnable
      }
      messenger.findPeople(wanted) { result ->
        main.post {
          if (peopleFor != wanted) return@post
          people = result.getOrNull() ?: emptyList()
          refresh()
        }
      }
    }
    peopleSoon = work
    main.postDelayed(work, 300)
  }

  /** «Сообщения»: the history kept on this device, newest first, without hidden messages and actions. */
  private fun searchHistory(wanted: String) {
    hitsFor = wanted
    hits = emptyList()
    historyRun += 1
    val messenger = messenger ?: return
    if (wanted.isEmpty()) return
    val run = historyRun
    val known = chats.map { it.id }.toSet()
    val hidden = ChatLocal.of(context, messenger).hiddenKeys.toSet()
    val names = chats.associate { it.id to it.title.lowercase(ru) }
    val me = messenger.userId
    messenger.crypto.run({ crypto: CryptoService ->
      val found = ArrayList<Hit>()
      val ids = (crypto.callNow("historyChats").getOrNull() as? List<*>).orEmpty().mapNotNull { it as? String }
      for (chatId in ids) {
        if (!known.contains(chatId)) continue
        val kept = (crypto.callNow("history", listOf(chatId, 600)).getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }
        for (item in kept) {
          val clientId = item["clientId"] as? String ?: continue
          if (ChatHistory.action(item) != null || hidden.contains(ChatHistory.key(item))) continue
          val text = (item["text"] as? String ?: "").trim()
          val file = Core.map(item["attachment"] as? Map<*, *>)?.get("name") as? String ?: ""
          val shown = if (text.isEmpty()) file else text
          val sender = item["senderId"] as? String ?: ""
          val senderName = if (sender == me) "ты" else names[chatId] ?: ""
          if (shown.isEmpty() || !(shown.lowercase(ru).contains(wanted) || senderName.contains(wanted))) continue
          found.add(Hit(chatId, clientId, sender, shown, item["sentAt"] as? String ?: ""))
        }
      }
      found.sortedByDescending { it.sentAt }.take(150)
    }, { found ->
      if (run == historyRun) {
        hits = found
        refresh()
      }
    })
  }
}

/** One row of the search: a 44 dp avatar (a person, a community, «Избранное» or a found message's bubble), the name in
 *  16 dp semibold and the line under it in 13 dp; a chat's heading over its found messages: a 28 dp avatar and the name
 *  in 15 dp bold. */
@SuppressLint("ViewConstructor")
class ChatSearchCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val personAvatar = PersonAvatarView(context)
  private val communityAvatar = CommunityAvatarView(context)
  private var badgeSymbol = ""
  private var badgeFill = 0
  private var badgeInk = 0
  private val badge = object : View(context) {
    private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
      paint.color = badgeFill
      canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, paint)
      ChatIcons.draw(canvas, badgeSymbol, width / 2f, height / 2f, 20f * d, badgeInk)
    }
  }
  private val title = TextView(context)
  private val sub = TextView(context)
  private val date = TextView(context)
  private var isHeader = false

  init {
    addView(personAvatar); addView(communityAvatar); addView(badge)
    title.setTextColor(Theme.text); title.maxLines = 1; title.ellipsize = TextUtils.TruncateAt.END; title.includeFontPadding = false; title.gravity = Gravity.CENTER_VERTICAL
    addView(title)
    sub.textSize = 13f; sub.setTextColor(Theme.muted); sub.maxLines = 1; sub.ellipsize = TextUtils.TruncateAt.END; sub.includeFontPadding = false
    addView(sub)
    date.textSize = 12f; date.setTextColor(Theme.muted); date.maxLines = 1; date.gravity = Gravity.END; date.includeFontPadding = false
    addView(date)
  }

  fun show(row: ChatSearchScreen.Row, address: String) {
    isHeader = row.header
    title.text = row.title
    title.textSize = if (row.header) 15f else 16f
    title.typeface = Theme.weight(if (row.header) 700 else 600)
    sub.text = row.sub
    sub.visibility = if (row.header) View.GONE else View.VISIBLE
    date.text = row.date ?: ""
    date.visibility = if (row.date == null) View.GONE else View.VISIBLE
    personAvatar.visibility = View.GONE
    communityAvatar.visibility = View.GONE
    badge.visibility = View.GONE
    val person = row.person
    val community = row.community
    if (row.date != null) {
      badge.visibility = View.VISIBLE
      badgeFill = Theme.alpha(Theme.accent, 0.14f); badgeSymbol = "bubble"; badgeInk = Theme.accent
    } else if (person != null) {
      personAvatar.visibility = View.VISIBLE
      personAvatar.show(person, address)
    } else if (community != null) {
      communityAvatar.visibility = View.VISIBLE
      communityAvatar.show(community)
    } else {
      badge.visibility = View.VISIBLE
      badgeFill = Theme.accent; badgeSymbol = "bookmark.fill"; badgeInk = Theme.onAccent
    }
    badge.invalidate()
    contentDescription = listOf(row.title, row.sub, row.date ?: "").filter { it.isNotEmpty() }.joinToString(", ")
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(if (isHeader) 12f + 28f + 4f else 7f + 44f + 7f))
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxOf(0, height), MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    if (isHeader) {
      put(personAvatar, dp(16f), dp(12f), dp(28f), dp(28f))
      put(title, dp(16f + 28f + 10f), dp(12f), width - dp(54f + 16f), dp(28f))
      return
    }
    for (avatar in listOf(personAvatar, communityAvatar, badge)) put(avatar, dp(16f), dp(7f), dp(44f), dp(44f))
    val textX = dp(16f + 44f + 12f)
    var dateWidth = 0
    if (date.visibility == View.VISIBLE) {
      date.measure(MeasureSpec.makeMeasureSpec(dp(120f), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      dateWidth = date.measuredWidth
    }
    put(title, textX, dp(9f), width - textX - dp(16f) - (if (dateWidth > 0) dateWidth + dp(5f) else 0), dp(21f))
    put(date, width - dp(16f) - dateWidth, dp(10f), dateWidth, dp(18f))
    put(sub, textX, dp(31f), width - textX - dp(16f), dp(17f))
  }
}
