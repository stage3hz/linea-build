package com.linea.messenger.design

import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.text.TextPaint

/** The avatar of a person without a photo, one rule for every screen — the reference's `Avatar`
 *  (mobile/src/components.tsx:139-150, colours from mobile/src/design/peerLight.tsx `orbColors`; iOS
 *  Avatars/AvatarOrb.swift):
 *  - a ball of three colours [lighter, the colour, deeper] from (.9, 1) to (.1, 0);
 *  - over it a white highlight 0.42 → 0.06 → 0 at .0/.38/.6, from (.12, .02) to (.7, .8);
 *  - the initials (`Messenger.initials`: the first character of the first two words, in capitals) at 0.32 of the
 *    side, bold (700), letter spacing −0.5, dark (#14243D) on a light colour and white on the others.
 *  Round always (the owner's rule). One instance per view: it keeps its paints and the gradients of the last size. */
class AvatarOrb(private val density: Float) {
  private val body = Paint(Paint.ANTI_ALIAS_FLAG)
  private val shine = Paint(Paint.ANTI_ALIAS_FLAG)
  private val letters = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Theme.weight(700) }
  private var madeFor = FloatArray(4) { Float.NaN }
  private var madeRgb = -1

  /** The whole avatar (ball, highlight, initials) in the circle of the square (left, top, side). `rgb`: 0xRRGGBB. */
  fun draw(canvas: Canvas, left: Float, top: Float, side: Float, rgb: Int, initials: String) {
    if (side <= 0f) return
    val color = rgb and 0xFFFFFF
    if (madeRgb != color || madeFor[0] != left || madeFor[1] != top || madeFor[2] != side) {
      val pair = orbPair(color)
      body.shader = LinearGradient(left + side * 0.9f, top + side, left + side * 0.1f, top, intArrayOf(pair.first, 0xFF000000.toInt() or color, pair.second), null, Shader.TileMode.CLAMP)
      shine.shader = LinearGradient(left + side * 0.12f, top + side * 0.02f, left + side * 0.7f, top + side * 0.8f, SHINE, SHINE_STOPS, Shader.TileMode.CLAMP)
      madeRgb = color; madeFor[0] = left; madeFor[1] = top; madeFor[2] = side
    }
    val cx = left + side / 2; val cy = top + side / 2
    canvas.drawCircle(cx, cy, side / 2, body)
    canvas.drawCircle(cx, cy, side / 2, shine)
    if (initials.isEmpty()) return
    letters.color = lettersColor(color)
    letters.textSize = side * 0.32f
    letters.letterSpacing = -0.5f * density / letters.textSize
    // Never wider than the ball (an unusually wide character): shrunk to fit, as the label does on iOS.
    val room = side * 0.76f
    val wide = letters.measureText(initials)
    if (wide > room && wide > 0f) { letters.textSize *= maxOf(0.5f, room / wide); letters.letterSpacing = -0.5f * density / letters.textSize }
    canvas.drawText(initials, cx, cy - (letters.ascent() + letters.descent()) / 2, letters)
  }

  companion object {
    private val SHINE = intArrayOf(0x6BFFFFFF, 0x0FFFFFFF, 0x00FFFFFF)
    private val SHINE_STOPS = floatArrayOf(0f, 0.38f, 0.6f)

    /** components.tsx:139 `avatarTextColor`: #14243D when 0.299 R + 0.587 G + 0.114 B is above 0.68, else white. */
    fun lettersColor(rgb: Int): Int {
      val r = ((rgb shr 16) and 255) / 255.0; val g = ((rgb shr 8) and 255) / 255.0; val b = (rgb and 255) / 255.0
      return if (r * 0.299 + g * 0.587 + b * 0.114 > 0.68) 0xFF14243D.toInt() else 0xFFFFFFFF.toInt()
    }
  }
}
