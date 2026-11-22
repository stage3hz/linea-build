package com.linea.messenger.chats

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
import android.widget.FrameLayout
import android.widget.ListView

/** The chat list as one scrolling view. The framework ListView recycles the rows; each row is a single
 *  canvas-drawn view (ChatRowView). The owner gives the rows and the colours and hears the taps. */
@SuppressLint("ViewConstructor")
class ChatListView(context: Context) : FrameLayout(context) {
  // The window asks for the display's highest refresh rate: a phone with
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

  /** A tap on a row. */
  var onRowPress: (id: String) -> Unit = {}
  /** How far the rows have gone up under the floating header, px (0 at rest, at the top of the list). */
  var onScrolledUnder: (Int) -> Unit = {}
  /** A long press on a row; `y` is the finger's place on the screen, px. */
  var onRowLongPress: (id: String, y: Float) -> Unit = { _, _ -> }
  /** One of the row's swipe buttons. */
  var onRowAction: (id: String, action: String) -> Unit = { _, _ -> }
  /** ChatsPlus: whether a sideways drag that began at `startX` and went `dx` turns the folder instead of opening a
   *  row's buttons (chatsplus/ChatListPlus.kt); then the drag goes to `onFolderDrag` and `onFolderRelease`. */
  var folderClaims: ((startX: Float, dx: Float) -> Boolean)? = null
  var onFolderDrag: ((dx: Float) -> Unit)? = null
  var onFolderRelease: ((dx: Float, velocity: Float) -> Unit)? = null
  private var folderDrag = false
  private var folderTracker: android.view.VelocityTracker? = null
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

  // Swiping a row sideways: the row follows the finger and uncovers its buttons; past half
  // of them it stays open, a swipe across most of the row performs the outermost action at once.
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
    if (action != null && id.isNotEmpty()) onRowAction(id, action)
  }

  /** True when the gesture belongs to a row's swipe and the list must not see it. */
  private fun swipeTouch(list: ListView, event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x; downY = event.y; dragging = false; folderDrag = false
        folderTracker?.recycle(); folderTracker = android.view.VelocityTracker.obtain(); folderTracker?.addMovement(event)
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
        folderTracker?.addMovement(event)
        // ChatsPlus: a drag that turns the folder (from the middle of a row; listSwipes.ts `rowClaimsSwipe`).
        if (folderDrag) { onFolderDrag?.invoke(event.x - downX); return true }
        if (!dragging && !swallow && open == null) {
          val fx = event.x - downX; val fy = event.y - downY
          if (Math.abs(fx) >= slop && Math.abs(fx) > Math.abs(fy) * 1.3f && folderClaims?.invoke(downX, fx) == true) {
            folderDrag = true
            list.parent?.requestDisallowInterceptTouchEvent(true)
            val cancel = MotionEvent.obtain(event); cancel.action = MotionEvent.ACTION_CANCEL; list.onTouchEvent(cancel); cancel.recycle()
            onFolderDrag?.invoke(fx)
            return true
          }
        }
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
        if (folderDrag) {
          folderDrag = false
          folderTracker?.addMovement(event); folderTracker?.computeCurrentVelocity(1000)
          val velocity = if (event.actionMasked == MotionEvent.ACTION_UP) folderTracker?.xVelocity ?: 0f else 0f
          onFolderRelease?.invoke(if (event.actionMasked == MotionEvent.ACTION_UP) event.x - downX else 0f, velocity)
          target = null
          return true
        }
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
    // Stories: a header above the first chat (`setHeader`) takes the first place of the list.
    setOnItemClickListener { _, _, position, _ -> rows.getOrNull(position - headerViewsCount)?.let { onRowPress(it.id) } }
    setOnItemLongClickListener { _, _, position, _ ->
      val row = rows.getOrNull(position - headerViewsCount) ?: return@setOnItemLongClickListener false
      onRowLongPress(row.id, lastTouchY); true
    }
  }

  init {
    addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    // ChatsPlus: «Архив» behind the pull settles open or shut when the list comes to rest.
    list.setOnScrollListener(object : android.widget.AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: android.widget.AbsListView?, state: Int) {
        if (state == android.widget.AbsListView.OnScrollListener.SCROLL_STATE_IDLE) snapPull()
      }
      override fun onScroll(view: android.widget.AbsListView?, first: Int, visible: Int, total: Int) {
        val top = list.getChildAt(0)?.top ?: 0
        if (first == 0) { if (top > lastFirstTop) pullDirection = -1 else if (top < lastFirstTop) pullDirection = 1 }
        lastFirstTop = top
        // ChatsPlus: how far the rows have gone up under the floating header (0 at rest).
        onScrolledUnder(if (first > 0) 10_000 else maxOf(0, list.paddingTop - top))
      }
    })
  }

  fun setRows(next: List<ChatRow>) {
    if (next == rows) return
    // ChatsPlus: a chat that moves up (a new message, a pin) slides to its place instead of jumping.
    val before = movable(next)
    rows = next; open?.let { settle?.cancel(); it.swipeX = 0f; open = null }; adapter.notifyDataSetChanged()
    if (before != null) slideFrom(before)
  }

  // ChatsPlus — rows that move, «Архив» behind a pull

  private val motionOff: Boolean
    get() = try { android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }

  /** The reference's LayoutAnimation (220 ms, ease in-out, opacity): when only a few chats come or go and the rest
   *  change places, the rows on screen slide from where they stood and the new ones fade in. The tops of the rows on
   *  screen by id, or null when nothing should move. */
  private fun movable(next: List<ChatRow>): Map<String, Int>? {
    if (motionOff || !isAttachedToWindow || rows.isEmpty() || next.isEmpty()) return null
    val oldIds = rows.map { it.id }; val newIds = next.map { it.id }
    if (oldIds == newIds || oldIds.toSet().size != oldIds.size || newIds.toSet().size != newIds.size) return null
    val gone = oldIds.count { it !in newIds.toSet() }; val came = newIds.count { it !in oldIds.toSet() }
    if (gone + came > 4) return null
    val tops = HashMap<String, Int>()
    for (index in 0 until list.childCount) {
      val child = list.getChildAt(index) as? ChatRowView ?: continue
      if (child.rowId.isNotEmpty()) tops[child.rowId] = child.top
    }
    return tops
  }

  private fun slideFrom(before: Map<String, Int>) {
    list.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
      override fun onPreDraw(): Boolean {
        list.viewTreeObserver.removeOnPreDrawListener(this)
        val curve = android.view.animation.AccelerateDecelerateInterpolator()
        for (index in 0 until list.childCount) {
          val child = list.getChildAt(index) as? ChatRowView ?: continue
          child.animate().cancel()
          val was = before[child.rowId]
          if (was == null) {
            child.alpha = 0f; child.translationY = 0f
            child.animate().alpha(1f).setDuration(220).setInterpolator(curve).start()
          } else if (was != child.top) {
            child.translationY = (was - child.top).toFloat(); child.alpha = 1f
            child.animate().translationY(0f).setDuration(220).setInterpolator(curve).start()
          } else { child.translationY = 0f; child.alpha = 1f }
        }
        return true
      }
    })
  }

  private var pull: View? = null

  /** A view hidden above the first row (the stories strip included), brought out by pulling the list down
   *  (ChatListScreen.tsx: «Архив» above the first chat, out of sight until the list is pulled). A drag that ends with it
   *  partly shown settles open or shut in the drag's direction (listSwipes.ts `archiveSnap`). null takes it away. */
  fun setPull(view: View?) {
    if (view === pull) return
    val hadPull = pull != null
    pull?.let { list.removeHeaderView(it) }
    pull = view
    val strip = header
    if (view != null) {
      // The pull comes first, the stories after it.
      strip?.let { list.removeHeaderView(it) }
      list.addHeaderView(view, null, false)
      strip?.let { list.addHeaderView(it, null, false) }
      // At rest it is out of sight under the floating header.
      if (!hadPull) list.post { if (pull === view && list.firstVisiblePosition == 0) list.setSelectionFromTop(1, list.paddingTop) }
    }
  }

  /** For the emulator check: «Архив» pulled out and left open. */
  fun openPull() { if (pull != null) list.post { list.setSelectionFromTop(0, list.paddingTop) } }

  private fun snapPull() {
    val view = pull ?: return
    if (list.firstVisiblePosition != 0) return
    val first = list.getChildAt(0) ?: return
    if (first !== view) return
    val shown = view.bottom - list.paddingTop
    val tall = view.height
    if (shown <= 0 || shown >= tall) return
    val open = if (pullDirection < 0) true else if (pullDirection > 0) false else shown >= tall / 2
    if (open) list.smoothScrollBy(-(tall - shown), 180) else list.smoothScrollBy(shown, 180)
    if (open) performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
  }

  private var pullDirection = 0
  private var lastFirstTop = 0

  fun setPalette(next: ChatPalette) {
    if (next == palette) return
    palette = next; adapter.notifyDataSetChanged()
  }

  /** The headers the app sends with a file request (its session); used only to fetch avatars. */
  fun setHeaders(headers: Map<String, String>) { AvatarStore.headers = headers }

  /** Nameplate pictures (id → base64 PNG). */
  fun setPlates(plates: Map<String, String>) { if (DecorStore.setPlates(plates)) adapter.notifyDataSetChanged() }

  /** Room above the first row and under the last one, px: what the heading and the bar cover. */
  /** Stories: a view above the first chat that scrolls away with the list (stories/StoriesStrip.kt); null takes
   *  it away. The view comes with its size set. */
  fun setHeader(view: View?) {
    if (view === header) return
    header?.let { list.removeHeaderView(it) }
    header = view
    if (view != null) list.addHeaderView(view, null, false)
  }

  /** Whether a header (the pull, the stories) stands above the rows: the rows' positions start after them. */
  val headers: Int get() = list.headerViewsCount
  private var header: View? = null

  fun setPad(top: Int, bottom: Int) { if (list.paddingTop != top || list.paddingBottom != bottom) list.setPadding(0, top, 0, bottom) }
}
