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
  /** ChatsPlus: a notice row that takes a touch — a finished call («Перезвонить», MessageRow.tsx). */
  var noticeTappable: (key: String) -> Boolean = { false }
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
  /** Voice/Video: a tap on a part of a voice message, a video or a round video (`part`: "play", "wave", "rate"
   *  or "thumb"; `fraction`: where on the waveform, 0…1). */
  var onMediaPress: (key: String, part: String, fraction: Float) -> Unit = { _, _, _ -> }
  /** Voice/Video: the rows on screen moved or changed (a round video playing in its row follows it). */
  var onRowsMoved: () -> Unit = {}
  private var mediaState: com.linea.messenger.voice.MsgMediaState? = null
  /** LinkPreview: a tap on the card of a link (`key`: the row, `url`: where the card leads). */
  var onCardPress: (key: String, url: String) -> Unit = { _, _ -> }
  /** Polls: a tap on a poll (`part`: "option:<n>", "vote" or "retract"). */
  var onPollPress: (key: String, part: String) -> Unit = { _, _ -> }
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
    override fun isEnabled(position: Int) = rows[position].kind == 0 || noticeTappable(rows[position].key) // ChatsPlus: a finished call calls back
    override fun areAllItemsEnabled() = false
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val view = convertView as? MsgRowView ?: MsgRowView(context)
      view.bind(rows[position], palette, fontSize, revealed.contains(rows[position].key))
      view.flash = flashKey.isNotEmpty() && rows[position].key == flashKey
      view.mediaState = mediaState?.takeIf { it.key == rows[position].key }
      // ChatLook: a reused row stands straight unless it is the one being swiped; a new message slides in.
      if (swipe?.movingKey != rows[position].key && view.translationX != 0f) view.translationX = 0f
      arrivals.play(view, rows[position].key, rows[position].media == "note")
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
      // Polls: an option, «Голосовать», «Отменить голос» (not while messages are being chosen).
      val poll = if (row.checked < 0) (view as? MsgRowView)?.pollAt(upX - view.left, upY - view.top) else null
      if (poll != null) { onPollPress(row.key, poll); return@setOnItemClickListener }
      // Media: a photo of an album opens that photo (not while messages are being chosen).
      val albumPart = if (row.checked < 0) (view as? MsgRowView)?.albumAt(upX - view.left, upY - view.top) else null
      if (albumPart != null) { view.getLocationOnScreen(place); onMsgPress(albumPart, place[1] + view.height / 2f); return@setOnItemClickListener }
      val hit = (view as? MsgRowView)?.runAt(upX - view.left, upY - view.top)
      if (hit == null) {
        if ((view as? MsgRowView)?.quoteAt(upX - view.left, upY - view.top) == true) { onQuotePress(row.key); return@setOnItemClickListener }
        // Voice/Video: the play button, the waveform, the speed, the picture of a video.
        val media = if (row.checked < 0) (view as? MsgRowView)?.mediaAt(upX - view.left, upY - view.top) else null
        if (media != null) { onMediaPress(row.key, media.first, media.second); return@setOnItemClickListener }
        // LinkPreview: the card of a link opens the link (not while messages are being chosen).
        val card = if (row.checked < 0) (view as? MsgRowView)?.cardAt(upX - view.left, upY - view.top) else null
        if (card != null) { onCardPress(row.key, card); return@setOnItemClickListener }
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
        onRowsMoved()
      }
    })
  }

  init { addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }

  /** Attachments: a photo or a file of a row came, is coming or stopped — only that row is drawn again
   *  (attachments/InlineMedia.kt). */
  private val inlineMediaChanged: (String) -> Unit = { key ->
    for (index in 0 until list.childCount) (list.getChildAt(index) as? MsgRowView)?.takeIf { it.rowKey == key }?.invalidate()
  }

  /** Videonote: a row whose round video was brought, or whose player came or went, is drawn again. */
  fun redrawRow(key: String) = inlineMediaChanged(key)

  /** Videonote: the slot of `key` becomes large (an empty key gives the room back); the rows are laid out anew. */
  fun setExpandedNote(key: String) {
    if (key == msgExpandedNote) return
    val keys = listOf(msgExpandedNote, key).filter { it.isNotEmpty() }
    msgExpandedNote = key
    for (index in 0 until list.childCount) (list.getChildAt(index) as? MsgRowView)?.takeIf { it.rowKey in keys }?.regrow()
  }

  /** Whether a row is one's own (its circle grows away from the right edge). */
  fun isMine(key: String): Boolean {
    for (index in 0 until list.childCount) (list.getChildAt(index) as? MsgRowView)?.takeIf { it.rowKey == key }?.let { return it.mine }
    return true
  }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); com.linea.messenger.attachments.InlineMedia.listen(inlineMediaChanged) } // Attachments
  override fun onDetachedFromWindow() { com.linea.messenger.attachments.InlineMedia.unlisten(inlineMediaChanged); super.onDetachedFromWindow() } // Attachments

  // ChatLook: a swipe to the left answers a message; new messages slide in (chatlook/MsgMotion.kt).
  private val arrivals = com.linea.messenger.chatlook.MsgArrivals()
  private var swipe: com.linea.messenger.chatlook.MsgSwipeReply? = null

  /** ChatLook: the swipe to answer, with what can be answered and what answering does. */
  fun swipeReply(canReply: (String) -> Boolean, onReply: (String) -> Unit) {
    val made = swipe ?: com.linea.messenger.chatlook.MsgSwipeReply(this).also { swipe = it }
    made.canReply = { key -> rows.firstOrNull { it.key == key }?.let { it.kind == 0 && it.checked < 0 } == true && canReply(key) }
    made.onReply = onReply
    made.rowAt = { x, y -> rowAt(x, y) }
  }

  /** ChatLook: the row under a point of this view and its view. */
  private fun rowAt(x: Float, y: Float): Pair<String, View>? {
    val position = list.pointToPosition(x.toInt(), y.toInt())
    if (position == AbsListView.INVALID_POSITION) return null
    val row = rows.getOrNull(position) ?: return null
    val view = list.getChildAt(position - list.firstVisiblePosition) ?: return null
    return Pair(row.key, view)
  }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean = swipe?.intercept(event) == true || super.onInterceptTouchEvent(event)

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean = swipe?.touch(event) == true || super.onTouchEvent(event)

  /** ChatLook: the colours and the look (bubbles or the open look) changed: every row is laid out again. */
  fun setLook(next: MsgPalette) { palette = next; adapter.notifyDataSetChanged() }

  /** ChatLook: the emulator check — the view of the newest row of the other side on screen, its key. */
  fun demoTheirs(): Pair<String, View>? {
    for (index in list.childCount - 1 downTo 0) {
      val row = rows.getOrNull(list.firstVisiblePosition + index) ?: continue
      if (row.kind == 0 && !row.mine) return Pair(row.key, list.getChildAt(index))
    }
    return null
  }

  /** ChatLook: the emulator check — a row held half-way in the swipe. */
  fun demoSwipe(view: View) { swipe?.demo(view) }

  /** ChatLook: the emulator check — this row slides in when it is drawn. */
  fun markFresh(key: String) { arrivals.markFresh(key) }

  fun setRows(next: List<MsgRow>) {
    if (next == rows) return
    // Older rows put in front: the row that was first on screen stays where it is.
    val anchor = rows.getOrNull(list.firstVisiblePosition)?.key
    val top = list.getChildAt(0)?.top ?: 0
    val prepended = rows.isNotEmpty() && next.size > rows.size && next.firstOrNull()?.key != rows.firstOrNull()?.key && next.lastOrNull()?.key == rows.lastOrNull()?.key
    // A message of your own takes the list to its end, wherever it was scrolled to.
    val ownNew = rows.isNotEmpty() && next.lastOrNull()?.let { it.mine && it.key != rows.lastOrNull()?.key } == true
    arrivals.take(next) // ChatLook: which rows are new and slide in
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

  // Voice/Video

  /** Shows what is playing in its row (null: nothing plays). Only that row is drawn again. */
  fun setMediaState(next: com.linea.messenger.voice.MsgMediaState?) {
    if (next == mediaState) return
    val keys = listOf(mediaState?.key, next?.key)
    mediaState = next
    for (index in 0 until list.childCount) {
      val view = list.getChildAt(index) as? MsgRowView ?: continue
      if (view.rowKey in keys) view.mediaState = next?.takeIf { it.key == view.rowKey }
    }
  }

  /** The place of a row's picture in this view while the row is on screen, px (a round video plays there). */
  fun mediaHost(key: String): android.graphics.RectF? {
    for (index in 0 until list.childCount) {
      val view = list.getChildAt(index) as? MsgRowView ?: continue
      if (view.rowKey != key) continue
      val thumb = view.mediaThumb() ?: return null
      return android.graphics.RectF(thumb).apply { offset(view.left.toFloat(), view.top.toFloat()) }
    }
    return null
  }

  /** Record: the play button of a voice row while it is on screen, px in this view (the blob of a sent take flies
   *  to it). */
  fun mediaPlayHost(key: String): android.graphics.RectF? {
    for (index in 0 until list.childCount) {
      val view = list.getChildAt(index) as? MsgRowView ?: continue
      if (view.rowKey != key) continue
      val play = view.mediaPlay() ?: return null
      val at = IntArray(2); val mine = IntArray(2)
      view.getLocationInWindow(at); getLocationInWindow(mine)
      return android.graphics.RectF(play).apply { offset((at[0] - mine[0]).toFloat(), (at[1] - mine[1]).toFloat()) }
    }
    return null
  }

  /** The rows on screen, by key. */
  /** ChatScreen.tsx `peek`: a picture of the row of `key` as it stands now (the whole width), for the message menu. */
  /** The words of the row of `key` as laid out, with their place in its picture (see `rowPicture`). */
  fun rowWords(key: String): Triple<android.text.StaticLayout, Float, Float>? =
    (0 until list.childCount).mapNotNull { list.getChildAt(it) as? MsgRowView }.firstOrNull { it.rowKey == key }?.bodyCopy()

  fun rowPicture(key: String): android.graphics.Bitmap? {
    val row = (0 until list.childCount).mapNotNull { list.getChildAt(it) as? MsgRowView }.firstOrNull { it.rowKey == key } ?: return null
    if (row.width <= 0 || row.height <= 0) return null
    val picture = android.graphics.Bitmap.createBitmap(row.width, row.height, android.graphics.Bitmap.Config.ARGB_8888)
    row.draw(android.graphics.Canvas(picture))
    return picture
  }

  fun visibleKeys(): List<String> = (0 until list.childCount).mapNotNull { (list.getChildAt(it) as? MsgRowView)?.rowKey?.takeIf { key -> key.isNotEmpty() } }

  fun setPalette(next: MsgPalette) { if (next != palette) { palette = next; adapter.notifyDataSetChanged() } }
  fun setFontSize(size: Float) { val next = size.coerceIn(10f, 40f); if (next != fontSize) { fontSize = next; adapter.notifyDataSetChanged() } }
  /** Room above the first message and under the last one, px: what the header and the field cover. */
  fun setPad(top: Int, bottom: Int) { if (list.paddingTop != top || list.paddingBottom != bottom) list.setPadding(0, top, 0, bottom) }
}
