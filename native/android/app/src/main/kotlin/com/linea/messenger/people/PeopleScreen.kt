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
  private val heading = TextView(context)
  private val caption = TextView(context)
  private val searchBox = object : FrameLayout(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.surface2 }
    init { setWillNotDraw(false) }
    override fun onDraw(canvas: Canvas) {
      canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), 24f * d, 24f * d, paint)
      PeopleIcons.draw(canvas, "search", 26f * d, height / 2f, 20f * d, Theme.accent)
    }
  }
  private val field = EditText(context)
  private val clearButton = RoundIconButton(context, "clear", RoundIconButton.Look.PLAIN, 19f)
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
      is PeopleList.Item.Label, is PeopleList.Item.Notice -> 0
      is PeopleList.Item.Request, is PeopleList.Item.Friend -> 1
      is PeopleList.Item.Empty -> 2
    }
    override fun areAllItemsEnabled() = false
    override fun isEnabled(position: Int) = getItemViewType(position) == 1
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = when (val item = items[position]) {
      is PeopleList.Item.Label -> (convertView as? PeopleLabelCell ?: PeopleLabelCell(context)).apply { show(item.words, notice = false) }
      is PeopleList.Item.Notice -> (convertView as? PeopleLabelCell ?: PeopleLabelCell(context)).apply { show(item.words, notice = true) }
      is PeopleList.Item.Empty -> (convertView as? PeopleEmptyCell ?: PeopleEmptyCell(context)).apply { show(item.heading, item.words) }
      is PeopleList.Item.Request -> (convertView as? PersonCell ?: PersonCell(context)).apply {
        val person = item.person
        val buttons = if (item.incoming) listOf(
          PersonCell.Action("check", "Принять: ${person.displayName}", RoundIconButton.Look.PRIMARY) { answer(person, accept = true) },
          PersonCell.Action("cross", "Отклонить: ${person.displayName}", RoundIconButton.Look.OUTLINE) { answer(person, accept = false) },
        ) else listOf(
          PersonCell.Action("cross", "Отменить заявку: ${person.displayName}", RoundIconButton.Look.OUTLINE) { answer(person, accept = false) },
        )
        show(person, address(person), PeopleList.requestHandle(person, item.incoming), framed = true, dimmed = acting != null && acting != person.id,
          busy = acting == person.id, enabled = acting == null, actions = buttons)
        contentDescription = "Профиль ${person.displayName}"
      }
      is PeopleList.Item.Friend -> (convertView as? PersonCell ?: PersonCell(context)).apply {
        val person = item.person
        val buttons = listOf(
          PersonCell.Action("info", "Профиль ${person.displayName}", RoundIconButton.Look.PLAIN) { showProfile(person) },
          PersonCell.Action("bubble", "Написать: ${person.displayName}", RoundIconButton.Look.SOFT) { openChat(person) },
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

    heading.text = "Люди"
    heading.textSize = 34f
    heading.typeface = Theme.weight(700)
    heading.titled(Theme.TypeSize.sectionTitle) // Fonts: Unbounded, as the reference
    heading.setTextColor(Theme.text)
    heading.includeFontPadding = false
    addView(heading)
    caption.text = "Друзья, заявки и поиск по @имени"
    caption.textSize = 13f
    caption.setTextColor(Theme.muted)
    caption.includeFontPadding = false
    addView(caption)

    addView(searchBox)
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
    val headingHeight = putText(heading, dp(20f), top + dp(8f), width - dp(40f))
    val captionTop = top + dp(8f) + headingHeight + dp(2f)
    val captionHeight = putText(caption, dp(20f), captionTop, width - dp(40f))
    // ChatsPlus: the switch «Друзья | Звонки» stands between the caption and the search.
    val boxTop = calls.place(width, height, captionTop + captionHeight, edges.bottom) + dp(14f); val boxWidth = width - dp(34f); val boxHeight = dp(52f)
    place(clearButton, boxWidth - dp(46f), dp(4f), dp(44f), dp(44f))
    place(spinner, boxWidth - dp(46f) + dp(11f), dp(4f) + dp(11f), dp(22f), dp(22f))
    place(field, dp(46f), 0, boxWidth - dp(46f) - dp(48f), boxHeight)
    put(searchBox, dp(17f), boxTop, boxWidth, boxHeight)
    val listTop = boxTop + boxHeight + dp(12f)
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
    items = PeopleList.items(query, problem, searching, incoming, outgoing, friends, found)
    adapter.notifyDataSetChanged()
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

/** A quiet heading of a part of the list («ДРУЗЬЯ  5»), or words about what did not work. */
class PeopleLabelCell(context: Context) : TextView(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  init { includeFontPadding = false }

  fun show(words: String, notice: Boolean) {
    text = words
    if (notice) {
      textSize = 14f
      typeface = Theme.weight(400)
      letterSpacing = 0f
      setTextColor(Theme.danger)
      gravity = Gravity.START or Gravity.TOP
      setPadding(dp(26f), dp(7f), dp(26f), dp(15f))
      layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
    } else {
      textSize = 11f
      typeface = Theme.weight(700)
      letterSpacing = 1.7f / 11f
      setTextColor(Theme.muted)
      gravity = Gravity.START or Gravity.CENTER_VERTICAL
      setPadding(dp(26f), 0, dp(26f), dp(8f))
      layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, dp(34f))
    }
    if (android.os.Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = !notice
  }
}

/** «Кому напишем?» — the list is empty. */
class PeopleEmptyCell(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.veil(0.07f) }
  private val heading = TextView(context)
  private val words = TextView(context)

  init {
    setWillNotDraw(false)
    heading.textSize = 21f
    heading.typeface = Theme.weight(800)
    heading.setTextColor(Theme.text)
    heading.gravity = Gravity.CENTER
    heading.includeFontPadding = false
    addView(heading)
    words.textSize = 15f
    words.setTextColor(Theme.muted)
    words.gravity = Gravity.CENTER
    addView(words)
  }

  fun show(title: String, text: String) {
    heading.text = title
    words.text = text
    requestLayout()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    heading.measure(MeasureSpec.makeMeasureSpec((width - 56f * d).toInt().coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val room = minOf(310f * d, width - 56f * d).toInt().coerceAtLeast(0)
    words.measure(MeasureSpec.makeMeasureSpec(room, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    setMeasuredDimension(width, (300f * d).toInt())
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val headingTop = ((38f + 94f + 21f) * d).toInt()
    heading.layout((28f * d).toInt(), headingTop, (28f * d).toInt() + heading.measuredWidth, headingTop + heading.measuredHeight)
    val wordsTop = headingTop + heading.measuredHeight + (13f * d).toInt()
    val wordsLeft = (width - words.measuredWidth) / 2
    words.layout(wordsLeft, wordsTop, wordsLeft + words.measuredWidth, wordsTop + words.measuredHeight)
  }

  override fun onDraw(canvas: Canvas) {
    val side = 94f * d; val x = (width - side) / 2; val y = 38f * d
    canvas.drawRoundRect(x, y, x + side, y + side, 30f * d, 30f * d, paint)
    PeopleIcons.draw(canvas, "people", width / 2f, y + side / 2, 40f * d, Theme.accent)
  }
}

/** A person in the list: the picture, the name, the @username, and round buttons on the right. */
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
  private var buttons: List<RoundIconButton> = emptyList()
  private var framed = false
  private var busy = false

  init {
    setWillNotDraw(false)
    addView(avatar)
    nameLabel.textSize = 16f
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
    statusEmoji.show(person.look, if (framed) 14f else 15f) // Avatars
    handleLabel.text = handle
    alpha = if (dimmed) 0.5f else 1f
    for (button in buttons) removeView(button)
    // While this row's request is on its way, the wheel stands where its buttons were (in a list of people:
    // where the «написать» button was).
    val shown = if (!busy) actions else if (framed) emptyList() else actions.dropLast(1)
    buttons = shown.map { action ->
      RoundIconButton(context, action.symbol, action.look, if (action.look == RoundIconButton.Look.PLAIN) 23f else 18f).apply {
        contentDescription = action.words
        isEnabled = enabled
        setOnClickListener { action.run() }
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

  private fun exactly(size: Float) = MeasureSpec.makeMeasureSpec((size * d).toInt(), MeasureSpec.EXACTLY)

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    avatar.measure(exactly(48f), exactly(48f))
    waiting.measure(exactly(22f), exactly(22f))
    for (button in buttons) button.measure(exactly(38f), exactly(38f))
    val taken = 28f + 14f + 48f + 14f + 12f + (buttons.size + if (busy) 1 else 0) * 44f
    val room = MeasureSpec.makeMeasureSpec((width - taken * d).toInt().coerceAtLeast(0), MeasureSpec.EXACTLY)
    // Avatars: the status takes its room after the name.
    statusEmoji.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val emojiRoom = if (statusEmoji.visibility == View.VISIBLE) statusEmoji.measuredWidth + (6f * d).toInt() else 0
    nameLabel.measure(MeasureSpec.makeMeasureSpec((MeasureSpec.getSize(room) - emojiRoom).coerceAtLeast(0), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    handleLabel.measure(room, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    setMeasuredDimension(width, ((if (framed) 78f else 83f) * d).toInt())
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val gap = (if (framed) 6f else 7f) * d
    val cardLeft = 14f * d; val height = (bottom - top) - gap
    fun put(view: View, x: Float, y: Float) = view.layout(x.toInt(), y.toInt(), x.toInt() + view.measuredWidth, y.toInt() + view.measuredHeight)
    put(avatar, cardLeft + 14f * d, (height - 48f * d) / 2)
    var edge = (right - left) - 14f * d - 12f * d
    if (busy) {
      put(waiting, edge - 19f * d - 11f * d, height / 2 - 11f * d)
      edge -= (38f + 6f) * d
    }
    for (button in buttons.reversed()) {
      put(button, edge - 38f * d, (height - 38f * d) / 2)
      edge -= (38f + 6f) * d
    }
    val textLeft = cardLeft + (14f + 48f + 14f) * d
    put(nameLabel, textLeft, height / 2 - 1f * d - nameLabel.measuredHeight)
    if (statusEmoji.visibility == View.VISIBLE) put(statusEmoji, textLeft + nameLabel.measuredWidth + 6f * d, height / 2 - 1f * d - nameLabel.measuredHeight / 2f - statusEmoji.measuredHeight / 2f) // Avatars
    put(handleLabel, textLeft, height / 2 + 4f * d)
  }

  override fun onDraw(canvas: Canvas) {
    val gap = (if (framed) 6f else 7f) * d
    val l = 14f * d; val r = width - 14f * d; val b = height - gap; val radius = 24f * d
    val fill = if (isPressed) Theme.veil(0.07f) else if (framed) Theme.veil(0.04f) else 0
    if (fill != 0) { paint.style = Paint.Style.FILL; paint.color = fill; canvas.drawRoundRect(l, 0f, r, b, radius, radius, paint) }
    if (framed) {
      paint.style = Paint.Style.STROKE; paint.strokeWidth = d; paint.color = Theme.veil(0.08f)
      canvas.drawRoundRect(l + d / 2, d / 2, r - d / 2, b - d / 2, radius, radius, paint)
    }
  }
}
