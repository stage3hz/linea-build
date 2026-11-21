package com.linea.messenger

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Launcher
import com.linea.messenger.attachments.AttachmentsDemo
import com.linea.messenger.channels.ChannelsSimulator
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.design.orbPair
import com.linea.messenger.people.PeopleSimulator

/** Made-up chats and messages for looking at the app with no account behind it, and the launch arguments of
 *  the emulator check. This file is in the debug source set: a release build is compiled with the
 *  empty `Demo` of src/release instead and contains none of this. */
object Demo {
  private class Person(val title: String, val preview: String, val time: String, val color: Int, val unread: Int, val muted: Boolean, val pinned: Boolean, val ticks: Int, val section: String)

  fun chats(): List<ChatRow> {
    val people = listOf(
      Person("Алиса Воронцова", "Тогда до завтра, я принесу распечатки", "09:38", 0x5E7BFF, 2, false, true, 0, "Закреплённые"),
      Person("Команда запуска", "Игорь: сборка прошла, смотрю снимки", "09:12", 0x34C3A0, 14, false, false, 0, "Сегодня"),
      Person("Мама", "Позвони, как освободишься", "08:47", 0xE86F9B, 0, false, false, 2, ""),
      Person("Дмитрий Орлов", "Голосовое сообщение", "08:05", 0xF2A33C, 0, false, false, 1, ""),
      Person("Книжный клуб", "Вера: в четверг обсуждаем третью главу", "Вчера", 0x9B6BF2, 131, true, false, 0, "Вчера"),
      Person("Саша", "Ок", "Вчера", 0x3CA7F2, 0, false, false, 2, ""),
      Person("Поддержка", "Спасибо, вопрос решён", "Пн", 0x7A8699, 0, false, false, 0, "Раньше"),
      Person("Марина Ким", "Фото", "Пн", 0xF26B5E, 0, false, false, 0, ""),
      Person("Лев", "Пришли адрес ещё раз, пожалуйста", "12.11", 0x4FB86A, 0, false, false, 2, ""),
    )
    return ChatRow.parse(people.mapIndexed { index, person ->
      val orb = orbPair(person.color)
      val initials = person.title.split(" ").take(2).mapNotNull { it.firstOrNull() }.joinToString("")
      mapOf(
        "id" to "demo-$index", "title" to person.title, "preview" to person.preview, "time" to person.time, "unread" to person.unread,
        "muted" to person.muted, "pinned" to person.pinned, "ticks" to person.ticks,
        "avatarColor" to (0xFF000000.toInt() or person.color), "initials" to initials, "orbA" to orb.first, "orbB" to orb.second, "section" to person.section,
        "previewIcon" to if (person.preview == "Голосовое сообщение") "mic" else "",
      )
    })
  }

  fun messages(): List<MsgRow> {
    val said = listOf(
      Triple(false, "Привет! Ты завтра будешь на встрече?", "09:12"),
      Triple(true, "Привет. Да, к десяти подойду", "09:14"),
      Triple(false, "Отлично. Я подготовила короткий план — три пункта, должно уложиться в полчаса, если никто не уйдёт в детали", "09:15"),
      Triple(true, "Хорошо", "09:15"),
      Triple(true, "Распечатки нужны или хватит экрана?", "09:16"),
      Triple(false, "Лучше распечатки, там таблица", "09:30"),
      Triple(false, "Тогда до завтра, я принесу распечатки", "09:38"),
    )
    val rows = ArrayList<Map<String, Any?>>()
    rows.add(mapOf("key" to "day", "kind" to 1, "text" to "Сегодня"))
    said.forEachIndexed { index, line ->
      val last = index + 1 == said.size || said[index + 1].first != line.first
      rows.add(mapOf("key" to "m$index", "kind" to 0, "mine" to line.first, "text" to line.second, "time" to line.third, "ticks" to (if (line.first) 2 else 0), "tail" to last))
    }
    return MsgRow.parse(rows)
  }

  /** "Sending" while there is nothing to send with: the text joins the rows as the user's own message. */
  val send: ((rows: List<MsgRow>, text: String) -> List<MsgRow>)? = { rows, text ->
    rows + MsgRow.parse(listOf(mapOf("key" to "local-${rows.size}", "kind" to 0, "mine" to true, "text" to text, "time" to "09:41", "ticks" to 1, "tail" to true)))
  }

  /** The local test server a launch argument pointed this debug build at (`--es server https://10.0.2.2:8443`):
   *  only the emulator's own host or this device itself, only HTTPS. Null = the real server. */
  var testServer: String? = null
    private set

  private val local = Regex("^https://(10\\.0\\.2\\.2|localhost):[0-9]{1,5}$")

  /** `--es authmode register|recover|waiting|reset` (with `--ez auth true`): the step the sign-in screen opens
   *  at. `waiting` and `reset` show those two steps with a made-up request: no server is asked, nothing is kept. */
  var authMode: String? = null
    private set
  /** The login of that made-up request. */
  const val authLogin = "nativetester"

  /** The person «Настройки» shows when there is no account behind the shell (`--ez demo true`). */
  fun settingsPerson(): Map<String, Any?> = mapOf("displayName" to "Мария Орлова", "username" to "maria", "avatarColor" to "#9271C3")

  /** `--es settings <page>`: opens «Настройки» and one of its pages as soon as the shell is on the screen (after
   *  the sign-in of the same launch, when there is one). */
  private fun openSettings(launcher: Launcher, page: String, tries: Int = 60) {
    Handler(Looper.getMainLooper()).postDelayed({ if (!launcher.openSettings(page) && tries > 1) openSettings(launcher, page, tries - 1) }, 1000)
  }

  /** What the emulator check asks for by launch arguments, as the iOS simulator check does. True when one of
   *  them decided the start.
   *    --es server https://10.0.2.2:8443           the local test server (kept for this launch only)
   *    --ez auth true                              the sign-in screen
   *    --es authmode register|recover|waiting|reset    with auth: that step of the sign-in screen
   *    --es settings root|profile|username|birthday|privacy|lastseen|security|password|confirmation|recovery|sessions|session|blocked|delete|about
   *                                                «Настройки» and one of its pages, with an account (root and about: also with demo)
   *    --ez demo true                              the shell with sample chats (no account)
   *    --es tab profile / --ez sections true / --ez chat true    with demo: a section, the list of sections, the sample chat
   *    --es login … --es password … --es word …    signs in, to the test server given by `server` only
   *    --ez openchat true                          with an account: opens the first chat of the list
   *    --es tab people / --es peoplesearch … / --es profile friend|chat    «Люди» and a profile (people/PeopleDemo.kt)
   *    --es channelsdemo 1|community|blog|chat|menu|settings / --es channels community|chat|create|join    «Каналы» (channels/ChannelsDemo.kt)
   *    --es attachdemo 1|viewer / --es openattachment photo|file           attachments (attachments/AttachmentsDemo.kt) */
  fun start(intent: Intent?, launcher: Launcher): Boolean {
    if (intent == null) return false
    testServer = intent.getStringExtra("server")?.takeIf { local.matches(it) }
    AttachmentsDemo.read(intent)
    authMode = intent.getStringExtra("authmode")
    if (intent.getBooleanExtra("auth", false)) { launcher.showAuth(); return true }
    intent.getStringExtra("settings")?.let { openSettings(launcher, it) }
    if (ChannelsSimulator.demo(intent, launcher)) return true
    if (intent.getBooleanExtra("demo", false)) {
      val root = launcher.showDemo()
      if (intent.getBooleanExtra("chat", false)) launcher.openChat(ChatTarget("Алиса Воронцова"), animated = false)
      intent.getStringExtra("tab")?.let { root.show(it) }
      PeopleSimulator.run(intent, launcher, root)
      if (intent.getBooleanExtra("sections", false)) root.postDelayed({ root.showSections() }, 1500)
      return true
    }
    val login = intent.getStringExtra("login"); val password = intent.getStringExtra("password")
    if (login != null && password != null && testServer != null) {
      launcher.signIn(login, password, intent.getStringExtra("word") ?: "")
      return true
    }
    if (intent.getBooleanExtra("openchat", false)) {
      Handler(Looper.getMainLooper()).postDelayed({ launcher.openFirstChat() }, 6000)
    }
    PeopleSimulator.later(intent, launcher)
    ChannelsSimulator.later(intent, launcher)
    return false
  }
}
