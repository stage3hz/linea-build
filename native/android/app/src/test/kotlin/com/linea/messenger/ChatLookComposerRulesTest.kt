package com.linea.messenger

import com.linea.messenger.chat.MsgRow
import com.linea.messenger.chatactions.ChatForward
import com.linea.messenger.chatactions.ChatHistory
import com.linea.messenger.chatactions.ChatSearchBar
import com.linea.messenger.chatactions.ForwardPicker
import com.linea.messenger.chatlook.ChatLookUnread
import com.linea.messenger.chatlook.LookColor
import com.linea.messenger.chatlook.MsgArrivals
import com.linea.messenger.chatlook.WallpaperChoice
import com.linea.messenger.chatlook.WallpaperFit
import com.linea.messenger.composer.BigEmoji
import com.linea.messenger.composer.ComposeRules
import com.linea.messenger.composer.ScheduleModel
import com.linea.messenger.composer.ScheduledItem
import com.linea.messenger.core.Core
import com.linea.messenger.polls.MsgPoll
import com.linea.messenger.polls.PollRows
import com.linea.messenger.polls.PollText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The pure rules of the chat's look, the composer and the polls (ChatLook, Composer, Polls), as on the iPhone. */
class ChatLookComposerRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")

  @Test fun theColoursOfTheLightAreTheReferences() {
    // brightTint: a dark colour is lifted until its brightest channel reaches the floor, a bright one stays.
    assertEquals(0xFFFFFF, LookColor.bright(0xFFFFFF))
    assertEquals(0x5E7BFF, LookColor.bright(0x5E7BFF))
    val lifted = LookColor.bright(0x102030, 190)
    assertEquals(190, maxOf((lifted shr 16) and 255, (lifted shr 8) and 255, lifted and 255))
    // vividTint: a grey picture has no colour of its own; a coloured one gets a saturated light.
    assertNull(LookColor.vivid(120, 120, 122))
    val vivid = LookColor.vivid(200, 40, 40)!!
    assertTrue(((vivid shr 16) and 255) > (vivid and 255))
    assertEquals(0x2E9E8F, LookColor.hex("#2E9E8F"))
    assertNull(LookColor.hex("2E9E8F"))
  }

  @Test fun aStoredWallpaperIsReadBackOrDropped() {
    val ids = listOf("none", "aurora")
    assertEquals(WallpaperChoice.preset("aurora"), WallpaperChoice.read(mapOf("kind" to "preset", "id" to "aurora"), ids))
    assertNull(WallpaperChoice.read(mapOf("kind" to "preset", "id" to "nothing"), ids))
    assertNull(WallpaperChoice.read(mapOf("kind" to "image", "file" to "../x.jpg"), ids))
    val image = WallpaperChoice.read(mapOf("kind" to "image", "file" to "a.jpg", "dim" to 0.3, "zoom" to 9.0, "aspect" to 1.5, "blur" to true), ids)!!
    assertEquals(0.2, image.dim, 0.0)
    assertEquals(4.0, image.zoom, 0.0)
    assertTrue(image.blur && image.isImage && image.shown)
    // The fit never shows an edge: a picture as wide as the screen cannot move sideways at zoom 1.
    val fitted = WallpaperFit.clamp(1.0, 0.4, 0.0, 400.0 / 800.0, 400.0, 800.0)
    assertEquals(0.0, fitted.second, 0.0001)
    val zoomed = WallpaperFit.clamp(2.0, 0.9, 0.0, 400.0 / 800.0, 400.0, 800.0)
    assertEquals(0.5, zoomed.second, 0.0001)
  }

  @Test fun theUnreadOfOtherChatsLeavesOutMutedOnes() {
    val later = Instant.parse("2026-11-22T10:00:00Z")
    assertTrue(ChatLookUnread.muted(mapOf("muted" to true), later))
    assertTrue(ChatLookUnread.muted(mapOf("muted" to true, "mutedUntil" to "2026-11-23T10:00:00Z"), later))
    assertFalse(ChatLookUnread.muted(mapOf("muted" to true, "mutedUntil" to "2026-11-21T10:00:00Z"), later))
    assertFalse(ChatLookUnread.muted(mapOf("muted" to false), later))
  }

  @Test fun onlyAMessageOrTwoArrivingLiveSlideIn() {
    fun rows(vararg keys: String) = MsgRow.parse(keys.map { mapOf("key" to it, "kind" to 0, "mine" to false, "text" to it) })
    val arrivals = MsgArrivals()
    arrivals.take(rows("a", "b"))
    arrivals.take(rows("a", "b", "c"))
    // A batch of more than three is simply there.
    arrivals.take(rows("a", "b", "c", "d", "e", "f", "g"))
    assertNotNull(arrivals)
  }

  @Test fun theScheduleWordsAndLimits() {
    val now = Instant.parse("2026-11-21T09:10:00Z") // 12:10 in Moscow
    val presets = ScheduleModel.presets(now, moscow)
    assertEquals(listOf("Через час", "Сегодня в 20:00", "Завтра в 09:00"), presets.map { it.first })
    assertEquals("13:10", ScheduleModel.timeLabel(presets[0].second, moscow))
    assertEquals("Сегодня в 20:00", ScheduleModel.formatDeliverAt(presets[1].second, now, moscow))
    assertEquals("Завтра в 09:00", ScheduleModel.formatDeliverAt(presets[2].second, now, moscow))
    assertEquals("3 января 2027 в 10:00", ScheduleModel.formatDeliverAt(Instant.parse("2027-01-03T07:00:00Z"), now, moscow))
    assertEquals("Время уже прошло — выбери хотя бы минуту вперёд.", ScheduleModel.validate(now.plusSeconds(30), now))
    assertEquals("Отложить можно не больше чем на год.", ScheduleModel.validate(now.plusSeconds(366L * 86_400), now))
    assertNull(ScheduleModel.validate(now.plusSeconds(3600), now))
    assertEquals("1 отложенное сообщение", ScheduleModel.countScheduled(1))
    assertEquals("3 отложенных сообщения", ScheduleModel.countScheduled(3))
    assertEquals("11 отложенных сообщений", ScheduleModel.countScheduled(11))
    assertEquals("Чат удалён.", ScheduleModel.failureText("CHAT_GONE"))
    assertEquals(mapOf("silent" to true), ScheduleModel.withSilent(null, true))
    val action = mapOf("action" to mapOf("type" to "react"))
    assertEquals(action, ScheduleModel.withSilent(action, true))
    assertEquals("2026-11-21T09:10:00.000Z", ScheduleModel.iso(now))
    // An item: only a device-set failure with the text here is sent again by itself.
    val item = ScheduledItem.parse(mapOf("id" to "s", "chatId" to "c", "clientId" to "k", "status" to "failed", "failure" to "E2EE_DEVICES_CHANGED"))!!
    assertFalse(item.canResend)
    item.cryptoState = "decrypted"
    assertTrue(item.canResend)
    assertEquals("Отложено с другого устройства", ScheduledItem("s", "c", "k", "", "scheduled", null, "").body)
  }

  @Test fun upToThreeEmojiAloneAreBig() {
    assertEquals(1, BigEmoji.count("🔥"))
    assertEquals(2, BigEmoji.count("🎉🔥"))
    assertEquals(3, BigEmoji.count(" 👍 ❤️ 🐶 "))
    assertEquals(1, BigEmoji.count("❤️‍🔥"))
    assertEquals(0, BigEmoji.count("👍👍👍👍"))
    assertEquals(0, BigEmoji.count("ок 👍"))
    assertEquals(0, BigEmoji.count("1️⃣"))
    assertEquals(0, BigEmoji.count(""))
    assertEquals(112f * 0.86f, BigEmoji.fontSize(1), 0.001f)
    assertEquals(68f, BigEmoji.box(3), 0f)
  }

  @Test fun aLinkAddressIsHttpsOnlyAndShort() {
    assertEquals("https://example.org", ComposeRules.linkAddress(" example.org "))
    assertEquals("http://example.org/a", ComposeRules.linkAddress("http://example.org/a"))
    assertNull(ComposeRules.linkAddress("javascript:alert(1)"))
    assertNull(ComposeRules.linkAddress(""))
    assertNull(ComposeRules.linkAddress("https://" + "a".repeat(2050)))
  }

  @Test fun theFormattingIsTheCores() {
    assumeTrue(Core.loaded)
    val bold = ComposeRules.toggle(emptyList(), "Встреча завтра", 0, 7, "bold")
    assertEquals(listOf(mapOf("type" to "bold", "offset" to 0.0, "length" to 7.0)), bold.map { it.filterKeys { key -> key in setOf("type", "offset", "length") }.mapValues { (_, v) -> (v as? Number)?.toDouble() ?: v } })
    assertEquals(setOf("bold"), ComposeRules.active(bold, 0, 7))
    assertTrue(ComposeRules.active(bold, 0, 9).isEmpty())
    assertTrue(ComposeRules.toggle(bold, "Встреча завтра", 0, 7, "bold").isEmpty())
    assertTrue(ComposeRules.clear(bold, "Встреча завтра", 0, 14).isEmpty())
    // The typed shortcuts become entities; the text is trimmed.
    val out = ComposeRules.compose("  **жирный** текст ", emptyList())
    assertEquals("жирный текст", out.first)
    assertEquals("bold", out.second?.firstOrNull()?.get("type"))
    assertNull(ComposeRules.compose("просто", emptyList()).second)
  }

  @Test fun aPollIsReadAndWorded() {
    val message = mapOf("meta" to mapOf("poll" to mapOf("question" to "Куда?", "options" to listOf("Кино", "Боулинг"), "multiple" to false)),
      "poll" to mapOf("counts" to listOf(1, 1), "mine" to listOf(1), "voters" to 2))
    val poll = MsgPoll.parse(PollRows.fields(message, emptyList(), disabled = false))!!
    assertTrue(poll.voted)
    assertEquals(2, poll.total)
    assertEquals("Куда?. Опрос. Кино, 50%. Боулинг, 50%. 2 голоса", poll.spoken)
    assertEquals(listOf("голос", "голоса", "голосов", "голосов", "голос"), listOf(1, 3, 5, 11, 21).map { MsgPoll.votes(it) })
    assertEquals("📊 Куда?\n1. Кино\n2. Боулинг", PollText.fallback(mapOf("question" to "Куда?", "options" to listOf("Кино", "Боулинг"))))
    assertNull(MsgPoll.parse(mapOf("question" to "Пусто", "options" to emptyList<String>())))
  }

  @Test fun theRowsCarryPollsBigEmojiAndSilence() {
    val now = Instant.parse("2026-11-21T09:10:00Z")
    fun message(id: Int, mine: Boolean, text: String, meta: Map<String, Any?>? = null) = linkedMapOf<String, Any?>("id" to id, "chatId" to "c", "senderId" to (if (mine) "me" else "peer"),
      "clientId" to "c$id", "text" to text, "attachment" to null, "createdAt" to "2026-11-21T09:0$id:00.000Z", "cryptoState" to "decrypted").apply { if (meta != null) put("meta", meta) }
    val raw = listOf(message(1, false, "🎉🔥"), message(2, true, "Тихо", mapOf("silent" to true)), message(3, false, "Ищи распечатки"))
    val shown = ChatHistory.build(ChatHistory.Snapshot(raw, emptyList(), emptyList(), null, 0, null, "me", "Алиса", now, moscow))
    val rows = MsgRow.parse(shown.rows).filter { it.kind == 0 }
    assertEquals(2, rows[0].bigEmoji)
    assertTrue(rows[1].silent)
    assertFalse(rows[2].silent)
    // The search shows only the messages that hold the words.
    val found = ChatHistory.build(ChatHistory.Snapshot(raw, emptyList(), emptyList(), null, 0, null, "me", "Алиса", now, moscow, needle = "распечат"))
    assertEquals(1, found.found)
    assertEquals(1, MsgRow.parse(found.rows).count { it.kind == 0 })
    assertTrue(ChatSearchBar.matches(mapOf("text" to "", "attachment" to mapOf("name" to "Отчёт.pdf")), "отчёт"))
  }

  @Test fun theForwardNotice() {
    fun target(id: String, name: String) = ForwardPicker.Target(id, "p", name, null, null)
    assertEquals("Переслано: Алиса", ChatForward.notice(listOf(target("a", "Алиса"))))
    assertEquals("Переслано в 1 чат", ChatForward.notice(listOf(target(ForwardPicker.SAVED_ID, "Избранное"))))
    assertEquals("Переслано в 3 чата", ChatForward.notice(listOf(target("a", "А"), target("b", "Б"), target(ForwardPicker.SAVED_ID, "Избранное"))))
  }
}
