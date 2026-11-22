package com.linea.messenger.settings

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.widget.TextView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.security.CodeEntryView
import com.linea.messenger.security.LockBiometrics
import com.linea.messenger.security.LockRules
import com.linea.messenger.security.LockStore

/** Настройки › «Код-пароль»: turn the code on, change it, unlock with the fingerprint, the autolock delay, turn it off.
 *  With a code set, the page first asks for the current code. (The previous app: `mobile/src/lock/PasscodeSettings.tsx`,
 *  word for word; iOS Settings/PasscodeSettings.swift; the rules: security/LockModel.kt.) */
class PasscodeScreen(context: Context) : SettingsPage(context, "Код-пароль") {
  private sealed class Phase { object Verify : Phase(); object Settings : Phase(); class Setup(val change: Boolean) : Phase() }
  private var phase: Phase = if (LockStore.current.record != null) Phase.Verify else Phase.Settings
  private var entry: CodeEntryView? = null
  private var kind = "digits"
  private var first: String? = null
  private var error = ""
  private var wrong = false
  private var checking = false
  private var bioBusy = false
  private val ticker = Handler(Looper.getMainLooper())
  private val tick = object : Runnable { override fun run() { refreshVerify(); ticker.postDelayed(this, 500) } }

  override fun build() = fill()

  override fun onDetachedFromWindow() { ticker.removeCallbacksAndMessages(null); super.onDetachedFromWindow() }

  private fun fill() {
    clear()
    entry = null
    ticker.removeCallbacksAndMessages(null)
    when (val now = phase) {
      Phase.Verify -> {
        val record = LockStore.current.record ?: run { phase = Phase.Settings; return fill() }
        val made = CodeEntryView(context, record.kind)
        made.onSubmit = { code -> verify(code) }
        entry = made
        add(SettingsLook.inset(made, top = 12f), 0f)
        refreshVerify()
        ticker.postDelayed(tick, 500)
        made.focus()
      }
      is Phase.Setup -> {
        val made = CodeEntryView(context, kind)
        made.onSubmit = { code -> take(code, now.change) }
        entry = made
        setupFooter(made)
        add(SettingsLook.inset(made, top = 12f), 0f)
        refreshSetup(now.change)
        made.focus()
      }
      Phase.Settings -> fillSettings()
    }
  }

  // ---- Verify (the same failure counter and wait as the lock screen) ----

  private fun refreshVerify() {
    val entry = entry ?: return
    val record = LockStore.current.record ?: return
    val wait = LockStore.waitMs
    val digits = record.kind == "digits"
    entry.setTitle(if (digits) "Введи текущий код-пароль" else "Введи текущий пароль",
      if (wait > 0) LockRules.retryHint(wait) else "Чтобы менять настройки код-пароля, подтверди его",
      if (wrong && wait <= 0) "Неверный код-пароль" else "")
    entry.disabled = checking || wait > 0
  }

  private fun verify(code: String) {
    if (checking || LockStore.waitMs > 0) return
    checking = true
    refreshVerify()
    LockStore.check(code) { right ->
      checking = false
      if (right) {
        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        LockStore.recordSuccess()
        endEditing()
        phase = Phase.Settings
        fill()
        return@check
      }
      wrong = true
      LockStore.recordFailure()
      entry?.shake()
      refreshVerify()
    }
  }

  // ---- Setup ----

  private fun setupFooter(made: CodeEntryView) {
    if (first == null) {
      made.footer.addView(textButton(if (kind == "digits") "Использовать пароль" else "Использовать 4-значный код", muted = false) {
        kind = if (kind == "digits") "password" else "digits"
        error = ""
        fill()
      })
    }
    made.footer.addView(textButton("Отмена", muted = true) {
      endEditing()
      first = null
      error = ""
      phase = Phase.Settings
      fill()
    })
  }

  private fun textButton(label: String, muted: Boolean, action: () -> Unit): TextView = context.words(label, 15f, if (muted) Theme.muted else Theme.accent, 600).apply {
    gravity = Gravity.CENTER
    minHeight = context.px(44f)
    setPadding(context.px(16f), 0, context.px(16f), 0)
    isClickable = true
    isFocusable = true
    setOnClickListener { action() }
  }

  private fun refreshSetup(change: Boolean) {
    val entry = entry ?: return
    val repeating = first != null
    val digits = kind == "digits"
    val title = when {
      repeating -> if (digits) "Повтори код-пароль" else "Повтори пароль"
      change -> if (digits) "Введи новый код-пароль" else "Введи новый пароль"
      else -> if (digits) "Введи код-пароль" else "Введи пароль"
    }
    entry.setTitle(title, if (repeating) "Ещё раз, чтобы не ошибиться" else "Он будет запрашиваться при открытии Инвиза", error)
  }

  private fun take(code: String, change: Boolean) {
    LockRules.codeProblem(code, kind)?.let { problem ->
      error = problem
      entry?.shake()
      refreshSetup(change)
      return
    }
    // The first code is taken: a quiet clear for «Повтори», not the wrong-code shake.
    val firstCode = first
    if (firstCode == null) {
      error = ""
      first = code
      entry?.clearQuietly()
      // «Использовать пароль» goes away while repeating.
      fill()
      return
    }
    if (code != firstCode) {
      error = "Коды не совпадают. Попробуй ещё раз"
      first = null
      fill()
      entry?.shake()
      return
    }
    entry?.disabled = true
    if (LockStore.enable(code)) {
      performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
      endEditing()
      first = null
      error = ""
      phase = Phase.Settings
      fill()
    } else {
      error = "Не удалось сохранить код-пароль на устройстве"
      first = null
      fill()
      entry?.shake()
    }
  }

  // ---- The settings ----

  private fun fillSettings() {
    val settings = LockStore.current
    if (settings.record == null) {
      val enable = SettingsRow(context, symbol = "ion:keypad", label = "Включить код-пароль")
      enable.onPress = { kind = "digits"; first = null; error = ""; phase = Phase.Setup(change = false); fill() }
      addGroup(rows = listOf(enable))
      add(SettingsLook.foot(context, "Когда код-пароль включён, при открытии Инвиза показывается экран блокировки. Код хранится только на этом устройстве в виде хеша: сервер его не знает."), 8f)
      add(SettingsLook.foot(context, "Если ты забудешь код-пароль, придётся переустановить приложение (на компьютере — закрыть вкладку и войти снова)."), 8f)
      return
    }
    val off = SettingsRow(context, symbol = "ion:lock-open", label = "Выключить код-пароль", danger = true)
    off.onPress = { performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); LockStore.disable(); fill() }
    val change = SettingsRow(context, symbol = "ion:key", label = "Сменить код-пароль")
    change.onPress = { kind = "digits"; first = null; error = ""; phase = Phase.Setup(change = true); fill() }
    addGroup(rows = listOf(off, change))
    LockBiometrics.label(context)?.let { label ->
      val bio = SettingsSwitchRow(context, "Разблокировка " + label, "Открывать Инвиз без кода, когда система узнаёт тебя", settings.biometrics, enabled = !bioBusy)
      bio.onChange = { on -> toggleBiometrics(on) }
      addGroup(rows = listOf(bio))
    }
    val autolock = SettingsRow(context, symbol = "ion:timer", label = "Автоблокировка", value = LockRules.autolockLabels[settings.autolock] ?: "")
    autolock.onPress = { chooseAutolock() }
    addGroup(rows = listOf(autolock))
    add(SettingsLook.foot(context, "Код-пароль запрашивается, если приложение не открывали дольше выбранного времени. «Сразу» блокирует при каждом уходе из Инвиза."), 8f)
    add(SettingsLook.foot(context, "После пяти неверных попыток следующая разрешается с нарастающей задержкой."), 8f)
  }

  /** Turning the fingerprint on asks for it once, so the owner sees it works before relying on it. */
  private fun toggleBiometrics(on: Boolean) {
    if (bioBusy) return
    if (!on) { LockStore.update { it.copy(biometrics = false) }; return }
    val activity = context as? Activity ?: return fill()
    bioBusy = true
    LockBiometrics.authenticate(activity, "Подтверди, что это ты") { success ->
      bioBusy = false
      if (success) { performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); LockStore.update { it.copy(biometrics = true) } }
      fill()
    }
  }

  private fun chooseAutolock() {
    // The reference's Sheet «Автоблокировка»: a SheetAction per mode with `autolockIcon` (off «close-circle-outline»,
    // immediate «flash-outline», a time «time-outline»).
    val choices = LockRules.autolockModes.map { mode ->
      val symbol = if (mode == "off") "ion:close-circle-outline" else if (mode == "immediate") "ion:flash-outline" else "ion:time-outline"
      com.linea.messenger.chatactions.ChoiceSheet.Choice(symbol, LockRules.autolockLabels[mode] ?: mode) {
        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        LockStore.update { it.copy(autolock = mode) }
        fill()
      }
    }
    com.linea.messenger.chatactions.ChoiceSheet(context, "Автоблокировка", "«Выключена»: код запрашивается только при запуске приложения, а не при возвращении в него.", choices).show()
  }
}
