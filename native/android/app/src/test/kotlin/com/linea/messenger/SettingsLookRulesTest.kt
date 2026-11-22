package com.linea.messenger

import com.linea.messenger.push.Push
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.settings.DataScreen
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.KeptWords
import com.linea.messenger.settings.NotificationPrefs
import com.linea.messenger.settings.NotificationsScreen
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.ThemeLook
import com.linea.messenger.settings.ThemeStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/** The look of the app and what the phone keeps of the settings, with no phone: the same as
 *  native/ios/Sources/Settings (ThemeStore, Appearance, Notifications, DataStorage). The rules themselves are the
 *  core's (native/core/src/settings.rs), called for real through JNI; those tests are skipped when the core has
 *  not been built for this machine (build-core-host.sh). The store is one of the test, in memory. */
class SettingsLookRulesTest {
  private class Memory : KeptWords {
    val kept = HashMap<String, String>()
    override fun get(key: String): String? = kept[key]
    override fun set(key: String, value: String?) { if (value == null) kept.remove(key) else kept[key] = value }
  }

  private val memory = Memory()

  /** The clock, the system's look and the screen's brightness are the test's. */
  private fun start(minute: Int = 12 * 60, system: String = "light", level: Double? = 0.8) {
    assumeTrue(Core.loaded)
    ThemeStore.minuteNow = { minute }
    ThemeStore.systemLook = { system }
    ThemeStore.screenLevel = { level }
    ThemeStore.use(memory)
  }

  @After fun backToTheAppsOwnLook() {
    ThemeStore.use(null)
    ThemeStore.systemLook = null
    ThemeStore.screenLevel = null
  }

  private fun assertBlack() {
    assertEquals(0xFF08090A.toInt(), Theme.bg)
    assertEquals(0xFFE5E5E6.toInt(), Theme.text)
    assertEquals(0xFF8A8F98.toInt(), Theme.muted)
    assertEquals(0xFF62666D.toInt(), Theme.subtle)
    assertEquals(0xFFE5E5E6.toInt(), Theme.accent)
    assertEquals(0xFF08090A.toInt(), Theme.onAccent)
    assertEquals(0xEB161718.toInt(), Theme.surface2)
    assertEquals(0xFFFF9CB0.toInt(), Theme.danger)
    assertTrue(Theme.dark)
    // What the lists and the settings drew with before the themes: nothing of it moved.
    val list = Theme.chatList
    assertEquals(listOf(0x12FFFFFF, 0x12FFFFFF, 0x0EFFFFFF, 0xEB161718.toInt(), 0), listOf(list.pressed, list.selected, list.pinned, list.badgeMuted, list.border))
    val messages = Theme.messages
    assertEquals(listOf(0xF51F2023.toInt(), 0xF5161718.toInt(), 0x0FFFFFFF, 0x14FFFFFF), listOf(messages.mine, messages.theirs, messages.notice, messages.quote))
    assertEquals(listOf(0xEB161718.toInt(), 0x14FFFFFF, 0x12FFFFFF, 0x24FF9CB0, 0x12FFFFFF), listOf(SettingsLook.card, SettingsLook.line, SettingsLook.chip, SettingsLook.dangerChip, SettingsLook.pressed))
  }

  @Test fun withNothingKeptTheAppIsBlack() {
    ThemeStore.use(null)
    assertBlack()
    assertEquals("black|", ThemeStore.look.source)
    // Nothing is redrawn while there is nowhere to keep a choice.
    assertFalse(ThemeStore.refresh())
  }

  @Test fun theCoresBlackIsTheAppsOwnLook() {
    start()
    assertEquals("black", ThemeStore.look.id)
    assertEquals("black", ThemeStore.mode)
    assertEquals("black", ThemeStore.darkTheme)
    assertBlack()
    val own = ThemeLook()
    val made = ThemeLook("black", ThemeStore.plainFields("black"))
    assertEquals(listOf(own.bg, own.text, own.muted, own.subtle, own.accent, own.onAccent, own.accentSoft, own.surface2, own.border, own.danger, own.bubble, own.incoming, own.dark, own.black),
      listOf(made.bg, made.text, made.muted, made.subtle, made.accent, made.onAccent, made.accentSoft, made.surface2, made.border, made.danger, made.bubble, made.incoming, made.dark, made.black))
  }

  @Test fun aColourIsReadAsTheReferenceWritesIt() {
    assertEquals(0xFF1C1C1E.toInt(), ThemeLook.color("#1C1C1E"))
    assertEquals(0xFFAABBCC.toInt(), ThemeLook.color("#aabbcc"))
    assertEquals(0xEB161718.toInt(), ThemeLook.color("rgba(22,23,24,0.92)"))
    assertEquals(0x12FFFFFF, ThemeLook.color("rgba(255, 255, 255, 0.07)"))
    assertEquals(0xFF010203.toInt(), ThemeLook.color("rgb(1,2,3)"))
    assertEquals(0, ThemeLook.color("transparent"))
    for (bad in listOf(null, "", "#12345", "#12345G", "#+12345", "red", "rgba(1,2)", "rgba(a,b,c,1)", "hsl(1,2,3)")) assertNull(bad, ThemeLook.color(bad))
    // The veil is white over a dark theme.
    assertEquals(0x1FFFFFFF, ThemeLook().veil(0.12f))
  }

  @Test fun theListsOfThePagesComeFromTheCore() {
    start()
    assertEquals(listOf("light", "dark", "black", "graphite"), ThemeStore.list("appearances").map { it["value"] })
    assertEquals(listOf("Светлая", "Тёмная", "Чёрная", "Графит"), ThemeStore.list("appearances").map { it["label"] })
    assertEquals(7, ThemeStore.list("palettes").size)
    assertEquals("Графит", ThemeStore.themeName("graphite"))
    assertEquals("Как в системе", ThemeStore.themeName("system"))
    assertEquals("unknown", ThemeStore.themeName("unknown"))
    assertEquals(listOf("system", "off", "schedule", "auto"), ThemeStore.words("nightModes"))
    assertEquals(listOf("dark", "black", "graphite"), ThemeStore.words("nightThemes"))
    assertEquals(listOf("Мелкий", "Обычный", "Крупный", "Очень крупный"), ThemeStore.list("textSizes").map { it["label"] })
    assertEquals(12, ThemeStore.words("accentChoices").size)
    assertEquals(listOf("Неон", "Пульс", "Без мелодии"), ThemeStore.list("ringtones").map { it["label"] })
    assertEquals(listOf("На 1 час", "На 8 часов", "На 2 дня", "Навсегда"), ThemeStore.list("muteChoices").map { it["label"] })
  }

  @Test fun aChosenThemeIsPutOnAndKept() {
    start()
    ThemeStore.mode = "graphite"
    assertTrue(ThemeStore.refresh())
    assertEquals("graphite", ThemeStore.look.id)
    assertEquals(ThemeLook.color(ThemeStore.plainFields("graphite")["bg"] as String), Theme.bg)
    assertNotEquals(0xFF08090A.toInt(), Theme.bg)
    assertTrue(Theme.dark)
    // The same look again: nothing to redraw.
    assertFalse(ThemeStore.refresh())
    assertEquals("graphite", memory.kept[ThemeStore.MODE_KEY])
    // The app opened again reads the same choice.
    ThemeStore.use(memory)
    assertEquals("graphite", ThemeStore.look.id)

    ThemeStore.mode = "light"
    assertTrue(ThemeStore.refresh())
    assertFalse(Theme.dark)
    // Over a light theme the veil is black, and the settings draw their lines with it.
    assertEquals(0x14000000, SettingsLook.line)
    // ChatListScreen.tsx nativePalette: pressed rgba(0,0,0,0.05) over a light theme.
    assertEquals(0x0D000000, Theme.chatList.pressed)
    // A record that is not a theme is «Как в системе», as in the previous app: the system here is light.
    memory.kept[ThemeStore.MODE_KEY] = "sepia"
    assertEquals("system", ThemeStore.mode)
    assertFalse(ThemeStore.refresh())
    assertEquals("light", ThemeStore.look.id)
    ThemeStore.systemLook = { "dark" }
    assertTrue(ThemeStore.refresh())
    assertEquals("black", ThemeStore.look.id)
    ThemeStore.mode = "black"
    assertFalse(ThemeStore.refresh())
    assertBlack()
  }

  @Test fun aPaletteNeedsPlatina() {
    start()
    ThemeStore.mode = "amethyst"
    assertFalse(ThemeStore.platina)
    assertEquals("dark", ThemeStore.shownWithPlatina("amethyst"))
    assertTrue(ThemeStore.refresh())
    // The choice itself is kept; «Тёмная» is what is shown until the account has Platina.
    assertEquals("dark", ThemeStore.look.id)
    assertEquals("amethyst", ThemeStore.mode)
    ThemeStore.platina = true
    assertEquals("amethyst", ThemeStore.shownWithPlatina("amethyst"))
    assertTrue(ThemeStore.refresh())
    assertEquals("amethyst", ThemeStore.look.id)
    ThemeStore.platina = false
    assertTrue(ThemeStore.refresh())
    assertEquals("dark", ThemeStore.look.id)
  }

  @Test fun theColourOfTheInterfaceLiesOverTheTheme() {
    start()
    assertNull(DevicePreferences.word("accentColor"))
    DevicePreferences.set(mapOf("accentColor" to "#FF9500"))
    assertEquals("#FF9500", DevicePreferences.word("accentColor"))
    assertTrue(ThemeStore.refresh())
    val made = Core.map(Core.view("settingsTheme", listOf("black", "#FF9500", null)))!!
    assertEquals(ThemeLook.color(made["accent"] as String), Theme.accent)
    assertNotEquals(0xFFE5E5E6.toInt(), Theme.accent)
    // Everything else is the theme's own.
    assertEquals(0xFF08090A.toInt(), Theme.bg)
    assertEquals(0xFFE5E5E6.toInt(), Theme.text)
    // Something that is not a colour is no colour.
    DevicePreferences.set(mapOf("accentColor" to "orange"))
    assertNull(DevicePreferences.word("accentColor"))
    assertTrue(ThemeStore.refresh())
    assertBlack()
    DevicePreferences.set(mapOf("accentColor" to "#FF9500"))
    assertTrue(ThemeStore.refresh())
    DevicePreferences.set(mapOf("accentColor" to null))
    assertTrue(ThemeStore.refresh())
    assertBlack()
  }

  @Test fun theSizeOfTheTextIsOneOfFour() {
    start()
    assertEquals(17f, ThemeStore.textSize)
    for ((id, size) in listOf("small" to 15f, "medium" to 17f, "large" to 19f, "xlarge" to 22f)) {
      DevicePreferences.set(mapOf("textSize" to id))
      assertEquals(id, size, ThemeStore.textSize)
    }
    DevicePreferences.set(mapOf("textSize" to "huge"))
    assertEquals("medium", DevicePreferences.word("textSize"))
    assertEquals(17f, ThemeStore.textSize)
    // The size is not the look: nothing is rebuilt for it.
    DevicePreferences.set(mapOf("textSize" to "large"))
    assertFalse(ThemeStore.refresh())
  }

  @Test fun aBrokenRecordIsTheDefaults() {
    memory.kept[DevicePreferences.KEY] = "{\"textSize\":\"large\",\"nightMode\":\"always\",\"accentColor\":7"
    memory.kept[NotificationPrefs.KEY] = "[oops"
    start()
    assertEquals("medium", DevicePreferences.word("textSize"))
    assertNull(DevicePreferences.word("nightMode"))
    assertEquals("22:00", DevicePreferences.word("nightFrom"))
    assertEquals(0.25, DevicePreferences.number("nightBrightness")!!, 0.0)
    assertNull(DevicePreferences.flag("nightForced"))
    assertTrue(NotificationPrefs.flag("chats", "show"))
    assertFalse(NotificationPrefs.changed)
    assertBlack()
  }

  @Test fun theNightThemeComesByTheClock() {
    start(minute = 23 * 60)
    ThemeStore.mode = "light"
    ThemeStore.darkTheme = "graphite"
    DevicePreferences.set(mapOf("nightMode" to "schedule"))
    var state = ThemeStore.nightState()
    assertEquals(listOf<Any?>("schedule", true, true, false, true, "graphite", "light"), listOf("kind", "auto", "known", "expired", "night", "shown", "day").map { state[it] })
    assertTrue(ThemeStore.refresh())
    assertEquals("graphite", ThemeStore.look.id)
    // Switched off by hand at night: it stays off until the clock itself says day.
    DevicePreferences.set(mapOf("nightForced" to false, "nightForcedAt" to true))
    assertTrue(ThemeStore.refresh())
    assertEquals("light", ThemeStore.look.id)
    ThemeStore.minuteNow = { 12 * 60 }
    assertFalse(ThemeStore.refresh())
    // The rule changed by itself: the switch by hand has run out and is forgotten.
    assertNull(DevicePreferences.flag("nightForced"))
    assertNull(DevicePreferences.flag("nightForcedAt"))
    ThemeStore.minuteNow = { 6 * 60 + 59 }
    assertTrue(ThemeStore.refresh())
    assertEquals("graphite", ThemeStore.look.id)
    ThemeStore.minuteNow = { 7 * 60 }
    assertTrue(ThemeStore.refresh())
    assertEquals("light", ThemeStore.look.id)
    // Another hour of the evening.
    DevicePreferences.set(mapOf("nightFrom" to "06:45", "nightTo" to "07:15"))
    assertTrue(ThemeStore.refresh())
    state = ThemeStore.nightState()
    assertEquals(true, state["night"])
  }

  @Test fun theNightThemeFollowsTheSystemOrTheScreen() {
    start(system = "dark", level = 0.8)
    ThemeStore.mode = "light"
    ThemeStore.darkTheme = "dark"
    DevicePreferences.set(mapOf("nightMode" to "system"))
    assertTrue(ThemeStore.refresh())
    assertEquals("dark", ThemeStore.look.id)
    ThemeStore.systemLook = { "light" }
    assertTrue(ThemeStore.refresh())
    assertEquals("light", ThemeStore.look.id)
    // By the screen's brightness: at the level and under it.
    DevicePreferences.set(mapOf("nightMode" to "auto", "nightBrightness" to 0.4))
    assertFalse(ThemeStore.refresh())
    ThemeStore.screenLevel = { 0.4 }
    assertTrue(ThemeStore.refresh())
    assertEquals("dark", ThemeStore.look.id)
    // A screen that does not say how bright it is: the rule is unknown and night does not come.
    ThemeStore.screenLevel = { null }
    val state = ThemeStore.nightState()
    assertEquals(false, state["known"])
    assertEquals(false, state["night"])
    // «Как в системе» chosen before the night settings were touched follows the system.
    DevicePreferences.set(mapOf("nightMode" to null))
    ThemeStore.mode = "system"
    ThemeStore.systemLook = { "dark" }
    assertEquals("system", ThemeStore.nightState()["kind"])
    assertEquals("dark", ThemeStore.nightState()["shown"])
  }

  @Test fun theNotificationSwitchesAreKeptOnTheDevice() {
    start()
    for ((group, name) in listOf("chats" to "show", "chats" to "sound", "communities" to "show", "communities" to "sound", "calls" to "vibration", "badge" to "enabled")) {
      assertTrue("$group.$name", NotificationPrefs.flag(group, name))
    }
    assertFalse(NotificationPrefs.flag("badge", "countMuted", otherwise = false))
    assertEquals("neon", NotificationPrefs.ringtone)
    assertFalse(NotificationPrefs.changed)
    assertNull(memory.kept[NotificationPrefs.KEY])

    NotificationPrefs.set("chats", "sound", false)
    NotificationPrefs.set("calls", "ringtone", "pulse")
    NotificationPrefs.set("badge", "countMuted", true)
    assertFalse(NotificationPrefs.flag("chats", "sound"))
    assertTrue(NotificationPrefs.flag("chats", "show"))
    assertEquals("pulse", NotificationPrefs.ringtone)
    assertTrue(NotificationPrefs.flag("badge", "countMuted", otherwise = false))
    assertTrue(NotificationPrefs.changed)
    // The record is the reference's: groups of switches, and nothing about whether it was changed.
    val kept = Core.map(Core.value(memory.kept[NotificationPrefs.KEY]))!!
    assertEquals(setOf("chats", "communities", "calls", "badge"), kept.keys)
    assertEquals(false, Core.map(kept["chats"])!!["sound"])
    // A melody that does not exist is the first one.
    NotificationPrefs.set("calls", "ringtone", "siren")
    assertEquals("neon", NotificationPrefs.ringtone)

    NotificationPrefs.reset()
    assertNull(memory.kept[NotificationPrefs.KEY])
    assertFalse(NotificationPrefs.changed)
    assertTrue(NotificationPrefs.flag("chats", "sound"))
  }

  @Test fun thePageSaysThePushStateAsTheReference() {
    // NotificationsSection.tsx / push.ts `pushStatusText`, word for word.
    assertEquals("Разрешение на уведомления ещё не запрошено." to false, NotificationsScreen.pushLine(Push.Status.PENDING))
    assertEquals("Уведомления выключены в настройках системы." to true, NotificationsScreen.pushLine(Push.Status.DENIED))
    assertEquals("Уведомления не настроены в этой сборке приложения." to true, NotificationsScreen.pushLine(Push.Status.UNAVAILABLE))
    assertEquals("Сервер пока не отправляет уведомления на это устройство." to true, NotificationsScreen.pushLine(Push.Status.SERVER_OFF))
    assertEquals("Когда приложение закрыто, уведомления показывает система. Переключатели ниже действуют, пока приложение запущено. В уведомлении только имя отправителя: текст остаётся зашифрованным." to false, NotificationsScreen.pushLine(Push.Status.ON))
  }

  @Test fun theSoundOfAChatReadsOnTheLocalClock() {
    assumeTrue(Core.loaded)
    val now = Instant.parse("2026-11-21T09:00:00Z")
    val moscow = ZoneId.of("Europe/Moscow")
    fun state(settings: Map<String, Any?>, zone: ZoneId = moscow) = NotificationsScreen.muteState(settings, now, zone)
    assertEquals(false, state(emptyMap())["muted"])
    assertEquals("", state(emptyMap())["status"])
    val forever = state(mapOf("muted" to true))
    assertEquals(listOf<Any?>(true, "навсегда", "Звук выключен"), listOf(forever["muted"], forever["until"], forever["status"]))
    val today = state(mapOf("muted" to true, "mutedUntil" to "2026-11-21T15:30:00.000Z"))
    assertEquals(listOf<Any?>(true, "до 18:30", "Звук выключен до 18:30"), listOf(today["muted"], today["until"], today["status"]))
    assertEquals("до 15:30", state(mapOf("muted" to true, "mutedUntil" to "2026-11-21T15:30:00.000Z"), ZoneOffset.UTC)["until"])
    assertEquals("до завтра, 00:30", state(mapOf("muted" to true, "mutedUntil" to "2026-11-21T21:30:00.000Z"))["until"])
    assertEquals("до 5 декабря, 12:00", state(mapOf("muted" to true, "mutedUntil" to "2026-12-05T09:00:00.000Z"))["until"])
    assertEquals("до 5 января 2027, 12:00", state(mapOf("muted" to true, "mutedUntil" to "2027-01-05T09:00:00.000Z"))["until"])
    // A silence that has ended is over before the server says so.
    assertEquals(false, state(mapOf("muted" to true, "mutedUntil" to "2026-11-21T08:59:59.000Z"))["muted"])
    // The end of a choice made now, as the server takes it.
    assertEquals("2026-11-21T10:00:00.000Z", NotificationsScreen.muteEnd("1h", now))
    assertEquals("2026-11-21T17:00:00.000Z", NotificationsScreen.muteEnd("8h", now))
    assertEquals("2026-11-23T09:00:00.000Z", NotificationsScreen.muteEnd("2d", now))
    assertNull(NotificationsScreen.muteEnd("forever", now))
  }

  @Test fun theStorageReadsAsTheReferenceWritesSizes() {
    assertEquals("…", DataScreen.serverWords(null, failed = false))
    assertEquals("Недоступно", DataScreen.serverWords(null, failed = true))
    assertEquals(0f, DataScreen.serverShare(null))
    assertEquals(0.5f, DataScreen.serverShare(mapOf("usedBytes" to 10.0, "storageBytes" to 20.0)))
    assertEquals(1f, DataScreen.serverShare(mapOf("usedBytes" to 30.0, "storageBytes" to 20.0)))
    assertEquals(0f, DataScreen.serverShare(mapOf("usedBytes" to 0.0, "storageBytes" to 0.0)))
    assertEquals("Видео до 10 ГБ, файлы до 2 ГБ, всего 20 ГБ. С Platina — файлы до 4 ГБ и 40 ГБ всего.", DataScreen.planWords(false))
    assertEquals("Видео до 10 ГБ, файлы до 4 ГБ (Platina), всего 40 ГБ.", DataScreen.planWords(true))
    assumeTrue(Core.loaded)
    val gb = 1024.0 * 1024 * 1024
    assertEquals("0 Б / 20 ГБ", DataScreen.serverWords(mapOf("usedBytes" to 0.0, "storageBytes" to 20 * gb), failed = false))
    assertEquals("1.5 ГБ / 40 ГБ", DataScreen.serverWords(mapOf("usedBytes" to 1.5 * gb, "storageBytes" to 40 * gb), failed = false))
    assertEquals("1.3 МБ", DataScreen.sizeWords(1.3 * 1024 * 1024, storage = false))
    assertEquals(DataScreen.sizeWords(0.0, storage = false), DataScreen.sizeWords(-5.0, storage = false))
  }

  @Test fun onlyTheDecryptedAttachmentsAreCountedAsTemporary() {
    val area = File(System.getProperty("java.io.tmpdir"), "invizent-look-test-" + System.nanoTime()).apply { mkdirs() }
    try {
      assertEquals(0L, DataScreen.temporaryBytes(area))
      File(area, "invizent-view-11111111-2222-3333-4444-555555555555").apply { mkdirs() }.resolve("photo.jpg").writeBytes(ByteArray(1500))
      File(area, "invizent-view-aaaaaaaa-2222-3333-4444-555555555555/deep").apply { mkdirs() }.resolve("file.pdf").writeBytes(ByteArray(700))
      // Something else of the app's in the same area is not a temporary file of this page.
      File(area, "avatars").apply { mkdirs() }.resolve("a.png").writeBytes(ByteArray(4000))
      File(area, "other.tmp").writeBytes(ByteArray(300))
      assertEquals(2200L, DataScreen.temporaryBytes(area))
      assertEquals(0L, DataScreen.temporaryBytes(File(area, "nothing-here")))
    } finally {
      area.deleteRecursively()
    }
  }
}
