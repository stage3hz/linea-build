package com.linea.messenger.profile

import android.content.Context
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.DecoratedAvatarView
import com.linea.messenger.avatars.PlatinaButton
import com.linea.messenger.avatars.PlatinaNameView
import com.linea.messenger.avatars.PlatinaSealView
import com.linea.messenger.avatars.StatusEmojiView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.titled
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.platina.PlatinaShowcase

/** The head of Settings (the reference's SettingsScreen.tsx `Root`; iOS Profile/SettingsProfileHead.swift): the banner
 *  runs under the status bar (or the person's light when there is none) and stretches when the list is pulled down;
 *  the profile effect plays over it; «Изменить» at the top right opens the editor; under it the decorated avatar (100,
 *  moving), the name — platinum with Platina — with the emoji status (a tap opens the picker on the profile),
 *  @username with the seal (a tap opens the showcase). Without Platina the offer card follows.
 *
 *  Settings keeps one chrome and asks it for the head on every rebuild; the banner, the effect and the button live on
 *  the page itself (behind / above the list), attached once. */
class SettingsProfileChrome(private val context: Context) {
  private val backdrop = FrameLayout(context)
  private val banner = ProfileBannerView(context)
  private val light = ProfileLightView(context)
  private val effect = ProfileEffectView(context)
  private val edit = context.words("Изм.", 16f, Theme.text, 600)
  private var page: ViewGroup? = null
  private var scroll: ScrollView? = null
  private var messenger: Messenger? = null
  /** «Мой профиль», the editor, the status picker on the profile. */
  var onProfile: (() -> Unit)? = null
  var onEdit: (() -> Unit)? = null
  var onStatus: (() -> Unit)? = null
  private var pulled = 0

  /** Puts the banner, the effect and «Изменить» on the page once. */
  fun attach(page: ViewGroup, scroll: ScrollView, messenger: Messenger?) {
    this.messenger = messenger
    if (this.page != null) return
    this.page = page
    this.scroll = scroll
    backdrop.clipChildren = false
    backdrop.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    backdrop.addView(light)
    backdrop.addView(banner)
    // Just above the settings page's own background (its glass source, index 0), under the list.
    page.addView(backdrop, if (page is com.linea.messenger.settings.SettingsPage) 1 else 0)
    page.addView(effect)
    edit.gravity = Gravity.CENTER
    // D: «Изменить» on glass (the reference's `GlassSurface radius={22} interactive`), springing under the finger.
    com.linea.messenger.design.GlassBacking.put(edit, 0.94f, 22f * context.resources.displayMetrics.density, clear = false)
    edit.setPadding(context.px(16f), 0, context.px(16f), 0)
    edit.isClickable = true
    edit.setOnClickListener { onEdit?.invoke() }
    page.addView(edit)
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> follow() }
    page.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> follow() }
    scroll.setOnTouchListener { _, event ->
      // The pull at the top stretches the banner.
      when (event.actionMasked) {
        android.view.MotionEvent.ACTION_DOWN -> pullStart = if (scroll.scrollY == 0) event.rawY else -1f
        android.view.MotionEvent.ACTION_MOVE -> if (pullStart >= 0 && scroll.scrollY == 0) { pulled = maxOf(0, ((event.rawY - pullStart) * 0.5f).toInt()); follow() }
        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { pulled = 0; pullStart = -1f; follow() }
      }
      false
    }
  }

  private var pullStart = -1f

  /** The head for the column (built anew with the page). */
  fun head(raw: Map<String, Any?>): View {
    val person = Person.from(raw) ?: Person(raw["id"] as? String ?: "", raw["username"] as? String ?: "", raw["displayName"] as? String ?: "", "", "", com.linea.messenger.app.Messenger.color(raw["avatarColor"] as? String), raw["avatarId"] as? String ?: "", com.linea.messenger.avatars.PersonLook.from(raw))
    val base = messenger?.server?.endpoint ?: ""
    banner.show(person.look, base)
    light.visibility = if (person.look.hasBanner) View.GONE else View.VISIBLE
    light.color = person.avatarColor
    effect.show(person.look.profileEffect)
    follow()

    val head = LinearLayout(context)
    head.orientation = LinearLayout.VERTICAL
    head.clipChildren = false
    val ring = FrameLayout(context)
    ring.clipChildren = false
    ring.contentDescription = "Мой профиль"
    ring.isClickable = true
    ring.setOnClickListener { onProfile?.invoke() }
    val avatar = DecoratedAvatarView(context)
    avatar.show(person, person.look, base, animated = true)
    ring.addView(avatar, FrameLayout.LayoutParams(context.px(100f), context.px(100f), Gravity.CENTER))
    // Where the banner ends in the column: 200 under the status bar, the column starting 57 under it.
    head.addView(ring, LinearLayout.LayoutParams(context.px(110f), context.px(110f)).apply { topMargin = context.px(200f - 57f - 8f - 58f); leftMargin = context.px(4f) }) // the avatar 25 from the screen, as the reference
    val nameRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    val name = PlatinaNameView(context)
    name.titled(Theme.TypeSize.profileName)
    name.maxLines = 2
    name.show(person.displayName, person.look.platina)
    nameRow.addView(name, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { weight = 0f; width = LinearLayout.LayoutParams.WRAP_CONTENT })
    val status = StatusEmojiView(context)
    status.show(person.look, 22f, animated = true)
    status.isClickable = true
    status.contentDescription = "Сменить статус рядом с именем"
    status.setOnClickListener { onStatus?.invoke() }
    nameRow.addView(status, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(8f) })
    head.addView(nameRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(12f); leftMargin = context.px(4f); rightMargin = context.px(4f) })
    val handleRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    handleRow.addView(context.words(if (person.username.isEmpty()) "" else "@" + person.username, 15f, Theme.muted))
    if (person.look.platina) {
      val seal = PlatinaSealView(context)
      handleRow.addView(seal, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(8f) })
    }
    head.addView(handleRow, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(5f); leftMargin = context.px(4f); bottomMargin = context.px(4f) })
    return head
  }

  /** «Твой профиль — заметнее любого другого» (SettingsScreen.tsx `PlatinaOffer`), for Settings without Platina. */
  fun offer(): View {
    val card = LinearLayout(context)
    card.orientation = LinearLayout.VERTICAL
    // D: on glass, as the reference's `GlassSurface radius={22}` (so «Ледяное стекло» frosts its rim).
    card.background = com.linea.messenger.design.GlassDrawable(card, 22f * context.resources.displayMetrics.density, clear = false)
    card.setPadding(context.px(16f), context.px(16f), context.px(16f), context.px(16f))
    val brand = PlatinaNameView(context)
    brand.textSize = 11f
    brand.typeface = Theme.weight(800)
    brand.letterSpacing = 0.22f
    brand.show("ИНВИЗ PLATINA", platina = true)
    card.addView(brand)
    // The reference: the title letter spacing −0.3, line 23; the words line 19.
    card.addView(context.words("Твой профиль —\nзаметнее любого другого", 18f, Theme.text, 800).apply {
      letterSpacing = -0.3f / 18f; if (android.os.Build.VERSION.SDK_INT >= 28) lineHeight = context.px(23f)
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })
    card.addView(context.words("Живой баннер и аватар, платиновое имя, рамки, невидимка и всё, что выйдет дальше.", 13f, Theme.muted).apply {
      if (android.os.Build.VERSION.SDK_INT >= 28) lineHeight = context.px(19f)
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    val button = PlatinaButton(context, "Попробовать Platina", 15f, 15f)
    button.setOnClickListener {
      button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      PlatinaShowcase.open(button)
    }
    card.addView(button, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.px(46f)).apply { topMargin = context.px(14f) })
    return card
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(maxOf(0, width), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(maxOf(0, height), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + maxOf(0, height))
  }

  /** The banner stays at the top of the screen and grows by the pull (scaled about its centre). */
  private fun follow() {
    val page = page ?: return
    val scroll = scroll ?: return
    val width = page.width
    if (width <= 0) return
    val top = page.rootWindowInsets?.systemWindowInsetTop ?: context.px(24f)
    val height = context.px(200f) + top
    val offset = scroll.scrollY
    put(backdrop, 0, -offset, width, height)
    put(banner, 0, 0, width, height)
    put(light, 0, 0, width, height + context.px(180f))
    val scale = 1 + pulled.toFloat() / maxOf(1, height)
    backdrop.pivotX = width / 2f; backdrop.pivotY = 0f
    backdrop.scaleX = scale; backdrop.scaleY = scale
    put(effect, 0, -offset, width, height + context.px(140f))
    edit.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(context.px(44f), View.MeasureSpec.EXACTLY))
    put(edit, width - context.px(16f) - edit.measuredWidth, top + context.px(6f), edit.measuredWidth, context.px(44f))
  }
}
