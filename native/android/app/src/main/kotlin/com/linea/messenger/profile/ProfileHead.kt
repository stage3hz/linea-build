package com.linea.messenger.profile

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.AvatarMedia
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.StatusEmojiView
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.platina.ConfettiView
import com.linea.messenger.settings.BirthdayWords

/** The layers of a full profile's top that do not scroll with it (UserProfile.tsx / ProfileScreen.tsx; iOS
 *  Profile/ProfileHead.swift): the banner (fixed at the top), or the person's light falling from above; on their
 *  birthday — without a banner — the festive gradient that follows the scroll and stretches when pulled; the profile
 *  effect over everything; and on the birthday a burst of confetti once. Put `back` under the page's scroll and
 *  `front` over it; call `layout` on every scroll. */
class ProfileTopLayers(context: Context) {
  val back = FrameLayout(context)
  val front = FrameLayout(context)
  private val banner = ProfileBannerView(context)
  private val light = ProfileLightView(context)
  private val festive = View(context)
  private val effect = ProfileEffectView(context)
  private var look = PersonLook()
  private var celebrated = false
  /** False when the page already has its own light. */
  var showsLight = true
  /** The header turned festive (no banner, birthday): texts over it are white. */
  var tinted = false
    private set

  init {
    back.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    front.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    back.clipChildren = false
    back.addView(light); back.addView(festive); back.addView(banner)
    front.addView(effect)
  }

  fun show(person: Person, base: String) {
    look = person.look
    banner.show(look, base)
    val birthday = look.birthdayToday()
    tinted = !look.hasBanner && birthday
    light.visibility = if (look.hasBanner || tinted || !showsLight) View.GONE else View.VISIBLE
    light.color = person.avatarColor
    festive.visibility = if (tinted) View.VISIBLE else View.GONE
    val colors = AvatarCatalog.birthdayColors(look.gender)
    festive.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(lookColor(colors[0]), lookColor(colors[1])))
    effect.show(look.profileEffect)
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(maxOf(0, width), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(maxOf(0, height), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
  }

  /** Lays the layers out for the page's width (px), the scroll (`scrolled` < 0 when pulled down) and where the hero
   *  ends. `back` and `front` must already be placed by the page (`placeBack` / `placeFront`). */
  fun layout(width: Int, topInset: Int, scrolled: Int, heroBottom: Int) {
    val c = back.context
    put(banner, 0, 0, width, c.px(260f))
    put(light, 0, 0, width, c.px(440f))
    put(effect, 0, 0, width, c.px(420f))
    val height = topInset + c.px(56f) + heroBottom + c.px(34f) + maxOf(0, -scrolled)
    put(festive, 0, minOf(0, -scrolled), width, height)
  }

  /** The sizes of the two layers on the page (px). */
  fun backHeight(heroBottom: Int): Int = maxOf(heroBottom, back.context.px(440f)) + back.context.px(200f)
  fun frontHeight(): Int = front.context.px(420f)

  /** On the birthday: the confetti once, over the page. */
  fun celebrate(page: ViewGroup) {
    if (!look.birthdayToday() || celebrated || !AvatarMotion.enabled(page.context) || page.width <= 0) return
    celebrated = true
    val confetti = ConfettiView(page.context)
    page.addView(confetti, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    confetti.measure(View.MeasureSpec.makeMeasureSpec(page.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(page.height, View.MeasureSpec.EXACTLY))
    confetti.layout(0, 0, page.width, page.height)
    confetti.onDone = { page.removeView(confetti) }
    confetti.burst("bottom", 110, AvatarCatalog.birthdayColors(look.gender) + listOf("#FFFFFF", "#FFD86B"), 2.8)
  }
}

/** The centre of a profile's top (UserProfile.tsx): the pattern around the photo, the decorated avatar (116, moving),
 *  the name (platinum with Platina) with the emoji status, the presence and «🎉 Сегодня день рождения». Scrolled up,
 *  the photo shrinks towards the top and darkens away; pulled down, it grows. */
class ProfileHeroView(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  val pattern = ProfilePatternView(context)
  val avatarHolder = FrameLayout(context)
  val avatar = DecoratedAvatarView(context)
  private val dim = View(context)
  val name = PlatinaNameView(context)
  val status = StatusEmojiView(context)
  val presence = TextView(context)
  private val party = context.words("🎉 Сегодня день рождения", 13f, Theme.text, 700)
  private val nameRow = LinearLayout(context)
  private val column = LinearLayout(context)
  /** The emoji status was tapped (the own profile opens the picker); the y of the tap on the screen. */
  var onStatus: ((Int) -> Unit)? = null
  private var tinted = false

  init {
    clipChildren = false
    addView(pattern)
    column.orientation = LinearLayout.VERTICAL
    column.gravity = Gravity.CENTER_HORIZONTAL
    column.clipChildren = false
    addView(column)
    avatarHolder.clipChildren = false
    avatarHolder.setPadding(dp(6f), dp(6f), dp(6f), dp(6f))
    avatarHolder.clipToPadding = false
    avatarHolder.addView(avatar, FrameLayout.LayoutParams(dp(116f), dp(116f)))
    dim.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF000000.toInt()) }
    dim.alpha = 0f
    avatarHolder.addView(dim, FrameLayout.LayoutParams(dp(116f), dp(116f)))
    column.addView(avatarHolder, LinearLayout.LayoutParams(dp(128f), dp(128f)))
    name.textSize = 27f
    name.typeface = Theme.weight(800)
    name.maxLines = 2
    name.gravity = Gravity.CENTER
    name.letterSpacing = -0.01f
    nameRow.orientation = LinearLayout.HORIZONTAL
    nameRow.gravity = Gravity.CENTER
    nameRow.addView(name, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { weight = 0f })
    nameRow.addView(status, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(7f) })
    status.isClickable = true
    status.setOnClickListener {
      val place = IntArray(2); it.getLocationOnScreen(place)
      onStatus?.invoke(place[1] + it.height)
    }
    column.addView(nameRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) })
    presence.textSize = 15f
    presence.gravity = Gravity.CENTER
    column.addView(presence, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
    party.setPadding(dp(12f), dp(5f), dp(12f), dp(5f))
    column.addView(party, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
  }

  private fun dp(value: Float) = Math.round(value * d)

  fun show(person: Person, base: String, presenceWords: String?, tinted: Boolean) {
    this.tinted = tinted
    avatar.ringBackground = Theme.bg
    avatar.show(person, person.look, base, animated = true)
    name.onDark = tinted
    name.plainColor = if (tinted) 0xFFFFFFFF.toInt() else Theme.text
    name.show(person.displayName, person.look.platina)
    status.show(person.look, 22f, animated = true)
    pattern.show(person.look.profilePattern)
    setPresence(presenceWords)
    party.visibility = if (person.look.birthdayToday()) VISIBLE else GONE
    party.setTextColor(if (tinted) 0xFFFFFFFF.toInt() else Theme.text)
    party.background = context.plate(if (tinted) 0x38FFFFFF else com.linea.messenger.settings.ThemeStore.look.accentSoft, 14f)
    requestLayout()
  }

  fun setPresence(words: String?) {
    presence.text = words ?: ""
    presence.visibility = if (words == null) GONE else VISIBLE
    presence.setTextColor(if (tinted) 0xC7FFFFFF.toInt() else if (words == "в сети") Theme.accent else Theme.muted)
  }

  /** Scroll `y` (px) from the rest position: up shrinks and darkens the photo, a pull grows it. */
  fun applyScroll(yPx: Int) {
    val y = yPx / d
    fun range(value: Float, a: Float, b: Float, c: Float, outA: Float, outB: Float, outC: Float): Float = when {
      value <= a -> outA
      value >= c -> outC
      value < b -> outA + (outB - outA) * (value - a) / (b - a)
      else -> outB + (outC - outB) * (value - b) / (c - b)
    }
    val shift = range(y, -160f, 0f, 150f, -40f, 0f, -70f)
    val scale = range(y, -160f, 0f, 150f, 1.6f, 1f, 0.22f)
    avatarHolder.translationY = shift * d
    avatarHolder.scaleX = scale; avatarHolder.scaleY = scale
    avatarHolder.alpha = 1 - ((y - 60) / 90).coerceIn(0f, 1f)
    dim.alpha = ((y - 20) / 110 * 0.85f).coerceIn(0f, 0.85f)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    nameRow.getChildAt(0).layoutParams.width = LinearLayout.LayoutParams.WRAP_CONTENT
    name.maxWidth = maxOf(0, width - dp(32f) - (if (status.visibility == VISIBLE) dp(40f) else 0))
    column.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    setMeasuredDimension(width, column.measuredHeight)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    column.layout(0, 0, width, column.measuredHeight)
    val top = -dp(90f)
    val tall = dp(90f) + maxOf(dp(220f), b - t)
    pattern.measure(MeasureSpec.makeMeasureSpec(width + dp(36f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(tall, MeasureSpec.EXACTLY))
    pattern.layout(-dp(18f), top, width + dp(18f), top + tall)
    pattern.center(avatarHolder.left + avatarHolder.width / 2f + dp(18f), avatarHolder.top + avatarHolder.height / 2f + dp(90f))
  }
}

/** The «имя пользователя / день рождения / о себе» card of profiles (ProfileInfo.tsx): the same on one's own and on
 *  other people's. The username row copies on tap and reads «Скопировано» for a moment. */
class ProfileInfoCard(context: Context) : LinearLayout(context) {
  var onCopy: (() -> Unit)? = null

  init {
    orientation = VERTICAL
    background = context.plate(if (Theme.dark) Theme.surface2 else 0xFFFFFFFF.toInt(), 22f)
    clipToOutline = true
  }

  fun show(username: String, birthday: String, bio: String, copied: Boolean, extra: View? = null) {
    removeAllViews()
    val first = row("имя пользователя", if (copied) "Скопировано" else "@$username", accent = true)
    first.isClickable = true
    if (android.os.Build.VERSION.SDK_INT >= 26) first.tooltipText = "Нажми, чтобы скопировать"
    first.setOnClickListener { onCopy?.invoke() }
    addView(first)
    val day = BirthdayWords.format(birthday)
    if (day.isNotEmpty()) { addView(line()); addView(row("день рождения", day, accent = false)) }
    if (bio.isNotEmpty()) { addView(line()); addView(row("о себе", bio, accent = false)) }
    if (extra != null) {
      addView(line())
      (extra.parent as? ViewGroup)?.removeView(extra)
      addView(FrameLayout(context).apply { setPadding(context.px(16f), context.px(11f), context.px(16f), context.px(11f)); addView(extra) })
    }
  }

  private fun line(): View = View(context).apply {
    setBackgroundColor(Theme.veil(0.1f))
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, maxOf(1, context.px(0.5f))).apply { leftMargin = context.px(16f); rightMargin = context.px(16f) }
  }

  private fun row(label: String, value: String, accent: Boolean): LinearLayout = LinearLayout(context).apply {
    orientation = VERTICAL
    setPadding(context.px(16f), context.px(11f), context.px(16f), context.px(11f))
    addView(context.words(label, 14f, Theme.muted))
    addView(context.words(value, 17f, if (accent) Theme.accent else Theme.text).apply { ellipsize = TextUtils.TruncateAt.END }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(2f) })
    contentDescription = "$label: $value"
  }
}

/** The avatar address a person's picture is asked from on `base` (used by the light and the viewer). */
fun profileAvatarAddress(base: String, person: Person): String = AvatarMedia.address(base, person.avatarId)
