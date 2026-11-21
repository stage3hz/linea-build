package com.linea.messenger.effects

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.net.Live
import com.linea.messenger.settings.DevicePreferences
import kotlin.math.roundToInt

/** May the app animate right now, and which heavy processes may play: «Энергосбережение и анимации».
 *  (The previous app: `mobile/src/motionPolicy.ts` — the pure rules, word for word — and `mobile/src/motion.tsx` — the
 *  battery, the system's power saving and «Удалить анимацию»; iOS Effects/Motion.swift.) The choices themselves are the
 *  device preferences `animations`, `lowBattery`, `autoplayVideo`, `autoplayGif`, `animatedStickers`, `animatedEmoji`
 *  (settings/ThemeStore.kt, read back through the core's `settingsPreferences`). */
object Motion {
  /** Posted on the main thread whenever the answer may have changed (a preference, the battery, the system). */
  val changed = Live.Signal<Unit>()

  /** Battery level (0…1) at or below which animations switch off in automatic mode. */
  const val LOW_BATTERY_DEFAULT = 0.27

  data class Power(val level: Double? = null, val charging: Boolean = false, val lowPower: Boolean = false, val reduceMotion: Boolean = false)

  private var app: Context? = null
  var power = Power()
    private set
  private val preferencesChanged: (Unit) -> Unit = { read(); changed.post(Unit) }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      try {
        if (intent?.action == Intent.ACTION_BATTERY_CHANGED) battery(intent) else read()
        changed.post(Unit)
      } catch (_: Exception) { /* the answer stays as it was */ }
    }
  }

  /** Starts watching the battery and the system once (safe to call again); the avatars' motion follows these rules. */
  fun start(context: Context) {
    if (app != null) return
    val known = context.applicationContext
    app = known
    AvatarMotion.override = { kind -> if (kind == "motion") enabled else feature(kind) }
    try {
      val filter = IntentFilter().apply { addAction(Intent.ACTION_BATTERY_CHANGED); addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED) }
      val sticky = if (Build.VERSION.SDK_INT >= 33) known.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED) else known.registerReceiver(receiver, filter)
      if (sticky != null) battery(sticky)
    } catch (_: Exception) { /* no battery news: the rules use the system's power saving only */ }
    DevicePreferences.changed.watch(preferencesChanged)
    read()
  }

  private fun battery(intent: Intent) {
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
    power = power.copy(
      level = if (level >= 0 && scale > 0) level.toDouble() / scale else null,
      charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL,
    )
    read()
  }

  private fun read() {
    val known = app ?: return
    val saver = (known.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isPowerSaveMode == true
    val scale = try { Settings.Global.getFloat(known.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) } catch (_: Exception) { 1f }
    power = power.copy(lowPower = saver, reduceMotion = scale == 0f)
  }

  // ---- The rules (motionPolicy.ts) ----

  /** «Режим энергосбережения»: on always (threshold 1), in the system's power saving, or below the chosen battery level
   *  while not charging. Threshold 0 = never by battery. */
  fun powerSaving(power: Power, threshold: Double): Boolean {
    if (threshold >= 1 || power.lowPower) return true
    val level = power.level ?: return false
    if (level < 0) return false
    return !power.charging && threshold > 0 && level <= threshold + 1e-9
  }

  fun motionAllowed(mode: String, power: Power, threshold: Double): Boolean {
    if (mode == "on") return true
    if (mode == "off") return false
    if (power.reduceMotion) return false
    return !powerSaving(power, threshold)
  }

  fun percent(value: Double): Int = (value * 100).roundToInt()

  fun motionReason(mode: String, power: Power, threshold: Double): String {
    if (mode == "on") return "Анимации включены всегда."
    if (mode == "off") return "Анимации выключены."
    if (power.reduceMotion) return "Выключены: в системе включено «Уменьшение движения»."
    if (threshold >= 1) return "Выключены: режим энергосбережения включён всегда."
    if (power.lowPower) return "Выключены: включён режим энергосбережения."
    if (!motionAllowed(mode, power, threshold)) return "Выключены: заряд ${percent(power.level ?: 0.0)}% — не больше ${percent(threshold)}%."
    return if (threshold > 0) "Включены. Выключатся сами при заряде ${percent(threshold)}% и ниже или в режиме энергосбережения." else "Включены. По заряду не выключаются, только в режиме энергосбережения."
  }

  // ---- What the app asks ----

  val mode: String get() = DevicePreferences.word("animations") ?: "auto"
  val threshold: Double get() = DevicePreferences.number("lowBattery") ?: 0.25

  /** Animations (and the decorative effects) may run now. */
  val enabled: Boolean get() = motionAllowed(mode, power, threshold)
  val reason: String get() = motionReason(mode, power, threshold)
  val saving: Boolean get() = powerSaving(power, threshold)

  /** A heavy process plays when its switch is on and power saving is not active: "video" (autoplay of videos and round
   *  videos), "gif", "stickers" (big emoji move), "emoji" (emoji statuses move). */
  fun feature(kind: String): Boolean {
    if (saving) return false
    return when (kind) {
      "video" -> DevicePreferences.flag("autoplayVideo") ?: true
      "gif" -> DevicePreferences.flag("autoplayGif") ?: true
      "stickers" -> DevicePreferences.flag("animatedStickers") ?: true
      else -> DevicePreferences.flag("animatedEmoji") ?: true
    }
  }

  /** `ms` when animations are allowed, otherwise 0 (jump straight to the end). */
  fun duration(ms: Long): Long = if (enabled) ms else 0L
}
