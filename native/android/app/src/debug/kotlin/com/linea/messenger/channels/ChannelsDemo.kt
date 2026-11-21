package com.linea.messenger.channels

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.app.Launcher
import com.linea.messenger.people.Person
import com.linea.messenger.people.pages
import com.linea.messenger.shell.RootScreen
import java.time.Instant

/** Made-up communities for looking at «Каналы» on the emulator while there is no account behind it.
 *  This file is in the debug source set: a release build is compiled with the empty `ChannelsDemo` of
 *  src/release instead and contains none of this. */
object ChannelsDemo {
  const val present = true

  private class Sample(val id: String, val name: String, val username: String, val color: Int)
  private val people = listOf(
    Sample("demo-u0", "Алиса Воронцова", "alisa_v", 0x5E7BFF),
    Sample("demo-u1", "Дмитрий Орлов", "orlov", 0xF2A33C),
    Sample("demo-u2", "Лев", "lev_m", 0x4FB86A),
    Sample("demo-u3", "Марина Ким", "marina.kim", 0xF26B5E),
    Sample("demo-u4", "Саша", "sasha", 0x3CA7F2),
  )
  private const val me = "demo-me"

  fun summaries(): List<CommunitySummary> = listOf(
    CommunitySummary("demo-server", "server", "", false, "Клан «Север»", "Собираемся по вечерам. Новичкам — в #общий.", "", "demo-u0",
      128, true, Perm.invite or Perm.send or Perm.voice, "Лев: го в восемь, я создам лобби", false, 14, 1),
    CommunitySummary("demo-server-2", "server", "", true, "Ночная смена", "", "", "demo-u1", 7, true, Perm.send or Perm.voice, "", true, 0, 0),
    CommunitySummary("demo-blog", "blog", "blog", false, "Заметки Стейджа", "Короткие заметки о сборке и дизайне.", "", "demo-u3",
      12480, true, Perm.invite, "Собрали новую версию: что внутри", false, 2, 0),
    CommunitySummary("demo-blog-2", "blog", "music", false, "Винил по пятницам", "", "", "demo-u4", 342, true, Perm.invite, "", true, 31, 0),
  )

  /** Channels: `--es channelsdemo voice|voicemenu` — the sample server as seen by a moderator, with three people in
   *  «Общий»: this phone (inside), Лев (his own microphone off) and Марина (microphone and sound turned off by a moderator). */
  var voice = false

  fun community(id: String): Community? {
    val found = plainCommunity(id) ?: return null
    if (!voice || found.blog) return found
    val base = found.summary
    val members = listOf(CommunityVoiceMember(me, false, false, false), CommunityVoiceMember("demo-u2", true, false, false), CommunityVoiceMember("demo-u3", false, true, true))
    return found.copy(summary = base.copy(perms = base.perms or Perm.muteMembers or Perm.deafenMembers or Perm.kick or Perm.ban)).withVoice("$id-voice", members)
  }

  private fun plainCommunity(id: String): Community? {
    val summary = summaries().firstOrNull { it.id == id } ?: return null
    val everyone = CommunityRole("demo-role-all", if (summary.blog) "Подписчики" else "Участники", "#8A9BB8", 0, Perm.invite or Perm.send or Perm.voice, true)
    val moderator = CommunityRole("demo-role-mod", "Модератор", "#3FA9F5", 10, Perm.manageMessages or Perm.kick or Perm.ban, false)
    val veteran = CommunityRole("demo-role-vet", "Ветераны", "#F5C542", 5, Perm.send or Perm.voice, false)
    if (summary.blog) {
      return Community(summary, listOf(everyone), emptyList(), listOf(CommunityChannel("$id-posts", "text", "Публикации", "", "", 0, emptyList(), 0, summary.unread, 0)))
    }
    val channels = listOf(
      CommunityChannel("$id-general", "text", "общий", "Обо всём", "Текстовые каналы", 0, emptyList(), 0, 12, 1),
      CommunityChannel("$id-news", "text", "новости", "", "Текстовые каналы", 1, emptyList(), 0, 2, 0),
      CommunityChannel("$id-staff", "text", "штаб", "", "Текстовые каналы", 2, listOf("demo-role-mod"), 0, 0, 0),
      CommunityChannel("$id-voice", "voice", "Общий", "", "Голосовые каналы", 0, emptyList(), 2, 0, 0),
      CommunityChannel("$id-game", "voice", "Игра", "", "Голосовые каналы", 1, emptyList(), 0, 0, 0),
    )
    return Community(summary, listOf(moderator, veteran, everyone), emptyList(), channels)
  }

  fun members(): List<CommunityMember> = people.mapIndexed { index, person ->
    CommunityMember(Person(person.id, person.username, person.name, "", "", person.color, ""), if (index == 1) listOf("demo-role-mod") else if (index == 2) listOf("demo-role-vet") else emptyList(), index == 0)
  }

  /** A drawn picture (no photo of anyone). */
  private fun picture(): Bitmap {
    val made = Bitmap.createBitmap(960, 720, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(made)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, 960f, 720f, 0xFF16316A.toInt(), 0xFF2EE6C8.toInt(), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, 960f, 720f, paint)
    paint.shader = null
    paint.color = 0xD9FFFFFF.toInt()
    canvas.drawCircle(705f, 215f, 105f, paint)
    return made
  }

  /** The sample channel's messages: about two hundred of mixed lengths — runs by one author, answers,
   *  reactions, a picture, a file, an edited one, an invitation, a mention of the reader. */
  fun messages(blog: Boolean, now: Instant = Instant.now()): List<CommunityMessage> {
    val short = listOf("Привет!", "Ок", "😂😂😂", "Го вечером?", "Я за", "Кто создаёт лобби?", "Сейчас буду", "Минуту", "Ну ты даёшь", "+", "Давай в восемь")
    val long = listOf(
      "Скинул расписание на неделю: во вторник и четверг тренируемся с восьми, в субботу турнир — начало в полдень, собираемся за полчаса, чтобы проверить связь и состав.",
      "По вчерашней игре: первую половину держались отлично, потом рассыпались на ротациях. Предлагаю в следующий раз заранее договориться, кто закрывает центр, и не менять это на ходу — иначе опять будем бегать втроём в одну точку.",
      "Список на закупку:\n— гарнитура для Саши\n— коврик\n— переходник",
      "Подробности тут: https://example.com/turnir и ещё на www.example.org, пиши @alisa_v, если что-то не открывается.",
    )
    val messages = ArrayList<CommunityMessage>()
    var moment = now.minusSeconds(3L * 24 * 3600)
    var id = 1000L
    val total = if (blog) 14 else 200
    for (index in 0 until total) {
      id += 1
      // Runs of several messages by one author, then the next author; a new day now and then.
      val author = if (blog) people[3].id else if (index % 23 == 9) me else people[(index / 4) % people.size].id
      moment = moment.plusSeconds(if (index % 4 == 0) (600 + (index % 7) * 900).toLong() else 40L)
      var text = if (index % 9 == 4) long[(index / 9) % long.size] else short[index % short.size]
      if (blog) text = long[index % long.size]
      var attachment: CommunityMessage.Attachment? = null
      val reactions = ArrayList<CommunityMessage.Reaction>()
      var answers = 0L
      if (index == total - 12) {
        attachment = CommunityMessage.Attachment("demo-picture", "photo.png", "image/png", 482_113)
        text = if (blog) "Собрали новую версию: что внутри" else "Вид из окна штаба"
      }
      if (index == total - 30 && !blog) attachment = CommunityMessage.Attachment("demo-file", "Регламент турнира.pdf", "application/pdf", 1_843_200)
      if (index % 11 == 3) { reactions.add(CommunityMessage.Reaction("👍", 4, listOf(me))); reactions.add(CommunityMessage.Reaction("🔥", 2, emptyList())) }
      if (index % 17 == 6) reactions.add(CommunityMessage.Reaction("😂", 12, emptyList()))
      if (!blog && index % 13 == 7 && index > 3) answers = id - 3
      if (!blog && index == total - 6) text = "@nativetester глянь регламент, пожалуйста"
      if (!blog && index == total - 9) text = "Заходите к соседям: https://api.invizent.com/i/Ab3dEf9h"
      messages.add(CommunityMessage(id, "", author, text, attachment, answers, moment.toString(), index % 29 == 5, reactions))
    }
    return messages
  }

  fun fill(engine: ChannelEngine, blog: Boolean) {
    ChannelImages.putSample(picture(), "demo-picture")
    val authors = HashMap<String, ChannelAuthor>()
    for (person in people) authors[person.id] = ChannelAuthor(person.name, person.username, "", person.color)
    authors[me] = ChannelAuthor("Ты", "nativetester", "", 0x8A8F98)
    val blogSummary = summaries()[2]
    val card = ChannelInviteCard(2, "Ab3dEf9h", blogSummary.id, true, false, blogSummary.name, "", "Блог · " + blogSummary.countWords, false)
    engine.demo(messages(blog), authors, mapOf("demo-u1" to 0x3FA9F5, "demo-u2" to 0xF5C542), mapOf("Ab3dEf9h" to card), me, "nativetester")
  }
}

/** What the emulator check asks of «Каналы» by launch arguments (see `Demo.start`), as the iOS simulator check does:
 *    --es channelsdemo 1           no account, no server: the section's root with sample communities
 *    --es channelsdemo community   a sample game server: its channels in groups, counters, a locked channel
 *    --es channelsdemo blog        a sample blog channel: its posts as cards
 *    --es channelsdemo chat        a sample channel's chat: about 200 messages of mixed lengths
 *    --es channelsdemo menu        the same chat with the menu of its newest message (reactions and actions)
 *    --es channelsdemo settings    the settings of the sample server (as a member without special rights)
 *    --es tab channels             with an account (or --ez demo true): the section's root
 *    --es channels community       with an account: opens the first community of the list
 *    --es channels chat            with an account: the first community, then its first text channel
 *    --es channels create | join   with an account: «Что создаём?» / «Вступить по ссылке» */
object ChannelsSimulator {
  /** True when `channelsdemo` decided the start. */
  fun demo(intent: Intent, launcher: Launcher): Boolean {
    val demo = intent.getStringExtra("channelsdemo") ?: return false
    val root = launcher.showDemo()
    root.show("channels")
    val stack = root.pages() ?: return true
    val context = root.context
    if (demo == "voice" || demo == "voicemenu") {
      // Channels: inside «Общий» of the sample server (channels/CommunityVoice.kt).
      ChannelsDemo.voice = true
      val peers = listOf(com.linea.messenger.rooms.RoomVoicePeer("peer-2", "demo-u2", muted = true, connected = true),
        com.linea.messenger.rooms.RoomVoicePeer("peer-3", "demo-u3", muted = false, connected = true, serverMuted = true, serverDeafened = true))
      com.linea.messenger.rooms.RoomVoice.showDemo("demo-server-voice", "Общий", peers, muted = false, speaking = emptySet(), community = "demo-server" to "Клан «Север»")
      val screen = CommunityScreen(context, null, "demo-server", ChannelsDemo.summaries().firstOrNull { it.id == "demo-server" })
      stack.push(screen, animated = false)
      if (demo == "voicemenu") root.postDelayed({ screen.emulatorVoiceMenu() }, 1500)
    } else if (demo == "community" || demo == "blog") {
      val id = if (demo == "blog") "demo-blog" else "demo-server"
      stack.push(CommunityScreen(context, null, id, ChannelsDemo.summaries().firstOrNull { it.id == id }), animated = false)
    } else if (demo == "chat" || demo == "menu") {
      val community = ChannelsDemo.community("demo-server") ?: return true
      val chat = ChannelChatScreen(context, null, community, community.channels.first(), root = false)
      stack.push(chat, animated = false)
      if (demo == "menu") {
        // The rows are made on the chat's worker: tried until they are there.
        var tries = 20
        val open = object : Runnable { override fun run() { tries -= 1; if (!chat.emulatorMenu() && tries > 0) root.postDelayed(this, 500) } }
        root.postDelayed(open, 2000)
      }
    } else if (demo == "settings") {
      ChannelsDemo.community("demo-server")?.let { stack.push(CommunitySettingsPage(context, null, it), animated = false) }
    }
    return true
  }

  /** With an account: waits for the shell (the sign-in of the same launch may still be going), then opens. */
  fun later(intent: Intent, launcher: Launcher) {
    val wanted = intent.getStringExtra("channels") ?: return
    val page = (launcher as? Activity)?.window?.decorView ?: return
    var tries = 60
    val look = object : Runnable {
      override fun run() {
        tries -= 1
        if (tries <= 0) return
        val root = find(page)
        if (root == null) { page.postDelayed(this, 1000); return }
        root.show("channels")
        val section = root.channelsPage() ?: return
        if (wanted == "create" || wanted == "join") return section.emulatorForm(wanted)
        if (wanted != "community" && wanted != "chat") return
        // The list is read from the server: tried until it is there.
        val stack = root.pages() ?: return
        val top = stack.top
        if (top is CommunityScreen) {
          if (wanted == "chat" && !top.openFirstChannel()) page.postDelayed(this, 1000)
          return
        }
        if (stack.depth == 1 && section.openFirst() != null && wanted == "community") return
        page.postDelayed(this, 1000)
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
