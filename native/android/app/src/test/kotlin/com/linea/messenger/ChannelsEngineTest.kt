package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.channels.ChannelChatScreen
import com.linea.messenger.channels.ChannelEngine
import com.linea.messenger.channels.ChannelHit
import com.linea.messenger.channels.ChannelListView
import com.linea.messenger.channels.ChannelPaints
import com.linea.messenger.channels.ChannelPatch
import com.linea.messenger.channels.ChannelPiece
import com.linea.messenger.channels.ChannelRow
import com.linea.messenger.channels.ChannelRowLayout
import com.linea.messenger.channels.ChannelRowMaker
import com.linea.messenger.channels.ChannelRowView
import com.linea.messenger.channels.ChannelsDemo
import com.linea.messenger.channels.CommunityMessage
import com.linea.messenger.channels.ChannelLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.ZoneId
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/** The work behind a channel's chat and its pages, on the JVM (Robolectric with its native drawing): the engine
 *  hands the list one row per event, pages of older rows and never the whole list for one message; the rows are
 *  laid out without the main thread; every launch argument of «Каналы» opens what it should, and each page is
 *  saved as a picture in build/pages/ to be looked at. Not a phone: no server, no blur behind the glass. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChannelsEngineTest {
  private val asked = ArrayList<Pair<String, List<Any?>>>()
  private val answers = HashMap<String, (List<Any?>) -> Result<Any?>>()
  private val patches = ArrayList<ChannelPatch>()
  private val incoming = ArrayList<Long>()
  private var loadedWith: Pair<String, Long>? = null

  private fun raw(id: Long, sender: String = "u1", text: String = "Сообщение $id", minute: Long = id, reply: Long? = null): Map<String, Any?> = linkedMapOf(
    "id" to id.toDouble(), "channelId" to "c1", "senderId" to sender, "text" to text, "replyTo" to reply?.toDouble(),
    "createdAt" to java.time.Instant.parse("2026-11-20T10:00:00Z").plusSeconds(minute * 600).toString(),
  )

  private fun engine(): ChannelEngine {
    val made = ChannelEngine({ name, args, done -> asked.add(Pair(name, args)); done(answers[name]?.invoke(args) ?: Result.failure(com.linea.messenger.net.ServerError.Network("нет"))) },
      "s1", "c1", blog = false, meId = "me", meUsername = "nativetester", ownerId = "u1", density = 2.625f,
      worker = Executor { it.run() }, toMain = { it() }, maker = ChannelRowMaker(ZoneId.of("Europe/Moscow")) { null })
    made.onPatch = { patches.add(it) }
    made.onIncoming = { incoming.add(it) }
    made.onLoaded = { error, newest -> loadedWith = Pair(error, newest) }
    return made
  }

  @Test fun theEngineHandsTheListSmallFinishedPatches() {
    answers["channelMessages"] = { args ->
      if (args.size == 2) Result.success(mapOf("messages" to (11L..40L).map { raw(it) }, "hasMore" to true, "users" to listOf(mapOf("id" to "u1", "displayName" to "Алиса Воронцова"))))
      else Result.success(mapOf("messages" to (1L..10L).map { raw(it) }, "hasMore" to false))
    }
    val engine = engine()
    engine.load()
    // Nothing is laid out before the width is known; then everything at once, once.
    assertTrue(patches.isEmpty())
    assertEquals(Pair("", 40L), loadedWith)
    engine.setWidth(1080)
    assertEquals(1, patches.size)
    val first = patches.single().reset!!
    assertEquals((11L..40L).toList(), first.map { it.row.id })
    assertTrue(first.all { it.height > 0 && it.width == 1080 })
    assertEquals("Алиса Воронцова", first[0].row.author)
    patches.clear()

    // A message over the live line: ONE new row, nothing else touched, and it is read at once.
    engine.socket(mapOf("type" to "community.message", "communityId" to "s1", "message" to raw(41, sender = "u2", reply = 40)))
    assertEquals(1, patches.size)
    patches.single().let { patch ->
      assertNull(patch.reset); assertEquals(listOf(41L), patch.newest.map { it.row.id })
      assertTrue(patch.updated.isEmpty() && patch.older.isEmpty() && patch.removed.isEmpty() && !patch.own)
      assertTrue(patch.newest[0].row.hasReply)
    }
    assertEquals(listOf(41L), incoming)
    patches.clear()
    // The same message again changes nothing; one of another channel is not this chat's.
    engine.socket(mapOf("type" to "community.message", "communityId" to "s1", "message" to raw(41, sender = "u2", reply = 40)))
    engine.socket(mapOf("type" to "community.message", "communityId" to "s1", "message" to raw(42) + mapOf("channelId" to "other")))
    assertTrue(patches.isEmpty())
    incoming.clear()

    // An edit: the row itself and the row that quotes it — two redrawn rows, no reload.
    engine.socket(mapOf("type" to "community.message", "communityId" to "s1", "edited" to true, "message" to raw(40, text = "Исправлено") + mapOf("editedAt" to "2026-11-21T00:00:00Z")))
    assertEquals(listOf(40L, 41L), patches.single().updated.map { it.row.id })
    assertEquals("Исправлено", patches.single().updated[1].row.replyText)
    // An edit is not a new message: nothing is reported as read.
    assertTrue(incoming.isEmpty())
    patches.clear()

    // The person's own message, as the server answered it: one row, and the list goes to its end.
    engine.put(raw(43, sender = "me"), own = true)
    assertTrue(patches.single().own); assertEquals(listOf(43L), patches.single().newest.map { it.row.id })
    patches.clear()

    // A page of older messages: only those rows, in front; the row that was the oldest loses its date line.
    engine.loadOlder()
    assertEquals(listOf("s1", "c1", 11L), asked.last().second)
    patches.single().let { patch ->
      assertNull(patch.reset); assertEquals((1L..10L).toList(), patch.older.map { it.row.id })
      assertTrue(patch.newest.isEmpty())
      assertEquals(listOf(11L), patch.updated.map { it.row.id })
      assertEquals("", patch.updated[0].row.day)
    }
    patches.clear()
    // No more pages: nothing is asked again.
    val before = asked.size
    engine.loadOlder()
    assertEquals(before, asked.size)

    // A deleted message: one row out; the row after it and the row that quoted it are made again.
    engine.socket(mapOf("type" to "community.message.deleted", "communityId" to "s1", "channelId" to "c1", "messageId" to 40.0))
    assertEquals(listOf(40L), patches.single().removed)
    assertEquals(listOf(41L), patches.single().updated.map { it.row.id })
    assertTrue(!patches.single().updated[0].row.hasReply)
    patches.clear()

    // The members became known: only the rows whose look changed are made again (the others keep their layouts).
    engine.setMembers(mapOf("u2" to com.linea.messenger.channels.ChannelAuthor("Лев", "lev_m", "", 0x4FB86A)), mapOf("u2" to 0xF5C542))
    assertEquals(listOf(41L), patches.single().updated.map { it.row.id })
    assertEquals(0xF5C542, patches.single().updated[0].row.authorColor)
    patches.clear()

    // The line came back: what arrived meanwhile is merged in as new rows, not as a new list.
    answers["channelMessages"] = { Result.success(mapOf("messages" to (30L..45L).filter { it != 40L && it != 42L }.map { if (it == 41L) raw(41, sender = "u2") else if (it == 43L) raw(43, sender = "me") else raw(it) }, "hasMore" to true)) }
    engine.load()
    assertEquals(listOf(44L, 45L), patches.flatMap { it.newest }.map { it.row.id })
    assertTrue(patches.all { it.reset == null })
    assertEquals(Pair("", 45L), loadedWith)
    patches.clear()
    // Another width: every row is laid out anew.
    engine.setWidth(720)
    assertEquals(43, patches.single().reset!!.size)
  }

  @Test fun anAuthorsAvatarAndNameLineOpenTheMiniProfile() {
    // The reference (ChannelChat.tsx): the avatar («Профиль <name>», a button) and the whole name line of a run's
    // first message open the mini profile of the author as the server described them (`users`).
    answers["channelMessages"] = { Result.success(mapOf("messages" to (1L..3L).map { raw(it) }, "hasMore" to false,
      "users" to listOf(mapOf("id" to "u1", "displayName" to "Алиса Воронцова", "username" to "alisa_v", "bio" to "Капитан")))) }
    val engine = engine()
    engine.load()
    var found: com.linea.messenger.people.Person? = null
    engine.person("u1") { found = it }
    assertEquals("Алиса Воронцова", found?.displayName)
    assertEquals("Капитан", found?.bio)
    var nobody: com.linea.messenger.people.Person? = com.linea.messenger.people.Person("x", "", "", "", "", 0, "")
    engine.person("u9") { nobody = it }
    assertNull(nobody)
    // A member list and the live line add people too.
    engine.setMembers(emptyMap(), emptyMap(), mapOf("u2" to com.linea.messenger.people.Person("u2", "lev_m", "Лев", "", "", 0x4FB86A, "")))
    engine.socket(mapOf("type" to "community.message", "message" to raw(4, sender = "u3"), "user" to mapOf("id" to "u3", "displayName" to "Марина Ким")))
    engine.person("u2") { found = it }
    assertEquals("Лев", found?.displayName)
    engine.person("u3") { found = it }
    assertEquals("Марина Ким", found?.displayName)

    val paints = ChannelPaints(2.625f)
    val message = CommunityMessage(1, "c1", "u1", "Привет", null, 0, "", false, emptyList())
    val layout = ChannelRowLayout(ChannelRow(1, author = "Алиса Воронцова", initials = "АВ", time = "13:10", text = "Привет", owner = true), message, 1080, paints)
    val face = layout.avatarBox!!
    assertTrue(layout.hit(face.centerX(), face.centerY()) is ChannelHit.Author)
    // The time at the end of the name line is part of the same target.
    val time = layout.pieces.filterIsInstance<ChannelPiece.Text>().first { it.line.text.toString() == "13:10" }
    assertTrue(layout.hit(time.x + time.line.width / 2, time.baseline - 4) is ChannelHit.Author)
    assertEquals("Профиль Алиса Воронцова", ChannelRowView.profileWords(layout))
    // TalkBack: the row offers «Профиль <name>», and it does what the tap does.
    val view = ChannelRowView(org.robolectric.RuntimeEnvironment.getApplication())
    var opened: ChannelRowLayout? = null
    view.onProfile = { opened = it }
    view.show(layout)
    val info = android.view.accessibility.AccessibilityNodeInfo.obtain()
    view.onInitializeAccessibilityNodeInfo(info)
    val action = info.actionList.single { it.label == "Профиль Алиса Воронцова" }
    assertTrue(view.performAccessibilityAction(action.id, null))
    assertSame(layout, opened)
    // A grouped row and a blog post have no avatar to tap (the reference draws none there).
    assertNull(ChannelRowLayout(ChannelRow(2, header = false, text = "Ок", time = "13:11"), message, 1080, paints).avatarBox)
    assertNull(ChannelRowLayout(ChannelRow(3, blog = true, text = "Пост", time = "13:12"), message, 1080, paints).avatarBox)
  }

  @Test fun aTapOnAnAuthorOpensTheirMiniProfileWithWrite() {
    launch("channels-7-mini", "mini", wait = 700) { page -> (find(page, "ChannelListView") as? ChannelListView)?.count == 200 && org.robolectric.shadows.ShadowDialog.getLatestDialog() != null }
    val card = org.robolectric.shadows.ShadowDialog.getLatestDialog()
    assertNotNull(card)
    val shown = texts(card.window!!.decorView)
    // The newest sample message is Саша's: the card with «Написать» (no «Профиль»: the reference passes no onOpenProfile).
    assertTrue(shown.toString(), shown.containsAll(listOf("Саша", "@sasha", "Написать")))
    assertTrue(!shown.contains("Профиль"))
  }

  @Test fun aFailedFirstReadingSaysWhy() {
    val engine = engine()
    engine.setWidth(1080)
    engine.load()
    assertEquals(Pair("нет", 0L), loadedWith)
    assertTrue(patches.isEmpty())
  }

  @Test fun aRowIsLaidOutOnceAndKnowsWhatIsUnderAFinger() {
    val paints = ChannelPaints(2.625f)
    val text = "Подробности тут: https://example.com/turnir — и пиши, если что-то не открывается, я на связи весь вечер."
    val row = ChannelRow(1, day = "20 ноября", author = "Алиса Воронцова", initials = "АВ", time = "13:10", text = text, owner = true,
      links = listOf(ChannelLink(17, 26, "https://example.com/turnir")), attachKind = 2, attachId = "f", attachName = "Регламент.pdf", attachSize = "1.8 МБ",
      chips = listOf(com.linea.messenger.channels.ChannelChip("👍", 4, true), com.linea.messenger.channels.ChannelChip("🔥", 2, false)), forMe = true)
    val message = CommunityMessage(1, "c1", "u1", text, null, 0, "", false, emptyList())
    val layout = ChannelRowLayout(row, message, 1080, paints)
    assertTrue(layout.height > 400)
    val block = layout.pieces.filterIsInstance<ChannelPiece.Block>().single()
    assertTrue(block.layout.lineCount >= 2)
    // The link begins 17 letters in (on the first or, with the app's wider type, the second line): a point inside its
    // fourth letter, on that letter's line.
    val line = block.layout.getLineForOffset(20)
    val x = block.x + (block.layout.getPrimaryHorizontal(20) + block.layout.getPrimaryHorizontal(21)) / 2; val y = block.y + block.layout.getLineBaseline(line) - 5
    assertEquals("https://example.com/turnir", (layout.hit(x, y) as ChannelHit.Link).url)
    assertTrue(layout.hit(block.x + 5, block.y + block.layout.getLineBaseline(0) - 5) is ChannelHit.Row)
    val chip = layout.pieces.filterIsInstance<ChannelPiece.Border>().first().box
    assertEquals("👍", (layout.hit(chip.centerX(), chip.centerY()) as ChannelHit.Chip).emoji)
    val face = layout.pieces.filterIsInstance<ChannelPiece.Avatar>().single().box
    assertTrue(layout.hit(face.centerX(), face.centerY()) is ChannelHit.Author)
    val file = layout.pieces.filterIsInstance<ChannelPiece.Fill>().first { it.box.height() == 60 * 2.625f }.box
    assertTrue(layout.hit(file.centerX(), file.centerY()) is ChannelHit.Attachment)
    assertEquals("Алиса Воронцова. $text. Регламент.pdf. 13:10", layout.spoken)
    // The row's view takes the layout's height as it is and draws it.
    val view = ChannelRowView(org.robolectric.RuntimeEnvironment.getApplication())
    view.show(layout)
    view.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    assertEquals(layout.height, view.measuredHeight)
    view.layout(0, 0, 1080, layout.height)
    val picture = Bitmap.createBitmap(1080, layout.height, Bitmap.Config.ARGB_8888)
    view.draw(Canvas(picture))
    File("build/pages").mkdirs()
    File("build/pages/channels-row.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
    // A grouped row of one short line is far lower than the first.
    val small = ChannelRowLayout(ChannelRow(2, header = false, text = "Ок", time = "13:11"), message, 1080, paints)
    assertTrue(small.height < layout.height / 5)
  }

  // The pages

  private fun find(view: View, className: String): View? {
    if (view.javaClass.simpleName == className) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), className)?.let { return it }
    return null
  }

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view is TextView && view.visibility == View.VISIBLE) into.add(view.text.toString())
    if (view is ViewGroup && view.visibility == View.VISIBLE) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun spoken(view: View, into: MutableList<String> = ArrayList()): List<String> {
    view.contentDescription?.let { into.add(it.toString()) }
    if (view is ViewGroup) for (index in 0 until view.childCount) spoken(view.getChildAt(index), into)
    return into
  }

  /** Opens the app with a launch argument of «Каналы» and waits until `ready` (the chat's rows are made on its worker). */
  private fun launch(name: String, demo: String, wait: Long = 400, ready: (View) -> Boolean = { true }): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("channelsdemo", demo)).setup().get()
    val page = activity.window.decorView
    var turns = 0
    do {
      shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
      if (!ready(page)) Thread.sleep(50)
      turns += 1
    } while (!ready(page) && turns < 100)
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return activity
  }

  @Test fun theSectionShowsTheSampleCommunities() {
    val page = launch("channels-1-root", "1").window.decorView
    assertNotNull(find(page, "ChannelsScreen"))
    val shown = texts(page)
    assertTrue(shown.containsAll(listOf("Каналы", "ИГРОВЫЕ СЕРВЕРЫ", "Клан «Север»", "Лев: го в восемь, я создам лобби", "Ночная смена", "7 участников", "КАНАЛЫ", "Заметки Стейджа", "Винил по пятницам", "342 подписчика", "14", "@", "31")))
    assertTrue(spoken(page).containsAll(listOf("Вступить по ссылке", "Создать", "непрочитанных: 14", "упоминаний: 1")))
  }

  @Test fun aGameServerShowsItsChannelsInGroups() {
    val page = launch("channels-2-community", "community").window.decorView
    assertNotNull(find(page, "CommunityScreen"))
    val shown = texts(page)
    assertTrue(shown.containsAll(listOf("Клан «Север»", "128 участников", "Собираемся по вечерам. Новичкам — в #общий.", "ТЕКСТОВЫЕ КАНАЛЫ", "# общий", "# новости", "# штаб", "ГОЛОСОВЫЕ КАНАЛЫ", "Общий", "2/12", "Игра")))
    val said = spoken(page)
    assertTrue(said.containsAll(listOf("Пригласить", "Настройки", "Текстовый канал общий, непрочитанных: 12, упоминаний: 1", "Голосовой канал Игра")))
  }

  @Test fun aChannelsChatShowsTwoHundredRowsAndStaysAtItsEnd() {
    val activity = launch("channels-3-chat", "chat") { page -> (find(page, "ChannelListView") as? ChannelListView)?.count == 200 }
    val page = activity.window.decorView
    val list = find(page, "ChannelListView") as ChannelListView
    assertEquals(200, list.count)
    assertEquals(ChannelsDemo.messages(false).map { it.id }, list.ids())
    // Only the rows on the screen have views — each ONE view without children — and the newest is among them.
    val rows = ArrayList<ChannelRowView>()
    fun gather(view: View) { if (view is ChannelRowView) rows.add(view) else if (view is ViewGroup) for (index in 0 until view.childCount) gather(view.getChildAt(index)) }
    gather(list)
    assertTrue(rows.size in 3..40)
    assertSame(list.newest, rows.last().layoutInfo)
    assertTrue(rows.all { it.measuredHeight == it.layoutInfo!!.height })
    val shown = texts(page)
    assertTrue(shown.contains("# общий") && shown.contains("Обо всём"))
    val chat = find(page, "ChannelChatScreen") as ChannelChatScreen
    assertNotNull(chat)
    assertTrue(spoken(page).containsAll(listOf("Назад", "Прикрепить", "Отправить", "Написать в #общий")))
  }

  @Test fun theMenuOfAMessageOffersReactionsAndActions() {
    val activity = launch("channels-4-menu", "menu", wait = 700) { page -> (find(page, "ChannelListView") as? ChannelListView)?.count == 200 && find(page, "ChannelMenuView") != null }
    val page = activity.window.decorView
    assertNotNull(find(page, "ChannelMenuView"))
    val said = spoken(page)
    assertTrue(said.containsAll(listOf("Реакция 👍", "Реакция 👎", "Ответить", "Скопировать")))
    // The sample reader may not delete someone else's message, nor change it.
    assertTrue(!said.contains("Удалить") && !said.contains("Изменить"))
  }

  @Test fun aBlogChannelShowsItsPostsAsCards() {
    val activity = launch("channels-5-blog", "blog") { page -> (find(page, "ChannelListView") as? ChannelListView)?.count == 14 }
    val page = activity.window.decorView
    assertNotNull(find(page, "CommunityScreen"))
    val list = find(page, "ChannelListView") as ChannelListView
    assertEquals(14, list.count)
    assertTrue(list.newest!!.row.blog)
    val shown = texts(page)
    assertTrue(shown.containsAll(listOf("Заметки Стейджа", "12,4 тыс. подписчиков", "Публикуют только авторы канала.")))
  }

  @Test fun theSettingsOfACommunityShowWhatAMemberMaySee() {
    val page = launch("channels-6-settings", "settings").window.decorView
    assertNotNull(find(page, "CommunitySettingsPage"))
    val shown = texts(page)
    assertTrue(shown.containsAll(listOf("Настройки", "Игровой", "ПРИГЛАШЕНИЯ", "Ссылка-приглашение", "УЧАСТНИКИ", "Алиса Воронцова 👑", "Дмитрий Орлов", "Модератор", "@lev_m".let { "Ветераны" }, "СООБЩЕСТВО", "Покинуть сервер")))
    // Without the rights, nothing of managing is shown.
    assertTrue(!shown.contains("РОЛИ") && !shown.contains("БЛОКИРОВКИ") && !shown.contains("Сохранить"))
  }
}
