package com.linea.messenger.shell

import android.animation.TimeInterpolator
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

/** Where a spring that is let go at 0 and rests at 1 stands at the moment `t` (0…1 of the animation's time).
 *  `damping`: 1 comes to rest without passing it, less than 1 passes it a little and returns (as the damping
 *  ratio of a UIKit spring). `velocity`: the speed at the start, in distances per animation time. The spring is
 *  as stiff as it must be to have settled (to a thousandth) when the time is over. */
fun springAt(t: Float, damping: Float, velocity: Float = 0f): Float {
  if (t <= 0f) return 0f
  if (t >= 1f) return 1f
  val zeta = damping.coerceIn(0.05f, 1f).toDouble()
  val omega = 6.9 / zeta
  val time = t.toDouble()
  val decay = exp(-zeta * omega * time)
  if (zeta >= 0.999) return (1 - decay * (1 + (omega - velocity) * time)).toFloat()
  val ring = omega * sqrt(1 - zeta * zeta)
  return (1 - decay * (cos(ring * time) + (zeta * omega - velocity) / ring * sin(ring * time))).toFloat()
}

/** `springAt` as the curve of an animator. */
class SpringCurve(private val damping: Float, private val velocity: Float = 0f) : TimeInterpolator {
  override fun getInterpolation(input: Float): Float = springAt(input, damping, velocity)
}
