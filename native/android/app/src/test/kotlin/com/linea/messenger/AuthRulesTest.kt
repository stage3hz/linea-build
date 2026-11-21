package com.linea.messenger

import com.linea.messenger.auth.AuthRules
import com.linea.messenger.auth.RecoveryGrant
import com.linea.messenger.auth.RecoveryStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The checks of the sign-in screen and the kept recovery request: the rules of native/ios/Sources/Auth/AuthRules.swift
 *  and RecoveryStore.swift (and, behind them, mobile/src/AuthScreen.tsx and mobile/src/auth/recoveryStorage.ts). */
class AuthRulesTest {
  @Test fun aLoginIsSentTrimmedAndInSmallLetters() {
    assertEquals("native_tester", AuthRules.name("  Native_Tester\n"))
    for (good in listOf("abc", "native_tester", "A1_", " abc ", "x".repeat(24))) assertTrue(good, AuthRules.validName(good))
    for (bad in listOf("", "ab", "x".repeat(25), "имя", "a b", "a-b", "a@b", "abé")) assertFalse(bad, AuthRules.validName(bad))
  }

  @Test fun aPublicNameLosesItsAtSign() {
    assertEquals("maria", AuthRules.handle(" @Maria "))
    assertEquals("maria", AuthRules.handle("maria"))
    assertEquals("@maria", AuthRules.handle("@@maria"))
  }

  @Test fun aSecretWordIsComposedAndInSmallLetters() {
    assertEquals("ambergardenprism", AuthRules.word("  AmberGardenPrism\n"))
    assertEquals("ёлка", AuthRules.word("ЁЛКА"))
    assertEquals("", AuthRules.word("   "))
  }

  @Test fun thePasswordOfSignInIsOnlyCounted() {
    assertTrue(AuthRules.passwordEntered("p"))
    assertTrue(AuthRules.passwordEntered("я".repeat(128)))
    assertTrue(AuthRules.passwordEntered("😀".repeat(128)))
    assertFalse(AuthRules.passwordEntered(""))
    assertFalse(AuthRules.passwordEntered("x".repeat(129)))
  }

  @Test fun aNewPasswordIsTenToAHundredAndTwentyEightSymbolsWithoutControlOnes() {
    val length = "Новый пароль: от 10 до 128 символов. Можно использовать длинную фразу."
    assertEquals(length, AuthRules.newPasswordError("123456789"))
    assertEquals("", AuthRules.newPasswordError("1234567890"))
    assertEquals("", AuthRules.newPasswordError("длинная фраза тоже подходит"))
    assertEquals("", AuthRules.newPasswordError("😀".repeat(10)))
    assertEquals("", AuthRules.newPasswordError("x".repeat(128)))
    assertEquals(length, AuthRules.newPasswordError("x".repeat(129)))
    // Counted composed: nine letters and one combining mark are nine symbols.
    assertEquals(length, AuthRules.newPasswordError("12345678ё"))
    assertEquals("В пароле есть недопустимый символ.", AuthRules.newPasswordError("12345\t67890"))
    assertEquals("В пароле есть недопустимый символ.", AuthRules.newPasswordError("1234567890\u007f"))
  }

  @Test fun aSecretWordIsFourToSixtyFourLettersAndDiffersFromTheRest() {
    val letters = "Слово: от 4 до 64 русских или английских букв, без пробелов."
    val differ = "Два слова должны отличаться друг от друга, пароля и логина."
    assertEquals("", AuthRules.wordError("Amber"))
    assertEquals("", AuthRules.wordError("  ёлка "))
    assertEquals("", AuthRules.wordError("я".repeat(64)))
    for (bad in listOf("", "abc", "two words", "amber1", "amber_", "я".repeat(65), "naïve")) assertEquals(bad, letters, AuthRules.wordError(bad))
    assertEquals(differ, AuthRules.wordError("Amber", password = "amber"))
    assertEquals(differ, AuthRules.wordError("amber", login = "Amber"))
    assertEquals(differ, AuthRules.wordError("amber", otherWord = " AMBER "))
    assertEquals("", AuthRules.wordError("amber", password = "amber-long-password", login = "tester", otherWord = "garden"))
    // «е» and «ё» are different letters.
    assertEquals("", AuthRules.wordError("елка", otherWord = "ёлка"))
  }

  @Test fun theCountdownShowsMinutesAndSecondsAndHoursWhenThereAreAny() {
    assertEquals("09:41", AuthRules.countdown(581_000.0, 0.0))
    assertEquals("09:41", AuthRules.countdown(580_001.0, 0.0))     // a started second counts
    assertEquals("00:00", AuthRules.countdown(0.0, 5_000.0))
    assertEquals("00:01", AuthRules.countdown(1.0, 0.0))
    assertEquals("23:59:59", AuthRules.countdown(86_399_000.0, 0.0))
    assertEquals("24:00:00", AuthRules.countdown(86_400_000.0, 0.0))
  }

  @Test fun onlyTypingChangesAFieldTypedByHand() {
    assertTrue(AuthRules.typedByHand("", "a"))
    assertTrue(AuthRules.typedByHand("ab", "abc"))
    assertTrue(AuthRules.typedByHand("ac", "abc"))        // in the middle
    assertTrue(AuthRules.typedByHand("abc", "ab"))        // deleting
    assertTrue(AuthRules.typedByHand("abcdef", ""))       // deleting a selection
    assertTrue(AuthRules.typedByHand("abcdef", "axf"))    // one symbol over a selection
    assertTrue(AuthRules.typedByHand("a", "a😀"))          // one symbol of two units
    assertTrue(AuthRules.typedByHand("same", "same"))
    assertFalse(AuthRules.typedByHand("", "ab"))          // a paste
    assertFalse(AuthRules.typedByHand("ab", "abcd"))
    assertFalse(AuthRules.typedByHand("abc", "xy"))       // a replacement of everything by two symbols
  }

  private val token = "A".repeat(20) + "b_-9" + "z".repeat(19)

  private fun kept(change: (MutableMap<String, Any?>, MutableMap<String, Any?>) -> Unit = { _, _ -> }): String {
    val grant = linkedMapOf<String, Any?>("resetToken" to token, "requestId" to "req-1", "readyAt" to "2026-11-21T07:10:00.000Z",
      "expiresAt" to "2026-11-21T07:30:00.000Z", "serverTime" to "2026-11-21T07:00:00.000Z")
    val value = linkedMapOf<String, Any?>("version" to 1, "base" to "https://api.invizent.com", "username" to "native_tester", "challenge" to grant)
    change(value, grant)
    return com.linea.messenger.core.Core.text(value)!!
  }

  @Test fun aRequestKeptByThePreviousAppIsReadBack() {
    // Exactly what `JSON.stringify` of mobile/src/auth/recoveryStorage.ts writes.
    val raw = """{"version":1,"base":"https://api.invizent.com","username":"native_tester","challenge":{"resetToken":"$token","requestId":"req-1","readyAt":"2026-11-21T07:10:00.000Z","expiresAt":"2026-11-21T07:30:00.000Z","serverTime":"2026-11-21T07:00:00.000Z"}}"""
    val saved = RecoveryStore.decode(raw)!!
    assertEquals(listOf("https://api.invizent.com", "native_tester", token, "req-1"), listOf(saved.base, saved.username, saved.grant.resetToken, saved.grant.requestId))
    assertEquals(600_000.0, saved.grant.readyMs - saved.grant.serverMs, 0.0)
    assertEquals(1_200_000.0, saved.grant.expiresMs - saved.grant.readyMs, 0.0)
    // And what this app writes is what that app would read: the same fields, nothing else.
    val written = RecoveryStore.encode(saved.base, saved.username, saved.grant)!!
    val again = com.linea.messenger.core.Core.map(com.linea.messenger.core.Core.value(written))!!
    assertEquals(setOf("version", "base", "username", "challenge"), again.keys)
    assertEquals(1.0, (again["version"] as Number).toDouble(), 0.0)
    assertEquals(setOf("resetToken", "requestId", "readyAt", "expiresAt", "serverTime"), com.linea.messenger.core.Core.map(again["challenge"])!!.keys)
    assertNotNull(RecoveryStore.decode(written))
  }

  @Test fun whatIsNotARequestIsNotTaken() {
    assertNotNull(RecoveryStore.decode(kept()))
    assertNull(RecoveryStore.decode(null))
    assertNull(RecoveryStore.decode("not json"))
    assertNull(RecoveryStore.decode("[]"))
    assertNull(RecoveryStore.decode(kept { value, _ -> value["version"] = 2 }))
    assertNull(RecoveryStore.decode(kept { value, _ -> value["base"] = "x".repeat(513) }))
    assertNull(RecoveryStore.decode(kept { value, _ -> value["username"] = "Native_Tester" }))
    assertNull(RecoveryStore.decode(kept { value, _ -> value["username"] = "ab" }))
    assertNull(RecoveryStore.decode(kept { value, _ -> value.remove("challenge") }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant["resetToken"] = token.dropLast(1) }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant["resetToken"] = token.dropLast(1) + "+" }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant["requestId"] = "" }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant["requestId"] = "r".repeat(129) }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant["readyAt"] = "soon" }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant["expiresAt"] = grant["readyAt"] }))
    assertNull(RecoveryStore.decode(kept { _, grant -> grant.remove("serverTime") }))
  }

  @Test fun aGrantIsReadFromTheServersAnswerAndFollowsItsLaterTimes() {
    assertNull(RecoveryGrant.from(null))
    assertNull(RecoveryGrant.from(mapOf("resetToken" to "t")))
    val grant = RecoveryGrant.from(mapOf("resetToken" to "t", "requestId" to "r", "readyAt" to "2026-11-21T07:10:00Z", "expiresAt" to "2026-11-21T07:30:00.000Z", "serverTime" to "2026-11-21T07:00:00.5Z"))!!
    assertEquals(599_500.0, grant.readyMs - grant.serverMs, 0.0)
    assertNull(grant.updated("2026-11-21T07:10:00Z", "", "2026-11-21T07:00:00Z"))
    val later = grant.updated("2026-11-21T07:10:00Z", "2026-11-21T07:30:00Z", "2026-11-21T07:10:01Z")!!
    assertEquals(listOf("t", "r"), listOf(later.resetToken, later.requestId))
    assertTrue(later.readyMs < later.serverMs)
  }
}
