package com.linea.messenger.people

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.text.Editable
import android.text.InputFilter
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
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import com.linea.messenger.design.titled
import com.linea.messenger.net.Server
import com.linea.messenger.shell.Screen

/** What the list of «Люди» shows, row by row: plain rules, so they can be checked without a phone. */
object PeopleList {
  sealed class Item {
    data class Label(val words: String) : Item()
    data class Notice(val words: String) : Item()
    data class Request(val person: Person, val incoming: Boolean) : Item()
    data class Friend(val person: Person) : Item()
    data class Empty(val heading: String, val words: String) : Item()
    /** The 12 between the requests and the people (the screen puts it in; the rules do not). */
    object Gap : Item()
  }

  /** A search begins with two characters. */
  fun isSearch(query: String): Boolean = query.length >= 2

  /** `query`: what is typed, trimmed. `problem`: the words of what did not work. `searching`: an answer is awaited. */
  fun items(query: String, problem: String, searching: Boolean, incoming: List<Person>, outgoing: List<Person>, friends: List<Person>, found: List<Person>): List<Item> {
    val list = ArrayList<Item>()
    if (problem.isNotEmpty()) list.add(Item.Notice(problem))
    val search = isSearch(query)
    if (!search) {
      if (incoming.isNotEmpty()) {
        list.add(Item.Label("ЗАЯВКИ В ДРУЗЬЯ  ${incoming.size}"))
        for (person in incoming) list.add(Item.Request(person, incoming = true))
      }
      if (outgoing.isNotEmpty()) {
        list.add(Item.Label("ОТПРАВЛЕННЫЕ  ${outgoing.size}"))
        for (person in outgoing) list.add(Item.Request(person, incoming = false))
      }
    }
    val shown = if (search) found else friends
    if (shown.isNotEmpty()) {
      list.add(Item.Label(if (search) "РЕЗУЛЬТАТЫ ПОИСКА" else "ДРУЗЬЯ  ${friends.size}"))
      for (person in shown) list.add(Item.Friend(person))
    } else if (!searching) {
      if (!search) {
        list.add(Item.Empty("Кому напишем?", "Введи @имя целиком или его первые 4 символа, либо имя полностью."))
      } else {
        val name = query.removePrefix("@")
        val words = if (name.length < 4) "По началу @имени ищется с 4 символов. Введи ещё или напиши @имя целиком." else "По этому запросу никого нет. Проверь написание @имени."
        list.add(Item.Empty("Пока никого", words))
      }
    }
    return list
  }

  /** The line under a person's name in a row of requests. */
  fun requestHandle(person: Person, incoming: Boolean): String = if (incoming) "@${person.username}" else "@${person.username} · Ждёт ответа"
}

/** The «Люди» section: friends, requests to be friends, and the search of people by @username or name.
 *  Ported from the reference's PeopleScreen.tsx (its «Звонки» half waits for calls). */
@SuppressLint("ViewConstructor")
class PeopleScreen(
  context: Context,
  /** The account whose people are shown; null shows the debug build's samples (or nothing in a release one). */
  private val messenger: Messenger?,
) : Screen(context) {
  // B: the reference's header — «Люди» and its quiet line in a glass pill (GlassSurface «clear», radius 27, 14 from the
  // sides, 12 under the safe area, 10 inside, at least 72 tall; the name 26 on a 32 line, the line 11) — and the
  // search on glass (radius 24, at least 54 tall).
  private val header = com.linea.messenger.design.GlassHeaderView(context, "Люди", "Друзья, заявки и поиск по @имени", titleSize = Theme.TypeSize.sectionTitle,
    lineHeight = Theme.TypeSize.sectionTitleLine, subtitleSize = 11f, padding = 10f, minHeight = 72f, clear = true)
  private val caption: TextView get() = header.subtitleLabel
  private val searchBox = com.linea.messenger.design.GlassSearchField(context)
  private val field = EditText(context)
  private val clearButton = PeopleRoundButton(context, "close-circle", RoundIconButton.Look.PLAIN, 18f)
  /** What did not work (the reference's `Notice error`), above the list, 17 from the sides. */
  private val notice = PeopleNoticeView(context)
  /** «ДРУЗЬЯ  5» / «РЕЗУЛЬТАТЫ ПОИСКА»: above the list, not in it (it does not scroll), 26 from the left. */
  private val listLabel = PeopleLabelCell(context)
  private val spinner = ProgressBar(context)
  private val list = ListView(context)

  private var items: List<PeopleList.Item> = emptyList()
  private var friends: List<Person> = emptyList()
  private var found: List<Person> = emptyList()
  private var demoIncoming: List<Person> = emptyList()
  private var demoOutgoing: List<Person> = emptyList()
  private var searching = false
  private var problem = ""
  private var sequence = 0
  /** The person whose request is being answered, and the one a chat is being opened with. */
  private var acting: String? = null
  private var creating: String? = null
  /** The page is in the window and not covered by another one. */
  private var showing = false
  private var profileWanted = false
  private val requestsChanged: (Unit) -> Unit = { loadFriends(); rebuild() }
  /** ChatsPlus: «Друзья | Звонки» and the list of recent calls (chatsplus/CallHistory.kt). */
  private val calls = com.linea.messenger.chatsplus.CallHistoryPanel(context, messenger)

  private val incoming: List<Person> get() = if (messenger == null) demoIncoming else FriendRequests.incoming
  private val outgoing: List<Person> get() = if (messenger == null) demoOutgoing else FriendRequests.outgoing
  private val query: String get() = this.field.text.toString().trim()

  private val adapter = object : BaseAdapter() {
    override fun getCount() = items.size
    override fun getItem(position: Int) = items[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getViewTypeCount() = 3
    override fun getItemViewType(position: Int) = when (items[position]) {
      is PeopleList.Item.Label, is PeopleList.Item.Notice, PeopleList.Item.Gap -> 0
      is PeopleList.Item.Request, is PeopleList.Item.Friend -> 1
      is PeopleList.Item.Empty -> 2
    }
    override fun areAllItemsEnabled() = false
    override fun isEnabled(position: Int) = getItemViewType(position) == 1
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = when (val item = items[position]) {
      is PeopleList.Item.Label -> (convertView as? PeopleLabelCell ?: PeopleLabelCell(context)).apply { show(item.words, first = items.getOrNull(position - 1) !is PeopleList.Item.Request) }
      is PeopleList.Item.Notice -> (convertView as? PeopleLabelCell ?: PeopleLabelCell(context)).apply { show("", first = true) }
      PeopleList.Item.Gap -> (convertView as? PeopleLabelCell ?: PeopleLabelCell(context)).apply { gap() }
      is PeopleList.Item.Empty -> (convertView as? PeopleEmptyCell ?: PeopleEmptyCell(context)).apply { room = list.height - list.paddingBottom; show(item.heading, item.words) }
      is PeopleList.Item.Request -> (convertView as? PersonCell ?: PersonCell(context)).apply {
        val person = item.person
        val buttons = if (item.incoming) listOf(
          PersonCell.Action("checkmark", "Принять: ${person.displayName}", RoundIconButton.Look.PRIMARY) { answer(person, accept = true) },
          PersonCell.Action("close", "Отклонить: ${person.displayName}", RoundIconButton.Look.OUTLINE) { answer(person, accept = false) },
        ) else listOf(
          PersonCell.Action("close", "Отменить заявку: ${person.displayName}", RoundIconButton.Look.OUTLINE) { answer(person, accept = false) },
        )
        show(person, address(person), PeopleList.requestHandle(person, item.incoming), framed = true, dimmed = acting != null && acting != person.id,
          busy = acting == person.id, enabled = acting == null, actions = buttons)
        contentDescription = "Профиль ${person.displayName}"
      }
      is PeopleList.Item.Friend -> (convertView as? PersonCell ?: PersonCell(context)).apply {
        val person = item.person
        val buttons = listOf(
          PersonCell.Action("information-circle-outline", "Профиль ${person.displayName}", RoundIconButton.Look.PLAIN) { showProfile(person) },
          PersonCell.Action("chatbubble-outline", "Написать: ${person.displayName}", RoundIconButton.Look.SOFT) { openChat(person) },
        )
        show(person, address(person), "@${person.username}", framed = false, dimmed = creating != null && creating != person.id,
          busy = creating == person.id, enabled = creating == null, actions = buttons)
        contentDescription = person.displayName
      }
    }
  }

  init {
    setBackgroundColor(Theme.bg)

    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Color.TRANSPARENT); list.cacheColorHint = Color.TRANSPARENT
    list.isVerticalScrollBarEnabled = false; list.clipToPadding = false
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ ->
      when (val item = items.getOrNull(position)) {
        is PeopleList.Item.Request -> showProfile(item.person)
        is PeopleList.Item.Friend -> openChat(item.person)
        else -> {}
      }
    }
    // Dragging the list puts the keyboard away.
    list.setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView?, state: Int) { if (state == AbsListView.OnScrollListener.SCROLL_STATE_TOUCH_SCROLL) hideKeyboard() }
      override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {}
    })
    addView(list)

    addView(header)

    addView(searchBox)
    notice.visibility = View.GONE
    addView(notice)
    listLabel.visibility = View.GONE
    addView(listLabel)
    field.hint = "@имя или имя"
    field.setHintTextColor(Theme.muted)
    field.setTextColor(Theme.text)
    field.textSize = 15f
    field.background = null
    field.setPadding(0, 0, 0, 0)
    field.maxLines = 1
    field.isSingleLine = true
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    field.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    field.gravity = Gravity.CENTER_VERTICAL
    field.filters = arrayOf(InputFilter.LengthFilter(50))
    field.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_SEARCH) { hideKeyboard(); true } else false }
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) = queryChanged()
    })
    searchBox.addView(field)
    clearButton.contentDescription = "Очистить поиск"
    clearButton.setOnClickListener { field.setText("") }
    clearButton.visibility = View.GONE
    searchBox.addView(clearButton)
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.accent)
    spinner.visibility = View.GONE
    searchBox.addView(spinner)
    calls.install(this, caption) // ChatsPlus

    if (messenger != null) {
      lastFriends?.takeIf { it.first == messenger.userId }?.let { friends = it.second }
    } else {
      friends = PeopleDemo.friends
      demoIncoming = PeopleDemo.incoming
      demoOutgoing = PeopleDemo.outgoing
    }
    rebuild()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (messenger != null) FriendRequests.changed.watch(requestsChanged)
    calls.attached() // ChatsPlus
    appeared()
  }

  override fun onDetachedFromWindow() {
    FriendRequests.changed.unwatch(requestsChanged)
    calls.detached() // ChatsPlus
    showing = false
    super.onDetachedFromWindow()
  }

  /** A page that covered the section was closed: it is seen again. */
  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    appeared()
  }

  /** Reads the friends and the requests again each time the section comes into view. */
  private fun appeared() {
    val seen = isAttachedToWindow && isShown
    if (seen && !showing && messenger != null) {
      messenger.preparePersonAvatars()
      loadFriends()
      FriendRequests.refresh()
    }
    showing = seen
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(header, dp(14f), top + dp(12f), width - dp(28f), dp(72f))
    // ChatsPlus: the switch «Друзья | Звонки» stands between the header and the search (14 under the pill).
    val boxTop = calls.place(width, height, top + dp(12f + 72f + 2f), edges.bottom) + dp(14f); val boxWidth = width - dp(34f); val boxHeight = dp(54f)
    // The clear button: `IconButton` 30 wide, 44 tall, at the end of the row (paddingHorizontal 15, gap 10).
    place(clearButton, boxWidth - dp(45f), dp(5f), dp(30f), dp(44f))
    place(spinner, boxWidth - dp(45f) + dp(5f), dp(5f) + dp(12f), dp(20f), dp(20f))
    place(field, searchBox.wordsLeft, 0, boxWidth - searchBox.wordsLeft - dp(55f), boxHeight)
    put(searchBox, dp(17f), boxTop, boxWidth, boxHeight)
    var listTop = boxTop + boxHeight + dp(17f)
    if (notice.visibility == View.VISIBLE) {
      val tall = notice.heightFor(width - dp(34f))
      put(notice, dp(17f), listTop, width - dp(34f), tall)
      listTop += tall + dp(12f)
    }
    if (listLabel.visibility == View.VISIBLE) {
      listLabel.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      val tall = listLabel.measuredHeight
      put(listLabel, 0, listTop, width, tall)
      listTop += tall
    }
    val barRoom = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 12f)
    // Above the keyboard when it is up, above the bar otherwise.
    val bottom = maxOf(barRoom, edges.keyboard + dp(12f))
    if (list.paddingBottom != bottom) list.setPadding(0, 0, 0, bottom)
    put(list, 0, listTop, width, height - listTop)
  }

  /** A part of the search box at an exact place and size (the box lays nothing out itself). */
  private fun place(view: View, left: Int, top: Int, width: Int, height: Int) {
    val now = view.layoutParams as? FrameLayout.LayoutParams
    // Only a change is a new layout: a part put where it already is asks for nothing.
    if (now != null && now.width == width.coerceAtLeast(0) && now.height == height.coerceAtLeast(0) && now.leftMargin == left && now.topMargin == top) return
    view.layoutParams = FrameLayout.LayoutParams(width.coerceAtLeast(0), height.coerceAtLeast(0)).apply { leftMargin = left; topMargin = top }
  }

  private fun hideKeyboard() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
    field.clearFocus()
  }

  // Reading

  private fun loadFriends() {
    val messenger = messenger ?: return
    messenger.friends { result ->
      val people = result.getOrNull() ?: return@friends
      friends = people
      lastFriends = messenger.userId to people
      rebuild()
      emulatorProfileIfWanted()
    }
  }

  private fun queryChanged() {
    sequence += 1
    val mine = sequence
    val wanted = query
    if (!PeopleList.isSearch(wanted)) {
      found = emptyList()
      searching = false
      problem = ""
      rebuild()
      return
    }
    searching = true
    rebuild()
    postDelayed({
      if (mine != sequence) return@postDelayed
      val messenger = messenger
      if (messenger == null) {
        found = PeopleDemo.find(wanted)
        searching = false
        rebuild()
        return@postDelayed
      }
      messenger.findPeople(wanted) { result ->
        if (mine != sequence) return@findPeople
        val people = result.getOrNull()
        if (people != null) { found = people; problem = "" } else problem = Server.error(result).words
        searching = false
        rebuild()
      }
    }, 300)
  }

  // The list

  private fun rebuild() {
    spinner.visibility = if (searching) View.VISIBLE else View.GONE
    clearButton.visibility = if (searching || field.text.isEmpty()) View.GONE else View.VISIBLE
    // The rules give the list as one column; the reference shows what did not work and the heading of the people
    // above the list (they do not scroll), the people's heading above the requests, and 12 after the requests.
    val all = PeopleList.items(query, problem, searching, incoming, outgoing, friends, found)
    val wrong = all.firstOrNull { it is PeopleList.Item.Notice } as? PeopleList.Item.Notice
    val headIndex = all.indexOfFirst { it is PeopleList.Item.Label && all.getOrNull(all.indexOf(it) + 1) is PeopleList.Item.Friend }
    val head = all.getOrNull(headIndex) as? PeopleList.Item.Label
    val rows = ArrayList<PeopleList.Item>()
    all.forEachIndexed { index, item ->
      if (item is PeopleList.Item.Notice || index == headIndex) return@forEachIndexed
      if (item is PeopleList.Item.Friend && rows.lastOrNull() is PeopleList.Item.Request) rows.add(PeopleList.Item.Gap)
      if (item is PeopleList.Item.Empty && rows.lastOrNull() is PeopleList.Item.Request) rows.add(PeopleList.Item.Gap)
      rows.add(item)
    }
    if (rows.lastOrNull() is PeopleList.Item.Request) rows.add(PeopleList.Item.Gap)
    notice.show(wrong?.words ?: "")
    notice.visibility = if (wrong == null) View.GONE else View.VISIBLE
    if (head != null) listLabel.show(head.words, first = true, outside = true)
    listLabel.visibility = if (head == null) View.GONE else View.VISIBLE
    items = rows
    adapter.notifyDataSetChanged()
    requestLayout()
  }

  private fun address(person: Person): String = messenger?.personAvatarAddress(person.avatarId) ?: ""

  // What the person does

  private fun showProfile(person: Person) {
    hideKeyboard()
    pages()?.push(PersonProfileScreen(context, messenger, person.id, person.displayName, person))
  }

  private fun openChat(person: Person) {
    if (creating != null) return
    val messenger = messenger
    if (messenger == null) {
      // The sample chat of the debug build; nothing in a release one.
      val stack = pages() ?: return
      if (PeopleDemo.present) stack.push(ChatScreen(context, person.displayName) { stack.pop() })
      return
    }
    creating = person.id
    problem = ""
    rebuild()
    messenger.openChat(person, this) { error ->
      creating = null
      if (error != null) problem = error.words else hideKeyboard()
      rebuild()
    }
  }

  /** «Принять», «Отклонить», «Отменить заявку». */
  private fun answer(person: Person, accept: Boolean) {
    if (acting != null) return
    val messenger = messenger
    if (messenger == null) {
      demoIncoming = demoIncoming.filter { it.id != person.id }
      demoOutgoing = demoOutgoing.filter { it.id != person.id }
      if (accept) friends = friends + person
      rebuild()
      return
    }
    acting = person.id
    problem = ""
    rebuild()
    val done: (com.linea.messenger.net.ServerError?) -> Unit = { error ->
      acting = null
      if (error != null) problem = error.words
      rebuild()
      FriendRequests.refresh()
    }
    if (accept) messenger.acceptFriend(person.id, done) else messenger.dropFriendRequest(person.id, done)
  }

  // The emulator check

  /** Fills the search field in and searches. */
  fun emulatorSearch(text: String) { field.setText(text) }

  /** Opens the profile of the first friend when the friends are read; without friends — of the first request,
   *  else of the person of the first chat. */
  fun emulatorOpenFirstProfile() {
    profileWanted = true
    if (messenger == null) emulatorProfileIfWanted()
  }

  private fun emulatorProfileIfWanted() {
    if (!profileWanted) return
    profileWanted = false
    (friends.firstOrNull() ?: incoming.firstOrNull() ?: outgoing.firstOrNull())?.let { return showProfile(it) }
    messenger?.chats { result ->
      val chat = result.getOrNull()?.firstOrNull() ?: return@chats
      pages()?.push(PersonProfileScreen(context, messenger, chat.peerId, chat.title))
    }
  }

  companion object {
    /** A failed reading (no network) keeps the friends shown last time in this run of the app: the owner's id and the list. */
    private var lastFriends: Pair<String, List<Person>>? = null
  }
}

/** A quiet heading («ДРУЗЬЯ  5», «ЗАЯВКИ В ДРУЗЬЯ  2»): 10, bold, 1.7 apart, 26 from the left. In the list (a
 *  requests' heading): 4 above (and 6 more above the second section), 10 under; above the list: 12 under. */
class PeopleLabelCell(context: Context) : TextView(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  init {
    includeFontPadding = false
    textSize = 10f
    typeface = Theme.weight(700)
    letterSpacing = 1.7f / 10f
    setTextColor(Theme.muted)
    maxLines = 1
  }

  fun show(words: String, first: Boolean, outside: Boolean = false) {
    text = words
    gravity = Gravity.START or Gravity.TOP
    setPadding(dp(26f), if (outside) 0 else dp(if (first) 4f else 10f), dp(26f), dp(if (outside) 12f else 10f))
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
    if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = words.isNotEmpty()
  }

  /** The 12 after the requests. */
  fun gap() {
    text = ""
    setPadding(0, 0, 0, 0)
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, dp(12f))
  }
}

/** What did not work (the reference's `Notice` with `error`): glass of radius 18 under the danger tint, the
 *  `alert-circle-outline` (19) and the words (13 on 19) in the danger colour, 14 inside, 10 between. */
class PeopleNoticeView(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val words = TextView(context)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    setWillNotDraw(false)
    words.textSize = 13f
    words.includeFontPadding = false
    if (android.os.Build.VERSION.SDK_INT >= 28) words.lineHeight = dp(19f)
    addView(words)
  }

  fun show(text: String) {
    words.text = text
    words.setTextColor(Theme.danger)
    contentDescription = text
    requestLayout(); invalidate()
  }

  fun heightFor(width: Int): Int {
    words.measure(MeasureSpec.makeMeasureSpec(maxOf(1, width - dp(28f + 19f + 10f)), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    return maxOf(dp(19f), words.measuredHeight) + dp(28f)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val inner = maxOf(1, (right - left) - dp(28f + 19f + 10f))
    words.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    words.layout(dp(14f + 19f + 10f), dp(14f), dp(14f + 19f + 10f) + inner, dp(14f) + words.measuredHeight)
  }

  override fun onDraw(canvas: Canvas) {
    val r = 18f * d
    paint.color = Theme.veil(0.06f)
    canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, paint)
    paint.color = com.linea.messenger.settings.ThemeStore.look.dangerBg
    canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, paint)
    IonIcon.draw(canvas, "alert-circle-outline", 14f * d + 9.5f * d, 14f * d + 9.5f * d, 19f * d, Theme.danger)
  }
}

/** «Кому напишем?» — the list is empty: the reference's `Empty` with `people-outline`, in the middle of the room
 *  left (`justifyContent: center`, 35 kept free under it). */
class PeopleEmptyCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val empty = com.linea.messenger.chatsplus.EmptyStateView(context)
  /** The room the list leaves for it (its own height, without the bar's padding). */
  var room = 0

  init { addView(empty) }

  fun show(title: String, text: String) {
    empty.show("ion:people-outline", title, text)
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val inner = width - Math.round(28f * d)
    setMeasuredDimension(width, maxOf(empty.contentHeight(inner), room - Math.round(35f * d)) + Math.round(35f * d))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val side = Math.round(14f * d)
    empty.measure(MeasureSpec.makeMeasureSpec(right - left - side * 2, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(bottom - top - Math.round(35f * d), MeasureSpec.EXACTLY))
    empty.layout(side, 0, right - left - side, bottom - top - Math.round(35f * d))
  }
}

/** One round button of a row (PeopleScreen.tsx): the info — `IconButton` 22 on clear glass 38 × 40; the chat —
 *  38 × 38, radius 18, the soft accent and the page's border; a request's — 38 round, the accent (`primary`) or the
 *  border; 19 each. Pressed: 0.6. */
class PeopleRoundButton(context: Context, private val symbol: String, private val look: RoundIconButton.Look, private val size: Float = if (look == RoundIconButton.Look.PLAIN) 22f else 19f) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var wasPressed = false

  init {
    isClickable = look != RoundIconButton.Look.SOFT // the chat button is a picture: the row opens the chat
    isFocusable = false
    if (look == RoundIconButton.Look.PLAIN) { background = com.linea.messenger.design.GlassDrawable(this); tag = "info" }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    // `IconButton` is a `Bouncy` (scale 0.86) with the reference's springs.
    if (look == RoundIconButton.Look.PLAIN && isPressed != wasPressed) { wasPressed = isPressed; if (isPressed) com.linea.messenger.chatlook.Bouncy.press(this, 0.86f) else com.linea.messenger.chatlook.Bouncy.release(this) }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    val dim = if ((isPressed && look != RoundIconButton.Look.PLAIN) || !isEnabled) 0.6f else 1f
    fun shade(color: Int) = Theme.alpha(color, (color ushr 24) / 255f * dim)
    val color = when (look) {
      RoundIconButton.Look.PLAIN -> Theme.muted
      RoundIconButton.Look.SOFT -> {
        paint.style = Paint.Style.FILL; paint.color = com.linea.messenger.settings.ThemeStore.look.accentSoft
        canvas.drawRoundRect(0f, 0f, w, h, 18f * d, 18f * d, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = d; paint.color = com.linea.messenger.settings.ThemeStore.look.border
        canvas.drawRoundRect(d / 2, d / 2, w - d / 2, h - d / 2, 18f * d, 18f * d, paint)
        Theme.accent
      }
      RoundIconButton.Look.PRIMARY -> { paint.style = Paint.Style.FILL; paint.color = shade(Theme.accent); canvas.drawCircle(w / 2, h / 2, minOf(w, h) / 2, paint); Theme.onAccent }
      RoundIconButton.Look.OUTLINE -> { paint.style = Paint.Style.STROKE; paint.strokeWidth = d; paint.color = shade(com.linea.messenger.settings.ThemeStore.look.border); canvas.drawCircle(w / 2, h / 2, minOf(w, h) / 2 - d / 2, paint); Theme.muted }
    }
    IonIcon.draw(canvas, symbol, w / 2, h / 2, size * d, shade(color))
  }
}

/** A person in the list: the picture (54), the name, the @username, and round buttons on the right. A request:
 *  12 inside, 12 between, radius 22, framed; a person: 14, 14, radius 24, the border and a veil only when pressed. */
class PersonCell(context: Context) : ViewGroup(context) {
  class Action(val symbol: String, val words: String, val look: RoundIconButton.Look, val run: () -> Unit)

  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val avatar = PersonAvatarView(context)
  private val nameLabel = TextView(context)
  private val handleLabel = TextView(context)
  /** Avatars: the person's emoji status after the name (avatars/StatusEmoji.kt). */
  private val statusEmoji = com.linea.messenger.avatars.StatusEmojiView(context)
  private val waiting = ProgressBar(context)
  private var buttons: List<PeopleRoundButton> = emptyList()
  private var framed = false
  private var busy = false

  init {
    setWillNotDraw(false)
    addView(avatar)
    nameLabel.typeface = Theme.weight(600)
    nameLabel.setTextColor(Theme.text)
    nameLabel.maxLines = 1
    nameLabel.ellipsize = TextUtils.TruncateAt.END
    nameLabel.includeFontPadding = false
    addView(nameLabel)
    handleLabel.textSize = 12f
    handleLabel.setTextColor(Theme.muted)
    handleLabel.maxLines = 1
    handleLabel.ellipsize = TextUtils.TruncateAt.END
    handleLabel.includeFontPadding = false
    addView(handleLabel)
    addView(statusEmoji) // Avatars
    waiting.isIndeterminate = true
    waiting.indeterminateTintList = ColorStateList.valueOf(Theme.accent)
    waiting.visibility = View.GONE
    addView(waiting)
  }

  fun show(person: Person, address: String, handle: String, framed: Boolean, dimmed: Boolean, busy: Boolean, enabled: Boolean, actions: List<Action>) {
    this.framed = framed
    this.busy = busy
    avatar.show(person, address)
    nameLabel.text = person.displayName
    nameLabel.textSize = if (framed) 15f else 16f
    nameLabel.letterSpacing = if (framed) 0f else -0.2f / 16f
    statusEmoji.show(person.look, if (framed) 14f else 15f) // Avatars
    handleLabel.text = handle
    alpha = if (dimmed) (if (framed) 0.5f else 0.45f) else 1f
    for (button in buttons) removeView(button)
    // While this row's request is on its way, the wheel stands where its buttons were (in a list of people:
    // where the «написать» button was).
    val shown = if (!busy) actions else if (framed) emptyList() else actions.dropLast(1)
    buttons = shown.map { action ->
      PeopleRoundButton(context, action.symbol, action.look).apply {
        contentDescription = action.words
        isEnabled = enabled
        if (isClickable) setOnClickListener { action.run() }
        this@PersonCell.addView(this)
      }
    }
    waiting.visibility = if (busy) View.VISIBLE else View.GONE
    requestLayout()
    invalidate()
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  /** The row is pressed, not its buttons with it. */
  override fun dispatchSetPressed(pressed: Boolean) {}

  private fun exactly(size: Float) = MeasureSpec.makeMeasureSpec(Math.round(size * d), MeasureSpec.EXACTLY)
  private val inset: Float get() = if (framed) 12f else 14f

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    avatar.measure(exactly(54f), exactly(54f))
    waiting.measure(exactly(20f), exactly(20f))
    for (button in buttons) button.measure(exactly(38f), exactly(if (button.tag == "info") 40f else 38f))
    val taken = 28f + inset + 54f + inset + inset + buttons.size * (38f + inset) + (if (busy) 20f + inset else 0f)
    val room = MeasureSpec.makeMeasureSpec(Math.round(width - taken * d).coerceAtLeast(0), MeasureSpec.EXACTLY)
    // Avatars: the status takes its room after the name.
    statusEmoji.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val emojiRoom = if (statusEmoji.visibility == View.VISIBLE) statusEmoji.measuredWidth + Math.round(6f * d) else 0
    nameLabel.measure(MeasureSpec.makeMeasureSpec((MeasureSpec.getSize(room) - emojiRoom).coerceAtLeast(0), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    handleLabel.measure(room, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    // A request: 12 + 54 + 12 and 6 under it; a person: 14 + 54 + 14 and 7 under it.
    setMeasuredDimension(width, Math.round((if (framed) 84f else 89f) * d))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val gap = (if (framed) 6f else 7f) * d
    val cardLeft = 14f * d; val height = (bottom - top) - gap
    fun put(view: View, x: Float, y: Float) = view.layout(x.toInt(), y.toInt(), x.toInt() + view.measuredWidth, y.toInt() + view.measuredHeight)
    put(avatar, cardLeft + inset * d, (height - 54f * d) / 2)
    var edge = (right - left) - 14f * d - inset * d
    if (busy) {
      put(waiting, edge - 20f * d, height / 2 - 10f * d)
      edge -= (20f + inset) * d
    }
    for (button in buttons.reversed()) {
      put(button, edge - 38f * d, (height - button.measuredHeight) / 2)
      edge -= (38f + inset) * d
    }
    val textLeft = cardLeft + (inset + 54f + inset) * d
    val spacing = (if (framed) 4f else 6f) * d
    val textTop = (height - nameLabel.measuredHeight - spacing - handleLabel.measuredHeight) / 2
    put(nameLabel, textLeft, textTop)
    if (statusEmoji.visibility == View.VISIBLE) put(statusEmoji, textLeft + nameLabel.measuredWidth + 6f * d, textTop + nameLabel.measuredHeight / 2f - statusEmoji.measuredHeight / 2f) // Avatars
    put(handleLabel, textLeft, textTop + nameLabel.measuredHeight + spacing)
  }

  override fun onDraw(canvas: Canvas) {
    val gap = (if (framed) 6f else 7f) * d
    val l = 14f * d; val r = width - 14f * d; val b = height - gap; val radius = (if (framed) 22f else 24f) * d
    val fill = if (framed) (if (Theme.dark) 0x0AFFFFFF else 0x73FFFFFF) else if (isPressed) (if (Theme.dark) 0x12FFFFFF else 0x80FFFFFF.toInt()) else 0
    if (fill != 0) { paint.style = Paint.Style.FILL; paint.color = fill; canvas.drawRoundRect(l, 0f, r, b, radius, radius, paint) }
    if (framed || isPressed) {
      paint.style = Paint.Style.STROKE; paint.strokeWidth = d; paint.color = com.linea.messenger.settings.ThemeStore.look.border
      canvas.drawRoundRect(l + d / 2, d / 2, r - d / 2, b - d / 2, radius, radius, paint)
    }
  }
}
