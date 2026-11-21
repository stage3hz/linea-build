package com.linea.messenger.chatsplus

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.provider.Settings
import android.view.View
import android.view.animation.LinearInterpolator
import com.linea.messenger.design.Theme
import kotlin.math.cos
import kotlin.math.tan

/** ChatsPlus: placeholder rows shaped like the chat list's while it waits for its first chats — the reference's
 *  `ChatListSkeleton` (effects.tsx) over the expokit `Skeleton` (kit/ui/skeleton.tsx), «shimmer» variant: nine rows
 *  (a 60 dp avatar — round, the owner's rule —, a name bar, the time, a preview bar) and one angled light band that
 *  sweeps across all of them together. Static when the system's animations are off
 *  (native/ios/Sources/ChatsPlus/ChatListSkeleton.swift). */
class ChatListSkeletonView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val blocks = Path()
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val band = Paint(Paint.ANTI_ALIAS_FLAG)
  private val box = RectF()
  private var laidFor = 0L
  private var shift = 0f
  private var clock: ValueAnimator? = null

  init {
    contentDescription = "Загрузка чатов"
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  private val motionOff: Boolean
    get() = try { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }

  private fun build() {
    val key = (width.toLong() shl 32) or height.toLong()
    if (key == laidFor) return
    laidFor = key
    blocks.reset()
    val w = width.toFloat()
    for (index in 0 until ROWS) {
      // SkeletonGroup paddingTop 4; each row: 8 dp above and below a 60 dp line, 16 dp at the sides.
      val top = (4f + index * 76f + 8f) * d
      blocks.addOval(16f * d, top, 76f * d, top + 60f * d, Path.Direction.CW)
      val left = (16f + 60f + 12f) * d; val columnWidth = w - left - 16f * d
      // The name row (14 dp) and the preview (12 dp), 9 dp apart, centred in the 60 dp column.
      val lineTop = top + (60f - 14f - 9f - 12f) / 2 * d
      box.set(left, lineTop, left + columnWidth * NAME[index % 9], lineTop + 14f * d); blocks.addRoundRect(box, 7f * d, 7f * d, Path.Direction.CW)
      box.set(left + columnWidth - 34f * d, lineTop + 1.5f * d, left + columnWidth, lineTop + 12.5f * d); blocks.addRoundRect(box, 5.5f * d, 5.5f * d, Path.Direction.CW)
      val previewTop = lineTop + 23f * d
      box.set(left, previewTop, left + columnWidth * PREVIEW[(index + 3) % 9], previewTop + 12f * d); blocks.addRoundRect(box, 6f * d, 6f * d, Path.Direction.CW)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    start()
  }

  override fun onDetachedFromWindow() {
    clock?.cancel(); clock = null
    super.onDetachedFromWindow()
  }

  override fun onVisibilityChanged(changedView: View, visibility: Int) {
    super.onVisibilityChanged(changedView, visibility)
    if (isShown) start() else { clock?.cancel(); clock = null }
  }

  private fun start() {
    if (clock != null || motionOff || !isAttachedToWindow || !isShown) return
    clock = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = CYCLE; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
      addUpdateListener { shift = it.animatedValue as Float; invalidate() }
      start()
    }
  }

  override fun onDraw(canvas: Canvas) {
    if (width == 0) return
    build()
    // kit.ts: foreground #fafafa (dark) / #09090b (light); the block at 11 % / 9 %.
    val dark = Theme.dark
    val foreground = if (dark) 0xFFFAFAFA.toInt() else 0xFF09090B.toInt()
    fill.color = Theme.alpha(foreground, if (dark) 0.11f else 0.09f)
    canvas.drawPath(blocks, fill)
    if (clock == null) return
    val t = shift
    if (t >= SWEEP) return
    // Where the band's centre line crosses the top: from −B to W + H·tan20° + B, eased by a sine over 70 % of the
    // 2.1 s cycle; then a calm pause.
    val w = width.toFloat(); val h = minOf(height.toFloat(), 900f * d)
    val slope = tan(ANGLE); val wide = maxOf(160f * d, minOf(320f * d, w * 0.55f))
    val middle = height / 2f
    val from = -wide - middle * slope; val to = w + h * slope + wide - middle * slope
    val eased = (0.5 - 0.5 * cos(Math.PI * (t / SWEEP))).toFloat()
    val x = from + (to - from) * eased
    val shine = if (dark) foreground else 0xFFFFFFFF.toInt()
    val peak = if (dark) 0.11f else 0.62f
    val half = wide * cos(ANGLE) / 2
    band.shader = LinearGradient(-half, 0f, half, 0f,
      intArrayOf(Theme.alpha(shine, 0f), Theme.alpha(shine, peak * 0.12f), Theme.alpha(shine, peak * 0.62f), Theme.alpha(shine, peak), Theme.alpha(shine, peak * 0.62f), Theme.alpha(shine, peak * 0.12f), Theme.alpha(shine, 0f)),
      floatArrayOf(0f, 0.22f, 0.4f, 0.5f, 0.6f, 0.78f, 1f), Shader.TileMode.CLAMP)
    val tall = (height + wide) / cos(ANGLE) + 40f * d
    canvas.save()
    canvas.clipPath(blocks)
    // A vertical band turned by 20°: its top leans to the right, as the reference's slanted line does.
    canvas.translate(x, middle)
    canvas.rotate(Math.toDegrees(ANGLE.toDouble()).toFloat())
    canvas.drawRect(-half, -tall / 2, half, tall / 2, band)
    canvas.restore()
  }

  companion object {
    // The reference's numbers.
    private val NAME = floatArrayOf(0.58f, 0.42f, 0.66f, 0.50f, 0.36f, 0.62f, 0.47f, 0.55f, 0.40f)
    private val PREVIEW = floatArrayOf(0.88f, 0.72f, 0.94f, 0.80f, 0.66f, 0.90f, 0.76f, 0.84f, 0.70f)
    private const val ROWS = 9
    private const val CYCLE = 2100L
    private const val SWEEP = 0.7f
    private val ANGLE = (20 * Math.PI / 180).toFloat()
  }
}
