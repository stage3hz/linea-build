package com.linea.messenger.composer

import android.annotation.SuppressLint
import android.content.Context
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.GridView
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.chatlook.GlassPill
import com.linea.messenger.chatlook.Haptic
import com.linea.messenger.core.Core
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.settings.ThemeStore
import kotlin.math.abs

/** The emoji panel under the composer (iOS: Sources/Composer/EmojiPanel.swift; the reference's StickerPanel.tsx): a tap
 *  puts the emoji into the text at the cursor (like the system keyboard); a message of only 1–3 emoji is then shown
 *  large. It stands where the keyboard was, as tall as the keyboard last was; a swipe down — from the header at any
 *  time, from the grid when it is at its top — puts it away. Nothing is downloaded from anywhere. */
@SuppressLint("ViewConstructor")
class EmojiPanel(context: Context, source: GlassSource?) : GlassPill(context, source) {
  companion object {
    val sets: List<Triple<String, String, List<String>>> = listOf(
      Triple("faces", "😀", listOf("😀", "😃", "😄", "😁", "😆", "🥹", "😅", "😂", "🤣", "🥲", "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🥸", "🤩", "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔", "🫣", "🤭", "🫢", "🫡", "🤫", "🫠", "🤥", "😶", "🫥", "😐", "🫤", "😑", "😬", "🙄", "😯", "😦", "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵", "🤐", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕", "🤑", "🤠", "😈", "👿", "👻", "💀", "☠️", "👽", "🤖", "🎃", "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾")),
      Triple("hands", "👍", listOf("👍", "👎", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "✋", "🤚", "🖐️", "🖖", "👋", "🫶", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💪", "🦾", "🫵", "👀", "🧠", "🫀", "👄", "💋")),
      Triple("hearts", "❤️", listOf("❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❤️‍🔥", "❤️‍🩹", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "✨", "🔥", "💯", "💥", "💫", "⭐", "🌟", "⚡", "🎉", "🎊", "🎁", "🏆", "🥇", "👑", "💎", "🎈")),
      Triple("animals", "🐶", listOf("🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐻‍❄️", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔", "🐧", "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄", "🐝", "🦋", "🐌", "🐞", "🐢", "🐍", "🦖", "🐙", "🦑", "🦀", "🐡", "🐠", "🐬", "🐳", "🦈", "🐊", "🐘", "🦒", "🦔", "🐾")),
      Triple("food", "🍕", listOf("🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🍆", "🥦", "🌶️", "🌽", "🥕", "🥐", "🍞", "🧀", "🍳", "🥞", "🥓", "🍔", "🍟", "🍕", "🌭", "🥪", "🌮", "🌯", "🍝", "🍜", "🍣", "🍱", "🍩", "🍪", "🎂", "🍰", "🧁", "🍫", "🍬", "🍭", "🍿", "☕", "🍵", "🧃", "🥤", "🧋", "🍺", "🍷", "🥂", "🍾")),
      Triple("activity", "⚽", listOf("⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🎱", "🏓", "🏸", "🥊", "🥋", "⛳", "⛸️", "🎿", "🛹", "🏂", "🏋️", "🚴", "🏊", "🎮", "🕹️", "🎲", "🧩", "🎯", "🎳", "🎸", "🎹", "🥁", "🎤", "🎧", "🎬", "🎨", "📸", "🚗", "🏎️", "✈️", "🚀", "🛸", "🏖️", "🏝️", "🌋", "🌈", "☀️", "🌙", "❄️", "☔", "🌊")),
    )
    const val RECENT_KEY = "invizent.emoji.recent.v1"
  }

  /** An emoji was chosen. */
  var onPick: ((String) -> Unit)? = null
  /** «Стереть символ» (a long touch: eight at once). */
  var onErase: (() -> Unit)? = null
  /** The panel wants to go (the chevron, a swipe down). */
  var onClose: (() -> Unit)? = null

  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val tabs = ArrayList<View>()
  private val grid = GridView(context)
  private val empty = TextView(context)
  private var chosen = "recent"
  private var recent: List<String> = (Core.value(ThemeStore.kept?.get(RECENT_KEY)) as? List<*>).orEmpty().filterIsInstance<String>().take(32)
  private var downY = 0f
  private var downX = 0f
  private var pulling = false

  private val adapter = object : BaseAdapter() {
    override fun getCount() = items.size
    override fun getItem(position: Int) = items[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val cell = (convertView as? TextView) ?: TextView(context).apply {
        textSize = 30f; gravity = Gravity.CENTER; includeFontPadding = false
        layoutParams = AbsListView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50f))
      }
      cell.text = items[position]
      cell.contentDescription = "Вставить " + items[position]
      return cell
    }
  }

  init {
    placesChildren = true
    radius = 26 * d
    val column = LinearLayout(context)
    column.orientation = LinearLayout.VERTICAL
    val grabber = View(context).apply { background = context.plate(Theme.alpha(Theme.subtle, 0.45f), 2f) }
    column.addView(grabber, LinearLayout.LayoutParams(dp(36f), dp(4f)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(7f) })
    val header = LinearLayout(context)
    header.gravity = Gravity.CENTER_VERTICAL
    header.setPadding(dp(8f), 0, dp(8f), 0)
    val ids = listOf("recent") + sets.map { it.first }
    ids.forEachIndexed { index, id ->
      val tab: View = if (id == "recent") ChatIconView(context, "clock", 17f, Theme.muted).apply { contentDescription = "Недавние" }
      else TextView(context).apply { text = sets[index - 1].second; textSize = 20f; gravity = Gravity.CENTER; includeFontPadding = false }
      tab.isClickable = true
      tab.setOnClickListener { chosen = id; Haptic.tap(tab); showTabs() }
      header.addView(tab, LinearLayout.LayoutParams(dp(40f), dp(36f)).apply { rightMargin = dp(2f) })
      tabs.add(tab)
    }
    header.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    val erase = ChatIconView(context, "delete.left", 19f, Theme.muted)
    erase.contentDescription = "Стереть символ"
    erase.isClickable = true
    erase.setOnClickListener { onErase?.invoke() }
    erase.setOnLongClickListener { repeat(8) { onErase?.invoke() }; true }
    header.addView(erase, LinearLayout.LayoutParams(dp(40f), dp(36f)))
    val hide = ChatIconView(context, "chevron.down", 18f, Theme.muted)
    hide.contentDescription = "Скрыть эмодзи"
    hide.isClickable = true
    hide.setOnClickListener { onClose?.invoke() }
    header.addView(hide, LinearLayout.LayoutParams(dp(36f), dp(36f)))
    column.addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(41f)).apply { topMargin = dp(3f) })
    grid.numColumns = GridView.AUTO_FIT
    grid.columnWidth = dp(50f)
    grid.stretchMode = GridView.STRETCH_COLUMN_WIDTH
    grid.isVerticalScrollBarEnabled = false
    grid.selector = android.graphics.drawable.ColorDrawable(Theme.veil(0.07f))
    grid.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
    grid.clipToPadding = false
    grid.adapter = adapter
    grid.setOnItemClickListener { _, view, position, _ ->
      val emoji = items.getOrNull(position) ?: return@setOnItemClickListener
      view.animate().scaleX(1.25f).scaleY(1.25f).setDuration(80).withEndAction { view.animate().scaleX(1f).scaleY(1f).setDuration(100).start() }.start()
      pick(emoji)
    }
    val body = android.widget.FrameLayout(context)
    body.addView(grid)
    empty.text = "Здесь появятся недавние"
    empty.textSize = 13f
    empty.setTextColor(Theme.muted)
    empty.gravity = Gravity.CENTER
    body.addView(empty)
    column.addView(body, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    if (recent.isEmpty()) chosen = "faces"
    showTabs()
  }

  /** Appears with a short lift. */
  fun appear() {
    alpha = 0f
    translationY = 40 * d
    animate().alpha(1f).translationY(0f).setDuration(320).setInterpolator(android.view.animation.DecelerateInterpolator(1.6f)).start()
  }

  private val items: List<String> get() = if (chosen == "recent") recent else sets.firstOrNull { it.first == chosen }?.third ?: emptyList()

  private fun showTabs() {
    val ids = listOf("recent") + sets.map { it.first }
    tabs.forEachIndexed { index, tab ->
      val on = ids[index] == chosen
      tab.background = if (on) context.plate(Theme.alpha(Theme.accent, 0.16f), 12f) else null
      (tab as? ChatIconView)?.let { it.color = if (on) Theme.accent else Theme.muted; it.invalidate() }
      tab.isSelected = on
    }
    empty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
    adapter.notifyDataSetChanged()
    grid.setSelection(0)
  }

  private fun pick(emoji: String) {
    onPick?.invoke(emoji)
    recent = (listOf(emoji) + recent.filter { it != emoji }).take(32)
    Core.text(recent)?.let { ThemeStore.kept?.set(RECENT_KEY, it) }
  }

  // The swipe down

  private val gridAtTop: Boolean get() = grid.childCount == 0 || (grid.firstVisiblePosition == 0 && (grid.getChildAt(0)?.top ?: 0) >= grid.paddingTop - dp(2f))

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { downX = event.x; downY = event.y; pulling = false }
      MotionEvent.ACTION_MOVE -> {
        val dy = event.y - downY; val dx = event.x - downX
        val inHeader = downY < 52 * d
        if (dy > 8 * d && abs(dy) > abs(dx) * 1.4f && (inHeader || gridAtTop)) { pulling = true; return true }
      }
    }
    return false
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!pulling) return event.actionMasked == MotionEvent.ACTION_DOWN
    val move = maxOf(0f, event.y - downY)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> translationY = move
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        pulling = false
        if (move > 70 * d) animate().translationY(320 * d).setDuration(160).withEndAction { onClose?.invoke() }.start()
        else animate().translationY(0f).setDuration(300).setInterpolator(android.view.animation.OvershootInterpolator(0.8f)).start()
      }
    }
    return true
  }
}
