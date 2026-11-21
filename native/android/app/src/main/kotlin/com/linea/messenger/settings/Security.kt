package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.auth.AuthRules
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words

/** Parts one under another, `gap` dp between them. */
internal fun stacked(context: Context, parts: List<View>, gap: Float): LinearLayout = LinearLayout(context).apply {
  orientation = LinearLayout.VERTICAL
  parts.forEachIndexed { index, part ->
    addView(part, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = if (index == 0) 0 else context.px(gap) })
  }
}

/** An icon on a quiet round plate with words beside it. */
internal fun beside(context: Context, symbol: String, symbolSize: Float, plateSize: Float, texts: View, gap: Float): LinearLayout = LinearLayout(context).apply {
  orientation = LinearLayout.HORIZONTAL
  gravity = Gravity.CENTER_VERTICAL
  val icon = SymbolView(context, symbol, symbolSize, Theme.text)
  icon.plate = SettingsLook.chip
  addView(icon, LinearLayout.LayoutParams(context.px(plateSize), context.px(plateSize)).apply { rightMargin = context.px(gap) })
  addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
}

/** «Безопасность»: the password and the two secret words, and deleting the account.
 *  (The previous app: `mobile/src/SecurityScreen.tsx` and `AccountZone.tsx`; the sessions and the blocked people
 *  of that screen have their own pages here.) */
@SuppressLint("ViewConstructor")
class SecurityScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Безопасность") {
  private var status: Map<String, Any?>? = null
  private var loading = true
  private var failure = ""
  private var request = 0

  override fun build() {
    load()
  }

  private fun load() {
    request += 1
    val mine = request
    loading = true
    failure = ""
    fill()
    account.accountCall("security", emptyList()) { result ->
      if (mine != request) return@accountCall
      loading = false
      val body = result.getOrNull()
      if (body != null) {
        status = body
      } else {
        failure = if (result.refusalStatus == 404) "Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0."
          else result.failureWords("Не удалось загрузить настройки безопасности.")
        if (result.refusalStatus == 401) return@accountCall closeAccount(account.sessionEndedHere("Сессия завершилась. Войди в аккаунт снова."))
      }
      fill()
    }
  }

  private fun card(parts: List<View>): View = SettingsLook.inset(stacked(context, parts, 13f), top = 16f, side = 16f, bottom = 16f)

  /** The name of a secret word and whether it is set up. */
  private fun wordState(name: String, configured: Boolean): View = beside(context, if (configured) "check.circle" else "key", 22f, 42f, stacked(context, listOf(
    context.words(name, 15f, Theme.text, 700),
    context.words(if (configured) "Настроено" else "Пока не настроено", 12f, if (configured) Theme.text else Theme.muted),
  ), 4f), 11f)

  private fun fill() {
    clear()
    addGroup(rows = listOf(card(listOf(
      context.words("Твой доступ.\nТвои устройства.", 23f, Theme.text, 800),
      context.words("Вход по логину (тайному, не @имени), паролю и слову подтверждения. Для восстановления — другое слово. Почта и номер телефона не нужны.", 13f, Theme.muted),
    ))))
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = { load() }), 14f)
    if (loading && status == null) add(SettingsLook.foot(context, "Загружаем настройки…"), 16f)
    val status = status ?: return
    val confirmationConfigured = status["confirmationConfigured"] as? Boolean ?: false
    val recoveryConfigured = status["recoveryConfigured"] as? Boolean ?: false
    if (!confirmationConfigured || !recoveryConfigured) {
      add(SettingsNotice(context, "Заверши настройку двух слов. В старом аккаунте недостающие слова можно добавить, пока помнишь пароль."), 14f)
    }

    val password = SettingsButton(context, "Изменить пароль", SettingsButton.Kind.SECONDARY)
    password.onPress = { openForm(SecretChangeScreen.Form.PASSWORD, confirmationConfigured) }
    addGroup("Пароль", listOf(card(listOf(
      context.words("Можно использовать длинную фразу. После смены пароля все сеансы завершатся.", 13f, Theme.muted),
      password,
    ))))

    val confirmation = SettingsButton(context, if (confirmationConfigured) "Изменить слово подтверждения" else "Настроить слово подтверждения", SettingsButton.Kind.SECONDARY)
    confirmation.onPress = { openForm(SecretChangeScreen.Form.CONFIRMATION, confirmationConfigured) }
    addGroup("Подтверждение входа", listOf(card(listOf(
      wordState("Слово подтверждения", confirmationConfigured),
      context.words("Это слово нужно при каждом входе после пароля. Посмотреть его повторно нельзя.", 13f, Theme.muted),
      confirmation,
    ))))

    val limit = SettingsLook.inset(stacked(context, listOf(
      context.words("3 попытки → 24 часа ожидания", 12f, Theme.text, 700),
      context.words("Ограничение действует на сервере и относится только к восстановлению. Вход с паролем и словом подтверждения остаётся доступен.", 12f, Theme.muted),
    ), 5f), top = 13f, side = 13f, bottom = 13f)
    limit.background = context.plate(SettingsLook.chip, 14f)
    val recovery = SettingsButton(context, if (recoveryConfigured) "Изменить слово восстановления" else "Настроить слово восстановления", SettingsButton.Kind.SECONDARY)
    recovery.onPress = { openForm(SecretChangeScreen.Form.RECOVERY, confirmationConfigured) }
    addGroup("Восстановление доступа", listOf(card(listOf(
      wordState("Слово восстановления", recoveryConfigured),
      context.words(if (recoveryConfigured) "Отдельное слово для случая, когда пароль забыт. После его проверки действует 10-минутное ожидание. Открытые сеансы могут отменить запрос."
        else "Настрой слово сейчас, пока помнишь пароль. Без слова восстановления вернуть доступ через этот экран не получится.", 13f, Theme.muted),
      limit,
      recovery,
    ))))

    val remove = SettingsRow(context, symbol = "trash", label = "Удалить аккаунт", danger = true)
    remove.onPress = { open(DeleteAccountScreen(context, account, confirmationConfigured)) }
    addGroup(rows = listOf(remove))

    add(SettingsLook.foot(context, "Выбирай два разных непредсказуемых слова. Они должны отличаться друг от друга, логина и пароля. Все значения здесь вводятся вручную."), 16f)
  }

  private fun openForm(form: SecretChangeScreen.Form, confirmationConfigured: Boolean) {
    open(SecretChangeScreen(context, account, form, confirmationConfigured))
  }
}

/** Changing one of the three secrets: the password, the confirmation word, the recovery word. The current ones
 *  are asked first; after saving every device is signed out — this one too. */
@SuppressLint("ViewConstructor")
class SecretChangeScreen(context: Context, private val account: SettingsAccount, private val form: Form, private val confirmationConfigured: Boolean) : SettingsPage(context, when (form) {
  Form.PASSWORD -> "Изменить пароль"
  Form.CONFIRMATION -> "Слово подтверждения"
  Form.RECOVERY -> "Слово восстановления"
}) {
  enum class Form { PASSWORD, CONFIRMATION, RECOVERY }

  private var busy = false

  private val currentPassword = SettingsField(context, "Текущий пароль", "Пароль этого аккаунта", secret = true)
  private val currentWord = SettingsField(context, "Текущее слово подтверждения", "Слово, которое используешь при входе", secret = true)
  private val fresh = when (form) {
    Form.PASSWORD -> SettingsField(context, "Новый пароль", "От 10 до 128 символов", secret = true)
    Form.CONFIRMATION -> SettingsField(context, "Новое слово подтверждения", "Русские или английские буквы", secret = true)
    Form.RECOVERY -> SettingsField(context, "Новое слово восстановления", "Русские или английские буквы", secret = true)
  }
  private val again = when (form) {
    Form.PASSWORD -> SettingsField(context, "Повтори новый пароль", "Для проверки без опечаток", secret = true)
    else -> SettingsField(context, "Повтори новое слово", "Введи то же слово вручную", secret = true)
  }
  private val noticeBox = LinearLayout(context)
  private val saveButton = SettingsButton(context, "Сохранить изменения")

  override fun build() {
    add(SettingsLook.foot(context, "Подтверди текущие данные. После сохранения все устройства выйдут из аккаунта. Новое значение введи дважды вручную."), 4f)
    add(currentPassword, 16f)
    if (confirmationConfigured) add(currentWord, 14f)
    add(fresh, 14f)
    if (form != Form.PASSWORD) {
      add(SettingsLook.foot(context, "От 4 до 64 букв, без пробелов. Регистр не важен; «е» и «ё» различаются. Два слова должны отличаться друг от друга, логина и пароля."), 8f)
    }
    again.onReturn = { save() }
    add(again, 14f)
    noticeBox.orientation = LinearLayout.VERTICAL
    add(noticeBox, 14f)
    saveButton.onPress = { save() }
    add(saveButton, 14f)
    val cancel = context.words("Отмена", 13f, Theme.muted)
    cancel.gravity = Gravity.CENTER
    cancel.minHeight = dp(44f)
    cancel.isClickable = true
    cancel.isFocusable = true
    cancel.setOnClickListener { cancelPressed() }
    add(cancel, 4f)
  }

  private fun cancelPressed() {
    if (busy) return
    forgetSecrets()
    goBack()
  }

  override fun onDetachedFromWindow() {
    // What was typed does not wait on a screen that is no longer looked at.
    if (!busy) forgetSecrets()
    super.onDetachedFromWindow()
  }

  private fun forgetSecrets() {
    currentPassword.value = ""
    currentWord.value = ""
    fresh.value = ""
    again.value = ""
  }

  private fun showError(words: String) {
    noticeBox.removeAllViews()
    if (words.isNotEmpty()) {
      noticeBox.addView(SettingsNotice(context, words, error = true))
      announceForAccessibility(words)
    }
  }

  private fun setBusy(value: Boolean) {
    busy = value
    saveButton.setBusy(value)
    for (field in listOf(currentPassword, currentWord, fresh, again)) field.isEnabled = !value
  }

  private fun save() {
    if (busy) return
    val password = currentPassword.value
    val wordNow = currentWord.value
    if (password.isEmpty() || password.codePointCount(0, password.length) > 128) return showError("Введи текущий пароль.")
    if (confirmationConfigured && wordNow.trim().isEmpty()) return showError("Введи текущее слово подтверждения.")
    val typed = fresh.value
    val repeated = again.value
    val invalid = when (form) {
      Form.PASSWORD -> AuthRules.newPasswordError(typed)
      Form.CONFIRMATION -> AuthRules.wordError(typed, password = password)
      Form.RECOVERY -> AuthRules.wordError(typed, password = password, otherWord = wordNow)
    }
    if (invalid.isNotEmpty()) return showError(invalid)
    if (form == Form.PASSWORD) {
      if (typed != repeated) return showError("Новые пароли не совпадают.")
    } else if (AuthRules.word(typed) != AuthRules.word(repeated)) {
      return showError("Секретные слова не совпадают.")
    }
    val sentWord = AuthRules.word(wordNow)
    val operation: String
    val value: String
    val done: String
    when (form) {
      Form.PASSWORD -> {
        operation = "changePassword"
        value = typed
        done = "Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и словом подтверждения."
      }
      Form.CONFIRMATION -> {
        operation = "changeConfirmationWord"
        value = AuthRules.word(typed)
        done = "Слово подтверждения сохранено. Все устройства вышли из аккаунта. Используй новое слово при входе."
      }
      Form.RECOVERY -> {
        operation = "changeRecoveryWord"
        value = AuthRules.word(typed)
        done = "Слово восстановления сохранено. Все устройства вышли из аккаунта. Войди с паролем и словом подтверждения."
      }
    }
    endEditing()
    showError("")
    setBusy(true)
    account.accountCall(operation, listOf(password, value, sentWord)) { result ->
      if (result.isSuccess) {
        forgetSecrets()
        setBusy(false)
        closeAccount(account.sessionEndedHere(done))
      } else {
        setBusy(false)
        currentPassword.value = ""
        currentWord.value = ""
        showError(result.failureWords("Не удалось изменить настройки. Попробуй ещё раз."))
      }
    }
  }
}

/** «Удалить аккаунт»: for good, after the password and the confirmation word are typed once more.
 *  (The previous app: the sheet of `mobile/src/AccountZone.tsx`.)
 *  `confirmationConfigured`: whether the account has a confirmation word; null until the server said. */
@SuppressLint("ViewConstructor")
class DeleteAccountScreen(context: Context, private val account: SettingsAccount, private var confirmationConfigured: Boolean? = null) : SettingsPage(context, "Удалить аккаунт") {
  private var busy = false
  private var loadFailure = ""
  private val password = SettingsField(context, "Пароль", "Пароль этого аккаунта", secret = true)
  private val word = SettingsField(context, "Слово подтверждения", "Слово для входа", secret = true)
  private val noticeBox = LinearLayout(context)
  private val removeButton = SettingsButton(context, "Удалить навсегда", SettingsButton.Kind.DANGER)

  override fun build() {
    noticeBox.orientation = LinearLayout.VERTICAL
    removeButton.onPress = { remove() }
    fill()
    if (confirmationConfigured == null) load()
  }

  private fun load() {
    loadFailure = ""
    fill()
    account.accountCall("security", emptyList()) { result ->
      val body = result.getOrNull()
      if (body != null) confirmationConfigured = body["confirmationConfigured"] as? Boolean ?: false
      else loadFailure = result.failureWords("Не удалось загрузить настройки безопасности.")
      fill()
    }
  }

  private fun fill() {
    clear()
    add(SettingsLook.inset(context.words("Удалить аккаунт навсегда?", 20f, Theme.text, 700), side = 2f), 4f)
    add(SettingsLook.inset(context.words("Удалятся профиль, все личные чаты (у собеседников тоже), файлы, каналы и серверы, где ты владелец, твои сообщения в чужих каналах и устройства. Вернуть будет нельзя. Подписку Platina это не отменяет, если она оплачена через магазин приложений.", 13f, Theme.muted), side = 2f), 8f)
    val configured = confirmationConfigured
    if (configured == null) {
      if (loadFailure.isEmpty()) add(SettingsLook.foot(context, "Загрузка…"), 16f)
      else add(SettingsNotice(context, loadFailure, error = true, onRetry = { load() }), 16f)
      return
    }
    add(password, 16f)
    if (configured) add(word, 14f)
    add(noticeBox, 14f)
    add(removeButton, 14f)
  }

  override fun onDetachedFromWindow() {
    if (!busy) {
      password.value = ""
      word.value = ""
    }
    super.onDetachedFromWindow()
  }

  private fun showError(words: String) {
    noticeBox.removeAllViews()
    if (words.isNotEmpty()) noticeBox.addView(SettingsNotice(context, words, error = true))
  }

  private fun setBusy(value: Boolean) {
    busy = value
    removeButton.setBusy(value)
    password.isEnabled = !value
    word.isEnabled = !value
  }

  private fun remove() {
    val configured = confirmationConfigured
    if (busy || configured == null) return
    val typed = password.value
    val typedWord = word.value.trim()
    if (typed.isEmpty()) return showError("Введи пароль.")
    if (configured && typedWord.isEmpty()) return showError("Введи слово подтверждения.")
    endEditing()
    showError("")
    setBusy(true)
    account.accountCall("deleteAccount", listOf(typed, if (configured) typedWord else "")) { result ->
      setBusy(false)
      if (result.isSuccess) {
        password.value = ""
        word.value = ""
        closeAccount(account.sessionEndedHere("Аккаунт удалён."))
      } else {
        showError(result.failureWords("Не удалось удалить аккаунт."))
      }
    }
  }
}
