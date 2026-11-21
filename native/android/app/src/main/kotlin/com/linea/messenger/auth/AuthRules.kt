package com.linea.messenger.auth

import java.text.Normalizer
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max

/** The checks of the sign-in screen, as `mobile/src/AuthScreen.tsx` makes them before anything is sent.
 *  The server repeats every one of them (`server/src/auth.js`): these only spare a round trip. */
object AuthRules {
  private fun symbols(text: String): Int = text.codePointCount(0, text.length)

  private fun composed(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFC)

  /** A login or a public @username as it is sent: without the spaces around, in lower case. */
  fun name(typed: String): String = typed.trim().lowercase(Locale.ROOT)

  /** 3–24 of a–z, 0–9 and «_» (after `name`). */
  fun validName(typed: String): Boolean {
    val made = name(typed)
    return made.length in 3..24 && made.all { it in 'a'..'z' || it in '0'..'9' || it == '_' }
  }

  const val nameError = "Логин: 3–24 символа — латинские буквы, цифры и знак _."
  const val passwordEntryError = "Введи свой пароль. Максимум — 128 символов."

  /** The public @username as typed on the profile step: no «@» in front, lower case. */
  fun handle(typed: String): String = typed.trim().removePrefix("@").lowercase(Locale.ROOT)

  /** A secret word as it is compared and sent: trimmed, composed (NFC), lower case. */
  fun word(typed: String): String = composed(typed.trim()).lowercase(Locale.ROOT)

  /** The password typed at sign-in: not empty, at most 128 symbols. */
  fun passwordEntered(value: String): Boolean = value.isNotEmpty() && symbols(value) <= 128

  /** What is wrong with a password being created; empty when nothing is. */
  fun newPasswordError(value: String): String {
    val count = symbols(composed(value))
    if (count < 10 || count > 128) return "Новый пароль: от 10 до 128 символов. Можно использовать длинную фразу."
    if (value.any { it.code <= 0x1F || it.code == 0x7F }) return "В пароле есть недопустимый символ."
    return ""
  }

  /** What is wrong with a secret word; empty when nothing is. The word must differ from the password, the login
   *  and the other word (those not given are not compared). */
  fun wordError(value: String, password: String = "", login: String = "", otherWord: String = ""): String {
    val made = word(value)
    val letters = made.length in 4..64 && made.all { it in 'a'..'z' || it in 'а'..'я' || it == 'ё' }
    if (!letters) return "Слово: от 4 до 64 русских или английских букв, без пробелов."
    if (made == word(password) || made == name(login) || made == word(otherWord)) return "Два слова должны отличаться друг от друга, пароля и логина."
    return ""
  }

  /** The time left until `until` (both in milliseconds): `MM:SS`, with the hours in front when there are any. */
  fun countdown(until: Double, now: Double): String {
    val seconds = max(0.0, ceil((until - now) / 1000)).toLong()
    val hours = seconds / 3600
    val rest = String.format(Locale.ROOT, "%02d:%02d", (seconds % 3600) / 60, seconds % 60)
    return if (hours > 0) String.format(Locale.ROOT, "%02d:", hours) + rest else rest
  }

  /** Whether a field's text changed the way typing changes it: at most one symbol put in at once (a paste, an
   *  autofill or a dictation puts in several). Deleting, and replacing a selection with one symbol, is typing.
   *  The rule of `mobile/src/auth/manualEdit.ts`. */
  fun typedByHand(previous: String, next: String): Boolean {
    if (previous == next) return true
    val before = previous.codePoints().toArray(); val after = next.codePoints().toArray()
    var start = 0
    while (start < before.size && start < after.size && before[start] == after[start]) start += 1
    var beforeEnd = before.size; var afterEnd = after.size
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] == after[afterEnd - 1]) { beforeEnd -= 1; afterEnd -= 1 }
    return afterEnd - start <= 1
  }
}
