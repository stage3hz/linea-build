package com.linea.messenger.security

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.design.Glass
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.profile.pages
import com.linea.messenger.settings.MessengerAccount
import com.linea.messenger.settings.SessionsScreen
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsNotice
import com.linea.messenger.settings.SettingsPage
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.settings.accountCall
import java.lang.ref.WeakReference
import java.time.ZoneId

/** «Новый вход» and «Запрошено восстановление аккаунта»: notices above the chat list, each opening a sheet. (The
 *  previous app: `NewLoginNotice.tsx` with `sessionAlerts.ts`, and `RecoveryNotice.tsx` with the polling of
 *  `useMessenger.ts`; iOS Security/AccountNotices.swift.) The sign-ins are kept only while the app is open (the full
 *  list is «Активные сеансы»); the recovery requests are asked from the server at start, on its events, and every 30 s
 *  while the app is in front. */
object AccountNotices {
  val changed = Live.Signal<Unit>()

  class NewLogin(val session: Map<String, Any?>, val label: String, val id: String)

  private var account = WeakReference<Messenger>(null)
  val messenger: Messenger? get() = account.get()
  var logins: List<NewLogin> = emptyList()
    private set
  var recovery: List<Map<String, Any?>> = emptyList()
    private set
  var recoveryError = ""
    private set
  private var revision = 0
  private var samples = false
  private var host = WeakReference<ViewGroup>(null)
  private var card: NoticeCards? = null
  private val main = Handler(Looper.getMainLooper())
  /** The window is in front (MainActivity's onStart / onStop). */
  var front = true
  private val poll = object : Runnable {
    override fun run() { if (front) refreshRecovery(); main.postDelayed(this, 30_000) }
  }
  private val heard: (Map<String, Any?>) -> Unit = { data ->
    if (data["type"] == "session.new") noteLogin(data) else refreshRecovery()
  }

  /** Called once by the signed-in account's shell (shell/RootScreen.kt). */
  fun start(context: Context, messenger: Messenger?) {
    if (messenger == null) return
    account = WeakReference(messenger)
    logins = emptyList(); recovery = emptyList(); recoveryError = ""
    Live.securityEvent.unwatch(heard)
    Live.securityEvent.watch(heard)
    main.removeCallbacks(poll)
    main.postDelayed(poll, 30_000)
    refreshRecovery()
    // Links: the number on the app's icon (links/AppBadge.kt); a link that came before the account was open (links/DeepLinks.kt).
    com.linea.messenger.links.AppBadge.start(context, messenger)
    com.linea.messenger.links.DeepLinks.accountReady()
    tell()
  }

  /** The app came to the front again (MainActivity). */
  fun cameBack() { front = true; refreshRecovery() }

  private fun tell() {
    card?.show(logins, recovery, recoveryError)
    host.get()?.requestLayout()
    changed.post(Unit)
  }

  /** One line for the notice: model and OS, else the device name (the server's `sessionLabel`). */
  fun loginLabel(session: Map<String, Any?>): String {
    var name = session["deviceModel"] as? String ?: ""
    if (name.isEmpty()) name = session["deviceName"] as? String ?: ""
    if (name.isEmpty()) name = "Неизвестное устройство"
    val system = session["osVersion"] as? String ?: ""
    return if (system.isEmpty()) name else "$name · $system"
  }

  /** A `session.new` packet: kept (newest first, at most five). */
  fun noteLogin(data: Map<String, Any?>) {
    val session = Core.map(data["session"]) ?: return
    val id = session["id"] as? String ?: return
    var label = (data["label"] as? String ?: "").trim()
    if (label.isEmpty()) label = loginLabel(session)
    logins = (listOf(NewLogin(session, label, id)) + logins.filter { it.id != id }).take(5)
    tell()
  }

  fun dismissLogin(id: String) {
    val next = logins.filter { it.id != id }
    if (next.size == logins.size) return
    logins = next
    tell()
  }

  fun refreshRecovery() {
    val messenger = messenger ?: return
    revision += 1
    val asked = revision
    messenger.accountCall("recoveryRequests", emptyList()) { result ->
      if (asked != revision) return@accountCall
      val body = result.getOrNull()
      if (body != null) {
        recovery = (body["requests"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }
        recoveryError = ""
      } else {
        // Offline is not «не удалось проверить»: the last known requests stay, the next poll asks again.
        val failed = result.exceptionOrNull()
        if (failed is ServerError.Network || failed is ServerError.Timeout) return@accountCall
        recoveryError = Server.error(result).words
      }
      tell()
    }
  }

  fun cancelRecovery(id: String, done: (String?) -> Unit) {
    val messenger = messenger ?: return done("Не удалось отменить запрос.")
    messenger.accountCall("cancelRecovery", listOf(id)) { result ->
      if (result.isSuccess) {
        revision += 1
        recovery = recovery.filter { it["id"] as? String != id }
        recoveryError = ""
        tell()
        refreshRecovery()
        done(null)
      } else done(Server.error(result).words.ifEmpty { "Не удалось отменить запрос." })
    }
  }

  /** For the emulator check: sample notices without a server. */
  fun showSamples(login: Boolean, recovery: Boolean) {
    samples = true
    if (login) noteLogin(mapOf("type" to "session.new", "label" to "iPhone 15 · iOS 18.1", "session" to mapOf("id" to "sample-session", "deviceName" to "iPhone", "deviceModel" to "iPhone 15", "osVersion" to "iOS 18.1", "platform" to "ios", "appVersion" to "0.17.0", "ip" to "203.0.113.24", "createdAt" to "2026-11-08T18:36:00.000Z")))
    if (recovery) { this.recovery = listOf(mapOf("id" to "sample-recovery", "deviceName" to "Pixel 8", "createdAt" to "2026-11-21T09:15:00.000Z", "readyAt" to "2026-11-22T09:15:00.000Z")); tell() }
  }

  // ---- Above the chat list ----

  /** Puts the notices under the heading of the chats (chats/ChatsScreen.kt); returns where the list begins below them. */
  fun place(screen: ViewGroup, top: Int, width: Int, account: Boolean): Int {
    // The samples of the emulator check are the only notices without an account.
    if (!account && !samples) return top
    host = WeakReference(screen)
    var shown = card
    if (shown == null || shown.parent !== screen) {
      shown?.let { (it.parent as? ViewGroup)?.removeView(it) }
      val made = NoticeCards(screen.context)
      made.onOpen = { kind -> openSheet(kind, screen) }
      made.show(logins, recovery, recoveryError)
      card = made
      screen.addView(made)
      shown = made
    }
    if (shown.visibility != View.VISIBLE) return top
    val d = screen.resources.displayMetrics.density
    val side = (12 * d).toInt()
    shown.measure(View.MeasureSpec.makeMeasureSpec(width - side * 2, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val y = top + (8 * d).toInt()
    shown.layout(side, y, width - side, y + shown.measuredHeight)
    return y + shown.measuredHeight + (6 * d).toInt()
  }

  fun openSheet(kind: String, from: View) {
    val page: View = if (kind == "login") NewLoginSheet(from.context, logins.firstOrNull() ?: return) else RecoverySheet(from.context)
    from.pages()?.push(page)
  }
}

/** The two notices on glass, one under the other. */
class NoticeCards(context: Context) : LinearLayout(context) {
  var onOpen: ((String) -> Unit)? = null

  init { orientation = VERTICAL; visibility = GONE }

  fun show(logins: List<AccountNotices.NewLogin>, recovery: List<Map<String, Any?>>, error: String) {
    removeAllViews()
    fun put(line: View) = addView(line, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (childCount > 0) topMargin = context.px(8f) })
    if (recovery.isNotEmpty()) {
      put(NoticeLine(context, "ion:shield-outline", "Запрошено восстановление аккаунта", "Если это не ты — открой запрос и отмени смену пароля.").apply {
        contentDescription = "Запрошено восстановление аккаунта. Проверить запрос"
        setOnClickListener { onOpen?.invoke("recovery") }
      })
    } else if (error.isNotEmpty()) {
      put(NoticeLine(context, "ion:alert-circle-outline", "Не удалось проверить запросы на восстановление аккаунта.", "Коснись, чтобы повторить.").apply { setOnClickListener { AccountNotices.refreshRecovery() } })
    }
    logins.firstOrNull()?.let { latest ->
      val more = if (logins.size > 1) "Ещё входов: ${logins.size - 1}. " else ""
      put(NoticeLine(context, NewLoginSheet.symbol(latest.session), "Новый вход: " + latest.label, more + "Если это был не ты — заверши сеанс.").apply {
        contentDescription = "Новый вход: " + latest.label + ". Проверить"
        setOnClickListener { onOpen?.invoke("login") }
      })
    }
    visibility = if (childCount == 0) GONE else VISIBLE
  }
}

/** One notice: a red icon, a bold line, a quiet line, an arrow; on glass with a radius of 18. */
@SuppressLint("ViewConstructor")
class NoticeLine(context: Context, symbol: String, title: String, words: String) : LinearLayout(context) {
  private val glass = Glass(this)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.px(54f)
    setPadding(context.px(13f), context.px(13f), context.px(13f), context.px(13f))
    setWillNotDraw(false)
    addView(SymbolView(context, symbol, 22f, Theme.danger), LayoutParams(context.px(22f), context.px(22f))) // Ionicons 22
    val texts = LinearLayout(context).apply { orientation = VERTICAL }
    texts.addView(context.words(title, 14f, Theme.text, 700).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
    texts.addView(context.words(words, 12f, Theme.muted), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f); rightMargin = context.px(12f) })
    addView(SymbolView(context, "ion:chevron-forward", 18f, Theme.muted), LayoutParams(context.px(18f), context.px(18f)))
    isClickable = true
    isFocusable = true
  }

  override fun onDraw(canvas: android.graphics.Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 18 * resources.displayMetrics.density)
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) { super.setPressed(pressed); alpha = if (pressed) 0.7f else 1f }
}

/** A card with a hairline rim of the theme's border, radius 18. */
private fun Context.rimmed(): android.graphics.drawable.GradientDrawable = android.graphics.drawable.GradientDrawable().apply {
  cornerRadius = 18 * resources.displayMetrics.density
  setStroke(px(1f), ThemeStore.look.border)
}

/** «Новый вход в аккаунт»: the device, its system, the app, the address the server saw, the time; «Это был не я —
 *  завершить сеанс» ends that session on the server at once, «Это был я» hides the notice. */
@SuppressLint("ViewConstructor")
class NewLoginSheet(context: Context, private val login: AccountNotices.NewLogin) : SettingsPage(context, "Новый вход в аккаунт", large = true) {
  private var ended = false
  private var failure = ""
  private val endButton = SettingsButton(context, "Это был не я — завершить сеанс", SettingsButton.Kind.DANGER, icon = "log-out-outline")

  companion object {
    fun symbol(session: Map<String, Any?>): String {
      val platform = session["platform"] as? String ?: ""
      val model = (session["deviceModel"] as? String ?: "").lowercase()
      val device = (session["deviceName"] as? String ?: "").lowercase()
      if (platform == "ios" || platform == "android") return if (model.contains("ipad") || model.contains("tablet")) "ion:tablet-portrait-outline" else "ion:phone-portrait-outline"
      if (platform == "web") return "ion:globe-outline"
      if (platform == "windows") return "ion:desktop-outline"
      for (word in listOf("android", "iphone", "ipad", "ios", "pixel", "galaxy")) if (device.contains(word)) return "ion:phone-portrait-outline"
      return "ion:desktop-outline"
    }
  }

  private fun value(name: String): String = (login.session[name] as? String)?.takeIf { it.isNotEmpty() } ?: "—"

  override fun build() {
    clear()
    val session = login.session
    if (ended) add(SettingsNotice(context, "Сеанс завершён. На том устройстве понадобится снова ввести логин, пароль и слово подтверждения. Если пароль мог утечь — смени его в разделе «Безопасность»."), 4f)
    else add(context.words("В твой аккаунт вошли с другого устройства. Данные об устройстве сообщает само приложение; адрес — такой, каким его увидел сервер. Через 10 минут после входа это устройство получит копию твоих переписок (зашифрованную только для него). Если это был не ты — заверши сеанс сейчас, и перенос не состоится.", 14f, Theme.muted), 4f)
    var device = session["deviceModel"] as? String ?: ""
    if (device.isEmpty()) device = value("deviceName")
    val app = session["appVersion"] as? String ?: ""
    val rows = listOf("Устройство" to device, "Система" to value("osVersion"), "Приложение" to (if (app.isEmpty()) "—" else "Инвиз $app"), "IP-адрес" to value("ip"), "Вход" to SettingsLook.moment(session["createdAt"] as? String))
    val card = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, context.px(10f)); background = context.rimmed() }
    card.addView(SettingsLook.inset(context.words(login.label, 16f, Theme.text, 700), top = 14f, side = 14f, bottom = 2f))
    for ((name, shown) in rows) {
      val line = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
      line.addView(context.words(name, 13f, Theme.muted), LinearLayout.LayoutParams(context.px(104f), LinearLayout.LayoutParams.WRAP_CONTENT))
      line.addView(context.words(shown, 13f, Theme.text), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f) })
      card.addView(SettingsLook.inset(line, top = 4f, side = 14f, bottom = 4f))
    }
    add(card, 16f)
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true), 16f)
    if (ended) {
      val done = SettingsButton(context, "Понятно")
      done.onPress = { goBack() }
      add(done, 16f)
      return
    }
    endButton.onPress = { notMe() }
    add(endButton, 16f)
    val me = SettingsButton(context, "Это был я", SettingsButton.Kind.SECONDARY, icon = "checkmark-outline")
    me.onPress = { AccountNotices.dismissLogin(login.id); goBack() }
    add(me, 8f)
    val all = context.words("Все сеансы и устройства", 13f, Theme.accent, 700).apply {
      gravity = Gravity.CENTER; minHeight = context.px(44f); isClickable = true
      setOnClickListener { AccountNotices.messenger?.let { open(SessionsScreen(context, MessengerAccount(it))) } }
    }
    add(all, 4f)
  }

  private fun notMe() {
    val messenger = AccountNotices.messenger ?: return
    endButton.setBusy(true)
    failure = ""
    messenger.accountCall("revokeSession", listOf(login.id)) { result ->
      endButton.setBusy(false)
      if (result.isSuccess) { ended = true; AccountNotices.dismissLogin(login.id) }
      else failure = Server.error(result).words.ifEmpty { "Не удалось завершить сеанс. Открой Безопасность → Сеансы." }
      build()
    }
  }
}

/** «Восстановление аккаунта»: the open requests, each with «Это не я — отменить». */
class RecoverySheet(context: Context) : SettingsPage(context, "Восстановление аккаунта", large = true) {
  private var busy = ""
  private var failure = ""
  private val refill: (Unit) -> Unit = { if (built) build() }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); AccountNotices.changed.watch(refill) }
  override fun onDetachedFromWindow() { AccountNotices.changed.unwatch(refill); super.onDetachedFromWindow() }

  override fun build() {
    clear()
    add(context.words("Другое устройство подтвердило слово восстановления. Пока пароль не изменён, ты можешь отменить запрос. Название устройства указано самим клиентом.", 14f, Theme.muted), 4f)
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true), 16f)
    if (AccountNotices.recoveryError.isNotEmpty()) add(SettingsNotice(context, "Список запросов не удалось обновить. Проверь подключение.", error = true, onRetry = { AccountNotices.refreshRecovery() }), 16f)
    for (request in AccountNotices.recovery) {
      val id = request["id"] as? String ?: continue
      val device = (request["deviceName"] as? String)?.takeIf { it.isNotEmpty() } ?: "Новое устройство"
      val asked = SettingsLook.longMomentWords(request["createdAt"] as? String)
      val ready = Messenger.date(request["readyAt"] as? String)?.atZone(ZoneId.systemDefault())?.let { String.format("%02d:%02d", it.hour, it.minute) } ?: ""
      val cancel = SettingsButton(context, "Это не я — отменить", SettingsButton.Kind.DANGER, icon = "close-circle-outline")
      cancel.onPress = { cancel(id) }
      val card = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setPadding(context.px(14f), context.px(14f), context.px(14f), context.px(14f)); background = context.rimmed() }
      card.addView(context.words(device, 16f, Theme.text, 700))
      card.addView(context.words("Запрошено: $asked\nСмена пароля разрешится после: $ready", 13f, Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
      card.addView(cancel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, context.px(50f)).apply { topMargin = context.px(10f) })
      add(card, 16f)
      if (busy == id) cancel.setBusy(true) else if (busy.isNotEmpty()) cancel.isEnabled = false
    }
    if (AccountNotices.recovery.isEmpty()) add(SettingsNotice(context, "Активных запросов на восстановление нет."), 16f)
  }

  private fun cancel(id: String) {
    if (busy.isNotEmpty()) return
    busy = id
    failure = ""
    build()
    AccountNotices.cancelRecovery(id) { problem ->
      busy = ""
      failure = problem ?: ""
      build()
    }
  }
}
