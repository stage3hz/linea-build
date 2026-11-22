package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.NumberPicker
import android.widget.SeekBar
import android.widget.TextView
import android.content.res.ColorStateList
import com.linea.messenger.core.Core
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Symbols
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/** A theme as a small picture of a chat in its own colours, with its name under it. The one that is on has a
 *  mark; a palette the account cannot use yet has a lock.
 *  `page`: the theme's background; `theirs` and `mine`: the two kinds of lines; `dot`: its accent (palettes). */
@SuppressLint("ViewConstructor")
class ThemeCard(context: Context, val label: String, spoken: String, val chosen: Boolean, val locked: Boolean, page: Int, theirs: Int, mine: Int, edge: Int, dot: Int?) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null

  /** The picture: three lines of a chat — theirs, mine, theirs. */
  private class Preview(context: Context, private val page: Int, private val theirs: Int, private val mine: Int, private val edge: Int, private val dot: Int?, private val locked: Boolean) : View(context) {
    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val box = RectF()
    private val clip = Path()
    private val shares = floatArrayOf(0.62f, 0.66f, 0.45f)

    override fun onDraw(canvas: Canvas) {
      val w = width.toFloat(); val h = height.toFloat()
      box.set(0f, 0f, w, h)
      clip.reset(); clip.addRoundRect(box, 12f * d, 12f * d, Path.Direction.CW)
      canvas.save(); canvas.clipPath(clip)
      paint.style = Paint.Style.FILL; paint.color = page
      canvas.drawRect(box, paint)
      shares.forEachIndexed { index, share ->
        val own = index == 1
        val wide = w * share - 12f * d
        val top = (8f + index * 15f) * d
        val left = if (own) w - 8f * d - wide else 8f * d
        paint.color = if (own) mine else theirs
        canvas.drawRoundRect(left, top, left + wide, top + 10f * d, 5f * d, 5f * d, paint)
      }
      if (dot != null) { paint.color = dot; canvas.drawCircle(w - 14f * d, h - 13f * d, 7f * d, paint) }
      if (locked) {
        paint.color = 0x8C000000.toInt()
        canvas.drawCircle(16f * d, h - 16f * d, 10f * d, paint)
        Symbols.draw(canvas, "ion:lock-closed", 16f * d, h - 16f * d, 10f * d, 0xFFE8ECF4.toInt())
      }
      canvas.restore()
      paint.style = Paint.Style.STROKE; paint.strokeWidth = d; paint.color = edge
      box.inset(d / 2, d / 2)
      canvas.drawRoundRect(box, 12f * d, 12f * d, paint)
    }
  }

  init {
    orientation = VERTICAL
    background = GradientDrawable().apply {
      setColor(if (chosen) ThemeStore.look.accentSoft else 0)
      cornerRadius = 18f * resources.displayMetrics.density
      setStroke(context.px(if (chosen) 1.5f else 1f), if (chosen) Theme.accent else Theme.veil(0.12f))
    }
    setPadding(context.px(8f), context.px(8f), context.px(8f), context.px(9f))
    addView(Preview(context, page, theirs, mine, edge, dot, locked), LayoutParams(LayoutParams.MATCH_PARENT, context.px(58f)))

    val name = context.words(label, 12f, if (chosen) Theme.text else Theme.muted, 600)
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    val foot = LinearLayout(context)
    foot.orientation = HORIZONTAL
    foot.gravity = Gravity.CENTER
    foot.addView(name, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    if (chosen) foot.addView(SymbolView(context, "ion:checkmark-circle", 14f, Theme.accent), LayoutParams(context.px(14f), context.px(14f)).apply { leftMargin = context.px(4f) })
    addView(foot, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })

    isClickable = true
    isFocusable = true
    isSelected = chosen
    contentDescription = if (locked) "$spoken, доступна с Platina" else spoken
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    alpha = if (pressed) 0.7f else 1f
  }

  companion object {
    /** The card of a theme by its id, in the theme's own colours (the core's `settingsTheme`). */
    fun of(context: Context, id: String, chosen: Boolean, locked: Boolean): ThemeCard {
      val fields = ThemeStore.plainFields(id)
      val name = ThemeStore.themeName(id)
      val dark = fields["dark"] as? Boolean ?: true
      return ThemeCard(context, name, "Тема $name", chosen, locked,
        page = ThemeLook.color(fields["bg"] as? String) ?: 0xFF000000.toInt(),
        theirs = ThemeLook.color(fields["incoming"] as? String) ?: 0xFF555555.toInt(),
        mine = ThemeLook.color(fields["bubble"] as? String) ?: 0xFF808080.toInt(),
        edge = if (dark) 0x1FFFFFFF else 0x1F000000, dot = ThemeLook.color(fields["accent"] as? String))
    }

    /** Cards side by side that scroll sideways; each `width` dp wide. */
    fun strip(context: Context, cards: List<ThemeCard>, width: Float): HorizontalScrollView {
      val scroll = HorizontalScrollView(context)
      scroll.isHorizontalScrollBarEnabled = false
      val row = LinearLayout(context)
      row.orientation = HORIZONTAL
      cards.forEachIndexed { index, card ->
        row.addView(card, LayoutParams(context.px(width), LayoutParams.WRAP_CONTENT).apply { leftMargin = if (index == 0) 0 else context.px(9f) })
      }
      scroll.addView(row, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
      return scroll
    }
  }
}

/** «Оформление»: the theme, the night theme, the person's own colour of the interface, the size of the text in
 *  chats. (The previous app: `Appearance` of `mobile/src/SettingsScreen.tsx`, `ThemeSettings.tsx`.)
 *
 *  Everything here is kept on this device, as in the previous app. ChatLook adds the wallpapers of chats, the
 *  bubbles, their corners and the colour of one's own messages (chatlook/ChatLookSettings.kt). Not on this page
 *  yet: the app's icon, «Пиксельный след», «Снег», «Ледяное стекло».
 *  `account`: the signed-in account (it says whether the palettes are open); null in the shell that has none. */
@SuppressLint("ViewConstructor")
class AppearanceScreen(context: Context, private val account: SettingsAccount?) : SettingsPage(context, "Оформление") {
  private var lockedHint = false
  private var away = false

  override fun build() {
    fill()
    askPlatina()
  }

  /** Back from «Ночная тема» or «Цвет интерфейса»: what they changed is shown. */
  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    if (isVisible && away && built) fill()
    away = !isVisible
  }

  /** The palettes belong to Platina: the server says whether the account has it. */
  private fun askPlatina() {
    val account = account ?: return
    account.accountCall("usernameStatus", emptyList()) { result ->
      val body = result.getOrNull() ?: return@accountCall
      val active = Core.map(body["platina"])?.get("active") as? Boolean ?: false
      if (active == ThemeStore.platina) return@accountCall
      ThemeStore.platina = active
      // The answer may come while «Ночная тема» or «Цвет интерфейса» is open over this page: it stays open.
      if (isAttachedToWindow && !ThemeStore.refresh(openPages())) fill()
    }
  }

  /** This page and those open over it, by the names the settings reopen them with after the app is redrawn. */
  private fun openPages(): List<String> {
    val pages = arrayListOf("appearance")
    val stack = parent as? ViewGroup ?: return pages
    val at = stack.indexOfChild(this)
    if (at < 0) return pages
    for (index in at + 1 until stack.childCount) {
      when (stack.getChildAt(index)) {
        is NightThemeScreen -> pages.add("night")
        is AccentColorScreen -> pages.add("accent")
        else -> break
      }
    }
    return pages
  }

  /** Puts on what was just chosen. The app is redrawn when the look changed; otherwise only this page is. */
  private fun apply() {
    if (!ThemeStore.refresh(listOf("appearance"))) fill()
  }

  private fun fill() {
    clear()
    val state = ThemeStore.nightState()
    val night = state["night"] as? Boolean ?: false
    val known = state["known"] as? Boolean ?: true
    val auto = state["auto"] as? Boolean ?: false
    val shown = state["shown"] as? String ?: "black"
    val day = state["day"] as? String ?: "black"
    val platina = ThemeStore.platina

    // «Тема»: the four built-in ones, then the palettes.
    val builtIn = LinearLayout(context)
    builtIn.orientation = LinearLayout.HORIZONTAL
    ThemeStore.list("appearances").forEachIndexed { index, item ->
      val id = item["value"] as? String ?: return@forEachIndexed
      val label = item["label"] as? String ?: return@forEachIndexed
      val page = ThemeLook.color(item["color"] as? String) ?: 0xFF000000.toInt()
      val line = ThemeLook.color(item["line"] as? String) ?: 0xFF808080.toInt()
      val card = ThemeCard(context, label, "$label тема", shown == id, false, page, line, line, line, null)
      card.onPress = { choose(id) }
      builtIn.addView(card, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = if (index == 0) 0 else dp(7f) })
    }
    val palettesName = LinearLayout(context)
    palettesName.orientation = LinearLayout.HORIZONTAL
    palettesName.addView(context.words("ПАЛИТРЫ", 11f, Theme.muted, 700).apply {
      letterSpacing = 0.1f
      if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    })
    if (!platina) palettesName.addView(context.words("  · с Platina", 11f, Theme.muted))
    val cards = ThemeStore.list("palettes").mapNotNull { item ->
      val id = item["id"] as? String ?: return@mapNotNull null
      ThemeCard.of(context, id, chosen = platina && shown == id, locked = !platina).also { it.onPress = { pick(id) } }
    }
    val themes = LinearLayout(context)
    themes.orientation = LinearLayout.VERTICAL
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    themes.addView(builtIn, LinearLayout.LayoutParams(wide, wrap))
    themes.addView(palettesName, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    themes.addView(ThemeCard.strip(context, cards, 112f), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    if (lockedHint && !platina) {
      themes.addView(context.words("Палитры входят в Инвиз Platina. Войди в аккаунт с Platina, чтобы их включить.", 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    }
    addGroup("Тема", listOf(SettingsLook.inset(themes, top = 14f, side = 14f, bottom = 14f)))
    if (night && day != ThemeStore.shownWithPlatina(ThemeStore.darkTheme)) {
      add(SettingsLook.foot(context, "Включён ночной режим. Дневная тема «" + ThemeStore.themeName(day) + "» вернётся, когда он выключится."), 8f)
    }

    // «Ночной режим» switches now; «Ночная тема» is when it switches by itself, and to which theme.
    val nightNow = SettingsSwitchRow(context, "Ночной режим", "", night, enabled = known)
    nightNow.onChange = { value ->
      DevicePreferences.set(mapOf("nightForced" to value, "nightForcedAt" to auto))
      apply()
    }
    val kind = state["kind"] as? String ?: "off"
    val kindName = Core.map(ThemeStore.rules["nightLabels"])?.get(kind) as? String ?: ""
    val nightRule = SettingsRow(context, symbol = "ion:moon", label = "Ночная тема", value = kindName)
    nightRule.onPress = { open(NightThemeScreen(context)) }
    addGroup(rows = listOf(nightNow, nightRule))
    // Effects: «Иконка приложения» (settings/AppearanceEffects.kt).
    addIconGroup()

    // «Свои цвета». Only the colour of the interface, as on the iPhone.
    val own = DevicePreferences.word("accentColor")
    val accentRow = SettingsRow(context, label = "Цвет интерфейса", value = if (own == null) "Как в теме" else "Свой", swatch = Theme.accent)
    accentRow.onPress = { open(AccentColorScreen(context)) }
    // ChatLook: «Цвет своих сообщений» — seen in chats with bubbles (chatlook/ChatLookSettings.kt).
    addGroup("Свои цвета", listOf(accentRow, com.linea.messenger.chatlook.ChatLookSettings.colourRow(this)))
    // Effects: «Пиксельный след», «Снег», «Ледяное стекло» (settings/AppearanceEffects.kt).
    addEffectGroups()
    // «Свечение панели»: the bottom bar's lights on or off, and their own colour (settings/BarGlowSettings.kt).
    addBarGlowGroup { fill() }

    // «Размер текста в чатах»: a sample message, then the sizes.
    val chosenSize = DevicePreferences.word("textSize") ?: "medium"
    val sizeRows = ArrayList<View>()
    sizeRows.add(SettingsLook.inset(PaddedSample(context, "Привет! Так будет выглядеть текст сообщений.", ThemeStore.textSize), top = 14f, side = 14f, bottom = 12f))
    for (item in ThemeStore.list("textSizes")) {
      val id = item["id"] as? String ?: continue
      val label = item["label"] as? String ?: continue
      val row = SettingsRow(context, label = label, checked = id == chosenSize)
      row.onPress = {
        if (id != chosenSize) {
          DevicePreferences.set(mapOf("textSize" to id))
          fill()
        }
      }
      sizeRows.add(row)
    }
    addGroup("Размер текста в чатах", sizeRows)
    // ChatLook: «Обои чатов», «Пузыри сообщений», «Углы сообщений» (chatlook/ChatLookSettings.kt).
    com.linea.messenger.chatlook.ChatLookSettings.addGroups(this) { fill() }
    add(SettingsLook.foot(context, "Тема, цвет и размер текста хранятся только на этом устройстве."), 10f)
  }

  /** A tap on a theme card: the tapped theme is what the screen shows next (the core's `settingsThemeTap`). */
  private fun choose(id: String) {
    val state = ThemeStore.nightState()
    val night = state["night"] as? Boolean ?: false
    val known = state["known"] as? Boolean ?: true
    val auto = state["auto"] as? Boolean ?: false
    val plan = Core.map(Core.view("settingsThemeTap", listOf(id, night))) ?: return
    if (plan["nightOff"] == true) {
      // «Светлая» at night turns the night mode off by hand, as the switch would.
      DevicePreferences.set(mapOf("nightForced" to false, "nightForcedAt" to if (known) auto else true))
    }
    (plan["darkTheme"] as? String)?.let { ThemeStore.darkTheme = it }
    (plan["mode"] as? String)?.let { mode ->
      // Before the night settings were touched, «Как в системе» meant following the system: that is kept.
      if (DevicePreferences.word("nightMode") == null) {
        DevicePreferences.set(mapOf("nightMode" to if (ThemeStore.mode == "system") "system" else "off"))
      }
      ThemeStore.mode = mode
    }
    apply()
  }

  private fun pick(palette: String) {
    if (!ThemeStore.platina) {
      lockedHint = true
      fill()
      return
    }
    choose(palette)
  }
}

/** A sample message: words on a rounded plate, `size` sp. */
@SuppressLint("ViewConstructor")
class PaddedSample(context: Context, text: String, size: Float) : FrameLayout(context) {
  init {
    val words = context.words(text, size, Theme.text)
    words.background = context.plate(ThemeStore.look.incoming, 18f)
    words.setPadding(context.px(12f), context.px(9f), context.px(12f), context.px(9f))
    addView(words, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.START))
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  }
}

/** «Ночная тема»: when the night theme turns on by itself (with the system, never, by the clock, by the
 *  screen's brightness) and which theme it is. (The previous app: `NightSettings` of `SettingsScreen.tsx`.) */
class NightThemeScreen(context: Context) : SettingsPage(context, "Ночная тема") {
  override fun build() {
    fill()
  }

  private fun apply() {
    if (!ThemeStore.refresh(listOf("appearance", "night"))) fill()
  }

  private fun fill() {
    clear()
    val state = ThemeStore.nightState()
    val kind = state["kind"] as? String ?: "off"
    val labels = Core.map(ThemeStore.rules["nightLabels"]) ?: emptyMap()
    addGroup(rows = ThemeStore.words("nightModes").map { mode ->
      val row = SettingsRow(context, label = labels[mode] as? String ?: mode, checked = mode == kind)
      row.onPress = {
        DevicePreferences.set(mapOf("nightMode" to mode, "nightForced" to null, "nightForcedAt" to null))
        apply()
      }
      row
    })

    if (kind == "schedule") {
      val from = DevicePreferences.word("nightFrom") ?: "22:00"
      val until = DevicePreferences.word("nightTo") ?: "07:00"
      val start = SettingsRow(context, symbol = "ion:moon", label = "Начало", value = from)
      start.onPress = { askClock("Начало", "nightFrom", from) }
      val end = SettingsRow(context, symbol = "ion:sunny", label = "Конец", value = until)
      end.onPress = { askClock("Конец", "nightTo", until) }
      addGroup("Время использования", listOf(start, end))
    }
    if (kind == "auto") {
      val now = DevicePreferences.number("nightBrightness") ?: 0.25
      val segments = SettingsSegments(context, levels.map { "${(it * 100).roundToInt()}%" }, levels.indexOfLast { abs(it - now) < 0.01 }, spoken = "Порог яркости")
      segments.onPick = { index ->
        DevicePreferences.set(mapOf("nightBrightness" to levels[index]))
        apply()
      }
      val box = LinearLayout(context)
      box.orientation = LinearLayout.VERTICAL
      box.addView(segments, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
      box.addView(context.words("Ночная тема включится, когда яркость экрана опустится до ${(now * 100).roundToInt()}% и ниже.", 12f, Theme.muted),
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) })
      addGroup("Порог яркости", listOf(SettingsLook.inset(box, top = 14f, side = 14f, bottom = 14f)))
    }
    if (kind == "system") {
      add(SettingsLook.foot(context, "Ночная тема включается вместе с тёмным оформлением Android."), 10f)
    }

    // «Выбранная ночная тема»: the dark built-in ones, and the palettes with Platina.
    val ids = ArrayList(ThemeStore.words("nightThemes"))
    if (ThemeStore.platina) ThemeStore.list("palettes").forEach { item -> (item["id"] as? String)?.let { ids.add(it) } }
    val chosenNight = ThemeStore.shownWithPlatina(ThemeStore.darkTheme)
    val cards = ids.map { id ->
      ThemeCard.of(context, id, chosen = id == chosenNight, locked = false).also {
        it.onPress = {
          ThemeStore.darkTheme = id
          apply()
        }
      }
    }
    addGroup("Выбранная ночная тема", listOf(SettingsLook.inset(ThemeCard.strip(context, cards, 112f), top = 14f, side = 14f, bottom = 14f)))
    add(SettingsLook.foot(context, "Сама по себе ночная тема включается, когда приложение открывают или возвращаются в него. Открытый чат при этом не перерисовывается."), 10f)
  }

  private fun askClock(heading: String, name: String, value: String) {
    open(ClockScreen(context, heading, value) { picked ->
      DevicePreferences.set(mapOf(name to picked, "nightForced" to null, "nightForcedAt" to null))
      apply()
    })
  }

  companion object {
    /** The levels of the screen's brightness the night theme can wait for. */
    val levels = listOf(0.1, 0.25, 0.4, 0.6)
  }
}

/** «Начало» / «Конец»: an hour and a minute of the day (the minutes by quarters of an hour, as on the iPhone). */
@SuppressLint("ViewConstructor")
class ClockScreen(context: Context, heading: String, private val start: String, private val done: (String) -> Unit) : SettingsPage(context, heading) {
  private val hours = NumberPicker(context)
  private val minutes = NumberPicker(context)

  override fun build() {
    val pieces = start.split(":")
    val hour = (if (pieces.size == 2) pieces[0].toIntOrNull() else null) ?: 22
    val minute = (if (pieces.size == 2) pieces[1].toIntOrNull() else null) ?: 0
    for (picker in listOf(hours, minutes)) {
      // The wheels are turned, not typed in.
      picker.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
      if (Build.VERSION.SDK_INT >= 29) picker.textColor = Theme.text
    }
    hours.minValue = 0
    hours.maxValue = 23
    hours.setFormatter { String.format(Locale.ROOT, "%02d", it) }
    hours.value = hour.coerceIn(0, 23)
    hours.contentDescription = "Часы"
    minutes.minValue = 0
    minutes.maxValue = 3
    minutes.displayedValues = arrayOf("00", "15", "30", "45")
    minutes.value = (minute.coerceIn(0, 59) / 15)
    minutes.contentDescription = "Минуты"
    val pickers = LinearLayout(context)
    pickers.orientation = LinearLayout.HORIZONTAL
    pickers.gravity = Gravity.CENTER
    pickers.addView(hours, LinearLayout.LayoutParams(dp(96f), dp(180f)))
    pickers.addView(minutes, LinearLayout.LayoutParams(dp(96f), dp(180f)).apply { leftMargin = dp(12f) })
    add(pickers, 8f)
    val ready = SettingsButton(context, "Готово")
    ready.onPress = { finish() }
    add(ready, 16f)
  }

  /** For the checks: the wheels at an hour and a quarter. */
  fun set(hour: Int, minute: Int) {
    hours.value = hour.coerceIn(0, 23)
    minutes.value = minute.coerceIn(0, 59) / 15
  }

  private fun finish() {
    val words = String.format(Locale.ROOT, "%02d:%02d", hours.value, minutes.value * 15)
    goBack()
    done(words)
  }
}

/** «Цвет интерфейса»: the person's own accent colour over whichever theme is on — a row of colours, «Свой цвет»
 *  with three sliders, and «Как в теме» to go back. The choice is put on at once: the app itself is the
 *  preview. (The previous app: `mobile/src/ColorSettings.tsx`; the rules are the core's `settingsTheme`.) */
class AccentColorScreen(context: Context) : SettingsPage(context, "Цвет интерфейса") {
  private val hue = SeekBar(context)
  private val saturation = SeekBar(context)
  private val brightness = SeekBar(context)
  private val code = context.words("", 12f, Theme.muted)

  /** A slider's place as its value: the hue 0…359.9, the saturation 0…1, the brightness 0.12…1. */
  private class Span(val low: Double, val high: Double) {
    fun value(bar: SeekBar): Double = low + (high - low) * bar.progress / STEPS
    fun place(value: Double): Int = ((value.coerceIn(low, high) - low) / (high - low) * STEPS).roundToInt()
  }

  override fun build() {
    fill()
  }

  private val choices: List<String> get() = ThemeStore.words("accentChoices")
  private val base: String get() = DevicePreferences.word("accentColor") ?: choices.firstOrNull() ?: "#3568E7"

  private fun set(color: String?) {
    DevicePreferences.set(mapOf("accentColor" to color))
    if (!ThemeStore.refresh(listOf("appearance", "accent"))) fill()
  }

  private fun fill() {
    clear()
    val current = DevicePreferences.word("accentColor")
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT

    // How it looks, in the colours that are on right now.
    val sample = LinearLayout(context)
    sample.orientation = LinearLayout.VERTICAL
    sample.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    sample.addView(context.words("Нравится, оставляю", 15f, Theme.text), LinearLayout.LayoutParams(wrap, wrap))
    sample.addView(context.words("ссылка · 12:30", 13f, Theme.accent), LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(6f) })
    val sampleButton = context.words("Кнопка", 14f, Theme.onAccent, 700)
    sampleButton.background = context.plate(Theme.accent, 12f)
    sampleButton.gravity = Gravity.CENTER
    sampleButton.setPadding(dp(14f), dp(8f), dp(14f), dp(8f))
    sample.addView(sampleButton, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(6f) })

    // The colours offered before «Свой цвет»: two rows of round ones.
    val rowsOfColours = LinearLayout(context)
    rowsOfColours.orientation = LinearLayout.VERTICAL
    var line = LinearLayout(context)
    choices.forEachIndexed { index, color ->
      if (index % 6 == 0) {
        line = LinearLayout(context)
        line.orientation = LinearLayout.HORIZONTAL
        rowsOfColours.addView(line, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = if (index == 0) 0 else dp(10f) })
      }
      val on = current == color
      val ball = FrameLayout(context)
      ball.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(ThemeLook.color(color) ?: 0xFF808080.toInt())
        if (on) setStroke(dp(3f), Theme.text)
      }
      if (on) ball.addView(SymbolView(context, "ion:checkmark", 20f, 0xFFFFFFFF.toInt()), FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER))
      ball.isClickable = true
      ball.isFocusable = true
      ball.isSelected = on
      ball.contentDescription = "Цвет $color"
      ball.setOnClickListener {
        custom = false
        set(color)
      }
      val place = FrameLayout(context)
      place.addView(ball, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.CENTER))
      line.addView(place, LinearLayout.LayoutParams(0, wrap, 1f))
    }

    val asTheme = ColorChoiceButton(context, "Как в теме", current == null)
    asTheme.onPress = {
      custom = false
      set(null)
    }
    val ownColour = ColorChoiceButton(context, "Свой цвет", custom)
    ownColour.onPress = { toggleCustom() }
    val buttons = LinearLayout(context)
    buttons.orientation = LinearLayout.HORIZONTAL
    buttons.addView(asTheme, LinearLayout.LayoutParams(0, wrap, 1f))
    buttons.addView(ownColour, LinearLayout.LayoutParams(0, wrap, 1f).apply { leftMargin = dp(8f) })

    val box = LinearLayout(context)
    box.orientation = LinearLayout.VERTICAL
    box.addView(sample, LinearLayout.LayoutParams(wide, wrap))
    box.addView(rowsOfColours, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    box.addView(buttons, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    if (custom) {
      val position = sliders ?: hsv(base)
      val named = listOf(Triple("Оттенок", hue, hueSpan) to position[0], Triple("Насыщенность", saturation, saturationSpan) to position[1], Triple("Яркость", brightness, brightnessSpan) to position[2])
      for ((part, value) in named) {
        val (name, slider, span) = part
        slider.setOnSeekBarChangeListener(null)
        slider.max = STEPS
        slider.progress = span.place(value)
        slider.progressTintList = ColorStateList.valueOf(Theme.accent)
        slider.thumbTintList = ColorStateList.valueOf(Theme.accent)
        slider.contentDescription = name
        slider.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
          override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) { if (fromUser) moved() }
          override fun onStartTrackingTouch(bar: SeekBar?) {}
          override fun onStopTrackingTouch(bar: SeekBar?) { released() }
        })
        (slider.parent as? ViewGroup)?.removeView(slider)
        box.addView(context.words(name, 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
        box.addView(slider, LinearLayout.LayoutParams(wide, dp(36f)).apply { topMargin = dp(2f) })
      }
      (code.parent as? ViewGroup)?.removeView(code)
      code.text = current ?: base
      code.typeface = Typeface.MONOSPACE
      code.gravity = Gravity.CENTER
      box.addView(code, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f) })
    }
    addGroup(rows = listOf(SettingsLook.inset(box, top = 16f, side = 16f, bottom = 16f)))
    add(SettingsLook.foot(context, "Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым."), 10f)
  }

  private fun hsv(color: String): List<Double> {
    val read = Core.map(Core.view("settingsColorHsv", listOf(color))) ?: emptyMap()
    return listOf("h", "s", "v").map { (read[it] as? Number)?.toDouble() ?: 0.0 }
  }

  private fun placeOfSliders(): List<Double> = listOf(hueSpan.value(hue), saturationSpan.value(saturation), brightnessSpan.value(brightness))

  private fun colourOfSliders(): String? = Core.view("settingsHsvColor", placeOfSliders()) as? String

  private fun toggleCustom() {
    sliders = hsv(base)
    custom = !custom
    if (custom && DevicePreferences.word("accentColor") == null) set(base) else fill()
  }

  /** While a slider moves only the code of the colour follows; the colour is put on when the finger lets go. */
  private fun moved() {
    sliders = placeOfSliders()
    colourOfSliders()?.let { code.text = it }
  }

  private fun released() {
    sliders = placeOfSliders()
    set(colourOfSliders() ?: return)
  }

  /** For the checks: the sliders moved to a colour's place and let go. */
  fun slide(h: Double, s: Double, v: Double) {
    hue.progress = hueSpan.place(h); saturation.progress = saturationSpan.place(s); brightness.progress = brightnessSpan.place(v)
    moved()
    released()
  }

  companion object {
    private const val STEPS = 1000
    private val hueSpan = Span(0.0, 359.9)
    private val saturationSpan = Span(0.0, 1.0)
    private val brightnessSpan = Span(0.12, 1.0)
    /** «Свой цвет» is open, and where its sliders stand (a grey has no hue of its own: the slider must not jump).
     *  Kept past the page itself: a colour that is put on rebuilds the page. */
    var custom = false
    var sliders: List<Double>? = null
  }
}
