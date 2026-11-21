package com.linea.messenger

import com.linea.messenger.channels.ChannelAuthor
import com.linea.messenger.channels.ChannelCategory
import com.linea.messenger.channels.ChannelContext
import com.linea.messenger.channels.ChannelPixels
import com.linea.messenger.channels.ChannelInviteCard
import com.linea.messenger.channels.ChannelLink
import com.linea.messenger.channels.ChannelOutbox
import com.linea.messenger.channels.ChannelRowMaker
import com.linea.messenger.channels.ChannelUpload
import com.linea.messenger.channels.ChannelWords
import com.linea.messenger.channels.ChannelsScreen
import com.linea.messenger.channels.ChannelsStore
import com.linea.messenger.channels.Community
import com.linea.messenger.channels.CommunityBansPage
import com.linea.messenger.channels.CommunityCell
import com.linea.messenger.channels.CommunityMember
import com.linea.messenger.channels.CommunityMessage
import com.linea.messenger.channels.CommunitySummary
import com.linea.messenger.channels.InvitePreview
import com.linea.messenger.channels.MemberRow
import com.linea.messenger.channels.Perm
import com.linea.messenger.channels.RoleEditPage
import com.linea.messenger.channels.channelFilePath
import com.linea.messenger.net.ServerError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** The rules and the words of «Каналы», as the iPhone app has them (native/ios/Sources/Channels). */
class ChannelsRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")

  private fun summary(id: String, kind: String = "server", unread: Int = 0, mentions: Int = 0, muted: Boolean = false, last: String = "", about: String = "", count: Int = 5) =
    CommunitySummary(id, kind, if (kind == "blog") "music" else "", false, "Имя $id", about, "", "owner", count, true, Perm.send, last, muted, unread, mentions)

  private fun message(id: Long, sender: String, text: String, at: String, reply: Long = 0, channel: String = "c1") =
    CommunityMessage(id, channel, sender, text, null, reply, at, false, emptyList())

  @Test fun countsAreWordedAsInTheReference() {
    assertEquals("1 участник", ChannelWords.members(1))
    assertEquals("3 участника", ChannelWords.members(3))
    assertEquals("12 участников", ChannelWords.members(12))
    assertEquals("21 подписчик", ChannelWords.subscribers(21))
    assertEquals("1 234 подписчика", ChannelWords.subscribers(1234))
    assertEquals("12,4 тыс. подписчиков", ChannelWords.subscribers(12480))
    assertEquals("1,2 млн участников", ChannelWords.members(1_250_000))
    assertEquals("1 005", ChannelWords.compactCount(1005))
    assertEquals("0 участников", ChannelWords.members(-4))
  }

  @Test fun badgesAreExactUpToAThousand() {
    assertEquals("", ChannelWords.badge(0))
    assertEquals("999", ChannelWords.badge(999))
    assertEquals("1K", ChannelWords.badge(1000))
    assertEquals("4,3K", ChannelWords.badge(4321))
    assertEquals("12K", ChannelWords.badge(12_900))
    assertEquals("1,2M", ChannelWords.badge(1_250_000))
  }

  @Test fun sizesInitialsAndColours() {
    assertEquals("512 Б", ChannelWords.fileSize(512))
    assertEquals("471 КБ", ChannelWords.fileSize(482_113))
    assertEquals("1.8 МБ", ChannelWords.fileSize(1_843_200))
    assertEquals("2.0 ГБ", ChannelWords.fileSize(2L * 1024 * 1024 * 1024))
    assertEquals("К«", ChannelWords.initials("Клан «Север»"))
    assertEquals("ЗС", ChannelWords.initials("заметки  стейджа"))
    assertEquals("#", ChannelWords.initials("   "))
    // The same id always gets the same pair, and it is one of the six.
    assertEquals(ChannelWords.gradient("demo-server"), ChannelWords.gradient("demo-server"))
    assertEquals(Pair(0x2C5BD6, 0x1AA889), ChannelWords.gradient(""))
    // 'a' = 97; 97 % 6 = 1.
    assertEquals(Pair(0x3FA9F5, 0x0D3480), ChannelWords.gradient("a"))
  }

  @Test fun inviteLinksAreKnownOnlyOnTheAppsOwnAddresses() {
    assertEquals("Ab3dEf9h", ChannelWords.inviteCode("Заходите: https://api.invizent.com/i/Ab3dEf9h"))
    assertEquals("Ab3dEf9h", ChannelWords.inviteCode("https://invizent.com/i/Ab3dEf9h."))
    assertEquals("Ab3dEf9h", ChannelWords.inviteCode("(invizent://invite/Ab3dEf9h)"))
    assertEquals("Ab3dEf9h", ChannelWords.inviteCode("linea://invite/Ab3dEf9h"))
    assertNull(ChannelWords.inviteCode("https://evil.example/i/Ab3dEf9h"))
    assertNull(ChannelWords.inviteCode("https://api.invizent.com.evil.example/i/Ab3dEf9h"))
    assertNull(ChannelWords.inviteCode("xhttps://api.invizent.com/i/Ab3dEf9h"))
    assertNull(ChannelWords.inviteCode("https://api.invizent.com/i/abc"))
    assertNull(ChannelWords.inviteCode("https://api.invizent.com/i/Ab3dEf9hAb3dEf9hX"))
    assertEquals("Ab3dEf9h", ChannelWords.typedInviteCode("  Ab3dEf9h \n"))
    assertEquals("Ab3dEf9h", ChannelWords.typedInviteCode("https://api.invizent.com/i/Ab3dEf9h"))
    assertNull(ChannelWords.typedInviteCode("не код"))
    assertEquals("Заходите к соседям:", ChannelWords.withoutInviteLink("Заходите к соседям: https://api.invizent.com/i/Ab3dEf9h"))
    assertEquals("раз\n\nдва", ChannelWords.withoutInviteLink("раз  \n\n\n https://invizent.com/i/Ab3dEf9h\n\nдва"))
  }

  @Test fun aMentionIsANameStandingOnItsOwn() {
    assertTrue(ChannelWords.mentions("@NativeTester глянь", "nativetester"))
    assertTrue(ChannelWords.mentions("эй, @nativetester!", "nativetester"))
    assertFalse(ChannelWords.mentions("почта a@nativetester", "nativetester"))
    assertFalse(ChannelWords.mentions("@nativetester2", "nativetester"))
    assertFalse(ChannelWords.mentions("@@nativetester", "nativetester"))
    assertFalse(ChannelWords.mentions("привет", "nativetester"))
    assertFalse(ChannelWords.mentions("@nativetester", ""))
  }

  @Test fun theServersAnswersAreRead() {
    val raw = mapOf(
      "id" to "s1", "kind" to "blog", "category" to "news", "closed" to true, "name" to "Новости", "description" to "о разном", "avatarId" to "f1", "ownerId" to "u1",
      "memberCount" to 3.0, "perms" to 144.0, "lastMessage" to mapOf("text" to "привет"), "muted" to true, "unreadCount" to 7.0, "mentionCount" to 2.0,
      "roles" to listOf(mapOf("id" to "r0", "name" to "все", "isDefault" to true, "perms" to 32.0), mapOf("id" to "r1", "name" to "Модератор", "color" to "#3FA9F5", "position" to 10.0),
        mapOf("id" to "r2", "name" to "Ветераны", "color" to "#F5C542", "position" to 5.0)),
      "myRoleIds" to listOf("r1"),
      "channels" to listOf(mapOf("id" to "c1", "name" to "общий"), mapOf("id" to "v1", "kind" to "voice", "name" to "Игра", "voice" to listOf("u1", "u2")),
        mapOf("id" to "c2", "name" to "штаб", "category" to "Свои", "roleIds" to listOf("r1"), "unread" to 4.0, "mentions" to 1.0), mapOf("id" to "c3", "name" to "мемы")),
    )
    val community = Community.from(raw)!!
    assertTrue(community.blog)
    assertTrue(community.summary.closed && community.summary.muted && community.summary.isMember)
    assertEquals("привет", community.summary.lastText)
    assertEquals("3 подписчика", community.summary.countWords)
    assertTrue(community.can(Perm.post) && community.can(Perm.invite) && !community.can(Perm.send))
    assertEquals(listOf("Текстовые каналы", "Голосовые каналы", "Свои"), community.groups.map { it.name })
    assertEquals(listOf("c1", "c3"), community.groups[0].channels.map { it.id })
    assertEquals(2, community.channels[1].voiceCount)
    assertFalse(community.channels[1].isText)
    assertEquals(listOf("r1"), community.channels[2].roleIds)
    // The highest role that is not «everyone» gives the colour of a name.
    assertEquals(0x3FA9F5, community.nameColor(listOf("r2", "r1", "r0")))
    assertEquals(0xF5C542, community.nameColor(listOf("r2")))
    assertNull(community.nameColor(listOf("r0")))
    assertEquals(0xFF8A9BB8.toInt(), community.roles[0].color)
    assertNull(CommunitySummary.from(mapOf("name" to "без id")))
    // An invitation's preview does not say «member» inside the community: the summary then reads as one.
    val preview = InvitePreview.from(mapOf("code" to "Ab3dEf9h", "community" to mapOf("id" to "s2", "name" to "Клан", "memberCount" to 12.0), "isMember" to false))!!
    assertFalse(preview.isMember)
    assertEquals("Игровой · 12 участников", ChannelInviteCard.known(preview, "Ab3dEf9h").details)
    assertEquals("Новости", ChannelCategory.label("news"))
    assertEquals("Канал", ChannelCategory.label("unknown"))

    val message = CommunityMessage.from(mapOf("id" to 41.0, "channelId" to "c1", "senderId" to "u1", "text" to "смотри", "replyTo" to 40.0, "createdAt" to "2026-11-21T07:00:00.000Z", "editedAt" to "2026-11-21T07:01:00.000Z",
      "attachment" to mapOf("id" to "f9", "name" to "a.pdf", "mimeType" to "application/pdf", "size" to 2048.0),
      "reactions" to listOf(mapOf("emoji" to "👍", "count" to 2.0, "userIds" to listOf("u1", "me")), mapOf("emoji" to ""))))!!
    assertEquals(41L, message.id); assertEquals(40L, message.replyTo); assertTrue(message.edited)
    assertEquals(CommunityMessage.Attachment("f9", "a.pdf", "application/pdf", 2048), message.attachment)
    assertEquals(listOf(CommunityMessage.Reaction("👍", 2, listOf("u1", "me"))), message.reactions)
    assertNull(CommunityMessage.from(mapOf("text" to "без id")))
    assertNull(CommunityMessage.from(mapOf("id" to 1.0, "attachment" to mapOf("id" to "")))!!.attachment)
    val member = CommunityMember.from(mapOf("user" to mapOf("id" to "u1", "username" to "orlov", "displayName" to "Дмитрий"), "roleIds" to listOf("r1", "r2"), "owner" to true))!!
    assertEquals("Модератор, Ветераны", MemberRow.words(member, community))
    assertEquals("@orlov", MemberRow.words(CommunityMember(member.user, emptyList(), false), community))
  }

  @Test fun aRowIsMadeFromAMessageAndWhatStandsAroundIt() {
    val context = ChannelContext().apply { meId = "me"; meUsername = "nativetester"; ownerId = "u1" }
    context.authors["u1"] = ChannelAuthor("Алиса Воронцова", "alisa_v", "pic", 0x5E7BFF)
    context.authors["me"] = ChannelAuthor("Ты", "nativetester", "", 0x8A8F98)
    context.roleColors = mapOf("u1" to 0x3FA9F5)
    val maker = ChannelRowMaker(moscow) { text ->
      val at = text.indexOf("https://")
      if (at < 0) null else mapOf("text" to text, "fmt" to listOf(64.0, at.toDouble(), (text.length - at).toDouble()), "urls" to listOf(text.substring(at)))
    }
    val first = message(1, "u1", "Привет!", "2026-11-20T20:58:00.000Z")
    val second = message(2, "u1", "Смотри https://example.com/a", "2026-11-20T20:59:30.000Z")
    val late = message(3, "u1", "Ещё тут?", "2026-11-20T21:07:00.000Z")
    val mine = message(4, "me", "Да", "2026-11-20T21:08:00.000Z")
    val answer = message(5, "u2", "@nativetester глянь", "2026-11-20T21:09:00Z", reply = 4)

    val one = maker.row(first, null, null, context)
    assertEquals("20 ноября", one.day); assertEquals("23:58", one.time)
    assertTrue(one.header && one.owner && !one.forMe)
    assertEquals("Алиса Воронцова", one.author); assertEquals("АВ", one.initials); assertEquals(0x3FA9F5, one.authorColor); assertEquals("pic", one.avatarId)
    // The same author within seven minutes: no header, no date.
    val two = maker.row(second, first, null, context)
    assertFalse(two.header); assertEquals("", two.day)
    assertEquals(listOf(ChannelLink(7, 21, "https://example.com/a")), two.links)
    // Midnight in Moscow passed between them: a new day, and a header again (more than seven minutes).
    val three = maker.row(late, second, null, context)
    assertEquals("21 ноября", three.day); assertTrue(three.header)
    assertTrue(maker.row(mine, late, null, context).header)
    // An unknown author, a mention of the reader and an answer to them.
    val five = maker.row(answer, mine, mine, context)
    assertEquals("Участник", five.author); assertEquals("", five.initials); assertNull(five.authorColor)
    assertTrue(five.forMe && five.hasReply); assertEquals("Ты", five.replyAuthor); assertEquals("Да", five.replyText)
    // The message it answers is not loaded: no quote.
    assertFalse(maker.row(answer, mine, null, context).hasReply)
    // The reader's own messages never stand out.
    assertFalse(maker.row(message(6, "me", "@nativetester", "2026-11-20T21:10:00Z"), null, null, context).forMe)
    // A blog shows every post with its own header; an invite link becomes a banner and leaves the text.
    context.blog = true
    val post = maker.row(message(7, "u1", "Заходите: https://api.invizent.com/i/Ab3dEf9h", "2026-11-20T21:11:00Z"), mine, null, context)
    assertTrue(post.blog && post.header); assertEquals("Заходите:", post.text)
    assertEquals(ChannelInviteCard.loading("Ab3dEf9h"), post.invite)
    val file = CommunityMessage(8, "c1", "u1", "", CommunityMessage.Attachment("f", "v.mp4", "video/mp4", 5), 0, "нет", false, listOf(CommunityMessage.Reaction("🔥", 3, listOf("me"))))
    val attached = maker.row(file, null, null, context)
    assertEquals(3, attached.attachKind); assertEquals("5 Б", attached.attachSize); assertEquals("", attached.time)
    assertTrue(attached.chips.single().mine)
  }

  @Test fun theStoreCountsWhatIsUnread() {
    val store = ChannelsStore
    store.reset("me")
    assertNull(store.list)
    store.took(listOf(summary("s1", unread = 3, mentions = 1), summary("s2", unread = 9, mentions = 2, muted = true), summary("b1", "blog")))
    // A muted community counts only its @mentions.
    assertEquals(3 + 2, store.badge)
    store.setChannels("s1", Community.from(mapOf("id" to "s1", "channels" to listOf(mapOf("id" to "c1", "unread" to 3.0, "mentions" to 1.0), mapOf("id" to "v1", "kind" to "voice"))))!!.channels)
    assertEquals(3, store.channel("c1").unread)
    assertEquals(0, store.channel("v1").unread)
    fun arrived(sender: String, channel: String = "c1", edited: Boolean = false, mentions: List<String> = emptyList()) =
      store.event(mapOf("type" to "community.message", "communityId" to "s1", "edited" to edited, "mentions" to mentions, "message" to mapOf("id" to 9.0, "channelId" to channel, "senderId" to sender, "text" to "новое")))
    arrived("u1", mentions = listOf("me"))
    assertEquals(4, store.community("s1").unread); assertEquals(2, store.community("s1").mentions)
    assertEquals(4, store.channel("c1").unread); assertEquals(2, store.channel("c1").mentions)
    assertEquals("новое", store.list!!.first { it.id == "s1" }.lastText)
    // One's own message, an edit, and a message of the channel on screen count nothing.
    arrived("me"); arrived("u1", edited = true)
    store.setViewing("c1"); arrived("u1"); store.setViewing("")
    assertEquals(4, store.community("s1").unread)
    // The server's word about what was read.
    store.event(mapOf("type" to "community.read", "communityId" to "s1", "channelId" to "c1", "unread" to 0.0, "mentions" to 0.0,
      "community" to mapOf("id" to "s1", "unreadCount" to 0.0, "mentionCount" to 0.0)))
    assertEquals(0, store.channel("c1").unread); assertEquals(0, store.community("s1").unread)
    assertEquals(2, store.badge)
    // A community read from the server replaces its row; a new one goes first; one left goes away with its channels.
    store.event(mapOf("type" to "community", "community" to mapOf("id" to "s9", "name" to "Новый", "unreadCount" to 1.0)))
    assertEquals(listOf("s9", "s1", "s2", "b1"), store.list!!.map { it.id })
    store.event(mapOf("type" to "community", "community" to mapOf("id" to "s2", "isMember" to false)))
    store.event(mapOf("type" to "community.removed", "communityId" to "s1"))
    assertEquals(listOf("s9", "b1"), store.list!!.map { it.id })
    assertEquals(0, store.channel("c1").unread)
    assertEquals(1, store.badge)
    store.reset("")
  }

  @Test fun theListOfCommunitiesHasItsParts() {
    val rows = ChannelsScreen.rows(listOf(summary("b1", "blog"), summary("s1"), summary("s2")))
    assertEquals(listOf("Игровые серверы", "", "", "Каналы", ""), rows.map { it.first })
    assertEquals(listOf(null, "s1", "s2", null, "b1"), rows.map { it.second?.id })
    assertEquals(emptyList<Any>(), ChannelsScreen.rows(emptyList()))
    assertEquals("го в восемь", CommunityCell.line(summary("s1", last = "го\nв восемь", about = "о нас")))
    assertEquals("о нас", CommunityCell.line(summary("s1", about = "о нас")))
    assertEquals("5 участников", CommunityCell.line(summary("s1")))
  }

  @Test fun whatWaitsForAConnectionGoesOutInOrder() {
    val outbox = ChannelOutbox
    outbox.start(null)
    val sent = ArrayList<String>()
    var answer: (ChannelOutbox.Item) -> Result<Map<String, Any?>> = { Result.failure(ServerError.Network("нет")) }
    outbox.sender = { item, done -> sent.add(item.text); done(answer(item)) }
    val changes = ArrayList<ChannelOutbox.Change>()
    val watcher: (ChannelOutbox.Change) -> Unit = { changes.add(it) }
    outbox.changed.watch(watcher)
    fun item(key: String, text: String) = ChannelOutbox.Item(key, "s1", "c1", text, 0)
    assertTrue(outbox.add(item("k1", "раз"))); assertTrue(outbox.add(item("k2", "два"))); assertTrue(outbox.add(item("k3", "три")))
    // No answer: the first stays, the others are not tried.
    outbox.flush()
    assertEquals(listOf("раз"), sent); assertEquals(3, outbox.waiting.size)
    // The line is back: the first goes, the second is refused for good, the third is told «later».
    answer = { item -> when (item.key) {
      "k1" -> Result.success(mapOf("message" to mapOf("id" to 5.0)))
      "k2" -> Result.failure(ServerError.Refused("Нельзя писать.", 403, null, emptyMap()))
      else -> Result.failure(ServerError.Refused("Слишком часто.", 429, null, emptyMap()))
    } }
    sent.clear()
    com.linea.messenger.net.Live.communityEvent.post(mapOf("type" to "ready"))
    assertEquals(listOf("раз", "два", "три"), sent)
    assertEquals(listOf("k3"), outbox.waiting.map { it.key })
    assertEquals(listOf("Нельзя писать."), outbox.refused.map { it.words })
    assertEquals(mapOf("id" to 5.0), changes.first { it.message != null }.message)
    // A refused one is tried again as a new message; a waiting one can be cancelled.
    outbox.retry("k2")
    assertEquals(0, outbox.refused.size); assertEquals(2, outbox.waiting.size)
    assertTrue(outbox.waiting.none { it.key == "k2" })
    outbox.cancel("k3")
    assertEquals(listOf("два"), outbox.waiting.map { it.text })
    assertTrue(ChannelOutbox.forGood(404)); assertFalse(ChannelOutbox.forGood(401)); assertFalse(ChannelOutbox.forGood(408)); assertFalse(ChannelOutbox.forGood(500))
    outbox.waiting.clear()
    repeat(ChannelOutbox.limit) { assertTrue(outbox.add(item("m$it", "x"))) }
    assertFalse(outbox.add(item("over", "x")))
    outbox.changed.unwatch(watcher)
    outbox.start(null)
  }

  @Test fun anUploadIsOneMultipartBodyAsTheReferenceMakesIt() {
    val body = String(ChannelUpload.body("DATA".toByteArray(), "мой \"файл\"\r\n.png", "image/png", "----invizentabc"), Charsets.UTF_8)
    assertEquals("------invizentabc\r\nContent-Disposition: form-data; name=\"file\"; filename=\"мой _файл___.png\"\r\nContent-Type: image/png\r\n\r\nDATA\r\n------invizentabc--\r\n", body)
    assertEquals("application/octet-stream", ChannelUpload.safeType("image/png\r\nX: y"))
    assertEquals("file", ChannelUpload.safeName(""))
    assertEquals(200, ChannelUpload.safeName("я".repeat(300)).length)
    assertEquals("/files/a%2Fb%20c", channelFilePath("a/b c"))
  }

  @Test fun aPictureIsDecodedAtTheSizeItIsShownAt() {
    assertEquals(Pair(360, 270), ChannelPixels.fit(4000, 3000, 360))
    assertEquals(Pair(200, 100), ChannelPixels.fit(200, 100, 360))
    assertEquals(Pair(1, 360), ChannelPixels.fit(2, 4000, 360))
    // The largest power of two that keeps the longer side at least as long as wanted.
    assertEquals(8, ChannelPixels.sample(4000, 3000, 360))
    assertEquals(1, ChannelPixels.sample(500, 400, 360))
    assertEquals(2, ChannelPixels.sample(720, 100, 360))
    assertEquals(540, ChannelPixels.pixels(360f, 270f))
  }

  @Test fun theRightsOfARoleDependOnTheKindOfCommunity() {
    val server = RoleEditPage.rights(blog = false, owner = false).map { it.label }
    assertTrue(server.containsAll(listOf("Писать в каналах", "Голосовые каналы", "Управлять каналами")))
    assertFalse(server.contains("Публиковать посты")); assertFalse(server.contains("Администратор (все права)"))
    val blog = RoleEditPage.rights(blog = true, owner = true).map { it.label }
    assertEquals(listOf("Публиковать посты", "Приглашать по ссылке", "Удалять чужие сообщения", "Исключать участников", "Блокировать участников", "Управлять ролями", "Менять название и фото", "Администратор (все права)"), blog)
    assertEquals("Нажми, чтобы разблокировать", CommunityBansPage.banWords(""))
    assertEquals("Причина: спам · нажми, чтобы разблокировать", CommunityBansPage.banWords("спам"))
    assertEquals(13, Perm.labels.size); assertEquals(10, ChannelCategory.all.size)
    assertEquals(listOf("👍", "❤️", "😂", "😮", "😢", "🔥", "👎"), ChannelWords.quickReactions)
  }
}
