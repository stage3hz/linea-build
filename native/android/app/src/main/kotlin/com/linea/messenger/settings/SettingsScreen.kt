package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.Demo
import com.linea.messenger.app.Messenger
import com.linea.messenger.auth.Account
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words

/** The settings section: who is signed in, then the groups of what can be set up — each row opens its own page.
 *  (The previous app: `mobile/src/SettingsScreen.tsx`, `Root`.)
 *  `account`: the signed-in account; null shows the page with the debug build's sample person (rows then open
 *  nothing but «О приложении»). */
@SuppressLint("ViewConstructor")
class SettingsScreen internal constructor(context: Context, private val account: SettingsAccount?) : SettingsPage(context, "Настройки", large = true) {
  /** `messenger`: the signed-in account; null in the shell that has none (the debug build's samples). */
  constructor(context: Context, messenger: Messenger?) : this(context, messenger?.let { MessengerAccount(it) })

  private var leaving = false
  private val profileChanged: () -> Unit = { if (built) build() }

  override fun onAttachedToWindow() {
    val again = built
    super.onAttachedToWindow()
    OwnProfile.watch(profileChanged)
    // Back in the window: what changed while the section was away is shown.
    if (again) build()
  }

  override fun onDetachedFromWindow() {
    OwnProfile.unwatch(profileChanged)
    super.onDetachedFromWindow()
  }

  /** The section came to the eyes (opened, or uncovered by a page that left): the profile is asked again. */
  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    if (!isVisible) return
    account?.prepareSettingsAvatars()
    account?.refreshOwnProfile()
  }

  private val person: Map<String, Any?> get() = account?.ownProfile ?: Demo.settingsPerson()

  override fun build() {
    clear()
    val who = person
    if (who.isNotEmpty()) {
      val head = SettingsHead(context, who, account?.base ?: "")
      head.onPress = { openProfile() }
      add(head, 0f)
    }

    val profile = SettingsRow(context, symbol = "person", label = "Мой профиль")
    profile.onPress = { openProfile() }
    addGroup(rows = listOf(profile))

    val privacy = SettingsRow(context, symbol = "lock", label = "Конфиденциальность")
    privacy.onPress = { account?.let { open(PrivacyScreen(context, it)) } }
    val security = SettingsRow(context, symbol = "shield", label = "Безопасность")
    security.onPress = { account?.let { open(SecurityScreen(context, it)) } }
    val sessions = SettingsRow(context, symbol = "phone", label = "Активные сеансы")
    sessions.onPress = { account?.let { open(SessionsScreen(context, it)) } }
    val blocked = SettingsRow(context, symbol = "blocked", label = "Заблокированные")
    blocked.onPress = { account?.let { open(BlockedScreen(context, it)) } }
    addGroup(rows = listOf(privacy, security, sessions, blocked))

    val help = SettingsRow(context, symbol = "lifebuoy", label = "Помощь и поддержка")
    help.onPress = { if (account != null) openSupport() }
    val about = SettingsRow(context, symbol = "info", label = "О приложении", value = appVersion(context))
    about.onPress = { open(AboutScreen(context)) }
    addGroup(rows = listOf(help, about))

    val leave = SettingsRow(context, symbol = "exit", label = "Выйти из аккаунта", danger = true)
    leave.onPress = { askToLeave() }
    addGroup(rows = listOf(leave))

    // What the app is made of, in one quiet line.
    val made = context.words("INVIZENT ${appVersion(context)} · ядро ${Core.version}", 12f, Theme.subtle)
    made.typeface = Typeface.MONOSPACE
    made.gravity = Gravity.CENTER
    add(made, 18f)
  }

  private fun openProfile() {
    account?.let { open(ProfileEditScreen(context, it)) }
  }

  /** The support page of the server, in the browser. */
  private fun openSupport() {
    try {
      context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Account.server + "/support")))
    } catch (_: Exception) {
      // No browser on this device: nothing opens.
    }
  }

  /** «Выйти из аккаунта» asks first: coming back needs the login, the long password and the confirmation word. */
  private fun askToLeave() {
    if (account == null || leaving) return
    confirm("Выйти из Инвиза?", "Сеанс на этом устройстве завершится. Для следующего входа понадобятся логин, пароль и слово подтверждения. Публичное имя может отличаться от логина.", "Выйти") { leave() }
  }

  private fun leave() {
    val account = account ?: return
    if (leaving) return
    leaving = true
    account.signOut { result ->
      leaving = false
      val notice = result.getOrNull()
      if (notice != null) closeAccount(notice) else tell(result.failureWords(""))
    }
  }

  /** For the emulator check (`--es settings <name>`): opens one page of the settings at once. */
  fun openDetail(name: String) {
    val account = account
    if (account == null) {
      if (name == "about") open(AboutScreen(context), animated = false)
      return
    }
    val page: View? = when (name) {
      "profile" -> ProfileEditScreen(context, account)
      "username" -> UsernameScreen(context, account)
      "birthday" -> BirthdayScreen(context, account.ownProfile["birthday"] as? String) { }
      "privacy" -> PrivacyScreen(context, account)
      "lastseen" -> LastSeenScreen(context, SettingsPrivacyModel(account).also { it.load() })
      "security" -> SecurityScreen(context, account)
      "password" -> SecretChangeScreen(context, account, SecretChangeScreen.Form.PASSWORD, confirmationConfigured = true)
      "confirmation" -> SecretChangeScreen(context, account, SecretChangeScreen.Form.CONFIRMATION, confirmationConfigured = true)
      "recovery" -> SecretChangeScreen(context, account, SecretChangeScreen.Form.RECOVERY, confirmationConfigured = true)
      "sessions" -> SessionsScreen(context, account)
      "session" -> SessionsScreen(context, account).also { it.opensFirstWhenLoaded = true }
      "blocked" -> BlockedScreen(context, account)
      "delete" -> DeleteAccountScreen(context, account)
      "about" -> AboutScreen(context)
      else -> null
    }
    if (page != null) open(page, animated = false)
  }

  companion object {
    /** The app's version as its package says it. */
    fun appVersion(context: Context): String = try { context.packageManager.getPackageInfo(context.packageName, 0).versionName } catch (_: Exception) { null } ?: "?"

    /** The number of the build. */
    @Suppress("DEPRECATION")
    fun buildNumber(context: Context): String = try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      (if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()).toString()
    } catch (_: Exception) { "?" }
  }
}

/** The top of the settings: the person's ball, their name and @username. Pressing it opens the profile. */
@SuppressLint("ViewConstructor")
class SettingsHead(context: Context, person: Map<String, Any?>, base: String) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null

  init {
    orientation = VERTICAL
    setPadding(context.px(4f), context.px(6f), context.px(4f), context.px(4f))
    val ball = SettingsAvatar(context)
    ball.show(person, base)
    addView(ball, LayoutParams(context.px(84f), context.px(84f)))
    val name = person["displayName"] as? String ?: ""
    val handle = person["username"] as? String ?: ""
    val nameLabel = context.words(name, 27f, Theme.text, 800)
    nameLabel.maxLines = 2
    nameLabel.ellipsize = TextUtils.TruncateAt.END
    addView(nameLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(12f) })
    val handleLabel = context.words(if (handle.isEmpty()) "" else "@$handle", 15f, Theme.muted)
    handleLabel.maxLines = 1
    handleLabel.ellipsize = TextUtils.TruncateAt.END
    addView(handleLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(5f) })
    isClickable = true
    isFocusable = true
    contentDescription = "Мой профиль: " + name + (if (handle.isEmpty()) "" else ", @$handle")
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    alpha = if (pressed) 0.7f else 1f
  }
}

/** «О приложении»: what the app is made of. */
class AboutScreen(context: Context) : SettingsPage(context, "О приложении") {
  override fun build() {
    val version = SettingsScreen.appVersion(context)
    val rows = listOf("Приложение" to "INVIZENT $version", "Сборка" to SettingsScreen.buildNumber(context), "Ядро" to Core.version).map { (label, value) ->
      SettingsRow(context, label = label, value = value, arrow = false).apply { isClickable = false }
    }
    addGroup(rows = rows)
    add(SettingsLook.foot(context, "Инвиз $version · переписка защищена сквозным шифрованием"), 10f)
  }
}
