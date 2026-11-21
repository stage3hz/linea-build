package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.PhotoViewer
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors

// What a channel's chat is made of besides its list: the messages waiting for a connection, the menu of a
// message, the photo on the whole screen, a file opened by another app.

/** Messages written while the server could not be reached: they wait and go out by themselves when the live
 *  line is back, whichever screen is open (reference: communities/channelOutbox.ts). Each carries a key the
 *  server knows a repeated send by, so nothing is posted twice. Kept in memory for as long as the app runs
 *  (the reference also keeps them on disk across restarts — not built here, as on the iPhone). Main thread only. */
object ChannelOutbox {
  /** What changed: the channel, and the server's message when one has just been sent. */
  class Change(val channelId: String, val message: Any?)
  /** Posted when the waiting or refused messages changed. */
  val changed = Live.Signal<Change>()
  const val limit = 200
  const val full = "Слишком много сообщений ждут отправки (200). Дождись соединения или отмени часть из них."

  /** `replyTo` 0: answers nothing. */
  data class Item(val key: String, val communityId: String, val channelId: String, val text: String, val replyTo: Long)
  class Refused(val item: Item, val words: String)

  val waiting = ArrayList<Item>()
  /** What the server refused for good, with its words. */
  val refused = ArrayList<Refused>()
  private var messenger = WeakReference<Messenger>(null)
  private var sending = false
  private var observing = false
  /** How a message is sent (the account's server; a check gives its own). */
  var sender: ((item: Item, done: (Result<Map<String, Any?>>) -> Unit) -> Unit)? = null

  fun start(messenger: Messenger?) {
    this.messenger = WeakReference(messenger)
    waiting.clear()
    refused.clear()
    sending = false
    sender = if (messenger == null) null else { item, done ->
      val fields = linkedMapOf<String, Any?>("text" to item.text, "clientKey" to item.key)
      if (item.replyTo != 0L) fields["replyTo"] = item.replyTo
      messenger.server.ask("sendChannelMessage", listOf(item.communityId, item.channelId, fields), done)
    }
    if (!observing) {
      observing = true
      Live.communityEvent.watch { data -> if (data["type"] == "ready") flush() }
    }
  }

  private fun post(channelId: String, message: Any? = null) = changed.post(Change(channelId, message))

  /** False when too many are waiting already. */
  fun add(item: Item): Boolean {
    if (waiting.size >= limit) return false
    waiting.add(item)
    post(item.channelId)
    return true
  }

  fun cancel(key: String) {
    val index = waiting.indexOfFirst { it.key == key }
    if (index < 0) return
    post(waiting.removeAt(index).channelId)
  }

  fun dismiss(key: String) {
    val index = refused.indexOfFirst { it.item.key == key }
    if (index < 0) return
    post(refused.removeAt(index).item.channelId)
  }

  /** A refused message is tried again as a new one. */
  fun retry(key: String) {
    val index = refused.indexOfFirst { it.item.key == key }
    if (index < 0) return
    val gone = refused.removeAt(index).item
    add(gone.copy(key = UUID.randomUUID().toString().lowercase()))
    flush()
  }

  /** A refusal for good: 4xx, but not a dead session 401, «too slow» 408 or «too often» 429. */
  fun forGood(status: Int): Boolean = status in 400..499 && status != 401 && status != 408 && status != 429

  /** Sends what is waiting, oldest first, one at a time; stops at the first one that gets no answer. */
  fun flush() {
    val send = sender ?: return
    if (sending) return
    val item = waiting.firstOrNull() ?: return
    sending = true
    send(item) { result ->
      sending = false
      // Cancelled meanwhile: the answer changes nothing here.
      val index = waiting.indexOfFirst { it.key == item.key }
      if (index < 0) return@send flush()
      val body = result.getOrNull()
      val error = result.exceptionOrNull() as? ServerError.Refused
      if (body != null) {
        waiting.removeAt(index)
        post(item.channelId, body["message"])
        flush()
      } else if (error != null && forGood(error.status)) {
        waiting.removeAt(index)
        refused.add(Refused(item, error.words))
        if (refused.size > 20) refused.removeAt(0)
        post(item.channelId)
        flush()
      }
      // Else no answer, or «try later»: it stays and goes out with the next «ready».
    }
  }
}

/** The menu of a message: a row of reactions and what can be done with the message. It lies over the chat. */
@SuppressLint("ViewConstructor")
class ChannelMenuView(
  context: Context, private val reactions: List<Pair<String, Boolean>>, private val actions: List<Action>,
  /** Where the finger was on the screen, px. */
  private val anchor: Float, private val onReact: (String) -> Unit,
) : ViewGroup(context) {
  class Action(val symbol: String, val label: String, val danger: Boolean, val run: () -> Unit)

  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val reactionBar = object : ViewGroup(context) {
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      for (index in 0 until childCount) getChildAt(index).layout(dp(7f + index * 42f), dp(5f), dp(7f + index * 42f + 38f), dp(43f))
    }
  }
  private val panel = object : ViewGroup(context) {
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      for (index in 0 until childCount) {
        val row = getChildAt(index)
        row.measure(MeasureSpec.makeMeasureSpec(r - l, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(46f), MeasureSpec.EXACTLY))
        row.layout(0, dp(index * 46f), r - l, dp(index * 46f + 46f))
      }
    }
  }
  /** Top of the system's bars and what is under the screen's lower edge, px (the chat tells). */
  var safeTop = 0
  var safeBottom = 0

  init {
    setBackgroundColor(0x73000000)
    isClickable = true
    contentDescription = "Закрыть"
    setOnClickListener { close() }
    reactionBar.background = context.plate(0xFF1B1C1E.toInt(), 24f, 0x1AFFFFFF)
    panel.background = context.plate(0xFF1B1C1E.toInt(), 16f, 0x1AFFFFFF)
    panel.clipToOutline = true
    reactionBar.isClickable = true
    for ((emoji, chosen) in reactions) {
      val button = TextView(context)
      button.text = emoji
      button.textSize = 22f
      button.setTextColor(Theme.text)
      button.gravity = Gravity.CENTER
      button.includeFontPadding = false
      button.background = if (chosen) context.plate(0x29FFFFFF, 19f) else null
      button.contentDescription = "Реакция $emoji"
      button.isClickable = true; button.isFocusable = true
      button.setOnClickListener { close(); onReact(emoji) }
      button.measure(MeasureSpec.makeMeasureSpec(dp(38f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(dp(38f), MeasureSpec.EXACTLY))
      reactionBar.addView(button)
    }
    for (action in actions) panel.addView(ActionRow(context, action) { close(); action.run() })
    addView(reactionBar)
    addView(panel)
    alpha = 0f
  }

  /** One thing to do: its picture and its words, in one drawn view. */
  @SuppressLint("ViewConstructor")
  private class ActionRow(context: Context, private val action: Action, press: () -> Unit) : View(context) {
    private val d = resources.displayMetrics.density
    private val paint = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f * d; typeface = Theme.weight(400) }
    private val color = if (action.danger) Theme.danger else Theme.text

    init {
      isClickable = true; isFocusable = true
      contentDescription = action.label
      setOnClickListener { press() }
    }

    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }

    override fun onDraw(canvas: android.graphics.Canvas) {
      if (isPressed) canvas.drawColor(0x12FFFFFF)
      ChannelIcons.draw(canvas, action.symbol, 26f * d, height / 2f, 19f * d, color)
      paint.color = color
      canvas.drawText(action.label, 50f * d, height / 2f - (paint.ascent() + paint.descent()) / 2, paint)
    }
  }

  fun show() { animate().alpha(1f).setDuration(140).start() }

  fun close() {
    animate().alpha(0f).setDuration(120).withEndAction { (parent as? ViewGroup)?.removeView(this) }.start()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    val barWidth = minOf(dp(reactions.size * 42f + 10f), width - dp(24f))
    val panelWidth = dp(240f); val panelHeight = dp(actions.size * 46f)
    val total = dp(48f + 8f) + panelHeight
    val place = IntArray(2); getLocationOnScreen(place)
    val low = safeTop + dp(8f); val high = height - safeBottom - dp(8f) - total
    val y = maxOf(low, minOf(high, (anchor - place[1]).toInt() - dp(60f)))
    val x = maxOf(dp(12f), (width - barWidth) / 2)
    reactionBar.layout(x, y, x + barWidth, y + dp(48f))
    panel.visibility = if (actions.isEmpty()) GONE else VISIBLE
    panel.layout(x, y + dp(56f), x + panelWidth, y + dp(56f) + panelHeight)
  }
}

/** A channel's picture on the whole screen (the app's own viewer: pinch or double tap to zoom, the cross, a
 *  swipe down or Back to close). The picture is decoded off the main thread at the size of the screen. */
class ChannelPhotoOpener(private val host: View) {
  private var wanted = ""
  private var asked = false
  private val arrived: (String) -> Unit = { id -> if (id == wanted) show(last = true) }

  fun open(fileId: String) {
    if (fileId.isEmpty() || wanted == fileId) return
    stop()
    wanted = fileId
    ChannelImages.ready.watch(arrived)
    show(last = false)
  }

  private fun stop() {
    ChannelImages.ready.unwatch(arrived)
    wanted = ""
  }

  private fun show(last: Boolean) {
    val metrics = host.resources.displayMetrics
    val image = ChannelImages.image(wanted, maxOf(metrics.widthPixels, metrics.heightPixels))
    if (image == null) { if (last) stop(); return }
    stop()
    if (host.isAttachedToWindow) try { PhotoViewer(host.context, image, null).show() } catch (_: Exception) { /* the window is gone */ }
  }
}

/** Opens a channel's file with the app the person chooses: brought into the cache folder once, then a copy is
 *  handed over through the app's own provider (to read only) and removed when the next file is opened or the
 *  chat is left. */
class ChannelFileOpener(private val host: View) {
  private var busy = false
  private var shown: File? = null
  private val main = Handler(Looper.getMainLooper())

  init {
    host.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) {}
      override fun onViewDetachedFromWindow(view: View) = forget()
    })
  }

  private fun forget() {
    val folder = shown ?: return
    shown = null
    work.execute { DecryptedFiles.remove(folder) }
  }

  fun open(server: Server, id: String, name: String) {
    if (busy) return
    busy = true
    forget()
    val context = host.context.applicationContext
    work.execute {
      var written: DecryptedFiles.Written? = null
      val file = ChannelFiles.bring(server, id, name.ifEmpty { "file" })
      if (file != null) {
        val folder = File(context.cacheDir, DecryptedFiles.prefix + UUID.randomUUID().toString().lowercase())
        written = try { DecryptedFiles.Written(folder, file.copyTo(File(folder, file.name), overwrite = true)) } catch (_: Exception) { folder.deleteRecursively(); null }
      }
      main.post {
        busy = false
        if (written == null) return@post channelSay(host.context, "Не удалось открыть файл.")
        if (!host.isAttachedToWindow) { work.execute { DecryptedFiles.remove(written.folder) }; return@post }
        shown = written.folder
        val address = DecryptedFiles.address(host.context, written)
        val view = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(address, DecryptedFiles.mimeType(written.file.name))
          // The chosen app may read this one file, and only until it is deleted.
          clipData = ClipData.newRawUri("", address)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
          host.context.startActivity(Intent.createChooser(view, name).apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) })
        } catch (_: ActivityNotFoundException) {
          forget()
          channelSay(host.context, "Не удалось открыть файл.")
        }
      }
    }
  }

  private companion object {
    val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.channel-files").apply { isDaemon = true } }
  }
}

/** A message that waits for a connection (or was refused), above the field: one line with its state. */
@SuppressLint("ViewConstructor")
class WaitingChip(context: Context, text: String, state: String, failed: Boolean, spoken: String, onRetry: (() -> Unit)?, onClose: () -> Unit) : android.widget.LinearLayout(context) {
  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    background = context.plate(Theme.surface2, 16f)
    setPadding(context.px(12f), context.px(3f), context.px(6f), context.px(3f))
    addView(ChannelIconView(context, if (failed) "alert" else "clock", 14f, if (failed) Theme.danger else Theme.muted), LayoutParams(context.px(16f), context.px(28f)))
    val words = context.words(text.replace("\n", " "), 14f, Theme.text)
    words.maxLines = 1; words.ellipsize = android.text.TextUtils.TruncateAt.END
    addView(words, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(8f) })
    val note = context.words(state, 11f, if (failed) Theme.danger else Theme.muted)
    note.maxLines = 1
    addView(note, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(8f) })
    if (onRetry != null) {
      val again = ChannelIconButton(context, "refresh", 15f, Theme.muted)
      again.contentDescription = "Отправить ещё раз"
      again.setOnClickListener { onRetry() }
      addView(again, LayoutParams(context.px(28f), context.px(28f)).apply { leftMargin = context.px(8f) })
    }
    val close = ChannelIconButton(context, "cross", 15f, Theme.muted)
    close.contentDescription = if (failed) "Убрать" else "Отменить отправку"
    close.setOnClickListener { onClose() }
    addView(close, LayoutParams(context.px(28f), context.px(28f)).apply { leftMargin = if (onRetry == null) context.px(8f) else 0 })
    if (spoken.isNotEmpty()) contentDescription = spoken
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    // The words give way first: the state and the buttons are always whole.
    val words = getChildAt(1)
    (words.layoutParams as LayoutParams).let { it.width = LayoutParams.WRAP_CONTENT; it.weight = 0f }
    super.onMeasure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), heightSpec)
    val most = MeasureSpec.getSize(widthSpec)
    if (measuredWidth > most) {
      (words.layoutParams as LayoutParams).let { it.width = 0; it.weight = 1f }
      super.onMeasure(MeasureSpec.makeMeasureSpec(most, MeasureSpec.EXACTLY), heightSpec)
    }
  }
}
