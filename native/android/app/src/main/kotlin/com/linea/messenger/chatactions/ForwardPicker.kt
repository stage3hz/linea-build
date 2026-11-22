package com.linea.messenger.chatactions

import android.app.Dialog
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileTransfer
import com.linea.messenger.attachments.downloadSealedFile
import com.linea.messenger.attachments.uploadSealedFile
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.video.BigFiles
import com.linea.messenger.video.BigTransfer
import com.linea.messenger.video.ChunkCore
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.personAvatarAddress
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** A forward that waits above the field of the chat it goes to (the reference's forward/forwardDraft.ts): the
 *  chat opens with «Переслать сообщение» over the field, a comment can be written, and sending sends both.
 *  Kept in memory only, for one chat at a time. Main thread only. */
object ForwardDraft {
  class Item(
    /** The message as it is shown (decrypted, edits applied). */
    val message: Map<String, Any?>,
    /** Whose words they are: the first author, kept through further forwards. */
    val author: String,
  )

  var chatId = ""
    private set
  var items: List<Item> = emptyList()
    private set

  fun put(chatId: String, items: List<Item>) {
    this.chatId = chatId
    this.items = items
  }

  fun waiting(chatId: String): List<Item> = if (this.chatId == chatId) items else emptyList()

  fun clear() {
    chatId = ""
    items = emptyList()
  }
}

/** Sending a message on to another chat. It is encrypted anew for that chat; a file is downloaded, opened here,
 *  sealed with a new key and uploaded again as a new encrypted file (the key of the first one is never reused). */
object ChatForward {
  private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.forward").apply { isDaemon = true } }

  /** At most `units` UTF-16 units of a text, never cutting a character in two. */
  fun clipped(text: String, units: Int): String {
    if (text.length <= units) return text
    var end = 0
    while (end < text.length) {
      val size = Character.charCount(text.codePointAt(end))
      if (end + size > units) break
      end += size
    }
    return text.substring(0, end)
  }

  /** What travels with a forwarded message: whose words they are, and the formatting of its text; an answer's
   *  quote, reactions and albums do not. Null: there is nothing to forward. */
  fun meta(message: Map<String, Any?>, author: String): Map<String, Any?>? {
    val text = message["text"] as? String ?: ""
    if (text.isBlank() && Core.map(message["attachment"] as? Map<*, *>) == null) return null
    val from = clipped(author.trim(), 80)
    val meta = linkedMapOf<String, Any?>("forward" to mapOf("from" to from.ifEmpty { "собеседник" }))
    val entities = Core.map(message["meta"])?.get("entities") as? List<*>
    if (!entities.isNullOrEmpty() && text.isNotEmpty()) meta["entities"] = entities
    return meta
  }

  /** Sends one message on. The answer comes on the main thread: null when it went (or will go by itself when the
   *  connection is back), else the words for the person. */
  fun send(messenger: Messenger, chatId: String, peerId: String, message: Map<String, Any?>, author: String, done: (String?) -> Unit) {
    val main = Handler(Looper.getMainLooper())
    val text = message["text"] as? String ?: ""
    val original = Core.map(message["attachment"] as? Map<*, *>)
    val meta = meta(message, author) ?: return done("Пустое сообщение нельзя переслать.")
    work.execute {
      var attachment: Map<String, Any?>? = null
      if (original != null) {
        val copied = copied(original, messenger.server)
        attachment = copied.getOrNull()
        if (attachment == null) {
          val words = (copied.exceptionOrNull() as? FileCore.Failure)?.words ?: "Не удалось переслать."
          main.post { done(words) }
          return@execute
        }
      }
      val sent = attachment
      val clientId = UUID.randomUUID().toString().lowercase()
      messenger.crypto.run({ crypto: CryptoService -> messenger.deliver(crypto, chatId, peerId, clientId, text, sent, meta) }, { result ->
        val failure = CryptoService.failure(result)
        if (result.isFailure && failure?.name != "NetworkError") {
          done(failure?.words.orEmpty().ifEmpty { "Не удалось переслать." })
        } else {
          messenger.noteChanged(chatId)
          done(null)
        }
      })
    }
  }

  /** Composer: the comment of «Выбрать» → send: a plain message to another chat, end-to-end encrypted like any other
   *  (the reference's `store.send(target.id, comment, null)`). The answer comes on the main thread. */
  fun sendText(messenger: Messenger, chatId: String, peerId: String, text: String, done: (String?) -> Unit) {
    val clientId = UUID.randomUUID().toString().lowercase()
    messenger.crypto.run({ crypto: CryptoService -> messenger.deliver(crypto, chatId, peerId, clientId, text, null, null) }, { result ->
      val failure = CryptoService.failure(result)
      if (result.isFailure && failure?.name != "NetworkError") { done(failure?.words.orEmpty().ifEmpty { "Не удалось переслать." }); return@run }
      messenger.noteChanged(chatId)
      done(null)
    })
  }

  /** Composer: «Выбрать» → send: to every chosen chat in turn, the comment first, then the messages in their order (the
   *  reference's `onSendMany`). «Избранное» among the targets is the caller's. `done` gets the first problem, if any. */
  fun sendMany(messenger: Messenger, targets: List<ForwardPicker.Target>, comment: String, items: List<ForwardDraft.Item>, done: (String?) -> Unit) {
    val steps = ArrayList<Pair<ForwardPicker.Target, ForwardDraft.Item?>>()
    for (target in targets) {
      if (target.isSaved) continue
      if (comment.isNotEmpty()) steps.add(target to null)
      for (item in items) steps.add(target to item)
    }
    fun step(index: Int) {
      if (index >= steps.size) return done(null)
      val (target, item) = steps[index]
      val next: (String?) -> Unit = { problem -> if (problem != null) done(problem) else step(index + 1) }
      if (item != null) send(messenger, target.chatId, target.peerId, item.message, item.author, next)
      else sendText(messenger, target.chatId, target.peerId, comment, next)
    }
    step(0)
  }

  /** «Переслано: Имя» or «Переслано в 3 чата» (the reference's notice; «Избранное» counts as a chat there). */
  fun notice(targets: List<ForwardPicker.Target>): String {
    val only = targets.singleOrNull()
    if (only != null && !only.isSaved) return "Переслано: " + only.name
    return "Переслано в ${targets.size} " + com.linea.messenger.composer.ScheduleModel.plural(targets.size, "чат", "чата", "чатов")
  }

  /** The file of a message as a new encrypted file on the server. Runs on a background thread. A failure is a
   *  `FileCore.Failure`. */
  private fun copied(attachment: Map<String, Any?>, server: Server): Result<Map<String, Any?>> {
    // A big file (a long video, a round video, a file over 20 MB) goes in encrypted chunks: it is taken down chunk
    // by chunk into a private file and goes up again the same way, under a new key.
    if (ChunkCore.isChunked(attachment)) return copiedBig(attachment, server)
    fun failure(words: String) = Result.failure<Map<String, Any?>>(FileCore.Failure(words))
    val unable = failure("Не удалось переслать.")
    val about = FileCore.describe(attachment)
    about.refusal?.let { return failure(it) }
    val id = attachment["id"] as? String ?: return unable
    val cipherSize = about.cipherSize ?: return unable
    val downloaded = server.downloadSealedFile(id, cipherSize, FileTransfer())
    val sealed = downloaded.getOrNull()
      ?: return failure((downloaded.exceptionOrNull() as? FileTransfer.Failure.Words)?.words ?: "Не удалось загрузить зашифрованный файл.")
    val opened = FileCore.open(sealed, attachment)
    val plain = opened.getOrNull() ?: return failure(FileCore.words(opened))
    // A new key, nonce and key id: the same key never seals two uploads.
    val encryption = Core.map(FileCore.call("newEncryption")) ?: return failure("Шифрование ещё не готово. Попробуй ещё раз.")
    val resealed = FileCore.seal(plain, encryption)
    val again = resealed.getOrNull() ?: return failure(FileCore.words(resealed))
    val uploaded = server.uploadSealedFile(again, FileTransfer())
    val newId = uploaded.getOrNull() ?: return (uploaded.exceptionOrNull() as? FileTransfer.Failure.Words)?.let { failure(it.words) } ?: unable
    val name = attachment["name"] as? String ?: "file"
    val type = attachment["mimeType"] as? String ?: "application/octet-stream"
    val made = Core.map(FileCore.call("attachment", listOf(newId, name, type, plain.size, encryption, attachment["media"], attachment["preview"]))) ?: return unable
    return Result.success(made)
  }

  /** A file of the chunked scheme as a new chunked file on the server (the reference's forward: the file is opened
   *  here and sent again as a new encrypted file; the key of the first one is never reused). One 4 MiB chunk is in
   *  memory at a time. Background thread. */
  private fun copiedBig(attachment: Map<String, Any?>, server: Server): Result<Map<String, Any?>> {
    val cache = File(System.getProperty("java.io.tmpdir") ?: return Result.failure(FileCore.Failure("Не удалось открыть файл.")))
    val quiet: (Long, Long) -> Unit = { _, _ -> }
    return copiedBig(attachment, cache,
      download = { file -> BigFiles.download(server, attachment, file, BigTransfer(), quiet) },
      upload = { file, video -> BigFiles.upload(server, file, video, BigTransfer(), progress = quiet) })
  }

  /** The steps of `copiedBig` around the transfers (given, so that the checks can run them without a server): the
   *  opened copy lives in a private folder of the app's cache that goes as soon as this ends (its name is that of
   *  the opened files, so a copy left by a killed app is swept with them); a video goes up under the video limit,
   *  anything else under the file limit; the message gets the new id and key with the first one's name, type,
   *  media and preview. */
  internal fun copiedBig(
    attachment: Map<String, Any?>, cache: File,
    download: (File) -> Result<Unit>, upload: (File, Boolean) -> Result<BigFiles.Uploaded>,
  ): Result<Map<String, Any?>> {
    fun failure(words: String) = Result.failure<Map<String, Any?>>(FileCore.Failure(words))
    val folder = File(cache, DecryptedFiles.prefix + UUID.randomUUID().toString().lowercase())
    try {
      if (!folder.mkdirs()) return failure("Не удалось открыть файл.")
      val file = File(folder, "forward.bin")
      val brought = download(file)
      if (brought.isFailure) return failure(FileCore.words(brought))
      val name = attachment["name"] as? String ?: "file"
      val type = attachment["mimeType"] as? String ?: "application/octet-stream"
      val uploaded = upload(file, isVideo(type))
      val done = uploaded.getOrNull() ?: return failure(FileCore.words(uploaded))
      val made = Core.map(FileCore.call("attachment", listOf(done.id, name, type, done.size, done.encryption, attachment["media"], attachment["preview"])))
        ?: return failure("Не удалось переслать.")
      return Result.success(made)
    } finally {
      folder.deleteRecursively()
    }
  }

  /** Whether a forwarded big file goes up as a video (its limit is the same for everyone) or as a file. */
  fun isVideo(mimeType: String): Boolean = mimeType.lowercase(java.util.Locale.ROOT).startsWith("video/")
}

/** «Переслать»: the chats to choose from, with a search by name. */
class ForwardPicker(context: Context, private val messenger: Messenger?, private val count: Int) : Dialog(context, android.R.style.Theme_Black_NoTitleBar) {
  class Target(
    val chatId: String, val peerId: String, val name: String, val person: Person?,
    /** The chat as the list knows it (null in the debug build's samples). */
    val summary: Messenger.ChatSummary?,
  ) {
    /** ChatsPlus: «Избранное» — the saved messages of this device, not a chat. */
    val isSaved: Boolean get() = chatId == SAVED_ID
  }

  /** A chat was chosen (the picker is already closed). */
  var onPick: ((Target) -> Unit)? = null
  /** Composer: «Выбрать» → send: the chosen chats in the order of the list, and the comment (trimmed, maybe empty). */
  var onSendMany: ((List<Target>, String) -> Unit)? = null
  private var selecting = false
  private val picked = LinkedHashSet<String>()
  private val selectButton = TextView(context)
  private val bottomBar = LinearLayout(context)
  private val commentField = EditText(context)
  private val sendButton = TextView(context)

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var everyone: List<Target> = emptyList()
  private var shown: List<Target> = emptyList()
  private val searchField = EditText(context)
  private val emptyLabel = TextView(context)
  private val table = ListView(context)
  // Media: the folder tabs («Все чаты» and the person's folders, chatsplus/ChatFolders.kt), as the reference's
  // forward/ForwardPicker.tsx; no row at all while there are no folders (its `tabs.length > 1`).
  private val tabsScroll = android.widget.HorizontalScrollView(context)
  private val tabsRow = LinearLayout(context)
  private var folders: List<com.linea.messenger.chatsplus.ChatFolder> = emptyList()
  private var filterId = "all"
  private val folderStore get() = com.linea.messenger.chatsplus.ChatFolderStore.of(context, messenger?.userId ?: "sample")
  private val foldersChanged: (Unit) -> Unit = { buildTabs(); filter() }

  /** One chat of the picker: the person's round picture and name. */
  private inner class Cell : FrameLayout(context) {
    val avatar = PersonAvatarView(context)
    val nameLabel = TextView(context).apply { textSize = 17f; setTextColor(Theme.text); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL }
    /** ChatsPlus: «Избранное» has a round bookmark instead of a person's picture. */
    val saved = ChatIconView(context, "bookmark.fill", 20f, Theme.onAccent).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.accent) } }
    /** Composer: the mark of a chat chosen with «Выбрать». */
    val mark = ChatIconView(context, "check.circle", 22f, Theme.accent)
    init {
      addView(avatar, LayoutParams(dp(44f), dp(44f), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(16f) })
      addView(saved, LayoutParams(dp(44f), dp(44f), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(16f) })
      addView(nameLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply { leftMargin = dp(72f); rightMargin = dp(52f) })
      addView(mark, LayoutParams(dp(26f), dp(26f), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(18f) })
      layoutParams = android.widget.AbsListView.LayoutParams(android.widget.AbsListView.LayoutParams.MATCH_PARENT, dp(60f))
    }
    fun show(target: Target) {
      nameLabel.text = target.name
      saved.visibility = if (target.isSaved) View.VISIBLE else View.GONE
      avatar.visibility = if (target.person == null) View.INVISIBLE else View.VISIBLE
      target.person?.let { avatar.show(it, messenger?.personAvatarAddress(it.avatarId) ?: "") }
      val chosen = picked.contains(target.chatId)
      mark.visibility = if (selecting) View.VISIBLE else View.GONE
      mark.symbol = if (chosen) "check.fill" else ""
      mark.color = Theme.accent
      mark.background = if (chosen) null else GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(dp(1.6f), Theme.subtle) }
      mark.invalidate()
      contentDescription = if (selecting) target.name + (if (chosen) ", выбран" else "") else target.name
    }
  }

  private val adapter = object : BaseAdapter() {
    override fun getCount() = shown.size
    override fun getItem(position: Int) = shown[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = ((convertView as? Cell) ?: Cell()).also { it.show(shown[position]) }
  }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val column = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Theme.bg)
      fitsSystemWindows = true
    }
    val top = FrameLayout(context)
    top.addView(TextView(context).apply {
      text = heading(count); textSize = 17f; typeface = Theme.weight(700); setTextColor(Theme.text); gravity = Gravity.CENTER
    }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    top.addView(TextView(context).apply {
      text = "Отмена"; textSize = 16f; typeface = Theme.weight(600); setTextColor(Theme.accent); gravity = Gravity.CENTER_VERTICAL
      isClickable = true; isFocusable = true
      setOnClickListener { dismiss() }
    }, FrameLayout.LayoutParams(dp(84f), FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(16f) })
    // Composer: «Выбрать» several chats (and «Отмена» of it).
    selectButton.text = "Выбрать"; selectButton.textSize = 16f; selectButton.typeface = Theme.weight(600); selectButton.setTextColor(Theme.accent)
    selectButton.gravity = Gravity.CENTER_VERTICAL or Gravity.END
    selectButton.isClickable = true; selectButton.isFocusable = true
    selectButton.setOnClickListener { toggleSelecting() }
    top.addView(selectButton, FrameLayout.LayoutParams(dp(100f), FrameLayout.LayoutParams.MATCH_PARENT, Gravity.END).apply { rightMargin = dp(16f) })
    column.addView(top, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44f)).apply { topMargin = dp(14f) })

    searchField.hint = "Поиск"
    searchField.setHintTextColor(Theme.muted)
    searchField.setTextColor(Theme.text)
    searchField.textSize = 16f
    searchField.maxLines = 1
    searchField.isSingleLine = true
    searchField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    searchField.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    searchField.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 20f * d }
    searchField.setPadding(dp(14f), 0, dp(14f), 0)
    searchField.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) = filter()
    })
    column.addView(searchField, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40f)).apply { leftMargin = dp(14f); rightMargin = dp(14f); topMargin = dp(6f); bottomMargin = dp(8f) })
    // Media: the folder tabs under the search.
    tabsScroll.isHorizontalScrollBarEnabled = false
    tabsRow.orientation = LinearLayout.HORIZONTAL
    tabsRow.setPadding(dp(16f), 0, dp(10f), 0)
    tabsScroll.addView(tabsRow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(34f)))
    column.addView(tabsScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(34f)).apply { bottomMargin = dp(6f) })
    buildTabs()

    val body = FrameLayout(context)
    table.divider = null
    table.dividerHeight = 0
    table.isVerticalScrollBarEnabled = false
    table.adapter = adapter
    table.setOnItemClickListener { _, _, position, _ ->
      val target = shown.getOrNull(position) ?: return@setOnItemClickListener
      if (selecting) {
        if (!picked.remove(target.chatId)) picked.add(target.chatId)
        refreshSend()
        adapter.notifyDataSetChanged()
        return@setOnItemClickListener
      }
      dismiss()
      onPick?.invoke(target)
    }
    body.addView(table, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    emptyLabel.textSize = 15f
    emptyLabel.setTextColor(Theme.muted)
    emptyLabel.gravity = Gravity.CENTER_HORIZONTAL
    emptyLabel.text = "Загрузка…"
    body.addView(emptyLabel, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(42f); leftMargin = dp(20f); rightMargin = dp(20f) })
    column.addView(body, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    // Composer: «Выбрать» — the comment and the send button at the bottom.
    bottomBar.gravity = Gravity.CENTER_VERTICAL
    bottomBar.setPadding(dp(14f), dp(8f), dp(14f), dp(14f))
    bottomBar.visibility = View.GONE
    commentField.hint = "Комментарий"
    commentField.setHintTextColor(Theme.muted)
    commentField.setTextColor(Theme.text)
    commentField.textSize = 16f
    commentField.maxLines = 4
    commentField.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 20f * d }
    commentField.setPadding(dp(14f), dp(9f), dp(14f), dp(9f))
    commentField.contentDescription = "Комментарий"
    bottomBar.addView(commentField, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    sendButton.textSize = 14f; sendButton.typeface = Theme.weight(700); sendButton.setTextColor(Theme.onAccent); sendButton.gravity = Gravity.CENTER
    sendButton.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.accent) }
    sendButton.isClickable = true
    sendButton.setOnClickListener { sendNow() }
    bottomBar.addView(sendButton, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { leftMargin = dp(10f) })
    column.addView(bottomBar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    setContentView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.let { window ->
      window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      @Suppress("DEPRECATION")
      window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
    }
    load()
  }

  private fun load() {
    val messenger = messenger
    if (messenger == null) {
      everyone = ChatActionsDemo.forwardTargets()
      filter()
      return
    }
    val local = ChatLocal.of(context, messenger)
    messenger.chats { result ->
      val chats = result.getOrNull()
      if (chats == null) {
        emptyLabel.text = Server.error(result).words
        emptyLabel.visibility = View.VISIBLE
      } else {
        everyone = chats.mapNotNull { chat ->
          val last = ChatHistory.number(Core.map(chat.chat["lastMessage"])?.get("id"))
          if (local.isRemoved(chat.id, last)) null else Target(chat.id, chat.peerId, chat.title, Person.from(chat.chat["peer"]), chat)
        }
        filter()
      }
    }
  }

  /** ChatsPlus: «Избранное» as the first target (chatsplus/SavedMessages.kt), only with nothing typed or its own name. */
  private val savedTargets: List<Target>
    get() {
      if (com.linea.messenger.chatsplus.SavedMessages.shared(messenger) == null) return emptyList()
      val wanted = searchField.text.toString().trim().lowercase()
      return if (wanted.isEmpty() || "избранное".contains(wanted)) listOf(Target(SAVED_ID, "", "Избранное", null, null)) else emptyList()
    }

  private fun filter() {
    // Media: the chats of the chosen folder tab; «Избранное» only under «Все чаты».
    val store = folderStore
    val inTab = everyone.filter { store.matches(it.chatId, false, filterId) }
    shown = (if (filterId == "all") savedTargets else emptyList()) + matching(inTab, searchField.text.toString())
    emptyLabel.text = "Ничего не найдено"
    emptyLabel.visibility = if (shown.isEmpty()) View.VISIBLE else View.GONE
    adapter.notifyDataSetChanged()
  }

  // Media: the folder tabs

  /** «Все чаты» and the folders; hidden while there are none. */
  private fun buildTabs() {
    folders = folderStore.folders
    if (filterId != "all" && folders.none { it.id == filterId }) filterId = "all"
    tabsRow.removeAllViews()
    val tabs = listOf("all" to "Все чаты") + folders.map { it.id to it.name }
    for ((id, name) in tabs) {
      val tab = TextView(context)
      tab.text = name
      tab.textSize = 14f
      tab.typeface = Theme.weight(600)
      tab.gravity = Gravity.CENTER
      tab.maxLines = 1
      tab.setPadding(dp(14f), 0, dp(14f), 0)
      tab.isClickable = true
      tab.isFocusable = true
      tab.tag = id
      tab.setOnClickListener { filterId = id; paintTabs(); filter() }
      tabsRow.addView(tab, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(34f)).apply { rightMargin = dp(6f) })
    }
    paintTabs()
    tabsScroll.visibility = if (folders.isEmpty()) View.GONE else View.VISIBLE
  }

  private fun paintTabs() {
    for (index in 0 until tabsRow.childCount) {
      val tab = tabsRow.getChildAt(index) as? TextView ?: continue
      val on = tab.tag == filterId
      tab.background = GradientDrawable().apply {
        cornerRadius = 17f * d
        if (on) setColor(Theme.surface2) else setStroke(maxOf(1, dp(1f)), Theme.veil(0.14f))
      }
      tab.setTextColor(if (on) Theme.text else Theme.muted)
      tab.isSelected = on
    }
  }

  override fun onStart() { super.onStart(); com.linea.messenger.chatsplus.ChatFolderStore.changed.watch(foldersChanged) }
  override fun onStop() { com.linea.messenger.chatsplus.ChatFolderStore.changed.unwatch(foldersChanged); super.onStop() }

  /** `chatdemo forwardfolders` and the checks: the tab of a folder (by its id). */
  fun chooseTab(id: String) { filterId = id; buildTabs(); filter() }

  // Composer: choosing several

  private fun toggleSelecting() {
    selecting = !selecting
    picked.clear()
    selectButton.text = if (selecting) "Отмена" else "Выбрать"
    bottomBar.visibility = if (selecting) View.VISIBLE else View.GONE
    refreshSend()
    adapter.notifyDataSetChanged()
  }

  private fun refreshSend() {
    val size = picked.size
    sendButton.isEnabled = size > 0
    sendButton.alpha = if (size > 0) 1f else 0.4f
    sendButton.text = if (size > 1) "$size" else "↑"
    sendButton.contentDescription = "Отправить в $size"
  }

  private fun sendNow() {
    if (picked.isEmpty()) return
    // In the order of the list.
    val targets = (savedTargets + everyone).filter { picked.contains(it.chatId) }
    val text = commentField.text.toString().trim()
    dismiss()
    onSendMany?.invoke(targets, text)
  }

  /** `chatdemo forwardmany`: «Выбрать» on, the first chats marked and a comment written. */
  fun demoChooseSeveral() {
    if (!selecting) toggleSelecting()
    for (target in shown.filter { !it.isSaved }.take(3)) picked.add(target.chatId)
    commentField.setText("Глянь, это про субботу")
    refreshSend()
    adapter.notifyDataSetChanged()
  }

  /** The names on the screen now (for the checks). */
  val names: List<String> get() = shown.map { it.name }

  override fun show() {
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  companion object {
    /** ChatsPlus: the id of «Избранное» among the targets (never the id of a chat). */
    const val SAVED_ID = "saved"

    fun heading(count: Int): String = if (count > 1) "Переслать ($count)" else "Переслать"

    /** The chats whose person's name or @name holds the words. */
    fun matching(everyone: List<Target>, query: String): List<Target> {
      val wanted = query.trim(' ').lowercase()
      if (wanted.isEmpty()) return everyone
      return everyone.filter { it.name.lowercase().contains(wanted) || (it.person?.username?.lowercase()?.contains(wanted) ?: false) }
    }
  }
}
