package com.linea.messenger.composer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.view.View
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource

/** Composer: the reference's row under a chat (mobile/src/ChatScreen.tsx, the composer's row: gap 8) — a round
 *  glass paperclip (40 dp), the field in a glass pill (radius 20, at least 40 dp tall, the emoji button inside on
 *  its right), and a round glass microphone (40 dp); the send button (an accent circle of 40 dp) takes the
 *  microphone's place while there is something to send. These are only the glass shapes, drawn under the
 *  composer's own buttons and field; touches go through them. The iPhone's Sources/Composer/ComposerPills.swift. */
@SuppressLint("ViewConstructor")
class ComposerPills(context: Context, page: GlassSource?) : View(context) {
  companion object {
    const val SIDE = 40f
    const val GAP = 8f
  }

  private val d = resources.displayMetrics.density
  private val clip = Glass(this).apply { source = page }
  private val field = Glass(this).apply { source = page }
  private val microphone = Glass(this).apply { source = page }

  /** The round glass of the record button is shown (not while the send button stands there). */
  var microphoneShown = true
    set(value) { if (field != value) { field = value; invalidate() } }
  /** Nothing is drawn (while a take covers the row). */
  var hidden = false
    set(value) { if (field != value) { field = value; invalidate() } }

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onDraw(canvas: Canvas) {
    if (hidden) return
    val w = width.toFloat(); val h = height.toFloat()
    val side = SIDE * d; val gap = GAP * d
    clip.draw(canvas, 0f, h - side, side, h, side / 2)
    // The field's pill: from the paperclip's gap to the microphone's gap.
    if (w - 2 * (side + gap) > 0f) field.draw(canvas, side + gap, 0f, w - side - gap, h, 20f * d)
    if (microphoneShown) microphone.draw(canvas, w - side, h - side, w, h, side / 2)
  }
}
