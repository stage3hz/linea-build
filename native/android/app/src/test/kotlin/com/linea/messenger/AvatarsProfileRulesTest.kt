package com.linea.messenger

import com.linea.messenger.avatars.AnimatedEmojiView
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.ChatListDecor
import com.linea.messenger.avatars.DecorEase
import com.linea.messenger.avatars.Nameplates
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.PlatinaMetal
import com.linea.messenger.avatars.decorRand
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.platina.PlatinaState
import com.linea.messenger.profile.AvatarCrop
import com.linea.messenger.profile.BirthdayReminders
import com.linea.messenger.profile.GiftCatalog
import com.linea.messenger.profile.ProfileAmbientView
import com.linea.messenger.profile.ProfileChatExtras
import com.linea.messenger.profile.ProfileGift
import com.linea.messenger.profile.SharedMediaView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

/** The plain rules of the avatars, profiles, Platina, gifts and birthdays (avatars/, profile/, platina/), as the
 *  reference and the iOS app have them. */
class AvatarsProfileRulesTest {
  private val now = Instant.parse("2026-11-21T12:00:00Z")

  @Test fun theStatusShowsOnlyWhileItLasts() {
    // statusEmojiModel.ts `visibleStatusEmoji`, rule for rule.
    fun look(vararg fields: Pair<String, Any?>) = PersonLook.from(mapOf(*fields))
    assertEquals("🔥", look("statusEmoji" to "🔥", "statusEmojiPermanent" to true, "statusEmojiExpiresAt" to null).visibleStatus(now))
    assertNull(look("statusEmoji" to "🔥", "statusEmojiPermanent" to true).visibleStatus(now))
    assertNull(look("statusEmoji" to "🔥", "statusEmojiPermanent" to true, "statusEmojiExpiresAt" to "2027-01-01T00:00:00Z").visibleStatus(now))
    assertEquals("💎", look("statusEmoji" to "💎", "statusEmojiExpiresAt" to "2026-11-22T00:00:00Z").visibleStatus(now))
    assertNull(look("statusEmoji" to "💎", "statusEmojiExpiresAt" to "2026-11-20T00:00:00Z").visibleStatus(now))
    assertEquals("💎", look("statusEmoji" to "💎", "statusEmojiPermanent" to false, "statusEmojiExpiresAt" to "2026-11-22T00:00:00Z").visibleStatus(now))
    assertNull(look("statusEmoji" to "💎", "statusEmojiPermanent" to "yes", "statusEmojiExpiresAt" to "2026-11-22T00:00:00Z").visibleStatus(now))
    // Only the fixed set.
    assertNull(look("statusEmoji" to "🍕", "statusEmojiPermanent" to true, "statusEmojiExpiresAt" to null).visibleStatus(now))
    assertEquals(Instant.parse("2026-11-22T00:00:00Z"), look("statusEmoji" to "💎", "statusEmojiExpiresAt" to "2026-11-22T00:00:00Z").statusEnds(now))
  }

  @Test fun birthdaysAndTheFestiveRing() {
    assertTrue(AvatarCatalog.isBirthdayToday("11-21", LocalDate.of(2026, 11, 21)))
    assertTrue(AvatarCatalog.isBirthdayToday("1990-11-21", LocalDate.of(2026, 11, 21)))
    assertFalse(AvatarCatalog.isBirthdayToday("11-22", LocalDate.of(2026, 11, 21)))
    // 29 Feb is celebrated on 28 Feb in other years.
    assertTrue(AvatarCatalog.isBirthdayToday("02-29", LocalDate.of(2027, 2, 28)))
    assertTrue(AvatarCatalog.isBirthdayToday("02-29", LocalDate.of(2028, 2, 29)))
    assertEquals(LocalDate.of(2027, 3, 2), AvatarCatalog.nextBirthday("03-02", LocalDate.of(2026, 11, 21)))
    assertEquals(LocalDate.of(2026, 11, 21), AvatarCatalog.nextBirthday("11-21", LocalDate.of(2026, 11, 21)))
    val birthday = PersonLook.from(mapOf("birthday" to "11-21", "gender" to "female", "avatarFrame" to "fx-neon"))
    assertEquals(AvatarCatalog.birthdayColors("female"), AvatarCatalog.ringColors(birthday, LocalDate.of(2026, 11, 21)))
    assertEquals(AvatarCatalog.frame("platinum")!!.colors, AvatarCatalog.ringColors(PersonLook(seal = "platina"), LocalDate.of(2026, 11, 21)))
    assertNull(AvatarCatalog.ringColors(PersonLook(avatarFrame = "deco-chrome"), LocalDate.of(2026, 11, 21)))
  }

  @Test fun theDressAndThePlainHeader() {
    val dressed = PersonLook().dressed()
    assertTrue(dressed.platina); assertEquals("platinum", dressed.avatarFrame); assertEquals("sparks", dressed.profileEffect)
    // The owner's rule: the chat header shows no frame, no Platina ring and no birthday ring.
    val plain = PersonLook(seal = "platina", avatarFrame = "fx-flame", birthday = "11-21", statusEmoji = "🔥").plain()
    assertEquals("", plain.avatarFrame); assertFalse(plain.platina); assertEquals("", plain.birthday); assertEquals("🔥", plain.statusEmoji)
  }

  @Test fun theChatListRowKeys() {
    val today = LocalDate.of(2026, 11, 21)
    val code = ChatListDecor.fields(mapOf("displayName" to "Вера", "avatarFrame" to "fx-orbit", "seal" to "platina", "nameplate" to "night",
      "statusEmoji" to "💎", "statusEmojiPermanent" to true, "statusEmojiExpiresAt" to null), now, today, dark = false)
    assertEquals("Вера 💎", code["title"])
    assertEquals("fx-orbit", code["deco"]); assertEquals(1.3, code["decoScale"] as Double, 0.001)
    assertEquals("night", code["plate"])
    // On a plate the light metal, also in a light theme.
    assertEquals(PlatinaMetal.argb(PlatinaMetal.name), code["metal"]); assertEquals(4, code["nameLen"])
    val art = ChatListDecor.fields(mapOf("displayName" to "Лев", "avatarFrame" to "deco-moths"), now, today, dark = true)
    assertEquals("decoration_moths", art["deco"]); assertEquals(1.5, art["decoScale"] as Double, 0.001)
    val platina = ChatListDecor.fields(mapOf("displayName" to "Аня", "seal" to "platina"), now, today, dark = false)
    assertEquals(PlatinaMetal.argb(AvatarCatalog.frame("platinum")!!.colors), platina["ring"])
    assertEquals(PlatinaMetal.argb(PlatinaMetal.nameLight), platina["metal"])
    assertTrue(ChatListDecor.fields(mapOf("displayName" to "Саша"), now, today, dark = true).isEmpty())
  }

  @Test fun catalogues() {
    assertEquals(7, AvatarCatalog.frames.size); assertEquals(8, AvatarCatalog.codeFrames.size); assertEquals(12, AvatarCatalog.decorations.size)
    assertEquals(6, AvatarCatalog.banners.size); assertEquals(6, AvatarCatalog.effects.size); assertEquals(10, AvatarCatalog.plates.size)
    assertEquals(20, AvatarCatalog.statusEmoji.size); assertEquals(24, AvatarCatalog.patterns.size)
    assertEquals(16, GiftCatalog.all.size)
    assertEquals("Подарок", GiftCatalog.gift("unknown").label)
    assertEquals(0xFF5E7BFF.toInt(), lookColor("#5E7BFF"))
    assertEquals(4, AvatarCatalog.decorationCollections.size)
    assertTrue(AvatarCatalog.decorations.all { it.file.startsWith("decoration_") })
  }

  @Test fun theDeterministicGenerators() {
    // The reference's LCG seeded by the plate's id: the same numbers as on the other phone.
    val g = Nameplates.Generator("crows")
    assertEquals(0.6927959583699703, g.next().toDouble(), 1e-6)
    assertEquals(0.4286737476941198, g.next().toDouble(), 1e-6)
    assertEquals(decorRand(3.0), decorRand(3.0), 0.0)
    assertTrue(decorRand(1.0) in 0.0..1.0)
    assertEquals(0.5, DecorEase.inOutCubic(0.5), 1e-9)
    assertEquals(0.0, DecorEase.loop(0.5, 1.0, delay = 1.0), 1e-9)
    assertEquals(0.25, DecorEase.loop(1.25, 1.0), 1e-9)
    assertEquals(0f, PlatinaMetal.sheen(0.0, 3.6, 100f), 0.01f)
    assertEquals(-150f, PlatinaMetal.sheen(3.6, 3.6, 100f), 0.01f)
    assertEquals(1.0, ProfileAmbientView.layerOpacity(2.0, 2, 5), 1e-9)
    assertEquals(0.0, ProfileAmbientView.layerOpacity(0.0, 2, 5), 1e-9)
  }

  @Test fun theAvatarCrop() {
    // A landscape photo in a 300 viewport: the middle square, at zoom 1.
    val rect = AvatarCrop.rect(1200f, 900f, 300f, 1f, 0f, 0f)
    assertEquals(150, rect.left); assertEquals(0, rect.top); assertEquals(900, rect.side)
    // Panned to the far left edge: the offset is clamped.
    val left = AvatarCrop.rect(1200f, 900f, 300f, 1f, 1000f, 0f)
    assertEquals(0, left.left)
    // Zoomed 2×: half the side.
    assertEquals(450, AvatarCrop.rect(1200f, 900f, 300f, 2f, 0f, 0f).side)
  }

  @Test fun birthdayReminders() {
    val zone = ZoneOffset.UTC
    val reminders = BirthdayReminders.reminders("Иван", "11-23", ZonedDateTime.of(2026, 11, 21, 12, 0, 0, 0, zone))
    assertEquals(4, reminders.size)
    assertEquals("🎂 Иван: завтра день рождения", reminders[0].title)
    assertEquals("Нажми, чтобы открыть профиль.", reminders[0].body)
    assertEquals(ZonedDateTime.of(2026, 11, 22, 10, 0, 0, 0, zone), reminders[0].at)
    assertEquals(ZonedDateTime.of(2026, 11, 22, 20, 0, 0, 0, zone), reminders[1].at)
    assertEquals("🎉 Иван: сегодня день рождения!", reminders[2].title)
    assertEquals("Нажми, чтобы открыть профиль и поздравить.", reminders[3].body)
    // Only those still ahead.
    assertEquals(1, BirthdayReminders.reminders("Иван", "11-21", ZonedDateTime.of(2026, 11, 21, 5, 0, 0, 0, zone)).size)
    assertTrue(BirthdayReminders.reminders("Иван", "", ZonedDateTime.of(2026, 11, 21, 5, 0, 0, 0, zone)).isEmpty())
  }

  @Test fun theChatsSoundAndRules() {
    val zone = ZoneId.of("UTC")
    assertFalse(ProfileChatExtras.muted(mapOf("muted" to false), now))
    assertTrue(ProfileChatExtras.muted(mapOf("muted" to true), now))
    assertFalse(ProfileChatExtras.muted(mapOf("muted" to true, "mutedUntil" to "2026-11-21T11:00:00Z"), now))
    assertEquals("18:30", ProfileChatExtras.endLabel(Instant.parse("2026-11-21T18:30:00Z"), now, zone))
    assertEquals("завтра, 09:15", ProfileChatExtras.endLabel(Instant.parse("2026-11-22T09:15:00Z"), now, zone))
    assertEquals("3 января 2027, 09:15", ProfileChatExtras.endLabel(Instant.parse("2027-01-03T09:15:00Z"), now, zone))
    assertEquals("навсегда", ProfileChatExtras.untilLabel(null, now, zone))
    assertEquals("до 18:30", ProfileChatExtras.untilLabel("2026-11-21T18:30:00Z", now, zone))
    assertEquals("1 неделя", ProfileChatExtras.autoDeleteLabel(604800))
    assertEquals("Автоудаление выключено", ProfileChatExtras.autoDeleteNotice(0))
    assertEquals("Автоудаление: 1 день", ProfileChatExtras.autoDeleteNotice(86400))
    assertEquals("Копирование снова разрешено", ProfileChatExtras.noCopyNotice(true))
  }

  @Test fun theSharedMedia() {
    assertEquals("photo", SharedMediaView.kind(mapOf("mimeType" to "image/jpeg")))
    assertEquals("photo", SharedMediaView.kind(mapOf("name" to "RAW.CR3")))
    assertEquals("video", SharedMediaView.kind(mapOf("name" to "walk.mov")))
    assertEquals("file", SharedMediaView.kind(mapOf("name" to "Отчёт.pdf", "mimeType" to "application/pdf")))
    assertTrue(SharedMediaView.isVoice(mapOf("mimeType" to "audio/mp4", "name" to "voice-1730000000.m4a")))
    assertTrue(SharedMediaView.isVideoNote(mapOf("mimeType" to "video/mp4", "name" to "circle-1.mp4")))
    assertEquals("512 Б", SharedMediaView.size(512)); assertEquals("84 КБ", SharedMediaView.size(86_000)); assertEquals("1.2 МБ", SharedMediaView.size(1_240_000))
    assertEquals(listOf("https://tickets.example.com/event/42"), SharedMediaView.linksOf("Билеты тут: https://tickets.example.com/event/42."))
    assertTrue(SharedMediaView.linksOf("зайди https://invizent.com/i/abcd1234").isEmpty())
    assertEquals(listOf("Фото", "Файлы", "Ссылки"), SharedMediaView.tabsFor(2, 0, 1, 0, 3).map { it.second })
    assertEquals(1, SharedMediaView.pageRelease(0, 3, -120f, 0f, 400f))
    assertEquals(0, SharedMediaView.pageRelease(0, 3, -20f, 0f, 400f))
    // A flick back cancels the step.
    assertEquals(0, SharedMediaView.pageRelease(0, 3, -120f, 500f, 400f))
  }

  @Test fun giftsAndPlatina() {
    val gift = ProfileGift.from(mapOf("id" to "g1", "gift" to "rose", "message" to "Ура", "sender" to mapOf("id" to "u1", "displayName" to "Лев")))!!
    assertEquals("rose", gift.gift); assertEquals("Лев", gift.sender?.displayName)
    assertNull(ProfileGift.from(mapOf("gift" to "rose")))
    assertEquals("Бессрочно", PlatinaState.untilWords(true, mapOf("platina" to mapOf("active" to true, "permanent" to true))))
    assertEquals("Активна до 5 марта", PlatinaState.untilWords(true, mapOf("platina" to mapOf("active" to true, "expiresAt" to "2027-03-05T12:00:00Z")), ZoneId.of("UTC")))
    assertEquals("", PlatinaState.untilWords(false, mapOf("platina" to mapOf("active" to false))))
    // The animated emoji files, tolerant to a missing or extra U+FE0F.
    assertEquals(listOf("emoji_2764_fe0f", "emoji_2764"), AnimatedEmojiView.names("❤️"))
    assertEquals(listOf("emoji_1f525", "emoji_1f525_fe0f"), AnimatedEmojiView.names("🔥"))
  }
}
