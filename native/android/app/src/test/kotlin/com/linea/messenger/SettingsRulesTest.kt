package com.linea.messenger

import com.linea.messenger.net.ServerError
import com.linea.messenger.settings.BirthdayWords
import com.linea.messenger.settings.SessionWords
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsPrivacyModel
import com.linea.messenger.settings.UsernameSheet
import com.linea.messenger.settings.failureWords
import com.linea.messenger.settings.refusalStatus
import com.linea.messenger.settings.signOutNotice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

/** The words and rules of «Настройки» that need no phone: the same as native/ios/Sources/Settings. */
class SettingsRulesTest {
  @Test fun aBirthdayIsKeptWithOrWithoutItsYear() {
    assertEquals(BirthdayWords.Day(2, 3, null), BirthdayWords.parse("03-02"))
    assertEquals(BirthdayWords.Day(2, 3, 1999), BirthdayWords.parse("1999-03-02"))
    for (bad in listOf(null, "", "3-2", "03/02", "99-03-02", "1999-3-2", "03-0a", "1999-03-02-01", "03--2")) assertNull(bad, BirthdayWords.parse(bad))
    assertEquals("2 мар", BirthdayWords.format("03-02"))
    assertEquals("2 мар 1999", BirthdayWords.format("1999-03-02"))
    assertEquals("31 дек", BirthdayWords.format("12-31"))
    assertEquals("", BirthdayWords.format("13-01"))
    assertEquals("", BirthdayWords.format(null))
    assertEquals("03-02", BirthdayWords.value(BirthdayWords.Day(2, 3, null)))
    assertEquals("1999-12-31", BirthdayWords.value(BirthdayWords.Day(31, 12, 1999)))
  }

  @Test fun februaryHasTwentyNineDaysUnlessTheYearSaysOtherwise() {
    assertEquals(29, BirthdayWords.daysInMonth(2, null))
    assertEquals(28, BirthdayWords.daysInMonth(2, 1999))
    assertEquals(29, BirthdayWords.daysInMonth(2, 2024))
    assertEquals(28, BirthdayWords.daysInMonth(2, 1900))
    assertEquals(30, BirthdayWords.daysInMonth(4, null))
    assertEquals(31, BirthdayWords.daysInMonth(12, 2000))
    assertEquals(31, BirthdayWords.daysInMonth(0, null))
    assertEquals(12, BirthdayWords.months.size)
    assertEquals(12, BirthdayWords.monthsShort.size)
  }

  @Test fun aSessionSaysWhatDeviceItIs() {
    val phone = mapOf<String, Any?>("deviceModel" to "Samsung SM-S911B", "deviceName" to "Android", "platform" to "android", "osVersion" to "Android 15", "appVersion" to "0.17.0", "ip" to "203.0.113.7")
    assertEquals("Samsung SM-S911B", SessionWords.name(phone, "Устройство"))
    assertEquals("Samsung SM-S911B · Android 15", SessionWords.loginLabel(phone))
    assertEquals("Android 15 · Инвиз 0.17.0", SessionWords.subtitle(phone))
    assertEquals("ion:phone-portrait-outline", SessionWords.symbol(phone))
    assertEquals("203.0.113.7", SessionWords.address(phone))
    assertEquals("ion:tablet-portrait-outline", SessionWords.symbol(mapOf("platform" to "ios", "deviceModel" to "iPad Pro")))
    assertEquals("ion:globe-outline", SessionWords.symbol(mapOf("platform" to "web")))
    assertEquals("ion:desktop-outline", SessionWords.symbol(mapOf("platform" to "windows")))
    // An old session without a platform is told by the name it gave.
    assertEquals("ion:phone-portrait-outline", SessionWords.symbol(mapOf("deviceName" to "Google Pixel 9")))
    assertEquals("ion:desktop-outline", SessionWords.symbol(mapOf("deviceName" to "Firefox")))
    val bare = emptyMap<String, Any?>()
    assertEquals("Устройство", SessionWords.name(bare, "Устройство"))
    assertEquals("Имя", SessionWords.name(mapOf("deviceName" to "Имя"), "Устройство"))
    assertEquals("Неизвестное устройство", SessionWords.loginLabel(bare))
    assertEquals("", SessionWords.subtitle(bare))
    assertEquals("Инвиз 0.14.13", SessionWords.subtitle(mapOf("appVersion" to "0.14.13")))
  }

  @Test fun thisDeviceIsFirstThenTheNewestSignIns() {
    val sessions = listOf(
      mapOf<String, Any?>("id" to "old", "createdAt" to "2026-11-01T10:00:00.000Z"),
      mapOf<String, Any?>("id" to "here", "isCurrent" to true, "createdAt" to "2026-11-10T10:00:00.000Z"),
      mapOf<String, Any?>("id" to "new", "createdAt" to "2026-11-20T10:00:00.000Z"),
      mapOf<String, Any?>("id" to "undated"),
    )
    assertEquals(listOf("here", "new", "old", "undated"), SessionWords.ordered(sessions).map { it["id"] })
  }

  @Test fun theTimeOfComingIsSummedUpInOneLine() {
    assertEquals("everyone", SettingsPrivacyModel.lastSeenMode(null))
    assertEquals("everyone", SettingsPrivacyModel.lastSeenMode(mapOf("showLastSeen" to true)))
    // An old server only knows the switch.
    assertEquals("nobody", SettingsPrivacyModel.lastSeenMode(mapOf("showLastSeen" to false)))
    assertEquals("contacts", SettingsPrivacyModel.lastSeenMode(mapOf("lastSeen" to "contacts", "showLastSeen" to false)))
    assertEquals("Все", SettingsPrivacyModel.lastSeenSummary("everyone", -1, -1))
    assertEquals("Все (−1)", SettingsPrivacyModel.lastSeenSummary("everyone", 5, 1))
    assertEquals("Мои друзья (−1, +2)", SettingsPrivacyModel.lastSeenSummary("contacts", 2, 1))
    assertEquals("Никто (+3)", SettingsPrivacyModel.lastSeenSummary("nobody", 3, 4))
    assertEquals("Никто", SettingsPrivacyModel.lastSeenSummary("nobody", 0, 0))
    assertEquals("Все", SettingsPrivacyModel.lastSeenSummary("something new", 0, 0))
  }

  @Test fun aServerTimeIsShownOnTheClockOfThePlace() {
    val moscow = ZoneId.of("Europe/Moscow")
    assertEquals("5 мар., 14:05", SettingsLook.moment("2026-03-05T11:05:00.000Z", moscow))
    assertEquals("21 нояб., 00:30", SettingsLook.moment("2026-11-20T21:30:00Z", moscow))
    assertEquals("Неизвестно", SettingsLook.moment(null, moscow))
    assertEquals("Неизвестно", SettingsLook.moment("yesterday", moscow))
    assertEquals("5 марта, 14:05", SettingsLook.longMomentWords("2026-03-05T11:05:00.000Z", moscow))
    assertEquals("", SettingsLook.longMomentWords("", moscow))
  }

  @Test fun leavingSaysWhatTheServerDidNotConfirm() {
    assertEquals("", signOutNotice(null))
    assertEquals("", signOutNotice(ServerError.Refused("Войдите заново", 401, null, emptyMap())))
    assertEquals("Выход выполнен на этом устройстве. Сервер не подтвердил отзыв удалённой сессии.", signOutNotice(ServerError.Refused("Ошибка", 500, null, emptyMap())))
    assertEquals("Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось.", signOutNotice(ServerError.Network("Нет связи")))
    assertEquals("Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось.", signOutNotice(ServerError.Timeout()))
  }

  @Test fun aFailureGivesItsStatusAndItsWords() {
    val refused: Result<Any?> = Result.failure(ServerError.Refused("Слишком часто", 429, "RATE", emptyMap()))
    assertEquals(429, refused.refusalStatus)
    assertEquals("Слишком часто", refused.failureWords("Не удалось."))
    val silent: Result<Any?> = Result.failure(ServerError.Network(""))
    assertEquals(0, silent.refusalStatus)
    assertEquals("Не удалось.", silent.failureWords("Не удалось."))
    assertEquals(0, Result.success(1).refusalStatus)
  }

  @Test fun thePublicNameSaysHowOftenItCanBeChanged() {
    assertEquals("Публичное имя можно менять раз в неделю, с Platina — раз в день.", UsernameSheet.changeWords(canChange = true, platina = false, later = ""))
    assertEquals("С Platina публичное имя можно менять раз в день.", UsernameSheet.changeWords(canChange = true, platina = true, later = "5 марта, 14:05"))
    assertEquals("Имя можно менять раз в неделю, с Platina — раз в день. Следующая смена — 5 марта, 14:05.", UsernameSheet.changeWords(canChange = false, platina = false, later = "5 марта, 14:05"))
    assertEquals("С Platina имя можно менять раз в день.", UsernameSheet.changeWords(canChange = false, platina = true, later = ""))
    assertEquals("@maria → @masha\n\nЛогин для входа «native_tester», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.\n\nСледующая смена будет доступна через неделю, с Platina — через день.",
      UsernameSheet.reviewWords("maria", "masha", "native_tester", platina = false))
  }
}
