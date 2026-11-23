package com.linea.messenger.profile

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Switch
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.PlatinaSealView
import com.linea.messenger.avatars.StatusEmojiView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Server
import com.linea.messenger.people.FriendRequests
import com.linea.messenger.people.Person
import com.linea.messenger.people.acceptFriend
import com.linea.messenger.people.addFriend
import com.linea.messenger.people.dropFriendRequest
import com.linea.messenger.people.personProfile
import com.linea.messenger.people.removeFriend
import com.linea.messenger.people.setPersonBlocked

/** The mini profile (the reference's MiniProfile.tsx; iOS Profile/MiniProfile.swift): tap a name or an avatar and a
 *  compact card rises from the bottom — the banner or a quiet strip of the person's colour, the decorated avatar, the
 *  platinum name with the status, @username with the seal, the presence, «о себе», and the obvious actions. Pulled
 *  down or tapped outside, it closes. `quick` (a personal chat): «Звонок», «Видео», «Вложения» tiles and the chat's own
 *  rows — friends, no copying, block. */
class MiniProfile(
  context: Context, private val person: Person, private val messenger: Messenger?, private val statusWords: String? = null,
  private val onWrite: (() -> Unit)? = null, private val onOpenProfile: (() -> Unit)? = null, private val quick: Quick? = null,
) : Dialog(context, android.R.style.Theme_Translucent_NoTitleBar) {
  class Quick(val onCall: ((Boolean) -> Unit)?, val onAttachments: () -> Unit, var noCopy: Boolean, val onNoCopy: ((Boolean) -> Unit)?)

  private val surface = Theme.panel(0xFF1C1D20.toInt())
  private val dim = View(context)
  private val card = LinearLayout(context)
  private val rows = LinearLayout(context)
  // Empty, it takes no height (as an empty label in the iPhone's stack: only the gaps above and below it stay),
  // so no line-high gap under the group.
  private val note = object : android.widget.TextView(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      super.onMeasure(widthMeasureSpec, heightMeasureSpec)
      if (text.isNullOrEmpty()) setMeasuredDimension(measuredWidth, 0)
    }
  }.apply { textSize = 13f; typeface = Theme.weight(400); setTextColor(Theme.muted); includeFontPadding = false }
  private var isFriend: Boolean? = null
  private var request: String? = null
  private var blocked = false
  private var confirmBlock = false
  private var busy = false
  private val base: String get() = messenger?.server?.endpoint ?: ""

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val root = FrameLayout(context)
    dim.setBackgroundColor(0x73000000)
    dim.alpha = 0f
    dim.contentDescription = "Закрыть"
    dim.setOnClickListener { close() }
    root.addView(dim, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    val width = minOf(context.resources.displayMetrics.widthPixels - context.px(24f), context.px(520f))
    card.orientation = LinearLayout.VERTICAL
    card.background = context.plate(surface, 22f, Theme.veil(0.1f))
    card.clipToOutline = true
    card.isClickable = true
    root.addView(card, FrameLayout.LayoutParams(width, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = context.px(12f) })
    build(width)
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply { setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT) }
    card.post { card.setOnTouchListener(pull) }
    if (quick != null && messenger != null) {
      messenger.personProfile(person.id) { result ->
        val profile = result.getOrNull()
        if (profile != null) { isFriend = profile.isFriend; request = profile.request; blocked = profile.blocked } else isFriend = false
        buildRows()
      }
    }
    card.post {
      card.translationY = card.height + context.px(40f).toFloat()
      card.animate().translationY(0f).setDuration(320).start()
      dim.animate().alpha(1f).setDuration(320).start()
    }
  }

  private fun build(width: Int) {
    val c = context
    val look = person.look
    val bannerHeight = c.px(if (look.hasBanner) 84f else 56f)
    val top = FrameLayout(c)
    if (look.hasBanner) top.addView(ProfileBannerView(c).apply { show(look, base) })
    else top.addView(View(c).apply { setBackgroundColor(Theme.alpha(0xFF000000.toInt() or person.avatarColor, 0.18f)) })
    card.addView(top, LinearLayout.LayoutParams(width, bannerHeight))
    val column = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL; clipChildren = false }
    val ring = FrameLayout(c)
    ring.clipChildren = false
    ring.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(surface) }
    ring.contentDescription = "Открыть полный профиль"
    ring.isClickable = true
    ring.setOnClickListener { onOpenProfile?.let { dismissThen(it) } }
    val avatar = DecoratedAvatarView(c)
    avatar.ringBackground = surface
    avatar.show(person, look, base, animated = true)
    ring.addView(avatar, FrameLayout.LayoutParams(c.px(72f), c.px(72f), Gravity.CENTER))
    column.addView(ring, LinearLayout.LayoutParams(c.px(80f), c.px(80f)))
    val nameRow = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    val name = PlatinaNameView(c)
    name.textSize = 20f
    name.typeface = Theme.weight(800)
    name.show(person.displayName, look.platina)
    nameRow.addView(name)
    nameRow.addView(StatusEmojiView(c).apply { show(look, 18f, animated = true) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = c.px(6f) })
    column.addView(nameRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(6f) })
    val handleRow = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    handleRow.addView(c.words(if (person.username.isEmpty()) "" else "@" + person.username, 14f, Theme.muted))
    if (look.platina) handleRow.addView(PlatinaSealView(c, small = true).apply { owner = person.id to person.displayName }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = c.px(8f) })
    column.addView(handleRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(4f) })
    statusWords?.let { column.addView(c.words(it, 13f, Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(4f) }) }
    if (person.bio.isNotEmpty()) column.addView(c.words(person.bio, 14f, Theme.text).apply { maxLines = 4 }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(8f) })
    rows.orientation = LinearLayout.VERTICAL
    column.addView(rows, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(14f) })
    card.clipChildren = false
    card.addView(column, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = -c.px(36f); leftMargin = c.px(16f); rightMargin = c.px(16f); bottomMargin = c.px(16f) })
    buildRows()
  }

  private fun actionButton(symbol: String, label: String, primary: Boolean, action: () -> Unit): View {
    val c = context
    val line = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; background = c.plate(if (primary) Theme.accent else Theme.surface2, 14f); minimumHeight = c.px(44f) }
    val ink = if (primary) Theme.onAccent else Theme.text // onAccent: readable on every theme's accent (the reference's #FFFFFF vanishes on «Чёрная»)
    line.addView(ProfileIconView(c, symbol, 18f, ink), LinearLayout.LayoutParams(c.px(18f), c.px(18f))) // Ionicons 18
    line.addView(c.words(label, 14f, ink, 700), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = c.px(7f) })
    line.isClickable = true
    line.contentDescription = label
    line.setOnClickListener { dismissThen(action) }
    return line
  }

  private fun tile(symbol: String, label: String, action: () -> Unit): View {
    val c = context
    val box = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; background = c.plate(Theme.surface2, 14f); setPadding(c.px(4f), c.px(11f), c.px(4f), c.px(11f)) }
    box.addView(ProfileIconView(c, symbol, 21f, Theme.accent), LinearLayout.LayoutParams(c.px(21f), c.px(21f))) // Ionicons 21
    box.addView(c.words(label, 12f, Theme.text, 600), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = c.px(5f) })
    box.isClickable = true
    box.contentDescription = label
    box.setOnClickListener { dismissThen(action) }
    return box
  }

  @Suppress("UseSwitchCompatOrMaterialCode")
  private fun row(symbol: String, label: String, danger: Boolean = false, on: Boolean? = null, hint: String = "", action: () -> Unit): View {
    val c = context
    val line = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = c.px(48f); setPadding(c.px(14f), c.px(8f), c.px(14f), c.px(8f)) }
    line.addView(ProfileIconView(c, symbol, 20f, if (danger) Theme.danger else Theme.text), LinearLayout.LayoutParams(c.px(20f), c.px(20f))) // Ionicons 20
    val words = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL }
    words.addView(c.words(label, 15f, if (danger) Theme.danger else Theme.text, 600))
    if (hint.isNotEmpty()) words.addView(c.words(hint, 12f, Theme.muted))
    line.addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = c.px(12f) })
    // The reference draws its own small switch here: a 44×26 pill (radius 13, 3 inside) of the accent when on, `surface2`
    // when off, with a white 20 knob at the end.
    if (on != null) line.addView(FrameLayout(c).apply {
      background = c.plate(if (on) Theme.accent else Theme.surface2, 13f)
      addView(View(c).apply { background = c.plate(0xFFFFFFFF.toInt(), 10f) },
        FrameLayout.LayoutParams(c.px(20f), c.px(20f), Gravity.CENTER_VERTICAL or (if (on) Gravity.END else Gravity.START)).apply { leftMargin = c.px(3f); rightMargin = c.px(3f) })
    }, LinearLayout.LayoutParams(c.px(44f), c.px(26f)))
    line.isClickable = true
    line.contentDescription = label
    line.setOnClickListener { action() }
    return line
  }

  private fun buildRows() {
    rows.removeAllViews()
    val c = context
    val me = messenger?.userId == person.id
    val quick = quick
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    if (quick != null) {
      val tiles = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL }
      fun addTile(view: View) = tiles.addView(view, LinearLayout.LayoutParams(0, wrap, 1f).apply { if (tiles.childCount > 0) leftMargin = c.px(8f) })
      quick.onCall?.let { call -> addTile(tile("ion:call", "Звонок") { call(false) }); addTile(tile("ion:videocam", "Видео") { call(true) }) }
      addTile(tile("ion:images", "Вложения", quick.onAttachments))
      rows.addView(tiles, LinearLayout.LayoutParams(wide, wrap))
      val group = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL; background = c.plate(Theme.surface2, 14f); clipToOutline = true }
      val friend = isFriend
      if (friend != null) {
        val words = if (friend) "Удалить из друзей" else if (request == "outgoing") "Отменить заявку" else if (request == "incoming") "Принять в друзья" else "Добавить в друзья"
        group.addView(row(if (friend) "ion:person-remove-outline" else if (request == "outgoing") "ion:time-outline" else "ion:person-add-outline", words) { toggleFriend() })
      } else group.addView(android.widget.FrameLayout(c).apply {
        // The iPhone's medium spinner (20 pt, accent) in the middle of a 48 pt row, not a ring the row's height.
        addView(ProgressBar(c).apply { isIndeterminate = true; indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent) },
          android.widget.FrameLayout.LayoutParams(c.px(20f), c.px(20f), Gravity.CENTER))
      }, LinearLayout.LayoutParams(wide, c.px(48f)))
      quick.onNoCopy?.let { onNoCopy ->
        group.addView(row(if (quick.noCopy) "ion:lock-closed-outline" else "ion:lock-open-outline", "Запретить пересылку и копирование", on = quick.noCopy, hint = "Для обоих в этом чате") {
          card.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
          val next = !quick.noCopy
          quick.noCopy = next
          onNoCopy(next)
          note.text = if (next) "Теперь копировать и пересылать сообщения этого чата нельзя обоим" else "Копирование и пересылка снова разрешены"
          buildRows()
        })
      }
      val blockWords = if (blocked) "Разблокировать" else if (confirmBlock) "Нажми ещё раз, чтобы заблокировать" else "Заблокировать"
      group.addView(row(if (blocked) "ion:hand-left-outline" else "ion:remove-circle-outline", blockWords, danger = !blocked) { blockPressed() })
      rows.addView(group, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = c.px(10f) })
      note.gravity = Gravity.CENTER
      (note.parent as? ViewGroup)?.removeView(note)
      rows.addView(note, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = c.px(10f) })
      onOpenProfile?.let { rows.addView(actionButton("ion:person-circle-outline", "Открыть профиль", false, it), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = c.px(10f) }) }
      return
    }
    val line = LinearLayout(c).apply { orientation = LinearLayout.HORIZONTAL }
    fun addAction(view: View) = line.addView(view, LinearLayout.LayoutParams(0, wrap, 1f).apply { if (line.childCount > 0) leftMargin = c.px(8f) })
    if (!me && onWrite != null) addAction(actionButton("ion:chatbubble-outline", "Написать", true, onWrite))
    onOpenProfile?.let { addAction(actionButton("ion:person-circle-outline", "Профиль", me || onWrite == null, it)) }
    if (line.childCount > 0) rows.addView(line, LinearLayout.LayoutParams(wide, wrap))
  }

  private fun toggleFriend() {
    val messenger = messenger ?: return
    val friend = isFriend ?: return
    if (busy) return
    busy = true
    card.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    fun finish(error: com.linea.messenger.net.ServerError?, words: String, apply: () -> Unit) {
      busy = false
      if (error != null) note.text = error.words else { apply(); note.text = words; FriendRequests.refresh() }
      buildRows()
    }
    when {
      friend -> messenger.removeFriend(person.id) { error -> finish(error, "Удалён из друзей") { isFriend = false } }
      request == "outgoing" -> messenger.dropFriendRequest(person.id) { error -> finish(error, "Заявка отменена") { request = null } }
      request == "incoming" -> messenger.acceptFriend(person.id) { error -> finish(error, "Теперь вы друзья") { request = null; isFriend = true } }
      else -> messenger.addFriend(person.id) { result ->
        val friends = result.getOrNull()
        if (friends == null) finish(Server.error(result), "") {} else finish(null, if (friends) "Теперь вы друзья" else "Заявка отправлена") { if (friends) isFriend = true else request = "outgoing" }
      }
    }
  }

  private fun blockPressed() {
    val messenger = messenger ?: return
    if (busy) return
    if (!blocked && !confirmBlock) { confirmBlock = true; buildRows(); return }
    confirmBlock = false
    busy = true
    val block = !blocked
    messenger.setPersonBlocked(person.id, block) { error ->
      busy = false
      if (error != null) note.text = error.words
      else {
        blocked = block
        if (block) { isFriend = false; request = null; FriendRequests.refresh() }
        note.text = if (block) "Заблокирован: он не сможет писать и звонить" else "Разблокирован"
      }
      buildRows()
    }
  }

  private fun dismissThen(action: () -> Unit) {
    card.animate().translationY(card.height + context.px(40f).toFloat()).setDuration(200).start()
    dim.animate().alpha(0f).setDuration(200).withEndAction { dismiss(); action() }.start()
  }

  private fun close() = dismissThen {}

  private var downY = 0f
  private var downAt = 0L

  private val pull = View.OnTouchListener { _, event ->
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { downY = event.rawY; downAt = event.eventTime; false }
      MotionEvent.ACTION_MOVE -> {
        val moved = maxOf(0f, event.rawY - downY)
        card.translationY = moved
        dim.alpha = 1 - minOf(1f, moved / maxOf(1, card.height))
        moved > 8
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val moved = maxOf(0f, event.rawY - downY)
        val speed = moved / maxOf(0.016f, (event.eventTime - downAt) / 1000f)
        if (moved > card.height * 0.3f || speed > 900 * context.resources.displayMetrics.density) close()
        else { card.animate().translationY(0f).setDuration(250).start(); dim.animate().alpha(1f).setDuration(250).start() }
        moved > 8
      }
      else -> false
    }
  }
}
