package com.linea.messenger

import android.os.Handler
import android.os.Looper
import com.linea.messenger.chatactions.ChatActivityWords
import com.linea.messenger.chatactions.ChatTyping
import com.linea.messenger.chatactions.activityDotted
import com.linea.messenger.net.ActivitySend
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/** What people are doing in a chat: the words of every kind, alone and in a group, how long a mark lasts, and what
 *  the sending side says and repeats. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatActivityTest {
  private var now = 1_000_000L

  @Before fun setUp() {
    ChatTyping.clear()
    ChatTyping.clock = { now }
    ChatTyping.timer = Handler(Looper.getMainLooper())
  }

  @After fun tearDown() {
    ChatTyping.clear()
    ChatTyping.clock = { android.os.SystemClock.elapsedRealtime() }
    ChatTyping.timer = null
  }

  @Test fun theWordsOfEveryKind() {
    val one = mapOf(
      "typing" to "печатает", "voice" to "записывает голосовое", "round" to "записывает видеосообщение",
      "video" to "отправляет видео", "photo" to "отправляет фото", "file" to "отправляет файл",
      "voice-upload" to "отправляет голосовое", "round-upload" to "отправляет видеосообщение",
    )
    assertEquals(one.keys, ChatActivityWords.kinds)
    for ((kind, words) in one) {
      assertEquals(words, ChatActivityWords.label(listOf("Аня" to kind), group = false))
      assertEquals("Аня $words", ChatActivityWords.label(listOf("Аня" to kind), group = true))
    }
    // An unknown or missing kind (another version of the app) is plain typing.
    assertEquals("печатает", ChatActivityWords.label(listOf("Аня" to "dance"), group = false))
    assertEquals("typing", ChatActivityWords.known(null))
    assertNull(ChatActivityWords.label(emptyList(), group = true))
    // A row of the list starts with a capital letter.
    assertEquals("Записывает голосовое", ChatActivityWords.line("записывает голосовое"))
  }

  @Test fun aGroupNamesThePeople() {
    assertEquals("Аня и Лев печатают", ChatActivityWords.label(listOf("Аня" to "typing", "Лев" to "typing"), group = true))
    assertEquals("Аня и Лев записывают голосовое", ChatActivityWords.label(listOf("Аня" to "voice", "Лев" to "voice"), group = true))
    assertEquals("Аня и Лев отправляют видеосообщение", ChatActivityWords.label(listOf("Аня" to "round-upload", "Лев" to "round-upload"), group = true))
    assertEquals("3 человека печатают", ChatActivityWords.label(listOf("Аня" to "typing", "Лев" to "typing", "Ира" to "typing"), group = true))
    assertEquals("5 человек отправляют фото", ChatActivityWords.label((1..5).map { "П$it" to "photo" }, group = true))
    // Different actions: the newest one is said, with the people doing it.
    assertEquals("Лев записывает видеосообщение", ChatActivityWords.label(listOf("Лев" to "round", "Аня" to "typing"), group = true))
    assertEquals("Аня и Ира печатают", ChatActivityWords.label(listOf("Аня" to "typing", "Лев" to "voice", "Ира" to "typing"), group = true))
    // No name known: the action alone, or the count.
    assertEquals("Печатает", ChatActivityWords.label(listOf(null to "typing"), group = true))
    assertEquals("2 человека печатают", ChatActivityWords.label(listOf(null to "typing", "Лев" to "typing"), group = true))
    assertEquals(listOf("человек", "человека", "человека", "человек", "человек", "человек", "человека"),
      listOf(1, 2, 4, 5, 11, 12, 22).map { ChatActivityWords.people(it) })
  }

  @Test fun noEmojiInTheWords() {
    val all = ChatActivityWords.kinds.flatMap { kind -> listOf(ChatActivityWords.label(listOf("А" to kind), false)!!, ChatActivityWords.label(listOf("А" to kind, "Б" to kind), true)!!) }
    for (words in all) assertTrue(words, words.all { it.code < 0x2000 })
  }

  @Test fun theDotsKeepTheirRoom() {
    for (lit in 0..3) assertEquals("печатает...", activityDotted("печатает", lit).toString())
    assertEquals(listOf(0, 1, 2, 3, 0), listOf(0L, 350L, 700L, 1050L, 1400L).map { ChatActivityWords.dots(it) })
  }

  @Test fun aMarkGoesByItselfWithoutARefresh() {
    ChatTyping.heard("c", "anya", "voice", true)
    assertEquals("записывает голосовое", ChatTyping.words("c", group = false) { null })
    now += 4000
    // Heard again: it lasts another six seconds from now.
    ChatTyping.heard("c", "anya", "voice", true)
    now += 5000
    assertTrue(ChatTyping.isTyping("c"))
    now += 1001
    assertFalse("not heard for six seconds: gone", ChatTyping.isTyping("c"))
    assertNull(ChatTyping.words("c", group = false) { null })
  }

  @Test fun theExpiryIsToldToTheScreens() {
    val told = ArrayList<String?>()
    val watcher: (String?) -> Unit = { told.add(it) }
    ChatTyping.changed.watch(watcher)
    try {
      ChatTyping.heard("c", "anya", "typing", true)
      assertEquals(listOf<String?>("c"), told)
      now += ChatTyping.HOLD + 200
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ChatTyping.HOLD + 200))
      assertEquals(listOf<String?>("c", "c"), told)
      assertFalse(ChatTyping.isTyping("c"))
    } finally { ChatTyping.changed.unwatch(watcher) }
  }

  @Test fun aStopClearsEverythingThePersonDid() {
    ChatTyping.heard("c", "anya", "typing", true)
    ChatTyping.heard("c", "anya", "video", true)
    // One action per person: the newer one replaces the older.
    assertEquals(listOf("anya" to "video"), ChatTyping.who("c"))
    ChatTyping.heard("c", "lev", "voice", true)
    now += 10
    ChatTyping.heard("c", "ira", "typing", true)
    assertEquals(listOf("ira", "lev", "anya"), ChatTyping.who("c").map { it.first })
    ChatTyping.heard("c", "anya", "video", false)
    assertEquals(listOf("ira", "lev"), ChatTyping.who("c").map { it.first })
    val names = mapOf("ira" to "Ира", "lev" to "Лев")
    assertEquals("Ира печатает", ChatTyping.words("c", group = true) { names[it] })
    ChatTyping.heard("c", "ira", "typing", false)
    ChatTyping.heard("c", "lev", "typing", false)
    assertFalse(ChatTyping.isTyping("c"))
  }

  // The sending side

  private class Said(val chatId: String, val on: Boolean, val kind: String, val progress: Int?) {
    override fun toString() = "$chatId:$on:$kind:${progress ?: ""}"
  }

  @Test fun anActionIsRepeatedWhileItLastsAndStoppedOnce() {
    val said = ArrayList<String>()
    var allowed = true
    val send = ActivitySend({ chatId, on, kind, progress -> said.add(Said(chatId, on, kind, progress).toString()) }, { allowed }, Handler(Looper.getMainLooper()))
    val looper = shadowOf(Looper.getMainLooper())
    val voice = send.begin("c", "voice")
    assertEquals(listOf("c:true:voice:"), said)
    looper.idleFor(Duration.ofMillis(ActivitySend.REPEAT))
    looper.idleFor(Duration.ofMillis(ActivitySend.REPEAT))
    assertEquals(listOf("c:true:voice:", "c:true:voice:", "c:true:voice:"), said)
    // Sent: the voice message uploads, with its percent; then the recording ends.
    val upload = send.begin("c", "voice-upload")
    voice.end()
    upload.progress(40)
    looper.idleFor(Duration.ofMillis(ActivitySend.REPEAT))
    assertEquals(listOf("c:true:voice-upload:", "c:true:voice-upload:", "c:true:voice-upload:40"), said.drop(3))
    upload.end()
    upload.end()
    assertEquals("c:false:typing:", said.last())
    val count = said.size
    looper.idleFor(Duration.ofMillis(3 * ActivitySend.REPEAT))
    assertEquals("nothing is said after the stop", count, said.size)
    // Recording has no percent.
    val round = send.begin("c", "round")
    round.progress(50)
    looper.idleFor(Duration.ofMillis(ActivitySend.REPEAT))
    assertEquals("c:true:round:", said.last())
    // The chat is left: one stop for everything in it.
    send.begin("c", "typing")
    said.clear()
    send.endChat("c")
    assertTrue(round.ended)
    assertEquals(listOf("c:false:typing:"), said)
    // «Показывать «печатает…»» off: nothing is said, only the stop (which tells nothing new).
    allowed = false
    said.clear()
    val quiet = send.begin("d", "file")
    looper.idleFor(Duration.ofMillis(ActivitySend.REPEAT))
    quiet.end()
    assertEquals(listOf("d:false:typing:"), said)
  }

  @Test fun theAppLeavingTheScreenStopsAndComesBack() {
    val said = ArrayList<String>()
    val send = ActivitySend({ chatId, on, kind, progress -> said.add(Said(chatId, on, kind, progress).toString()) }, { true }, Handler(Looper.getMainLooper()))
    val looper = shadowOf(Looper.getMainLooper())
    val photo = send.begin("c", "photo")
    send.pause()
    assertEquals("c:false:typing:", said.last())
    val count = said.size
    looper.idleFor(Duration.ofMillis(2 * ActivitySend.REPEAT))
    assertEquals(count, said.size)
    photo.progress(70)
    send.resume()
    assertEquals("c:true:photo:70", said.last())
  }
}
