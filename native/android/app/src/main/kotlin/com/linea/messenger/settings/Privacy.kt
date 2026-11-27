package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words

/** One copy of the server's privacy settings for the pages that show them: a change on one page is seen on the
 *  other. (The previous app: `mobile/src/privacy/privacyStore.ts`.) */
class SettingsPrivacyModel(val account: SettingsAccount) { // Security: the lists' pages call with it (settings/PrivacyLists.kt)
  private val watchers = LinkedHashSet<() -> Unit>()
  fun watch(watcher: () -> Unit) { watchers.add(watcher) }
  fun unwatch(watcher: () -> Unit) { watchers.remove(watcher) }

  var privacy: Map<String, Any?>? = null
    private set
  var platina = false
    private set
  /** How many people are in the two lists of exceptions of «Время захода»; -1 while not known. */
  var allowCount = -1
    private set
  var denyCount = -1
    private set
  var saving = false
    private set
  var failure = ""
    private set

  private fun tell() { for (watcher in watchers.toList()) watcher() }

  /** The mode of «Время захода», old servers included: they only know the on/off switch. */
  val lastSeen: String get() = lastSeenMode(privacy)

  fun flag(name: String, otherwise: Boolean): Boolean = privacy?.get(name) as? Boolean ?: otherwise

  fun word(name: String, otherwise: String): String = (privacy?.get(name) as? String)?.takeIf { it.isNotEmpty() } ?: otherwise

  fun load() {
    failure = ""
    tell()
    account.accountCall("privacy", emptyList()) { result ->
      val body = result.getOrNull()
      if (body != null) {
        Core.map(body["privacy"])?.let { privacy = it }
        platina = body["platina"] as? Boolean ?: false
      } else {
        failure = result.failureWords("Не удалось загрузить настройки.")
      }
      tell()
    }
    account.accountCall("lastSeenRules", emptyList()) { result ->
      val body = result.getOrNull() ?: return@accountCall
      allowCount = (body["allow"] as? List<*>)?.size ?: 0
      denyCount = (body["deny"] as? List<*>)?.size ?: 0
      tell()
    }
  }

  /** The setting moves at once and comes back if the server refuses. */
  fun change(patch: Map<String, Any?>) {
    val previous = privacy
    if (previous == null || saving) return tell()
    val next = LinkedHashMap(previous)
    next.putAll(patch)
    (patch["lastSeen"] as? String)?.let { next["showLastSeen"] = it != "nobody" }
    privacy = next
    saving = true
    failure = ""
    tell()
    account.accountCall("updatePrivacy", listOf(patch)) { result ->
      saving = false
      val body = result.getOrNull()
      if (body != null) {
        Core.map(body["privacy"])?.let { privacy = it }
        platina = body["platina"] as? Boolean ?: false
      } else {
        privacy = previous
        failure = result.failureWords("Не удалось сохранить.")
      }
      tell()
    }
  }

  /** The value of the «Время захода» row: «Все», «Мои друзья (−1, +2)», «Никто (+3)». */
  val lastSeenSummary: String get() = lastSeenSummary(lastSeen, allowCount, denyCount)

  companion object {
    val lastSeenModes = listOf("everyone" to "Все", "contacts" to "Мои друзья", "nobody" to "Никто")

    fun lastSeenMode(privacy: Map<String, Any?>?): String {
      (privacy?.get("lastSeen") as? String)?.takeIf { it.isNotEmpty() }?.let { return it }
      if (privacy?.get("showLastSeen") == false) return "nobody"
      return "everyone"
    }

    fun lastSeenSummary(mode: String, allowCount: Int, denyCount: Int): String {
      val label = lastSeenModes.firstOrNull { it.first == mode }?.second ?: "Все"
      val parts = ArrayList<String>()
      if (mode != "nobody" && denyCount > 0) parts.add("−$denyCount")
      if (mode != "everyone" && allowCount > 0) parts.add("+$allowCount")
      return if (parts.isEmpty()) label else label + " (" + parts.joinToString(", ") + ")"
    }
  }
}

/** «Конфиденциальность»: what the server shows of the person to others, and who may reach them.
 *  (The previous app: `PrivacySection` of `mobile/src/SettingsScreen.tsx`.) */
@SuppressLint("ViewConstructor")
class PrivacyScreen(context: Context, account: SettingsAccount) : SettingsPage(context, "Конфиденциальность") {
  private val model = SettingsPrivacyModel(account)
  private val changed: () -> Unit = { fill() }
  /** The inline call lists, kept while «Кто может звонить» stays the same. */
  private var callLists: CallRulesInline? = null
  private var callListsMode = ""

  private class Choice(val value: String, val label: String, val hint: String)

  private val audiences = listOf(
    Choice("friends", "Друзья", "Истории и записи видят только твои друзья."),
    Choice("everyone", "Все", "Истории и записи видит любой, кого ты не заблокировал."),
  )
  private val callModes = listOf(
    Choice("everyone", "Все", "Позвонить может любой, кроме тех, кто в списке «Никогда»."),
    Choice("contacts", "Друзья", "Только люди из твоих друзей и из списка «Разрешить»."),
    Choice("allowed", "Разрешённые", "Только люди из списка «Разрешить»."),
  )

  override fun build() {
    model.watch(changed)
    model.load()
  }

  override fun onDetachedFromWindow() {
    model.unwatch(changed)
    super.onDetachedFromWindow()
  }

  private fun fill() {
    clear()
    val model = this.model
    if (model.failure.isNotEmpty()) {
      if (model.privacy == null) add(SettingsNotice(context, model.failure, error = true, onRetry = { model.load() }))
      else add(SettingsNotice(context, model.failure, error = true))
    }
    // Security: the device lock sits first on the privacy screen (settings/PasscodeSettings.kt).
    val passcode = SettingsRow(context, symbol = "ion:keypad", label = "Код-пароль", value = if (com.linea.messenger.security.LockStore.current.record != null) "Вкл." else "Выкл.")
    passcode.onPress = { open(PasscodeScreen(context)) }
    addGroup("Безопасность", listOf(passcode))
    if (model.privacy == null) {
      if (model.failure.isEmpty()) add(SettingsLook.foot(context, "Загрузка…"), 16f)
      return
    }
    val saving = model.saving
    val platina = model.platina

    val lastSeen = SettingsRow(context, symbol = "ion:time", label = "Время захода", value = model.lastSeenSummary)
    lastSeen.onPress = { open(LastSeenScreen(context, model)) }
    val newChats = SettingsSwitchRow(context, "Новые разговоры", "Кто ещё не писал тебе, сможет начать чат. Выключи, чтобы писали только те, с кем переписка уже есть.",
      value = model.flag("allowNewChats", true), enabled = !saving)
    newChats.onChange = { value -> model.change(mapOf("allowNewChats" to value)) }
    val photo = SettingsSwitchRow(context, "Фото профиля для других", "Если выключить, собеседники и поиск увидят цветной аватар вместо фото.",
      value = model.flag("showAvatar", true), enabled = !saving)
    photo.onChange = { value -> model.change(mapOf("showAvatar" to value)) }
    val receipts = SettingsSwitchRow(context, "Отчёты о прочтении",
      if (platina) "Взаимно: если выключить, ты тоже не увидишь, прочитали ли твои сообщения." else "Скрывать прочтение можно с Platina.",
      value = model.flag("readReceipts", true), enabled = !saving && platina, badge = if (platina) "" else "Platina")
    receipts.onChange = { value -> model.change(mapOf("readReceipts" to value)) }
    addGroup("На сервере", listOf(lastSeen, newChats, photo, receipts))

    val audienceIndex = audiences.indexOfFirst { it.value == model.word("posts", "friends") }.coerceAtLeast(0)
    val audienceBox = choice("Кто видит мои истории и записи", audiences[audienceIndex].hint, hintFirst = false, labels = audiences.map { it.label },
      chosen = audienceIndex, enabled = !saving, spoken = "") { index ->
      if (index != audienceIndex) model.change(mapOf("posts" to audiences[index].value))
    }
    addGroup("Истории и записи", listOf(audienceBox))

    val callIndex = callModes.indexOfFirst { it.value == model.word("calls", "everyone") }.coerceAtLeast(0)
    val callBox = choice("Кто может звонить", callModes[callIndex].hint, hintFirst = true, labels = callModes.map { it.label },
      chosen = callIndex, enabled = !saving, spoken = "Звонки") { index ->
      if (index != callIndex) model.change(mapOf("calls" to callModes[index].value))
    }
    // CallPrivacy.tsx: the lists «Разрешить» and «Никогда» right under the choice, in the same card (12 under the segments,
    // 14 at the sides and below); kept while the choice stays the same.
    val calls = model.word("calls", "everyone")
    val lists = callLists?.takeIf { callListsMode == calls } ?: CallRulesInline(context, model.account, calls).also { callLists = it; callListsMode = calls }
    (lists.parent as? android.view.ViewGroup)?.removeView(lists)
    val callCard = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    callCard.addView(callBox)
    callCard.addView(SettingsLook.inset(lists, side = 14f, bottom = 14f), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = -context.px(2f) })
    addGroup("Звонки", listOf(callCard))

    // «На этом устройстве» — the typing notice (SettingsScreen.tsx; DevicePreferences `sendTyping`).
    val typing = SettingsSwitchRow(context, "Показывать «печатает…»", "Собеседник видит, что ты набираешь сообщение, записываешь или отправляешь голосовое, видео или файл.", DevicePreferences.flag("sendTyping") ?: true)
    typing.onChange = { value -> DevicePreferences.set(mapOf("sendTyping" to value)) }
    addGroup("На этом устройстве", listOf(typing))

    add(SettingsLook.foot(context, "Содержимое сообщений, ответы, реакции, правки и закрепления шифруются на устройстве. Сервер видит только служебные данные: кто, кому и когда."), 16f)
  }

  /** A heading, one of several side by side, and the words about the chosen one. */
  private fun choice(heading: String, hint: String, hintFirst: Boolean, labels: List<String>, chosen: Int, enabled: Boolean, spoken: String, pick: (Int) -> Unit): View {
    val name = context.words(heading, 15f, Theme.text, 600)
    val about = context.words(hint, 12.5f, Theme.muted)
    val segments = SettingsSegments(context, labels, chosen, enabled, spoken)
    segments.onPick = pick
    val box = LinearLayout(context)
    box.orientation = LinearLayout.VERTICAL
    val parts = if (hintFirst) listOf(name, about, segments) else listOf(name, segments, about)
    parts.forEachIndexed { index, part ->
      box.addView(part, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        topMargin = if (index == 0) 0 else context.px(if (hintFirst && index == 1) 3f else 12f)
      })
    }
    return SettingsLook.inset(box, top = 14f, side = 14f, bottom = 14f)
  }
}

/** «Время захода»: who sees when the person was last here, and whether the time of reading is hidden with it.
 *  (The previous app: `LastSeenSection` of `mobile/src/SettingsScreen.tsx`.) */
@SuppressLint("ViewConstructor")
class LastSeenScreen(context: Context, private val model: SettingsPrivacyModel) : SettingsPage(context, "Время захода") {
  private val changed: () -> Unit = { fill() }

  override fun build() {
    model.watch(changed)
    fill()
  }

  override fun onDetachedFromWindow() {
    model.unwatch(changed)
    super.onDetachedFromWindow()
  }

  private fun fill() {
    clear()
    val model = this.model
    if (model.privacy == null) {
      if (model.failure.isEmpty()) add(SettingsLook.foot(context, "Загрузка…"), 16f)
      else add(SettingsNotice(context, model.failure, error = true, onRetry = { model.load() }))
      return
    }
    if (model.failure.isNotEmpty()) add(SettingsNotice(context, model.failure, error = true))
    val mode = model.lastSeen
    val saving = model.saving
    val rows = SettingsPrivacyModel.lastSeenModes.map { (value, label) ->
      val on = value == mode
      val row = SettingsRow(context, label = label, checked = on)
      row.isEnabled = !saving
      row.onPress = { if (!on) model.change(mapOf("lastSeen" to value)) }
      row
    }
    addGroup("Кто видит, когда я в сети", rows)
    add(SettingsLook.foot(context, "Без подписки Platina вы не будете видеть появление в сети и время последнего захода пользователей, от которых скрыли свои. Вместо точного времени будет видно примерное значение (недавно, на этой неделе, в этом месяце)."), 8f)
    // Security: «Исключения» — «Всегда показывать» (not with «Все»), «Никогда не показывать» (not with «Никто») (settings/PrivacyLists.kt).
    val lists = ArrayList<View>()
    fun count(people: Int): String = if (people < 0) "" else if (people > 0) people.toString() else "Добавить"
    if (mode != "everyone") lists.add(SettingsRow(context, symbol = "ion:checkmark-circle", label = "Всегда показывать", value = count(model.allowCount)).apply { onPress = { open(LastSeenExceptionsScreen(context, model.account, model, "allow")) } })
    if (mode != "nobody") lists.add(SettingsRow(context, symbol = "ion:remove-circle", label = "Никогда не показывать", value = count(model.denyCount)).apply { onPress = { open(LastSeenExceptionsScreen(context, model.account, model, "deny")) } })
    addGroup("Исключения", lists)
    add(SettingsLook.foot(context, "Вы можете добавить пользователей в список исключений из настроек выше."), 8f)

    // The time of reading can be hidden once the time of coming is hidden from anyone.
    if (mode != "everyone" || model.denyCount > 0) {
      val hide = SettingsSwitchRow(context, "Скрывать время прочтения", "", value = model.flag("hideReadTime", false), enabled = !saving)
      hide.onChange = { value -> model.change(mapOf("hideReadTime" to value)) }
      addGroup(rows = listOf(hide))
      add(SettingsLook.foot(context, "Не показывать время прочтения сообщений пользователям, от которых вы скрыли время захода. Если включить, их время прочтения тоже будет скрыто от вас. Отметки о прочтении при этом остаются. Подписчики Platina видят время прочтения, даже если скрыли своё."), 8f)
    }
  }
}
