package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.chatactions.ForwardPicker
import com.linea.messenger.chatactions.MessageMenu
import com.linea.messenger.chats.ChatsScreen
import com.linea.messenger.core.Core
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
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

/** The actions on messages and chats on the real pages, built and drawn on the JVM (Robolectric): each launch
 *  argument of the emulator check (`chatdemo`, `chatlist`, `chatsearch`) leaves the page in the state it names.
 *  The sample chat is folded by the core, so these are skipped when the core for this machine has not been built.
 *  Not a phone: no system bars, no blur, no keyboard. Pictures are saved in build/pages/. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatActionsPagesTest {
  private fun <T : View> find(view: View, kind: Class<T>): T? {
    if (kind.isInstance(view)) return kind.cast(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), kind)?.let { return it }
    return null
  }

  /** The rows are made on a thread of their own and come back to the main one: both are given their time. */
  private fun settle(activity: MainActivity, rounds: Int = 12) {
    repeat(rounds) {
      Thread.sleep(40)
      shadowOf(activity.mainLooper).idleFor(200, TimeUnit.MILLISECONDS)
    }
  }

  private fun launch(name: String, vararg extras: Pair<String, String>): MainActivity {
    val intent = Intent(Intent.ACTION_MAIN).putExtra("demo", true)
    for ((key, value) in extras) if (value == "true") intent.putExtra(key, true) else intent.putExtra(key, value)
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    settle(activity)
    val page = activity.window.decorView
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return activity
  }

  private fun chat(name: String, state: String): ChatScreen {
    assumeTrue(Core.loaded)
    val activity = launch(name, "chat" to "true", "chatdemo" to state)
    return find(activity.window.decorView, ChatScreen::class.java)!!
  }

  @Test fun theSampleChatHasItsStatusAndItsQuotes() {
    val screen = chat("30-chat-quotes", "quotes")
    assertEquals("в сети", screen.actions.status)
    assertEquals(9, screen.actions.history.shown.order.size)
    assertEquals("", screen.actions.bar)
    assertEquals("печатает…", chat("30b-chat-typing", "typing").actions.status)
  }

  @Test fun replyEditAndDraft() {
    val reply = chat("31-chat-reply", "reply")
    assertEquals(listOf("Ответ Алиса Воронцова", "Лучше распечатки, там таблица"), listOf(reply.actions.bar, reply.actions.barWords))
    val edit = chat("32-chat-edit", "edit")
    assertEquals("Редактирование", edit.actions.bar)
    assertEquals("Распечатки нужны или хватит экрана?", find(edit, EditText::class.java)!!.text.toString())
    val draft = chat("33-chat-draft", "draft")
    assertEquals("Не забыть спросить про проектор", find(draft, EditText::class.java)!!.text.toString())
  }

  @Test fun pinnedAndSelect() {
    val pinned = chat("34-chat-pinned", "pinned")
    assertNotNull(pinned.actions.history.shown.pinned)
    val select = chat("35-chat-select", "select")
    assertEquals("Выбрано: 2", select.actions.selectionWords)
  }

  @Test fun theMenuOfAMessageAndDeleting() {
    val menu = chat("36-chat-menu", "menu").actions.shownMenu
    assertNotNull(menu)
    assertEquals(listOf("Ответить", "Скопировать", "Закрепить", "Переслать", "Удалить", "Выбрать"), menu!!.items.map { it.label })
    assertTrue(menu.showsReactions)
    menu.dismiss()
    val delete = chat("37-chat-delete", "delete").actions.shownMenu
    assertEquals(listOf("Удалить у меня и у Алиса Воронцова", "Удалить у меня"), delete!!.items.map { it.label })
    assertTrue(!delete.showsReactions)
    delete.dismiss()
  }

  @Test fun forwardOffersTheChats() {
    chat("38-chat-forward", "forward")
    val picker = ShadowDialog.getLatestDialog() as? ForwardPicker
    assertNotNull(picker)
    assertTrue(picker!!.names.contains("Алиса Воронцова"))
    picker.dismiss()
  }

  @Test fun sendingAnAnswerInTheSampleChat() {
    val screen = chat("39-chat-answer", "reply")
    val field = find(screen, EditText::class.java)!!
    field.setText("Принесу")
    screen.actions.submit()
    settle(screen.context as MainActivity, 6)
    val shown = screen.actions.history.shown
    val last = shown.messages.getValue(shown.order.last())
    assertEquals("Принесу", last["text"])
    assertNotNull(Core.map(Core.map(last["meta"])?.get("reply")))
    assertEquals(listOf("", ""), listOf(screen.actions.bar, field.text.toString()))
  }

  private fun list(name: String, key: String, value: String): MainActivity = launch(name, key to value)

  @Test fun theListOfChats() {
    val menu = list("40-list-menu", "chatlist", "menu")
    val sheet = ShadowDialog.getLatestDialog() as? ChoiceSheet
    assertEquals(listOf("Пометить как прочитанное", "Открепить", "Выключить звук", "В архив", "Удалить чат"), sheet!!.choices.map { it.label })
    assertEquals("Алиса Воронцова", sheet.heading)
    sheet.dismiss()
    assertNotNull(find(menu.window.decorView, ChatsScreen::class.java))

    list("41-list-mute", "chatlist", "mute")
    val mute = ShadowDialog.getLatestDialog() as ChoiceSheet
    assertEquals(listOf("Выключить звук", "Алиса Воронцова"), listOf(mute.heading, mute.note))
    assertEquals(listOf("На 1 час", "На 8 часов", "На 2 дня", "Навсегда"), mute.choices.map { it.label })
    mute.dismiss()

    list("42-list-delete", "chatlist", "delete")
    val delete = ShadowDialog.getLatestDialog() as ChoiceSheet
    assertEquals("Удалить чат?", delete.heading)
    assertEquals(listOf("Удалить у меня", "Удалить у меня и у собеседника"), delete.choices.map { it.label })
    delete.dismiss()
  }

  @Test fun archiveDraftUnreadAndSearchDoNotBreakTheList() {
    for ((name, key, value) in listOf(Triple("43-list-archive", "chatlist", "archive"), Triple("44-list-archived", "chatlist", "archived"), Triple("45-list-draft", "chatlist", "draft"),
      Triple("46-list-unread", "chatlist", "unread"), Triple("47-list-search", "chatsearch", "ма"))) {
      val activity = list(name, key, value)
      assertNotNull(find(activity.window.decorView, ChatsScreen::class.java))
    }
  }
}
