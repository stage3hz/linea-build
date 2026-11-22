package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.text.TextUtils
import android.view.Gravity
import android.widget.FrameLayout
import com.linea.messenger.design.plate
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import java.util.Locale

/** What a session of the list says about itself, in the words of `mobile/src/SecurityScreen.tsx` and
 *  `mobile/src/sessionAlerts.ts`. */
object SessionWords {
  private fun text(session: Map<String, Any?>, name: String): String = session[name] as? String ?: ""

  fun isCurrent(session: Map<String, Any?>): Boolean = session["isCurrent"] as? Boolean ?: false

  /** The model, else the name the app gave the device; `otherwise` when the server has neither. */
  fun name(session: Map<String, Any?>, otherwise: String): String = text(session, "deviceModel").ifEmpty { text(session, "deviceName").ifEmpty { otherwise } }

  /** «iPhone · iOS 18.1»: one line for a question about the session. */
  fun loginLabel(session: Map<String, Any?>): String {
    val device = name(session, "Неизвестное устройство")
    val system = text(session, "osVersion")
    return if (system.isEmpty()) device else "$device · $system"
  }

  /** «iOS 18.1 · Инвиз 0.14.13», without the parts the server has no data for. */
  fun subtitle(session: Map<String, Any?>): String {
    val parts = ArrayList<String>()
    text(session, "osVersion").takeIf { it.isNotEmpty() }?.let { parts.add(it) }
    text(session, "appVersion").takeIf { it.isNotEmpty() }?.let { parts.add("Инвиз $it") }
    return parts.joinToString(" · ")
  }

  private fun mentions(words: String, needles: List<String>): Boolean = words.lowercase(Locale.ROOT).let { low -> needles.any { low.contains(it) } }

  /** The picture of the device's kind: the reference's `deviceIcon` (SecurityScreen.tsx) — Ionicons names with "ion:". */
  fun symbol(session: Map<String, Any?>): String {
    val platform = text(session, "platform")
    if (platform == "ios" || platform == "android") return if (mentions(text(session, "deviceModel"), listOf("ipad", "tablet"))) "ion:tablet-portrait-outline" else "ion:phone-portrait-outline"
    if (platform == "web") return "ion:globe-outline"
    if (platform == "windows") return "ion:desktop-outline"
    return if (mentions(text(session, "deviceName"), listOf("android", "iphone", "ipad", "ios", "pixel", "galaxy"))) "ion:phone-portrait-outline" else "ion:desktop-outline"
  }

  /** This device first, then the newest sign-ins. */
  fun ordered(sessions: List<Map<String, Any?>>): List<Map<String, Any?>> {
    fun time(session: Map<String, Any?>): Long = Messenger.date(session["createdAt"] as? String)?.toEpochMilli() ?: 0L
    val (current, others) = sessions.partition { isCurrent(it) }
    return current.sortedByDescending { time(it) } + others.sortedByDescending { time(it) }
  }

  fun address(session: Map<String, Any?>): String = text(session, "ip")
}

/** «Активные сеансы»: where the account is signed in, with the way to end one session or all the others. */
@SuppressLint("ViewConstructor")
class SessionsScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Активные сеансы") {
  private var sessions: List<Map<String, Any?>> = emptyList()
  private var loaded = false
  private var loading = false
  private var busy = false
  private var failure = ""
  private var notice = ""
  private var request = 0
  /** For the emulator check: the details of the first session open by themselves once the list is here. */
  var opensFirstWhenLoaded = false

  override fun build() {
    setSide("ion:refresh-outline", "Обновить список сеансов") { if (!busy && !loading) refresh() }
    refresh()
  }

  private fun refresh() {
    request += 1
    val mine = request
    loading = true
    failure = ""
    fill()
    account.accountCall("sessions", emptyList()) { result ->
      if (mine != request) return@accountCall
      loading = false
      val body = result.getOrNull()
      if (body != null) {
        sessions = SessionWords.ordered((body["sessions"] as? List<*>).orEmpty().mapNotNull { Core.map(it) })
        loaded = true
      } else {
        if (result.refusalStatus == 401) return@accountCall closeAccount(account.sessionEndedHere("Сессия завершилась. Войди в аккаунт снова."))
        failure = if (result.refusalStatus == 404) "Сервер ещё не поддерживает настройки безопасности. Обнови сервер Инвиза до версии 0.3.0."
          else result.failureWords("Не удалось загрузить настройки безопасности.")
      }
      fill()
      val first = sessions.firstOrNull()
      if (opensFirstWhenLoaded && first != null) {
        opensFirstWhenLoaded = false
        showDetails(first, animated = false)
      }
    }
  }

  private fun fill() {
    clear()
    setSideEnabled(!busy && !loading)
    add(SettingsLook.foot(context, "Здесь показаны действующие входы: устройство, система, версия приложения и IP-адрес, с которого выполнен вход. Нажми на сеанс, чтобы увидеть подробности или завершить его."), 4f)
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = { refresh() }), 12f)
    if (notice.isNotEmpty()) add(SettingsNotice(context, notice), 12f)
    if (!loaded) {
      if (loading) add(SettingsLook.foot(context, "Загружаем настройки…"), 16f)
      return
    }
    val (current, others) = sessions.partition { SessionWords.isCurrent(it) }
    if (current.isNotEmpty()) addGroup(rows = current.map { row(it) })

    // «Завершить все другие сеансы» sits between this device and the other sessions.
    val endOthers = SettingsButton(context, "Завершить все другие сеансы", SettingsButton.Kind.DANGER, icon = "log-out-outline")
    endOthers.isEnabled = !busy && others.isNotEmpty()
    endOthers.onPress = { askToEndOthers() }
    add(endOthers, 14f)

    if (others.isNotEmpty()) addGroup("Другие устройства", others.map { row(it) })
    if (sessions.isEmpty() && !loading) add(SettingsLook.foot(context, "Действующие сеансы не найдены."), 14f)
    add(SettingsLook.foot(context, "Если ты видишь вход, которого не делал, заверши его и смени пароль. IP-адрес показан как есть, местоположение по нему не определяется."), 16f)
  }

  private fun row(session: Map<String, Any?>): View {
    val current = SessionWords.isCurrent(session)
    val made = SessionRow(context, session)
    made.isEnabled = !busy
    made.contentDescription = "Сеанс: " + SessionWords.loginLabel(session) + (if (current) ", это устройство" else "") + ". Подробности"
    made.onPress = { showDetails(session, animated = true) }
    return made
  }

  private fun showDetails(session: Map<String, Any?>, animated: Boolean) {
    open(SessionDetailScreen(context, session) { detail -> end(session, detail) }, animated)
  }

  private fun askToEndOthers() {
    if (busy) return
    confirm("Завершить все другие сеансы?", "Этот сеанс останется открытым. На остальных устройствах понадобится снова ввести логин, пароль и слово подтверждения.", "Завершить") { endOthers() }
  }

  private fun endOthers() {
    if (busy) return
    busy = true
    failure = ""
    notice = ""
    fill()
    account.accountCall("revokeOtherSessions", emptyList()) { result ->
      busy = false
      if (result.isSuccess) {
        notice = "Все другие сеансы завершены."
        refresh()
      } else {
        failure = result.failureWords("Не удалось завершить сеанс.")
        fill()
      }
    }
  }

  /** Ends one session, asked from its page of details. */
  private fun end(session: Map<String, Any?>, detail: SessionDetailScreen) {
    val id = session["id"] as? String
    if (busy || id == null) return
    val current = SessionWords.isCurrent(session)
    busy = true
    failure = ""
    notice = ""
    detail.setBusy(true)
    account.accountCall("revokeSession", listOf(id)) { result ->
      busy = false
      detail.setBusy(false)
      if (result.isSuccess) {
        if (current) return@accountCall closeAccount(account.sessionEndedHere("Сеанс на этом устройстве завершён. Войди снова, чтобы продолжить."))
        notice = "Выбранный сеанс завершён."
        detail.goBack()
        refresh()
      } else {
        failure = result.failureWords("Не удалось завершить сеанс.")
        detail.goBack()
        fill()
      }
    }
  }
}

/** One session in the list: the device's icon, its model, the system and the app's version, the address and the
 *  last activity. */
@SuppressLint("ViewConstructor")
class SessionRow(context: Context, session: Map<String, Any?>) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), context.px(13f), context.px(14f), context.px(13f))
    val current = SessionWords.isCurrent(session)
    // The reference's `SessionRow`: a 42 square of `accentSoft`, radius 16, the glyph 23 in the accent.
    val icon = FrameLayout(context).apply { background = context.plate(ThemeStore.look.accentSoft, 16f) }
    icon.addView(SymbolView(context, SessionWords.symbol(session), 23f, Theme.accent), FrameLayout.LayoutParams(context.px(23f), context.px(23f), Gravity.CENTER))
    addView(icon, LayoutParams(context.px(42f), context.px(42f)).apply { rightMargin = context.px(12f) })

    val name = context.words(SessionWords.name(session, "Устройство"), 14f, Theme.text, 700)
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    val top = LinearLayout(context)
    top.orientation = HORIZONTAL
    top.gravity = Gravity.CENTER_VERTICAL
    // The name gives way to the mark: it is cut short, the mark is not.
    top.addView(name, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    if (current) top.addView(SettingsSwitchRow.paddedLabel(context, "Это устройство", 10f).apply { setTextColor(Theme.accent); background = context.plate(ThemeStore.look.accentSoft, 8f) }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(8f) })

    val lines = ArrayList<View>()
    lines.add(top)
    val subtitle = SessionWords.subtitle(session)
    if (subtitle.isNotEmpty()) lines.add(context.words(subtitle, 12f, Theme.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    val address = SessionWords.address(session)
    val seen = if (current) "в сети" else SettingsLook.moment(session["lastActiveAt"] as? String)
    lines.add(context.words((if (address.isEmpty()) "" else "$address · ") + seen, 11f, Theme.subtle).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    addView(stacked(context, lines, 3f), LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    addView(SymbolView(context, "ion:chevron-forward", 18f, Theme.subtle), LayoutParams(context.px(18f), context.px(18f)).apply { leftMargin = context.px(12f) })
    isClickable = true
    isFocusable = true
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    setBackgroundColor(if (pressed) SettingsLook.pressed else 0)
  }

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    alpha = if (enabled) 1f else 0.5f
  }
}

/** The details of one session, and the button that ends it. */
@SuppressLint("ViewConstructor")
class SessionDetailScreen(context: Context, private val session: Map<String, Any?>, private val onEnd: (SessionDetailScreen) -> Unit) :
  SettingsPage(context, if (SessionWords.isCurrent(session)) "Это устройство" else "Сеанс") {
  private val endButton = SettingsButton(context, if (SessionWords.isCurrent(session)) "Выйти на этом устройстве" else "Завершить сеанс", SettingsButton.Kind.DANGER, icon = "log-out-outline")

  fun setBusy(busy: Boolean) {
    endButton.setBusy(busy)
  }

  private fun detail(label: String, value: String): View {
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.addView(context.words(label, 13f, Theme.muted), LinearLayout.LayoutParams(dp(132f), LinearLayout.LayoutParams.WRAP_CONTENT))
    row.addView(context.words(value, 13f, Theme.text), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12f) })
    row.contentDescription = "$label: $value"
    row.isFocusable = true
    return SettingsLook.inset(row, top = 10f, side = 14f, bottom = 10f)
  }

  override fun build() {
    val current = SessionWords.isCurrent(session)
    val head = beside(context, SessionWords.symbol(session), 26f, 48f, stacked(context, listOf(
      context.words(SessionWords.name(session, "Устройство"), 17f, Theme.text, 800),
      context.words(if (current) "Текущий сеанс на этом устройстве" else "Действующий сеанс на другом устройстве", 12f, Theme.muted),
    ), 3f), 12f)
    add(SettingsLook.inset(head, top = 4f, side = 2f), 4f)

    val app = session["appVersion"] as? String ?: ""
    val system = session["osVersion"] as? String ?: ""
    val address = SessionWords.address(session)
    addGroup(rows = listOf(
      detail("Устройство", SessionWords.name(session, "—")),
      detail("Система", system.ifEmpty { "—" }),
      detail("Приложение", if (app.isEmpty()) "—" else "Инвиз $app"),
      detail("IP-адрес", address.ifEmpty { "—" }),
      detail("Первый вход", SettingsLook.moment(session["createdAt"] as? String)),
      detail("Последняя активность", if (current) "Сейчас" else SettingsLook.moment(session["lastActiveAt"] as? String)),
      detail("Действует до", SettingsLook.moment(session["expiresAt"] as? String)),
    ))
    add(SettingsLook.foot(context, if (current) "Выход завершит сеанс на этом устройстве. Переписка останется на сервере."
      else "После завершения на том устройстве понадобится снова ввести логин, пароль и слово подтверждения. Название и версии сообщает само приложение; IP-адрес показан как есть."), 12f)
    endButton.onPress = { onEnd(this) }
    add(endButton, 18f)
  }
}

/** «Заблокированные»: the people who cannot write to the account, with the way to let one back.
 *  (The previous app: the first card of `mobile/src/AccountZone.tsx`.) */
@SuppressLint("ViewConstructor")
class BlockedScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Заблокированные") {
  private var people: List<Map<String, Any?>>? = null
  private var failure = ""
  private var busyId = ""

  override fun build() {
    account.prepareSettingsAvatars()
    load()
  }

  private fun load() {
    failure = ""
    fill()
    account.accountCall("blocks", emptyList()) { result ->
      val body = result.getOrNull()
      if (body != null) people = (body["users"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      else failure = result.failureWords("Не удалось загрузить список.")
      fill()
    }
  }

  private fun fill() {
    clear()
    val people = people
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = if (people == null) ({ load() }) else null), 4f)
    if (people == null) {
      if (failure.isEmpty()) add(SettingsLook.foot(context, "Загрузка…"), 16f)
      return
    }
    if (people.isEmpty()) {
      add(SettingsLook.foot(context, "Никого нет. Заблокировать можно в профиле собеседника через «⋯»."), 16f)
      return
    }
    addGroup(rows = people.map { person(it) })
  }

  private fun person(user: Map<String, Any?>): View {
    val id = user["id"] as? String ?: ""
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    val ball = SettingsAvatar(context)
    ball.show(user, account.base)
    row.addView(ball, LinearLayout.LayoutParams(dp(40f), dp(40f)).apply { rightMargin = dp(12f) })
    val name = context.words(user["displayName"] as? String ?: "", 15f, Theme.text, 600).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
    val handle = context.words("@" + (user["username"] as? String ?: ""), 12f, Theme.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
    row.addView(stacked(context, listOf(name, handle), 2f), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    val free = context.words("Разблокировать", 14f, if (busyId.isEmpty()) Theme.text else Theme.subtle, 600)
    free.gravity = Gravity.CENTER
    free.minHeight = dp(40f)
    free.isEnabled = busyId.isEmpty()
    free.isClickable = true
    free.isFocusable = true
    free.setOnClickListener { unblock(id) }
    row.addView(free, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(12f) })
    return SettingsLook.inset(row, top = 10f, side = 14f, bottom = 10f)
  }

  private fun unblock(id: String) {
    if (busyId.isNotEmpty() || id.isEmpty()) return
    busyId = id
    failure = ""
    fill()
    account.accountCall("unblock", listOf(id)) { result ->
      busyId = ""
      if (result.isSuccess) people = people.orEmpty().filter { it["id"] as? String != id }
      // Otherwise the row stays; the person is told why.
      else failure = result.failureWords("Не удалось разблокировать.")
      fill()
    }
  }
}
