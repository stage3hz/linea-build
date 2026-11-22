package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.core.Core
import com.linea.messenger.design.SymbolButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import java.time.Instant
import java.time.ZoneId

/** The notification switches of this device (show, sound, the call's melody and vibration, the number on the
 *  icon): one JSON record kept on the phone, read back through the core (`settingsNotificationPrefs`). The server
 *  knows nothing of them; the sound of a chat is the server's own setting. (The previous app:
 *  `mobile/src/notifications/prefs.ts`, `model.ts`.) */
object NotificationPrefs {
  const val KEY = "invizent.notification-prefs.v1"

  /** `chats`, `communities`, `calls`, `badge` — each a group of switches — and `changed`. */
  val all: Map<String, Any?>
    get() = Core.map(Core.view("settingsNotificationPrefs", listOf(ThemeStore.kept?.get(KEY)))) ?: emptyMap()

  fun flag(group: String, name: String, otherwise: Boolean = true): Boolean = Core.map(all[group])?.get(name) as? Boolean ?: otherwise

  /** The melody of an incoming call: `neon`, `pulse` or `none`. */
  val ringtone: String get() = Core.map(all["calls"])?.get("ringtone") as? String ?: "neon"

  /** Any switch differs from its default. */
  val changed: Boolean get() = all["changed"] as? Boolean ?: false

  fun set(group: String, name: String, value: Any) {
    val next = LinkedHashMap(all)
    next.remove("changed")
    next[group] = LinkedHashMap(Core.map(next[group]) ?: emptyMap()).also { it[name] = value }
    ThemeStore.kept?.set(KEY, Core.text(next) ?: return)
  }

  /** «Сбросить настройки»: back to the defaults, the record removed. */
  fun reset() {
    ThemeStore.kept?.set(KEY, null)
  }
}

/** A chat whose sound is off: the person, until when, and a bell that turns the sound back on. */
@SuppressLint("ViewConstructor")
class MutedChatRow(context: Context, person: Map<String, Any?>, base: String, val name: String, val status: String) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null
  var onBell: (() -> Unit)? = null
  val bell = SymbolButton(context, "ion:notifications-outline", 20f, Theme.accent)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.px(56f)
    setPadding(context.px(14f), context.px(6f), context.px(6f), context.px(6f))
    val ball = SettingsAvatar(context)
    ball.show(person, base)
    addView(ball, LayoutParams(context.px(36f), context.px(36f)))
    val texts = LinearLayout(context)
    texts.orientation = VERTICAL
    val nameLabel = context.words(name, 15f, Theme.text, 600)
    nameLabel.maxLines = 1
    nameLabel.ellipsize = TextUtils.TruncateAt.END
    val statusLabel = context.words(status, 12f, Theme.muted)
    statusLabel.maxLines = 1
    statusLabel.ellipsize = TextUtils.TruncateAt.END
    texts.addView(nameLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    texts.addView(statusLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(2f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f); rightMargin = context.px(8f) })
    bell.contentDescription = "Включить звук"
    bell.setOnClickListener { onBell?.invoke() }
    addView(bell, LayoutParams(context.px(44f), context.px(44f)))
    isClickable = true
    isFocusable = true
    contentDescription = "$name: изменить время без звука"
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    setBackgroundColor(if (pressed) SettingsLook.pressed else 0)
  }
}

/** «Уведомления и звуки»: the switches of this device, and the chats whose sound is off.
 *  (The previous app: `mobile/src/notifications/NotificationsSection.tsx`.)
 *
 *  This app does not deliver notifications yet — not when it is closed, not when it is in the background — and
 *  the page says so. The switches are kept for the moment it does; nothing here pretends to work. The sound of a
 *  chat is real already: it is the server's setting and follows the account to its other devices. */
@SuppressLint("ViewConstructor")
class NotificationsScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Уведомления и звуки") {
  private var chats: List<Messenger.ChatSummary> = emptyList()
  private var failure = ""

  /** Push: the state line follows what this device managed (push/Push.kt). */
  private val pushWatch: (Unit) -> Unit = { if (isAttachedToWindow) fill() }

  override fun build() {
    account.prepareSettingsAvatars()
    fill()
    load()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    com.linea.messenger.push.Push.changed.watch(pushWatch)
  }

  override fun onDetachedFromWindow() {
    com.linea.messenger.push.Push.changed.unwatch(pushWatch)
    super.onDetachedFromWindow()
  }

  private fun load() {
    account.chatList { result ->
      result.getOrNull()?.let { list ->
        chats = list
        if (isAttachedToWindow) fill()
      }
    }
  }

  private fun toggle(group: String, name: String, label: String, words: String, enabled: Boolean = true, otherwise: Boolean = true): SettingsSwitchRow {
    val row = SettingsSwitchRow(context, label, words, NotificationPrefs.flag(group, name, otherwise), enabled)
    row.onChange = { value ->
      NotificationPrefs.set(group, name, value)
      fill()
    }
    return row
  }

  private fun fill() {
    clear()
    // The push state of this device, said out loud (the reference's NotificationsSection): a notice when push does
    // not work, otherwise a line of what to expect.
    val line = pushLine(com.linea.messenger.push.Push.status)
    add(if (line.second) SettingsNotice(context, line.first) else SettingsLook.foot(context, line.first))

    val showChats = NotificationPrefs.flag("chats", "show")
    addGroup("Личные чаты", listOf(
      toggle("chats", "show", "Показывать уведомления", "Новые сообщения и реакции в личных чатах, пока приложение свёрнуто. Когда оно закрыто, уведомления показывает система."),
      toggle("chats", "sound", "Звук", "Короткий сигнал при новом сообщении.", enabled = showChats),
    ))
    val showCommunities = NotificationPrefs.flag("communities", "show")
    addGroup("Сообщества", listOf(
      toggle("communities", "show", "Показывать уведомления", "Сообщения в каналах сообществ, где ты состоишь. Сообщества без звука присылают только упоминания."),
      toggle("communities", "sound", "Звук", "Короткий сигнал при новом сообщении в сообществе.", enabled = showCommunities),
    ))

    val melody = ThemeStore.list("ringtones").firstOrNull { it["id"] == NotificationPrefs.ringtone }?.get("label") as? String ?: ""
    val melodyRow = SettingsRow(context, symbol = "ion:musical-notes", label = "Мелодия", value = melody)
    melodyRow.onPress = { askMelody() }
    addGroup("Звонки", listOf(
      melodyRow,
      toggle("calls", "vibration", "Вибрация", "Телефон вибрирует при входящем звонке, пока приложение запущено."),
    ))

    val badge = NotificationPrefs.flag("badge", "enabled")
    addGroup("Бейдж на иконке", listOf(
      toggle("badge", "enabled", "Считать непрочитанные", "Число непрочитанных сообщений на иконке приложения."),
      toggle("badge", "countMuted", "Включая чаты без звука", "Сообщения из чатов с выключенным звуком тоже попадают в число на иконке.", enabled = badge, otherwise = false),
    ))

    val quiet = ArrayList<View>()
    for (chat in chats) {
      val settings = Core.map(chat.chat["settings"]) ?: emptyMap()
      val state = muteState(settings)
      if (state["muted"] != true) continue
      val row = MutedChatRow(context, Core.map(chat.chat["peer"]) ?: emptyMap(), account.base, chat.title, state["status"] as? String ?: "")
      row.onPress = { askMute(chat, settings) }
      row.onBell = { change(chat, mapOf("muted" to false)) }
      quiet.add(row)
    }
    if (quiet.isNotEmpty()) addGroup("Чаты без звука", quiet)
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true), 12f)

    val reset = SettingsRow(context, symbol = "ion:refresh", label = "Сбросить настройки", danger = true)
    reset.onPress = { askReset() }
    addGroup(rows = listOf(reset))
    add(SettingsLook.foot(context, "Переключатели хранятся только на этом устройстве. Выключенный звук чата действует на всех твоих устройствах: сервер просто не отправляет уведомление, пока он выключен."), 10f)
  }

  private fun askMelody() {
    val current = NotificationPrefs.ringtone
    val choices = ThemeStore.list("ringtones").mapNotNull { tone ->
      val id = tone["id"] as? String ?: return@mapNotNull null
      val label = tone["label"] as? String ?: return@mapNotNull null
      ChoiceSheet.Choice(if (id == current) "check.circle" else "circle", label) {
        NotificationPrefs.set("calls", "ringtone", id)
        fill()
      }
    }
    if (isAttachedToWindow) ChoiceSheet(context, "Мелодия звонка", choices = choices).show()
  }

  private fun askReset() {
    if (!NotificationPrefs.changed) {
      tell("Все переключатели уже стоят по умолчанию.")
      return
    }
    confirm("Сбросить настройки уведомлений?", "Все переключатели на этом устройстве вернутся к значениям по умолчанию. Звук в чатах останется как есть.", "Сбросить") {
      NotificationPrefs.reset()
      fill()
    }
  }

  /** «Выключить звук» for a chat that is quiet already: the sound back, or another time. */
  private fun askMute(chat: Messenger.ChatSummary, settings: Map<String, Any?>) {
    val choices = ArrayList<ChoiceSheet.Choice>()
    val now = muteState(settings)
    choices.add(ChoiceSheet.Choice("bell", "Включить звук", "Сейчас звук выключен " + (now["until"] as? String ?: "навсегда") + ".") { change(chat, mapOf("muted" to false)) })
    for (choice in ThemeStore.list("muteChoices")) {
      val id = choice["id"] as? String ?: continue
      val label = choice["label"] as? String ?: continue
      if (choice["ms"] is Number) {
        // The note shows the end counted from now; the end sent is counted from the moment of the choice.
        val note = muteEnd(id)?.let { preview -> "Без звука " + (muteState(mapOf("muted" to true, "mutedUntil" to preview))["until"] as? String ?: "") + "." } ?: ""
        choices.add(ChoiceSheet.Choice("clock", label, note) { muteEnd(id)?.let { until -> change(chat, mapOf("mutedUntil" to until)) } })
      } else {
        choices.add(ChoiceSheet.Choice("bell.slash", label, "Пока не включишь снова. Звонки продолжат звонить.") { change(chat, mapOf("muted" to true)) })
      }
    }
    if (isAttachedToWindow) ChoiceSheet(context, "Выключить звук", chat.title, choices).show()
  }

  /** The sound of a chat is its setting on the server: it follows the account to its other devices. */
  private fun change(chat: Messenger.ChatSummary, update: Map<String, Any?>) {
    failure = ""
    account.accountCall("chatSettings", listOf(chat.id, update)) { result ->
      if (result.isFailure) {
        failure = result.failureWords("Не удалось изменить чат.")
        if (isAttachedToWindow) fill()
      }
      load()
    }
  }

  companion object {
    /** What the page says first: the push state line, word for word the reference's (NotificationsSection.tsx) — the
     *  text, and whether it is a notice (push does not work). */
    fun pushLine(status: com.linea.messenger.push.Push.Status): Pair<String, Boolean> {
      val problem = com.linea.messenger.push.Push.text(status)
      if (problem.isNotEmpty()) return problem to true
      if (status == com.linea.messenger.push.Push.Status.ON) return "Когда приложение закрыто, уведомления показывает система. Переключатели ниже действуют, пока приложение запущено. В уведомлении только имя отправителя: текст остаётся зашифрованным." to false
      return "Разрешение на уведомления ещё не запрошено." to false
    }

    /** The sound of a chat right now (the core's `settingsMuteState`): `muted`, `until`, `status`. */
    fun muteState(settings: Map<String, Any?>, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Map<String, Any?> {
      val end = Messenger.date(settings["mutedUntil"] as? String) ?: now
      fun offset(at: Instant): Int = zone.rules.getOffset(at).totalSeconds / 60
      return Core.map(Core.view("settingsMuteState", listOf(settings, now.toEpochMilli(), offset(now), offset(end)))) ?: emptyMap()
    }

    /** The end of a silence chosen now, as the server takes it (the core's `settingsMuteUntil`). */
    fun muteEnd(choice: String, now: Instant = Instant.now()): String? = Core.view("settingsMuteUntil", listOf(choice, now.toEpochMilli())) as? String
  }
}
