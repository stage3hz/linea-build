package com.linea.messenger.chatlook

import android.graphics.drawable.GradientDrawable
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.design.Theme
import kotlin.math.abs

/** Swipe a message to the LEFT to answer it (the reference's MessageRow.tsx `SwipeToReply`; a right swipe goes
 *  back). The row follows the finger at 0.85 of its way, at most 96 dp; at 60 dp a light knock says it is armed and
 *  the round arrow is fully there; letting go then answers. The row snaps back once, without overshoot (180 ms,
 *  ease-out). A mostly vertical move scrolls the list (the reference: activeOffsetX -10, failOffsetY ±28).
 *
 *  `host` is the list's own frame: it hands its touches here (`intercept` from onInterceptTouchEvent, `touch` from
 *  onTouchEvent); the arrow is a child of it, drawn over the rows. */
class MsgSwipeReply(private val host: ViewGroup) {
  /** The row under a point of the host and the view that moves (null: nothing that can be answered there). */
  var rowAt: (Float, Float) -> Pair<String, View>? = { _, _ -> null }
  /** Whether the message of a row can be answered (decrypted, not on its way out, not while choosing). */
  var canReply: (String) -> Boolean = { false }
  var onReply: (String) -> Unit = {}

  private val d = host.resources.displayMetrics.density
  private var downX = 0f
  private var downY = 0f
  private var found: Pair<String, View>? = null
  private var moving: Pair<String, View>? = null
  private var decided = false
  private var armed = false
  // MessageRow.tsx SwipeToReply: <Icon name="arrow-undo" size={17}> on a 32-point accentSoft circle.
  private val badge = ChatIconView(host.context, "ion:arrow-undo", 17f, Theme.accent).apply {
    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(com.linea.messenger.settings.ThemeStore.look.accentSoft) }
    alpha = 0f
    isClickable = false
  }

  init { host.addView(badge, ViewGroup.LayoutParams((32 * d).toInt(), (32 * d).toInt())) }

  /** The key of the row being moved now (a row being drawn again keeps its place). */
  val movingKey: String? get() = moving?.first

  fun intercept(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x; downY = event.y; decided = false; armed = false
        found = rowAt(event.x, event.y)?.takeIf { canReply(it.first) }
      }
      MotionEvent.ACTION_MOVE -> {
        if (decided || found == null) return false
        val dx = event.x - downX; val dy = event.y - downY
        if (abs(dy) > 28 * d) { decided = true; found = null; return false }
        if (dx > 10 * d) { decided = true; found = null; return false }
        if (dx < -10 * d && abs(dx) > abs(dy) * 1.2f) {
          decided = true
          moving = found
          downX = event.x
          host.parent?.requestDisallowInterceptTouchEvent(true)
          badge.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(com.linea.messenger.settings.ThemeStore.look.accentSoft) }
          badge.color = Theme.accent
          return true
        }
      }
    }
    return false
  }

  fun touch(event: MotionEvent): Boolean {
    val row = moving ?: return false
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        val value = ((event.x - downX) * 0.85f).coerceIn(-96 * d, 0f)
        row.second.translationX = value
        place(row.second, value)
        if (value <= -60 * d && !armed) { armed = true; Haptic.light(host) } else if (value > -60 * d && armed) armed = false
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val fire = event.actionMasked == MotionEvent.ACTION_UP && armed
        moving = null; armed = false
        row.second.animate().translationX(0f).setDuration(180).setInterpolator(DecelerateInterpolator(1.5f)).start()
        badge.animate().alpha(0f).setDuration(180).start()
        if (fire) onReply(row.first)
      }
    }
    return true
  }

  /** The emulator check: a row held 70 dp to the left, the arrow fully there. */
  fun demo(view: View) {
    view.translationX = -70 * d
    place(view, -70 * d)
  }

  /** The round arrow at the row's right (4 dp from the edge, in the middle of the row above its gap): it grows from
   *  0.6 and comes in between 12 and 60 dp of the move. */
  private fun place(view: View, value: Float) {
    val share = ((-value - 12 * d) / (48 * d)).coerceIn(0f, 1f)
    badge.animate().cancel()
    badge.alpha = share
    val scale = 0.6f + 0.4f * share
    badge.scaleX = scale; badge.scaleY = scale
    val side = 32 * d
    // The row's place in the host (the list may have padding and its own offset).
    var top = view.top.toFloat(); var parent = view.parent as? View
    while (parent != null && parent !== host) { top += parent.top; parent = parent.parent as? View }
    badge.x = host.width - 4 * d - side
    badge.y = top + maxOf(0f, (view.height - 8 * d) / 2 - side / 2)
  }
}

/** New messages slide in (the reference's MessageRow.tsx `entering={fresh ? FadeInDown.duration(220) : …}`, a round
 *  video only fades in, 150 ms). Only a message or two arriving live: the first rows of a chat, a page of history and
 *  anything that came in a batch of more than three are simply there. A message of one's own that replaces its own
 *  row «on its way out» is not new and does not slide in twice. */
class MsgArrivals {
  private var seen: MutableSet<String>? = null
  private val fresh = HashSet<String>()

  private fun pending(key: String) = key.startsWith("attach-") || key.startsWith("media-")

  /** The rows now. */
  fun take(rows: List<MsgRow>) {
    val keys = rows.map { it.key }
    val known = seen
    if (known == null) { if (keys.isNotEmpty()) seen = keys.toHashSet(); return }
    val unseen = rows.filter { !known.contains(it.key) }
    if (unseen.size > 3) { known.addAll(keys); return }
    // Rows on their way out (attachments, voice and videos being sent) that are gone now became messages.
    val current = keys.toHashSet()
    val landed = known.any { pending(it) && !current.contains(it) }
    for (row in unseen) {
      known.add(row.key)
      if (row.kind != 0) continue
      if (row.mine && landed && !pending(row.key)) continue
      fresh.add(row.key)
    }
    // A row that has gone is forgotten, so the set does not keep growing with every pending row.
    known.retainAll { current.contains(it) || !pending(it) }
  }

  /** Called as a row is drawn: a fresh one slides in; any other is put straight. */
  fun play(view: View, key: String, note: Boolean) {
    if (!fresh.remove(key) || !AvatarMotion.enabled(view.context)) {
      if (view.alpha != 1f || view.translationY != 0f) { view.animate().cancel(); view.alpha = 1f; view.translationY = 0f }
      return
    }
    view.alpha = 0f
    // FadeInDown: from 25 dp above, opacity 0 → 1.
    view.translationY = if (note) 0f else -25f * view.resources.displayMetrics.density
    view.animate().alpha(1f).translationY(0f).setDuration(if (note) 150 else 220).setInterpolator(android.view.animation.AccelerateDecelerateInterpolator()).start()
  }

  /** The emulator check: this key slides in when its row is drawn. */
  fun markFresh(key: String) { fresh.add(key) }
}
