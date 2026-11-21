package com.linea.messenger

import android.content.Intent
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.design.orbPair
import com.linea.messenger.shell.RootScreen

/** Made-up chats and messages for looking at the app while there is no account behind it yet, and the launch
 *  arguments of the emulator check. This file is in the debug source set: a release build is compiled with the
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

  /** For the emulator check, as the launch arguments of the iOS app: `--es tab profile` opens a section at once,
   *  `--ez sections true` opens the list of sections, `--ez chat true` opens a chat. */
  fun launch(intent: Intent?, root: RootScreen, openChat: (name: String) -> Unit) {
    if (intent == null) return
    if (intent.getBooleanExtra("chat", false)) openChat("Алиса Воронцова")
    intent.getStringExtra("tab")?.let { root.show(it) }
    if (intent.getBooleanExtra("sections", false)) root.postDelayed({ root.showSections() }, 1500)
  }
}
