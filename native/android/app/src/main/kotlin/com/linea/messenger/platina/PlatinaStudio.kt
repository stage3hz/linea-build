package com.linea.messenger.platina

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.ChatListDecor
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.NameplateView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.PlatinaSealView
import com.linea.messenger.avatars.StatusEmojiView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.chats.ChatRowView
import com.linea.messenger.people.Person
import com.linea.messenger.profile.ProfileAmbientView
import com.linea.messenger.profile.ProfileBannerView
import com.linea.messenger.profile.ProfileEffectView
import com.linea.messenger.profile.MiniProfile
import com.linea.messenger.profile.ProfileIconView
import com.linea.messenger.profile.ProfilePhotoChange
import com.linea.messenger.profile.patchOwnProfile
import com.linea.messenger.profile.profileHeroRatio
import com.linea.messenger.settings.OwnProfile
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.SettingsNotice
import com.linea.messenger.settings.SettingsPage
import com.linea.messenger.settings.ownProfile
import java.io.File
import java.time.Instant
import java.time.ZoneId

/** Sample data for the debug build (set by profile/ProfileSamples.kt of src/debug): the sample account's raw `user`
 *  and whether its Platina counts as active. Null in a release build. */
object PlatinaSamples {
  var me: (() -> Map<String, Any?>)? = null
  var active: () -> Boolean = { true }
}

/** The Platina decoration editor (the reference's platina/PlatinaStudio.tsx; iOS Platina/PlatinaStudio.swift):
 *  frames and art in an even grid with tabs, the banner presets, the profile effects and the nameplates, each with
 *  its live look. Without Platina everything is shown but locked (the server enforces the same). A choice shows as
 *  chosen at once; requests go one after another and the last choice wins. `compact`: inside the profile editor (the
 *  photo / video of the avatar and the banner are changed at its top), only the decorations. */
@SuppressLint("ViewConstructor")
class PlatinaStudioView(context: Context, private val messenger: Messenger?, private val compact: Boolean) : LinearLayout(context) {
  private var saved: Map<String, Any?> = messenger?.ownProfile ?: PlatinaSamples.me?.invoke() ?: emptyMap()
  private val optimistic = LinkedHashMap<String, Any?>()
  private var applySeq = 0
  private val queue = ArrayList<Triple<Int, Map<String, Any?>, String>>()
  private var running = false
  private var tab = "Анимация"
  private var noticeWords = ""
  private var problemWords = ""
  /** The avatar-video and banner buttons of the full studio: "avatarVideo", "banner". */
  var onMedia: ((String) -> Unit)? = null
  private val outside: () -> Unit = { if (messenger != null && optimistic.isEmpty()) saved = messenger.ownProfile; rebuild() }
  private val platinaChanged: (Unit) -> Unit = { outside() }

  init {
    orientation = VERTICAL
    val initial = PersonLook.from(saved).avatarFrame
    tab = if (AvatarCatalog.isCodeFrame(initial)) "Анимация" else AvatarCatalog.decoration(initial)?.collection ?: (if (initial.isEmpty()) "Анимация" else "Кольца")
    rebuild()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); OwnProfile.watch(outside); PlatinaState.changed.watch(platinaChanged) }
  override fun onDetachedFromWindow() { OwnProfile.unwatch(outside); PlatinaState.changed.unwatch(platinaChanged); super.onDetachedFromWindow() }

  private val active: Boolean get() = if (messenger == null) PlatinaSamples.active() else PlatinaState.active

  private val user: Map<String, Any?> get() = LinkedHashMap(saved).apply { putAll(optimistic) }
  private val person: Person get() = (Person.from(user) ?: Person("", "", user["displayName"] as? String ?: "", "", "", 0x5E7BFF, "")).copy(look = PersonLook.from(user))
  private val base: String get() = messenger?.server?.endpoint ?: ""

  // Saving

  private fun apply(change: Map<String, Any?>, ok: String) {
    if (!active) return
    applySeq += 1
    noticeWords = ""; problemWords = ""
    optimistic.putAll(change)
    rebuild()
    if (messenger == null) {
      saved = LinkedHashMap(saved).apply { putAll(change) }
      optimistic.clear()
      noticeWords = ok
      rebuild()
      return
    }
    queue.add(Triple(applySeq, change, ok))
    runQueue()
  }

  /** One request after another, so the server ends on the same choice as the screen. */
  private fun runQueue() {
    val messenger = messenger ?: return
    if (running || queue.isEmpty()) return
    running = true
    val next = queue.removeAt(0)
    messenger.patchOwnProfile(next.second) { result ->
      running = false
      if (next.first == applySeq) {
        val fresh = result.getOrNull()
        if (fresh != null) { if (fresh.isNotEmpty()) saved = fresh; noticeWords = next.third }
        else {
          // An older server does not know the newest frames yet.
          val words = com.linea.messenger.net.Server.error(result).words.ifEmpty { "Не удалось сохранить оформление." }
          problemWords = if (words == "Неизвестная рамка.") "Эта рамка пока недоступна: сервер ещё не обновлён." else words
        }
        optimistic.clear()
        rebuild()
      }
      runQueue()
    }
  }

  // Building

  private fun rebuild() {
    removeAllViews()
    val look = PersonLook.from(user)
    fun add(view: View, gap: Float = 16f) = addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (childCount > 0) topMargin = context.px(gap) })
    if (!compact) {
      add(ProfileHeroCard(context).apply { show(person, look, base) })
      add(section("Так тебя видят", "Твоя строка в «Чатах» у собеседника: рамка, табличка, имя и статус — как в настоящем списке.", seenBy()))
    }
    if (!active) {
      val lock = LinearLayout(context).apply {
        orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        background = context.plate(com.linea.messenger.settings.ThemeStore.look.accentSoft, 14f)
        setPadding(context.px(12f), context.px(12f), context.px(12f), context.px(12f))
        addView(ProfileIconView(context, "ion:lock-closed", 15f, Theme.accent), LayoutParams(context.px(15f), context.px(15f)))
        addView(context.words("Оформление доступно с Platina.", 13f, Theme.text), LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(8f) })
      }
      add(lock)
    }
    if (problemWords.isNotEmpty()) add(SettingsNotice(context, problemWords, error = true))
    if (noticeWords.isNotEmpty()) add(SettingsNotice(context, noticeWords))

    if (!compact) {
      val row = LinearLayout(context).apply { orientation = HORIZONTAL }
      val pick = SettingsButton(context, if (look.avatarVideoId.isEmpty()) "Выбрать видео" else "Заменить видео", SettingsButton.Kind.SECONDARY, icon = "videocam-outline")
      pick.isEnabled = active
      pick.onPress = { onMedia?.invoke("avatarVideo") }
      row.addView(pick, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      if (look.avatarVideoId.isNotEmpty()) {
        val off = SettingsButton(context, "Убрать", SettingsButton.Kind.SECONDARY, icon = "trash-outline")
        off.isEnabled = active
        off.onPress = { apply(mapOf("avatarVideoId" to null), "Видео убрано.") }
        row.addView(off, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(10f) })
      }
      add(section("Анимированный аватар", "Короткое видео до 10 секунд. Играет без звука в профиле и в шапке чата.", row))
    }

    add(section("Рамки и украшения", "Видны всем рядом с твоим фото; анимация играет в профиле и у выбранной.", frameGrid(look)))

    val banners = strip()
    banners.addView(choice("Нет", look.bannerId.isEmpty() && look.bannerPreset.isEmpty(), dashed(84f, 46f, 12f)) { apply(mapOf("bannerId" to null, "bannerPreset" to null), "Баннер убран.") })
    for (banner in AvatarCatalog.banners) {
      val swatch = ProfileAmbientView(context).apply { show(banner.id, still = true); background = context.plate(0, 12f); clipToOutline = true }
      banners.addView(choice(banner.label, look.bannerId.isEmpty() && look.bannerPreset == banner.id, sized(swatch, 84f, 46f)) { apply(mapOf("bannerId" to null, "bannerPreset" to banner.id), "Баннер «${banner.label}».") })
    }
    val bannerBox = LinearLayout(context).apply { orientation = VERTICAL }
    bannerBox.addView(scroller(banners))
    if (!compact) {
      val own = SettingsButton(context, if (look.bannerId.isEmpty()) "Своё фото или видео" else "Заменить своё фото или видео", SettingsButton.Kind.SECONDARY, icon = "image-outline")
      own.isEnabled = active
      own.onPress = { onMedia?.invoke("banner") }
      bannerBox.addView(own, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
    }
    add(section("Баннер профиля", "Живой фон над аватаром — или своё фото или видео.", bannerBox))

    val effects = strip()
    effects.addView(choice("Нет", look.profileEffect.isEmpty(), dashed(56f, 56f, 16f)) { apply(mapOf("profileEffect" to null), "Эффект убран.") })
    for (effect in AvatarCatalog.effects) {
      val swatch = ProfileEffectView(context).apply { background = context.plate(0xFF11141C.toInt(), 16f); clipToOutline = true; show(effect.id, preview = true) }
      effects.addView(choice(effect.label, look.profileEffect == effect.id, sized(swatch, 56f, 56f)) { apply(mapOf("profileEffect" to effect.id), "Эффект «${effect.label}».") })
    }
    add(section("Эффект профиля", "Играет поверх твоего профиля, когда его открывают.", scroller(effects)))

    val plates = strip()
    plates.addView(choice("Нет", look.nameplate.isEmpty(), dashed(120f, 40f, 12f)) { apply(mapOf("nameplate" to null), "Табличка убрана.") })
    for (plate in AvatarCatalog.plates) {
      val swatch = FrameLayout(context).apply { background = context.plate(Theme.surface2, 12f); clipToOutline = true }
      swatch.addView(NameplateView(context).apply { show(plate.id, 12f * resources.displayMetrics.density) }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      swatch.addView(context.words(person.displayName, 13f, 0xFFFFFFFF.toInt(), 600).apply { gravity = Gravity.CENTER_VERTICAL; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = context.px(10f); rightMargin = context.px(6f) })
      plates.addView(choice(plate.label, look.nameplate == plate.id, sized(swatch, 120f, 40f)) { apply(mapOf("nameplate" to plate.id), "Табличка «${plate.label}».") })
    }
    add(section("Табличка", "Фон за твоим именем в списке чатов и участников серверов.", scroller(plates)))
  }

  /** «Так тебя видят»: the real chat-list row (chats/ChatRowView.kt, built by the list's own `Messenger.summary` with
   *  ChatListDecor) of a chat with this account, as the other person's list shows it — with what is chosen here, also
   *  before the server answers. The row draws in one pass and its frames stand still, so it costs one view. Under it
   *  the real mini profile opens on a tap. */
  private fun seenBy(): View {
    val box = LinearLayout(context).apply { orientation = VERTICAL }
    ChatListDecor.install(context)
    val card = FrameLayout(context).apply {
      background = GradientDrawable().apply { setColor(Theme.bg); cornerRadius = 20f * resources.displayMetrics.density; setStroke(context.px(1f), com.linea.messenger.settings.ThemeStore.look.border) }
      clipToOutline = true
    }
    val row = ChatRowView(context)
    previewRow(user, base)?.let { row.bind(it, Theme.chatList) }
    row.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    card.addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    box.addView(card, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    val mini = SettingsButton(context, "Показать мини-профиль", SettingsButton.Kind.SECONDARY, icon = "person-circle-outline")
    mini.onPress = { MiniProfile(context, person, messenger).show() }
    box.addView(mini, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
    return box
  }

  private fun section(title: String, hint: String, body: View): View = LinearLayout(context).apply {
    orientation = VERTICAL
    addView(context.words(title, 15f, Theme.text, 600))
    addView(context.words(hint, 12f, Theme.muted).apply { if (android.os.Build.VERSION.SDK_INT >= 28) lineHeight = context.px(17f) }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
    addView(body, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(9f) })
  }

  private fun strip(): LinearLayout = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.TOP; setPadding(context.px(2f), context.px(4f), context.px(2f), context.px(4f)) }

  private fun scroller(row: LinearLayout): View = HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; clipChildren = false; addView(row) }

  private fun sized(view: View, w: Float, h: Float): View { view.layoutParams = ViewGroup.LayoutParams(context.px(w), context.px(h)); return view }

  private fun dashed(w: Float, h: Float, radius: Float): View = object : View(context) {
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Theme.subtle; strokeWidth = resources.displayMetrics.density; pathEffect = DashPathEffect(floatArrayOf(4 * resources.displayMetrics.density, 3 * resources.displayMetrics.density), 0f) }
    override fun onDraw(canvas: Canvas) { val r = radius * resources.displayMetrics.density; canvas.drawRoundRect(1f, 1f, width - 1f, height - 1f, r, r, line) }
  }.also { it.layoutParams = ViewGroup.LayoutParams(context.px(w), context.px(h)) }

  /** A choice of a strip: its swatch in a frame that lights up when chosen, its name under it. */
  private fun choice(label: String, selected: Boolean, swatch: View, action: () -> Unit): View {
    val holder = LinearLayout(context).apply { orientation = VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
    val frame = FrameLayout(context)
    frame.setPadding(context.px(5f), context.px(5f), context.px(5f), context.px(5f))
    frame.background = GradientDrawable().apply { cornerRadius = 18f * resources.displayMetrics.density; setStroke(context.px(2f), if (selected) Theme.accent else 0) }
    val size = swatch.layoutParams
    frame.addView(swatch, FrameLayout.LayoutParams(size.width, size.height))
    holder.addView(frame)
    holder.addView(context.words(label, 11f, if (selected) Theme.accent else Theme.muted, if (selected) 700 else 500), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    holder.isClickable = true
    holder.isEnabled = active
    holder.isSelected = selected
    holder.contentDescription = label
    holder.setOnClickListener { action() }
    // The reference's Choice: 0.7 while pressed, at once.
    holder.setOnTouchListener { view, event ->
      when (event.actionMasked) { android.view.MotionEvent.ACTION_DOWN -> view.alpha = 0.7f; android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> view.alpha = 1f }
      false
    }
    return LinearLayout(context).apply { addView(holder); setPadding(0, 0, context.px(10f), 0) }
  }

  // Frames

  companion object {
    private val gridTabs = listOf("Анимация") + AvatarCatalog.decorationCollections + listOf("Кольца")
    private const val VIEWER = "studio-viewer"

    /** The row of a chat with the account `user` (its raw profile, choices included) in someone else's list: the
     *  list's own `Messenger.summary`, so the avatar, the frame or art, the nameplate, the Platina name and the
     *  status emoji are exactly the list's; the last message «Привет! 👋» is theirs, read (two ticks). */
    fun previewRow(user: Map<String, Any?>, base: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): ChatRow? {
      val peer = LinkedHashMap(user)
      if ((peer["id"] as? String).isNullOrEmpty()) peer["id"] = "me"
      val chat = mapOf<String, Any?>("id" to "studio-preview", "peer" to peer, "peerLastReadMessageId" to 1)
      val last = mapOf<String, Any?>("id" to 1, "senderId" to VIEWER, "text" to "Привет! 👋", "createdAt" to now.minusSeconds(120).toString())
      val summary = Messenger.summary(chat, last, VIEWER, now, zone, base = base) ?: return null
      return ChatRow.parse(listOf(summary.row)).firstOrNull()
    }
  }

  /** Tabs and an even three-column grid; the chosen tile wears a check mark and plays its motion. */
  private fun frameGrid(look: PersonLook): View {
    val column = LinearLayout(context).apply { orientation = VERTICAL }
    val tabs = strip()
    for (name in gridTabs) {
      val on = tab == name
      val button = context.words(name, 13f, if (on) Theme.onAccent else Theme.text, if (on) 700 else 500)
      button.gravity = Gravity.CENTER
      button.setPadding(context.px(14f), 0, context.px(14f), 0)
      button.background = context.plate(if (on) Theme.accent else Theme.surface2, 17f)
      button.isClickable = true; button.isSelected = on
      button.setOnClickListener { tab = name; rebuild() }
      tabs.addView(button, LayoutParams(LayoutParams.WRAP_CONTENT, context.px(34f)).apply { rightMargin = context.px(6f) })
    }
    column.addView(scroller(tabs))
    val options = when (tab) {
      "Анимация" -> AvatarCatalog.codeFrames.map { it.id to it.label }
      "Кольца" -> AvatarCatalog.frames.map { it.id to it.label }
      else -> AvatarCatalog.decorations.filter { it.collection == tab }.map { it.id to it.label }
    }
    val all = listOf("" to "Без рамки") + options
    var row: LinearLayout? = null
    all.forEachIndexed { index, (id, label) ->
      if (index % 3 == 0) { row = LinearLayout(context).apply { orientation = HORIZONTAL }; column.addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(12f) }) }
      row?.addView(frameTile(id, label, look.avatarFrame == id), LayoutParams(0, context.px(76f + 20f + 26f), 1f).apply { if (index % 3 > 0) leftMargin = context.px(10f) })
    }
    val rest = (3 - all.size % 3) % 3
    repeat(rest) { row?.addView(View(context), LayoutParams(0, 1, 1f).apply { leftMargin = context.px(10f) }) }
    return column
  }

  private fun frameTile(id: String, label: String, selected: Boolean): View {
    val tile = FrameLayout(context)
    tile.clipChildren = false
    tile.isEnabled = active
    tile.alpha = if (!active && !selected) 0.55f else 1f
    tile.background = GradientDrawable().apply { cornerRadius = 18f * resources.displayMetrics.density; setColor(if (selected) com.linea.messenger.settings.ThemeStore.look.accentSoft else 0); setStroke(Math.round(1.5f * resources.displayMetrics.density), if (selected) Theme.accent else 0) }
    tile.contentDescription = label
    tile.isSelected = selected
    val box = FrameLayout(context).apply { clipChildren = false }
    if (id.isEmpty()) box.addView(dashed(52f, 52f, 26f).apply { layoutParams = FrameLayout.LayoutParams(context.px(52f), context.px(52f), Gravity.CENTER) })
    else {
      val avatar = DecoratedAvatarView(context)
      val look = PersonLook.from(user).copy(avatarFrame = id, avatarVideoId = "", birthday = "")
      avatar.show(person, look, base, animated = selected)
      box.addView(avatar, FrameLayout.LayoutParams(context.px(50f), context.px(50f), Gravity.CENTER))
    }
    tile.addView(box, FrameLayout.LayoutParams(context.px(76f), context.px(76f), Gravity.CENTER_HORIZONTAL).apply { topMargin = context.px(10f) })
    tile.addView(context.words(label, 12f, if (selected) Theme.accent else Theme.muted, if (selected) 700 else 500).apply { gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(92f); leftMargin = context.px(4f); rightMargin = context.px(4f) })
    if (selected) {
      val check = FrameLayout(context).apply { background = context.plate(Theme.accent, 10f) }
      check.addView(ProfileIconView(context, "ion:checkmark", 13f, Theme.onAccent), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      tile.addView(check, FrameLayout.LayoutParams(context.px(20f), context.px(20f), Gravity.END or Gravity.TOP).apply { topMargin = context.px(6f); rightMargin = context.px(8f) })
    }
    tile.isClickable = true
    // The reference's tile: 0.94 while pressed, at once.
    tile.setOnTouchListener { view, event ->
      when (event.actionMasked) { android.view.MotionEvent.ACTION_DOWN -> { view.scaleX = 0.94f; view.scaleY = 0.94f }; android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { view.scaleX = 1f; view.scaleY = 1f } }
      false
    }
    tile.setOnClickListener { apply(mapOf("avatarFrame" to id.ifEmpty { null }), if (id.isEmpty()) "Рамка убрана." else "Выбрано: «$label».") }
    return tile
  }
}

/** The top of a profile as others see it (PlatinaStudio.tsx `ProfileHero`, same proportions as the settings head):
 *  banner with soft edges, the avatar, the name, the status, @username and the seal. `localPicture` /
 *  `localVideo`: a banner picked here and not uploaded yet. */
class ProfileHeroCard(context: Context) : ViewGroup(context) {
  private val banner = ProfileBannerView(context)
  private val empty = context.words("Без баннера", 12f, Theme.muted).apply { gravity = Gravity.CENTER }
  private val ring = View(context)
  private val avatar = DecoratedAvatarView(context)
  private val name = PlatinaNameView(context)
  private val status = StatusEmojiView(context)
  private val handle = context.words("", 15f, Theme.muted)
  private val seal = PlatinaSealView(context, small = true)

  init {
    background = GradientDrawable().apply { setColor(Theme.bg); cornerRadius = 24f * resources.displayMetrics.density; setStroke(context.px(1f), com.linea.messenger.settings.ThemeStore.look.border) } // `t.border`
    clipToOutline = true
    // The avatar's frame reaches past the avatar's own box (avatars/DecoratedAvatarView.kt: the parents must not
    // clip); the card's rounded outline still clips the whole.
    clipChildren = false
    addView(banner); addView(empty)
    ring.background = GradientDrawable().apply { setColor(Theme.bg) } // a rounded square (`borderRadius: 40 * scale`), set in layout
    addView(ring)
    avatar.ringBackground = Theme.bg
    addView(avatar); addView(name); addView(status); addView(handle); addView(seal)
    name.typeface = Theme.weight(800)
  }

  fun show(person: Person, look: PersonLook, base: String, localPicture: Bitmap? = null, localVideo: File? = null) {
    banner.show(look, base, localPicture = localPicture, localVideo = localVideo)
    empty.visibility = if (banner.hasContent) GONE else VISIBLE
    avatar.show(person, look, base, animated = true)
    name.show(person.displayName, look.platina)
    shownLook = look; statusSide = 0f // sized in layout: round(22 × scale), as the reference
    handle.text = if (person.username.isEmpty()) "" else "@" + person.username
    seal.visibility = if (look.platina) VISIBLE else GONE
    seal.owner = person.id to person.displayName
    requestLayout()
  }

  private fun put(view: View, l: Int, t: Int, w: Int, h: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, w), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(maxOf(0, h), MeasureSpec.EXACTLY))
    view.layout(l, t, l + maxOf(0, w), t + maxOf(0, h))
  }

  private var layoutTotal = 0
  private var shownLook: PersonLook? = null
  private var statusSide = 0f

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val d = resources.displayMetrics.density
    val scale = width / (393f * d)
    val height = Math.round(width * profileHeroRatio)
    name.textSize = 26f * scale
    name.letterSpacing = -0.5f / (26f * scale)
    handle.textSize = 15f * scale
    val wantedStatus = Math.round(22f * scale).toFloat()
    shownLook?.let { if (statusSide != wantedStatus) { statusSide = wantedStatus; status.show(it, wantedStatus, animated = true) } }
    name.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    handle.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val side = 100f * d * scale; val pad = 5f * d * scale
    val ringBottom = height - 58 * d * scale + side + pad * 2
    status.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val nameRow = maxOf(name.measuredHeight, if (status.visibility == VISIBLE) status.measuredHeight else 0)
    layoutTotal = Math.round(ringBottom + 10 * d * scale + nameRow + 4 * d * scale + handle.measuredHeight + 16 * d * scale)
    setMeasuredDimension(width, layoutTotal)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    val d = resources.displayMetrics.density
    val scale = width / (393f * d)
    val height = Math.round(width * profileHeroRatio)
    put(banner, 0, 0, width, height); put(empty, 0, 0, width, height)
    val side = Math.round(Math.round(100 * scale) * d); val pad = Math.round(5 * d * scale)
    (ring.background as? GradientDrawable)?.cornerRadius = 40 * d * scale
    val ringLeft = Math.round(20 * d * scale); val ringTop = height - Math.round(58 * d * scale)
    put(ring, ringLeft, ringTop, side + pad * 2, side + pad * 2)
    put(avatar, ringLeft + pad, ringTop + pad, side, side)
    status.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val statusW = if (status.visibility == VISIBLE) status.measuredWidth else 0
    val nameTop = ringTop + side + pad * 2 + Math.round(10 * d * scale)
    val nameW = minOf(name.measuredWidth, width - Math.round(40 * d * scale) - statusW - Math.round(8 * d))
    val nameH = maxOf(name.measuredHeight, if (statusW > 0) status.measuredHeight else 0)
    put(name, ringLeft, nameTop, nameW, nameH)
    if (statusW > 0) put(status, ringLeft + nameW + Math.round(8 * d * scale), nameTop + (nameH - status.measuredHeight) / 2, statusW, status.measuredHeight)
    val handleTop = nameTop + nameH + Math.round(4 * d * scale)
    put(handle, ringLeft, handleTop, handle.measuredWidth, handle.measuredHeight)
    seal.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    put(seal, ringLeft + handle.measuredWidth + Math.round(8 * d), handleTop + (handle.measuredHeight - seal.measuredHeight) / 2, seal.measuredWidth, seal.measuredHeight)
  }
}

/** The full studio as its own page («Настроить оформление» of the showcase). */
@SuppressLint("ViewConstructor")
class PlatinaStudioScreen(context: Context, private val messenger: Messenger?) : SettingsPage(context, "Оформление профиля") {
  private var media: ProfilePhotoChange? = null

  override fun build() {
    val studio = PlatinaStudioView(context, messenger, compact = false)
    add(studio, 8f)
    PlatinaState.refresh()
    studio.onMedia = { what ->
      val messenger = messenger
      if (messenger != null) {
        val change = media ?: ProfilePhotoChange(context, messenger).also { media = it }
        when (what) {
          "avatarVideo" -> change.pickVideoAvatar()
          "banner" -> change.ask("banner")
        }
      }
    }
  }
}
