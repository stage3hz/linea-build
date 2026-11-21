package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.calls.CallBarView
import com.linea.messenger.calls.CallHost
import com.linea.messenger.calls.CallRoundButton
import com.linea.messenger.calls.CallScreenView
import com.linea.messenger.calls.Calls
import com.linea.messenger.calls.CallsDemo
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.core.Core
import com.linea.messenger.shell.Navigation
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

/** Calls, built and drawn on the JVM as `PagesTest` does: every launch argument of the emulator check shows the
 *  call screen it should, with the words of the iPhone app; the buttons do what they say; a minimised call is a
 *  bar the pages make room for. Each page is saved as a picture in build/pages/. Not a phone: no microphone, no
 *  camera, no connection — the calls are the debug build's samples. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CallPagesTest {
  @After fun noCallIsLeftBehind() { Calls.stop() }

  private fun snap(name: String, page: View) {
    if (page.width <= 0 || page.height <= 0) return
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun idle(activity: MainActivity, wait: Long = 600) = shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)

  private fun launch(name: String, state: String): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("calldemo", state)).setup().get()
    idle(activity, 1500)
    snap(name, activity.window.decorView)
    return activity
  }

  private fun <T : View> all(view: View, kind: Class<T>, into: MutableList<T> = ArrayList()): List<T> {
    if (kind.isInstance(view) && view.visibility == View.VISIBLE) into.add(kind.cast(view)!!)
    if (view is ViewGroup && view.visibility == View.VISIBLE) for (index in 0 until view.childCount) all(view.getChildAt(index), kind, into)
    return into
  }

  private fun page(activity: MainActivity): View = activity.window.decorView
  private fun screen(activity: MainActivity): CallScreenView? = all(page(activity), CallScreenView::class.java).firstOrNull()
  private fun buttons(activity: MainActivity): List<String> = screen(activity)?.let { all(it, CallRoundButton::class.java).map { button -> button.words } } ?: emptyList()
  private fun texts(view: View): List<String> = all(view, TextView::class.java).map { it.text.toString() }
  private fun press(activity: MainActivity, words: String) {
    all(page(activity), CallRoundButton::class.java).first { it.words == words }.performClick()
    idle(activity)
  }

  @Test fun aCallBeingPlaced() {
    val activity = launch("call-outgoing", "outgoing")
    val shown = screen(activity)
    assertNotNull(shown)
    assertEquals(listOf("Динамик", "Видео", "Убрать звук", "Завершить"), buttons(activity))
    val words = texts(shown!!)
    assertTrue(words.toString(), words.contains("Алиса Воронцова"))
    assertTrue(words.toString(), words.contains("🔒 Звонок защищён сквозным шифрованием"))
    if (Core.loaded) assertTrue(words.toString(), words.contains("Вызов…"))
    // The screen covers the whole window.
    assertEquals(page(activity).width, shown.width)
    // «Убрать звук» and «Динамик» change their own button.
    press(activity, "Убрать звук")
    assertEquals(listOf("Динамик", "Видео", "Звук выкл", "Завершить"), buttons(activity))
    assertEquals(true, Calls.call?.muted)
    press(activity, "Динамик")
    assertEquals(true, Calls.call?.speaker)
    assertTrue(all(page(activity), CallRoundButton::class.java).first { it.words == "Динамик" }.isSelected)
  }

  @Test fun anIncomingCallIsAnsweredOrDeclined() {
    val activity = launch("call-incoming", "incoming")
    assertEquals(listOf("Отклонить", "Ответить"), buttons(activity))
    if (Core.loaded) assertTrue(texts(screen(activity)!!).contains("Входящий звонок"))
    // An incoming call cannot be minimised.
    Calls.minimize()
    assertEquals(false, Calls.call?.minimized)
    press(activity, "Ответить")
    assertEquals("active", Calls.call?.status)
    assertEquals(listOf("Динамик", "Видео", "Убрать звук", "Завершить"), buttons(activity))
    assertTrue(texts(screen(activity)!!).any { it.startsWith("🔒 🦊") })
    snap("call-answered", page(activity))
  }

  @Test fun aRunningCallAndItsEnd() {
    val activity = launch("call-active", "active")
    val words = texts(screen(activity)!!)
    assertTrue(words.toString(), words.contains("🔒 🦊 🌵 🎧 ⭐"))
    if (Core.loaded) assertTrue(words.toString(), words.any { it.startsWith("0:4") })
    if (!Core.loaded) return
    // «Завершить»: the words of the end stay for a moment, then the screen is gone.
    press(activity, "Завершить")
    assertEquals("ended", Calls.call?.status)
    assertEquals("Звонок завершён", Calls.call?.endedText)
    assertEquals(emptyList<String>(), buttons(activity))
    idle(activity, 2500)
    assertNull(Calls.call)
    assertNull(screen(activity))
    assertEquals(0, all(page(activity), CallHost::class.java).size)
  }

  @Test fun aVideoCall() {
    val activity = launch("call-video", "video")
    assertEquals(listOf("Динамик", "Видео", "Повернуть", "Убрать звук", "Завершить"), buttons(activity))
    assertTrue(texts(screen(activity)!!).contains("🔒 🐳 🍋 🚀 🌙"))
    // «Видео» switches this phone's camera off: «Повернуть» goes with it.
    press(activity, "Видео")
    assertEquals(true, Calls.call?.cameraOff)
    assertEquals(listOf("Динамик", "Видео", "Убрать звук", "Завершить"), buttons(activity))
  }

  @Test fun noConnectionOffersToTryAgain() {
    val activity = launch("call-retry", "retry")
    assertEquals(listOf("Закрыть", "Повторить"), buttons(activity))
    if (Core.loaded) assertTrue(texts(screen(activity)!!).contains("Нет соединения"))
    // It stays until the person decides.
    idle(activity, 3000)
    assertNotNull(screen(activity))
    press(activity, "Повторить")
    assertEquals("ringing", Calls.call?.status)
    CallsDemo.show("retry")
    idle(activity)
    press(activity, "Закрыть")
    assertNull(Calls.call)
  }

  @Test fun aMinimisedCallIsABarThePagesMakeRoomFor() {
    val activity = launch("call-bar", "bar")
    assertNull(screen(activity))
    val bar = all(page(activity), CallBarView::class.java).first()
    val d = activity.resources.displayMetrics.density
    assertEquals(Math.round(36f * d), bar.height)
    assertEquals(page(activity).width, bar.width)
    assertTrue(texts(bar).first().contains("Алиса Воронцова"))
    assertTrue(bar.contentDescription.toString().endsWith("Вернуться к звонку"))
    val pages = all(page(activity), Navigation::class.java).first()
    assertEquals(Math.round(36f * d), (pages.layoutParams as ViewGroup.MarginLayoutParams).topMargin)
    // A touch on the bar opens the call again; the pages go back up.
    bar.performClick()
    idle(activity)
    assertNotNull(screen(activity))
    assertEquals(false, Calls.call?.minimized)
    assertEquals(0, (pages.layoutParams as ViewGroup.MarginLayoutParams).topMargin)
    assertFalse(bar.visibility == View.VISIBLE)
    // The chevron minimises it.
    Calls.minimize()
    idle(activity)
    assertNull(screen(activity))
    assertEquals(View.VISIBLE, all(page(activity), CallBarView::class.java).first().visibility)
  }

  @Test fun theChatsHeaderAndThePersonsProfileRing() {
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("chat", true)).setup().get()
    idle(activity, 800)
    val chat = all(page(activity), ChatScreen::class.java).first()
    assertEquals("Позвонить", chat.callButton.contentDescription)
    assertTrue(chat.callButton.width > 0 && chat.callButton.left > chat.width / 2)
    // Opened from the chat, the profile's row is «Звонок», «Видео», «Ещё».
    chat.openProfile()
    idle(activity, 800)
    val described = all(page(activity), View::class.java).mapNotNull { it.contentDescription?.toString() }
    for (words in listOf("Звонок", "Видео", "Ещё")) assertTrue(described.toString(), described.contains(words))
    assertFalse(described.contains("Написать"))
    snap("call-profile-tiles", page(activity))
    // Without an account the button shows the sample of a call being placed.
    chat.callButton.performClick()
    idle(activity, 800)
    assertEquals("ringing", Calls.call?.status)
    assertNotNull(screen(activity))
  }
}
