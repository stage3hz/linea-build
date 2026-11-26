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
  // D: no big «Настройки» — the reference's `Root` starts with the profile head and «Изменить» on glass.
  override val showsHeading: Boolean get() = false
  private val profileChanged: () -> Unit = { if (built) buildIfChanged() }
  // Profile: the banner, the effect, «Изменить» and the decorated head (profile/SettingsProfileHead.kt).
  private val profileChrome = com.linea.messenger.profile.SettingsProfileChrome(context)
  private val platinaChanged: (Unit) -> Unit = { if (built) buildIfChanged() }
  /** What the page was last built from: the same profile told again leaves the head and the rows as they are. */
  private var builtPerson: Map<String, Any?>? = null
  private var builtRows = ""

  override fun onAttachedToWindow() {
    val again = built
    super.onAttachedToWindow()
    OwnProfile.watch(profileChanged)
    com.linea.messenger.platina.PlatinaState.changed.watch(platinaChanged) // Profile: the offer
    // Back in the window: what changed while the section was away is shown.
    if (again) build()
  }

  override fun onDetachedFromWindow() {
    OwnProfile.unwatch(profileChanged)
    com.linea.messenger.platina.PlatinaState.changed.unwatch(platinaChanged)
    super.onDetachedFromWindow()
  }

  /** The section came to the eyes (opened, or uncovered by a page that left): the profile is asked again. */
  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    if (!isVisible) return
    account?.prepareSettingsAvatars()
    account?.refreshOwnProfile()
    countMuted()
  }

  private val person: Map<String, Any?> get() = account?.ownProfile ?: Demo.settingsPerson()

  /** The server is asked for the profile every time the section comes to the eyes, and for Platina's state by the
   *  profile's pages; each answer is told here even when it says nothing new. Built anew, the head and every row were
   *  new views: a finger on the status or on a row lost its touch (its view was taken from under it), and the press
   *  did nothing. The iPhone's Settings/SettingsViewController.swift keeps its page the same way. */
  private fun buildIfChanged() {
    if (builtPerson == person && builtRows == rowsKey()) return
    build()
  }

  /** What the rows show besides the profile: the theme's name, the number of folders, the language, the quiet chats
   *  and Platina (the offer). */
  private fun rowsKey(): String {
    val theme = ThemeStore.nightState()["shown"] as? String ?: "black"
    val folders = account?.let { com.linea.messenger.chatsplus.ChatFolderStore.of(context, it.userId).folders.size } ?: 0
    return listOf(theme, folders.toString(), com.linea.messenger.language.Language.chosenName, mutedChats.toString(), if (com.linea.messenger.platina.PlatinaState.active) "platina" else "").joinToString("|")
  }

  override fun build() {
    clear()
    val who = person
    builtPerson = who
    builtRows = rowsKey()
    if (who.isNotEmpty()) {
      // Profile: the reference's head (banner under the status bar, decorated avatar, platinum name, seal).
      profileChrome.attach(this, scroll, account?.messenger)
      profileChrome.onProfile = { openProfile() }
      profileChrome.onEdit = { account?.let { open(ProfileEditScreen(context, it)) } }
      profileChrome.onStatus = { open(com.linea.messenger.profile.OwnProfileScreen(context, account?.messenger, account).also { it.opensStatusPicker = true }) }
      add(profileChrome.head(who), 0f)
      if (!com.linea.messenger.platina.PlatinaState.active && !com.linea.messenger.avatars.PersonLook.from(who).platina) add(profileChrome.offer(), 18f)
    }

    // The reference's `Root` (SettingsScreen.tsx): its groups 14 apart, 18 under the head; the icons are its Ionicons.
    val offered = who.isNotEmpty() && !com.linea.messenger.platina.PlatinaState.active && !com.linea.messenger.avatars.PersonLook.from(who).platina
    var gap = if (offered) 14f else 18f
    fun group(rows: List<View>) { add(SettingsGroup(context, rows), gap); gap = 14f }

    val profile = SettingsRow(context, symbol = "ion:person", label = "Мой профиль")
    profile.onPress = { openProfile() }
    group(listOf(profile))

    // «Уведомления и звуки» says how many chats are quiet right now («Без звука: N»).
    val notifications = SettingsRow(context, symbol = "ion:notifications", label = "Уведомления и звуки", value = if (mutedChats > 0) "Без звука: $mutedChats" else "")
    notifications.onPress = { openPage("notifications") }
    val shownTheme = ThemeStore.nightState()["shown"] as? String ?: "black"
    val appearance = SettingsRow(context, symbol = "ion:color-palette", label = "Оформление", value = ThemeStore.themeName(shownTheme))
    appearance.onPress = { openPage("appearance") }
    // ChatsPlus: «Папки с чатами» — the folders above the chat list, kept on this device (chatsplus/ChatFolders.kt); the
    // row shows how many there are.
    val folderCount = account?.let { com.linea.messenger.chatsplus.ChatFolderStore.of(context, it.userId).folders.size } ?: 0
    val folders = SettingsRow(context, symbol = "ion:folder", label = "Папки с чатами", value = if (folderCount > 0) folderCount.toString() else "")
    folders.onPress = { open(com.linea.messenger.chatsplus.FoldersSettingsPage(context, account?.messenger)) }
    // Effects: «Энергосбережение и анимации» and «Язык» (settings/PowerSettings.kt, settings/LanguageSettings.kt).
    val power = SettingsRow(context, symbol = "ion:battery-half", label = "Энергосбережение и анимации")
    power.onPress = { openPage("power") }
    val language = SettingsRow(context, symbol = "ion:language", label = "Язык", value = com.linea.messenger.language.Language.chosenName)
    language.onPress = { openPage("language") }
    group(listOf(notifications, appearance, folders, power, language))

    val privacy = SettingsRow(context, symbol = "ion:lock-closed", label = "Конфиденциальность")
    privacy.onPress = { account?.let { open(PrivacyScreen(context, it)) } }
    // «Безопасность и устройства»: the reference's one SecurityScreen — the secrets, the sessions, the blocked people and
    // deleting the account (settings/Security.kt).
    val security = SettingsRow(context, symbol = "ion:shield-checkmark", label = "Безопасность и устройства")
    security.onPress = { account?.let { open(SecurityScreen(context, it)) } }
    val data = SettingsRow(context, symbol = "ion:server", label = "Данные и память")
    data.onPress = { openPage("data") }
    group(listOf(privacy, security, data))

    val help = SettingsRow(context, symbol = "ion:help-buoy", label = "Помощь и поддержка")
    help.onPress = { if (account != null) openSupport() }
    group(listOf(help))

    val leave = SettingsRow(context, symbol = "ion:log-out-outline", label = "Выйти из аккаунта", danger = true)
    leave.onPress = { askToLeave() }
    group(listOf(leave))

    // The technical line: «Чёрная» — monospaced (12, `subtle`, letter spacing −0.15); other themes — 11 in `muted`.
    val version = appVersion(context)
    val made = if (ThemeStore.look.black) context.words("INVIZENT $version · e2ee · signal", 12f, Theme.subtle).apply {
      typeface = Typeface.MONOSPACE
      letterSpacing = -0.15f / 12f
    } else context.words("Инвиз $version · переписка защищена сквозным шифрованием", 11f, Theme.muted)
    made.gravity = Gravity.CENTER
    add(made, 14f)
  }

  /** How many chats are quiet right now (the reference's `mutedChats`), from the list kept on this device. */
  private var mutedChats = 0

  private fun countMuted() {
    val messenger = account?.messenger ?: return
    com.linea.messenger.offline.ChatCache.cachedChats(messenger) { list ->
      val quiet = list.count { chat ->
        val settings = Core.map(chat.chat["settings"]) ?: return@count false
        NotificationsScreen.muteState(settings)["muted"] as? Boolean ?: false
      }
      if (quiet != mutedChats) { mutedChats = quiet; if (built) build() }
    }
  }

  private fun openProfile() {
    // Profile: «Мой профиль» is the read-only profile; «Изменить» there opens the editor.
    if (account != null || com.linea.messenger.platina.PlatinaSamples.me != null) open(com.linea.messenger.profile.OwnProfileScreen(context, account?.messenger, account))
  }

  private fun openPage(name: String) {
    page(name)?.let { open(it) }
  }

  /** The pages of how the app looks and sounds, by name (also what a change of the theme opens again on top
   *  of the rebuilt shell, see ThemeStore.kt). «Оформление» needs no account: it is kept on the device. */
  fun page(name: String): View? = when (name) {
    "appearance" -> AppearanceScreen(context, account)
    "night" -> NightThemeScreen(context)
    "accent" -> AccentColorScreen(context)
    "notifications" -> account?.let { NotificationsScreen(context, it) }
    "data" -> account?.let { DataScreen(context, it) }
    // Effects / Security: «Энергосбережение и анимации», «Язык», «Код-пароль», the privacy lists (settings/LanguageSettings.kt, parityPage).
    else -> parityPage(context, name, account)
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
    // «Оформление» and its pages: «night» and «accent» stand on top of «Оформление», as they are reached.
    if (name == "night" || name == "accent") page("appearance")?.let { open(it, animated = false) }
    page(name)?.let { return open(it, animated = false) }
    val account = account
    if (account == null) {
      if (name == "about") open(AboutScreen(context), animated = false)
      return
    }
    val page: View? = when (name) {
      "profile" -> ProfileEditScreen(context, account)
      "username" -> {
        // The @username's sheet over the editor, as it is reached.
        open(ProfileEditScreen(context, account), animated = false)
        UsernameSheet.show(context, account)
        return
      }
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
