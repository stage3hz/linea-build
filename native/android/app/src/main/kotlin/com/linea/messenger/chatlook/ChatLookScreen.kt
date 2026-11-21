package com.linea.messenger.chatlook

import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.AvatarMedia
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.StatusEmojiView
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chat.MsgListView
import com.linea.messenger.chatactions.ChatScreenActions
import com.linea.messenger.core.Core
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.people.Person
import com.linea.messenger.settings.DevicePreferences

/** The look of one chat (iOS: Sources/ChatLook/ChatLookScreen.swift; the reference's ChatScreen.tsx header and
 *  backdrop): the header as glass — «назад» on the left with the unread messages of the other chats, the name in the
 *  very middle (in platinum for Platina, with the emoji status, the status line under it), and on the right
 *  «Позвонить» (the owner's decision) and the person's avatar (a tap opens the profile, a long touch the large
 *  picture); the soft edge under the header; behind the messages the wallpaper or the person's light; bubbles or
 *  the open look; a swipe to answer.
 *
 *  The screen keeps its own views (the name, «назад», the call button, the status line of ChatActions) and hands
 *  them over; this object puts them into the glass and places them after the screen and ChatActions did. */
class ChatLookScreen(private val host: ChatScreen, private val messenger: Messenger?, private val chatId: String, private val peerId: String, private val name: String) {
  private val context = host.context
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  private var heading: TextView? = null
  private var back: View? = null
  private var call: View? = null
  private var status: TextView? = null
  private var list: MsgListView? = null
  private var header: View? = null

  private val wallpaper = WallpaperView(context)
  private val light = PeerLightView(context)
  private val edge = HeaderEdgeView(context)
  private lateinit var backPill: GlassPill
  private lateinit var namePill: GlassPill
  private lateinit var callPill: GlassPill
  private val badge = TextView(context)
  /** Avatars: the emoji status (animated) or the Platina gem, as StatusEmoji size 16. */
  private val emoji = StatusEmojiView(context)
  /** Platina: the name in moving platinum over the plain one (kept for TalkBack and the layout). */
  private val metal = PlatinaNameView(context)
  private val avatarControl = FrameLayout(context)
  /** Avatars: the plain photo or video avatar (the owner's rule: no frame in the chat header). */
  private val avatar = DecoratedAvatarView(context)
  /** The person as the server describes them (`User`): colour, picture, emoji status, Platina. */
  private var peer: Map<String, Any?> = emptyMap()
  private var unread = 0
  private var bubbles = false

  /** «Поиск» in the avatar's menu: set by whoever gives the chat its search (shown only when set). */
  var onSearch: (() -> Unit)? = null
  /** «Отправить подарок» in the avatar's menu (the reference keeps it in the chat's menu): set by the chat. */
  var onGift: (() -> Unit)? = null

  private val unreadWatcher: (Unit) -> Unit = { unreadChanged() }
  private val lookWatcher: (Unit) -> Unit = { apply() }
  private val pictureWatcher: (String) -> Unit = { id -> if (id.isNotEmpty() && id == avatarId) apply() }

  // Setting up

  /** The wallpaper and the person's light go under the list, inside the page the glass blurs. */
  fun installBackdrop(page: GlassSource) {
    page.addView(wallpaper, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    page.addView(light, 1, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    // The page's own colour stays the screen's: the page itself is clear so the light and the wallpaper show.
  }

  /** Takes the header's views over. Call after ChatActions has set itself up. */
  fun installHeader(page: GlassSource, header: View, heading: TextView, back: View, call: View, status: TextView, list: MsgListView, actions: ChatScreenActions) {
    this.header = header; this.heading = heading; this.back = back; this.call = call; this.status = status; this.list = list
    backPill = GlassPill(context, page); namePill = GlassPill(context, page); callPill = GlassPill(context, page)
    header.setBackgroundColor(0)
    header.visibility = View.INVISIBLE
    host.addView(edge, host.indexOfChild(header))

    // «назад»: a glass pill; with unread messages in other chats, their number after the arrow.
    move(back, backPill)
    badge.textSize = 11f
    badge.typeface = Theme.weight(700)
    badge.setTextColor(if (Theme.dark) 0xFF000000.toInt() else 0xFFFFFFFF.toInt())
    badge.background = GradientDrawable().apply { setColor(Theme.text); cornerRadius = 9 * d }
    badge.gravity = Gravity.CENTER
    badge.includeFontPadding = false
    badge.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    backPill.addView(badge)
    host.addView(backPill)
    Bouncy.attach(back, 0.88f, backPill)

    // The name in the middle, the emoji status after it, the status line under it.
    move(heading, namePill)
    move(status, namePill)
    namePill.addView(metal)
    namePill.addView(emoji)
    status.textSize = 12f
    // The whole pill opens the profile (the label's own tap would open it a second time).
    heading.setOnClickListener(null)
    heading.isClickable = false
    namePill.isClickable = true
    namePill.setOnClickListener { host.openProfile() }
    host.addView(namePill)

    // «Позвонить» (a long touch offers «Видеозвонок»), a round glass button.
    move(call, callPill)
    host.addView(callPill)
    Bouncy.attach(call, 0.86f, callPill)

    // The avatar: a tap opens the profile, a long touch shows the large picture.
    avatarControl.addView(avatar, FrameLayout.LayoutParams(dp(44f), dp(44f)))
    avatar.isClickable = false
    avatar.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    avatarControl.contentDescription = "Полный профиль $name"
    avatarControl.isClickable = true
    avatarControl.isFocusable = true
    avatarControl.setOnClickListener { host.openProfile() }
    avatarControl.setOnLongClickListener { Haptic.impact(avatarControl); showPeek(); true }
    host.addView(avatarControl)

    // A swipe to the left on a message answers it.
    list.swipeReply({ key -> actions.canSwipeReply(key) }, { key -> actions.swipeReply(key) })

    peer = ChatLookUnread.peer(chatId)
    if (messenger == null) peer = LookDemo.peer(name)
    unread = currentUnread()
    showPeer()
    apply()
    askPeer()
  }

  private fun move(view: View, into: ViewGroup) {
    (view.parent as? ViewGroup)?.removeView(view)
    into.addView(view)
  }

  fun attached() {
    ChatLookUnread.changed.watch(unreadWatcher)
    Wallpapers.changed.watch(lookWatcher)
    AvatarMedia.ready.watch(pictureWatcher)
    apply()
  }

  fun detached() {
    ChatLookUnread.changed.unwatch(unreadWatcher)
    Wallpapers.changed.unwatch(lookWatcher)
    AvatarMedia.ready.unwatch(pictureWatcher)
  }

  /** The person as the server describes them now (their emoji status may have changed since the list was read). */
  private fun askPeer() {
    val messenger = messenger ?: return
    if (peerId.isEmpty()) return
    messenger.server.op("userProfile", listOf(peerId)) { result ->
      val user = Core.map((result.getOrNull() as? Map<*, *>)?.get("user") as? Map<*, *>) ?: return@op
      host.post { peer = user; showPeer(); apply() }
    }
  }

  // What is shown

  private val avatarColor: Int get() = if (peer["avatarColor"] == null) 0x5E7BFF else Messenger.color(peer["avatarColor"] as? String)
  private val avatarId: String get() = peer["avatarId"] as? String ?: ""
  private val base: String get() = messenger?.server?.endpoint ?: ""

  /** The colour of the person's light: their photo's, else the one they chose. */
  private val peerTint: Int
    get() {
      if (peer["avatarColor"] == null) return 0x5E7BFF
      val picture = if (avatarId.isEmpty() || base.isEmpty()) null else AvatarMedia.image(context, avatarId, base, dp(96f))
      return LookColor.tint(avatarId, picture, avatarColor)
    }

  private val shownName: String get() = (peer["displayName"] as? String)?.takeIf { it.isNotEmpty() } ?: name

  private fun person(): Person = Person(peerId, peer["username"] as? String ?: "", shownName, "", "", avatarColor, avatarId)

  private fun showPeer() {
    val look = PersonLook.from(peer)
    // Owner's rule: frames only in the chat list and profiles — the header avatar is plain (the video avatar stays).
    val plain = look.copy(avatarFrame = "", seal = "", birthday = "")
    avatar.show(person(), plain, base, animated = true)
    emoji.show(look, 16f, gem = true, animated = true)
    val platina = peer["seal"] == "platina"
    metal.visibility = if (platina) View.VISIBLE else View.GONE
    host.requestLayout()
  }

  private fun currentUnread(): Int {
    if (messenger == null) return if (LookDemo.chatlook != null) 3 else 0
    return ChatLookUnread.elsewhere(chatId)
  }

  private fun unreadChanged() {
    val next = currentUnread()
    if (next == unread) return
    unread = next
    host.requestLayout()
  }

  /** Bubbles or the open look, their colours, the wallpaper or the light, the header's edge. */
  fun apply() {
    val choice = Wallpapers.choice(chatId)
    bubbles = ChatBubbleLook.bubbles(chatId)
    val tint = peerTint
    ChatBubbleLook.open = !bubbles
    ChatBubbleLook.radius = ChatBubbleLook.chosenRadius
    ChatBubbleLook.peerLine = LookColor.argb(LookColor.bright(tint, if (Theme.dark) 190 else 0))
    list?.setLook(ChatBubbleLook.palette(bubbles))
    wallpaper.show(choice)
    wallpaper.visibility = if (choice.shown) View.VISIBLE else View.GONE
    light.peerColor = tint
    light.visibility = if (choice.shown) View.GONE else View.VISIBLE
    // The edge takes the wallpaper's own colour at the top, so it never shows as a band over it.
    val colors = choice.colors
    if (colors != null && colors.isNotEmpty()) { edge.color = colors[0]; edge.alphaOfEdge = 0.9f }
    else if (choice.isImage) { edge.color = 0; edge.alphaOfEdge = 0.5f }
    else { edge.color = Theme.bg and 0xFFFFFF; edge.alphaOfEdge = 0.96f }
    host.requestLayout()
  }

  // Layout

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** Places the header after the screen and ChatActions placed theirs (`safeTop`: the status bar), px. */
  fun place(width: Int, height: Int, safeTop: Int) {
    val heading = heading ?: return; val back = back ?: return; val call = call ?: return; val status = status ?: return
    // The light runs past the screen's edges (top -80, bottom -60), as in the reference.
    light.translationY = -80 * d
    light.scaleY = (height + 140 * d) / height.coerceAtLeast(1)
    light.pivotY = 0f
    val headerSize = safeTop + dp(52f)
    edge.size = headerSize.toFloat()
    put(edge, 0, 0, width, headerSize + dp(HeaderEdgeView.FADE))
    // ChatActions hides the name while messages are being chosen: the glass goes with it.
    val choosing = heading.visibility != View.VISIBLE
    val pillsShown = if (choosing) View.GONE else View.VISIBLE
    for (part in listOf(backPill, namePill, callPill, avatarControl)) if (part.visibility != pillsShown) part.visibility = pillsShown
    if (choosing) return
    back.visibility = View.VISIBLE
    val y = safeTop + dp(8f)
    val side = dp(44f)

    // «назад»
    badge.visibility = if (unread == 0) View.GONE else View.VISIBLE
    badge.text = if (unread > 99) "99+" else unread.toString()
    badge.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val badgeWidth = if (unread == 0) 0 else maxOf(dp(18f), badge.measuredWidth + dp(10f))
    back.contentDescription = if (unread == 0) "Назад к чатам" else "Назад к чатам, непрочитанных $unread"
    val backWidth = if (unread == 0) side else dp(9f + 22f - 4f) + badgeWidth + dp(11f)
    put(backPill, dp(12f), y, backWidth, side)
    put(back, 0, 0, if (unread == 0) side else dp(36f), side)
    put(badge, dp(9f + 22f - 4f), (side - dp(18f)) / 2, badgeWidth, dp(18f))

    // The right column: «Позвонить», then the avatar at the edge.
    val avatarX = width - dp(12f) - side
    put(avatarControl, avatarX, y, side, side)
    val callX = avatarX - dp(8f) - side
    put(callPill, callX, y, side, side)
    put(call, 0, 0, side, side)

    // The name: in the very middle of the screen; when it is too long for that, in the middle of the room between
    // «назад» and the right column.
    heading.textSize = 16f
    heading.typeface = Theme.weight(600)
    heading.letterSpacing = -0.25f / 16f
    heading.gravity = Gravity.CENTER
    heading.maxLines = 1
    heading.ellipsize = TextUtils.TruncateAt.END
    val words = heading.text.toString().ifEmpty { name }
    val hasStatus = status.text.isNotEmpty()
    status.visibility = if (hasStatus) View.VISIBLE else View.GONE
    emoji.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED), View.MeasureSpec.makeMeasureSpec(dp(22f), View.MeasureSpec.EXACTLY))
    val emojiWidth = if (emoji.visibility != View.VISIBLE) 0 else emoji.measuredWidth + dp(5f)
    val nameWidth = Math.ceil(heading.paint.measureText(words).toDouble()).toInt() + emojiWidth
    val statusWidth = if (hasStatus) Math.ceil(status.paint.measureText(status.text.toString()).toDouble()).toInt() else 0
    val wanted = maxOf(nameWidth, statusWidth) + dp(36f)
    val rightColumn = width - callX
    val symmetric = width - 2 * (rightColumn + dp(8f))
    val backRight = dp(12f) + backWidth
    val between = callX - dp(8f) - (backRight + dp(8f))
    val pillWidth = maxOf(dp(60f), minOf(wanted, (width * 0.62f).toInt(), if (wanted <= symmetric) symmetric else between))
    var pillX = (width - pillWidth) / 2
    if (pillWidth > symmetric) pillX = backRight + dp(8f) + (between - pillWidth) / 2
    put(namePill, pillX, y, pillWidth, side)
    namePill.contentDescription = "Профиль $words"

    val inner = pillWidth - dp(36f)
    val shownName = minOf(nameWidth - emojiWidth, inner - emojiWidth)
    val rowWidth = shownName + emojiWidth
    val nameY = if (hasStatus) dp(4.5f) else (side - dp(20f)) / 2
    val nameX = dp(18f) + (inner - rowWidth) / 2
    put(heading, nameX, nameY, shownName, dp(20f))
    put(emoji, nameX + shownName + dp(5f), nameY - dp(1f), maxOf(0, emojiWidth - dp(5f)), dp(22f))
    status.gravity = Gravity.CENTER
    put(status, dp(18f), nameY + dp(20f), inner, dp(15f))
    // Platina: the letters in moving platinum over the plain ones.
    if (metal.visibility == View.VISIBLE) {
      metal.textSize = 16f
      metal.typeface = Theme.weight(600)
      metal.letterSpacing = heading.letterSpacing
      metal.gravity = Gravity.CENTER
      if (metal.text.toString() != words) metal.show(words, platina = true, animated = true)
      put(metal, nameX, nameY, shownName, dp(20f))
      heading.alpha = 0.011f
    } else heading.alpha = 1f
  }

  // Touches

  /** The large picture with «Открыть профиль», «Поиск» and «Отправить подарок». */
  fun showPeek() {
    // Avatars: the decorated, animated avatar of 220 dp (the reference's `DecoratedAvatar size={220} animated round`):
    // its frame, art or code frame, the silent video avatar; the gap of a ring is the card's colour.
    val large = DecoratedAvatarView(context)
    large.ringBackground = if (Theme.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt()
    large.show(person(), PersonLook.from(peer), base, animated = true)
    val items = arrayListOf(AvatarPeek.Item("person", "Открыть профиль") { host.openProfile() })
    onSearch?.let { items.add(AvatarPeek.Item("search", "Поиск", it)) }
    onGift?.let { items.add(AvatarPeek.Item("gift", "Отправить подарок", it)) }
    val top = (host.rootWindowInsets?.systemWindowInsetTop ?: 0) + dp(60f)
    AvatarPeek(context, large, shownName, status?.text?.toString() ?: "", top, items).show()
  }

  /** «Обои чатов» for this chat (the profile's «Обои»). */
  fun openWallpaper() { WallpaperPicker(context, chatId).show() }

  /** The emulator check: the list the look works on. */
  val listForDemo: MsgListView? get() = list
}
