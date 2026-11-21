package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChatHistory
import com.linea.messenger.chatactions.ChatLocal
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.design.edges
import com.linea.messenger.design.words

/** ChatsPlus: a hold on a chat row (ChatListScreen.tsx `ChatPeek` in ContextMenu.tsx): the screen dims, a card with
 *  the chat itself — the person's name and @name over its last 14 messages — comes up from the finger over a glass
 *  menu with what can be done with the chat. A touch beside them (or a pull down) puts them away. The messages are
 *  the ones this device has already decrypted; nothing is asked of the server for the card
 *  (native/ios/Sources/ChatsPlus/ChatPeekMenu.swift). */
class ChatPeekMenu(
  context: Context, private val anchorY: Float, name: String, username: String, initials: String, avatarColor: Int,
  lines: List<Line>, private val choices: List<ChoiceSheet.Choice>,
) : Dialog(context, android.R.style.Theme_Translucent_NoTitleBar) {
  class Line(val text: String, val mine: Boolean)

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var lines: List<Line> = lines.takeLast(14)
  private val page = Page(context)
  private val card = Card(context)
  private val avatar = TextView(context).apply {
    text = initials; textSize = 14f; typeface = Theme.weight(700); setTextColor(Color.WHITE); gravity = Gravity.CENTER
    background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xFF000000.toInt() or (avatarColor and 0xFFFFFF)) }
  }
  private val nameLabel = context.words(name, 15f, Theme.text, 700).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
  private val userLabel = context.words(if (username.isEmpty()) "" else "@$username", 12f, Theme.muted).apply { maxLines = 1 }
  private val messages = ArrayList<TextView>()
  private val emptyLabel = context.words("Сообщений пока нет", 15f, Theme.muted).apply { gravity = Gravity.CENTER }
  private val panel = Panel(context)
  private var shown = false

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    card.addView(avatar); card.addView(nameLabel); card.addView(userLabel); card.addView(emptyLabel)
    page.addView(card)
    choices.forEach { choice ->
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isClickable = true; isFocusable = true
        contentDescription = choice.label
        setPadding(dp(16f), 0, dp(16f), 0)
        background = android.graphics.drawable.StateListDrawable().apply { addState(intArrayOf(android.R.attr.state_pressed), ColorDrawable(Theme.veil(0.08f))) }
        val ink = if (choice.danger) Theme.danger else Theme.text
        addView(PlusIconView(context, choice.symbol, 19f, ink), LinearLayout.LayoutParams(dp(22f), dp(22f)).apply { rightMargin = dp(13f) })
        addView(context.words(choice.label, 15.5f, ink).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        setOnClickListener { dismiss(); choice.run() }
      }
      panel.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44f)))
    }
    page.addView(panel)
    buildLines()
    setContentView(page)
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      setDimAmount(0f)
      addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
    }
    setCanceledOnTouchOutside(true)
  }

  /** The messages arrived after the card was opened (they are read from the private storage in the background). */
  fun setLines(next: List<Line>) {
    lines = next.takeLast(14)
    buildLines()
    page.requestLayout()
  }

  private fun buildLines() {
    messages.forEach { card.removeView(it) }
    messages.clear()
    for (line in lines) {
      // The owner's open look: own lines at the right edge, the other side's at the left, no bubbles.
      val label = context.words(line.text, 14f, Theme.text).apply { maxLines = 4; ellipsize = TextUtils.TruncateAt.END; gravity = if (line.mine) Gravity.END else Gravity.START }
      messages.add(label)
      card.addView(label)
    }
    emptyLabel.visibility = if (lines.isEmpty()) View.VISIBLE else View.GONE
  }

  private val motionOff: Boolean
    get() = try { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }

  /** The card starts at the finger (scaled to .96), the menu at a third of its size from its top; both spring in. */
  private fun enter(top: Int) {
    if (shown) return
    shown = true
    card.translationY = anchorY - dp(20f) - top
    card.scaleX = 0.96f; card.scaleY = 0.96f; card.alpha = 0f
    panel.pivotY = 0f; panel.scaleX = 0.35f; panel.scaleY = 0.35f; panel.alpha = 0f
    val time = if (motionOff) 1L else 420L
    card.animate().translationY(0f).scaleX(1f).scaleY(1f).alpha(1f).setDuration(time).setInterpolator(OvershootInterpolator(0.6f)).start()
    panel.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(time).setInterpolator(OvershootInterpolator(0.6f)).start()
  }

  override fun show() {
    last = java.lang.ref.WeakReference(this)
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  /** The whole screen: the dim, the card, the menu; a touch beside them closes, a pull down follows and closes. */
  private inner class Page(context: Context) : ViewGroup(context) {
    private var downY = 0f
    private var pulling = false
    private var tracker: VelocityTracker? = null

    init { setBackgroundColor(if (Theme.dark) 0x8F000000.toInt() else 0x3D141E3C) }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val width = r - l; val height = b - t
      val safe = rootWindowInsets?.edges()
      val safeTop = safe?.top ?: 0; val safeBottom = safe?.bottom ?: 0
      val column = minOf(dp(340f), width - dp(24f))
      val peekHeight = minOf(dp(440f), height / 2)
      val menuWidth = minOf(dp(250f), column)
      val menuHeight = choices.size * dp(44f)
      val size = peekHeight + dp(8f) + menuHeight
      val top = maxOf(safeTop + dp(8f), minOf((anchorY - dp(70f)).toInt(), height - safeBottom - dp(8f) - size))
      val left = (width - column) / 2
      card.measure(MeasureSpec.makeMeasureSpec(column, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(peekHeight, MeasureSpec.EXACTLY))
      card.layout(left, top, left + column, top + peekHeight)
      panel.measure(MeasureSpec.makeMeasureSpec(menuWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(menuHeight, MeasureSpec.EXACTLY))
      val menuLeft = (width - menuWidth) / 2; val menuTop = top + peekHeight + dp(8f)
      panel.layout(menuLeft, menuTop, menuLeft + menuWidth, menuTop + menuHeight)
      enter(top)
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
      if (event.actionMasked == MotionEvent.ACTION_DOWN) { downY = event.rawY; pulling = false }
      if (event.actionMasked == MotionEvent.ACTION_MOVE && event.rawY - downY > dp(12f)) { pulling = true; return true }
      return false
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (tracker == null) tracker = VelocityTracker.obtain()
      tracker?.addMovement(event)
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> { downY = event.rawY; return true }
        MotionEvent.ACTION_MOVE -> {
          val down = maxOf(0f, event.rawY - downY)
          if (down > dp(12f)) pulling = true
          if (pulling) { card.translationY = down; panel.translationY = down }
          return true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          val down = maxOf(0f, event.rawY - downY)
          tracker?.computeCurrentVelocity(1000)
          val speed = (tracker?.yVelocity ?: 0f) / d
          tracker?.recycle(); tracker = null
          if (!pulling) { if (event.actionMasked == MotionEvent.ACTION_UP) dismiss(); return true }
          if (event.actionMasked == MotionEvent.ACTION_UP && (down > dp(90f) || speed > 900)) dismiss()
          else { card.animate().translationY(0f).setDuration(200).start(); panel.animate().translationY(0f).setDuration(200).start() }
          pulling = false
          return true
        }
      }
      return true
    }
  }

  /** The card: the person and the newest messages, from the bottom up as in a chat. */
  private inner class Card(context: Context) : ViewGroup(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    init { setWillNotDraw(false); clipToOutline = true; outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(view: View, outline: android.graphics.Outline) = outline.setRoundRect(0, 0, view.width, view.height, 24f * d)
    } }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val column = r - l; val height = b - t
      fun put(view: View, x: Int, y: Int, w: Int, h: Int) {
        view.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY)); view.layout(x, y, x + w, y + h)
      }
      put(avatar, dp(14f), dp(10f), dp(36f), dp(36f))
      put(nameLabel, dp(60f), dp(10f), column - dp(74f), dp(19f))
      put(userLabel, dp(60f), dp(30f), column - dp(74f), dp(15f))
      val boxTop = dp(57f); val boxLeft = dp(10f); val boxWidth = column - dp(20f); val boxHeight = height - dp(57f) - dp(10f)
      var y = boxHeight
      val widest = (boxWidth * 0.82f).toInt()
      for (index in messages.indices.reversed()) {
        val label = messages[index]
        label.measure(MeasureSpec.makeMeasureSpec(widest, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val h = label.measuredHeight + dp(12f)
        y -= h
        val x = if (lines.getOrNull(index)?.mine == true) boxLeft + boxWidth - widest else boxLeft
        label.layout(x, boxTop + y + dp(6f), x + widest, boxTop + y + dp(6f) + label.measuredHeight)
        label.visibility = if (y < -h) View.INVISIBLE else View.VISIBLE
        y -= dp(4f)
      }
      put(emptyLabel, boxLeft, boxTop + boxHeight - dp(40f), boxWidth, dp(20f))
    }

    override fun onDraw(canvas: Canvas) {
      paint.color = Theme.bg
      canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), 24f * d, 24f * d, paint)
      paint.color = Theme.veil(0.12f)
      canvas.drawRect(0f, 56f * d, width.toFloat(), 56f * d + maxOf(1f, d / 2), paint)
      line.color = Theme.veil(0.12f); line.strokeWidth = maxOf(1f, d / 2)
      canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), 24f * d, 24f * d, line)
    }
  }

  /** The glass menu under the card. */
  private inner class Panel(context: Context) : LinearLayout(context) {
    private val glass = Glass(this)
    init { orientation = VERTICAL; setWillNotDraw(false) }
    override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 26f * d)
  }

  companion object {
    /** The card on the screen now, if any (for the checks). */
    var last: java.lang.ref.WeakReference<ChatPeekMenu>? = null

    /** The lines of the card: the newest messages this device keeps decrypted for the chat (the actions on messages,
     *  the hidden ones and the empty ones left out), oldest first. Main thread in, main thread out. */
    fun peekLines(context: Context, messenger: Messenger, chatId: String, done: (List<Line>) -> Unit) {
      val me = messenger.userId
      val hidden = ChatLocal.of(context, messenger).hiddenKeys.toSet()
      messenger.crypto.run({ crypto: CryptoService ->
        val kept = (crypto.callNow("history", listOf(chatId, 60)).getOrNull() as? List<*>).orEmpty().mapNotNull { Core.map(it) }
        lines(kept, me, hidden)
      }, done)
    }

    /** The kept history (newest first, as the storage gives it) as the card's lines, oldest first, at most 14. */
    fun lines(kept: List<Map<String, Any?>>, me: String, hidden: Set<String>): List<Line> {
      val out = ArrayList<Line>()
      for (item in kept.reversed()) {
        if (ChatHistory.action(item) != null || hidden.contains(ChatHistory.key(item))) continue
        var text = (item["text"] as? String ?: "").trim()
        if (text.isEmpty()) Core.map(item["attachment"])?.let { text = ChatRowLooks.attachmentLine(it).first }
        if (text.isEmpty()) text = "Сообщение"
        out.add(Line(text, item["senderId"] == me))
      }
      return out.takeLast(14)
    }
  }
}
