package com.linea.messenger.design

import android.graphics.Typeface
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.chats.ChatPalette
import com.linea.messenger.settings.ThemeStore
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The app's colours: those of the theme that is on. «Чёрная», the app's own look, unless the person chose
 *  another in Настройки → Оформление (settings/ThemeStore.kt keeps the choice and makes the colours).
 *  Colours are 0xAARRGGBB. */
object Theme {
  val bg: Int get() = ThemeStore.look.bg
  val text: Int get() = ThemeStore.look.text
  val muted: Int get() = ThemeStore.look.muted
  val subtle: Int get() = ThemeStore.look.subtle
  val accent: Int get() = ThemeStore.look.accent
  val onAccent: Int get() = ThemeStore.look.onAccent
  val surface2: Int get() = ThemeStore.look.surface2
  val danger: Int get() = ThemeStore.look.danger
  /** Settings: a dark theme or a light one, and a thin veil over the page (white on dark, black on light). */
  val dark: Boolean get() = ThemeStore.look.dark
  fun veil(alpha: Float): Int = ThemeStore.look.veil(alpha)

  // Colours that the screens once fixed for the black look, made to follow the theme that is on
  // (native/ios/Sources/Design/ThemeFollow.swift). On «Чёрная» each gives back the very colour the screen always
  // had, so the app's own look does not change by a pixel; every other theme takes its own colours.
  /** «Чёрная», the app's own look, is on. */
  val black: Boolean get() = ThemeStore.look.black
  /** On «Чёрная» the fixed colour; on any other theme the given one. */
  fun onBlack(fixed: Int, otherwise: Int): Int = if (black) fixed else otherwise
  /** An opaque page of its own (a sheet, a screen opened on top): `fixed` on «Чёрная», the theme's page elsewhere. */
  fun page(fixed: Int): Int = onBlack(fixed, bg)
  /** A card, a field or a bubble raised over the page: `fixed` on «Чёрная», the theme's card colour elsewhere. */
  fun raised(fixed: Int): Int = onBlack(fixed, ThemeStore.look.incoming)
  /** An opaque panel floating over the page (a menu, a toast, a bar): `fixed` on «Чёрная»; elsewhere the theme's
   *  card colour laid over its page, so nothing shows through. */
  fun panel(fixed: Int): Int = onBlack(fixed, solid(ThemeStore.look.incoming, bg))
  /** One colour laid over another, as a single opaque colour. */
  fun solid(top: Int, bottom: Int): Int {
    val a = (top ushr 24) / 255f; val keep = 1 - a
    fun mix(shift: Int): Int = (((top shr shift) and 255) * a + ((bottom shr shift) and 255) * keep).roundToInt().coerceIn(0, 255) shl shift
    return 0xFF000000.toInt() or mix(16) or mix(8) or mix(0)
  }

  /** The colours the chat list draws with. */
  val chatList: ChatPalette get() = ChatPalette(
    text = text, muted = muted, subtle = subtle, accent = accent, onAccent = onAccent, border = 0,
    // ChatListScreen.tsx nativePalette: pressed 0.07 white / 0.05 black, selected accentSoft, pinned 0.055 / 0.045.
    pressed = veil(if (dark) 0.07f else 0.05f), selected = ThemeStore.look.accentSoft, badgeMuted = surface2, bg = bg,
    pinned = veil(if (dark) 0.055f else 0.045f), danger = danger,
  )

  /** The colours a chat's messages draw with. */
  val messages: MsgPalette get() = MsgPalette(
    text = text, muted = muted, accent = accent, onAccent = onAccent, mine = ThemeStore.look.bubble, theirs = ThemeStore.look.incoming,
    notice = veil(0.06f), noticeText = text, danger = danger, quote = veil(0.08f), mineMeta = muted, mineMark = text, subtle = subtle,
  )

  /** A colour with another alpha (0…1). */
  fun alpha(color: Int, alpha: Float): Int = (color and 0x00FFFFFF) or ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24)

  /** Fonts: Montserrat at a weight (400 regular, 500 medium, 600 semibold, 700 bold, 800 extrabold), as the
   *  reference's fontWeight picks it (design/Fonts.kt); the system's font while the faces are not loaded. */
  fun weight(weight: Int): Typeface = Fonts.weight(weight)

  // Fonts: the reference's type (mobile/src/typography.tsx, native/ios/Sources/Design/Theme.swift). Titles and the
  // big names of profiles are Unbounded ExtraBold with −0.2 letter spacing: `Theme.title` for the face,
  // `view.titled(size)` (design/Fonts.kt) for a TextView with the spacing. `TypeSize` lists the reference's sizes.
  /** Unbounded ExtraBold: the reference's TITLE_FONT (screen titles, profile names, sheet headings, empty states). */
  val title: Typeface get() = Fonts.title
  /** The reference's TITLE letter spacing, pt (the face is wide; tighter, the letters touched). */
  const val titleKern = -0.2f

  /** The sizes (and line heights) the reference uses, by where they appear (sp). */
  object TypeSize {
    /** «Чаты» / «Архив» over the chat list: Unbounded 30, line 36. */
    const val chatsTitle = 30f; const val chatsTitleLine = 36f
    /** «Каналы», «Музыка», «Люди»: Unbounded 26, line 32. */
    const val sectionTitle = 26f; const val sectionTitleLine = 32f
    /** A profile's name (own, someone's, the settings head): Unbounded 27, line 33. */
    const val profileName = 27f; const val profileNameLine = 33f
    /** The sign-in screen's «Инвиз»: Unbounded 25, line 31. */
    const val authTitle = 25f; const val authTitleLine = 31f
    /** A settings page's heading: Unbounded 22 (19 over 12 letters, 17 over 16), line 28. */
    const val pageTitle = 22f; const val pageTitleLine = 28f
    /** An empty state's heading: Unbounded 21, line 27; its words Montserrat 15, line 23. */
    const val emptyTitle = 21f; const val emptyTitleLine = 27f
    /** A room's name: Unbounded 20, line 26. */
    const val roomTitle = 20f; const val roomTitleLine = 26f
    /** A sheet's heading: Unbounded 19, line 25. */
    const val sheetTitle = 19f; const val sheetTitleLine = 25f
    /** Montserrat body sizes: a row's label 15, a list name 16, a message 17, small words 13, a caption 12, a tag 11. */
    const val row = 15f; const val name = 16f; const val message = 17f; const val small = 13f; const val caption = 12f; const val tag = 11f

    /** A settings page heading's size for its length, as the reference shrinks it. */
    fun pageTitleSize(text: String): Float = if (text.length > 16) 17f else if (text.length > 12) 19f else 22f
  }
}

/** The bar at the bottom: its size and place, dp. */
object BarMetrics {
  const val height = 62f
  const val width = 176f

  /** From the bar's lower edge to the screen's: the reference on Android (chatLayout.ts `tabBarMarginBottom`, the bar
   *  inside the safe area) — 10 above the navigation bar, so the bar never touches the gesture handle nor covers the
   *  buttons. (The iPhone tucks it into the home indicator's area: max(inset − 8, 12).) */
  fun bottomGap(safeBottom: Float): Float = max(safeBottom, 0f) + 10f
}

/** A person's colour as a lit ball: the lighter corner and the deeper one (0xAARRGGBB each). */
fun orbPair(rgb: Int): Pair<Int, Int> {
  val r = ((rgb shr 16) and 255) / 255.0; val g = ((rgb shr 8) and 255) / 255.0; val b = (rgb and 255) / 255.0
  val top = max(r, max(g, b)); val low = min(r, min(g, b)); val l = (top + low) / 2; val d = top - low
  val sat = if (d == 0.0) 0.0 else d / (1 - abs(2 * l - 1))
  val hue = if (d == 0.0) 0.0 else if (top == r) ((g - b) / d + 6) % 6 * 60 else if (top == g) ((b - r) / d + 2) * 60 else ((r - g) / d + 4) * 60
  fun hsl(h: Double, s: Double, light: Double): Int {
    val a = s * min(light, 1 - light)
    val turn = (h % 360 + 360) % 360 / 30
    fun part(n: Double): Int {
      val k = (n + turn) % 12
      return (255 * (light - a * max(-1.0, min(min(k - 3, 9 - k), 1.0)))).roundToInt()
    }
    return 0xFF000000.toInt() or (part(0.0) shl 16) or (part(8.0) shl 8) or part(4.0)
  }
  val s = min(1.0, sat * 1.15 + 0.08)
  return Pair(hsl(hue + 38, s, min(0.72, l + 0.16)), hsl(hue - 34, s, max(0.22, l - 0.14)))
}
