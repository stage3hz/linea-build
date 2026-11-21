package com.linea.messenger.chat

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

/** The messages of one chat as a list (rows oldest first, the newest at the bottom).
 *  It stays at the bottom while the user is there, keeps its place when older messages are put in front, and
 *  asks for older ones when the top comes near. */
@SuppressLint("ViewConstructor")
class MsgListView(context: Context) : FrameLayout(context) {
  /** A tap on a message; `y` is the middle of its row on the screen, px (ChatActions: the menu opens next to it). */
  var onMsgPress: (key: String, y: Float) -> Unit = { _, _ -> }
  /** ChatActions: a tap on the quote of an answer (`key`: the row of the answer). */
  var onQuotePress: (key: String) -> Unit = {}
  /** ChatActions: the list moved; how far it stands from its newest message, px. */
  var onScrolled: (fromNewest: Float) -> Unit = {}
  /** ChatActions: the row lit after a jump to it. */
  private var flashKey = ""
  private val place = IntArray(2)
  /** A long press on a message; `y` is the finger's place on the screen, px. */
  var onMsgLongPress: (key: String, y: Float) -> Unit = { _, _ -> }
  /** The top is near: older messages are wanted before the row `key`. */
  var onNearTop: (key: String) -> Unit = {}
  /** A tap on a link: its address and the words it stands under. */
  var onLinkPress: (key: String, url: String, shown: String) -> Unit = { _, _, _ -> }
  /** A tap on a reaction chip. */
  var onReactPress: (key: String, emoji: String) -> Unit = { _, _ -> }
  /** Messages whose spoilers were tapped open (until the chat is left). */
  private val revealed = HashSet<String>()
  private var upX = 0f
  private var upY = 0f
  private var rows: List<MsgRow> = emptyList()
  private var palette = MsgPalette.DARK
  private var fontSize = 17f
  private var lastTouchY = 0f
  private var askedAt = ""

  private val adapter = object : BaseAdapter() {
    override fun getCount() = rows.size
    override fun getItem(position: Int) = rows[position]
    override fun getItemId(position: Int) = rows[position].key.hashCode().toLong()
    override fun hasStableIds() = true
    override fun isEnabled(position: Int) = rows[position].kind == 0
    override fun areAllItemsEnabled() = false
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val view = convertView as? MsgRowView ?: MsgRowView(context)
      view.bind(rows[position], palette, fontSize, revealed.contains(rows[position].key))
      view.flash = flashKey.isNotEmpty() && rows[position].key == flashKey
      return view
    }
  }

  private val list = object : ListView(context) {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean { lastTouchY = event.rawY; upX = event.x; upY = event.y; return super.dispatchTouchEvent(event) }
  }.apply {
    divider = null; dividerHeight = 0
    selector = ColorDrawable(Color.TRANSPARENT); cacheColorHint = Color.TRANSPARENT
    isVerticalScrollBarEnabled = false; clipToPadding = false
    isStackFromBottom = true; transcriptMode = AbsListView.TRANSCRIPT_MODE_NORMAL
    this.adapter = this@MsgListView.adapter
    setOnItemClickListener { _, view, position, _ ->
      val row = rows.getOrNull(position) ?: return@setOnItemClickListener
      // A tap on a link or on a hidden spoiler is not a tap on the message.
      val chip = (view as? MsgRowView)?.chipAt(upX - view.left, upY - view.top)
      if (chip != null) { onReactPress(row.key, chip); return@setOnItemClickListener }
      val hit = (view as? MsgRowView)?.runAt(upX - view.left, upY - view.top)
      if (hit == null) {
        if ((view as? MsgRowView)?.quoteAt(upX - view.left, upY - view.top) == true) { onQuotePress(row.key); return@setOnItemClickListener }
        view.getLocationOnScreen(place)
        onMsgPress(row.key, place[1] + view.height / 2f)
      }
      else if (hit.first.isEmpty()) { revealed.add(row.key); (view as? MsgRowView)?.reveal() }
      else onLinkPress(row.key, hit.first, hit.second)
    }
    setOnItemLongClickListener { _, _, position, _ ->
      val row = rows.getOrNull(position) ?: return@setOnItemLongClickListener false
      onMsgLongPress(row.key, lastTouchY); true
    }
    setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView?, state: Int) {}
      override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {
        // Once per «oldest row»: asked again only after older rows have arrived.
        val oldest = rows.firstOrNull()?.key ?: return
        if (total > 0 && first <= 4 && askedAt != oldest) { askedAt = oldest; onNearTop(oldest) }
        onScrolled(fromNewest())
      }
    })
  }

  init { addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }

  fun setRows(next: List<MsgRow>) {
    if (next == rows) return
    // Older rows put in front: the row that was first on screen stays where it is.
    val anchor = rows.getOrNull(list.firstVisiblePosition)?.key
    val top = list.getChildAt(0)?.top ?: 0
    val prepended = rows.isNotEmpty() && next.size > rows.size && next.firstOrNull()?.key != rows.firstOrNull()?.key && next.lastOrNull()?.key == rows.lastOrNull()?.key
    // A message of your own takes the list to its end, wherever it was scrolled to.
    val ownNew = rows.isNotEmpty() && next.lastOrNull()?.let { it.mine && it.key != rows.lastOrNull()?.key } == true
    rows = next; adapter.notifyDataSetChanged()
    if (ownNew) list.post { list.setSelection(next.size - 1) }
    if (prepended && anchor != null) { val index = next.indexOfFirst { it.key == anchor }; if (index >= 0) list.setSelectionFromTop(index, top - list.paddingTop) }
  }

  // ChatActions — going to a message

  /** How far the list stands from its newest message, px (the rows that are not on the screen are counted as
   *  tall as the ones that are). */
  private fun fromNewest(): Float {
    val shown = list.childCount
    if (shown == 0 || rows.isEmpty()) return 0f
    val lastChild = list.getChildAt(shown - 1)
    val below = rows.size - 1 - list.lastVisiblePosition
    val hidden = (lastChild.bottom - (list.height - list.paddingBottom)).coerceAtLeast(0)
    if (below <= 0) return hidden.toFloat()
    val each = (lastChild.bottom - list.getChildAt(0).top).toFloat() / shown
    return hidden + below * each
  }

  /** Takes the list to its newest message. */
  fun scrollToNewest(animated: Boolean) {
    if (rows.isEmpty()) return
    if (animated && rows.size - 1 - list.lastVisiblePosition < 30) list.smoothScrollToPosition(rows.size - 1) else list.setSelection(rows.size - 1)
  }

  /** Scrolls to the row with this key and lights it for a moment. False when there is no such row. */
  fun jump(key: String): Boolean {
    val index = rows.indexOfFirst { it.key == key }
    if (index < 0) return false
    list.setSelectionFromTop(index, ((list.height - list.paddingTop - list.paddingBottom) * 0.4f).toInt())
    flashKey = key
    showFlash()
    postDelayed({ if (flashKey == key) { flashKey = ""; showFlash() } }, 1600)
    return true
  }

  private fun showFlash() {
    for (index in 0 until list.childCount) {
      val view = list.getChildAt(index) as? MsgRowView ?: continue
      val row = rows.getOrNull(list.firstVisiblePosition + index) ?: continue
      view.flash = flashKey.isNotEmpty() && row.key == flashKey
    }
  }

  fun setPalette(next: MsgPalette) { if (next != palette) { palette = next; adapter.notifyDataSetChanged() } }
  fun setFontSize(size: Float) { val next = size.coerceIn(10f, 40f); if (next != fontSize) { fontSize = next; adapter.notifyDataSetChanged() } }
  /** Room above the first message and under the last one, px: what the header and the field cover. */
  fun setPad(top: Int, bottom: Int) { if (list.paddingTop != top || list.paddingBottom != bottom) list.setPadding(0, top, 0, bottom) }
}
