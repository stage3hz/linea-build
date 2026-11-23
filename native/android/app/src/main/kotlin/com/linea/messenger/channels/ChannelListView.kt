package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.ListView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px

// The list of a channel's messages, on the principles of chat/MsgListView.kt: the platform's ListView with
// reused row views, one drawn view per row, nothing nested inside rows, filled from the bottom.
//
// What is different: the list never measures anything. It is handed finished layouts (made off the main thread
// by ChannelEngine) in small patches — one row in, one row changed, one row out, a page of older rows — and
// only puts them in. Every row's height is known beforehand, so after each patch the list is put back exactly
// where it was: on the row the person is reading (older pages and new messages arrive without moving it), or at
// its end. A new message is one new row; an edit or a reaction of the same height is one redrawn row.

/** A change of the list, ready to be shown. Rows are oldest first. */
class ChannelPatch {
  /** Not null: everything is replaced by these rows. */
  var reset: List<ChannelRowLayout>? = null
  var removed: List<Long> = emptyList()
  var updated: MutableList<ChannelRowLayout> = ArrayList()
  /** A page of older rows, to stand before everything shown. */
  var older: List<ChannelRowLayout> = emptyList()
  /** New rows, to stand after everything shown. */
  var newest: List<ChannelRowLayout> = emptyList()
  /** One of the new rows is the person's own: the list goes to its end. */
  var own = false

  val isEmpty: Boolean get() = reset == null && removed.isEmpty() && updated.isEmpty() && older.isEmpty() && newest.isEmpty()
}

@SuppressLint("ViewConstructor")
class ChannelListView(context: Context) : FrameLayout(context) {
  /** The oldest rows are about to be shown: time to bring a page of older ones. */
  var onNearTop: () -> Unit = {}
  var onPress: (ChannelRowLayout, ChannelHit) -> Unit = { _, _ -> }
  /** A row held: the layout, and where on the screen (px). */
  var onLongPress: (ChannelRowLayout, Float) -> Unit = { _, _ -> }
  /** The width rows are laid out for has changed (px). */
  var onWidth: (Int) -> Unit = {}

  /** Oldest first (the last one is at the bottom of the screen). */
  private val items = ArrayList<ChannelRowLayout>()
  /** The person is at the newest message (changed only by their own scrolling). */
  private var pinned = true
  private var askedAt = 0L
  private var knownWidth = 0
  private var lastTouchY = 0f
  private var upX = 0f
  private var upY = 0f
  /** The list is being put in place by the code, not moved by a finger. */
  private var settling = false

  val isEmpty: Boolean get() = items.isEmpty()
  /** The newest row shown, if any. */
  val newest: ChannelRowLayout? get() = items.lastOrNull()
  /** How many rows are in the list (for checks). */
  val count: Int get() = items.size

  private val adapter = object : BaseAdapter() {
    override fun getCount() = items.size
    override fun getItem(position: Int) = items[position]
    override fun getItemId(position: Int) = items[position].row.id
    override fun hasStableIds() = true
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val view = convertView as? ChannelRowView ?: ChannelRowView(context).also { made -> made.onProfile = { onPress(it, ChannelHit.Author) } }
      view.show(items[position])
      return view
    }
  }

  private val list = object : ListView(context) {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean { lastTouchY = event.rawY; upX = event.x; upY = event.y; return super.dispatchTouchEvent(event) }
  }.apply {
    divider = null; dividerHeight = 0
    selector = ColorDrawable(Color.TRANSPARENT); cacheColorHint = Color.TRANSPARENT
    isVerticalScrollBarEnabled = false; clipToPadding = false
    overScrollMode = View.OVER_SCROLL_NEVER
    // The place is kept by this class itself (`settle`), not by the list's own transcript rule.
    isStackFromBottom = true; transcriptMode = AbsListView.TRANSCRIPT_MODE_DISABLED
    this.adapter = this@ChannelListView.adapter
    setOnItemClickListener { _, view, position, _ ->
      val layout = items.getOrNull(position) ?: return@setOnItemClickListener
      onPress(layout, layout.hit(upX - view.left, upY - view.top))
    }
    setOnItemLongClickListener { _, _, position, _ ->
      val layout = items.getOrNull(position) ?: return@setOnItemLongClickListener false
      onLongPress(layout, lastTouchY); true
    }
    setOnScrollListener(object : AbsListView.OnScrollListener {
      private var moving = false
      override fun onScrollStateChanged(view: AbsListView?, state: Int) { moving = state != AbsListView.OnScrollListener.SCROLL_STATE_IDLE; if (!moving) look(byFinger = true) }
      override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {
        look(byFinger = moving && !settling)
        // Once per «oldest row»: asked again only after older rows have arrived.
        val oldest = items.firstOrNull()?.row?.id ?: return
        if (total > 0 && first <= 12 && askedAt != oldest) { askedAt = oldest; onNearTop() }
      }
    })
  }

  private val toEnd = ChannelIconButton(context, "ion:chevron-down", 20f, Theme.text).apply {
    background = context.plate(Theme.surface2, 19f, Theme.veil(0.1f))
    contentDescription = "К новым сообщениям"
    alpha = 0f
    visibility = View.GONE
    setOnClickListener { scrollToEnd() }
  }

  private val pictureReady: (String) -> Unit = { id ->
    for (index in 0 until list.childCount) {
      val row = list.getChildAt(index) as? ChannelRowView ?: continue
      if (row.layoutInfo?.pictures?.contains(id) == true) row.invalidate()
    }
  }

  init {
    addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(toEnd, LayoutParams(context.px(38f), context.px(38f)))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ChannelImages.ready.watch(pictureReady)
  }

  override fun onDetachedFromWindow() {
    ChannelImages.ready.unwatch(pictureReady)
    super.onDetachedFromWindow()
  }

  // Size and room

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    val width = right - left; val side = context.px(38f)
    toEnd.layout(width - context.px(14f) - side, bottom - top - list.paddingBottom - side - context.px(6f), width - context.px(14f), bottom - top - list.paddingBottom - context.px(6f))
    if (width > 0 && width != knownWidth) {
      knownWidth = width
      onWidth(width)
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    // A list left at its newest message is put back there (the window changed its size).
    if (pinned && h != oldh) settle(null)
  }

  /** Room above the first message and under the last one, px: what the header and the field cover. */
  fun setPad(top: Int, bottom: Int) {
    if (list.paddingTop == top && list.paddingBottom == bottom) return
    val anchor = if (pinned) null else anchor(emptySet())
    list.setPadding(0, top, 0, bottom)
    // The keyboard came or went: the end stays at the end, a place in the middle stays where it was.
    settle(anchor)
    requestLayout()
  }

  // Changes

  private fun position(id: Long): Int {
    // Changes are nearly always about the newest rows.
    var at = items.size - 1
    while (at >= 0) { if (items[at].row.id == id) return at; at -= 1 }
    return -1
  }

  /** The first row on the screen that stays after the change, and where its top is. */
  private fun anchor(gone: Set<Long>): Pair<Long, Int>? {
    for (index in 0 until list.childCount) {
      val child = list.getChildAt(index) as? ChannelRowView ?: continue
      val id = child.layoutInfo?.row?.id ?: continue
      if (id !in gone) return Pair(id, child.top)
    }
    return null
  }

  /** Puts the list where it belongs after a change: on the row the person was reading (`anchor`), else at its
   *  end. Row heights are known, so this is exact and happens within the same layout pass: nothing jumps. */
  private fun settle(anchor: Pair<Long, Int>?) {
    if (items.isEmpty()) return
    settling = true
    val at = if (anchor == null) -1 else position(anchor.first)
    if (at >= 0 && anchor != null) {
      list.setSelectionFromTop(at, anchor.second - list.paddingTop)
    } else {
      // The last row's bottom on the list's lower edge (a row taller than the screen shows its end).
      val room = height - list.paddingTop - list.paddingBottom
      list.setSelectionFromTop(items.size - 1, room - items.last().height)
    }
    list.post { settling = false }
  }

  /** Puts a finished change into the list. Main thread. */
  fun apply(patch: ChannelPatch) {
    val all = patch.reset
    if (all != null) {
      val kept = if (pinned) null else anchor(emptySet())
      items.clear(); items.addAll(all)
      askedAt = 0
      adapter.notifyDataSetChanged()
      if (kept == null || position(kept.first) < 0) pinned = true
      settle(if (pinned) null else kept)
      return
    }
    val kept = if (pinned) null else anchor(patch.removed.toSet())
    var structural = false
    for (id in patch.removed) {
      val index = position(id)
      if (index < 0) continue
      items.removeAt(index); structural = true
    }
    for (layout in patch.updated) {
      val index = position(layout.row.id)
      if (index < 0) continue
      val old = items[index]
      items[index] = layout
      if (old.height == layout.height) {
        // The same room: only the row itself is drawn again.
        shown(layout.row.id)?.show(layout)
      } else structural = true
    }
    if (patch.older.isNotEmpty()) { items.addAll(0, patch.older); structural = true }
    if (patch.newest.isNotEmpty()) { items.addAll(patch.newest); structural = true }
    if (structural) {
      // The rows on the screen are handed their layouts again (the same object: nothing is drawn anew); the
      // new or changed row is the only one that is drawn. Then the place is restored.
      adapter.notifyDataSetChanged()
      settle(kept)
    }
    if (patch.own && patch.newest.isNotEmpty()) scrollToEnd()
  }

  private fun shown(id: Long): ChannelRowView? {
    for (index in 0 until list.childCount) {
      val row = list.getChildAt(index) as? ChannelRowView ?: continue
      if (row.layoutInfo?.row?.id == id) return row
    }
    return null
  }

  /** Goes to the newest message (the person sent one, or asked to). */
  fun scrollToEnd() {
    pinned = true
    settle(null)
    showToEnd(false)
  }

  private fun showToEnd(shown: Boolean) {
    if ((toEnd.visibility == View.VISIBLE) == shown) return
    toEnd.animate().cancel()
    if (shown) { toEnd.visibility = View.VISIBLE; toEnd.animate().alpha(1f).setDuration(150).start() }
    else toEnd.animate().alpha(0f).setDuration(150).withEndAction { toEnd.visibility = View.GONE }.start()
  }

  /** How far the end of the list is under the lower edge, px — counted only up to `most`. */
  private fun toEndDistance(most: Int): Int {
    val last = list.lastVisiblePosition
    val child = list.getChildAt(list.childCount - 1) ?: return 0
    var far = child.bottom - (height - list.paddingBottom)
    var index = last + 1
    while (index < items.size && far <= most) { far += items[index].height; index += 1 }
    return far
  }

  /** Looks where the list is: at its end or not, and whether the button to the end is wanted. */
  private fun look(byFinger: Boolean) {
    if (items.isEmpty() || list.childCount == 0) return
    val far = toEndDistance(context.px(400f))
    if (byFinger) pinned = far <= context.px(24f)
    showToEnd(!pinned && far > context.px(400f))
  }

  /** The paging failed: the same oldest row may ask again. */
  fun forgetAsked() { askedAt = 0 }

  /** For checks: the ids of the rows, oldest first. */
  fun ids(): List<Long> = items.map { it.row.id }
}
