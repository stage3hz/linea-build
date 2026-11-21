package com.linea.messenger.chat

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.Demo
import com.linea.messenger.app.Messenger
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.IconButton
import com.linea.messenger.design.Theme
import com.linea.messenger.shell.Screen
import java.time.Instant
import java.time.ZoneId

/** One chat: the messages, the header with the person's name, the field to write in.
 *  With a `messenger`: the real chat. Without: the debug build's sample chat. */
@SuppressLint("ViewConstructor")
class ChatScreen(
  context: Context, name: String,
  private val messenger: Messenger? = null, private val chatId: String = "", private val peerId: String = "",
  /** Up to which message the other side has read (for the two ticks). */
  private var peerLastRead: Long = 0,
  private val goBack: () -> Unit,
) : Screen(context), Messenger.Watcher {
  private val page = GlassSource(context)
  private val list = MsgListView(context)
  private val header = View(context)
  private val back = IconButton(context, "back", 24f, Theme.text)
  private val heading = TextView(context)
  private val composer = object : FrameLayout(context) {
    val glass = Glass(this).apply { source = page }
    init { setWillNotDraw(false) }
    override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), height / 2f)
  }
  private val field = EditText(context)
  private val send = IconButton(context, "send", 30f, Theme.text)
  /** The sample chat's rows. */
  private var rows: List<MsgRow> = emptyList()
  /** The real chat's rows, as the messenger gave them (and what is being sent, until the server has taken it). */
  private var real: List<Map<String, Any?>> = emptyList()

  /** What sends a message; null while there is nothing to send with. */
  var onSend: ((String) -> Unit)? = null

  init {
    setBackgroundColor(Theme.bg)
    list.setPalette(Theme.messages)
    page.addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(page)

    header.setBackgroundColor(Theme.alpha(Theme.bg, 0.92f))
    addView(header)
    back.contentDescription = "Назад"
    back.setOnClickListener { leave() }
    addView(back)
    heading.text = name
    heading.textSize = 17f
    heading.typeface = Theme.weight(600)
    heading.setTextColor(Theme.text)
    heading.gravity = Gravity.CENTER
    heading.maxLines = 1
    heading.ellipsize = TextUtils.TruncateAt.END
    addView(heading)

    field.hint = "Сообщение"
    field.setHintTextColor(Theme.muted)
    field.setTextColor(Theme.text)
    field.textSize = 17f
    field.background = null
    field.setPadding(0, 0, 0, 0)
    field.maxLines = 1
    field.isSingleLine = true
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    field.imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    field.gravity = Gravity.CENTER_VERTICAL
    field.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_SEND) { sendNow(); true } else false }
    composer.addView(field, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(18f); rightMargin = dp(50f) })
    send.contentDescription = "Отправить"
    send.setOnClickListener { sendNow() }
    composer.addView(send, FrameLayout.LayoutParams(dp(44f), dp(44f), Gravity.END or Gravity.CENTER_VERTICAL).apply { rightMargin = dp(2f) })
    addView(composer)

    if (messenger != null) {
      onSend = { text ->
        // Shown at once as being sent; the list is read again when the server has taken it.
        real = real + mapOf("key" to "sending-${real.size}", "kind" to 0, "mine" to true, "text" to text, "time" to Messenger.clock(Instant.now(), ZoneId.systemDefault()), "ticks" to 3, "tail" to true)
        list.setRows(MsgRow.parse(real))
        messenger.send(chatId, peerId, text) { load() }
      }
    } else {
      // Made-up messages in a debug build, and "sending" that only adds the text to them; nothing in a release one.
      rows = Demo.messages()
      Demo.send?.let { sender -> onSend = { text -> rows = sender(rows, text); list.setRows(rows) } }
      list.setRows(rows)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    messenger?.watch(this)
    load()
  }

  override fun onDetachedFromWindow() {
    messenger?.unwatch(this)
    super.onDetachedFromWindow()
  }

  /** Reads the chat's newest page and shows it; what came from the other side is reported as read. */
  private fun load() {
    val messenger = messenger ?: return
    messenger.messages(chatId, peerLastRead) { result ->
      val page = result.getOrNull()
      if (page == null || !isAttachedToWindow) return@messages
      real = page.rows
      list.setRows(MsgRow.parse(page.rows))
      // Reported once per new message: the server answers a read mark with an event, which reads the page again.
      if (page.newestTheirs > reportedRead) {
        reportedRead = page.newestTheirs
        messenger.markRead(chatId, page.newestTheirs)
      }
    }
  }

  /** Up to which message this screen has told the server «read». */
  private var reportedRead = 0

  override fun changed(chatId: String?) {
    if (chatId != null && chatId != this.chatId) return
    load()
  }

  override fun peerRead(chatId: String, messageId: Long) {
    if (chatId != this.chatId || messageId <= peerLastRead) return
    peerLastRead = messageId
    load()
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(header, 0, 0, width, top + dp(48f))
    put(back, dp(6f), top + dp(2f), dp(44f), dp(44f))
    put(heading, dp(56f), top + dp(2f), width - dp(112f), dp(44f))
    val composerHeight = dp(48f)
    // Above the keyboard when it is up, above the system's bar otherwise.
    val floor = if (edges.keyboard > 0) height - edges.keyboard - dp(8f) else height - maxOf(edges.bottom, dp(12f))
    val composerTop = floor - composerHeight
    list.setPad(top + dp(48f) + dp(8f), height - composerTop + dp(8f))
    put(page, 0, 0, width, height)
    put(composer, dp(12f), composerTop, width - dp(24f), composerHeight)
  }

  private fun leave() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
    goBack()
  }

  private fun sendNow() {
    val text = field.text.toString().trim()
    val sender = onSend ?: return
    if (text.isEmpty()) return
    field.setText("")
    sender(text)
  }
}
