package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.calls.CallEntry
import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.design.words
import com.linea.messenger.shell.RootScreen

/** A plate of glass as a view (inside a section the blur would see itself: the plain glass fill is drawn). */
open class GlassPlate(context: Context, private val radius: Float) : LinearLayout(context) {
  private val glass = Glass(this)
  private val d = resources.displayMetrics.density

  init { setWillNotDraw(false) }

  override fun onDraw(canvas: Canvas) {
    glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), radius * d)
    super.onDraw(canvas)
  }
}

/** ChatsPlus: «Выбрать» in the list's header and the choosing of chats (ChatListScreen.tsx `editing`). While
 *  choosing, every chat row has a round mark and a touch marks it; the title's line says «Отметь чаты» /
 *  «Выбрано: N»; the search, «Новый чат», the stories and the bar of sections give way, and a glass bar at the bottom
 *  holds what can be done with the chosen chats: «Прочитать все» (nothing chosen) / «Прочитать», «Звонок» /
 *  «Звонок · N» (one person rings the ordinary way, several become a room), «В архив» / «Из архива», «Удалить».
 *  «Готово» ends it. Main thread only (native/ios/Sources/ChatsPlus/ChatListEdit.swift). */
class ChatListEdit(private val context: Context, private val messenger: Messenger?) {
  var chosen: Set<String>? = null
    private set
  val selecting: Boolean get() = chosen != null
  val count: Int get() = chosen?.size ?: 0
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  val button = GlassPlate(context, 20f)
  private val buttonWords = context.words("Выбрать", 16f, Theme.text, 600)
  val bar = GlassPlate(context, 26f)
  private val readButton = item()
  private val callButton = item()
  private val archiveButton = item()
  private val removeButton = item(danger = true)
  private var host: ViewGroup? = null
  private var actions: ChatListActions? = null
  /** The mode began or ended, or a mark changed: the rows and the title are drawn again. */
  var onChange: (() -> Unit)? = null

  private fun item(danger: Boolean = false): TextView = context.words("", 14f, if (danger) Theme.danger else Theme.accent, 600).apply {
    gravity = Gravity.CENTER; maxLines = 1; isClickable = true; isFocusable = true
  }

  fun install(host: ViewGroup, actions: ChatListActions) {
    this.host = host
    this.actions = actions
    button.gravity = Gravity.CENTER
    buttonWords.gravity = Gravity.CENTER
    button.addView(buttonWords, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
    button.isClickable = true
    button.isFocusable = true
    button.setOnClickListener { it.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); set(if (selecting) null else emptySet()) }
    host.addView(button)
    bar.orientation = LinearLayout.HORIZONTAL
    bar.visibility = View.GONE
    // Each action as wide as its words, the same inset at both ends of the bar and equal room between them (equal
    // slices centred the words, so a short first and a long last word left uneven ends).
    bar.setPadding(dp(16f), 0, dp(16f), 0)
    for ((index, item) in listOf(readButton, callButton, archiveButton, removeButton).withIndex()) {
      if (index > 0) bar.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
      bar.addView(item, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT))
    }
    readButton.setOnClickListener { readChosen() }
    callButton.setOnClickListener { callChosen() }
    archiveButton.setOnClickListener { archiveChosen() }
    removeButton.setOnClickListener { removeChosen() }
    host.addView(bar)
    refresh()
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** The button left of the search (or, while choosing, where «Новый чат» stands), and the bar at the bottom. */
  fun place(width: Int, height: Int, safeTop: Int, safeBottom: Int, searchLeft: Int) {
    val side = buttonWords.paint.measureText(buttonWords.text.toString()).toInt() + dp(32f)
    val x = if (selecting) width - dp(20f) - side else searchLeft - dp(8f) - side
    put(button, x, safeTop + dp(8f), side, dp(40f))
    put(bar, dp(16f), height - maxOf(safeBottom, dp(12f)) - dp(6f) - dp(BAR_HEIGHT), width - dp(32f), dp(BAR_HEIGHT))
  }

  /** The room the list keeps at its bottom while choosing (the bar and its margins), px. */
  fun listBottom(safeBottom: Int): Int = maxOf(safeBottom, dp(12f)) + dp(6f + BAR_HEIGHT + 12f)

  fun isChosen(id: String): Boolean = chosen?.contains(id) ?: false

  /** A touch on a row while choosing: its mark goes on or off. */
  fun toggle(id: String) {
    val set = chosen ?: return
    host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    chosen = if (set.contains(id)) set - id else set + id
    refresh()
    onChange?.invoke()
  }

  /** Begins (an empty set), ends (null) or replaces what is chosen. */
  fun set(next: Set<String>?) {
    val was = selecting
    chosen = next
    refresh()
    if (was != selecting) {
      host?.let { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(it.windowToken, 0) }
      root()?.setBarAway(selecting)
      bar.animate().cancel()
      if (selecting) {
        bar.alpha = 0f; bar.visibility = View.VISIBLE
        bar.animate().alpha(1f).setDuration(180).start()
      } else {
        bar.animate().alpha(0f).setDuration(180).withEndAction { if (!selecting) bar.visibility = View.GONE }.start()
      }
      host?.requestLayout()
    }
    onChange?.invoke()
  }

  private fun root(): RootScreen? {
    var above = host?.parent
    while (above != null && above !is RootScreen) above = above.parent
    return above as? RootScreen
  }

  private fun refresh() {
    buttonWords.text = if (selecting) "Готово" else "Выбрать"
    button.contentDescription = buttonWords.text
    // Owner: no «Выбрать» on the main screen; choosing starts from a chat's long-press menu, only «Готово» shows.
    button.visibility = if (selecting) android.view.View.VISIBLE else android.view.View.GONE
    val marked = count
    val archive = actions?.showingArchive ?: false
    readButton.text = if (marked > 0) "Прочитать" else "Прочитать все"
    callButton.text = if (marked > 1) "Звонок · $marked" else "Звонок"
    callButton.contentDescription = "Позвонить выбранным"
    archiveButton.text = if (archive) "Из архива" else "В архив"
    removeButton.text = "Удалить"
    for (item in listOf(callButton, archiveButton, removeButton)) {
      item.isEnabled = marked > 0
      item.alpha = if (marked > 0) 1f else 0.4f
    }
    host?.requestLayout()
  }

  // What is done with the chosen chats

  private val picked: List<String> get() = chosen?.toList() ?: emptyList()

  private fun readChosen() {
    actions?.groupRead(picked)
    host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    set(null)
  }

  private fun archiveChosen() {
    if (count == 0) return
    actions?.groupArchive(picked, !(actions?.showingArchive ?: false))
    host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    set(null)
  }

  private fun removeChosen() {
    if (count == 0) return
    actions?.groupRemove(picked) { set(null) }
  }

  /** One chosen person is an ordinary call; several become a room and everyone is called at once. */
  private fun callChosen() {
    val actions = actions ?: return
    if (count == 0) return
    val chats = actions.summaries(picked)
    set(null)
    host?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    val first = chats.firstOrNull() ?: return
    if (chats.size == 1) return CallEntry.call(messenger, first.id, first.peerId, first.title, video = false)
    if (messenger == null) return
    com.linea.messenger.rooms.Rooms.startCall(chats.map { it.peerId }) { words ->
      if (words != null) ChatAttachments.say(context, words.ifEmpty { "Не удалось позвонить." })
    }
  }

  companion object { const val BAR_HEIGHT = 52f }
}
