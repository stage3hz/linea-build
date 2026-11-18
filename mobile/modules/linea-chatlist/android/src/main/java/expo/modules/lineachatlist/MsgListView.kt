package expo.modules.lineachatlist

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.ListView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** The messages of one chat as a native list (rows oldest first, the newest at the bottom; see ../index.ts).
 *  It stays at the bottom while the user is there, keeps its place when older messages are put in front, and
 *  asks for older ones when the top comes near. */
@SuppressLint("ViewConstructor")
class MsgListView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onMsgPress by EventDispatcher()
  private val onMsgLongPress by EventDispatcher()
  private val onNearTop by EventDispatcher()
  private val onLinkPress by EventDispatcher()
  private val onReactPress by EventDispatcher()
  /** Messages whose spoilers were tapped open (until the chat is left). */
  private val revealed = HashSet<String>()
  private var upX = 0f
  private var upY = 0f
  private val d = resources.displayMetrics.density
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
      if (chip != null) { onReactPress(mapOf("key" to row.key, "emoji" to chip)); return@setOnItemClickListener }
      val hit = (view as? MsgRowView)?.runAt(upX - view.left, upY - view.top)
      if (hit == null) onMsgPress(mapOf("key" to row.key))
      else if (hit.first.isEmpty()) { revealed.add(row.key); (view as? MsgRowView)?.reveal() }
      else onLinkPress(mapOf("key" to row.key, "url" to hit.first, "shown" to hit.second))
    }
    setOnItemLongClickListener { _, _, position, _ ->
      val row = rows.getOrNull(position) ?: return@setOnItemLongClickListener false
      onMsgLongPress(mapOf("key" to row.key, "y" to (lastTouchY / d).toDouble())); true
    }
    setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView?, state: Int) {}
      override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) {
        // Once per «oldest row»: asked again only after older rows have arrived.
        val oldest = rows.firstOrNull()?.key ?: return
        if (total > 0 && first <= 4 && askedAt != oldest) { askedAt = oldest; onNearTop(mapOf("key" to oldest)) }
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
    // Telegram: a message of your own takes the list to its end, wherever it was scrolled to.
    val ownNew = rows.isNotEmpty() && next.lastOrNull()?.let { it.mine && it.key != rows.lastOrNull()?.key } == true
    rows = next; adapter.notifyDataSetChanged()
    if (ownNew) list.post { list.setSelection(next.size - 1) }
    if (prepended && anchor != null) { val index = next.indexOfFirst { it.key == anchor }; if (index >= 0) list.setSelectionFromTop(index, top - list.paddingTop) }
  }

  fun setPalette(next: MsgPalette) { if (next != palette) { palette = next; adapter.notifyDataSetChanged() } }
  fun setFontSize(size: Float) { val next = size.coerceIn(10f, 40f); if (next != fontSize) { fontSize = next; adapter.notifyDataSetChanged() } }
  fun setPadding(top: Float, bottom: Float) { list.setPadding(0, (top * d).toInt(), 0, (bottom * d).toInt()) }

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
