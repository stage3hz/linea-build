package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.Picks
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.PersonProfileScreen
import com.linea.messenger.people.personAvatarAddress
import com.linea.messenger.people.preparePersonAvatars
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.SettingsField
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsNotice
import com.linea.messenger.settings.SettingsPage
import com.linea.messenger.settings.SettingsRow
import com.linea.messenger.settings.SettingsSwitchRow
import com.linea.messenger.settings.SettingsTextArea
import java.io.ByteArrayOutputStream

// The settings of a community: its name and picture, its channels and who sees them, its roles and their
// rights, its members, the people it does not let back in. Every part is shown only to those who have the
// right; the server checks the rights and the order of roles again.
// Reference: mobile/src/communities/CommunitySettings.tsx and MemberMenu.tsx.

@SuppressLint("ViewConstructor")
class CommunitySettingsPage(context: Context, private val messenger: Messenger?, private var community: Community) : SettingsPage(context, "Настройки") {
  var onChanged: ((Community) -> Unit)? = null
  var onInvite: (() -> Unit)? = null
  private var members: List<CommunityMember>? = null
  private val nameField = SettingsField(context, "Название", "")
  private val aboutArea = SettingsTextArea(context, "Описание")
  private val saveButton = SettingsButton(context, "Сохранить")
  private var busy = false
  private var showing = false

  private val blog: Boolean get() = community.blog
  private val owner: Boolean get() = messenger != null && community.summary.ownerId == messenger.userId

  override fun build() {
    messenger?.preparePersonAvatars()
    nameField.limit = 60
    nameField.sentences()
    nameField.value = community.summary.name
    nameField.onEdit = { showSave() }
    aboutArea.limit = 500
    aboutArea.value = community.summary.about
    aboutArea.onEdit = { showSave() }
    saveButton.onPress = { save() }
    render()
    loadMembers()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    // Back from a page that changed a role, a channel or a member: read again.
    if (isVisible && !showing && built && members != null) refresh()
    showing = isVisible
  }

  // The page

  private fun render() {
    clear()
    val avatar = CommunityAvatarView(context)
    avatar.show(community.summary)
    val face = FrameLayout(context)
    face.addView(avatar, FrameLayout.LayoutParams(context.px(86f), context.px(86f), Gravity.CENTER_HORIZONTAL))
    if (community.can(Perm.manageCommunity)) {
      avatar.isClickable = true
      avatar.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      avatar.contentDescription = "Сменить фото"
      avatar.setOnClickListener { pickAvatar() }
    }
    add(face, 8f)
    add(context.words(if (blog) ChannelCategory.label(community.summary.category) else "Игровой", 11f, Theme.muted, 700).apply { gravity = Gravity.CENTER }, 10f)

    if (community.can(Perm.manageCommunity)) {
      add(nameField, 16f)
      add(SettingsLook.caption(context, "Описание"), 12f)
      add(aboutArea, 7f)
      if (blog) {
        addGroup("О чём канал", ChannelCategory.all.map { item ->
          SettingsRow(context, item.symbol, item.label, checked = item.id == community.summary.category).apply { onPress = { update(mapOf("category" to item.id), "") } }
        })
      }
      val closed = SettingsSwitchRow(context, if (blog) "Закрытый канал" else "Закрытый сервер",
        "Ссылки-приглашения создаёшь только ты и те, у кого есть право «Менять название и фото»; ссылки остальных участников не действуют, а баннер приглашения нельзя переслать внутри Инвиза.",
        community.summary.closed)
      closed.onChange = { on -> update(mapOf("closed" to on), "") }
      addGroup(rows = listOf(closed))
      add(saveButton, 14f)
      showSave()
    }
    if (community.can(Perm.invite)) {
      addGroup("Приглашения", listOf(SettingsRow(context, "link", "Ссылка-приглашение").apply { onPress = { onInvite?.invoke() } }))
    }
    if (!blog && community.can(Perm.manageChannels)) {
      val rows = community.channels.map { channel ->
        SettingsRow(context, if (channel.isText) "bubble" else "speaker", if (channel.isText) "# " + channel.name else channel.name, if (channel.roleIds.isEmpty()) "" else "по ролям")
          .apply { onPress = { openChannel(channel, channel.kind) } }
      }
      val text = SettingsRow(context, "plus", "Текстовый канал").apply { onPress = { openChannel(null, "text") } }
      val voice = SettingsRow(context, "plus", "Голосовой канал").apply { onPress = { openChannel(null, "voice") } }
      addGroup("Каналы", rows + listOf(text, voice))
    }
    if (community.can(Perm.manageRoles)) {
      val rows = community.roles.map { role ->
        SettingsRow(context, if (role.isDefault) "people" else "shield", role.name, if (role.isDefault) "все" else "", swatch = if (role.isDefault) null else role.color)
          .apply { onPress = { openRole(role) } }
      }
      addGroup("Роли", rows + listOf(SettingsRow(context, "plus", "Новая роль").apply { onPress = { openRole(null) } }))
    }
    val known = members
    if (known != null) {
      val pressable = community.can(Perm.manageRoles) || community.can(Perm.kick) || community.can(Perm.ban)
      val rows = known.map { member ->
        MemberRow(context, member, community, messenger?.personAvatarAddress(member.user.avatarId) ?: "").apply {
          isEnabled = pressable
          onPress = { openMember(member) }
        }
      }
      if (rows.isNotEmpty()) addGroup(if (blog) "Подписчики" else "Участники", rows)
    } else {
      add(SettingsLook.caption(context, if (blog) "Подписчики" else "Участники"), 14f)
      add(SettingsLook.foot(context, "Загрузка…"), 7f)
    }
    if (community.can(Perm.ban)) {
      addGroup("Блокировки", listOf(SettingsRow(context, "blocked", "Заблокированные").apply {
        onPress = { messenger?.let { open(CommunityBansPage(context, it, community.id)) } }
      }))
    }
    val leaveRow = SettingsRow(context, if (owner) "trash" else "exit", if (owner) "Удалить сообщество" else if (blog) "Отписаться" else "Покинуть сервер", danger = true)
    leaveRow.onPress = { askExit() }
    addGroup("Сообщество", listOf(leaveRow))
    val note = context.words("Каналы и серверы не шифруются сквозным шифрованием: сообщения хранятся на сервере Инвиза. Личные чаты по-прежнему зашифрованы.", 12f, Theme.subtle)
    note.gravity = Gravity.CENTER
    add(SettingsLook.inset(note, side = 10f), 16f)
  }

  private fun showSave() {
    val name = nameField.value.trim()
    saveButton.isEnabled = !busy && name.isNotEmpty() && (nameField.value != community.summary.name || aboutArea.value != community.summary.about)
  }

  // Reading and changing

  private fun loadMembers() {
    val messenger = messenger
    if (messenger == null) {
      if (ChannelsDemo.present) { members = ChannelsDemo.members(); render() }
      return
    }
    messenger.server.ask("communityMembers", listOf(community.id)) { result ->
      val body = result.getOrNull()
      if (body != null) {
        members = CommunityMember.list(body["members"])
        render()
      } else if (members == null) tell(Server.error(result).words)
    }
  }

  /** Reads the community and its members again and shows them. */
  private fun refresh() {
    val messenger = messenger ?: return
    messenger.server.ask("community", listOf(community.id)) { result ->
      Community.from(result.getOrNull()?.get("community"))?.let { took(it) }
    }
    loadMembers()
  }

  private fun took(found: Community) {
    community = found
    ChannelsStore.put(found.summary)
    onChanged?.invoke(found)
    render()
  }

  private fun update(fields: Map<String, Any?>, done: String) {
    val messenger = messenger ?: return
    // Something is being saved already: the page shows what is true again (a switch does not stay flipped).
    if (busy) return render()
    busy = true
    showSave()
    messenger.server.ask("updateCommunity", listOf(community.id, fields)) { result ->
      busy = false
      saveButton.setBusy(false)
      val body = result.getOrNull()
      if (body != null) {
        Community.from(body["community"])?.let { took(it) }
        if (done.isNotEmpty()) tell(done)
      } else {
        render()
        tell(Server.error(result).words)
      }
    }
  }

  private fun save() {
    if (busy) return
    saveButton.setBusy(true)
    update(mapOf("name" to nameField.value.trim(), "description" to aboutArea.value.trim()), "Сохранено.")
  }

  private fun askExit() {
    val messenger = messenger ?: return
    val deleting = owner
    confirm(if (deleting) "Удалить сообщество?" else if (blog) "Отписаться?" else "Покинуть сервер?",
      if (deleting) "Каналы, сообщения и приглашения удалятся у всех. Это нельзя отменить." else "Вернуться можно по ссылке-приглашению.",
      if (deleting) "Удалить" else "Выйти") {
      val id = community.id
      messenger.server.ask(if (deleting) "deleteCommunity" else "leaveCommunity", listOf(id)) { result ->
        if (result.isSuccess) {
          ChannelsStore.remove(id)
          ChannelsRoute.closeCommunity(this)
        } else tell(Server.error(result).words)
      }
    }
  }

  private fun openChannel(channel: CommunityChannel?, kind: String) { messenger?.let { open(ChannelEditPage(context, it, community, channel, kind)) } }
  private fun openRole(role: CommunityRole?) { messenger?.let { open(RoleEditPage(context, it, community, role, owner)) } }
  private fun openMember(member: CommunityMember) {
    val messenger = messenger ?: return
    val page = MemberPage(context, messenger, community, member)
    page.onParted = { words -> post { tell(words) } }
    open(page)
  }

  // The picture

  private fun pickAvatar() {
    if (messenger == null || busy) return
    var owner: Context? = context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    val activity = owner as? Activity ?: return
    // The system's photo picker returns only the chosen picture, readable for this one time: no permission.
    val asked = Picks.ask(activity, ChannelPick.photo()) { chosen -> picked(chosen.firstOrNull()) }
      || Picks.ask(activity, ChatAttachments.documentPicker("image/*")) { chosen -> picked(chosen.firstOrNull()) }
    if (!asked) tell("Не удалось открыть галерею.")
  }

  private fun picked(uri: Uri?) {
    val messenger = messenger ?: return
    if (uri == null || busy) return
    busy = true
    val server = messenger.server
    val id = community.id
    val resolver = context.contentResolver
    ChannelPick.work.execute {
      // The picture is drawn anew as a 512-pixel square: nothing of the original file goes up.
      var outcome: Result<Any?> = Result.failure(ServerError.Network("Не удалось обработать фото. Файл не отправлен."))
      val jpeg = CommunityPicture.square(resolver, uri)
      if (jpeg != null) {
        val uploaded = server.uploadPlainFile(jpeg, "community.jpg", "image/jpeg", null)
        val file = uploaded.getOrNull()
        outcome = if (file == null) Result.failure(Server.error(uploaded)) else server.opAndWait("updateCommunity", listOf(id, mapOf("avatarId" to (file["id"] as? String ?: ""))))
      }
      main.post {
        busy = false
        if (outcome.isSuccess) {
          Community.from(Core.map(outcome.getOrNull() as? Map<*, *>)?.get("community"))?.let { took(it) }
          tell("Фото обновлено.")
        } else tell(Server.error(outcome).words)
      }
    }
  }
}

/** A community's picture got ready for the server. */
object CommunityPicture {
  private const val SIDE = 512

  private fun decode(resolver: ContentResolver, uri: Uri): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 28) New.decode(resolver, uri) else old(resolver, uri)
  } catch (_: Throwable) { null }

  @android.annotation.TargetApi(28)
  private object New {
    fun decode(resolver: ContentResolver, uri: Uri): Bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
      val size = ChannelPixels.fit(info.size.width, info.size.height, 1024)
      decoder.setTargetSize(size.first, size.second)
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
  }

  private fun old(resolver: ContentResolver, uri: Uri): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply { inSampleSize = ChannelPixels.sample(bounds.outWidth, bounds.outHeight, 1024) }
    return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
  }

  /** The middle square of a picture at 512 pixels on white, as a JPEG that has not yet been cleaned. */
  fun squared(decoded: Bitmap): ByteArray? {
    if (decoded.width <= 0 || decoded.height <= 0) return null
    val made = Bitmap.createBitmap(SIDE, SIDE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(made)
    canvas.drawColor(Color.WHITE)
    val scale = maxOf(SIDE.toFloat() / decoded.width, SIDE.toFloat() / decoded.height)
    val w = decoded.width * scale; val h = decoded.height * scale
    canvas.drawBitmap(decoded, null, RectF((SIDE - w) / 2, (SIDE - h) / 2, (SIDE + w) / 2, (SIDE + h) / 2), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    val out = ByteArrayOutputStream()
    val written = made.compress(Bitmap.CompressFormat.JPEG, 86, out)
    made.recycle()
    return if (written) out.toByteArray() else null
  }

  /** The middle square of a picture file at 512 pixels, as a clean JPEG. Not on the main thread. */
  fun square(resolver: ContentResolver, uri: Uri): ByteArray? {
    val decoded = decode(resolver, uri) ?: return null
    val jpeg = squared(decoded)
    decoded.recycle()
    return jpeg?.let { FileCore.cleanJpeg(it).getOrNull() }
  }
}

/** A member in the settings: the picture, the name in the colour of the highest role, the roles. */
@SuppressLint("ViewConstructor")
class MemberRow(context: Context, member: CommunityMember, community: Community, address: String) : ViewGroup(context) {
  var onPress: (() -> Unit)? = null
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val avatar = PersonAvatarView(context)
  private val nameLabel = context.words(member.user.displayName + (if (member.owner) " 👑" else ""), 15f, community.nameColor(member.roleIds)?.let { 0xFF000000.toInt() or it } ?: Theme.text, 600)
  private val rolesLabel = context.words(words(member, community), 12f, Theme.muted)

  init {
    avatar.show(member.user, address)
    addView(avatar)
    for (label in listOf(nameLabel, rolesLabel)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.gravity = Gravity.CENTER_VERTICAL; addView(label) }
    isClickable = true; isFocusable = true
    contentDescription = member.user.displayName
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setPressed(pressed: Boolean) {
    super.setPressed(pressed)
    setBackgroundColor(if (pressed) SettingsLook.pressed else 0)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(52f))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    avatar.layout(dp(14f), dp(8f), dp(50f), dp(44f))
    for ((label, top, tall) in listOf(Triple(nameLabel, 8f, 19f), Triple(rolesLabel, 28f, 16f))) {
      label.measure(MeasureSpec.makeMeasureSpec((width - dp(76f)).coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(tall), MeasureSpec.EXACTLY))
      label.layout(dp(62f), dp(top), width - dp(14f), dp(top + tall))
    }
  }

  companion object {
    /** The quiet line of a member: the names of their roles, else their @username. */
    fun words(member: CommunityMember, community: Community): String =
      community.roles.filter { member.roleIds.contains(it.id) }.joinToString(", ") { it.name }.ifEmpty { "@" + member.user.username }
  }
}

/** A member: their roles, and the two ways to part with them. */
@SuppressLint("ViewConstructor")
class MemberPage(context: Context, private val messenger: Messenger, private val community: Community, private val member: CommunityMember) : SettingsPage(context, member.user.displayName) {
  private var roleIds = member.roleIds
  private var busy = false
  /** The member was excluded or blocked: the words about it, for the page this one returns to. */
  var onParted: ((String) -> Unit)? = null

  override fun build() = render()

  private fun render() {
    clear()
    val profile = SettingsRow(context, "person", "Профиль")
    profile.onPress = { open(PersonProfileScreen(context, messenger, member.user.id, member.user.displayName, member.user)) }
    addGroup(rows = listOf(profile))
    if (community.can(Perm.manageRoles)) {
      val rows = community.roles.filter { !it.isDefault }.map { role ->
        SettingsSwitchRow(context, role.name, "", roleIds.contains(role.id), enabled = !busy).apply { onChange = { on -> setRole(role.id, on) } }
      }
      if (rows.isNotEmpty()) addGroup("Роли", rows)
    }
    val other = !member.owner && member.user.id != messenger.userId
    val rows = ArrayList<View>()
    if (other && community.can(Perm.kick)) rows.add(SettingsRow(context, "person.minus", "Исключить", danger = true).apply { onPress = { part("kickMember", "Участник исключён.") } })
    if (other && community.can(Perm.ban)) rows.add(SettingsRow(context, "blocked", "Заблокировать", danger = true).apply { onPress = { part("banMember", "Участник заблокирован.") } })
    if (rows.isNotEmpty()) {
      addGroup(rows = rows)
      if (other && community.can(Perm.ban)) add(SettingsLook.foot(context, "Заблокировать: исключить и не пускать обратно по приглашениям"))
    }
  }

  private fun setRole(id: String, on: Boolean) {
    // Another change is on its way: nothing is sent, and the switch shows what is saved again.
    if (busy) { post { render() }; return }
    busy = true
    val wanted = roleIds.filter { it != id } + (if (on) listOf(id) else emptyList())
    messenger.server.ask("setMemberRoles", listOf(community.id, member.user.id, wanted)) { result ->
      busy = false
      val body = result.getOrNull()
      if (body != null) roleIds = (body["roleIds"] as? List<*>)?.mapNotNull { it as? String } ?: wanted else tell(Server.error(result).words)
      render()
    }
  }

  private fun part(operation: String, done: String) {
    if (busy) return
    busy = true
    messenger.server.ask(operation, listOf(community.id, member.user.id)) { result ->
      busy = false
      if (result.isSuccess) {
        goBack()
        onParted?.invoke(done)
      } else tell(Server.error(result).words)
    }
  }
}

/** The people a community does not let back in; a touch lets one back. */
@SuppressLint("ViewConstructor")
class CommunityBansPage(context: Context, private val messenger: Messenger, private val communityId: String) : SettingsPage(context, "Заблокированные") {
  override fun build() {
    add(SettingsLook.foot(context, "Загрузка…"))
    read()
  }

  private fun read() {
    messenger.server.ask("communityBans", listOf(communityId)) { result ->
      clear()
      val body = result.getOrNull() ?: return@ask add(SettingsNotice(context, Server.error(result).words, error = true, onRetry = { read() }))
      val bans = (body["bans"] as? List<*>).orEmpty().mapNotNull { Core.map(it as? Map<*, *>) }
      if (bans.isEmpty()) return@ask add(SettingsLook.foot(context, "Никого нет."))
      for (ban in bans) {
        val person = Person.from(ban["user"]) ?: continue
        addGroup(rows = listOf(SettingsRow(context, "person", person.displayName, arrow = false).apply { onPress = { letBack(person.id) } }))
        add(SettingsLook.foot(context, banWords(ban["reason"] as? String ?: "")))
      }
    }
  }

  private fun letBack(userId: String) {
    messenger.server.ask("unbanMember", listOf(communityId, userId)) { result ->
      if (result.isFailure) tell(Server.error(result).words) else read()
    }
  }

  companion object {
    fun banWords(reason: String): String = if (reason.isEmpty()) "Нажми, чтобы разблокировать" else "Причина: $reason · нажми, чтобы разблокировать"
  }
}

/** The colours a role can have, as round swatches; the chosen one is ringed. */
@SuppressLint("ViewConstructor")
class RoleColorStrip(context: Context, private var chosen: String) : LinearLayout(context) {
  var onPick: (String) -> Unit = {}
  private val buttons = ArrayList<View>()

  init {
    orientation = HORIZONTAL
    setPadding(context.px(2f), 0, 0, 0)
    for ((hex, spoken) in ChannelWords.roleColors) {
      val button = View(context)
      button.isClickable = true; button.isFocusable = true
      button.contentDescription = "Цвет роли: $spoken"
      button.setOnClickListener { chosen = hex; paint(); onPick(hex) }
      addView(button, LayoutParams(context.px(32f), context.px(32f)).apply { rightMargin = context.px(9f) })
      buttons.add(button)
    }
    paint()
  }

  private fun paint() {
    buttons.forEachIndexed { index, button ->
      val hex = ChannelWords.roleColors[index].first
      val on = hex.equals(chosen, ignoreCase = true)
      button.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(0xFF000000.toInt() or Messenger.color(hex))
        if (on) setStroke(context.px(3f), Theme.text)
      }
      button.isSelected = on
    }
  }
}

/** A role: its name, its colour and what it lets its people do. `role` null: a new one. */
@SuppressLint("ViewConstructor")
class RoleEditPage(context: Context, private val messenger: Messenger, private val community: Community, private val role: CommunityRole?, private val owner: Boolean)
  : SettingsPage(context, if (role == null) "Новая роль" else if (role.isDefault) "Права: " + role.name else "Роль") {
  private val nameField = SettingsField(context, "Название", "Например, Ветераны")
  private val saveButton = SettingsButton(context, "Сохранить")
  private var color = role?.colorHex ?: ChannelWords.roleColors[0].first
  private var perms = role?.perms ?: (Perm.send or Perm.voice)

  override fun build() {
    if (role?.isDefault == true) {
      add(SettingsLook.foot(context, "Эти права есть у всех участников."))
    } else {
      nameField.limit = 32
      nameField.sentences()
      nameField.value = role?.name ?: ""
      add(nameField)
      add(RoleColorStrip(context, color).apply { onPick = { hex -> color = hex } }, 12f)
    }
    addGroup(rows = rights(community.blog, owner).map { item ->
      SettingsSwitchRow(context, item.label, "", perms and item.bit != 0).apply { onChange = { on -> perms = if (on) perms or item.bit else perms and item.bit.inv() } }
    })
    saveButton.onPress = { save() }
    add(saveButton, 16f)
    if (role != null && !role.isDefault) {
      add(SettingsButton(context, "Удалить роль", SettingsButton.Kind.DANGER).apply { onPress = { finish("deleteRole", listOf(community.id, role.id)) } }, 10f)
    }
  }

  private fun save() {
    val name = nameField.value.trim()
    if (role != null) {
      val fields = linkedMapOf<String, Any?>("perms" to perms)
      if (!role.isDefault) { fields["name"] = name; fields["color"] = color }
      finish("updateRole", listOf(community.id, role.id, fields))
    } else {
      finish("createRole", listOf(community.id, mapOf("name" to name.ifEmpty { "Новая роль" }, "color" to color, "perms" to perms)))
    }
  }

  private fun finish(operation: String, args: List<Any?>) {
    saveButton.setBusy(true)
    messenger.server.ask(operation, args) { result ->
      saveButton.setBusy(false)
      if (result.isSuccess) goBack() else tell(Server.error(result).words)
    }
  }

  companion object {
    /** The rights a role of this kind of community can be given; «Администратор» only by the owner. */
    fun rights(blog: Boolean, owner: Boolean): List<Perm.Label> =
      Perm.labels.filter { item -> !(if (blog) item.server else item.blog) && (owner || item.bit != Perm.admin) }
  }
}

/** A channel: its name, its topic and who sees it. `channel` null: a new one of `kind`. */
@SuppressLint("ViewConstructor")
class ChannelEditPage(context: Context, private val messenger: Messenger, private val community: Community, private val channel: CommunityChannel?, private val kind: String)
  : SettingsPage(context, if (channel != null) "Канал" else if (kind == "voice") "Новый голосовой канал" else "Новый текстовый канал") {
  private val nameField = SettingsField(context, "Название", if (kind == "voice") "Например, Катка" else "например, мемы")
  private val topicField = SettingsField(context, "Тема", "О чём этот канал")
  private val saveButton = SettingsButton(context, if (channel == null) "Создать" else "Сохранить")
  private var roleIds = channel?.roleIds ?: emptyList()

  override fun build() {
    nameField.limit = 40
    nameField.value = channel?.name ?: ""
    nameField.onEdit = { showReady() }
    add(nameField)
    if (kind == "text") {
      topicField.limit = 200
      topicField.sentences()
      topicField.value = channel?.topic ?: ""
      add(topicField, 12f)
    }
    add(SettingsLook.caption(context, "Кто видит"), 14f)
    add(SettingsLook.foot(context, "Ничего не выбрано — канал видят все участники. Выбери роли, чтобы сделать канал закрытым."), 6f)
    val rows = community.roles.filter { !it.isDefault }.map { role ->
      SettingsSwitchRow(context, role.name, "", roleIds.contains(role.id)).apply { onChange = { on -> roleIds = roleIds.filter { it != role.id } + (if (on) listOf(role.id) else emptyList()) } }
    }
    if (rows.isNotEmpty()) addGroup(rows = rows)
    saveButton.onPress = { save() }
    add(saveButton, 16f)
    if (channel != null) {
      add(SettingsButton(context, "Удалить канал", SettingsButton.Kind.DANGER).apply { onPress = { finish("deleteChannel", listOf(community.id, channel.id)) } }, 10f)
    }
    showReady()
  }

  private fun showReady() {
    saveButton.isEnabled = nameField.value.trim().isNotEmpty()
  }

  private fun save() {
    val name = nameField.value.trim()
    if (name.isEmpty()) return
    val topic = topicField.value.trim()
    if (channel != null) finish("updateChannel", listOf(community.id, channel.id, mapOf("name" to name, "topic" to topic, "roleIds" to roleIds)))
    else finish("createChannel", listOf(community.id, mapOf("kind" to kind, "name" to name, "topic" to topic, "roleIds" to roleIds)))
  }

  private fun finish(operation: String, args: List<Any?>) {
    saveButton.setBusy(true)
    messenger.server.ask(operation, args) { result ->
      saveButton.setBusy(false)
      showReady()
      if (result.isSuccess) goBack() else tell(Server.error(result).words)
    }
  }
}
