package com.linea.messenger.settings

import android.content.Context
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.shell.Screen

/** The settings section. For now: what the app is made of. */
class SettingsScreen(context: Context) : Screen(context) {
  private val heading = TextView(context)
  private val version = TextView(context)

  init {
    setBackgroundColor(Theme.bg)
    heading.text = "Настройки"
    heading.textSize = 34f
    heading.typeface = Theme.weight(700)
    heading.setTextColor(Theme.text)
    heading.includeFontPadding = false
    addView(heading)
    val app = try { context.packageManager.getPackageInfo(context.packageName, 0).versionName } catch (_: Exception) { null } ?: "?"
    version.text = "INVIZENT $app · ядро ${Core.version}"
    version.textSize = 15f
    version.setTextColor(Theme.muted)
    addView(version)
  }

  override fun place(width: Int, height: Int) {
    val headingHeight = putText(heading, dp(20f), edges.top + dp(8f), width - dp(40f))
    putText(version, dp(20f), edges.top + dp(8f) + headingHeight + dp(6f), width - dp(40f))
  }
}
