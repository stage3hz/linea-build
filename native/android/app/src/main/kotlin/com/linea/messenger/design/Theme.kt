package com.linea.messenger.design

import android.graphics.Typeface
import android.os.Build
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.chats.ChatPalette
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The black theme: the app's own look. Colours are 0xAARRGGBB. */
object Theme {
  const val bg = 0xFF08090A.toInt()
  const val text = 0xFFE5E5E6.toInt()
  const val muted = 0xFF8A8F98.toInt()
  const val subtle = 0xFF62666D.toInt()
  const val accent = 0xFFE5E5E6.toInt()
  const val onAccent = 0xFF08090A.toInt()
  const val surface2 = 0xEB161718.toInt()
  const val danger = 0xFFFF9CB0.toInt()

  /** The colours the chat list draws with. */
  val chatList = ChatPalette(
    text = text, muted = muted, subtle = subtle, accent = accent, onAccent = onAccent, border = 0,
    pressed = 0x12FFFFFF, selected = 0x12FFFFFF, badgeMuted = surface2, bg = bg, pinned = 0x0EFFFFFF, danger = danger,
  )

  /** The colours a chat's messages draw with. */
  val messages = MsgPalette(
    text = text, muted = muted, accent = accent, onAccent = onAccent, mine = 0xF51F2023.toInt(), theirs = 0xF5161718.toInt(),
    notice = 0x8C0C1222.toInt(), noticeText = text, danger = danger, quote = 0x14FFFFFF, mineMeta = muted, mineMark = text, subtle = subtle,
  )

  /** A colour with another alpha (0…1). */
  fun alpha(color: Int, alpha: Float): Int = (color and 0x00FFFFFF) or ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24)

  /** The system's font at a weight (400 regular, 500 medium, 600 semibold, 700 bold). Before Android 9 there are
   *  only regular and bold. */
  fun weight(weight: Int): Typeface =
    if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight, false)
    else Typeface.create(Typeface.DEFAULT, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
}

/** The bar at the bottom: its size and place, dp. */
object BarMetrics {
  const val height = 62f
  const val width = 176f

  /** From the bar's lower edge to the screen's. */
  fun bottomGap(safeBottom: Float): Float = max(safeBottom - 8f, 12f)
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
