package expo.modules.lineachatlist

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayOutputStream

/** A container whose React children can be photographed: the app draws a decoration with its own components
 *  (vector frames, nameplates) once, off screen, and the native lists show the picture. Never takes a touch. */
@SuppressLint("ViewConstructor")
class BakeView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override fun isEnabled(): Boolean = false

  /** The children as a PNG (base64); '' when there is nothing to draw yet. */
  fun snapshot(): String {
    if (width <= 0 || height <= 0) return ""
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    draw(Canvas(bitmap))
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
    bitmap.recycle()
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }
}
