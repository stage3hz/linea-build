package expo.modules.lineachatlist

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64

/** Decorations of the native chat list. Nameplates arrive from JS as PNGs of the app's own vector art; the art of
 *  an avatar decoration is one of the app's bundled pictures, named by its drawable resource or a file path. */
object DecorStore {
  val plates = HashMap<String, Bitmap>()
  private val plateSource = HashMap<String, Int>()
  private val arts = HashMap<String, Bitmap?>()

  /** True when a plate was added or replaced (the rows are redrawn then). */
  fun setPlates(next: Map<String, String>): Boolean {
    var changed = false
    for ((id, base64) in next) {
      val mark = base64.length * 31 + base64.hashCode()
      if (plateSource[id] == mark) continue
      val bytes = Base64.decode(base64.substringAfter("base64,", base64), Base64.DEFAULT)
      val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: continue
      plates[id] = bitmap; plateSource[id] = mark; changed = true
    }
    return changed
  }

  fun art(context: Context, name: String): Bitmap? {
    if (arts.containsKey(name)) return arts[name]
    val bitmap = try {
      when {
        name.startsWith("file://") -> BitmapFactory.decodeFile(name.removePrefix("file://"))
        name.startsWith("/") -> BitmapFactory.decodeFile(name)
        name.contains("://") -> null   // a development server address: no art in the native list there
        else -> {
          val resources = context.resources
          val id = resources.getIdentifier(name, "drawable", context.packageName).takeIf { it != 0 } ?: resources.getIdentifier(name, "raw", context.packageName)
          if (id != 0) BitmapFactory.decodeResource(resources, id) else null
        }
      }
    } catch (_: Throwable) { null }
    arts[name] = bitmap
    return bitmap
  }
}
