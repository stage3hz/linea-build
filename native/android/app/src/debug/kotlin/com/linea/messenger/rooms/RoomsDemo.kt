package com.linea.messenger.rooms

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.app.Launcher
import com.linea.messenger.people.Person
import com.linea.messenger.people.pages
import com.linea.messenger.shell.RootScreen
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/** Sample people and rooms for the emulator check (no account, no server, no media). Debug builds only: the release
 *  build has an empty `RoomsDemo` of its own. */
object RoomsDemo {
  val me = Person("demo-me", "nativetester", "Стейдж", "", "", 0x4F8FD9, "")

  private val people = listOf(
    Triple("demo-r1", "Лариса Орлова", "#E0A23B"), Triple("demo-r2", "Тимур Ахметов", "#3FA9A0"), Triple("demo-r3", "Анна Белова", "#5B8DEF"),
    Triple("demo-r4", "Глеб Соколов", "#58B368"), Triple("demo-r5", "Мира Левина", "#E07A5F"), Triple("demo-r6", "Ян Котов", "#7C8A99"), Triple("demo-r7", "Зоя Никитина", "#C9A227"),
  )

  private fun member(index: Int): Map<String, Any?> {
    val person = people[index]
    return mapOf("id" to person.first, "username" to "user${index + 1}", "displayName" to person.second, "avatarColor" to person.third, "avatarId" to null)
  }

  private val mine: Map<String, Any?> = mapOf("id" to me.id, "username" to me.username, "displayName" to me.displayName, "avatarColor" to "#4F8FD9", "avatarId" to null)

  private fun inside(userId: String, muted: Boolean): Map<String, Any?> = mapOf("userId" to userId, "muted" to muted)

  private fun stamp(agoSeconds: Long): String = Instant.now().minusSeconds(agoSeconds).toString()

  /** Five rooms: two with people inside, one that has just emptied, one asleep since yesterday, one never used. */
  fun rooms(): List<Map<String, Any?>> {
    val zone = ZoneId.systemDefault()
    val yesterday = Instant.now().atZone(zone).toLocalDate().minusDays(1).atTime(LocalTime.of(18, 20)).atZone(zone).toInstant().toString()
    return listOf(
      mapOf("id" to "demo-room-1", "name" to "Походники", "auto" to false, "members" to listOf(mine, member(0), member(1), member(2), member(3), member(4)),
        "inside" to listOf(inside("demo-r1", false), inside("demo-r2", true), inside("demo-r3", false)), "awake" to true, "lastActiveAt" to stamp(40), "createdAt" to stamp(30 * 86_400)),
      mapOf("id" to "demo-room-2", "name" to "Лариса, Тимур", "auto" to true, "members" to listOf(mine, member(0), member(1)),
        "inside" to listOf(inside("demo-r1", false)), "awake" to true, "lastActiveAt" to stamp(600), "createdAt" to stamp(12 * 86_400)),
      mapOf("id" to "demo-room-3", "name" to "Семья", "auto" to false, "members" to listOf(mine, member(5), member(6)),
        "inside" to emptyList<Any?>(), "awake" to true, "lastActiveAt" to stamp(120), "createdAt" to stamp(60 * 86_400)),
      mapOf("id" to "demo-room-4", "name" to "Глеб, Мира и ещё 2", "auto" to true, "members" to listOf(mine, member(3), member(4), member(5), member(6)),
        "inside" to emptyList<Any?>(), "awake" to false, "lastActiveAt" to yesterday, "createdAt" to stamp(20 * 86_400)),
      mapOf("id" to "demo-room-5", "name" to "Работа", "auto" to false, "members" to listOf(mine, member(2), member(5)),
        "inside" to emptyList<Any?>(), "awake" to false, "lastActiveAt" to null, "createdAt" to stamp(3 * 86_400)),
    )
  }

  fun ring(): Map<String, Any?> = mapOf("roomId" to "demo-room-2", "name" to "Лариса, Тимур", "from" to member(0), "at" to RoomRules.nowMs)

  /** This phone «inside» the first room: three others around it, one of them talking, one with the microphone off. */
  fun walkIn() {
    val peers = listOf(RoomVoicePeer("peer-1", "demo-r1", muted = false, connected = true), RoomVoicePeer("peer-2", "demo-r2", muted = true, connected = true),
      RoomVoicePeer("peer-3", "demo-r3", muted = false, connected = true))
    RoomVoice.showDemo("demo-room-1", "Походники", peers, muted = false, speaking = setOf("demo-r1"))
  }

  fun pickerChoices(): List<RoomPicker.Choice> = people.indices.mapNotNull { index -> Person.from(member(index))?.let { RoomPicker.Choice("demo-chat-$index", it) } }
}

/** What the emulator check asks of rooms by launch arguments (debug builds only; see `Demo.start`):
 *    --es roomsdemo list      no account, no server: «Каналы» with «КОМНАТЫ» on top — two lit cards (people inside,
 *                             «трое внутри», «Зайти»), a room that has just emptied («никого · ещё не спит»), one asleep
 *                             («спит · были вчера в 18:20») and one never used; the green dot of «Каналы» in the bar's list
 *    --es roomsdemo empty     the same section without rooms: the dashed card that says how a room is made
 *    --es roomsdemo room      this phone inside «Походники»: the glass bar («комната · четверо внутри»), this account in
 *                             the middle, three people around it with their lights (one with the green ring of talking,
 *                             one with the crossed microphone), two members dim (not inside), «Позвать всех», the
 *                             loudspeaker, the microphone and the red way out
 *    --es roomsdemo outside   the screen of a room this phone is not inside: one person lit, «Позвать всех» and «Зайти»
 *    --es roomsdemo ring      «зовёт в комнату · один внутри» over the chats, with «Не сейчас» and «Зайти» (silent here)
 *    --es roomsdemo bar       inside the room, its screen closed: the glass strip «Голосовая связь» under the status bar
 *                             over the chats, with the microphone and the red button
 *    --es roomsdemo music     as `room`, with «включил Лариса · играет у всех» above «Позвать всех»
 *    --es roomsdemo menu | rename   the room's actions («Переименовать», «Уйти из комнаты насовсем»), the form of its name
 *    --es roomsdemo gone      «Этой комнаты больше нет.» with «Назад»
 *    --es roomsdemo picker    «Выбрать»: the people of the chats, three marked, «Звонок · 3»
 *    --es rooms list|room|enter|picker    with an account: «Каналы» with the rooms on top, the first room (not inside:
 *                             «Зайти»; `enter` presses it — the microphone has to be allowed beforehand), «Выбрать»
 *                             over the chats with the first two people marked */
object RoomsSimulator {
  private val main = Handler(Looper.getMainLooper())

  /** True when `roomsdemo` decided the start. */
  fun demo(intent: Intent, launcher: Launcher): Boolean {
    val demo = intent.getStringExtra("roomsdemo") ?: return false
    val root = launcher.showDemo()
    Rooms.showDemo(RoomsDemo.me, if (demo == "empty") emptyList() else RoomsDemo.rooms(), if (demo == "ring") RoomsDemo.ring() else null)
    val stack = root.pages()
    when (demo) {
      "ring" -> {}
      "bar" -> RoomsDemo.walkIn()
      "picker" -> main.postDelayed({
        val picker = RoomPicker(root.context, null, "")
        picker.show()
        picker.emulatorChoose(3)
      }, 800)
      "room", "video", "music", "menu", "rename" -> {
        root.show("channels")
        RoomsDemo.walkIn()
        val screen = RoomScreen(root.context, "demo-room-1")
        stack?.push(screen, animated = false)
        if (demo == "music") RoomMusic.showDemo("peer-1", mapOf("id" to "audius:demo", "source" to "audius", "title" to "Night Drive", "artist" to "Северный ветер", "duration" to 214))
        if (demo == "menu" || demo == "rename") main.postDelayed({ screen.emulatorShow(demo) }, 1000)
      }
      "outside" -> { root.show("channels"); stack?.push(RoomScreen(root.context, "demo-room-2"), animated = false) }
      "gone" -> { root.show("channels"); stack?.push(RoomScreen(root.context, "demo-room-none"), animated = false) }
      else -> root.show("channels")
    }
    RoomOverlay.refresh()
    return true
  }

  /** With an account: waits for the shell (the sign-in of the same launch may still be going) and for the list of
   *  rooms, then opens what was asked. */
  fun later(intent: Intent, launcher: Launcher) {
    val wanted = intent.getStringExtra("rooms") ?: return
    val page = (launcher as? Activity)?.window?.decorView ?: return
    var tries = 60
    val look = object : Runnable {
      override fun run() {
        tries -= 1
        if (tries <= 0) return
        val root = find(page)
        if (root == null) { page.postDelayed(this, 1000); return }
        if (wanted == "picker") {
          val messenger = Rooms.account ?: return
          val picker = RoomPicker(root.context, messenger, "")
          picker.show()
          page.postDelayed({ picker.emulatorChoose(2) }, 4000)
          return
        }
        root.show("channels")
        if (wanted != "room" && wanted != "enter") return
        val first = Rooms.rooms?.firstOrNull()
        if (first == null) { page.postDelayed(this, 1000); return }
        RoomRouter.open(first.id)
        if (wanted == "enter") Rooms.enter(first) { }
      }
    }
    page.postDelayed(look, 1000)
  }

  private fun find(view: View): RootScreen? {
    if (view is RootScreen) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
    return null
  }
}
