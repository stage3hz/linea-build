package com.linea.messenger.effects

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View
import com.linea.messenger.core.Core
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.ThemeLook
import com.linea.messenger.settings.ThemeStore

/** The colours of the theme that is on which only the backgrounds draw with: the page's gradient bands and the two
 *  ambient lights (the reference's `Theme.bgGradient`, `ambientBlue`, `ambientLilac`, `plain`). Read from the core's
 *  `settingsTheme` — the very answer settings/ThemeStore.kt makes the look from — once per look. (iOS
 *  Effects/PaletteBackdrop.swift.) */
class BackdropColors {
  var plain = true
  var dark = true
  var black = true
  var bg = 0xFF08090A.toInt()
  var gradient = intArrayOf(0xFF08090A.toInt(), 0xFF08090A.toInt(), 0xFF08090A.toInt())
  var ambientBlue = 0x08FFFFFF
  var ambientLilac = 0x05FFFFFF
  var accent = 0xFFE5E5E6.toInt()
  /** `#RRGGBB` of the page and the accent, when the theme writes them so (MusicAmbient's `themeAmbient`). */
  var bgHex: String? = null
  var accentHex: String? = null

  companion object {
    private var cached: Pair<String, BackdropColors>? = null

    /** The colours of the look that is on now. */
    val current: BackdropColors
      get() {
        val look = ThemeStore.look
        cached?.let { if (it.first == look.source) return it.second }
        val made = BackdropColors()
        made.dark = look.dark; made.black = look.black; made.bg = look.bg; made.accent = look.accent
        val fields = Core.map(Core.view("settingsTheme", listOf(look.id, DevicePreferences.item("accentColor"), null)))
        if (fields != null) {
          made.plain = fields["plain"] as? Boolean ?: false
          val bands = (fields["bgGradient"] as? List<*>).orEmpty().mapNotNull { ThemeLook.color(it as? String) }
          if (bands.size == 3) made.gradient = bands.toIntArray()
          made.ambientBlue = ThemeLook.color(fields["ambientBlue"] as? String) ?: made.ambientBlue
          made.ambientLilac = ThemeLook.color(fields["ambientLilac"] as? String) ?: made.ambientLilac
          made.bgHex = fields["bg"] as? String
          made.accentHex = fields["accent"] as? String
        }
        cached = Pair(look.source, made)
        return made
      }
  }
}

/** The page under every screen (the reference's `GlassBackdrop`, glass.tsx): the built-in themes (Светлая, Тёмная,
 *  Чёрная, Графит) are their plain colour; a palette theme is its gradient bands, a cool light from the upper right,
 *  the accent's light from the lower left and one faint arc. Never takes a touch. Calm by design: the colours are the
 *  theme's own, nothing moves. */
class PaletteBackdropView(context: Context) : View(context) {
  private val bands = Paint()
  private val blue = Paint()
  private val lilac = Paint()
  private val arcFill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val arcRim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private var shownSource = ""
  private var shownSize = 0L

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    isClickable = false
  }

  companion object {
    /** Whether the theme that is on has anything more than its plain colour. */
    val wanted: Boolean get() = !BackdropColors.current.plain
  }

  @Suppress("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent?) = false
  override fun dispatchTouchEvent(event: MotionEvent?) = false

  fun paint() { shownSource = ""; invalidate() }

  private fun prepare(w: Float, h: Float) {
    val colors = BackdropColors.current
    val size = (w.toLong() shl 32) or h.toLong()
    if (shownSource == ThemeStore.look.source && shownSize == size) return
    shownSource = ThemeStore.look.source; shownSize = size
    // start {x:0,y:0} end {x:.8,y:1}
    bands.shader = LinearGradient(0f, 0f, w * 0.8f, h, colors.gradient, null, Shader.TileMode.CLAMP)
    // [ambientBlue, transparent, transparent] at [0, .62, 1], from {x:1,y:0} to {x:0,y:.85}
    blue.shader = LinearGradient(w, 0f, 0f, h * 0.85f, intArrayOf(colors.ambientBlue, colors.ambientBlue and 0xFFFFFF, colors.ambientBlue and 0xFFFFFF), floatArrayOf(0f, 0.62f, 1f), Shader.TileMode.CLAMP)
    // [transparent, ambientLilac] from {x:.2,y:.15} to {x:.9,y:1}
    lilac.shader = LinearGradient(w * 0.2f, h * 0.15f, w * 0.9f, h, colors.ambientLilac and 0xFFFFFF, colors.ambientLilac, Shader.TileMode.CLAMP)
    val rim = if (colors.black) 0x09FFFFFF else if (colors.dark) 0x1291B5FF else 0x94FFFFFF.toInt()
    val fill = if (colors.black) 0x06FFFFFF else if (colors.dark) 0x175982DE else 0x57FFFFFF
    arcRim.color = rim
    arcRim.strokeWidth = resources.displayMetrics.density
    val side = w * 1.08f
    arcFill.shader = LinearGradient(0f, 0f, side * 0.6f, side, fill, fill and 0xFFFFFF, Shader.TileMode.CLAMP)
  }

  override fun onDraw(canvas: Canvas) {
    val colors = BackdropColors.current
    canvas.drawColor(colors.bg)
    if (colors.plain) return
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    prepare(w, h)
    canvas.drawRect(0f, 0f, w, h, bands)
    canvas.drawRect(0f, 0f, w, h, blue)
    canvas.drawRect(0f, 0f, w, h, lilac)
    // top −26 %, right −30 %, width 108 %, a circle, turned −24°.
    val side = w * 1.08f
    val left = w - (-w * 0.30f) - side
    val top = -h * 0.26f
    canvas.save()
    canvas.rotate(-24f, left + side / 2, top + side / 2)
    canvas.translate(left, top)
    canvas.drawCircle(side / 2, side / 2, side / 2, arcFill)
    canvas.drawCircle(side / 2, side / 2, side / 2 - arcRim.strokeWidth / 2, arcRim)
    canvas.restore()
  }
}
