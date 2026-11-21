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
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileTransfer
import com.linea.messenger.attachments.downloadSealedFile
import com.linea.messenger.attachments.uploadSealedFile
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.personAvatarAddress
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

  /** The file of a message as a new encrypted file on the server. Runs on a background thread. A failure is a
   *  `FileCore.Failure`. */
  private fun copied(attachment: Map<String, Any?>, server: Server): Result<Map<String, Any?>> {
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
}

/** «Переслать»: the chats to choose from, with a search by name. */
class ForwardPicker(context: Context, private val messenger: Messenger?, private val count: Int) : Dialog(context, android.R.style.Theme_Black_NoTitleBar) {
  class Target(
    val chatId: String, val peerId: String, val name: String, val person: Person?,
    /** The chat as the list knows it (null in the debug build's samples). */
    val summary: Messenger.ChatSummary?,
  )

  /** A chat was chosen (the picker is already closed). */
  var onPick: ((Target) -> Unit)? = null

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var everyone: List<Target> = emptyList()
  private var shown: List<Target> = emptyList()
  private val searchField = EditText(context)
  private val emptyLabel = TextView(context)
  private val table = ListView(context)

  /** One chat of the picker: the person's round picture and name. */
  private inner class Cell : FrameLayout(context) {
    val avatar = PersonAvatarView(context)
    val nameLabel = TextView(context).apply { textSize = 17f; setTextColor(Theme.text); maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL }
    init {
      addView(avatar, LayoutParams(dp(44f), dp(44f), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(16f) })
      addView(nameLabel, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply { leftMargin = dp(72f); rightMargin = dp(16f) })
      layoutParams = android.widget.AbsListView.LayoutParams(android.widget.AbsListView.LayoutParams.MATCH_PARENT, dp(60f))
    }
    fun show(target: Target) {
      nameLabel.text = target.name
      contentDescription = target.name
      avatar.visibility = if (target.person == null) View.INVISIBLE else View.VISIBLE
      target.person?.let { avatar.show(it, messenger?.personAvatarAddress(it.avatarId) ?: "") }
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

    val body = FrameLayout(context)
    table.divider = null
    table.dividerHeight = 0
    table.isVerticalScrollBarEnabled = false
    table.adapter = adapter
    table.setOnItemClickListener { _, _, position, _ ->
      val target = shown.getOrNull(position) ?: return@setOnItemClickListener
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

  private fun filter() {
    shown = matching(everyone, searchField.text.toString())
    emptyLabel.text = "Ничего не найдено"
    emptyLabel.visibility = if (shown.isEmpty()) View.VISIBLE else View.GONE
    adapter.notifyDataSetChanged()
  }

  /** The names on the screen now (for the checks). */
  val names: List<String> get() = shown.map { it.name }

  override fun show() {
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  companion object {
    fun heading(count: Int): String = if (count > 1) "Переслать ($count)" else "Переслать"

    /** The chats whose person's name or @name holds the words. */
    fun matching(everyone: List<Target>, query: String): List<Target> {
      val wanted = query.trim(' ').lowercase()
      if (wanted.isEmpty()) return everyone
      return everyone.filter { it.name.lowercase().contains(wanted) || (it.person?.username?.lowercase()?.contains(wanted) ?: false) }
    }
  }
}
