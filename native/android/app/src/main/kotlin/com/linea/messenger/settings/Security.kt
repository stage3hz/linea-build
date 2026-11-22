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

/** An icon in the accent on a square of `accentSoft` (radius 16; 18 for the 48 one of a session's sheet), words beside
 *  it — the reference's SecurityScreen.tsx. */
internal fun beside(context: Context, symbol: String, symbolSize: Float, plateSize: Float, texts: View, gap: Float): LinearLayout = LinearLayout(context).apply {
  orientation = LinearLayout.HORIZONTAL
  gravity = Gravity.CENTER_VERTICAL
  val icon = android.widget.FrameLayout(context).apply { background = context.plate(ThemeStore.look.accentSoft, if (plateSize >= 48f) 18f else 16f) }
  icon.addView(SymbolView(context, symbol, symbolSize, Theme.accent), android.widget.FrameLayout.LayoutParams(context.px(symbolSize), context.px(symbolSize), Gravity.CENTER))
  addView(icon, LinearLayout.LayoutParams(context.px(plateSize), context.px(plateSize)).apply { rightMargin = context.px(gap) })
  addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
}

/** «Безопасность и устройства» — the reference's SecurityScreen.tsx with its HistorySection and AccountZone.tsx, on one
 *  page: the header pill (clear glass, radius 27, the shield at the right), the intro card, the password and the two
 *  secret words, the sessions and devices, the chats on a new device, the blocked people and «Удалить аккаунт», each on a
 *  glass card of radius 28. */
@SuppressLint("ViewConstructor")
class SecurityScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Безопасность") {
  private var status: Map<String, Any?>? = null
  private var loading = true
  private var failure = ""
  private var notice = ""
  private var request = 0
  private var sessions: List<Map<String, Any?>> = emptyList()
  private var busy = false
  private var blocked: List<Map<String, Any?>>? = null
  private var unblocking = ""

  // `marginHorizontal: 14`, `padding: 10`, `minHeight: 68`, the name 20 Bold with letter spacing −0.5, the
  // shield-checkmark-outline 23 in the accent with 10 to its right; the list 17 from the sides, 17 under the pill's 2.
  override val ownLook: OwnLook? get() = OwnLook(side = 14f, padding = 10f, minHeight = 68f, clear = true, titleSize = 20f, titleWeight = 700, titleKern = -0.5f,
    mark = "shield-checkmark-outline", markSize = 23f, markRoom = 10f, backLabel = "Назад в профиль", columnSide = 17f, columnTop = 17f, columnBottom = 36f)

  override fun build() {
    account.prepareSettingsAvatars()
    load()
    loadBlocked()
  }

  private fun load() {
    request += 1
    val mine = request
    loading = true
    failure = ""
    fill()
    var security: Result<Map<String, Any?>>? = null
    var list: Result<Map<String, Any?>>? = null
    fun both() {
      val first = security ?: return
      val second = list ?: return
      if (mine != request) return
      loading = false
      val body = first.getOrNull(); val found = second.getOrNull()
      if (body != null && found != null) {
        status = body
        sessions = SessionWords.ordered((found["sessions"] as? List<*>).orEmpty().mapNotNull { com.linea.messenger.core.Core.map(it) })
      } else {
        val bad = if (body == null) first else second
        if (bad.refusalStatus == 401) return closeAccount(account.sessionEndedHere("Сессия завершилась. Войди в аккаунт снова."))
        failure = if (bad.refusalStatus == 404) "Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0."
          else bad.failureWords("Не удалось загрузить настройки безопасности.")
      }
      fill()
    }
    account.accountCall("security", emptyList()) { result -> security = result; both() }
    account.accountCall("sessions", emptyList()) { result -> list = result; both() }
  }

  private fun loadBlocked() {
    account.accountCall("blocks", emptyList()) { result ->
      blocked = (result.getOrNull()?.get("users") as? List<*>).orEmpty().mapNotNull { com.linea.messenger.core.Core.map(it) }
      if (built) fill()
    }
  }

  /** The name of a secret word and whether it is set up (a 42 square of `accentSoft`, the glyph 25, 11 to the words). */
  private fun wordState(name: String, configured: Boolean): View = beside(context, if (configured) "ion:checkmark-circle-outline" else "ion:key-outline", 25f, 42f, stacked(context, listOf(
    context.words(name, 15f, Theme.text, 700),
    context.words(if (configured) "Настроено" else "Пока не настроено", 12f, if (configured) Theme.accent else Theme.muted),
  ), 4f), 11f)

  private fun spinner(): View = android.widget.ProgressBar(context).apply {
    isIndeterminate = true
    indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent)
  }

  private fun fill() {
    clear()
    add(SettingsLook.glassCard(context, listOf(
      SettingsLook.para(context, "Твой доступ.\nТвои устройства.", 23f, Theme.text, 800, line = 28f, kern = -0.7f),
      SettingsLook.para(context, "Вход по логину (тайному, не @имени), паролю и слову подтверждения. Для восстановления — другое слово. Почта и номер телефона не нужны.", 13f, Theme.muted, line = 20f),
    ), padding = 22f, gap = 11f, clear = true), 0f)
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = { if (!busy) load() }), 16f)
    if (notice.isNotEmpty()) add(SettingsNotice(context, notice), 16f)
    if (loading && status == null) {
      // `padding: 30`, the spinner and «Загружаем настройки…» (13, `muted`) 12 apart, centred.
      val box = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(context.px(30f), context.px(30f), context.px(30f), context.px(30f)) }
      box.addView(spinner(), LinearLayout.LayoutParams(context.px(20f), context.px(20f)))
      box.addView(context.words("Загружаем настройки…", 13f, Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(12f) })
      add(box, 16f)
    }
    status?.let { fillStatus(it) }
    // The closing words: 11, line 17, `subtle`, centred, 10 in from the sides.
    add(SettingsLook.inset(SettingsLook.para(context, "Выбирай два разных непредсказуемых слова. Они должны отличаться друг от друга, логина и пароля. Все значения здесь вводятся вручную.", 11f, Theme.subtle, line = 17f, centered = true), side = 10f), 16f)
  }

  private fun fillStatus(status: Map<String, Any?>) {
    val confirmationConfigured = status["confirmationConfigured"] as? Boolean ?: false
    val recoveryConfigured = status["recoveryConfigured"] as? Boolean ?: false
    if (!confirmationConfigured || !recoveryConfigured) {
      add(SettingsNotice(context, "Заверши настройку двух слов. В старом аккаунте недостающие слова можно добавить, пока помнишь пароль."), 16f)
    }

    // «Пароль»: padding 20, gap 16; lock-closed-outline 23 in the accent beside the words, 12 apart.
    val passwordLine = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      addView(SymbolView(context, "ion:lock-closed-outline", 23f, Theme.accent), LinearLayout.LayoutParams(context.px(23f), context.px(23f)).apply { rightMargin = context.px(12f) })
      addView(SettingsLook.para(context, "Можно использовать длинную фразу. После смены пароля все сеансы завершатся.", 13f, Theme.muted, line = 20f), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    }
    val password = SettingsButton(context, "Изменить пароль", SettingsButton.Kind.SECONDARY, icon = "key-outline")
    password.isEnabled = !busy
    password.onPress = { openForm(SecretChangeScreen.Form.PASSWORD, confirmationConfigured) }
    add(SettingsLook.glassCard(context, listOf(SettingsLook.sectionLabel(context, "Пароль"), passwordLine, password), gap = 16f, labelled = true), 16f)

    val confirmation = SettingsButton(context, if (confirmationConfigured) "Изменить слово подтверждения" else "Настроить слово подтверждения", SettingsButton.Kind.SECONDARY, icon = "key-outline")
    confirmation.isEnabled = !busy
    confirmation.onPress = { openForm(SecretChangeScreen.Form.CONFIRMATION, confirmationConfigured) }
    add(SettingsLook.glassCard(context, listOf(
      SettingsLook.sectionLabel(context, "Подтверждение входа"),
      wordState("Слово подтверждения", confirmationConfigured),
      SettingsLook.para(context, "Это слово нужно при каждом входе после пароля. Посмотреть его повторно нельзя.", 13f, Theme.muted, line = 20f),
      confirmation,
    ), labelled = true), 16f)

    // The limit: radius 17, padding 13, gap 5, `accentSoft`.
    val limit = SettingsLook.inset(stacked(context, listOf(
      context.words("3 попытки → 24 часа ожидания", 12f, Theme.text, 700),
      SettingsLook.para(context, "Ограничение действует на сервере и относится только к восстановлению. Вход с паролем и словом подтверждения остаётся доступен.", 12f, Theme.muted, line = 18f),
    ), 5f), top = 13f, side = 13f, bottom = 13f)
    limit.background = context.plate(ThemeStore.look.accentSoft, 17f)
    val recovery = SettingsButton(context, if (recoveryConfigured) "Изменить слово восстановления" else "Настроить слово восстановления", SettingsButton.Kind.SECONDARY, icon = "key-outline")
    recovery.isEnabled = !busy
    recovery.onPress = { openForm(SecretChangeScreen.Form.RECOVERY, confirmationConfigured) }
    add(SettingsLook.glassCard(context, listOf(
      SettingsLook.sectionLabel(context, "Восстановление доступа"),
      wordState("Слово восстановления", recoveryConfigured),
      SettingsLook.para(context, if (recoveryConfigured) "Отдельное слово для случая, когда пароль забыт. После его проверки действует 10-минутное ожидание. Открытые сеансы могут отменить запрос."
        else "Настрой слово сейчас, пока помнишь пароль. Без слова восстановления вернуть доступ через этот экран не получится.", 13f, Theme.muted, line = 20f),
      limit,
      recovery,
    ), labelled = true), 16f)

    add(sessionsCard(), 16f)
    // HistorySection.tsx stands here (between the sessions and AccountZone): its own page in this app
    // (settings/HistorySettings.kt), reached from a card with the reference's section name.
    val history = SettingsRow(context, symbol = "ion:cloud-download-outline", label = "Переписки на новом устройстве")
    history.onPress = { account.messenger?.let { open(HistoryScreen(context, it)) } }
    add(SettingsLook.glassCard(context, listOf(SettingsLook.inset(SettingsLook.sectionLabel(context, "Переписки на новом устройстве"), top = 14f, side = 14f), history), padding = 6f, gap = 13f), 16f)
    add(blockedCard(), 16f)
    add(deleteCard(confirmationConfigured), 16f)
  }

  // «Сеансы и устройства»

  private fun sessionsCard(): View {
    // The label keeps its 13 of margin under it inside the row (as tall as the 44 refresh button, centred), 8 apart.
    val head = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    head.addView(SettingsLook.inset(SettingsLook.sectionLabel(context, "Сеансы и устройства"), bottom = 13f), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    val refresh = com.linea.messenger.design.GlassRoundButton(context, "ion:refresh-outline", "Обновить список сеансов", 19f)
    refresh.isEnabled = !busy && !loading
    refresh.onPress = { if (!busy && !loading) load() }
    head.addView(refresh, LinearLayout.LayoutParams(context.px(44f), context.px(44f)).apply { leftMargin = context.px(8f) })
    val parts = ArrayList<View>()
    parts.add(head)
    parts.add(SettingsLook.para(context, "Здесь показаны действующие входы: устройство, система, версия приложения и IP-адрес, с которого выполнен вход. Нажми на сеанс, чтобы увидеть подробности или завершить его.", 12f, Theme.muted, line = 18f))
    val (current, others) = sessions.partition { SessionWords.isCurrent(it) }
    for (session in current) parts.add(row(session, first = true))
    // «Завершить все другие сеансы» sits between this device and the other sessions.
    val endOthers = SettingsButton(context, "Завершить все другие сеансы", SettingsButton.Kind.DANGER, icon = "log-out-outline")
    endOthers.isEnabled = !busy && others.isNotEmpty()
    endOthers.onPress = { askToEndOthers() }
    parts.add(endOthers)
    var otherLabel: View? = null
    if (others.isNotEmpty()) { otherLabel = SettingsLook.sectionLabel(context, "Другие устройства"); parts.add(otherLabel) }
    others.forEachIndexed { index, session -> parts.add(row(session, first = index == 0)) }
    if (sessions.isEmpty() && !loading) parts.add(context.words("Действующие сеансы не найдены.", 13f, Theme.muted))
    if (loading && status != null) parts.add(spinner())
    parts.add(SettingsLook.para(context, "Если ты видишь вход, которого не делал, заверши его и смени пароль. IP-адрес показан как есть, местоположение по нему не определяется.", 11f, Theme.subtle, line = 16f))
    val card = SettingsLook.glassCard(context, parts)
    // «Другие устройства» (a SectionLabel) keeps its 13 of margin under it on top of the card's gap.
    otherLabel?.let { label ->
      val index = card.indexOfChild(label)
      if (index >= 0 && index + 1 < card.childCount) (card.getChildAt(index + 1).layoutParams as? LinearLayout.LayoutParams)?.let { it.topMargin += context.px(13f) }
    }
    return card
  }

  private fun row(session: Map<String, Any?>, first: Boolean): View {
    val current = SessionWords.isCurrent(session)
    val made = SessionRow(context, session, plain = true, first = first)
    made.isEnabled = !busy
    made.contentDescription = "Сеанс: " + SessionWords.loginLabel(session) + (if (current) ", это устройство" else "") + ". Подробности"
    made.onPress = { open(SessionDetailScreen(context, session) { detail -> end(session, detail) }) }
    return made
  }

  private fun askToEndOthers() {
    if (busy) return
    confirm("Завершить все другие сеансы?", "Этот сеанс останется открытым. На остальных устройствах понадобится снова ввести логин, пароль и слово подтверждения.", "Завершить") { endOthers() }
  }

  private fun endOthers() {
    if (busy) return
    busy = true; failure = ""; notice = ""
    fill()
    account.accountCall("revokeOtherSessions", emptyList()) { result ->
      busy = false
      if (result.isSuccess) { notice = "Все другие сеансы завершены."; load() }
      else { failure = result.failureWords("Не удалось завершить сеанс."); fill() }
    }
  }

  /** Ends one session, asked from its page of details. */
  private fun end(session: Map<String, Any?>, detail: SessionDetailScreen) {
    val id = session["id"] as? String
    if (busy || id == null) return
    val current = SessionWords.isCurrent(session)
    busy = true; failure = ""; notice = ""
    detail.setBusy(true)
    account.accountCall("revokeSession", listOf(id)) { result ->
      busy = false
      detail.setBusy(false)
      if (result.isSuccess) {
        if (current) return@accountCall closeAccount(account.sessionEndedHere("Сеанс на этом устройстве завершён. Войди снова, чтобы продолжить."))
        notice = "Выбранный сеанс завершён."
        detail.goBack()
        load()
      } else {
        failure = result.failureWords("Не удалось завершить сеанс.")
        detail.goBack()
        fill()
      }
    }
  }

  // AccountZone.tsx — «Заблокированные» and «Удалить аккаунт»

  private fun blockedCard(): View {
    val parts = ArrayList<View>()
    parts.add(SettingsLook.sectionLabel(context, "Заблокированные"))
    val people = blocked
    when {
      people == null -> parts.add(spinner())
      people.isEmpty() -> parts.add(context.words("Никого нет. Заблокировать можно в профиле собеседника через «⋯».", 13f, Theme.muted))
      else -> for (user in people) parts.add(person(user))
    }
    return SettingsLook.glassCard(context, parts, gap = 12f, labelled = true)
  }

  /** One blocked person: the avatar 40, 12 to the name (15 SemiBold) and @username (12, `muted`), «Разблокировать» (14
   *  SemiBold, the accent) at the right. */
  private fun person(user: Map<String, Any?>): View {
    val id = user["id"] as? String ?: ""
    val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    val ball = SettingsAvatar(context)
    ball.show(user, account.base)
    row.addView(ball, LinearLayout.LayoutParams(context.px(40f), context.px(40f)).apply { rightMargin = context.px(12f) })
    val name = context.words(user["displayName"] as? String ?: "", 15f, Theme.text, 600).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
    val handle = context.words("@" + (user["username"] as? String ?: ""), 12f, Theme.muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
    row.addView(stacked(context, listOf(name, handle), 0f), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    val free = context.words("Разблокировать", 14f, Theme.accent, 600)
    free.isEnabled = unblocking.isEmpty()
    free.isClickable = true
    free.isFocusable = true
    free.setOnClickListener { unblock(id) }
    row.addView(free, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(12f) })
    return row
  }

  private fun unblock(id: String) {
    if (unblocking.isNotEmpty() || id.isEmpty()) return
    unblocking = id
    account.accountCall("unblock", listOf(id)) { result ->
      unblocking = ""
      // The reference: on a failure the row stays.
      if (result.isSuccess) blocked = blocked.orEmpty().filter { it["id"] as? String != id }
      fill()
    }
  }

  /** «Удалить аккаунт»: a card (padding 6) holding one row — padding 14, radius 22, `dangerBg` under the finger,
   *  trash-outline 20 and the words (15 SemiBold) in `danger`, 12 apart. */
  private fun deleteCard(confirmationConfigured: Boolean): View {
    val row = object : LinearLayout(context) {
      override fun setPressed(pressed: Boolean) {
        super.setPressed(pressed)
        background = if (pressed) context.plate(ThemeStore.look.dangerBg, 22f) else null
      }
    }
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(context.px(14f), context.px(14f), context.px(14f), context.px(14f))
    row.addView(SymbolView(context, "ion:trash-outline", 20f, Theme.danger), LinearLayout.LayoutParams(context.px(20f), context.px(20f)).apply { rightMargin = context.px(12f) })
    row.addView(context.words("Удалить аккаунт", 15f, Theme.danger, 600))
    row.isClickable = true
    row.isFocusable = true
    row.contentDescription = "Удалить аккаунт"
    row.setOnClickListener { open(DeleteAccountScreen(context, account, confirmationConfigured)) }
    return SettingsLook.glassCard(context, listOf(row), padding = 6f, gap = 0f)
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
  private val removeButton = SettingsButton(context, "Удалить навсегда", SettingsButton.Kind.DANGER, icon = "trash-outline")

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
