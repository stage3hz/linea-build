package com.linea.messenger.people

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.design.AvatarOrb

/** A person's round picture; without one — their colour as a lit ball with their initials (as in the chat list). */
class PersonAvatarView(context: Context) : View(context) {
  private val orb = AvatarOrb(resources.displayMetrics.density)
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val matrix = Matrix()
  private var rgb = 0
  private var initials = ""
  private var pictureKey = ""
  private var pictureAddress = ""
  private var shaderOf: Bitmap? = null

  /** `address`: where the picture is (empty when the person has none). */
  fun show(person: Person, address: String) {
    rgb = person.avatarColor
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
    // components.tsx:150 `Avatar`: the lit ball, its highlight and the initials (design/AvatarOrb.kt).
    val side = minOf(w, h)
    orb.draw(canvas, (w - side) / 2, (h - side) / 2, side, rgb, initials)
  }
}
