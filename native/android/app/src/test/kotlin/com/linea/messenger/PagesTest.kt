package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.text.InputType
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

/** The real pages, built and drawn on the JVM (Robolectric with its native drawing): every launch argument of the
 *  emulator check opens what it should, a start without an account opens signing in, and each page is saved as
 *  a picture in build/pages/ to be looked at.
 *  Not a phone: no system bars, no blur behind the glass (the plain fill is drawn), no core library. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PagesTest {
  private fun launch(name: String, intent: Intent, wait: Long = 400): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    val page = activity.window.decorView
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return activity
  }

  private fun find(view: View, className: String): View? {
    if (view.javaClass.simpleName == className) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), className)?.let { return it }
    return null
  }

  private fun intent() = Intent(Intent.ACTION_MAIN)
  /** The shell with the sample chats: every page of it is asked for together with `demo`. */
  private fun demo() = intent().putExtra("demo", true)

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view is TextView && view.visibility == View.VISIBLE) into.add(view.text.toString())
    // Effects: the drawn parts of the sign-in screen (the wordmark, the button with states).
    if (view is com.linea.messenger.effects.WordmarkView) into.add("Инвиз")
    if (view is com.linea.messenger.effects.ActionButton) into.add(view.label)
    if (view is com.linea.messenger.effects.AppearingTextView) into.add(view.text)
    if (view is ViewGroup) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun field(view: View): EditText? {
    if (view is EditText) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) field(view.getChildAt(index))?.let { return it }
    return null
  }

  @Test fun withoutAnAccountTheAppOpensSigningIn() {
    val activity = launch("05-auth", intent())
    val page = activity.window.decorView
    assertNotNull(find(page, "AuthScreen"))
    assertEquals(null, find(page, "RootScreen"))
    assertTrue(texts(page).containsAll(listOf("Инвиз", "Твоя линия связи.", "Логин", "Продолжить")))
    // The launch arguments of the shell do nothing without `demo`.
    val other = launch("05-auth-not-demo", intent().putExtra("chat", true).putExtra("tab", "profile"))
    assertNotNull(find(other.window.decorView, "AuthScreen"))
    assertEquals(null, find(other.window.decorView, "ChatScreen"))
  }

  // Signing in step by step, creating an account and a forgotten password: AuthPagesTest.

  private fun click(view: View, words: String): Boolean {
    if (view is TextView && view.text.toString() == words && view.visibility == View.VISIBLE) { view.performClick(); return true }
    if (view is ViewGroup) for (index in 0 until view.childCount) if (click(view.getChildAt(index), words)) return true
    return false
  }

  @Test fun chats() {
    val activity = launch("01-chats", demo())
    assertNotNull(find(activity.window.decorView, "ChatsScreen"))
    val bar = find(activity.window.decorView, "TabBarView")!!
    val density = activity.resources.displayMetrics.density
    assertEquals(176f, bar.width / density, 0.5f)
    assertEquals(62f, bar.height / density, 0.5f)
    assertEquals(2, (bar as ViewGroup).childCount)
  }

  @Test fun sections() {
    val activity = launch("02-sections", demo().putExtra("sections", true), wait = 2500)
    assertNotNull(find(activity.window.decorView, "TabListOverlay"))
  }

  @Test fun settings() {
    val activity = launch("03-settings", demo().putExtra("tab", "profile"))
    assertNotNull(find(activity.window.decorView, "SettingsScreen"))
  }

  @Test fun chat() {
    val activity = launch("04-chat", demo().putExtra("chat", true))
    val chat = find(activity.window.decorView, "ChatScreen")
    assertNotNull(chat)
    assertTrue(chat!!.width > 0)
    // Back leaves the chat.
    @Suppress("DEPRECATION") activity.onBackPressed()
    shadowOf(activity.mainLooper).idleFor(600, TimeUnit.MILLISECONDS)
    assertEquals(null, find(activity.window.decorView, "ChatScreen"))
  }
}
