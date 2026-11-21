package com.linea.messenger.chatlook

import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.view.View
import com.linea.messenger.design.Theme

/** One soft elliptic light: a radial gradient in the units of the view's own box (the reference's SVG
 *  `RadialGradient gradientUnits="objectBoundingBox"`): the centre and the two radii are shares of the width and
 *  the height. `stops`: offsets with their ARGB colours. */
class LookGlow(val cx: Float, val cy: Float, val rx: Float, val ry: Float, val stops: List<Pair<Float, Int>>) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.DITHER_FLAG)
  private val matrix = Matrix()

  fun draw(canvas: Canvas, width: Float, height: Float) {
    if (width <= 0f || height <= 0f || stops.size < 2) return
    val gradient = RadialGradient(0f, 0f, 1f, stops.map { it.second }.toIntArray(), stops.map { it.first }.toFloatArray(), Shader.TileMode.CLAMP)
    matrix.reset()
    matrix.setScale(maxOf(0.001f, rx * width), maxOf(0.001f, ry * height))
    matrix.postTranslate(cx * width, cy * height)
    gradient.setLocalMatrix(matrix)
    paint.shader = gradient
    canvas.drawRect(0f, 0f, width, height, paint)
    paint.shader = null
  }
}

/** The light of the person you are talking to (the reference's design/peerLight.tsx `PeerLight`): a soft glow in
 *  their own colour on their side of the screen (the left, where their words are), and a faint white one on yours.
 *  One still picture: nothing is redrawn while the list scrolls. */
class PeerLightView(context: Context) : View(context) {
  /** The person's colour (0xRRGGBB): their photo's colour, else the one they chose. */
  var peerColor = 0x5E7BFF
    set(value) { if (field != value) { field = value; invalidate() } }

  override fun onDraw(canvas: Canvas) {
    val dark = Theme.dark
    val glow = LookColor.bright(peerColor, 150)
    // On a light page the glow is a tint, on a dark one it is light.
    val near = if (dark) 0.46f else 0.18f; val far = if (dark) 0.14f else 0.06f
    val w = width.toFloat(); val h = height.toFloat()
    LookGlow(-0.12f, 0.32f, 0.78f, 0.46f, listOf(0f to LookColor.argb(glow, near), 0.55f to LookColor.argb(glow, far), 1f to LookColor.argb(glow, 0f))).draw(canvas, w, h)
    val own = if (dark) 0xFFFFFF else (Theme.accent and 0xFFFFFF)
    LookGlow(1.12f, 0.80f, 0.62f, 0.34f, listOf(0f to LookColor.argb(own, if (dark) 0.09f else 0.07f), 1f to LookColor.argb(own, 0f))).draw(canvas, w, h)
  }
}

// The same light at the top of a person's profile (`ProfileLight`) is the profile's own: profile/ProfileVisuals.kt.
