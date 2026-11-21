package com.linea.messenger.settings

import android.content.Intent

/** For the emulator check (debug builds only): the look itself can be set for a shot by launch arguments, as the
 *  iOS simulator check does (native/ios/Sources/Settings/SettingsSimulator.swift). Kept on the emulator until
 *  changed again.
 *    --es settheme light|dark|black|graphite|amethyst|coffee|olive|dusk|lagoon|indigo|neon   the theme (a palette also needs --ez setplatina true)
 *    --es setaccent RRGGBB|none          «Цвет интерфейса»
 *    --es settextsize small|medium|large|xlarge
 *    --es setnight system|off|schedule|auto     when the night theme turns on by itself
 *    --ez setplatina true|false          what the phone remembers of the account's Platina (with an account the server's answer replaces it)
 *  The pages themselves: `--es settings appearance|night|accent` (also with demo), `notifications|data` (with an account). */
object SettingsSimulator {
  /** The look asked for by launch arguments; called before the first screen is made. */
  fun look(intent: Intent) {
    var touched = false
    if (intent.hasExtra("setplatina")) { ThemeStore.platina = intent.getBooleanExtra("setplatina", false); touched = true }
    intent.getStringExtra("settheme")?.let { theme ->
      ThemeStore.mode = theme
      if (theme != "light") ThemeStore.darkTheme = theme
      DevicePreferences.set(mapOf("nightMode" to "off", "nightForced" to null, "nightForcedAt" to null))
      touched = true
    }
    intent.getStringExtra("setaccent")?.let { accent ->
      DevicePreferences.set(mapOf("accentColor" to if (accent == "none") null else "#" + accent.uppercase()))
      touched = true
    }
    intent.getStringExtra("settextsize")?.let { size -> DevicePreferences.set(mapOf("textSize" to size)); touched = true }
    intent.getStringExtra("setnight")?.let { night ->
      DevicePreferences.set(mapOf("nightMode" to night, "nightForced" to null, "nightForcedAt" to null))
      touched = true
    }
    if (touched) ThemeStore.refresh()
  }
}
