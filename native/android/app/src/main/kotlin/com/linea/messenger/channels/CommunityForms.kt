package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Server
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.SettingsField
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsNotice
import com.linea.messenger.settings.SettingsPage
import com.linea.messenger.settings.SettingsRow
import com.linea.messenger.settings.SettingsTextArea

// The forms of «Каналы»: creating a community, joining by an invite link, an invitation before it is accepted,
// and sharing an invitation. Reference: CommunitiesScreen.tsx (CreateSheet, JoinSheet), InviteSheet.tsx,
// InviteCard.tsx, and the «Пригласить» sheet of CommunityScreen.tsx.

/** A field whose first letter of a sentence is a capital. */
internal fun SettingsField.sentences() { input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES }

/** «Что создаём?»: a game server or a standard channel. */
@SuppressLint("ViewConstructor")
class CommunityKindPage(context: Context, private val messenger: Messenger) : SettingsPage(context, "Что создаём?") {
  override fun build() {
    val server = SettingsRow(context, "gamecontroller", "Игровой")
    server.onPress = { open(CommunityCreatePage(context, messenger, "server")) }
    addGroup(rows = listOf(server))
    add(SettingsLook.foot(context, "Текстовые и голосовые каналы, роли, закрытые каналы для своих."))
    val blog = SettingsRow(context, "megaphone", "Стандартный")
    blog.onPress = { open(CommunityCreatePage(context, messenger, "blog")) }
    addGroup(rows = listOf(blog))
    add(SettingsLook.foot(context, "Обычный канал: блог, новости, музыка и не только. Публикуешь ты и авторы, подписчики читают."))
  }
}

/** The name, the description and (for a standard channel) what it is about; then it is created. */
@SuppressLint("ViewConstructor")
class CommunityCreatePage(context: Context, private val messenger: Messenger, private val kind: String) : SettingsPage(context, if (kind == "server") "Игровой сервер" else "Стандартный канал") {
  private val nameField = SettingsField(context, "Название", if (kind == "server") "Например, Клан «Север»" else "Например, Заметки Стейджа")
  private val aboutArea = SettingsTextArea(context, "Необязательно")
  private val createButton = SettingsButton(context, "Создать")
  private var category = "blog"
  private var busy = false

  override fun build() {
    nameField.limit = 60
    nameField.sentences()
    nameField.onEdit = { showReady() }
    aboutArea.limit = 500
    createButton.onPress = { submit() }
    render()
  }

  private fun render() {
    clear()
    add(nameField, 8f)
    add(SettingsLook.caption(context, "Описание"), 12f)
    add(aboutArea, 7f)
    if (kind == "blog") {
      addGroup("О чём канал", ChannelCategory.all.map { item ->
        SettingsRow(context, item.symbol, item.label, checked = item.id == category).apply { onPress = { category = item.id; render() } }
      })
    }
    val first = if (kind == "server") "Сразу появятся каналы #общий и #новости, голосовые «Общий» и «Игра» и роль «Модератор». Всё можно поменять."
      else "Ссылкой-приглашением можно делиться в чатах и вне мессенджера."
    add(SettingsLook.foot(context, "$first Сообщения в каналах не шифруются сквозным шифрованием."), 14f)
    add(createButton, 16f)
    showReady()
  }

  private fun showReady() {
    createButton.isEnabled = !busy && nameField.value.trim().isNotEmpty()
  }

  private fun submit() {
    val name = nameField.value.trim()
    if (name.isEmpty() || busy) return
    busy = true
    createButton.setBusy(true)
    val fields = linkedMapOf<String, Any?>("kind" to kind, "name" to name, "description" to aboutArea.value.trim())
    if (kind == "blog") fields["category"] = category
    messenger.server.ask("createCommunity", listOf(fields)) { result ->
      busy = false
      createButton.setBusy(false)
      showReady()
      val body = result.getOrNull()
      if (body == null) return@ask tell(Server.error(result).words)
      val made = Community.from(body["community"]) ?: return@ask tell("Не удалось создать.")
      ChannelsStore.put(made.summary)
      ChannelsRoute.openCommunity(this, messenger, made.id)
    }
  }
}

/** What an invitation says of the community it leads to: «Игровой · 12 участников». */
internal fun inviteDetails(community: CommunitySummary): String = (if (community.blog) ChannelCategory.label(community.category) else "Игровой") + " · " + community.countWords

/** An invitation as a card: the picture, the name, how many people, and the button that leads there
 *  (reference: InviteCard.tsx). */
@SuppressLint("ViewConstructor")
class InviteCardView(context: Context, preview: InvitePreview) : LinearLayout(context) {
  var onOpen: () -> Unit = {}

  init {
    orientation = VERTICAL
    background = context.plate(Theme.veil(0.06f), 16f, Theme.veil(0.08f))
    setPadding(context.px(12f), context.px(12f), context.px(12f), context.px(12f))
    val community = preview.community
    val kind = context.words((if (community.blog) "КАНАЛ" else "СЕРВЕР") + (if (community.closed) " · ЗАКРЫТЫЙ" else ""), 11f, Theme.muted, 700)
    kind.letterSpacing = 0.055f
    addView(kind, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    val middle = LinearLayout(context)
    middle.orientation = HORIZONTAL
    middle.gravity = Gravity.CENTER_VERTICAL
    val avatar = CommunityAvatarView(context)
    avatar.show(community)
    middle.addView(avatar, LayoutParams(context.px(48f), context.px(48f)))
    val words = LinearLayout(context)
    words.orientation = VERTICAL
    val name = context.words(community.name, 16f, Theme.text, 700)
    val details = context.words(inviteDetails(community), 12f, Theme.muted)
    for (label in listOf(name, details)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END }
    words.addView(name, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    words.addView(details, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
    middle.addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(11f) })
    addView(middle, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
    val button = context.words(if (preview.isMember) "Открыть" else if (community.blog) "Перейти в канал" else "Перейти на сервер", 14f, if (preview.isMember) Theme.text else 0xFFFFFFFF.toInt(), 700)
    button.gravity = Gravity.CENTER
    button.background = context.plate(if (preview.isMember) Theme.surface2 else 0xFF2FA36B.toInt(), 10f)
    button.contentDescription = (if (preview.isMember) "Открыть " else "Перейти: ") + community.name
    button.isClickable = true; button.isFocusable = true
    button.setOnClickListener { onOpen() }
    addView(button, LayoutParams(LayoutParams.MATCH_PARENT, context.px(38f)).apply { topMargin = context.px(10f) })
  }
}

/** «Вступить по ссылке»: a link or a code, and what it leads to. */
@SuppressLint("ViewConstructor")
class CommunityJoinPage(context: Context, private val messenger: Messenger) : SettingsPage(context, "Вступить по ссылке") {
  private val linkField = SettingsField(context, "Ссылка или код", "https://…/i/Ab3dEf9h")
  private val slot = FrameLayout(context)
  private var shownCode = ""

  override fun build() {
    linkField.onEdit = { typed() }
    add(linkField)
    add(slot, 14f)
    fill(SettingsLook.foot(context, "Вставь приглашение, которое тебе прислали."))
  }

  private fun fill(part: View) {
    slot.removeAllViews()
    slot.addView(part, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
  }

  private fun typed() {
    val code = ChannelWords.typedInviteCode(linkField.value)
    if (code == null) {
      shownCode = ""
      return fill(SettingsLook.foot(context, "Вставь приглашение, которое тебе прислали."))
    }
    if (code == shownCode) return
    shownCode = code
    fill(SettingsLook.foot(context, "Загрузка…"))
    messenger.server.ask("invite", listOf(code)) { result ->
      if (shownCode != code) return@ask
      val preview = result.getOrNull()?.let { InvitePreview.from(it) } ?: return@ask fill(SettingsNotice(context, "Приглашение недействительно"))
      val card = InviteCardView(context, preview)
      card.onOpen = {
        if (preview.isMember) ChannelsRoute.openCommunity(this, messenger, preview.community.id) else ChannelsRoute.openInvite(this, messenger, code)
      }
      fill(card)
    }
  }

  /** For the emulator check: the field filled in. */
  fun emulatorType(words: String) {
    linkField.value = words
    typed()
  }
}

/** «Приглашение»: what the invitation leads to, and the button that accepts it. */
@SuppressLint("ViewConstructor")
class InvitePage(context: Context, private val messenger: Messenger, private val code: String) : SettingsPage(context, "Приглашение") {
  private val acceptButton = SettingsButton(context, "Принять приглашение")

  override fun build() {
    add(SettingsLook.foot(context, "Загрузка…"))
    acceptButton.onPress = { accept() }
    messenger.server.ask("invite", listOf(code)) { result ->
      val body = result.getOrNull() ?: return@ask fail(Server.error(result).words)
      val preview = InvitePreview.from(body) ?: return@ask fail("Приглашение недействительно.")
      // Already there: straight to it.
      if (preview.isMember) return@ask ChannelsRoute.openCommunity(this, messenger, preview.community.id)
      show(preview.community)
    }
  }

  private fun fail(words: String) {
    clear()
    add(SettingsNotice(context, words, error = true))
  }

  private fun show(community: CommunitySummary) {
    clear()
    val avatar = CommunityAvatarView(context)
    avatar.show(community)
    val face = FrameLayout(context)
    face.addView(avatar, FrameLayout.LayoutParams(context.px(84f), context.px(84f), Gravity.CENTER_HORIZONTAL))
    add(face, 16f)
    add(context.words(community.name, 22f, Theme.text, 700).apply { gravity = Gravity.CENTER }, 12f)
    add(context.words(inviteDetails(community), 13f, Theme.muted).apply { gravity = Gravity.CENTER }, 6f)
    if (community.about.isNotEmpty()) add(context.words(community.about, 14f, Theme.muted).apply { gravity = Gravity.CENTER }, 12f)
    if (community.blog) acceptButton.label = "Подписаться"
    add(acceptButton, 20f)
  }

  private fun accept() {
    acceptButton.setBusy(true)
    messenger.server.ask("acceptInvite", listOf(code)) { result ->
      acceptButton.setBusy(false)
      val body = result.getOrNull() ?: return@ask tell(Server.error(result).words)
      val joined = Community.from(body["community"]) ?: return@ask tell("Не удалось вступить.")
      ChannelsStore.put(joined.summary)
      ChannelsRoute.openCommunity(this, messenger, joined.id)
    }
  }
}

/** «Пригласить»: the link is not shown — it is copied, shared, or sent to a chat. */
@SuppressLint("ViewConstructor")
class InviteSharePage(context: Context, private val messenger: Messenger, private val link: String) : SettingsPage(context, "Пригласить") {
  private val copyRow = SettingsRow(context, "copy", "Скопировать ссылку", arrow = false)
  private var sendingTo = ""

  override fun build() {
    copyRow.onPress = {
      (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("", link))
      copyRow.setValue("Скопировано")
    }
    val share = SettingsRow(context, "share", "Поделиться…", arrow = false)
    share.onPress = {
      val send = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, link) }
      try { context.startActivity(Intent.createChooser(send, null)) } catch (_: ActivityNotFoundException) { }
    }
    addGroup(rows = listOf(copyRow, share))
    messenger.chats { result ->
      val chats = result.getOrNull()
      if (chats.isNullOrEmpty() || !isAttachedToWindow) return@chats
      addGroup("Отправить в чат", chats.take(20).map { chat ->
        SettingsRow(context, "plane", chat.title, arrow = false).apply {
          contentDescription = "Отправить приглашение: " + chat.title
          onPress = { send(chat.id, chat.peerId) }
        }
      })
    }
  }

  /** The link goes to a chat as an ordinary (end-to-end encrypted) message. */
  private fun send(chatId: String, peerId: String) {
    if (sendingTo.isNotEmpty()) return
    sendingTo = chatId
    messenger.send(chatId, peerId, link) { result ->
      main.post {
        sendingTo = ""
        if (result.isSuccess) goBack() else tell((result.exceptionOrNull() as? com.linea.messenger.crypto.CryptoFailure)?.words ?: "Не удалось отправить.")
      }
    }
  }
}
