package com.linea.messenger.settings

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Outline
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.R
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words

// Effects: the parts of «Оформление» that belong to the effects — «Иконка приложения» and the switches of «Пиксельный
// след», «Снег» and «Ледяное стекло». (The previous app: `AppIconPicker.tsx` and `Appearance` of
// `mobile/src/SettingsScreen.tsx`, word for word; iOS Settings/AppearanceEffects.swift.) Kept on this device only.

/** «Иконка приложения» (before «Свои цвета», as in the reference). */
fun SettingsPage.addIconGroup() {
  addGroup("Иконка приложения", listOf(AppIconPicker(context)))
}

/** The three switches (after «Свои цвета»). */
fun SettingsPage.addEffectGroups() {
  val trail = SettingsSwitchRow(context, "Пиксельный след", "Сетка пикселей подсвечивается под пальцем и курсором: белая в тёмной теме, чёрная в светлой", DevicePreferences.flag("pixelTrail") ?: true)
  trail.onChange = { on -> DevicePreferences.set(mapOf("pixelTrail" to on)) }
  addGroup(rows = listOf(trail))
  val snow = SettingsSwitchRow(context, "Снег", "Снег падает на фоне экрана, за кнопками и панелями", DevicePreferences.flag("snow") ?: true)
  snow.onChange = { on -> DevicePreferences.set(mapOf("snow" to on)) }
  addGroup(rows = listOf(snow))
  val ice = SettingsSwitchRow(context, "Ледяное стекло", "Иней по кромке стеклянных кнопок, панелей и карточек; тает, когда телефон нагревается", DevicePreferences.flag("ice") ?: true)
  ice.onChange = { on -> DevicePreferences.set(mapOf("ice" to on)) }
  addGroup(rows = listOf(ice))
}

/** The app's icons as the launcher shows them: one alias of the window per icon (the reference's
 *  expo-alternate-app-icons: `MainActivityOutline` and the others in the manifest), exactly one of them enabled.
 *  «Контур» is the default (id null, the alias `Outline`). */
object AppIcons {
  class Icon(val id: String?, val label: String, val preview: Int, val alias: String)

  val icons = listOf(
    Icon(null, "Контур", R.drawable.app_icon_outline_preview, "Outline"),
    Icon("Blue", "Синяя", R.drawable.app_icon_default_preview, "Blue"),
    Icon("Light", "Светлая", R.drawable.app_icon_light_preview, "Light"),
    Icon("Aurora", "Сияние", R.drawable.app_icon_aurora_preview, "Aurora"),
  )

  private fun component(context: Context, alias: String) = ComponentName(context.packageName, "com.linea.messenger.MainActivity$alias")

  /** The icon on the launcher now (null = «Контур»); null too when it cannot be told. */
  fun current(context: Context): String? {
    val manager = context.packageManager
    for (icon in icons) {
      val state = try { manager.getComponentEnabledSetting(component(context, icon.alias)) } catch (_: Exception) { continue }
      val on = state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && icon.id == null)
      if (on) return if (icon.alias == "Outline") null else icon.id
    }
    return null
  }

  /** Puts `id` on the launcher. The window keeps running; the launcher may take a few seconds. False when it failed. */
  fun choose(context: Context, id: String?): Boolean = try {
    val manager = context.packageManager
    val chosen = icons.first { it.id == id }
    // The new one first: the app is never left without an entry on the launcher.
    manager.setComponentEnabledSetting(component(context, chosen.alias), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
    for (icon in icons) if (icon !== chosen) manager.setComponentEnabledSetting(component(context, icon.alias), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
    true
  } catch (_: Exception) { false }
}

/** The app's icon: four pictures side by side, the chosen one in a ring of the accent colour, its name under it. */
class AppIconPicker(context: Context) : LinearLayout(context) {
  private val row = LinearLayout(context)
  private val error = context.words("", 12f, Theme.danger)

  init {
    orientation = VERTICAL
    setPadding(context.px(14f), context.px(14f), context.px(14f), context.px(14f))
    row.orientation = HORIZONTAL
    addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(context.words("На Android лаунчер может обновить иконку через несколько секунд, а приложение — перезапуститься.", 11f, Theme.muted), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
    error.visibility = GONE
    addView(error, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(8f) })
    fill()
  }

  private fun fill() {
    row.removeAllViews()
    val current = AppIcons.current(context)
    AppIcons.icons.forEachIndexed { index, icon ->
      val tile = AppIconTile(context, icon, icon.id == current)
      tile.setOnClickListener { choose(icon, current) }
      row.addView(tile, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) leftMargin = context.px(12f) })
    }
  }

  private fun choose(icon: AppIcons.Icon, current: String?) {
    if (icon.id == current) return
    error.visibility = GONE
    if (!AppIcons.choose(context, icon.id)) { error.text = "Не удалось сменить иконку."; error.visibility = VISIBLE }
    fill()
  }
}

/** One icon: its picture (58 dp, rounded), a ring when chosen, its name under it. */
class AppIconTile(context: Context, icon: AppIcons.Icon, chosen: Boolean) : LinearLayout(context) {
  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    val ring = LinearLayout(context)
    ring.gravity = Gravity.CENTER
    ring.background = context.plate(0, 19f).apply { setStroke(context.px(2f), if (chosen) Theme.accent else 0) }
    val picture = ImageView(context)
    picture.setImageResource(icon.preview)
    picture.scaleType = ImageView.ScaleType.CENTER_CROP
    val corner = 15f * resources.displayMetrics.density
    picture.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, corner) }
    }
    picture.clipToOutline = true
    ring.addView(picture, LayoutParams(context.px(58f), context.px(58f)))
    addView(ring, LayoutParams(context.px(68f), context.px(68f)))
    val name: TextView = context.words(icon.label, 11f, if (chosen) Theme.accent else Theme.muted, if (chosen) 700 else 500)
    name.gravity = Gravity.CENTER
    addView(name, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(6f) })
    isClickable = true
    isFocusable = true
    contentDescription = "Иконка «" + icon.label + "»"
    isSelected = chosen
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.RadioButton"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    alpha = if (pressed) 0.7f else 1f
  }
}
