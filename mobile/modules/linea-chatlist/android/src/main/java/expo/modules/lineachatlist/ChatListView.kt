package expo.modules.lineachatlist

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ListView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** The chat list as one native scrolling view (see ../index.ts). The framework ListView recycles the rows; each row
 *  is a single canvas-drawn view (ChatRowView), so scrolling and updates never go through React. */
@SuppressLint("ViewConstructor")
class ChatListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // The window asks for the display's highest refresh rate (Telegram for Android does the same): a phone with
  // a 90 or 120 Hz screen may otherwise keep an app at 60. Done here because this list is the first screen.
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    try {
      var owner: Context? = context
      while (owner is android.content.ContextWrapper && owner !is android.app.Activity) owner = owner.baseContext
      val window = (owner as? android.app.Activity)?.window ?: return
      val fastest = display?.supportedRefreshRates?.maxOrNull() ?: return
      val params = window.attributes
      if (fastest > 0f && params.preferredRefreshRate != fastest) { params.preferredRefreshRate = fastest; window.attributes = params }
    } catch (_: Throwable) { /* the system keeps its own choice */ }
  }

  private val onRowPress by EventDispatcher()
  private val onRowLongPress by EventDispatcher()
  private val onRowAction by EventDispatcher()
  private val d = resources.displayMetrics.density
  private var rows: List<ChatRow> = emptyList()
  private var palette = ChatPalette.DARK
  private var lastTouchY = 0f

  private val adapter = object : BaseAdapter() {
    override fun getCount() = rows.size
    override fun getItem(position: Int) = rows[position]
    override fun getItemId(position: Int) = rows[position].id.hashCode().toLong()
    override fun hasStableIds() = true
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val view = convertView as? ChatRowView ?: ChatRowView(context)
      view.bind(rows[position], palette)
      return view
    }
  }

  // Swiping a row sideways (as the React list does): the row follows the finger and uncovers its buttons; past half
  // of them it stays open, a swipe across most of the row performs the outermost action at once (as in Telegram).
  private val slop = ViewConfiguration.get(context).scaledTouchSlop
  private var open: ChatRowView? = null
  private var target: ChatRowView? = null
  private var dragging = false
  private var swallow = false
  private var downX = 0f
  private var downY = 0f
  private var startX = 0f
  private var settle: ValueAnimator? = null

  private fun slide(view: ChatRowView, to: Float) {
    settle?.cancel()
    settle = ValueAnimator.ofFloat(view.swipeX, to).apply {
      duration = 180
      addUpdateListener { view.swipeX = it.animatedValue as Float }
      start()
    }
    open = if (to == 0f) null else view
  }
  private fun closeOpen() { open?.let { slide(it, 0f) } }
  private fun act(view: ChatRowView, action: String?) {
    val id = view.rowId
    slide(view, 0f)
    if (action != null && id.isNotEmpty()) onRowAction(mapOf("id" to id, "action" to action))
  }

  /** True when the gesture belongs to a row's swipe and the list must not see it. */
  private fun swipeTouch(list: ListView, event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x; downY = event.y; dragging = false
        val position = list.pointToPosition(event.x.toInt(), event.y.toInt())
        target = if (position < 0) null else list.getChildAt(position - list.firstVisiblePosition) as? ChatRowView
        val shown = open
        // A touch anywhere while a row is open belongs to that row: its button, or closing it.
        swallow = shown != null
        if (shown != null && shown !== target) closeOpen()
        startX = target?.swipeX ?: 0f
        return swallow
      }
      MotionEvent.ACTION_MOVE -> {
        val view = target ?: return swallow
        val dx = event.x - downX; val dy = event.y - downY
        if (!dragging) {
          if (Math.abs(dx) < slop || Math.abs(dx) < Math.abs(dy) * 1.5f) return swallow
          if (startX == 0f && view.buttons(if (dx > 0) 1 else -1).isEmpty()) return swallow
          dragging = true; settle?.cancel()
          list.parent?.requestDisallowInterceptTouchEvent(true)
          if (!swallow) { val cancel = MotionEvent.obtain(event); cancel.action = MotionEvent.ACTION_CANCEL; list.onTouchEvent(cancel); cancel.recycle() }
        }
        var x = startX + dx
        if (x > 0 && view.buttons(1).isEmpty() || x < 0 && view.buttons(-1).isEmpty()) x = 0f
        view.swipeX = x.coerceIn(-view.width.toFloat(), view.width.toFloat())
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val view = target; target = null
        if (dragging && view != null) {
          dragging = false
          val x = view.swipeX; val side = if (x > 0) 1 else -1; val rest = view.buttonsWidth(side)
          when {
            event.actionMasked == MotionEvent.ACTION_UP && Math.abs(x) > view.width * 0.6f -> act(view, view.buttons(side).firstOrNull()?.substringBefore(':'))
            Math.abs(x) > rest / 2 -> slide(view, side * rest)
            else -> slide(view, 0f)
          }
          return true
        }
        if (swallow) {
          if (view != null && view === open && event.actionMasked == MotionEvent.ACTION_UP) act(view, view.actionAt(event.x)) else closeOpen()
          return true
        }
        return false
      }
    }
    return dragging || swallow
  }

  private val list = object : ListView(context) {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
      lastTouchY = event.rawY
      if (swipeTouch(this, event)) return true
      return super.dispatchTouchEvent(event)
    }
  }.apply {
    divider = null; dividerHeight = 0
    selector = ColorDrawable(Color.TRANSPARENT); cacheColorHint = Color.TRANSPARENT
    isVerticalScrollBarEnabled = false; clipToPadding = false; overScrollMode = View.OVER_SCROLL_ALWAYS
    this.adapter = this@ChatListView.adapter
    setOnItemClickListener { _, _, position, _ -> rows.getOrNull(position)?.let { onRowPress(mapOf("id" to it.id)) } }
    setOnItemLongClickListener { _, _, position, _ ->
      val row = rows.getOrNull(position) ?: return@setOnItemLongClickListener false
      onRowLongPress(mapOf("id" to row.id, "y" to (lastTouchY / d).toDouble())); true
    }
  }

  init { addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }

  fun setRows(next: List<ChatRow>) {
    if (next == rows) return
    rows = next; open?.let { settle?.cancel(); it.swipeX = 0f; open = null }; adapter.notifyDataSetChanged()
  }

  fun setPalette(next: ChatPalette) {
    if (next == palette) return
    palette = next; adapter.notifyDataSetChanged()
  }

  /** The headers the app sends with a file request (its session); used only to fetch avatars. */
  fun setHeaders(headers: Map<String, String>) { AvatarStore.headers = headers }

  /** Nameplate pictures (id → base64 PNG), drawn once by the app's own vector art. */
  fun setPlates(plates: Map<String, String>) { if (DecorStore.setPlates(plates)) adapter.notifyDataSetChanged() }

  fun setPadding(top: Float, bottom: Float) { list.setPadding(0, (top * d).toInt(), 0, (bottom * d).toInt()) }

  // React Native lays its views out itself and does not run Android's layout pass for views added natively: after
  // the list asks for a layout (new data, a recycled row) it is measured and placed here.
  private val place = Runnable {
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    layout(left, top, right, bottom)
  }
  override fun requestLayout() { super.requestLayout(); post(place) }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    list.measure(MeasureSpec.makeMeasureSpec(right - left, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(bottom - top, MeasureSpec.EXACTLY))
    list.layout(0, 0, right - left, bottom - top)
  }
}
