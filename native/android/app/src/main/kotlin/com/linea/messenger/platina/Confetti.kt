package com.linea.messenger.platina

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

/** Confetti for the moments that deserve it (the reference's kit/ui/confetti.tsx, from expokit by Karan, MIT; iOS
 *  Platina/Confetti.swift): every piece flies on a real arc — launch, gravity, drag — and flutters as it falls.
 *  `origin` "bottom" fires two cannons from the corners, "top" rains down, "center" pops outward. With the system's
 *  animations reduced a quarter of the pieces. The view never takes touches. */
class ConfettiView(context: Context) : View(context) {
  companion object {
    val palette = listOf("#ff3d77", "#ffb000", "#3ddcff", "#7cff6b", "#a855ff", "#ffffff", "#ff7a1a")
  }

  private class Piece(
    val x0: Double, val y0: Double, val vx: Double, val vy: Double, val drag: Double, val sway: Double, val index: Int,
    val round: Boolean, val w: Float, val h: Float, val color: Int, val spin0: Double, val turns: Double, val flips: Double,
  )

  private class Burst(val started: Long, val duration: Double, val gravity: Double, val pieces: List<Piece>)

  private val bursts = ArrayList<Burst>()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  var onDone: (() -> Unit)? = null

  init {
    isClickable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  }

  private fun color(text: String): Int = if (text.startsWith("#") && text.length == 7) lookColor(text.uppercase()) else 0xFFFFFFFF.toInt()

  /** Fires one burst (bursts may overlap). Call once the view has its size. */
  fun burst(origin: String = "bottom", count: Int = 80, colors: List<String> = palette, duration: Double = 2.6, atX: Float? = null, atY: Float? = null) {
    val w = width.toDouble(); val h = height.toDouble()
    if (w <= 0 || h <= 0) return
    val reduced = try { Settings.Global.getFloat(context.contentResolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 1f) == 0f } catch (_: Exception) { false }
    val n = Math.round(count * (if (reduced) 0.25 else 1.0)).toInt().coerceIn(1, 160)
    val r = Random.Default
    val pieces = (0 until n).map { i ->
      var x0: Double; var y0: Double; var vx: Double; var vy: Double
      when (origin) {
        "top" -> { x0 = r.nextDouble() * w; y0 = -20 - r.nextDouble() * h * 0.25; vx = (r.nextDouble() - 0.5) * w * 0.25; vy = r.nextDouble() * h * 0.1 }
        "center" -> {
          x0 = atX?.toDouble() ?: (w / 2); y0 = atY?.toDouble() ?: (h / 2)
          val a = -Math.PI / 2 + (r.nextDouble() - 0.5) * Math.PI * 1.6
          val v = (0.45 + r.nextDouble() * 0.75) * maxOf(w, h) * 0.9
          vx = cos(a) * v; vy = sin(a) * v
        }
        else -> {
          val leftSide = i % 2 == 0
          x0 = if (leftSide) -6.0 else w + 6; y0 = h + 6
          val a = -Math.PI / 2 + (if (leftSide) 1 else -1) * (0.25 + r.nextDouble() * 0.45)
          val v = (0.75 + r.nextDouble() * 0.55) * h * 1.15
          vx = cos(a) * v; vy = sin(a) * v
        }
      }
      val round = r.nextDouble() < 0.3
      val strip = !round && r.nextDouble() < 0.35
      val d = resources.displayMetrics.density
      Piece(x0, y0, vx, vy, 1.6 + r.nextDouble(), (r.nextDouble() - 0.5) * 40 * d, i, round,
        (if (round) 7f else if (strip) 4f else 7f) * d, (if (round) 7f else if (strip) 16f else 11f) * d,
        if (colors.isEmpty()) 0xFFFFFFFF.toInt() else color(colors[r.nextInt(colors.size)]),
        Math.round(r.nextDouble() * 360).toDouble(), (if (r.nextDouble() < 0.5) -1.0 else 1.0) * (1 + r.nextDouble() * 2.5), 2 + r.nextDouble() * 4)
    }
    bursts.add(Burst(SystemClock.uptimeMillis(), duration, h * 1.25, pieces))
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val now = SystemClock.uptimeMillis()
    val done = bursts.filter { (now - it.started) / 1000.0 >= it.duration }
    if (done.isNotEmpty()) { bursts.removeAll(done.toSet()); if (bursts.isEmpty()) post { onDone?.invoke() } }
    for (burst in bursts) {
      val t = (now - burst.started) / 1000.0
      val progress = t / burst.duration
      val alpha = if (progress < 0.8) 1.0 else ((1 - progress) / 0.2).coerceIn(0.0, 1.0)
      for (p in burst.pieces) {
        // Air drag eases the launch; sideways sway makes paper fall like paper.
        val k = (1 - exp(-p.drag * t)) / p.drag
        val x = p.x0 + p.vx * k + p.sway * sin(t * 6 + p.index)
        val y = p.y0 + p.vy * k + 0.5 * burst.gravity * t * t * 0.55
        val spin = p.spin0 + p.turns * 360 * progress
        val flip = cos(p.flips * Math.PI * 2 * progress).toFloat()
        paint.color = (p.color and 0xFFFFFF) or (Math.round(alpha * 255).toInt() shl 24)
        canvas.save()
        canvas.translate(x.toFloat(), y.toFloat())
        canvas.rotate(spin.toFloat())
        canvas.scale(1f, maxOf(0.08f, Math.abs(flip)))
        if (p.round) canvas.drawCircle(0f, 0f, p.w / 2, paint)
        else canvas.drawRoundRect(-p.w / 2, -p.h / 2, p.w / 2, p.h / 2, 1.5f, 1.5f, paint)
        canvas.restore()
      }
    }
    if (bursts.isNotEmpty()) postInvalidateOnAnimation()
  }
}

/** Confetti and a short «Платина активирована ✨» on a pill at the top (platina/PlatinaConfetti.tsx); with
 *  animations off only the pill. Gone after 3.6 s. */
object PlatinaConfettiHost {
  val colors = listOf("#E8E3D3", "#C9CED8", "#F4D68A", "#B9A7F5", "#8FD3FF", "#FFFFFF", "#F2A7C9")

  fun show(over: View) {
    val window = over.rootView as? ViewGroup ?: return
    val context = window.context
    window.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    val cover = FrameLayout(context)
    cover.isClickable = false
    window.addView(cover, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    if (AvatarMotion.enabled(context)) {
      val confetti = ConfettiView(context)
      cover.addView(confetti, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      confetti.post { confetti.burst("bottom", 110, colors, 2.8) }
    }
    val pill = TextView(context)
    pill.text = "Платина активирована ✨"
    pill.textSize = 15f
    pill.typeface = Theme.weight(700)
    pill.setTextColor(Theme.text)
    pill.gravity = Gravity.CENTER
    pill.background = context.plate(Theme.alpha(Theme.surface2, 0.94f), 22f, Theme.veil(0.12f))
    pill.setPadding(context.px(18f), context.px(11f), context.px(18f), context.px(11f))
    val top = (window.rootWindowInsets?.systemWindowInsetTop ?: 0) + context.px(12f)
    cover.addView(pill, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = top })
    pill.alpha = 0f
    pill.translationY = -context.px(30f).toFloat()
    pill.animate().alpha(1f).translationY(0f).setDuration(500).setInterpolator(OvershootInterpolator(1.4f)).start()
    cover.postDelayed({
      pill.animate().alpha(0f).translationY(-context.px(30f).toFloat()).setDuration(300).withEndAction { window.removeView(cover) }.start()
    }, 3600)
  }
}
