package com.linea.messenger

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.util.LruCache
import android.view.View
import org.robolectric.RuntimeEnvironment
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.chats.ChatPalette
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.chats.ChatRowView
import com.linea.messenger.chats.DecorStore
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The emulator's «Анна Лебедева» (a person with a nameplate and the Platina ring): her row showed a solid black
 *  circle instead of her photo. The row's `picture` paint is shared by the nameplate and the avatar; the nameplate
 *  reset its shader after drawing, and the avatar reused "its" shader only by remembering the bitmap — so from the
 *  second frame on the photo was drawn with no shader, in the paint's black. Each row is drawn several times here. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatRowDecorPhotoTest {
  private val photoColor = 0xFFE0A040.toInt()

  @Suppress("UNCHECKED_CAST")
  private fun putAvatar(key: String, bitmap: Bitmap) {
    val field = AvatarStore::class.java.getDeclaredField("memory").apply { isAccessible = true }
    (field.get(AvatarStore) as LruCache<String, Bitmap>).put(key, bitmap)
  }

  private fun solid(color: Int, side: Int = 180) = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }

  private fun row(plate: String, ring: List<Int>, thumb: String = ""): ChatRow = ChatRow.parse(listOf(mapOf(
    "id" to "anna", "title" to "Анна Лебедева", "preview" to "Ок, жду", "time" to "06:38", "unread" to 4,
    "initials" to "АЛ", "avatarColor" to 0xFF5E7BFF.toInt(), "avatarUrl" to "https://localhost/avatars/anna", "avatarKey" to "anna-photo",
    "ring" to ring, "plate" to plate, "metal" to listOf(0xFFE8ECF2.toInt(), 0xFF9AA3B0.toInt()), "nameLen" to 13, "thumb" to thumb,
  ))).single()

  /** The colour in the middle of the avatar circle after drawing the row `times` times. */
  private fun avatarCentre(item: ChatRow, times: Int = 3): Int {
    val context = RuntimeEnvironment.getApplication()
    val view = ChatRowView(context)
    view.bind(item, ChatPalette.DARK)
    val width = 1080
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED)
    view.layout(0, 0, width, view.measuredHeight)
    val picture = Bitmap.createBitmap(width, view.measuredHeight, Bitmap.Config.ARGB_8888)
    repeat(times) { picture.eraseColor(0); view.draw(Canvas(picture)) }
    val d = context.resources.displayMetrics.density
    return picture.getPixel(Math.round((16 + 30) * d), view.measuredHeight / 2)
  }

  private fun assertPhoto(color: Int, what: String) {
    assertTrue("$what: the avatar is #${Integer.toHexString(color)}, not the photo", Color.alpha(color) == 255 && Color.red(color) > 0xC0 && Color.green(color) > 0x80 && Color.blue(color) < 0x70)
  }

  @Test fun aRowWithANameplateAndARingShowsThePhotoInsideTheFrame() {
    putAvatar("anna-photo", solid(photoColor))
    DecorStore.plates["test-crows"] = solid(0xFF2A3040.toInt(), 300)
    val ring = listOf(0xFFE8ECF2.toInt(), 0xFF9AA3B0.toInt(), 0xFFE8ECF2.toInt())
    assertPhoto(avatarCentre(row("test-crows", ring), times = 1), "first frame")
    assertPhoto(avatarCentre(row("test-crows", ring)), "nameplate and ring, redrawn")
    assertPhoto(avatarCentre(row("test-crows", emptyList())), "nameplate only, redrawn")
    assertPhoto(avatarCentre(row("", ring)), "ring only, redrawn")
  }

  @Test fun aRowWithAPictureBeforeItsLineKeepsThePhoto() {
    // The small picture of the last message shares the same paint too.
    putAvatar("anna-photo", solid(photoColor))
    val out = java.io.ByteArrayOutputStream()
    solid(0xFF3060E0.toInt(), 40).compress(Bitmap.CompressFormat.PNG, 100, out)
    val thumb = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
    assertPhoto(avatarCentre(row("", emptyList(), thumb)), "thumbnail row, redrawn")
  }
}
