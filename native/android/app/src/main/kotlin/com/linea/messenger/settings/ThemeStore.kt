package com.linea.messenger.settings

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.provider.Settings
import android.view.View
import android.view.WindowInsetsController
import com.linea.messenger.core.Core
import java.lang.ref.WeakReference
import java.time.LocalTime
import kotlin.math.roundToInt

/** Where this phone keeps a few words by their names (the device's own preferences; the tests give one in memory). */
interface KeptWords {
  fun get(key: String): String?
  /** Null removes the record. */
  fun set(key: String, value: String?)
}

/** The app's own preferences on this device. */
private class PhoneWords(private val store: SharedPreferences) : KeptWords {
  override fun get(key: String): String? = try { store.getString(key, null) } catch (_: ClassCastException) { null }
  override fun set(key: String, value: String?) {
    store.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
  }
}

/** What this phone keeps of the person's choices for the look and the chats: one JSON record, read back through
 *  the core, so an old or broken record never breaks a screen. Kept on this device only — the server knows
 *  nothing of it. (The previous app: `mobile/src/chatPreferences.ts`; the rules are the core's `settingsPreferences`.) */
object DevicePreferences {
  const val KEY = "invizent.chat-preferences.v1"
  private var kept: Map<String, Any?>? = null

  /** Every preference with its value (a missing one has its default; «not chosen» is null). */
  val all: Map<String, Any?>
    get() {
      kept?.let { return it }
      val read = Core.map(Core.view("settingsPreferences", listOf(ThemeStore.kept?.get(KEY)))) ?: emptyMap()
      kept = read
      return read
    }

  /** Changes some of them. */
  fun set(change: Map<String, Any?>) {
    val next = LinkedHashMap(all)
    next.putAll(change)
    val text = Core.text(next) ?: return
    ThemeStore.kept?.set(KEY, text)
    kept = Core.map(Core.view("settingsPreferences", listOf(text))) ?: next
    changed.post(Unit) // Effects: the snow, the trail, the animations follow the switches (effects/Motion.kt)
  }

  /** Effects: posted on the main thread after every change (effects/Motion.kt, effects/EffectsHost.kt). */
  val changed = com.linea.messenger.net.Live.Signal<Unit>()

  fun word(name: String): String? = all[name] as? String
  fun flag(name: String): Boolean? = all[name] as? Boolean
  fun number(name: String): Double? = (all[name] as? Number)?.toDouble()
  /** The value as it is handed to the core: `otherwise` when there is none. */
  fun item(name: String, otherwise: Any? = null): Any? = all[name] ?: otherwise

  /** The record is read again at the next question (another store was put under the app). */
  internal fun forget() { kept = null }
}

/** The colours of one theme, as the app draws with them (0xAARRGGBB). Made from the core's answer (`settingsTheme`:
 *  the reference's own `Theme`); without an answer it is «Чёрная», the app's own look. */
class ThemeLook {
  var id = "black"; private set
  var dark = true; private set
  var black = true; private set
  var bg = 0xFF08090A.toInt(); private set
  var text = 0xFFE5E5E6.toInt(); private set
  var muted = 0xFF8A8F98.toInt(); private set
  var subtle = 0xFF62666D.toInt(); private set
  var accent = 0xFFE5E5E6.toInt(); private set
  var onAccent = 0xFF08090A.toInt(); private set
  var accentSoft = 0x12FFFFFF; private set
  var surface2 = 0xEB161718.toInt(); private set
  var border = 0xFF23252A.toInt(); private set
  var danger = 0xFFFF9CB0.toInt(); private set
  var bubble = 0xF51F2023.toInt(); private set
  var incoming = 0xF5161718.toInt(); private set
  /** The reference's `glass` and `glassBorder` (theme.tsx). */
  var glass = 0x9E0F1011.toInt(); private set
  var glassBorder = 0x14FFFFFF; private set
  /** The reference's `glassHighlight` (theme.tsx): the light ring of a cover without a picture. */
  var glassHighlight = 0x1AFFFFFF; private set
  /** The reference's `dangerBg` (the circle of a missed call's row, MessageRow.tsx CallServiceRow). */
  var dangerBg = 0xE045141F.toInt(); private set
  /** Settings: the reference's `glassOpaque` (the flat card of a group in «Чёрная») and `accentGradient` (the main `Button`). */
  var glassOpaque = 0xFF0F1011.toInt(); private set
  /** The reference's `glassHighlight` (the line at the top of its glass). */
  var glassHighlight = 0x1AFFFFFF; private set
  var accentGradient: List<Int> = listOf(0xFFF2F2F2.toInt(), 0xFFC8C8C8.toInt()); private set
  /** What the look was made from: two looks with the same words here are the same look. */
  var source = "black|"; private set

  constructor()

  constructor(id: String, fields: Map<String, Any?>) {
    this.id = id
    dark = fields["dark"] as? Boolean ?: true
    black = fields["black"] as? Boolean ?: false
    bg = color(fields["bg"] as? String) ?: bg
    text = color(fields["text"] as? String) ?: text
    muted = color(fields["muted"] as? String) ?: muted
    subtle = color(fields["subtle"] as? String) ?: subtle
    accent = color(fields["accent"] as? String) ?: accent
    onAccent = color(fields["onAccent"] as? String) ?: onAccent
    accentSoft = color(fields["accentSoft"] as? String) ?: accentSoft
    surface2 = color(fields["surface2"] as? String) ?: surface2
    border = color(fields["border"] as? String) ?: border
    danger = color(fields["danger"] as? String) ?: danger
    bubble = color(fields["bubble"] as? String) ?: bubble
    incoming = color(fields["incoming"] as? String) ?: incoming
    glass = color(fields["glass"] as? String) ?: glass
    glassBorder = color(fields["glassBorder"] as? String) ?: glassBorder
    glassHighlight = color(fields["glassHighlight"] as? String) ?: glassHighlight
    dangerBg = color(fields["dangerBg"] as? String) ?: dangerBg
    glassOpaque = color(fields["glassOpaque"] as? String) ?: glassOpaque
    glassHighlight = color(fields["glassHighlight"] as? String) ?: glassHighlight
    accentGradient = ((fields["accentGradient"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { color(it as? String) }
    source = id + "|" + (fields["accent"] as? String ?: "")
  }

  /** A thin veil over the page: white on a dark theme, black on a light one. */
  fun veil(alpha: Float): Int = ((alpha.coerceIn(0f, 1f) * 255).roundToInt() shl 24) or (if (dark) 0xFFFFFF else 0)

  companion object {
    /** `#RRGGBB`, `rgba(r,g,b,a)` or `transparent`, as the reference writes a colour; null for anything else. */
    fun color(text: String?): Int? {
      if (text == null) return null
      if (text == "transparent") return 0
      if (text.startsWith("#")) {
        if (text.length != 7 || !text.drop(1).all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        return 0xFF000000.toInt() or text.drop(1).toInt(16)
      }
      val open = text.indexOf('('); val close = text.lastIndexOf(')')
      if (!text.startsWith("rgb") || open < 0 || close < open) return null
      val parts = text.substring(open + 1, close).split(",").map { it.trim().toDoubleOrNull() }
      if (parts.size < 3) return null
      val red = parts[0] ?: return null; val green = parts[1] ?: return null; val blue = parts[2] ?: return null
      val alpha = parts.getOrNull(3) ?: 1.0
      fun part(value: Double, top: Double): Int = (value / top * 255).roundToInt().coerceIn(0, 255)
      return (part(alpha, 1.0) shl 24) or (part(red, 255.0) shl 16) or (part(green, 255.0) shl 8) or part(blue, 255.0)
    }
  }
}

/** The window, as the theme sees it: where a look that has just been put on is drawn. */
interface ThemeHost {
  /** The sections are what the screen shows: no chat, no page, no list over them. */
  val shellAlone: Boolean
  /** The shell is built again in the colours that are on now; `pages` are the settings pages to open again on
   *  top («appearance», «night», «accent»). Nothing but the window's own colours changes while signing in. */
  fun restyle(pages: List<String>)
}

/** Which theme is on, and putting it on.
 *
 *  The choice is kept on this device, as in the previous app (`mobile/src/storage.ts`, `themePreference.ts`): the
 *  day theme, the night theme, and the night rule among the device preferences. Nothing chosen yet means
 *  «Чёрная», the app's own look. Which theme is shown at a given moment is the core's answer (`settingsNight`).
 *
 *  A change made in the settings redraws the app at once: the shell is built again in the new colours and the
 *  settings page is opened again on top. A change that comes by itself (the night theme by the clock, by the
 *  system's look or by the screen's brightness) is put on when the app is opened or comes back to the front
 *  while the sections are on the screen — an open chat or page is never rebuilt under the person's hands. */
object ThemeStore {
  const val MODE_KEY = "invizent.theme.v1"
  const val DARK_KEY = "invizent.dark-theme.v1"
  const val PLATINA_KEY = "invizent.platina.v1"
  private const val PREFERENCES = "invizent.look"

  /** Where the choices are kept; null before the window is there (and in a test that gave none): «Чёрная». */
  var kept: KeptWords? = null
    private set
  @Volatile private var current: ThemeLook? = null
  private var window = WeakReference<Activity>(null)
  private val black = ThemeLook()

  /** For the tests: the minute of the day, the system's look («dark», «light», «unspecified») and the screen's
   *  brightness (0…1, null when it cannot be told) as the phone says them. */
  internal var minuteNow: () -> Int = { LocalTime.now().let { it.hour * 60 + it.minute } }
  internal var systemLook: (() -> String)? = null
  internal var screenLevel: (() -> Double?)? = null

  /** The look that is on. */
  val look: ThemeLook
    get() {
      current?.let { return it }
      if (kept == null) return black
      return compute().also { current = it }
    }

  private fun stored(): Pair<String, String> {
    val mode = kept?.get(MODE_KEY) ?: "black"
    val dark = kept?.get(DARK_KEY) ?: "black"
    val read = Core.map(Core.view("settingsStoredTheme", listOf(mode, dark)))
    return (read?.get("mode") as? String ?: "black") to (read?.get("darkTheme") as? String ?: "black")
  }

  /** The day theme the person chose: light, dark, black, graphite, a palette, or system. */
  var mode: String
    get() = stored().first
    set(value) { kept?.set(MODE_KEY, value) }

  /** The night theme the person chose. */
  var darkTheme: String
    get() = stored().second
    set(value) { kept?.set(DARK_KEY, value) }

  /** Whether the account has Platina, as the server last said (the palettes belong to it). */
  var platina: Boolean
    get() = kept?.get(PLATINA_KEY) == "1"
    set(value) { kept?.set(PLATINA_KEY, if (value) "1" else null) }

  /** A theme as it is shown to this account: a palette without Platina is «Тёмная»; the choice itself is kept. */
  fun shownWithPlatina(id: String): String = Core.view("settingsWithPlatina", listOf(id, platina)) as? String ?: id

  /** The lists the pages show (`settingsRules`): names of the themes, sizes of the text, colours to choose from… */
  val rules: Map<String, Any?> by lazy { Core.map(Core.view("settingsRules", emptyList())) ?: emptyMap() }

  fun list(name: String): List<Map<String, Any?>> = (rules[name] as? List<*>).orEmpty().mapNotNull { Core.map(it) }

  fun words(name: String): List<String> = (rules[name] as? List<*>).orEmpty().filterIsInstance<String>()

  fun themeName(id: String): String = Core.map(rules["themeNames"])?.get(id) as? String ?: id

  /** The colours of a theme by its id, with nothing of the person's own laid over (for the cards). */
  fun plainFields(id: String): Map<String, Any?> = Core.map(Core.view("settingsTheme", listOf(id, null, null))) ?: emptyMap()

  private fun system(): String {
    systemLook?.let { return it() }
    val night = (window.get()?.resources?.configuration?.uiMode ?: 0) and Configuration.UI_MODE_NIGHT_MASK
    return when (night) { Configuration.UI_MODE_NIGHT_YES -> "dark"; Configuration.UI_MODE_NIGHT_NO -> "light"; else -> "unspecified" }
  }

  /** How bright the screen is, 0…1: the window's own brightness when it has one, else the system's. */
  private fun level(): Double? {
    screenLevel?.let { return it() }
    val activity = window.get() ?: return null
    val own = activity.window.attributes.screenBrightness
    if (own >= 0f) return own.toDouble().coerceIn(0.0, 1.0)
    return try { Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS).coerceIn(0, 255) / 255.0 } catch (_: Exception) { null }
  }

  /** The night theme right now (`settingsNight`): `kind`, `auto`, `known`, `expired`, `night`, `shown`, `day`. */
  fun nightState(): Map<String, Any?> {
    val rule = linkedMapOf(
      "mode" to DevicePreferences.item("nightMode"),
      "from" to DevicePreferences.item("nightFrom", "22:00"),
      "to" to DevicePreferences.item("nightTo", "07:00"),
      "brightness" to DevicePreferences.item("nightBrightness", 0.25),
      "forced" to DevicePreferences.item("nightForced"),
      "forcedAt" to DevicePreferences.item("nightForcedAt"),
    )
    val chosen = stored()
    val args = listOf(rule, shownWithPlatina(chosen.first), shownWithPlatina(chosen.second), system(), minuteNow(), level())
    return Core.map(Core.view("settingsNight", args)) ?: emptyMap()
  }

  private fun compute(): ThemeLook {
    var state = nightState()
    if (state["expired"] == true) {
      // The rule changed by itself since «Ночной режим» was switched by hand: the switch has run out.
      DevicePreferences.set(mapOf("nightForced" to null, "nightForcedAt" to null))
      state = nightState()
    }
    val id = state["shown"] as? String ?: "black"
    // «Цвет интерфейса». The colour of one's own messages is not laid over, as on the iPhone.
    val fields = Core.map(Core.view("settingsTheme", listOf(id, DevicePreferences.item("accentColor"), null))) ?: return ThemeLook()
    return ThemeLook(id, fields)
  }

  /** The size of the text of messages («Размер текста в чатах»). */
  val textSize: Float
    get() {
      val chosen = DevicePreferences.word("textSize") ?: "medium"
      return (list("textSizes").firstOrNull { it["id"] == chosen }?.get("fontSize") as? Number)?.toFloat() ?: 17f
    }

  /** The app's window: it takes the theme's light or dark side, and the theme is looked at again whenever the
   *  app comes back to the front (`cameBack`). */
  fun attach(activity: Activity) {
    window = WeakReference(activity)
    use(PhoneWords(activity.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)))
    paint(activity)
  }

  /** Puts a store under the app (the tests: one in memory; null — none, and «Чёрная» again). */
  internal fun use(store: KeptWords?) {
    kept = store
    DevicePreferences.forget()
    current = if (store == null) null else compute()
  }

  /** The window's own background, and the system's bars: dark signs over a light theme, light over a dark one. */
  @Suppress("DEPRECATION")
  private fun paint(activity: Activity) {
    val shown = look
    val decor = activity.window.decorView
    activity.window.setBackgroundDrawable(ColorDrawable(shown.bg or 0xFF000000.toInt()))
    if (Build.VERSION.SDK_INT >= 30) {
      val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
      activity.window.insetsController?.setSystemBarsAppearance(if (shown.dark) 0 else light, light)
    } else {
      val light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
      decor.systemUiVisibility = if (shown.dark) decor.systemUiVisibility and light.inv() else decor.systemUiVisibility or light
    }
  }

  /** The app is in front again: what should be on is looked at, unless a chat or a page is open. */
  fun cameBack() {
    val host = window.get() as? ThemeHost ?: return
    if (host.shellAlone) refresh()
  }

  /** Looks again at what should be on and, when the look changed, redraws the app in it. `reopen`: the settings
   *  pages to open again on top («appearance», «night», «accent»). True when the app was redrawn. */
  fun refresh(reopen: List<String> = emptyList()): Boolean {
    if (kept == null) return false
    val fresh = compute()
    if (fresh.source == look.source) return false
    current = fresh
    val activity = window.get() ?: return true
    paint(activity)
    (activity as? ThemeHost)?.restyle(reopen)
    return true
  }
}
