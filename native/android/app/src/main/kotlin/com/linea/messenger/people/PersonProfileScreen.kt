package com.linea.messenger.people

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.shell.Screen

/** The words of a profile's buttons and notices: plain rules, so they can be checked without a phone. */
object ProfileWords {
  /** The friends tile: its picture and its word. `isFriend` null: the profile is still being read. */
  fun friendTile(isFriend: Boolean?, request: String?): Pair<String, String> = Pair(
    if (isFriend == true) "ion:person-remove" else if (request == "outgoing") "ion:time-outline" else "ion:person-add",
    if (isFriend == true) "В друзьях" else if (request == "outgoing") "Заявка" else if (request == "incoming") "Принять" else "В друзья",
  )

  /** The friends line of «Ещё» (shown in a profile opened from a chat). */
  fun friendMenu(isFriend: Boolean, request: String?): String =
    if (isFriend) "Удалить из друзей" else if (request == "outgoing") "Отменить заявку" else if (request == "incoming") "Принять в друзья" else "Добавить в друзья"

  const val removed = "Удалён из друзей"
  const val cancelled = "Заявка отменена"
  const val friendsNow = "Теперь вы друзья"
  const val requested = "Заявка отправлена"
  const val reported = "Жалоба отправлена. Спасибо!"
  fun blocked(block: Boolean): String = if (block) "Заблокирован: он не сможет тебе писать и звонить" else "Разблокирован"

  /** «Пожаловаться»: the reasons and the words are the reference's. */
  val reasons: List<Pair<String, String>> = listOf(
    "spam" to "Спам", "scam" to "Мошенничество", "abuse" to "Оскорбления и травля",
    "violence" to "Насилие", "sexual" to "Откровенный контент", "illegal" to "Незаконное", "other" to "Другое",
  )
}

/** A person's profile: the picture, the name, when they were in the line, the buttons («Написать», friends,
 *  «Ещё») and the card with the @username, the birthday and «о себе». Ported from the reference's
 *  UserProfile.tsx and ProfileInfo.tsx. */
@SuppressLint("ViewConstructor")
class PersonProfileScreen(
  context: Context,
  private val messenger: Messenger?,
  private val userId: String,
  private val name: String,
  /** What is already known about them (a row of a list), shown until the profile is read. */
  private var person: Person? = null,
  /** Not empty: the profile was opened from this chat (then there is no «Написать» — the chat is one step back). */
  private val chatId: String = "",
) : Screen(context) {
  /** null while the profile is being read. */
  private var isFriend: Boolean? = null
  /** "incoming", "outgoing" or null. */
  private var request: String? = null
  private var blocked = false
  private var busy = false
  private var copied = false
  private var copyTurn = 0
  private var noticeWords = ""
  private var problemWords = ""

  private val scroll = ScrollView(context)
  private val content = LinearLayout(context)
  private val topBar = View(context)
  // C: back and «Ещё» are the reference's IconButtons — rounds of clear glass, the icons in the text colour.
  private val back = com.linea.messenger.design.GlassRoundButton(context, "ion:chevron-back", "Назад", 23f) // IconButton «chevron-back», 23
  private val more = com.linea.messenger.design.GlassRoundButton(context, "ion:ellipsis-horizontal", "Ещё", 23f) // IconButton «ellipsis-horizontal», 23
  // Profile: the top as the reference's UserProfile.tsx — banner / festive colour, the decorated avatar, the
  // platinum name and emoji status, the effect (profile/ProfileHead.kt).
  private val hero = com.linea.messenger.profile.ProfileHeroView(context)
  private val topLayers = com.linea.messenger.profile.ProfileTopLayers(context)
  /** The page's background and its banner / light as a glass source: the action tiles blur them, as the reference's
   *  GlassSurface does (its children are placed by this screen, not by the frame). */
  private val backdrop = object : com.linea.messenger.design.GlassSource(context) {
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}
  }
  private val backdropFill = View(context)
  private val avatar: View get() = hero.avatar
  /** Profile: the chat this profile was opened from — «Звук», «Поиск», the shared media and the chat's items of
   *  «Ещё» (profile/ProfileChatExtras.kt). Null: opened from elsewhere. */
  var chatLink: com.linea.messenger.profile.ProfileChatLink? = null
    set(value) { field = value; refresh() }
  private val sharedMedia = com.linea.messenger.profile.SharedMediaView(context)
  private val tiles = LinearLayout(context)
  private val noticeLabel = TextView(context)
  private val problemLabel = TextView(context)
  private val card = LinearLayout(context)
  /** Stories: «Публикации» / «Истории» under the card and the ring around the picture (stories/ProfilePosts.kt). */
  private val postsBlock = com.linea.messenger.stories.ProfilePostsBlock(context)

  private val fromChat: Boolean get() = chatId.isNotEmpty()
  private val presenceChanged: (String?) -> Unit = { refreshStatus() }
  /** «был(а) 5 минут назад» grows old by itself. */
  private val clock = object : Runnable { override fun run() { refreshStatus(); postDelayed(this, 30_000) } }

  init {
    setBackgroundColor(Theme.bg)

    backdropFill.setBackgroundColor(Theme.bg)
    backdrop.addView(backdropFill)
    backdrop.addView(topLayers.back) // Profile
    backdrop.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(backdrop)
    scroll.isVerticalScrollBarEnabled = false
    scroll.isFillViewport = false
    scroll.clipChildren = false
    scroll.overScrollMode = View.OVER_SCROLL_ALWAYS
    content.orientation = LinearLayout.VERTICAL
    content.clipChildren = false
    content.setPadding(dp(18f), dp(10f), dp(18f), dp(32f))
    scroll.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    addView(scroll)
    // Profile: the top follows the scroll.
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> layoutTop() }

    fun row(view: View, width: Int, height: Int, gap: Float) =
      content.addView(view, LinearLayout.LayoutParams(width, height).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(gap) })
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    row(hero, wide, wrap, 0f) // Profile
    hero.avatarHolder.setOnClickListener { avatarTapped() }
    tiles.orientation = LinearLayout.HORIZONTAL
    row(tiles, wrap, wrap, 16f)
    noticeLabel.textSize = 13f
    noticeLabel.setTextColor(Theme.accent)
    noticeLabel.gravity = Gravity.CENTER
    noticeLabel.visibility = View.GONE
    row(noticeLabel, wide, wrap, 16f)
    problemLabel.textSize = 14f
    problemLabel.setTextColor(Theme.danger)
    problemLabel.gravity = Gravity.CENTER
    problemLabel.visibility = View.GONE
    row(problemLabel, wide, wrap, 16f)
    card.orientation = LinearLayout.VERTICAL
    card.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 22f * d }
    card.clipToOutline = true
    row(card, wide, wrap, 16f)
    // Stories: the person's posts and stories.
    row(postsBlock, wide, wrap, 16f)
    postsBlock.attach(this, messenger, userId, own = false, avatar = avatar)
    // Profile: «Фото · Видео · Файлы · Голосовые · Ссылки» of the chat (SharedMedia.tsx).
    row(sharedMedia, wide, wrap, 16f)
    sharedMedia.onOpen = { key, attachment -> if (key.isNotEmpty()) chatLink?.openAttachment(key, attachment, this) }

    addView(topLayers.front) // Profile

    // Profile: the content scrolls under the floating back / «Ещё» row and dissolves there.
    topBar.background = android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Theme.alpha(Theme.bg, 0.92f), Theme.alpha(Theme.bg, 0f)))
    topBar.alpha = 0f
    addView(topBar)
    back.contentDescription = "Назад"
    back.setOnClickListener { pages()?.pop() }
    addView(back)
    more.contentDescription = "Ещё"
    more.setOnClickListener { showMore(more) }
    addView(more)

    if (messenger != null) {
      messenger.preparePersonAvatars()
      messenger.personProfile(userId) { result ->
        val profile = result.getOrNull()
        if (profile != null) {
          person = profile.person
          isFriend = profile.isFriend
          request = profile.request
          blocked = profile.blocked
        } else {
          problemWords = Server.error(result).words
        }
        refresh()
      }
    } else if (PeopleDemo.present) {
      if (person == null) person = PeopleDemo.named(name) // Profile: a sample person handed over keeps its decorations
      isFriend = PeopleDemo.friends.any { it.displayName == name }
      if (PeopleDemo.incoming.any { it.displayName == name }) request = "incoming"
      if (PeopleDemo.outgoing.any { it.displayName == name }) request = "outgoing"
    }
    refresh()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (messenger != null) Live.presenceChanged.watch(presenceChanged)
    removeCallbacks(clock)
    clock.run()
    // Profile: on the birthday, the confetti once.
    post { topLayers.celebrate(this) }
  }

  override fun onDetachedFromWindow() {
    Live.presenceChanged.unwatch(presenceChanged)
    removeCallbacks(clock)
    super.onDetachedFromWindow()
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(topBar, 0, 0, width, top + dp(48f))
    put(back, dp(10f), top + dp(2f), dp(44f), dp(44f)) // C: `paddingHorizontal: 10`
    put(more, width - dp(54f), top + dp(2f), dp(44f), dp(44f))
    // Profile: the page scrolls from the very top, under the floating row.
    val padTop = top + dp(48f + 18f)
    if (content.paddingBottom != dp(32f) + edges.bottom || content.paddingTop != padTop) content.setPadding(dp(18f), padTop, dp(18f), dp(32f) + edges.bottom)
    put(scroll, 0, 0, width, height)
    put(backdrop, 0, 0, width, height)
    put(backdropFill, 0, 0, width, height)
    put(topLayers.back, 0, 0, width, topLayers.backHeight(hero.bottom))
    put(topLayers.front, 0, 0, width, topLayers.frontHeight())
    fitTiles(width)
    layoutTop()
  }

  // Profile: the top follows the scroll

  private var pulled = 0

  private fun layoutTop() {
    val scrolled = scroll.scrollY - pulled
    val heroBottom = tiles.bottom
    topLayers.layout(width, edges.top, scrolled, heroBottom)
    hero.applyScroll(scrolled)
    topBar.alpha = (scrolled / (60f * d)).coerceIn(0f, 1f)
  }

  /** Up to five tiles share the row (the reference's `flex: 1, maxWidth: 120`): each as wide as the room allows. */
  private fun fitTiles(width: Int) {
    val count = tiles.childCount
    if (count == 0 || width <= 0) return
    val room = maxOf(dp(200f), width - dp(36f))
    val each = minOf(dp(120f), (room - dp(10f) * (count - 1)) / count) // `flex: 1, maxWidth: 120`
    for (index in 0 until count) {
      val params = tiles.getChildAt(index).layoutParams
      if (params.width != each) { params.width = each; tiles.getChildAt(index).layoutParams = params }
    }
  }

  // A long pull opens the stories, or the photo and video full screen (as the reference).
  private var pullStart = -1f

  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    when (event.actionMasked) {
      android.view.MotionEvent.ACTION_DOWN -> pullStart = if (scroll.scrollY == 0) event.rawY else -1f
      android.view.MotionEvent.ACTION_MOVE -> if (pullStart >= 0 && scroll.scrollY == 0) {
        val next = maxOf(0, ((event.rawY - pullStart) * 0.5f).toInt())
        if (next != pulled) { pulled = next; layoutTop() }
      }
      android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
        if (pulled > dp(110f)) post { avatarTapped() }
        if (pulled != 0) { pulled = 0; layoutTop() }
        pullStart = -1f
      }
    }
    return super.dispatchTouchEvent(event)
  }

  /** Profile, for the emulator check: the shared media (a tab by name, or the first) scrolled into view. */
  fun emulatorShared(tab: String) {
    com.linea.messenger.profile.SharedMediaView.Tab.values().firstOrNull { it.name.equals(tab, ignoreCase = true) }?.let { sharedMedia.select(it) }
    post { scroll.scrollTo(0, maxOf(0, sharedMedia.top - dp(120f))) }
  }

  /** Profile, for the emulator check: «Ещё» opened. */
  fun emulatorMore() = showMore(more)

  private fun avatarTapped() {
    if (postsBlock.openStoriesIfAny()) return
    val shown = shownPerson
    if (com.linea.messenger.profile.ProfileMediaViewer.items(shown).isEmpty()) return
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    com.linea.messenger.profile.ProfileMediaViewer(context, shown, messenger?.server?.endpoint ?: "").show()
  }

  // What is shown

  private val shownPerson: Person
    get() = person ?: Person(userId, "", name, "", "", 0x5E7BFF, "")

  private fun refreshStatus() {
    val words = if (messenger != null) PresenceWords.text(messenger.live.presence[userId]) else PeopleDemo.status
    hero.setPresence(words) // Profile
  }

  private fun refresh() {
    val shown = shownPerson
    // Profile: the decorated top (banner, festive colour, effect, avatar, name, status).
    val base = messenger?.server?.endpoint ?: ""
    topLayers.show(shown, base)
    hero.show(shown, base, hero.presence.text?.toString()?.takeIf { it.isNotEmpty() }, topLayers.tinted)
    postsBlock.setColor(shown.avatarColor) // Stories: the ring is lit by the person's own colour
    refreshStatus()
    noticeLabel.text = noticeWords
    noticeLabel.visibility = if (noticeWords.isEmpty()) View.GONE else View.VISIBLE
    problemLabel.text = problemWords
    problemLabel.visibility = if (problemWords.isEmpty()) View.GONE else View.VISIBLE
    more.isEnabled = !busy
    rebuildTiles()
    rebuildCard(shown)
    sharedMedia.show(chatLink?.messages ?: emptyList()) // Profile
  }

  private fun makeTile(symbol: String, words: String, loading: Boolean, active: Boolean = false, sub: String = ""): ProfileTile {
    val tile = ProfileTile(context, symbol, words, loading, active, sub)
    tile.source = backdrop
    tile.isEnabled = !loading && !busy
    val gap = if (tiles.childCount == 0) 0 else dp(10f)
    // The reference's tile: 12 + 22 + 6 + the label's line + 12 (and the sublabel's line, 3 closer).
    tiles.addView(tile, LinearLayout.LayoutParams(dp(120f), dp(if (sub.isEmpty()) 67f else 77f)).apply { leftMargin = gap })
    com.linea.messenger.chatlook.Bouncy.attach(tile, 0.9f) // `Bouncy scaleTo={.9}`
    return tile
  }

  private fun rebuildTiles() {
    tiles.removeAllViews()
    if (!fromChat) makeTile("ion:chatbubble", "Написать", loading = false).setOnClickListener { writeTapped() }
    if (fromChat) {
      // Calls: opened from a chat, the row is «Звонок», «Видео», «Ещё», as in the reference (the friends
      // action is in «Ещё» then). calls/CallOverlay.kt places the call.
      for (video in listOf(false, true)) {
        makeTile(if (video) "ion:videocam" else "ion:call", if (video) "Видео" else "Звонок", loading = false).setOnClickListener {
          com.linea.messenger.calls.CallEntry.call(messenger, chatId, userId, name, shownPerson, video)
        }
      }
    } else {
      val (symbol, words) = ProfileWords.friendTile(isFriend, request)
      val friend = makeTile(symbol, words, loading = isFriend == null && problemWords.isEmpty(), active = isFriend == true || request == "incoming")
      if (isFriend == null) friend.isEnabled = false
      friend.setOnClickListener { friendTapped() }
    }
    chatLink?.let { link ->
      // Profile: «Звук» / «Без звука» (with how long under it) and «Поиск», as the reference's row
      // «call · video · sound · search · more».
      val quiet = com.linea.messenger.profile.ProfileChatExtras.muted(link.settings)
      val sound = makeTile(if (quiet) "ion:notifications-off" else "ion:notifications", if (quiet) "Без звука" else "Звук", loading = false, active = quiet,
        sub = if (quiet) com.linea.messenger.profile.ProfileChatExtras.untilLabel(link.settings["mutedUntil"] as? String) else "")
      if (quiet) sound.contentDescription = "Без звука, " + com.linea.messenger.profile.ProfileChatExtras.untilLabel(link.settings["mutedUntil"] as? String)
      sound.setOnClickListener { soundTapped() }
      if (link.canSearch) makeTile("ion:search", "Поиск", loading = false).setOnClickListener { link.openSearch(this) }
    }
    val other = makeTile("ion:ellipsis-horizontal", "Ещё", loading = false)
    other.setOnClickListener { showMore(other) }
    fitTiles(width)
  }

  /** «Звук»: a chat without sound gets it back in one touch; otherwise the sheet asks for how long. */
  private fun soundTapped() {
    val link = chatLink ?: return
    if (busy) return
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    if (com.linea.messenger.profile.ProfileChatExtras.muted(link.settings)) return changeSound(link, mapOf("muted" to false), "Звук включён")
    val title = shownPerson.displayName.ifEmpty { name }
    com.linea.messenger.profile.ProfileChatExtras.muteSheet(context, title) { until ->
      if (until != null) changeSound(link, mapOf("mutedUntil" to until), "Звук выключен " + com.linea.messenger.profile.ProfileChatExtras.untilLabel(until))
      else changeSound(link, mapOf("muted" to true), "Звук выключен навсегда")
    }
  }

  private fun changeSound(link: com.linea.messenger.profile.ProfileChatLink, update: Map<String, Any?>, ok: String) {
    busy = true
    refresh()
    com.linea.messenger.profile.ProfileChatExtras.changeSound(link, messenger, update) { failure ->
      busy = false
      if (failure != null) say(problem = failure) else say(notice = ok)
    }
  }

  /** «Ещё»: the friends line (in a profile opened from a chat), blocking, a complaint. */
  private fun showMore(anchor: View) {
    val menu = PopupMenu(context, anchor)
    // The reference's MenuItems carry Ionicons (20, in the text colour; red for the dangerous ones).
    fun icon(name: String, danger: Boolean = false) = com.linea.messenger.design.IonIcon.drawable(context, name, dp(20f), if (danger) Theme.danger else Theme.text)
    val friendNow = isFriend
    if (fromChat && friendNow != null) menu.menu.add(ProfileWords.friendMenu(friendNow, request)).setIcon(icon(if (friendNow) "person-remove-outline" else "person-add-outline")).setOnMenuItemClickListener { friendTapped(); true }
    // Profile: the chat's own items, then «Очистить историю» apart with «Заблокировать» and «Пожаловаться».
    chatLink?.let { link ->
      val (top, clear) = com.linea.messenger.profile.ProfileChatExtras.menuItems(link, this, shownPerson.displayName.ifEmpty { name }) { words -> say(notice = words) }
      for (item in top) menu.menu.add(0, 0, 0, item.title).setIcon(icon(item.icon)).setOnMenuItemClickListener { item.run(); true }
      menu.menu.add(1, 0, 1, clear.title).setIcon(icon(clear.icon)).setOnMenuItemClickListener { clear.run(); true }
    }
    if (blocked) menu.menu.add(1, 0, 2, "Разблокировать").setIcon(icon("hand-left-outline")).setOnMenuItemClickListener { setBlocked(false); true }
    else menu.menu.add(1, 0, 2, "Заблокировать").setIcon(icon("remove-circle-outline", true)).setOnMenuItemClickListener { confirmBlock(); true }
    menu.menu.add(1, 0, 3, "Пожаловаться").setIcon(icon("warning-outline", true)).setOnMenuItemClickListener { report(); true }
    if (android.os.Build.VERSION.SDK_INT >= 28 && chatLink != null) menu.menu.setGroupDividerEnabled(true)
    if (android.os.Build.VERSION.SDK_INT >= 29) menu.setForceShowIcon(true)
    menu.show()
  }

  private fun hairline(): View = View(context).apply {
    setBackgroundColor(Theme.veil(0.1f))
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, maxOf(1, dp(0.5f))).apply { leftMargin = dp(16f); rightMargin = dp(16f) }
  }

  /** A row of the card: a small grey label above the value. */
  private fun infoRow(label: String, value: String, accent: Boolean): LinearLayout {
    val small = TextView(context).apply { text = label; textSize = 14f; setTextColor(Theme.muted) }
    val big = TextView(context).apply { text = value; textSize = 17f; setTextColor(if (accent) Theme.accent else Theme.text) }
    return LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16f), dp(11f), dp(16f), dp(11f))
      addView(small)
      addView(big, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2f) })
      contentDescription = "$label: $value"
    }
  }

  private fun rebuildCard(shown: Person) {
    card.removeAllViews()
    if (shown.username.isNotEmpty()) {
      val row = infoRow("имя пользователя", if (copied) "Скопировано" else "@${shown.username}", accent = true)
      row.isClickable = true
      if (android.os.Build.VERSION.SDK_INT >= 26) row.tooltipText = "Нажми, чтобы скопировать"
      row.setOnClickListener { copyUsername() }
      card.addView(row)
    }
    val birthday = shown.birthdayWords
    if (birthday.isNotEmpty()) {
      if (card.childCount > 0) card.addView(hairline())
      card.addView(infoRow("день рождения", birthday, accent = false))
    }
    if (shown.bio.isNotEmpty()) {
      if (card.childCount > 0) card.addView(hairline())
      card.addView(infoRow("о себе", shown.bio, accent = false))
    }
    if (card.childCount > 0) card.addView(hairline())
    val lock = object : View(context) {
      override fun onDraw(canvas: Canvas) = PeopleIcons.draw(canvas, "ion:lock-closed", width / 2f, height / 2f, width.toFloat(), Theme.accent)
    }
    val words = TextView(context).apply { text = "Переписка защищена сквозным шифрованием"; textSize = 12f; setTextColor(Theme.muted) }
    val secure = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(16f), dp(11f), dp(16f), dp(11f))
      addView(lock, LinearLayout.LayoutParams(dp(14f), dp(14f)))
      addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(8f) })
    }
    // Security: «Защита чата» — the safety codes of the devices to compare (security/TrustSheet.kt).
    com.linea.messenger.security.TrustSheet.attach(secure, words, messenger, userId)
    card.addView(secure)
  }

  // What the person does

  private fun say(notice: String = "", problem: String = "") {
    noticeWords = notice
    problemWords = problem
    refresh()
  }

  /** As on the own profile in the reference: the row itself reads «Скопировано» for a moment. */
  private fun copyUsername() {
    val username = person?.username
    if (username.isNullOrEmpty()) return
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("", "@$username"))
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    copied = true
    copyTurn += 1
    val turn = copyTurn
    refresh()
    postDelayed({
      if (copyTurn != turn) return@postDelayed
      copied = false
      refresh()
    }, 1800)
  }

  private fun writeTapped() {
    if (busy) return
    val messenger = messenger
    if (messenger == null) {
      // The sample chat of the debug build; nothing in a release one.
      val stack = pages() ?: return
      if (PeopleDemo.present) stack.push(ChatScreen(context, shownPerson.displayName) { stack.pop() })
      return
    }
    busy = true
    say()
    messenger.openChat(shownPerson, this) { error ->
      busy = false
      say(problem = error?.words ?: "")
    }
  }

  private fun friendTapped() {
    val friendNow = isFriend ?: return
    if (busy) return
    if (!friendNow) return toggleFriend()
    // Removing a friend asks first.
    AlertDialog.Builder(context)
      .setTitle("Удалить ${shownPerson.displayName} из друзей?")
      .setMessage("Публикации, истории и подарки друг друга вы больше не увидите. Заявку можно отправить снова.")
      .setPositiveButton("Удалить из друзей") { _, _ -> toggleFriend() }
      .setNegativeButton("Отмена", null)
      .show()
  }

  /** The one friends button of the reference (`toggleContact`): remove, take the request back, accept, or ask. */
  private fun toggleFriend() {
    val friendNow = isFriend ?: return
    if (busy) return
    val messenger = messenger
    if (messenger == null) {
      if (!PeopleDemo.present) return
      if (friendNow) { isFriend = false; say(notice = ProfileWords.removed) }
      else if (request == "outgoing") { request = null; say(notice = ProfileWords.cancelled) }
      else if (request == "incoming") { request = null; isFriend = true; say(notice = ProfileWords.friendsNow) }
      else { request = "outgoing"; say(notice = ProfileWords.requested) }
      return
    }
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    busy = true
    say()
    fun finish(error: ServerError?, notice: String, apply: () -> Unit) {
      busy = false
      if (error != null) {
        say(problem = error.words)
      } else {
        apply()
        say(notice = notice)
        FriendRequests.refresh()
        // Stories: posts and stories are for friends — what may be seen has changed.
        postsBlock.reload()
      }
    }
    if (friendNow) {
      messenger.removeFriend(userId) { error -> finish(error, ProfileWords.removed) { isFriend = false } }
    } else if (request == "outgoing") {
      messenger.dropFriendRequest(userId) { error -> finish(error, ProfileWords.cancelled) { request = null } }
    } else if (request == "incoming") {
      messenger.acceptFriend(userId) { error -> finish(error, ProfileWords.friendsNow) { request = null; isFriend = true } }
    } else {
      messenger.addFriend(userId) { result ->
        val friends = result.getOrNull()
        if (friends == null) finish(Server.error(result), "") {}
        else if (friends) finish(null, ProfileWords.friendsNow) { isFriend = true }
        else finish(null, ProfileWords.requested) { request = "outgoing" }
      }
    }
  }

  private fun confirmBlock() {
    AlertDialog.Builder(context)
      .setTitle("Заблокировать ${shownPerson.displayName}?")
      .setMessage("Он не сможет писать и звонить тебе, пока ты не разблокируешь.")
      .setPositiveButton("Заблокировать") { _, _ -> setBlocked(true) }
      .setNegativeButton("Отмена", null)
      .show()
  }

  /** Blocking also ends the friendship and drops a request between the two (the server does; the screen follows). */
  private fun setBlocked(block: Boolean) {
    if (busy) return
    val messenger = messenger
    if (messenger == null) {
      if (!PeopleDemo.present) return
      blocked = block
      if (block) { isFriend = false; request = null }
      say(notice = ProfileWords.blocked(block))
      return
    }
    busy = true
    say()
    messenger.setPersonBlocked(userId, block) { error ->
      busy = false
      if (error != null) return@setPersonBlocked say(problem = error.words)
      blocked = block
      if (block) {
        if (isFriend != null) isFriend = false
        request = null
        FriendRequests.refresh()
      }
      say(notice = ProfileWords.blocked(block))
    }
  }

  private fun report() {
    ReportSheet(context) { reason -> sendReport(reason) }.show()
  }

  private fun sendReport(reason: String) {
    if (busy) return
    val messenger = messenger
    if (messenger == null) {
      if (PeopleDemo.present) say(notice = ProfileWords.reported)
      return
    }
    busy = true
    say()
    messenger.reportPerson(userId, reason) { error ->
      busy = false
      if (error != null) say(problem = error.words) else say(notice = ProfileWords.reported)
    }
  }
}

/** One of the buttons under the name: a picture above a word on a soft plate; a wheel in place of the picture
 *  while its answer is awaited. It dims under a finger and while it cannot be pressed. */
@SuppressLint("ViewConstructor")
class ProfileTile(context: Context, private val symbol: String, private val words: String, private val loading: Boolean,
                  private val active: Boolean = false, private val sub: String = "") : FrameLayout(context) {
  private val d = resources.displayMetrics.density
  // The reference's tile (UserProfile.tsx): glass, radius 18; the Ionicons glyph 22 from 12, 6 to the label (12 SemiBold),
  // the sublabel 10 in `muted` 3 closer; an active one (a friend, a quiet chat) in the accent.
  private val glass = com.linea.messenger.design.Glass(this)
  /** The page the tile blurs. */
  var source: com.linea.messenger.design.GlassSource?
    get() = glass.source
    set(value) { glass.source = value; invalidate() }
  private val label = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = Theme.weight(600); textAlign = Paint.Align.CENTER }
  private val small = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * d; typeface = Theme.weight(400); textAlign = Paint.Align.CENTER; color = Theme.muted }

  init {
    setWillNotDraw(false)
    isClickable = true
    isFocusable = true
    contentDescription = if (sub.isEmpty()) words else "$words, $sub"
    if (loading) {
      val wheel = ProgressBar(context).apply { isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(Theme.accent) }
      addView(wheel, LayoutParams((22f * d).toInt(), (22f * d).toInt(), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = (12f * d).toInt() })
    }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 18f * d)
    val color = Theme.alpha(if (active) Theme.accent else Theme.text, if (!isEnabled) 0.5f else 1f)
    if (!loading) PeopleIcons.draw(canvas, symbol, width / 2f, 23f * d, 22f * d, color, Theme.surface2 or 0xFF000000.toInt())
    label.color = color
    val shown = TextUtils.ellipsize(words, label, width - 8f * d, TextUtils.TruncateAt.END)
    val labelTop = 40f * d
    canvas.drawText(shown, 0, shown.length, width / 2f, labelTop - label.fontMetrics.ascent, label)
    if (sub.isNotEmpty()) {
      val line = TextUtils.ellipsize(sub, small, width - 8f * d, TextUtils.TruncateAt.END)
      canvas.drawText(line, 0, line.length, width / 2f, labelTop + 15f * d - 3f * d - small.fontMetrics.ascent, small)
    }
  }
}

/** «Пожаловаться»: the reason is chosen, then sent. A sheet at the bottom of the screen; `onSend` is called
 *  with the chosen reason after the sheet has gone. */
class ReportSheet(context: Context, private val onSend: (String) -> Unit) : Dialog(context) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var chosen = -1
  private val rows = ArrayList<Row>()

  private inner class Row(context: Context, val index: Int, val words: String) : View(context) {
    private val text = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 17f * d; color = Theme.text }
    init {
      isClickable = true
      isFocusable = true
      contentDescription = words
      setOnClickListener { pick(index) }
    }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.RadioButton"
    override fun onDraw(canvas: Canvas) {
      val on = index == chosen
      PeopleIcons.draw(canvas, if (on) "ion:checkmark-circle" else "ion:ellipse-outline", 11f * d, height / 2f, 22f * d, if (on) Theme.accent else Theme.muted, Theme.page(0xFF141516.toInt()))
      canvas.drawText(words, 34f * d, height / 2f - (text.ascent() + text.descent()) / 2, text)
    }
  }

  private val sendButton = TextView(context)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val stack = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(22f), dp(30f), dp(22f), dp(24f))
      background = GradientDrawable().apply { setColor(Theme.page(0xFF141516.toInt())); cornerRadii = floatArrayOf(28f * d, 28f * d, 28f * d, 28f * d, 0f, 0f, 0f, 0f) }
    }
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    stack.addView(TextView(context).apply { text = "Пожаловаться"; textSize = 20f; typeface = Theme.weight(700); setTextColor(Theme.text) })
    stack.addView(TextView(context).apply {
      text = "Переписка зашифрована: модератор увидит только причину и профиль, но не сообщения."; textSize = 13f; setTextColor(Theme.muted)
    }, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(10f); bottomMargin = dp(6f) })
    ProfileWords.reasons.forEachIndexed { index, reason ->
      val row = Row(context, index, reason.second)
      rows.add(row)
      stack.addView(row, LinearLayout.LayoutParams(wide, dp(46f)))
    }
    sendButton.text = "Отправить жалобу"
    sendButton.textSize = 16f
    sendButton.typeface = Theme.weight(600)
    sendButton.gravity = Gravity.CENTER
    sendButton.setTextColor(Theme.onAccent)
    sendButton.background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = 26f * d }
    sendButton.isEnabled = false
    sendButton.alpha = 0.4f
    sendButton.setOnClickListener { sendNow() }
    stack.addView(sendButton, LinearLayout.LayoutParams(wide, dp(52f)).apply { topMargin = dp(14f) })
    val scroll = ScrollView(context).apply { addView(stack) }
    setContentView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
  }

  private fun pick(index: Int) {
    chosen = index
    for (row in rows) { row.isSelected = row.index == chosen; row.invalidate() }
    sendButton.isEnabled = true
    sendButton.alpha = 1f
  }

  private fun sendNow() {
    val reason = ProfileWords.reasons.getOrNull(chosen)?.first ?: return
    dismiss()
    onSend(reason)
  }
}
