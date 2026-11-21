package com.linea.messenger.effects

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Shader
import com.linea.messenger.avatars.LiveCanvasView
import com.linea.messenger.design.Theme
import com.linea.messenger.settings.ThemeStore
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt

/** The music «эмбиент» (mobile/src/music/MusicAmbient.tsx; iOS Effects/MusicAmbient.swift): soft light patches that
 *  drift slowly while each patch's colour flows blue → emerald → ice white, no pulsing. Behind the top of «Музыка»,
 *  the full player and the equalizer. It stands still while animations are off (effects/Motion.kt) or when asked to.
 *  `fade`: the lower part fades out to transparency (the top of «Музыка», which runs into the list below). */
class MusicAmbientView(context: Context, tone: String = "dark", private val custom: Palette? = null, private var still: Boolean = false, private val fade: Boolean = false) : LiveCanvasView(context) {
  /** The reference's palettes: a base colour, five lights, which of them is the ice accent and which the emerald. */
  class Palette(val base: Int, val colors: IntArray, val accent: Int = 4, val green: Int = 1)

  companion object {
    val palettes = mapOf(
      "dark" to Palette(0x0A1529, intArrayOf(0x0D3480, 0x0B6450, 0x123E92, 0x0A2F6E, 0xB8D8F5)),
      "black" to Palette(0x000000, intArrayOf(0x0A2766, 0x08483A, 0x0E2F72, 0x071F4F, 0x8FB3D9)),
      "light" to Palette(0xE7EFFC, intArrayOf(0x9DBDF2, 0xA9E0CF, 0xB5CDF5, 0x8FB0EA, 0xFFFFFF)),
      // Platina profile banners.
      "deep" to Palette(0x050B1C, intArrayOf(0x0D3480, 0x0A2F6E, 0x143F9E, 0x08245A, 0x8FB3D9)),
      "glacier" to Palette(0x0B1B2E, intArrayOf(0x4C8FD6, 0x7FC8E8, 0x2F6DB5, 0x9FD6F2, 0xFFFFFF)),
      "aurora" to Palette(0x04131C, intArrayOf(0x0B6450, 0x1AA889, 0x0D3480, 0x2EE6C8, 0xCFF7EE)),
      "ocean" to Palette(0x031424, intArrayOf(0x0A4E8A, 0x0C7A9E, 0x063A6B, 0x1593B8, 0xB8E4F5)),
      "mint" to Palette(0x061A16, intArrayOf(0x118A6A, 0x4FD1A5, 0x0B5C4A, 0x7BE8C3, 0xE6FFF6)),
      "night" to Palette(0x000000, intArrayOf(0x0A1A40, 0x101F4D, 0x06122E, 0x1A2C66, 0x5D7BB8)),
    )

    /** Seconds per colour. */
    private const val STEP = 6.0

    /** The tone the app's theme asks for: «black», «dark» or «light». */
    val themeTone: String get() = if (Theme.dark) (if (ThemeStore.look.black) "black" else "dark") else "light"

    /** Ambient colours from a theme (`themeAmbient`): its page colour as the base, its accent and two blends as the
     *  light. Null unless both are `#RRGGBB`. For Графит and the palettes, so the music screen is not navy there. */
    fun themePalette(bg: String?, accent: String?): Palette? {
      val base = hex(bg) ?: return null; val light = hex(accent) ?: return null
      fun mix(a: Int, b: Int, k: Double): Int {
        var out = 0
        for (shift in intArrayOf(16, 8, 0)) {
          val x = ((a shr shift) and 255).toDouble(); val y = ((b shr shift) and 255).toDouble()
          out = out or ((x * (1 - k) + y * k).roundToInt().coerceIn(0, 255) shl shift)
        }
        return out
      }
      return Palette(base, intArrayOf(mix(base, light, 0.55), mix(base, light, 0.35), mix(base, light, 0.7), mix(base, light, 0.45), mix(light, 0xFFFFFF, 0.5)))
    }

    /** `#RRGGBB` → 0xRRGGBB. */
    fun hex(text: String?): Int? {
      if (text == null || text.length != 7 || !text.startsWith("#")) return null
      return text.drop(1).toIntOrNull(16)
    }

    /** The custom palette the reference uses for the music screens: dark, not black, and not the old navy page. */
    val themeCustom: Palette?
      get() {
        val colors = BackdropColors.current
        if (!colors.dark || colors.black || colors.bgHex?.uppercase() == "#080F1E") return null
        return themePalette(colors.bgHex, colors.accentHex)
      }

    /** The opacity of colour layer `index` at a point of the cycle: full on its slot, gone a whole slot away
     *  (smoothstep of the circular distance). */
    fun layerOpacity(phase: Double, index: Int, count: Int): Double {
      val n = count.toDouble()
      var d = abs((((phase - index) % n) + n) % n)
      d = minOf(d, n - d)
      val k = maxOf(0.0, 1 - d)
      return k * k * (3 - 2 * k)
    }

    /** The view the music screens put behind their top: the theme's own colours on Графит and the palettes. */
    fun forTheme(context: Context, fade: Boolean = false): MusicAmbientView = MusicAmbientView(context, themeTone, themeCustom, fade = fade)
  }

  private var tone = if (palettes.containsKey(tone)) tone else "dark"
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val fadePaint = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) }
  private val motionChanged: (Unit) -> Unit = { live = moving }

  init { live = moving }

  private val palette: Palette get() = custom ?: palettes[tone] ?: palettes.getValue("dark")
  private val moving: Boolean get() = !still && Motion.enabled

  /** Another palette or stillness on the same view (an unknown preset is «deep»). */
  fun show(tone: String, still: Boolean) {
    this.tone = if (palettes.containsKey(tone)) tone else "deep"
    this.still = still
    live = moving
    invalidate()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); Motion.changed.watch(motionChanged); live = moving }
  override fun onDetachedFromWindow() { Motion.changed.unwatch(motionChanged); super.onDetachedFromWindow() }

  override fun paint(canvas: Canvas, width: Float, height: Float) {
    val w = width; val h = height
    if (w <= 0 || h <= 0) return
    val layer = if (fade) canvas.saveLayer(0f, 0f, w, h, null) else -1
    val palette = palette
    canvas.drawColor(0xFF000000.toInt() or palette.base)
    val t = if (live) seconds else 0.0
    val strength = if (tone == "light") 0.75f else 1f
    // x, y, size, offset, drift, strength
    val plan = listOf(
      floatArrayOf(w * 0.25f, h * 0.35f, w * 1.3f, 0f, 50f, 0.55f * strength), floatArrayOf(w * 0.85f, h * 0.55f, w * 1.2f, 1.7f, 45f, 0.45f * strength),
      floatArrayOf(w * 0.5f, h * 0.85f, w * 1.3f, 3.1f, 40f, 0.5f * strength), floatArrayOf(w * 0.55f, h * 0.3f, w * 0.8f, 4.2f, 55f, 0.3f * strength),
    )
    val d = resources.displayMetrics.density
    val count = palette.colors.size
    for (item in plan) {
      val offset = item[3].toDouble(); val drift = item[4] * d; val power = item[5]
      // Drift: 0 → d → −d → d → 0, each leg a sine ease, for ever.
      fun sway(amount: Float, leg: Double): Float {
        if (!live) return 0f
        val k = (t % (leg * 4)) / leg
        val seg = k.toInt().coerceIn(0, 3); val f = k - seg
        val e = (-(cos(Math.PI * f) - 1) / 2).toFloat()
        val points = floatArrayOf(0f, amount, -amount, amount, 0f)
        return points[seg] + (points[seg + 1] - points[seg]) * e
      }
      val x = item[0] + sway(drift, 9 + offset * 0.9); val y = item[1] + sway(-drift * 0.7f, 11 + offset * 0.7)
      val radius = item[2] / 2
      // The phase runs offset → offset + 5 in 30 s, linearly.
      val phase = offset + (if (live) t / STEP else 0.0)
      palette.colors.forEachIndexed { index, hex ->
        val peak = if (index == palette.accent) power * (if (tone == "light") 0.8f else 0.35f) else if (index == palette.green) power * 0.7f else power
        val opacity = peak * layerOpacity(phase, index, count).toFloat()
        if (opacity <= 0.005f) return@forEachIndexed
        val rgb = hex and 0xFFFFFF
        paint.shader = RadialGradient(x, y, radius, intArrayOf(rgb or ((opacity * 255).roundToInt().coerceIn(0, 255) shl 24), rgb), null, Shader.TileMode.CLAMP)
        canvas.drawCircle(x, y, radius, paint)
      }
    }
    paint.shader = null
    if (layer >= 0) {
      // [black, black, clear] at [0, .6, 1]
      fadePaint.shader = LinearGradient(0f, 0f, 0f, h, intArrayOf(0xFF000000.toInt(), 0xFF000000.toInt(), 0), floatArrayOf(0f, 0.6f, 1f), Shader.TileMode.CLAMP)
      canvas.drawRect(0f, 0f, w, h, fadePaint)
      canvas.restoreToCount(layer)
    }
  }
}
