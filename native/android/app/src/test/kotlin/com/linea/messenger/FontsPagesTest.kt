package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.text.MeasuredText
import com.linea.messenger.design.Fonts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.TimeUnit

/** Every word the app draws is Montserrat or Unbounded (the reference's faces, design/Fonts.kt): the pages the
 *  emulator check photographs (emu-shots.sh, the same launch arguments) are drawn into a canvas that notes the face
 *  of every text, and a text in the system's face fails — a Paint left without a face, `Typeface.DEFAULT`, a
 *  password field turned fixed-width. The system's default face is never replaced on a phone, so such a text
 *  would show in Roboto there. Monospaced texts (the reference's MONO: codes, keys) are the one exception. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FontsPagesTest {
  /** The canvas that notes each text drawn in a face that is not the app's. */
  private class Words(picture: Bitmap) : Canvas(picture) {
    val wrong = LinkedHashSet<String>()
    var count = 0
    private fun note(text: CharSequence, paint: Paint) {
      count++
      if (!system(paint.typeface)) return
      val words = text.toString().trim()
      // Nothing to read: spaces, a lone emoji or a symbol of an icon font is not a word in a face.
      if (words.none { it.isLetterOrDigit() }) return
      wrong.add("«${words.take(40)}» in ${paint.typeface?.systemFontFamilyName ?: "no face (the system's default)"}")
    }
    override fun drawText(text: CharArray, index: Int, count: Int, x: Float, y: Float, paint: Paint) { note(String(text, index, count), paint); super.drawText(text, index, count, x, y, paint) }
    override fun drawText(text: String, x: Float, y: Float, paint: Paint) { note(text, paint); super.drawText(text, x, y, paint) }
    override fun drawText(text: String, start: Int, end: Int, x: Float, y: Float, paint: Paint) { note(text.substring(start, end), paint); super.drawText(text, start, end, x, y, paint) }
    override fun drawText(text: CharSequence, start: Int, end: Int, x: Float, y: Float, paint: Paint) { note(text.subSequence(start, end), paint); super.drawText(text, start, end, x, y, paint) }
    override fun drawTextRun(text: CharArray, index: Int, count: Int, contextIndex: Int, contextCount: Int, x: Float, y: Float, isRtl: Boolean, paint: Paint) {
      note(String(text, index, count), paint); super.drawTextRun(text, index, count, contextIndex, contextCount, x, y, isRtl, paint)
    }
    override fun drawTextRun(text: CharSequence, start: Int, end: Int, contextStart: Int, contextEnd: Int, x: Float, y: Float, isRtl: Boolean, paint: Paint) {
      note(text.subSequence(start, end), paint); super.drawTextRun(text, start, end, contextStart, contextEnd, x, y, isRtl, paint)
    }
    override fun drawTextRun(text: MeasuredText, start: Int, end: Int, contextStart: Int, contextEnd: Int, x: Float, y: Float, isRtl: Boolean, paint: Paint) {
      count++; if (system(paint.typeface)) wrong.add("a measured text in ${paint.typeface?.systemFontFamilyName ?: "no face"}")
      super.drawTextRun(text, start, end, contextStart, contextEnd, x, y, isRtl, paint)
    }
    override fun drawTextOnPath(text: String, path: Path, hOffset: Float, vOffset: Float, paint: Paint) { note(text, paint); super.drawTextOnPath(text, path, hOffset, vOffset, paint) }
    override fun drawTextOnPath(text: CharArray, index: Int, count: Int, path: Path, hOffset: Float, vOffset: Float, paint: Paint) {
      note(String(text, index, count), paint); super.drawTextOnPath(text, index, count, path, hOffset, vOffset, paint)
    }
  }

  companion object {
    /** A face of the system (Roboto and its kin), or none at all (the system's default); monospace is allowed. */
    fun system(face: Typeface?): Boolean {
      if (face == null) return true
      val name = face.systemFontFamilyName ?: return false
      return name != "monospace" && name != "serif-monospace"
    }
  }

  /** The pages of emu-shots.sh whose texts the review looked at (chat, menus, calls, composer, settings, sign-in…). */
  private val wanted = Regex("^(0[1-9]|1[0-9]|2[0-8]|3[3-9]|4[0-4]|5[0-4]|6[3-7]|11[0-9]|14[0-9]|15[0-2]|17[0-9]|18[0-6]|20[0-9]|21[0-3]|24[3-9]|25[0-5]|29[0-9]|30[0-3]|31[0-9]|32[0-2]|36[0-4]|37[0-5]|38[0-5]|42[0-8]|429[a-d]?|44[0-3]|45[0-2]|460)[a-z]?-")

  private fun shots(): List<Pair<String, Intent>> {
    val script = File("../emu-shots.sh")
    assertTrue("the emulator check's list of pages (native/android/emu-shots.sh)", script.isFile)
    return script.readLines().map { it.trim() }.filter { it.startsWith("shot ") }.mapNotNull { line ->
      val parts = line.split(Regex("\\s+")).drop(1)
      val name = parts.first()
      if (!wanted.containsMatchIn(name)) return@mapNotNull null
      val intent = Intent(Intent.ACTION_MAIN)
      var index = 1
      while (index + 2 < parts.size) {
        val flag = parts[index]; val key = parts[index + 1]; val value = parts[index + 2]
        when (flag) { "--ez" -> intent.putExtra(key, value == "true"); "--es" -> intent.putExtra(key, value) }
        index += 3
      }
      name to intent
    }
  }

  @Test fun theTestTellsTheSystemFaceFromTheApps() {
    assertTrue(system(null))
    assertTrue(system(Typeface.DEFAULT))
    assertTrue(system(Typeface.create(Typeface.DEFAULT, Typeface.BOLD)))
    assertFalse(system(Typeface.MONOSPACE))
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN)).setup().get()
    assertTrue(Fonts.family != null && Fonts.titleFace != null)
    for (weight in listOf(400, 500, 600, 700, 800)) assertFalse("Montserrat $weight", system(Fonts.weight(weight)))
    assertFalse(system(Fonts.title))
    assertFalse(system(Typeface.create(Fonts.weight(400), Typeface.BOLD)))
    activity.finish()
  }

  /** The pages walked below cannot reach every text (a sheet, a state): no code names the system's face. */
  @Test fun noCodeNamesTheSystemsFace() {
    val wrong = ArrayList<String>()
    for (folder in listOf("src/main/kotlin", "src/debug/kotlin")) File(folder).walkTopDown().filter { it.extension == "kt" }.forEach { file ->
      if (file.name == "Fonts.kt") return@forEach
      file.readLines().forEachIndexed { index, line ->
        val code = line.substringBefore("//")
        if (Regex("Typeface\\.(DEFAULT|DEFAULT_BOLD|SANS_SERIF|SERIF)\\b|Typeface\\.defaultFromStyle|typeface = null|setTypeface\\(null").containsMatchIn(code)) wrong.add("${file.path}:${index + 1}: ${line.trim()}")
      }
    }
    assertEquals("the system's face named:\n" + wrong.joinToString("\n"), 0, wrong.size)
  }

  @Test fun everyWordOfThePagesIsInTheAppsFaces() {
    val shots = shots()
    assertTrue("pages to walk: ${shots.size}", shots.size >= 100)
    val wrong = LinkedHashMap<String, Set<String>>()
    val broken = ArrayList<String>()
    var drawn = 0
    for ((name, intent) in shots) {
      val controller = try { Robolectric.buildActivity(MainActivity::class.java, intent).setup() } catch (error: Throwable) { broken.add("$name: $error"); continue }
      try {
        val activity = controller.get()
        shadowOf(activity.mainLooper).idleFor(400, TimeUnit.MILLISECONDS)
        val page = activity.window.decorView
        if (page.width <= 0 || page.height <= 0) { broken.add("$name: not laid out"); continue }
        val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
        val canvas = Words(picture)
        page.draw(canvas)
        picture.recycle()
        drawn += canvas.count
        if (canvas.wrong.isNotEmpty()) wrong[name] = canvas.wrong
      } catch (error: Throwable) {
        broken.add("$name: $error")
      } finally {
        try { controller.pause().stop().destroy() } catch (_: Throwable) {}
      }
    }
    assertTrue("texts drawn: $drawn", drawn > 1000)
    // A page that cannot be built on the JVM (a camera, a player) is not this test's business, but most must be.
    assertTrue("pages not drawn: $broken", broken.size <= shots.size / 5)
    assertEquals("texts in the system's face:\n" + wrong.entries.joinToString("\n") { (page, texts) -> "$page: ${texts.joinToString("; ")}" }, 0, wrong.size)
  }
}
