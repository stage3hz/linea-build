package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.PhotoPrepare
import com.linea.messenger.attachments.Picks
import com.linea.messenger.core.Core
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.IconButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonProfileScreen
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen
import java.util.UUID
import java.util.concurrent.Executors

/** A text channel: a conversation (avatar, name in the colour of the role, time, text) for a game server; a
 *  feed of posts for a blog channel. Reference: mobile/src/communities/ChannelChat.tsx.
 *
 *  The screen itself does almost nothing: ChannelEngine reads, merges and lays out off the main thread, the
 *  list (ChannelListView) puts finished rows in. Communities are not end-to-end encrypted, by the reference's
 *  design: messages are sent and read as they are.
 *
 *  `root`: the channel is the whole of a blog — the header shows the community itself. */
@SuppressLint("ViewConstructor")
class ChannelChatScreen(context: Context, private val messenger: Messenger?, private var community: Community, private val channel: CommunityChannel, private val root: Boolean) : Screen(context) {
  private val engine = ChannelEngine(
    messenger?.let { account -> { name, args, done -> account.server.op(name, args, done) } },
    community.id, channel.id, community.blog, messenger?.userId ?: "", messenger?.user?.get("username") as? String ?: "", community.summary.ownerId,
    resources.displayMetrics.density,
  )
  private val page = GlassSource(context)
  private val list = ChannelListView(context)
  val header = ChannelHeaderView(context)
  private val spinner = ChannelSpinner(context)
  private val notice = context.words("", 13f, Theme.danger)
  private val emptyIcon = ChannelIconView(context, if (community.blog) "megaphone" else "bubble", 42f, Theme.subtle)
  private val emptyHeading = context.words("", 18f, Theme.text, 700)
  private val emptyWords = context.words("", 14f, Theme.muted)

  private val composer = object : ViewGroup(context) {
    val glass = Glass(this).apply { source = page }
    init { setWillNotDraw(false) }
    override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 24f * d)
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = placeComposer(right - left, bottom - top)
  }
  private val attachButton = ChannelIconButton(context, "plus.circle", 26f, Theme.muted)
  private val field = EditText(context)
  private val sendButton = IconButton(context, "send", 30f, Theme.text)
  private val busy = ChannelSpinner(context)
  private val closedWords = context.words("", 13f, Theme.muted)
  private val contextBar = object : ViewGroup(context) {
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      val width = right - left
      contextIcon.layout(dp(6f), 0, dp(30f), dp(30f))
      contextWords.measure(MeasureSpec.makeMeasureSpec(width - dp(74f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(30f), MeasureSpec.EXACTLY))
      contextWords.layout(dp(34f), 0, width - dp(40f), dp(30f))
      contextClose.layout(width - dp(40f), 0, width, dp(30f))
    }
  }
  private val contextIcon = ChannelIconView(context, "reply", 15f, Theme.text)
  private val contextWords = context.words("", 13f, Theme.muted)
  private val contextClose = ChannelIconButton(context, "cross", 15f, Theme.muted)
  private val waitingStrip = LinearLayout(context)
  private var menu: ChannelMenuView? = null

  private var reply: CommunityMessage? = null
  /** The message being changed (its text is in the field). */
  private var editingMessage: CommunityMessage? = null
  private var replyAuthor = ""
  private var sending = false
  private var loadedOnce = false
  private var started = false
  private var reportedRead = 0L
  /** The notice offers to read the channel again. */
  private var noticeRetries = false
  private val photos = ChannelPhotoOpener(this)
  private val opener = ChannelFileOpener(this)
  private val main = Handler(Looper.getMainLooper())
  private val hideNotice = Runnable { notice.visibility = View.GONE }

  private val blog: Boolean get() = community.blog
  private val canWrite: Boolean get() = community.can(if (blog) Perm.post else Perm.send)
  private val canModerate: Boolean get() = community.can(Perm.manageMessages)

  private val onEvent: (Map<String, Any?>) -> Unit = { data -> event(data) }
  private val onOutbox: (ChannelOutbox.Change) -> Unit = { change ->
    if (change.channelId == channel.id) {
      change.message?.let { engine.put(it, own = true) }
      showWaiting()
    }
  }

  // Building

  init {
    setBackgroundColor(Theme.bg)
    // A touch on the page's own background goes no further (to the page under it while this one slides in).
    isClickable = true
    page.addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(page)

    emptyHeading.gravity = Gravity.CENTER
    emptyWords.gravity = Gravity.CENTER
    for (part in listOf(emptyIcon, emptyHeading, emptyWords)) { part.visibility = View.GONE; addView(part) }
    addView(spinner)

    header.onBack = { endEditing(); pages()?.pop() }
    header.showsAvatar = root
    addView(header)
    notice.gravity = Gravity.CENTER
    notice.maxLines = 2
    notice.background = context.plate(0xFF1B1C1E.toInt(), 12f)
    notice.visibility = View.GONE
    notice.isClickable = true
    notice.setOnClickListener { noticePressed() }
    notice.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    addView(notice)

    buildComposer()
    showWords()

    list.onWidth = { wide -> engine.setWidth(wide) }
    list.onNearTop = { engine.loadOlder() }
    list.onPress = { layout, hit -> pressed(layout, hit) }
    list.onLongPress = { layout, y -> openMenu(layout, y) }
    engine.onPatch = { patch ->
      list.apply(patch)
      showEmpty()
    }
    engine.onLoaded = { error, newest -> loaded(error, newest) }
    engine.onIncoming = { id -> markRead(id) }
    engine.onOlderFailed = { list.forgetAsked() }
  }

  private fun buildComposer() {
    addView(composer)
    attachButton.contentDescription = "Прикрепить"
    attachButton.setOnClickListener { attach() }
    composer.addView(attachButton)
    field.background = null
    field.textSize = 16f
    field.setTextColor(Theme.text)
    field.setHintTextColor(Theme.subtle)
    field.setPadding(0, dp(13f), 0, dp(13f))
    field.gravity = Gravity.TOP or Gravity.START
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    field.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    field.isVerticalScrollBarEnabled = false
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { showSend(); requestLayout() }
    })
    composer.addView(field)
    sendButton.contentDescription = "Отправить"
    sendButton.setOnClickListener { sendNow() }
    composer.addView(sendButton)
    busy.visibility = View.GONE
    composer.addView(busy)

    closedWords.gravity = Gravity.CENTER
    addView(closedWords)

    contextBar.visibility = View.GONE
    addView(contextBar)
    contextBar.addView(contextIcon)
    contextWords.maxLines = 1
    contextWords.ellipsize = TextUtils.TruncateAt.END
    contextWords.gravity = Gravity.CENTER_VERTICAL
    contextBar.addView(contextWords)
    contextClose.contentDescription = "Отменить"
    contextClose.setOnClickListener { dropContext() }
    contextBar.addView(contextClose)

    waitingStrip.orientation = LinearLayout.VERTICAL
    waitingStrip.gravity = Gravity.END
    addView(waitingStrip)
  }

  /** The words that depend on the community and on what the person may do in it. */
  private fun showWords() {
    if (root) {
      header.avatar.show(community.summary)
      header.setWords(community.summary.name, community.summary.countWords)
    } else {
      header.setWords("# " + channel.name, channel.topic.ifEmpty { community.summary.name })
    }
    field.hint = if (blog) "Новая публикация" else "Написать в #" + channel.name
    field.contentDescription = field.hint
    closedWords.text = if (blog) "Публикуют только авторы канала." else "В этом канале нельзя писать."
    emptyHeading.text = if (blog) "Пока нет публикаций" else "Это начало #" + channel.name
    emptyWords.text = if (blog) (if (canWrite) "Напиши первый пост — его увидят все подписчики." else "Новые посты появятся здесь.") else "Напиши что-нибудь, чтобы начать разговор."
    composer.visibility = if (canWrite) View.VISIBLE else View.GONE
    closedWords.visibility = if (canWrite) View.GONE else View.VISIBLE
    showSend()
    requestLayout()
  }

  /** The community was read again (its name, the person's rights in it). */
  fun update(changed: Community) {
    community = changed
    showWords()
  }

  /** The icons on the right of the header (a blog's channel carries the community's own). */
  fun setTools(items: List<ChannelHeaderView.Tool>) = header.setTools(items)

  private fun showSend() {
    val ready = field.text.toString().trim().isNotEmpty()
    sendButton.alpha = if (ready) 1f else 0.4f
    sendButton.isEnabled = ready && !sending
    sendButton.visibility = if (sending) View.INVISIBLE else View.VISIBLE
    busy.visibility = if (sending) View.VISIBLE else View.GONE
    attachButton.visibility = if (editingMessage != null) View.GONE else View.VISIBLE
  }

  private fun showEmpty() {
    val empty = loadedOnce && list.isEmpty
    for (part in listOf(emptyIcon, emptyHeading, emptyWords)) part.visibility = if (empty) View.VISIBLE else View.GONE
  }

  // Place

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (messenger != null) {
      Live.communityEvent.watch(onEvent)
      ChannelOutbox.changed.watch(onOutbox)
    }
    if (started) return
    started = true
    if (messenger != null) {
      engine.load()
      if (!blog) loadMembers(messenger)
      showWaiting()
    } else {
      ChannelsDemo.fill(engine, blog)
    }
  }

  override fun onDetachedFromWindow() {
    Live.communityEvent.unwatch(onEvent)
    ChannelOutbox.changed.unwatch(onOutbox)
    main.removeCallbacks(hideNotice)
    if (messenger != null) ChannelsStore.setViewing("")
    endEditing()
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    // On the screen: its new messages are read as they come.
    if (messenger != null) ChannelsStore.setViewing(if (isVisible) channel.id else "")
  }

  private fun endEditing() {
    field.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun placeComposer(width: Int, tall: Int) {
    val side = if (editingMessage == null) dp(44f) else dp(14f)
    val fieldWidth = width - side - dp(46f)
    attachButton.layout(dp(2f), tall - dp(46f), dp(46f), tall - dp(2f))
    field.measure(MeasureSpec.makeMeasureSpec(fieldWidth.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(tall, MeasureSpec.EXACTLY))
    field.layout(side, 0, side + fieldWidth, tall)
    sendButton.layout(width - dp(46f), tall - dp(46f), width - dp(2f), tall - dp(2f))
    busy.measure(MeasureSpec.makeMeasureSpec(dp(22f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(22f), MeasureSpec.EXACTLY))
    busy.layout(width - dp(35f), tall - dp(35f), width - dp(13f), tall - dp(13f))
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    val headerBottom = top + dp(ChannelHeaderView.height)
    header.safeTop = top
    put(header, 0, 0, width, headerBottom)
    put(notice, dp(12f), headerBottom + dp(6f), width - dp(24f), dp(40f))
    // Above the keyboard when it is up, above the system's bar otherwise.
    var floor = if (edges.keyboard > 0) height - edges.keyboard - dp(8f) else height - maxOf(edges.bottom, dp(12f))
    if (canWrite) {
      val side = if (editingMessage == null) dp(44f) else dp(14f)
      val fieldWidth = width - dp(24f) - side - dp(46f)
      field.measure(MeasureSpec.makeMeasureSpec(fieldWidth.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      val tall = field.measuredHeight.coerceIn(dp(48f), dp(140f))
      put(composer, dp(12f), floor - tall, width - dp(24f), tall)
      floor -= tall
      if (contextBar.visibility == View.VISIBLE) {
        put(contextBar, dp(12f), floor - dp(34f), width - dp(24f), dp(30f))
        floor -= dp(34f)
      }
      if (waitingStrip.childCount > 0) {
        waitingStrip.measure(MeasureSpec.makeMeasureSpec(width - dp(24f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val strip = waitingStrip.measuredHeight
        waitingStrip.layout(dp(12f), floor - strip - dp(6f), width - dp(12f), floor - dp(6f))
        floor -= strip + dp(6f)
      }
    } else {
      put(closedWords, dp(16f), floor - dp(44f), width - dp(32f), dp(44f))
      floor -= dp(44f)
    }
    list.setPad(headerBottom + dp(6f), height - floor + dp(8f))
    put(page, 0, 0, width, height)
    put(spinner, width / 2 - dp(12f), headerBottom + dp(48f), dp(24f), dp(24f))
    val middle = (headerBottom + floor) / 2
    put(emptyIcon, 0, middle - dp(70f), width, dp(48f))
    put(emptyHeading, dp(24f), middle - dp(14f), width - dp(48f), dp(24f))
    put(emptyWords, dp(30f), middle + dp(14f), width - dp(60f), dp(40f))
    menu?.let { shown ->
      shown.safeTop = top; shown.safeBottom = maxOf(edges.bottom, edges.keyboard)
      put(shown, 0, 0, width, height)
    }
  }

  // Reading

  private fun loaded(error: String, newest: Long) {
    spinner.visibility = View.GONE
    if (error.isEmpty()) {
      loadedOnce = true
      if (noticeRetries) notice.visibility = View.GONE
      showEmpty()
      if (newest > 0) markRead(newest)
    } else {
      say(error, retry = true)
    }
  }

  /** Tells the server the channel was read up to a message; an older server gets the community-wide mark. */
  private fun markRead(id: Long) {
    val messenger = messenger ?: return
    if (id <= reportedRead || !isAttachedToWindow) return
    reportedRead = id
    val communityId = community.id; val channelId = channel.id
    messenger.server.ask("readChannel", listOf(communityId, channelId, id)) { result ->
      val body = result.getOrNull()
      val error = result.exceptionOrNull() as? ServerError.Refused
      if (body != null) {
        ChannelsStore.read(channelId, (body["unread"] as? Number)?.toInt() ?: 0, (body["mentions"] as? Number)?.toInt() ?: 0, CommunitySummary.from(body["community"]))
      } else if (error != null && error.status == 404) {
        messenger.server.ask("communityMe", listOf(communityId, mapOf("lastReadId" to id))) { }
      }
    }
  }

  /** The members: their names and pictures, and the colour of each one's highest role (for the names). */
  private fun loadMembers(messenger: Messenger) {
    val snapshot = community
    messenger.server.op("communityMembers", listOf(community.id)) { result ->
      val body = Core.map(result.getOrNull() as? Map<*, *>) ?: return@op
      val authors = HashMap<String, ChannelAuthor>()
      val colors = HashMap<String, Int>()
      for (raw in (body["members"] as? List<*>).orEmpty()) {
        val member = Core.map(raw as? Map<*, *>) ?: continue
        val user = Core.map(member["user"] as? Map<*, *>) ?: continue
        val id = user["id"] as? String ?: continue
        authors[id] = ChannelAuthor.from(user) ?: continue
        snapshot.nameColor((member["roleIds"] as? List<*>).orEmpty().mapNotNull { it as? String })?.let { colors[id] = it }
      }
      engine.setMembers(authors, colors)
    }
  }

  private fun event(data: Map<String, Any?>) {
    val type = data["type"] as? String ?: return
    if (type == "ready") {
      // The line is back: what arrived meanwhile is fetched and merged.
      if (loadedOnce) engine.load()
      return
    }
    if (data["communityId"] as? String != community.id) return
    if (type == "community.message" || type == "community.message.deleted") engine.socket(data)
  }

  // Notices

  private fun say(words: String, retry: Boolean = false) {
    notice.text = words
    noticeRetries = retry
    notice.visibility = View.VISIBLE
    main.removeCallbacks(hideNotice)
    if (!retry) main.postDelayed(hideNotice, 5000)
  }

  private fun noticePressed() {
    val again = noticeRetries
    notice.visibility = View.GONE
    if (again) {
      spinner.visibility = View.VISIBLE
      engine.load()
    }
  }

  // Writing

  private fun setField(text: String) {
    field.setText(text)
    field.setSelection(field.text.length)
  }

  private fun showContext() {
    val answered = reply
    if (editingMessage != null) {
      contextIcon.symbol = "pencil"
      contextWords.text = "Редактирование"
      contextBar.visibility = View.VISIBLE
    } else if (answered != null) {
      contextIcon.symbol = "reply"
      contextWords.text = "Ответ " + replyAuthor + ": " + answered.text.ifEmpty { "вложение" }.replace("\n", " ")
      contextBar.visibility = View.VISIBLE
    } else {
      contextBar.visibility = View.GONE
    }
    showSend()
    requestLayout()
  }

  private fun dropContext() {
    reply = null
    if (editingMessage != null) {
      editingMessage = null
      setField("")
    }
    showContext()
  }

  private fun sendNow() {
    val messenger = messenger ?: return
    if (sending) return
    val value = field.text.toString().trim()
    if (value.isEmpty()) return
    val communityId = community.id; val channelId = channel.id
    sending = true
    showSend()
    val changing = editingMessage
    if (changing != null) {
      messenger.server.ask("editChannelMessage", listOf(communityId, channelId, changing.id, value)) { result ->
        sending = false
        val body = result.getOrNull()
        if (body != null) {
          engine.put(body["message"], own = false)
          editingMessage = null
          setField("")
          showContext()
        } else {
          showSend()
          say(Server.error(result).words)
        }
      }
      return
    }
    // The key goes along: should no answer come and the message wait for a connection, the retry is the
    // same message for the server (no duplicate).
    val key = UUID.randomUUID().toString().lowercase()
    val answered = reply?.id ?: 0L
    val fields = linkedMapOf<String, Any?>("text" to value, "clientKey" to key)
    if (answered != 0L) fields["replyTo"] = answered
    messenger.server.ask("sendChannelMessage", listOf(communityId, channelId, fields)) { result ->
      sending = false
      val body = result.getOrNull()
      val error = Server.error(result)
      if (body != null) {
        engine.put(body["message"], own = true)
        sent()
      } else if (error is ServerError.Refused) {
        showSend()
        say(error.words)
      } else if (ChannelOutbox.add(ChannelOutbox.Item(key, communityId, channelId, value, answered))) {
        // No answer: it waits for the connection and goes out by itself.
        sent()
      } else {
        showSend()
        say(ChannelOutbox.full)
      }
    }
  }

  /** After a message has gone (or has been put to wait): the field is empty again and the list is at its end. */
  private fun sent() {
    reply = null
    setField("")
    showContext()
    list.scrollToEnd()
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
  }

  // Waiting for a connection

  private fun showWaiting() {
    waitingStrip.removeAllViews()
    val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    for (failure in ChannelOutbox.refused) {
      if (failure.item.channelId != channel.id) continue
      val key = failure.item.key
      waitingStrip.addView(WaitingChip(context, failure.item.text, "не отправлено", true, "Не отправлено: " + failure.words, { ChannelOutbox.retry(key) }, { ChannelOutbox.dismiss(key) }),
        LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = if (waitingStrip.childCount == 0) 0 else dp(4f) })
    }
    for (item in ChannelOutbox.waiting) {
      if (item.channelId != channel.id) continue
      val key = item.key
      waitingStrip.addView(WaitingChip(context, item.text, "ожидает отправки", false, "", null) { ChannelOutbox.cancel(key) },
        LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = if (waitingStrip.childCount == 0) 0 else dp(4f) })
    }
    requestLayout()
  }

  // Attaching

  private fun activity(): Activity? {
    var owner: Context? = context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    return owner as? Activity
  }

  private fun attach() {
    endEditing()
    try {
      AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Прикрепить")
        .setMessage("Каналы не шифруются сквозным шифрованием: файл увидят все, у кого есть доступ к каналу.")
        .setPositiveButton("Фото") { _, _ -> pickPhoto() }.setNegativeButton("Отмена", null).show()
    } catch (_: Exception) { /* the window is gone */ }
  }

  private fun pickPhoto() {
    val activity = activity() ?: return
    // The system's photo picker returns only the chosen picture, readable for this one time: no permission.
    // Where the phone has none, the system's own file chooser shows pictures the same way.
    val asked = Picks.ask(activity, ChannelPick.photo()) { chosen -> picked(chosen.firstOrNull()) }
      || Picks.ask(activity, ChatAttachments.documentPicker("image/*")) { chosen -> picked(chosen.firstOrNull()) }
    if (!asked) say("Не удалось открыть галерею.")
  }

  private fun picked(uri: Uri?) {
    val messenger = messenger ?: return
    if (uri == null || sending) return
    sending = true
    showSend()
    val caption = field.text.toString().trim()
    val communityId = community.id; val channelId = channel.id
    val server = messenger.server
    val resolver = context.contentResolver
    ChannelPick.work.execute {
      // The picture is drawn anew and written without anything of the original file (no EXIF, no place, no
      // camera), as before every upload in the reference; then it goes up in one request and the message
      // points at it.
      var outcome: Result<Any?> = Result.failure(ServerError.Network("Не удалось обработать фото. Файл не отправлен."))
      if (PhotoPrepare.isPicture(resolver, uri)) {
        val prepared = PhotoPrepare.prepare(resolver, uri, ChannelPick.size(resolver, uri))
        val photo = prepared.getOrNull()
        if (photo == null) {
          outcome = Result.failure(ServerError.Network(PhotoPrepare.words(prepared)))
        } else {
          val uploaded = server.uploadPlainFile(photo.bytes, photo.name, photo.mimeType, "channel")
          val file = uploaded.getOrNull()
          if (file == null) {
            outcome = Result.failure(Server.error(uploaded))
          } else {
            val fields = linkedMapOf<String, Any?>("attachmentId" to (file["id"] as? String ?: ""))
            if (caption.isNotEmpty()) fields["text"] = caption
            outcome = server.opAndWait("sendChannelMessage", listOf(communityId, channelId, fields))
          }
        }
      }
      main.post {
        sending = false
        if (outcome.isSuccess) {
          engine.put(Core.map(outcome.getOrNull() as? Map<*, *>)?.get("message"), own = true)
          if (caption.isNotEmpty()) setField("")
          showContext()
          list.scrollToEnd()
        } else {
          showSend()
          say(Server.error(outcome).words)
        }
      }
    }
  }

  // Touches on rows

  private fun pressed(layout: ChannelRowLayout, hit: ChannelHit) {
    val message = layout.message
    when (hit) {
      is ChannelHit.Row -> endEditing()
      is ChannelHit.Chip -> react(message, hit.emoji)
      is ChannelHit.Link -> openLink(hit.url)
      is ChannelHit.Author -> {
        if (message.senderId == messenger?.userId || message.senderId.isEmpty()) return
        endEditing()
        pages()?.push(PersonProfileScreen(context, messenger, message.senderId, layout.row.author))
      }
      is ChannelHit.Attachment -> {
        val file = message.attachment ?: return
        endEditing()
        if (file.mimeType.startsWith("image/")) photos.open(file.id)
        else if (messenger != null) opener.open(messenger.server, file.id, file.name)
      }
      is ChannelHit.Invite -> {
        val messenger = messenger ?: return
        val invite = layout.row.invite ?: return
        if (invite.state != 2) return
        endEditing()
        if (invite.member) ChannelsRoute.openCommunity(this, messenger, invite.communityId) else ChannelsRoute.openInvite(this, messenger, invite.code)
      }
    }
  }

  private fun openLink(address: String) {
    if (address.startsWith("mention:")) {
      // «@name» leads to that person.
      val messenger = messenger ?: return
      val username = address.removePrefix("mention:")
      messenger.server.ask("users", listOf("@$username")) { result ->
        val body = result.getOrNull() ?: return@ask
        val person = Person.list(body["users"]).firstOrNull { it.username.lowercase() == username.lowercase() } ?: return@ask
        if (!isAttachedToWindow) return@ask
        pages()?.push(PersonProfileScreen(context, messenger, person.id, person.displayName, person))
      }
      return
    }
    // Only http and https are ever opened.
    val url = try { Uri.parse(address) } catch (_: Exception) { return }
    val scheme = url.scheme?.lowercase() ?: return
    if (scheme != "https" && scheme != "http") return
    try { context.startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: ActivityNotFoundException) { }
  }

  /** For the emulator check: the menu of the newest message. False while there are no rows yet. */
  fun emulatorMenu(): Boolean {
    val newest = list.newest ?: return false
    openMenu(newest, height / 2f)
    return true
  }

  private fun openMenu(layout: ChannelRowLayout, y: Float) {
    val message = layout.message
    val author = layout.row.author
    endEditing()
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    val me = messenger?.userId ?: ""
    val mine = message.senderId == me
    val actions = ArrayList<ChannelMenuView.Action>()
    if (canWrite) actions.add(ChannelMenuView.Action("answer", "Ответить", false) { startReply(message, author) })
    if (message.text.isNotEmpty()) actions.add(ChannelMenuView.Action("copy", "Скопировать", false) {
      (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("", message.text))
    })
    if (mine && message.text.isNotEmpty()) actions.add(ChannelMenuView.Action("pencil", "Изменить", false) { startEdit(message) })
    if (mine || canModerate) actions.add(ChannelMenuView.Action("trash", "Удалить", true) { remove(message) })
    val reactions = ChannelWords.quickReactions.map { emoji -> Pair(emoji, message.reactions.any { it.emoji == emoji && it.userIds.contains(me) }) }
    menu?.let { removeView(it) }
    val shown = ChannelMenuView(context, reactions, actions, y) { emoji -> react(message, emoji) }
    menu = shown
    addView(shown)
    shown.show()
  }

  override fun onViewRemoved(child: View?) {
    super.onViewRemoved(child)
    if (child === menu) menu = null
  }

  private fun focusField() {
    field.requestFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(field, 0)
  }

  private fun startReply(message: CommunityMessage, author: String) {
    editingMessage = null
    reply = message
    replyAuthor = author
    showContext()
    focusField()
  }

  private fun startEdit(message: CommunityMessage) {
    reply = null
    editingMessage = message
    setField(message.text)
    showContext()
    focusField()
  }

  private fun react(message: CommunityMessage, emoji: String) {
    val messenger = messenger ?: return
    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    messenger.server.ask("reactChannelMessage", listOf(community.id, channel.id, message.id, emoji)) { result ->
      val body = result.getOrNull()
      if (body != null) engine.put(body["message"], own = false) else say(Server.error(result).words)
    }
  }

  private fun remove(message: CommunityMessage) {
    val messenger = messenger ?: return
    messenger.server.ask("deleteChannelMessage", listOf(community.id, channel.id, message.id)) { result ->
      if (result.isSuccess) engine.removed(message.id) else say(Server.error(result).words)
    }
  }
}

/** Choosing one picture and what is needed of it. */
object ChannelPick {
  /** Where pictures are got ready and uploaded: one at a time, never on the main thread. */
  val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.channel-upload").apply { isDaemon = true } }

  /** The system's photo picker for ONE picture (Android 13, and earlier phones the system update brought it
   *  to); elsewhere the system's file chooser for pictures. */
  fun photo(): Intent {
    val has = Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= 30 && Extensions.photoPicker())
    return if (has) Extensions.pickImage() else ChatAttachments.documentPicker("image/*")
  }

  /** The size of a chosen file as its provider says it (-1: it does not say). */
  fun size(resolver: android.content.ContentResolver, uri: Uri): Long = try {
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      val at = cursor.getColumnIndex(OpenableColumns.SIZE)
      if (cursor.moveToFirst() && at >= 0 && !cursor.isNull(at)) cursor.getLong(at) else -1L
    } ?: -1L
  } catch (_: Exception) { -1L }

  @android.annotation.TargetApi(30)
  private object Extensions {
    fun photoPicker(): Boolean = try { SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2 } catch (_: Throwable) { false }

    @SuppressLint("InlinedApi")
    fun pickImage(): Intent = Intent(MediaStore.ACTION_PICK_IMAGES).apply { type = "image/*" }
  }
}
