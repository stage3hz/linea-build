package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.chats.ChatsScreen
import com.linea.messenger.chatsplus.ChatPeekMenu
import com.linea.messenger.chatsplus.FolderEditor
import com.linea.messenger.chatsplus.FoldersSettingsPage
import com.linea.messenger.chatsplus.MuteCustomSheet
import com.linea.messenger.chatsplus.SavedScreen
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.UpdateGate
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
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** The chat list's extras and the shell on the real pages, built and drawn on the JVM (Robolectric): each launch
 *  argument of the emulator check (`chatsdemo`, `shelldemo`, `updatedemo`) leaves the page in the state it names.
 *  Not a phone: no system bars, no blur, no keyboard. Pictures are saved in build/pages/. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatsPlusPagesTest {
  private fun <T : View> find(view: View, kind: Class<T>): T? {
    if (kind.isInstance(view)) return kind.cast(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), kind)?.let { return it }
    return null
  }

  private fun texts(view: View, out: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return out
    if (view is TextView) out.add(view.text.toString())
    if (view is ViewGroup) for (index in 0 until view.childCount) texts(view.getChildAt(index), out)
    return out
  }

  private fun settle(activity: MainActivity, rounds: Int = 10) {
    repeat(rounds) {
      Thread.sleep(30)
      shadowOf(activity.mainLooper).idleFor(200, TimeUnit.MILLISECONDS)
    }
  }

  private fun launch(name: String, vararg extras: Pair<String, String>): MainActivity {
    val intent = Intent(Intent.ACTION_MAIN).putExtra("demo", true)
    for ((key, value) in extras) intent.putExtra(key, value)
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    settle(activity)
    val page = activity.window.decorView
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return activity
  }

  private fun top(activity: MainActivity): View? = find(activity.window.decorView, Navigation::class.java)?.top

  @Test fun theListShowsTheConnectionTheSavedRowAndTheLine() {
    val waiting = launch("140-chats-waiting", "chatsdemo" to "waiting")
    assertTrue(texts(waiting.window.decorView).contains("Ожидание сети…"))
    val list = launch("154-chats-unread-badge")
    val words = texts(list.window.decorView)
    assertTrue(words.any { it.endsWith("ждут ответа") || it.endsWith("ждёт ответа") || it == "всё прочитано" })
    assertNotNull(find(list.window.decorView, ChatsScreen::class.java))
    val empty = launch("144-chats-empty", "chatsdemo" to "empty")
    assertTrue(texts(empty.window.decorView).contains("Начни разговор"))
  }

  @Test fun foldersTabsEditorAndSettings() {
    val folders = launch("145-chats-folders", "chatsdemo" to "folders")
    assertTrue(texts(folders.window.decorView).containsAll(listOf("Все", "Работа", "Семья")))
    launch("147-folder-editor", "chatsdemo" to "foldereditor")
    assertNotNull(ShadowDialog.getLatestDialog() as? FolderEditor)
    ShadowDialog.getLatestDialog()?.dismiss()
    val settings = launch("148-folder-settings", "chatsdemo" to "foldersettings")
    assertTrue(top(settings) is FoldersSettingsPage)
    assertTrue(texts(settings.window.decorView).contains("Создать папку"))
  }

  @Test fun theSavedScreenAndItsMenu() {
    val saved = launch("150-saved", "chatsdemo" to "saved")
    assertTrue(top(saved) is SavedScreen)
    assertTrue(texts(saved.window.decorView).contains("Избранное"))
    launch("149-saved-menu", "chatsdemo" to "savedmenu")
    val menu = ShadowDialog.getLatestDialog() as ChoiceSheet
    assertEquals(listOf("Открыть", "Очистить Избранное"), menu.choices.map { it.label })
    menu.dismiss()
  }

  @Test fun choosingThePeekAndTheOwnTime() {
    val select = launch("297-chats-select", "chatsdemo" to "select")
    assertTrue(texts(select.window.decorView).containsAll(listOf("Готово", "Прочитать", "Звонок · 2", "Удалить")))
    launch("298-chat-peek", "chatlist" to "menu")
    assertNotNull(ShadowDialog.getLatestDialog() as? ChatPeekMenu)
    ShadowDialog.getLatestDialog()?.dismiss()
    launch("300-mute-custom", "chatsdemo" to "mutecustom")
    assertNotNull(ShadowDialog.getLatestDialog() as? MuteCustomSheet)
    ShadowDialog.getLatestDialog()?.dismiss()
  }

  @Test fun theCallsOfPeople() {
    val calls = launch("152-people-calls", "tab" to "people", "chatsdemo" to "calls")
    val words = texts(calls.window.decorView)
    assertTrue(words.containsAll(listOf("Друзья", "Звонки", "Недавние звонки", "Пропущенный звонок")))
  }

  @Test fun theShellMiniPlayerSwipeAndUpdate() {
    val mini = launch("290-mini-player-people", "shelldemo" to "mini")
    assertNotNull(find(mini.window.decorView, com.linea.messenger.music.MiniPlayerView::class.java)?.takeIf { it.visibility == View.VISIBLE })
    // The sample track is the app's one player: it is put away, so the pages of the other checks have no music.
    com.linea.messenger.music.MusicPlayer.shared.stop()
    settle(mini, 2)
    launch("292-swipe-back-half", "shelldemo" to "swipe")
    val required = launch("295-update-required", "updatedemo" to "required")
    settle(required, 8)
    assertTrue(texts(required.window.decorView).contains("Требуется обновление"))
    assertTrue(UpdateGate.mandatory)
  }
}
