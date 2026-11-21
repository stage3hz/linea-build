package com.linea.messenger.settings

import android.content.Context
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.language.Language

/** «Язык»: the language of the interface; the choice applies at once and is kept on this device. (The previous app:
 *  `LanguageSection` of `mobile/src/SettingsScreen.tsx`; iOS Settings/LanguageSettings.swift; the dictionary:
 *  language/Language.kt.) */
class LanguageScreen(context: Context) : SettingsPage(context, "Язык") {
  override fun build() {
    clear()
    val rows = Language.choices.map { choice ->
      LanguageRow(context, choice.native, choice.name, choice.id == Language.current).apply {
        setOnClickListener { performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); choose(choice.id) }
      }
    }
    addGroup("Язык интерфейса", rows)
    add(SettingsLook.foot(context, "Язык меняется только в интерфейсе. Сообщения и имена остаются как есть."), 8f)
  }

  private fun choose(id: String) {
    if (id == Language.current) return
    Language.set(id)
    // Every screen is made again in the new language, with «Настройки › Язык» open on top, as the theme does.
    (context as? ThemeHost)?.restyle(listOf("language"))
  }
}

/** One language: its own name, its name in English, a mark on the chosen one (neither is in the dictionary). */
class LanguageRow(context: Context, native: String, name: String, chosen: Boolean) : LinearLayout(context) {
  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.px(56f)
    setPadding(context.px(16f), context.px(9f), context.px(16f), context.px(9f))
    val texts = LinearLayout(context).apply { orientation = VERTICAL }
    // Kept as they are by the dictionary: a text with its own spans is never translated (language/Language.kt).
    texts.addView(context.words("", 15f, Theme.text, 600).apply { text = android.text.SpannableString(native) })
    texts.addView(context.words("", 13f, Theme.muted).apply { text = android.text.SpannableString(name) }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(2f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    addView(SymbolView(context, "check", 17f, Theme.accent).apply { alpha = if (chosen) 1f else 0f }, LayoutParams(context.px(20f), context.px(20f)))
    isClickable = true
    isFocusable = true
    isSelected = chosen
    contentDescription = native
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.RadioButton"

  override fun setPressed(pressed: Boolean) { super.setPressed(pressed); setBackgroundColor(if (pressed) SettingsLook.pressed else 0) }
}

/** The pages of the settings added for parity with the previous app, by the names `SettingsScreen.page` opens them with
 *  (also the names of `--es settings <page>` on the emulator; iOS Settings/ParityPages.swift). */
internal fun parityPage(context: Context, name: String, account: SettingsAccount?): View? = when (name) {
  "power" -> PowerSettingsScreen(context)
  "language" -> LanguageScreen(context)
  "passcode" -> PasscodeScreen(context)
  "lastseenallow", "lastseendeny" -> account?.let { val model = SettingsPrivacyModel(it).also { m -> m.load() }; LastSeenExceptionsScreen(context, it, model, if (name == "lastseenallow") "allow" else "deny") }
  "callrules" -> account?.let { CallRulesScreen(context, it) }
  else -> null
}
