package com.linea.messenger.people

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.text.TextPaint
import android.view.View
import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.design.Theme
import com.linea.messenger.design.orbPair

/** A person's round picture; without one — their colour as a lit ball with their initials (as in the chat list). */
class PersonAvatarView(context: Context) : View(context) {
  private val orb = Paint(Paint.ANTI_ALIAS_FLAG)
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val letters = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; typeface = Theme.weight(700) }
  private val matrix = Matrix()
  private var colors = intArrayOf(0, 0, 0)
  private var initials = ""
  private var pictureKey = ""
  private var pictureAddress = ""
  private var shaderOf: Bitmap? = null

  /** `address`: where the picture is (empty when the person has none). */
  fun show(person: Person, address: String) {
    val pair = orbPair(person.avatarColor)
    colors = intArrayOf(pair.first, 0xFF000000.toInt() or person.avatarColor, pair.second)
    initials = Messenger.initials(person.displayName)
    pictureKey = person.avatarId
    pictureAddress = address
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val radius = minOf(w, h) / 2
    // The store draws this view again when the picture has come.
    val face = if (pictureKey.isNotEmpty() && pictureAddress.isNotEmpty()) AvatarStore.get(context, pictureKey, pictureAddress, this) else null
    if (face != null) {
      if (shaderOf !== face) { picture.shader = BitmapShader(face, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP); shaderOf = face }
      val scale = maxOf(w / face.width, h / face.height)
      matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate((w - face.width * scale) / 2, (h - face.height * scale) / 2)
      picture.shader?.setLocalMatrix(matrix)
      canvas.drawCircle(w / 2, h / 2, radius, picture)
      return
    }
    orb.shader = LinearGradient(w * 0.1f, 0f, w * 0.9f, h, colors, null, Shader.TileMode.CLAMP)
    canvas.drawCircle(w / 2, h / 2, radius, orb)
    orb.shader = null
    // The letters shrink to fit the ball (down to 0.6 of their size).
    letters.textSize = w * 0.36f
    val room = w * 0.76f
    val wide = letters.measureText(initials)
    if (wide > room && wide > 0f) letters.textSize = w * 0.36f * maxOf(0.6f, room / wide)
    canvas.drawText(initials, w / 2, h / 2 - (letters.ascent() + letters.descent()) / 2, letters)
  }
}
