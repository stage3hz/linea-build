package expo.modules.lineachatlist

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.MotionEvent
import android.view.View
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
  private val onRowPress by EventDispatcher()
  private val onRowLongPress by EventDispatcher()
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

  private val list = object : ListView(context) {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean { lastTouchY = event.rawY; return super.dispatchTouchEvent(event) }
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
    rows = next; adapter.notifyDataSetChanged()
  }

  fun setPalette(next: ChatPalette) {
    if (next == palette) return
    palette = next; adapter.notifyDataSetChanged()
  }

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
