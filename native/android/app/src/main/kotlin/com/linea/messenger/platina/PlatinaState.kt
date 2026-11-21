package com.linea.messenger.platina

import android.view.View
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import com.linea.messenger.settings.accountCall
import java.lang.ref.WeakReference
import java.time.ZoneId

/** Whether the signed-in account has an active Platina, as the server says (`GET /me/username`, the reference's
 *  platina/usePlatina.ts; iOS Platina/PlatinaState.swift): shared by every screen, asked when a screen needs it at
 *  most once a minute, and set by screens that know better. The last state seen on this phone is kept per account,
 *  so a grant is noticed whether it happens while the app is open or between launches — the confetti and «Платина
 *  активирована» then (the first time an account is seen nothing is celebrated). Main thread only. */
object PlatinaState {
  /** Posted when `active` or the status changed. */
  val changed = Live.Signal<Unit>()
  private var messengerRef = WeakReference<Messenger>(null)
  val messenger: Messenger? get() = messengerRef.get()
  var owner = ""
    private set
  var active = false
    private set
  /** The server's whole answer (`UsernameStatus`): the emoji choices, the expiry… */
  var status: Map<String, Any?> = emptyMap()
    private set
  private var checkedAt = 0L
  private var loading = false
  private var host = WeakReference<View>(null)

  /** The account whose Platina this is; another account starts from nothing. `host`: where the confetti shows. */
  fun start(messenger: Messenger?, host: View? = null) {
    if (host != null) this.host = WeakReference(host)
    messenger ?: return
    if (this.messenger !== messenger) {
      messengerRef = WeakReference(messenger)
      owner = messenger.userId
      active = false
      status = emptyMap()
      checkedAt = 0L
    }
    refresh()
  }

  /** Asks the server again unless it was asked less than a minute ago (`force`: always). */
  fun refresh(force: Boolean = false) {
    val messenger = messenger ?: return
    if (loading) return
    if (!force && System.currentTimeMillis() - checkedAt < 60_000) return
    loading = true
    val asked = messenger.userId
    messenger.accountCall("usernameStatus", emptyList()) { result ->
      loading = false
      val body = result.getOrNull() ?: return@accountCall
      if (body["accountId"] as? String != asked || asked != owner) return@accountCall
      checkedAt = System.currentTimeMillis()
      take(body)
    }
  }

  /** A fresh status from a screen that changed it (the @username, the emoji status). */
  fun take(body: Map<String, Any?>) {
    status = body
    set(Core.map(body["platina"])?.get("active") as? Boolean ?: false)
  }

  fun set(next: Boolean) {
    active = next
    noteGrant(next)
    changed.post(Unit)
  }

  /** «Бессрочно», «Активна до 5 марта», «Активна»; empty without Platina (SettingsScreen.tsx). */
  val untilWords: String get() = untilWords(active, status)

  fun untilWords(active: Boolean, status: Map<String, Any?>, zone: ZoneId = ZoneId.systemDefault()): String {
    val platina = Core.map(status["platina"]) ?: return ""
    if (!active) return ""
    if (platina["permanent"] == true) return "Бессрочно"
    val at = Messenger.date(platina["expiresAt"] as? String) ?: return "Активна"
    val day = at.atZone(zone)
    return "Активна до ${day.dayOfMonth} ${months[day.monthValue - 1]}"
  }

  private val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

  private fun noteGrant(now: Boolean) {
    if (owner.isEmpty()) return
    val view = host.get() ?: return
    val prefs = view.context.getSharedPreferences("linea.platina", android.content.Context.MODE_PRIVATE)
    val key = "linea.platina.seen.$owner"
    val before = prefs.getString(key, null)
    val value = if (now) "1" else "0"
    if (before == value) return
    prefs.edit().putString(key, value).apply()
    if (before == "0" && now) PlatinaConfettiHost.show(view)
  }
}
