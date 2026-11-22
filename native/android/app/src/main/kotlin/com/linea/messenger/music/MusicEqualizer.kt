package com.linea.messenger.music

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.media.audiofx.Equalizer
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import com.linea.messenger.ai.AIIconButton
import com.linea.messenger.ai.AIKit
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.effects.MusicAmbientView
import com.linea.messenger.net.Live
import com.linea.messenger.profile.pages
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.shell.Screen
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt

// The music equalizer: one setting for the speaker, wired and Bluetooth headphones — «Рекомендованный» (the track as it
// is) or «Пользовательский» with НЧ / СЧ / ВЧ in dB. The settings are the reference's mobile/src/music/equalizer.ts and
// equalizerModel.ts (the same key and JSON); the sound is the reference's own Android module,
// mobile/modules/linea-photo/android/…/MusicEqualizer.kt, carried over: the system Equalizer effect on the player's
// audio session, each of the device's fixed bands getting the gain of the three-band curve at its centre. (iOS
// Music/MusicEqualizer.swift, Music/EqualizerViewController.swift.)

/** The settings, kept on this device. */
object EqualizerSettings {
  val changed = Live.Signal<Unit>()
  const val LIMIT = 12.0
  /** НЧ, СЧ, ВЧ. */
  val bands = listOf(Triple("low", "НЧ", 120.0), Triple("mid", "СЧ", 1000.0), Triple("high", "ВЧ", 8000.0))
  private const val KEY = "linea.equalizer.v1"
  private var app: Context? = null

  data class Profile(val mode: String = "recommended", val low: Double = 0.0, val mid: Double = 0.0, val high: Double = 0.0) {
    fun value(key: String): Double = when (key) { "low" -> low; "mid" -> mid; else -> high }
    fun with(key: String, value: Double): Profile = when (key) { "low" -> copy(low = value); "mid" -> copy(mid = value); else -> copy(high = value) }
  }

  private var kept: Profile? = null

  fun attach(context: Context) { if (app == null) app = context.applicationContext }

  /** A gain as the reference keeps it: a number, within ±12, to half a decibel; anything else is 0. */
  fun gain(value: Any?): Double {
    if (value !is Number || value is Boolean) return 0.0
    val raw = value.toDouble()
    if (!raw.isFinite()) return 0.0
    return Math.round(raw.coerceIn(-LIMIT, LIMIT) * 2) / 2.0
  }

  /** `parseEq`: earlier builds kept separate headphone / speaker profiles — the headphone one is kept. */
  fun parse(raw: String?): Profile {
    if (raw.isNullOrEmpty()) return Profile()
    var item = try { JSONObject(raw) } catch (_: Exception) { return Profile() }
    item.optJSONObject("headphones")?.let { item = it }
    return Profile(if (item.opt("mode") == "custom") "custom" else "recommended", gain(item.opt("low")), gain(item.opt("mid")), gain(item.opt("high")))
  }

  private fun prefs() = app?.getSharedPreferences("linea.music", Context.MODE_PRIVATE)

  var profile: Profile
    get() = kept ?: parse(prefs()?.getString(KEY, null)).also { kept = it }
    set(value) {
      kept = value
      val json = JSONObject().put("mode", value.mode).put("low", value.low).put("mid", value.mid).put("high", value.high)
      prefs()?.edit()?.putString(KEY, json.toString())?.apply()
      MusicEqualizer.apply()
      changed.post(Unit)
    }

  /** `effectiveGains`: the custom gains, or flat (bypass) for «Рекомендованный». */
  fun effective(profile: Profile): DoubleArray? {
    if (profile.mode != "custom") return null
    if (profile.low == 0.0 && profile.mid == 0.0 && profile.high == 0.0) return null
    return doubleArrayOf(profile.low, profile.mid, profile.high)
  }
}

/** The system Equalizer on the player's audio session (music/MusicService.kt, MediaEngine, hands each new session over). */
object MusicEqualizer {
  private var equalizer: Equalizer? = null
  private var sessionId = 0

  fun attach(session: Int) {
    if (session == 0) return
    if (session != sessionId || equalizer == null) {
      try { equalizer?.release() } catch (_: Exception) {}
      equalizer = try { Equalizer(0, session) } catch (_: Exception) { null }
      sessionId = session
    }
    apply()
  }

  fun release() {
    try { equalizer?.release() } catch (_: Exception) {}
    equalizer = null; sessionId = 0
  }

  /** Gain (dB) of the three-band curve at a frequency (the reference's `curve`: low shelf 120 Hz, peak 1 kHz, high shelf 8 kHz). */
  fun curve(gains: DoubleArray, hz: Double): Double {
    val low = 1.0 / (1.0 + (hz / 120.0).pow(2))
    val high = 1.0 / (1.0 + (8000.0 / hz).pow(2))
    val octaves = ln(hz / 1000.0) / ln(2.0)
    val mid = exp(-(octaves * octaves) / (2 * 1.1 * 1.1))
    return gains[0] * low + gains[1] * mid + gains[2] * high
  }

  fun apply() {
    val eq = equalizer ?: return
    val gains = EqualizerSettings.effective(EqualizerSettings.profile)
    try {
      eq.enabled = gains != null
      if (gains == null) return
      val range = eq.bandLevelRange // millibels
      for (band in 0 until eq.numberOfBands.toInt()) {
        val hz = eq.getCenterFreq(band.toShort()) / 1000.0
        val level = (curve(gains, hz) * 100).roundToInt().coerceIn(range[0].toInt(), range[1].toInt())
        eq.setBandLevel(band.toShort(), level.toShort())
      }
    } catch (_: Exception) { /* the effect may be unavailable on this device */ }
  }
}

/** «Эквалайзер» in the layout of the AirPods settings (mobile/src/music/EqualizerScreen.tsx): «Рекомендованный /
 *  Пользовательский», the playing track with ▶ to listen while adjusting, a curve with three points (НЧ, СЧ, ВЧ) dragged
 *  up and down, «Сбросить». On the same living background as the music home screen. */
@SuppressLint("ViewConstructor")
class EqualizerScreen(context: Context, private val player: MusicPlayer) : Screen(context) {
  private val ambient = MusicAmbientView(context, MusicAmbientView.themeTone)
  private val top = LinearLayout(context)
  private val scroll = ScrollView(context)
  private val column = LinearLayout(context)
  private val checks = ArrayList<Pair<String, View>>()
  private val trackCard = LinearLayout(context)
  private val cover = MusicCoverView(context, 14f)
  private val trackTitle = AIKit.label(context, "", 15f, 600, lines = 1)
  private val trackArtist = AIKit.label(context, "", 13f, color = Theme.muted, lines = 1)
  private val playButton = AIIconButton(context, "play", 24f, Theme.text, "Слушать")
  private val curve = EqualizerCurveView(context)
  private val card: Int get() = if (Theme.dark) 0xB8141824.toInt() else 0xC7FFFFFF.toInt()
  private val settingsChanged: (Unit) -> Unit = { refresh() }
  private val playerChanged: () -> Unit = { playerRefresh() }

  init {
    EqualizerSettings.attach(context)
    setBackgroundColor(Theme.bg)
    isClickable = true
    addView(ambient)
    top.orientation = LinearLayout.HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    val back = AIIconButton(context, "ion:chevron-back", 23f, Theme.text, "Назад")
    back.rotation = 90f
    back.setOnClickListener { pages()?.let { if (it.top === this) it.pop() } }
    top.addView(back, LinearLayout.LayoutParams(dp(44f), dp(44f)))
    top.addView(AIKit.label(context, "Эквалайзер", 17f, 600, lines = 1, align = Gravity.CENTER), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    top.addView(View(context), LinearLayout.LayoutParams(dp(44f), dp(44f)))
    addView(top)
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(16f), dp(16f), dp(16f), dp(24f))
    scroll.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    scroll.isVerticalScrollBarEnabled = false
    addView(scroll)

    // «Рекомендованный» / «Пользовательский».
    val modes = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; background = context.plate(card, 22f); clipToOutline = true }
    for ((index, mode) in listOf("recommended", "custom").withIndex()) {
      if (index > 0) modes.addView(View(context).apply { setBackgroundColor(ThemeStore.look.border) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, maxOf(1, dp(0.5f))))
      val words = if (mode == "recommended") "Рекомендованный" else "Пользовательский"
      val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(18f), 0, dp(18f), 0); isClickable = true; contentDescription = words }
      row.addView(AIKit.label(context, words, 17f, lines = 1), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
      val check = com.linea.messenger.design.SymbolView(context, "check", 18f, Theme.accent)
      row.addView(check, LinearLayout.LayoutParams(dp(22f), dp(22f)))
      row.setOnClickListener { EqualizerSettings.profile = EqualizerSettings.profile.copy(mode = mode) }
      modes.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56f)))
      checks.add(mode to check)
    }
    column.addView(modes)
    val help = AIKit.label(context, "«Рекомендованный» — звук трека без изменений. В «Пользовательском» потяни точки НЧ, СЧ и ВЧ вверх или вниз. Настройка одна для динамика, проводных и Bluetooth-наушников.", 13f, color = Theme.muted)
    column.addView(help, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14f); leftMargin = dp(4f); rightMargin = dp(4f) })

    // The track and the curve.
    trackCard.orientation = LinearLayout.VERTICAL
    trackCard.background = context.plate(card, 22f)
    trackCard.setPadding(dp(18f), dp(18f), dp(18f), dp(18f))
    val trackRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    trackRow.addView(cover, LinearLayout.LayoutParams(dp(64f), dp(64f)))
    val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    words.addView(trackTitle); words.addView(trackArtist, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2f) })
    trackRow.addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12f); rightMargin = dp(12f) })
    playButton.background = context.plate(if (Theme.dark) 0x1FFFFFFF else 0x12000000, 26f)
    playButton.setOnClickListener { player.togglePlayback() }
    trackRow.addView(playButton, LinearLayout.LayoutParams(dp(52f), dp(52f)))
    trackCard.addView(trackRow)
    trackCard.addView(View(context).apply { setBackgroundColor(Theme.veil(0.12f)) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, maxOf(1, dp(0.5f))).apply { topMargin = dp(16f) })
    curve.onChange = { key, value -> EqualizerSettings.profile = EqualizerSettings.profile.with(key, value) }
    trackCard.addView(curve, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(EqualizerCurveView.PLOT + EqualizerCurveView.LABELS)).apply { topMargin = dp(16f) })
    column.addView(trackCard, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14f) })

    val reset = AIKit.label(context, "Сбросить", 17f, color = Theme.accent, lines = 1, align = Gravity.CENTER)
    reset.background = context.plate(card, 27f)
    reset.isClickable = true
    reset.setOnClickListener {
      performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      EqualizerSettings.profile = EqualizerSettings.profile.copy(low = 0.0, mid = 0.0, high = 0.0)
    }
    column.addView(reset, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54f)).apply { topMargin = dp(14f) })
    refresh()
    playerRefresh()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); EqualizerSettings.changed.watch(settingsChanged); player.changed.watch(playerChanged); refresh(); playerRefresh() }
  override fun onDetachedFromWindow() { EqualizerSettings.changed.unwatch(settingsChanged); player.changed.unwatch(playerChanged); super.onDetachedFromWindow() }

  override fun place(width: Int, height: Int) {
    put(ambient, 0, 0, width, height)
    put(top, dp(12f), edges.top + dp(6f), width - dp(24f), dp(54f))
    val below = edges.top + dp(60f)
    put(scroll, 0, below, width, height - below)
  }

  private fun playerRefresh() {
    val current = player.current
    cover.bind(current)
    trackTitle.text = current?.title ?: "Включи трек"
    trackArtist.text = current?.artist ?: "чтобы слышать изменения"
    playButton.symbol = if (player.playing) "pause" else "play"
    playButton.contentDescription = if (player.playing) "Пауза" else "Слушать"
    playButton.isEnabled = current != null
    playButton.alpha = if (current != null) 1f else 0.5f
  }

  private fun refresh() {
    val profile = EqualizerSettings.profile
    for ((mode, check) in checks) check.visibility = if (mode == profile.mode) View.VISIBLE else View.INVISIBLE
    trackCard.alpha = if (profile.mode == "custom") 1f else 0.5f
    curve.profile = profile
    curve.disabled = profile.mode != "custom"
  }
}

/** The curve: flat ends, smooth S-shapes through three draggable points, a dotted zero line. A drag that starts near a
 *  point moves the point (never the page). */
class EqualizerCurveView(context: Context) : View(context) {
  companion object {
    const val PLOT = 250f
    const val LABELS = 34f
    private const val PAD = 28f

    /** 3 → «3», 2.5 → «2.5», as the reference prints a number. */
    fun number(value: Double): String = if (value == Math.rint(value)) value.toInt().toString() else value.toString()

    private fun colour(db: Double): Int = if (db > 0.5) 0xFFFFE15A.toInt() else if (db < -0.5) 0xFF5AD8FF.toInt() else 0xFF9BE87A.toInt()
  }

  var profile = EqualizerSettings.Profile()
    set(value) { if (field != value) { field = value; invalidate(); describe() } }
  var disabled = true
  var onChange: ((String, Double) -> Unit)? = null
  private val d = resources.displayMetrics.density
  private var active: Int? = null
  private var startY = 0f
  private var downY = 0f
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val captions = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; textSize = 19 * resources.displayMetrics.density; typeface = Theme.weight(700) }
  private val path = Path()

  init { isFocusable = true; describe() }

  private val xs: FloatArray get() = floatArrayOf(width * 0.17f, width * 0.5f, width * 0.83f)
  private fun yOf(db: Double): Float = PAD * d + ((EqualizerSettings.LIMIT - db) / (2 * EqualizerSettings.LIMIT)).toFloat() * (PLOT * d - 2 * PAD * d)
  private fun dbOf(y: Float): Double {
    val raw = EqualizerSettings.LIMIT - ((y - PAD * d) / (PLOT * d - 2 * PAD * d)) * 2 * EqualizerSettings.LIMIT
    return Math.round(raw.coerceIn(-EqualizerSettings.LIMIT, EqualizerSettings.LIMIT) * 2) / 2.0
  }
  private fun values(): List<Double> = EqualizerSettings.bands.map { profile.value(it.first) }

  private fun describe() {
    contentDescription = EqualizerSettings.bands.mapIndexed { index, band -> band.second + " " + number(values()[index]) + " дБ" }.joinToString(", ")
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (disabled) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val points = xs
        var best = -1; var distance = Float.MAX_VALUE
        for (index in points.indices) { val gap = abs(event.x - points[index]); if (gap <= 60 * d && gap < distance) { distance = gap; best = index } }
        if (best < 0) return false
        active = best
        startY = yOf(values()[best]); downY = event.y
        parent?.requestDisallowInterceptTouchEvent(true)
        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        invalidate()
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val index = active ?: return false
        val value = dbOf(startY + event.y - downY)
        if (value != values()[index]) onChange?.invoke(EqualizerSettings.bands[index].first, value)
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { active = null; parent?.requestDisallowInterceptTouchEvent(false); invalidate(); return true }
    }
    return true
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.className = "android.widget.SeekBar"
  }

  override fun onDraw(canvas: Canvas) {
    val width = width.toFloat(); val height = PLOT * d
    val points = xs
    val list = values()
    val ys = list.map { yOf(it) }
    active?.let { index ->
      // A soft band of focus behind the point being dragged.
      val ink = if (Theme.dark) 0xFFFFFF else 0x000000
      paint.shader = LinearGradient(0f, 0f, 0f, height, intArrayOf(ink, ink or 0x14000000, ink), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
      canvas.drawRect(points[index] - width * 0.165f, 0f, points[index] + width * 0.165f, height, paint)
      paint.shader = null
    }
    line.shader = null
    line.color = (Theme.muted and 0xFFFFFF) or 0x80000000.toInt()
    line.strokeWidth = d
    line.pathEffect = DashPathEffect(floatArrayOf(4 * d, 5 * d), 0f)
    for (x in points) canvas.drawLine(x, 8 * d, x, height - 8 * d, line)
    line.color = Theme.accent
    line.strokeWidth = 3 * d
    line.pathEffect = DashPathEffect(floatArrayOf(0.1f * d, 7 * d), 0f)
    canvas.drawLine(0f, yOf(0.0), width, yOf(0.0), line)
    line.pathEffect = null
    // The curve, coloured from yellow (up) through green to blue (down).
    fun mid(a: Float, b: Float) = (a + b) / 2
    path.reset()
    path.moveTo(0f, ys[0]); path.lineTo(points[0], ys[0])
    path.cubicTo(mid(points[0], points[1]), ys[0], mid(points[0], points[1]), ys[1], points[1], ys[1])
    path.cubicTo(mid(points[1], points[2]), ys[1], mid(points[1], points[2]), ys[2], points[2], ys[2])
    path.lineTo(width, ys[2])
    line.strokeWidth = 5 * d
    line.shader = LinearGradient(0f, 0f, 0f, height, intArrayOf(0xFFFFE15A.toInt(), 0xFF9BE87A.toInt(), 0xFF5AD8FF.toInt()), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
    canvas.drawPath(path, line)
    line.shader = null
    for ((index, x) in points.withIndex()) {
      paint.color = colour(list[index])
      canvas.drawCircle(x, ys[index], (if (active == index) 15 else 13) * d, paint)
    }
    for ((index, x) in points.withIndex()) {
      val on = active == index
      val value = list[index]
      captions.color = if (on) Theme.text else Theme.muted
      val text = if (on) (if (value > 0) "+" else "") + number(value) + " дБ" else EqualizerSettings.bands[index].second
      canvas.drawText(text, x, height + 6 * d + 19 * d, captions)
    }
  }
}

