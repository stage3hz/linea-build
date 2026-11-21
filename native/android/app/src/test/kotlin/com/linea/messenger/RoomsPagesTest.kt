package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.core.Core
import com.linea.messenger.rooms.RoomBarView
import com.linea.messenger.rooms.RoomHost
import com.linea.messenger.rooms.RoomMusicLine
import com.linea.messenger.rooms.RoomOverlay
import com.linea.messenger.rooms.RoomPicker
import com.linea.messenger.rooms.RoomRowView
import com.linea.messenger.rooms.RoomScreen
import com.linea.messenger.rooms.RoomVoice
import com.linea.messenger.rooms.Rooms
import com.linea.messenger.rooms.RoomsSectionView
import com.linea.messenger.shell.Navigation
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** Rooms, built and drawn on the JVM with the real core behind them (`CoreSharingRunner`; skipped when the core has
 *  not been built for this machine): every launch argument of the emulator check (`--es roomsdemo …`) shows what it
 *  should, with the words of the iPhone app; the buttons do what they say. Each page is saved as a picture in
 *  build/pages/. Not a phone: no microphone, no connection, no server — the rooms are the debug build's samples. */
@RunWith(CoreSharingRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RoomsPagesTest {
  private lateinit var activity: MainActivity
  private lateinit var page: View

  @Before fun theCoreIsHere() { assumeTrue(Core.loaded) }

  @After fun nothingIsLeftBehind() {
    RoomPicker.current?.dismiss()
    ShadowDialog.getShownDialogs().forEach { it.dismiss() }
    ShadowDialog.reset()
    Rooms.stop()
  }

  private fun idle(ms: Long = 600) {
    repeat(6) {
      Thread.sleep(10)
      shadowOf(activity.mainLooper).idleFor(ms / 6, TimeUnit.MILLISECONDS)
    }
  }

  private fun launch(demo: String, wait: Long = 1500) {
    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("roomsdemo", demo)).setup().get()
    page = activity.window.decorView
    idle(wait)
  }

  private fun snap(name: String, view: View = page) {
    if (view.width <= 0 || view.height <= 0) return
    val picture = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    view.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun all(view: View, into: MutableList<View> = ArrayList()): List<View> {
    if (view.visibility != View.VISIBLE) return into
    into.add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) all(view.getChildAt(index), into)
    return into
  }

  private fun texts(view: View): List<String> = all(view).filterIsInstance<TextView>().map { it.text.toString() }.filter { it.isNotEmpty() }
  private val stack: Navigation get() = all(page).first { it is Navigation } as Navigation
  private val room: RoomScreen get() = stack.top as RoomScreen
  private val host: RoomHost? get() = all(page).filterIsInstance<RoomHost>().firstOrNull()

  @Test fun theRoomsStandOnTopOfChannels() {
    launch("list")
    snap("56-rooms-list")
    val section = all(page).filterIsInstance<RoomsSectionView>().single()
    val rows = section.shownRows
    assertEquals(5, rows.size)
    // Two lit cards first, then the quiet rows.
    assertEquals(listOf(true, true, false, false, false), rows.map { it.lit })
    assertEquals(listOf("Комната Походники, трое внутри", "Комната Лариса, Тимур, один внутри", "Комната Семья, спит", "Комната Глеб, Мира и ещё 2, спит", "Комната Работа, спит"),
      rows.map { it.contentDescription.toString() })
    val words = texts(section)
    assertTrue(words.toString(), words.containsAll(listOf("КОМНАТЫ", "Походники", "трое внутри", "Зайти", "никого · ещё не спит", "спит · были вчера в 18:20", "спит · ещё никто не заходил", "3 чел", "5 чел")))
    assertTrue(section.height > 0)
    // The communities are still under the rooms; «Свои места для своих» gives way to them.
    assertTrue(texts(page).contains("Каналы"))
    assertTrue(Rooms.awake)
    // A touch on a row opens its room over «Каналы».
    rows[2].performClick()
    idle()
    assertEquals("Семья", room.shownName)
    assertEquals("комната · никого, ещё не спит", room.shownStatus)
  }

  @Test fun withoutRoomsTheSectionSaysHowOneIsMade() {
    launch("empty")
    snap("56b-rooms-empty")
    val section = all(page).filterIsInstance<RoomsSectionView>().single()
    assertEquals(0, section.shownRows.size)
    assertTrue(texts(section).contains("Комнат пока нет. В чатах удержи собеседника, нажми «Выбрать», отметь людей и позвони всем сразу — получится комната."))
  }

  @Test fun insideARoom() {
    launch("room")
    snap("57-room")
    val screen = room
    assertEquals("Походники", screen.shownName)
    assertEquals("комната · четверо внутри", screen.shownStatus)
    assertEquals(listOf("Звук на динамике", "Выключить микрофон", "Выйти из комнаты"), screen.buttons)
    assertTrue(screen.texts.contains("Позвать всех"))
    assertFalse(screen.texts.contains("Зайти"))
    val seats = screen.seats.associateBy { it.firstName }
    assertEquals(setOf("ты", "Лариса", "Тимур", "Анна", "Глеб", "Мира"), seats.keys)
    assertEquals("Лариса Орлова, говорит", seats.getValue("Лариса").words)
    assertTrue(seats.getValue("Лариса").talking)
    assertEquals("Тимур Ахметов, микрофон выключен", seats.getValue("Тимур").words)
    assertTrue(seats.getValue("Тимур").mutedShown)
    assertEquals("Глеб Соколов, не в комнате", seats.getValue("Глеб").words)
    assertEquals("Ты, в комнате", seats.getValue("ты").words)
    assertTrue(seats.values.all { it.width > 0 && it.left >= 0 && it.right <= screen.width })
    // Without headphones there is no music for everyone.
    val line = all(page).filterIsInstance<RoomMusicLine>().single()
    assertTrue(texts(line).contains("Музыка для всех — на телефоне только в наушниках"))
    // The room's own screen is on top: no bar over it.
    assertTrue(host?.bar?.visibility != View.VISIBLE)
    // The microphone goes off and on.
    all(page).filterIsInstance<com.linea.messenger.rooms.RoomRoundButton>().first { it.words == "Выключить микрофон" }.performClick()
    idle()
    assertEquals(true, RoomVoice.state?.muted)
    assertEquals(listOf("Звук на динамике", "Включить микрофон", "Выйти из комнаты"), room.buttons)
    // The way out: the room goes on screen as one this phone is not inside.
    all(page).filterIsInstance<com.linea.messenger.rooms.RoomRoundButton>().first { it.words == "Выйти из комнаты" }.performClick()
    idle()
    assertNull(RoomVoice.state)
    assertTrue(room.texts.contains("Зайти"))
    assertEquals("комната · трое внутри", room.shownStatus)
  }

  @Test fun musicForEveryone() {
    launch("music")
    snap("58-room-music")
    val line = all(page).filterIsInstance<RoomMusicLine>().single()
    assertEquals(listOf("Night Drive", "включил Лариса · играет у всех"), texts(line))
    // Only the one who leads turns it off.
    assertFalse(texts(line).contains("Выключить"))
  }

  @Test fun theRingOverTheChats() {
    launch("ring")
    snap("59-room-ring")
    val banner = host!!.banner
    assertEquals(View.VISIBLE, banner.visibility)
    assertEquals(listOf("Лариса Орлова", "зовёт в комнату · один внутри"), listOf(banner.shownName, banner.shownLine))
    assertTrue(banner.width > 0)
    all(banner).first { it.contentDescription == "Не сейчас" }.performClick()
    idle()
    assertNull(Rooms.ring)
    assertNull(host)
  }

  @Test fun theBarOfARoomWhoseScreenIsClosed() {
    launch("bar")
    snap("60-room-bar")
    val bar = host!!.bar
    assertEquals(View.VISIBLE, bar.visibility)
    assertEquals(listOf("Голосовая связь", "Походники · Комната · 4 внутри", "Выключить микрофон"), listOf(bar.shownHeading, bar.shownLine, bar.micWords))
    // The pages start lower by the bar's height.
    val d = activity.resources.displayMetrics.density
    assertEquals(Math.round((RoomBarView.TALL + 6f) * d), (stack.layoutParams as ViewGroup.MarginLayoutParams).topMargin)
    assertEquals(Math.round(48f * d), bar.height)
    all(bar).first { it.contentDescription == "Выключить микрофон" }.performClick()
    idle()
    assertEquals(listOf(true, "Включить микрофон"), listOf(RoomVoice.state?.muted, host!!.bar.micWords))
    // A tap opens the room; its own screen takes the bar's place.
    all(bar).first { it.contentDescription == "Комната Походники" }.performClick()
    idle()
    assertEquals("Походники", room.shownName)
    assertTrue(host?.bar?.visibility != View.VISIBLE)
    assertEquals(0, (stack.layoutParams as ViewGroup.MarginLayoutParams).topMargin)
    // Back: the bar comes back.
    stack.pop(animated = false)
    idle()
    assertEquals(View.VISIBLE, host!!.bar.visibility)
    // «Отключиться»: out of the room, the bar goes and the pages go back up.
    all(host!!.bar).first { it.contentDescription == "Отключиться" }.performClick()
    idle()
    assertNull(RoomVoice.state)
    assertNull(host)
    assertEquals(0, (stack.layoutParams as ViewGroup.MarginLayoutParams).topMargin)
    assertEquals(0f, RoomOverlay.room, 0f)
  }

  @Test fun choosingPeopleToCall() {
    launch("picker", wait = 2000)
    val picker = RoomPicker.current
    assertNotNull(picker)
    snap("61-room-picker", picker!!.window!!.decorView)
    assertEquals(listOf("Лариса Орлова", "Тимур Ахметов", "Анна Белова", "Глеб Соколов", "Мира Левина", "Ян Котов", "Зоя Никитина"), picker.shownPeople)
    assertEquals(listOf(3, "Звонок · 3", "Выбрано: 3"), listOf(picker.chosenCount, picker.callWords, picker.countWords))
    assertTrue(texts(picker.window!!.decorView).containsAll(listOf("Чаты", "Отмена", "Звонок · 3")))
  }

  @Test fun outsideTheRoomAndWhenItIsGone() {
    launch("outside")
    snap("57b-room-outside")
    assertEquals("Лариса, Тимур", room.shownName)
    assertEquals("комната · один внутри", room.shownStatus)
    assertEquals(emptyList<String>(), room.buttons)
    assertTrue(room.texts.containsAll(listOf("Позвать всех", "Зайти")))

    launch("gone")
    snap("57c-room-gone")
    assertEquals("Комната", room.shownName)
    assertEquals(listOf("Этой комнаты больше нет.", "Назад"), room.texts)
  }

  @Test fun theRoomsActions() {
    launch("menu", wait = 2500)
    val sheet = ShadowDialog.getLatestDialog() as? ChoiceSheet
    assertNotNull(sheet)
    assertEquals("Походники", sheet!!.heading)
    assertEquals(listOf("Переименовать", "Уйти из комнаты насовсем"), sheet.choices.map { it.label })
    assertEquals("Она пропадёт из твоего списка. Остальные останутся.", sheet.choices[1].note)
  }

  @Test fun theRowsOfTheListAreTheirOwnKind() {
    launch("list")
    val rows = all(page).filterIsInstance<RoomRowView>()
    val d = activity.resources.displayMetrics.density
    assertEquals(Math.round(86f * d), rows[0].height)
    assertEquals(Math.round(64f * d), rows[4].height)
  }
}
