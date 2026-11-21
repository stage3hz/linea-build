package com.linea.messenger

import android.app.Dialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chatlook.AvatarPeek
import com.linea.messenger.chatlook.ChatBubbleLook
import com.linea.messenger.chatlook.Wallpapers
import com.linea.messenger.composer.ComposerSheet
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** The chat's look, the composer's extras and the polls (ChatLook, Composer, Polls), built and drawn on the JVM with
 *  the launch arguments of the emulator check; each page is saved as a picture in build/pages/. Not a phone: no
 *  system bars, no blur behind the glass. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatLookPagesTest {
  @After fun reset() {
    ChatBubbleLook.demoBubbles = null
    Wallpapers.demo = null
  }

  private fun snap(name: String, page: View) {
    if (page.width <= 0 || page.height <= 0) return
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun chat(name: String, vararg extras: Pair<String, String>, wait: Long = 2600): Pair<MainActivity, ChatScreen> {
    val intent = Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("chat", true)
    for ((key, value) in extras) intent.putExtra(key, value)
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    snap(name, activity.window.decorView)
    return Pair(activity, all(activity.window.decorView, ChatScreen::class.java).first())
  }

  private fun <T : View> all(view: View, kind: Class<T>, into: MutableList<T> = ArrayList()): List<T> {
    if (kind.isInstance(view)) into.add(kind.cast(view)!!)
    if (view is ViewGroup) for (index in 0 until view.childCount) all(view.getChildAt(index), kind, into)
    return into
  }

  private fun texts(view: View): List<String> = all(view, TextView::class.java).filter { it.isShown }.map { it.text.toString() }
  private fun described(view: View): List<String> = all(view, View::class.java).mapNotNull { it.contentDescription?.toString() }

  private fun dialog(name: String): Dialog {
    val shown = ShadowDialog.getLatestDialog()
    assertNotNull(shown)
    snap(name, shown.window!!.decorView)
    return shown
  }

  @Test fun theGlassHeader() {
    val (_, screen) = chat("170-chatlook-header", "chatlook" to "header")
    val words = described(screen)
    assertTrue(words.toString(), words.contains("Назад к чатам, непрочитанных 3"))
    assertTrue(words.contains("Полный профиль Алиса Воронцова"))
    assertTrue(words.contains("Профиль Алиса Воронцова"))
    assertTrue(ChatBubbleLook.open)
    chat("180-chatlook-offline", "chatlook" to "header", "chatlookline" to "offline").second.let { assertEquals("ожидание сети…", it.actions.status) }
  }

  @Test fun thePeekBubblesAndWallpaper() {
    chat("171-chatlook-peek", "chatlook" to "peek")
    val peek = AvatarPeek.last?.get()
    assertNotNull(peek)
    assertEquals(listOf("Открыть профиль", "Поиск", "Отправить подарок"), peek!!.items.map { it.label })
    dialog("171-chatlook-peek-card")
    chat("172-chatlook-bubbles", "chatlook" to "bubbles")
    assertFalse(ChatBubbleLook.open)
    ChatBubbleLook.demoBubbles = null
    chat("173-chatlook-wallpaper", "chatlook" to "wallpaper")
    assertFalse(ChatBubbleLook.open)
  }

  @Test fun theSwipeAndTheReply() {
    chat("174-chatlook-swipe", "chatlook" to "swipe")
    val (_, screen) = chat("175-chatlook-reply", "chatlook" to "reply")
    assertEquals("Ответ Алиса Воронцова", screen.actions.bar)
    chat("176-chatlook-arrive", "chatlook" to "arrive")
  }

  @Test fun thePickerAndThePreview() {
    chat("177-chatlook-picker", "chatlook" to "picker")
    val picker = dialog("177-chatlook-picker-sheet")
    assertTrue(texts(picker.window!!.decorView).containsAll(listOf("Обои чатов", "Выбрать из галереи")))
    chat("178-chatlook-preview", "chatlook" to "preview")
    val preview = dialog("178-chatlook-preview-page")
    assertTrue(texts(preview.window!!.decorView).containsAll(listOf("Предпросмотр", "Отмена", "Установить")))
  }

  @Test fun theComposer() {
    chat("200-composer-silent", "composerdemo" to "silent")
    assertTrue(texts(dialog("200-composer-silent-sheet").window!!.decorView).containsAll(listOf("Отправить без звука", "Отправить позже")))
    chat("201-composer-later", "composerdemo" to "later")
    assertTrue(texts(dialog("201-composer-later-sheet").window!!.decorView).contains("Отправить позже"))
    val (_, pill) = chat("202-composer-scheduled-pill", "composerdemo" to "scheduled")
    assertTrue(described(pill).contains("Отложенные сообщения: 2"))
    chat("203-composer-scheduled-list", "composerdemo" to "list")
    assertTrue(ComposerSheet.shownLast?.get() != null)
    assertTrue(texts(dialog("203-composer-scheduled-list-sheet").window!!.decorView).contains("Отложенные сообщения"))
    val (_, emoji) = chat("204-composer-emoji", "composerdemo" to "emoji")
    assertTrue(described(emoji).contains("Скрыть эмодзи"))
    val (_, format) = chat("205-composer-format", "composerdemo" to "format")
    assertTrue(described(format).contains("Жирный"))
  }

  @Test fun thePollsTheSearchAndForwarding() {
    val (_, features) = chat("206-chat-features", "chatdemo" to "features")
    assertTrue(described(features).any { it.contains("Куда пойдём в пятницу?") })
    assertTrue(described(features).any { it.contains("без звука") })
    chat("207-poll-new", "chatdemo" to "newpoll")
    assertTrue(texts(dialog("207-poll-new-sheet").window!!.decorView).containsAll(listOf("Новый опрос", "Отправить опрос")))
    val (_, search) = chat("208-chat-search", "chatdemo" to "search")
    assertTrue(search.actions.searching)
    chat("213-forward-saved", "chatdemo" to "forward")
    assertTrue(texts(dialog("213-forward-saved-picker").window!!.decorView).contains("Избранное"))
    chat("360-forward-many", "chatdemo" to "forwardmany")
    assertTrue(texts(dialog("360-forward-many-picker").window!!.decorView).contains("Отмена"))
  }
}
