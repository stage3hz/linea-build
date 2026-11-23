package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.TextView
import com.linea.messenger.auth.AuthScreen
import com.linea.messenger.net.ServerError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.TimeUnit

/** The whole sign-in screen, built and driven on the JVM: signing in, creating an account in five steps, a
 *  forgotten password. The "server" is a function of the test (`AuthScreen.ask`): nothing leaves this machine.
 *  Each step is saved as a picture in build/pages/. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AuthPagesTest {
  private class Asked(val name: String, val args: List<Any?>)

  private lateinit var activity: MainActivity
  private lateinit var page: View
  private lateinit var auth: AuthScreen
  private val asked = ArrayList<Asked>()
  private val ended = ArrayList<String>()
  private var signedIn: String? = null
  /** What the "server" answers to the next request. */
  private var answer: (name: String, args: List<Any?>) -> Result<Any?> = { _, _ -> Result.failure(ServerError.Network("Нет связи с сервером.")) }

  private fun launch(intent: Intent = Intent(Intent.ACTION_MAIN).putExtra("auth", true)) {
    activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    page = activity.window.decorView
    auth = find(page) { it is AuthScreen } as AuthScreen
    auth.ask = { name, args, done -> asked.add(Asked(name, args)); done(answer(name, args)) }
    auth.endSession = { token -> ended.add(token) }
    auth.onSignedIn = { token, _ -> signedIn = token }
    idle()
  }

  private fun idle(ms: Long = 50) = shadowOf(activity.mainLooper).idleFor(ms, TimeUnit.MILLISECONDS)

  private fun shot(name: String) {
    idle()
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun shown(view: View): Boolean = view.visibility == View.VISIBLE && (view.parent as? View)?.let { shown(it) } != false

  private fun find(view: View, test: (View) -> Boolean): View? {
    if (test(view)) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), test)?.let { return it }
    return null
  }

  private fun texts(view: View = page, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    if (view is TextView && view !is EditText) into.add(view.text.toString())
    // Effects: the drawn parts of the screen (the wordmark, the title's words, the button with states).
    if (view is com.linea.messenger.effects.WordmarkView) into.add("Инвиз")
    if (view is com.linea.messenger.effects.AppearingTextView) into.add(view.text)
    if (view is com.linea.messenger.effects.ActionButton) { into.add(view.label); if (view.shownText != view.label) into.add(view.shownText) }
    if (view is ViewGroup) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  /** The field with this caption (as a screen reader names it), when it is on the screen. */
  private fun field(caption: String): EditText = find(page) { it is EditText && it.contentDescription == caption && shown(it) } as EditText

  /** Types as a person does: one symbol at a time. */
  private fun type(caption: String, text: String) {
    val field = field(caption)
    for (symbol in text.codePoints().toArray()) field.text.append(String(Character.toChars(symbol)))
  }

  /** Presses what carries these words: the text itself, or the button it is in. */
  private fun press(words: String) {
    val label = find(page) { (it is TextView && it.text.toString() == words || it is com.linea.messenger.effects.ActionButton && (it.label == words || it.shownText == words)) && shown(it) }
    assertNotNull("No «$words» on the screen: ${texts()}", label)
    var target: View? = label
    while (target != null && !target.isClickable) target = target.parent as? View
    assertTrue(target!!.performClick())
    idle()
  }

  /** Presses the screen's main button, whatever it says now. */
  private fun submit() {
    assertTrue(find(page) { it is com.linea.messenger.effects.ActionButton && shown(it) }!!.performClick())
    idle()
  }

  private fun has(vararg words: String) { val all = texts(); for (word in words) assertTrue("No «$word» in $all", all.contains(word)) }
  private fun hasNot(vararg words: String) { val all = texts(); for (word in words) assertFalse("«$word» is in $all", all.contains(word)) }

  @Test fun signingInGoesStepByStepAndChecksEachOne() {
    launch()
    has("Инвиз", "Логин", "Войти", "Создать аккаунт", "1 / 3", "Продолжить", "Забыл пароль?", "Только ручной ввод. Вставка и автозаполнение отключены.")
    // AuthScreen.tsx:361-362: the three trust chips under the card; no motto under the wordmark (AuthScreen.tsx:317-320).
    has("Сквозное шифрование", "Без почты и SMS", "Ключи только у тебя")
    hasNot("Назад", "Твоя линия связи.")
    type("Логин", "ab"); press("Продолжить")
    has("Логин: 3–24 символа — латинские буквы, цифры и знак _.", "Логин")
    type("Логин", "c"); press("Продолжить")
    has("Пароль", "Назад", "Продолжить", "2 / 3")
    shot("06-auth-password")
    press("Продолжить")
    has("Введи свой пароль. Максимум — 128 символов.")
    type("Пароль", "a password")
    // The password being entered is hidden as it is typed; the eye shows it.
    assertTrue(field("Пароль").transformationMethod is PasswordTransformationMethod)
    field("Пароль").onEditorAction(EditorInfo.IME_ACTION_GO); idle()
    has("Слово подтверждения", "Войти в Инвиз", "Назад", "3 / 3")
    assertTrue(field("Слово подтверждения").transformationMethod is PasswordTransformationMethod)
    // Back from the word: the password is asked again; back again: the login is still there.
    press("Назад"); has("Пароль"); assertEquals("", field("Пароль").text.toString())
    press("Назад"); has("1 / 3"); assertEquals("abc", field("Логин").text.toString())
    assertEquals(0, asked.size)
  }

  @Test fun aPasteIsTurnedBack() {
    launch()
    val field = field("Логин")
    field.setText("pasted_login")
    idle()
    assertEquals("", field.text.toString())
    has("Введи по одному символу. Вставка и автозаполнение отключены.")
    type("Логин", "abc")
    assertEquals("abc", field.text.toString())
    hasNot("Введи по одному символу. Вставка и автозаполнение отключены.")
    // Nothing over the limit of the login is taken.
    type("Логин", "x".repeat(30))
    assertEquals(24, field.text.length)
  }

  private fun signIn(word: String = "amber") {
    type("Логин", "Native_Tester"); press("Продолжить")
    type("Пароль", "a long password"); press("Продолжить")
    type("Слово подтверждения", word); press("Войти в Инвиз")
  }

  @Test fun aWrongSignInGoesBackToTheLoginWithTheTriesLeft() {
    launch()
    answer = { _, _ -> Result.failure(ServerError.Refused("Неверные данные", 401, "LOGIN_FAILED", mapOf("attemptsLeft" to 4.0))) }
    signIn(" Amber ")
    assertEquals("login", asked.single().name)
    assertEquals(listOf("native_tester", "a long password", "amber"), asked.single().args)
    has("Неверный логин, пароль или слово подтверждения. Осталось попыток: 4.", "1 / 3")
    // The login stays; neither secret does.
    assertEquals("native_tester", field("Логин").text.toString().lowercase())
    press("Продолжить")
    assertEquals("", field("Пароль").text.toString())
    shot("06-auth-refused")
  }

  @Test fun afterFiveWrongSignInsTheEntranceIsClosedForAWhile() {
    launch()
    answer = { _, _ -> Result.failure(ServerError.Refused("Слишком много попыток", 429, "LOGIN_LOCKED", mapOf("retryAfterSeconds" to 300.0))) }
    signIn()
    has("Слишком много неверных попыток. Вход снова откроется через 5 минут.", "Вход временно закрыт. Попробуй через 5:00.", "Подожди 5:00")
    shot("06-auth-locked")
    // A minute later the countdown has moved, and the entrance is still closed.
    idle(61_000)
    assertTrue(texts().toString(), texts().any { Regex("Вход временно закрыт\\. Попробуй через (3:5[0-9]|4:00)\\.").matches(it) })
    idle(240_000)
    assertFalse(texts().any { it.startsWith("Вход временно закрыт") })
    has("Продолжить")
  }

  @Test fun aGoodSignInShowsDoneAndThenOpensTheAccount() {
    launch()
    answer = { _, _ -> Result.success(mapOf("token" to "token-1", "user" to mapOf("id" to "u1", "displayName" to "Тест"))) }
    signIn()
    has("Готово")
    assertEquals(null, signedIn)
    idle(600)
    assertEquals("token-1", signedIn)
    assertEquals(emptyList<String>(), ended)
  }

  @Test fun anAnswerWithoutASessionIsNotASignIn() {
    launch()
    answer = { _, _ -> Result.success(mapOf("ok" to true)) }
    signIn()
    has("Не удалось выполнить запрос. Попробуй ещё раз.", "1 / 3")
    assertEquals(null, signedIn)
  }

  @Test fun anAccountIsCreatedInFiveSteps() {
    launch()
    press("Создать аккаунт")
    has("Логин", "1 / 5", "Всё вводится один раз. Перед тем как идти дальше, проверь, что нет опечатки.")
    has("Это твой логин для входа. Его видишь только ты, и сменить его потом нельзя. Публичный @юзернейм задашь на следующем шаге — он будет другим. Запомни логин или запиши в надёжное место.")
    hasNot("Забыл пароль?")
    shot("10-register-name")
    type("Логин", "native_tester"); press("Продолжить")

    has("Профиль", "2 / 5", "По @юзернейму тебя найдут. Логин для входа другой, его не видит никто.")
    press("Продолжить"); has("Имя: от 1 до 50 символов.")
    type("Имя", "Мария Орлова"); press("Продолжить"); has("@юзернейм: 3–24 символа — латинские буквы, цифры и знак _.")
    type("Публичный @юзернейм", "@native_tester"); press("Продолжить"); has("@юзернейм должен отличаться от логина: логин никто не должен видеть.")
    // A space is not taken in the public name at all.
    val handle = field("Публичный @юзернейм")
    for (index in 0 until 14) handle.text.delete(handle.text.length - 1, handle.text.length)
    type("Публичный @юзернейм", "@Ma ria")
    assertEquals("@Maria", handle.text.toString())
    shot("11-register-profile")
    press("Продолжить")

    has("Пароль", "3 / 5", "От 10 до 128 символов. Длинная фраза тоже подходит.")
    // A secret being created is typed once, so it is shown while typed.
    assertEquals(null, field("Пароль").transformationMethod)
    type("Пароль", "short"); press("Продолжить"); has("Новый пароль: от 10 до 128 символов. Можно использовать длинную фразу.")
    type("Пароль", " but long enough")
    shot("12-register-password")
    press("Продолжить")

    has("Слово подтверждения", "4 / 5", "От 4 до 64 русских или английских букв, без пробелов. Регистр не важен; «е» и «ё» различаются.")
    type("Слово подтверждения", "abc"); press("Продолжить"); has("Слово: от 4 до 64 русских или английских букв, без пробелов.")
    type("Слово подтверждения", "d")
    shot("13-register-confirmation")
    press("Продолжить")

    has("Слово восстановления", "5 / 5", "Создать аккаунт", "Запомни оба слова и храни их отдельно. В приложении их нельзя будет посмотреть повторно.")
    type("Слово восстановления", "ABCD"); submit(); has("Два слова должны отличаться друг от друга, пароля и логина.")
    assertEquals(0, asked.size)
    type("Слово восстановления", "ёж")
    shot("14-register-recovery")

    // A taken public name is fixed on the profile step; nothing typed is lost.
    answer = { _, _ -> Result.failure(ServerError.Refused("Этот @юзернейм уже занят.", 409, null, emptyMap())) }
    submit()
    assertEquals("register", asked.single().name)
    assertEquals(listOf("native_tester", "short but long enough", "Мария Орлова", "abcd", "abcdёж", "maria"), asked.single().args)
    has("Профиль", "2 / 5", "Этот @юзернейм уже занят.")
    press("Продолжить"); press("Продолжить"); press("Продолжить")
    has("5 / 5")
    answer = { _, _ -> Result.success(mapOf("token" to "token-2", "user" to mapOf("id" to "u2"))) }
    submit()
    has("Готово")
    idle(600)
    assertEquals("token-2", signedIn)
  }

  @Test fun leavingTheScreenClosesASessionNobodyWaitsFor() {
    launch()
    answer = { _, _ -> Result.success(mapOf("token" to "token-3", "user" to mapOf("id" to "u3"))) }
    signIn()
    // The screen is taken away before «Готово» has passed.
    (auth.parent as ViewGroup).removeView(auth)
    idle(600)
    assertEquals(null, signedIn)
    assertEquals(listOf("token-3"), ended)
  }

  private val grant = mapOf<String, Any?>("resetToken" to "r".repeat(43), "requestId" to "req-1")

  private fun times(readyIn: Long, now: Long = System.currentTimeMillis()): Map<String, Any?> = mapOf(
    "readyAt" to java.time.Instant.ofEpochMilli(now + readyIn).toString(), "expiresAt" to java.time.Instant.ofEpochMilli(now + readyIn + 1_200_000).toString(),
    "serverTime" to java.time.Instant.ofEpochMilli(now).toString())

  @Test fun aForgottenPasswordIsAWordAWaitAndANewPassword() {
    launch()
    press("Забыл пароль?")
    has("Восстановление", "Подтвердить слово", "Вернуться ко входу", "Введи логин и слово восстановления. После подтверждения нужно будет подождать 10 минут.",
      "Всего 3 неверные попытки, затем восстановление блокируется на 24 часа. Вход с паролем и словом подтверждения остаётся доступен.")
    hasNot("Войти", "1 / 3")
    shot("15-recover")
    type("Логин", "native_tester")
    type("Слово восстановления", "ab"); press("Подтвердить слово")
    has("Слово: от 4 до 64 русских или английских букв, без пробелов.")
    assertEquals(0, asked.size)

    // A wrong word: the server says how many tries are left.
    answer = { _, _ -> Result.failure(ServerError.Refused("Неверное слово восстановления.", 401, null, mapOf("attemptsRemaining" to 2.0))) }
    type("Слово восстановления", "cd"); press("Подтвердить слово")
    assertEquals(listOf("native_tester", "abcd"), asked.single().args)
    has("Неверное слово восстановления.", "По ответу сервера осталось попыток: 2 из 3.")
    assertEquals("", field("Слово восстановления").text.toString())

    // The third wrong word closes the recovery of this login for a day.
    answer = { _, _ -> Result.failure(ServerError.Refused("Восстановление заблокировано.", 429, null, mapOf("attemptsRemaining" to 0.0, "retryAfterSeconds" to 86_400.0))) }
    type("Слово восстановления", "wrong"); press("Подтвердить слово")
    has("Восстановление временно заблокировано. Повторная попытка через 24:00:00. Ограничение действует на сервере.")
    assertFalse(field("Слово восстановления").isEnabled)
    shot("15-recover-locked")
  }

  @Test fun theWaitingPeriodIsCountedDownAndAskedFromTheServer() {
    launch()
    press("Забыл пароль?")
    type("Логин", "native_tester")
    type("Слово восстановления", "garden")
    answer = { name, _ -> if (name == "verifyRecovery") Result.success(grant + times(600_000)) else Result.success(grant + times(590_000) + mapOf("status" to "waiting")) }
    press("Подтвердить слово")
    has("Ожидание", "Проверить статус", "Запрос для логина native_tester", "Вернуться ко входу",
      "Слово восстановления подтверждено. Через 10 минут сервер разрешит задать новый пароль.",
      "Переход ко входу удалит запрос с этого устройства. Продолжить его здесь после этого не получится.")
    hasNot("Только ручной ввод. Вставка и автозаполнение отключены.")
    // The word is confirmed, and the server is asked about the request at once.
    assertEquals(listOf("verifyRecovery", "recoveryStatus"), asked.map { it.name })
    assertEquals(listOf("r".repeat(43)), asked.last().args)
    assertTrue(texts().any { Regex("0[89]:[0-5][0-9]").matches(it) })
    shot("16-waiting")

    // Every ten seconds it is asked again.
    idle(11_000)
    assertEquals(3, asked.size)
    // Another request's answer is not taken for this one.
    answer = { _, _ -> Result.success(mapOf("requestId" to "other", "status" to "ready") + times(0)) }
    press("Проверить статус")
    has("Ожидание", "Не удалось проверить состояние запроса.")

    // Ready: the new password is asked.
    answer = { _, _ -> Result.success(grant + times(-1_000) + mapOf("status" to "ready")) }
    press("Проверить статус")
    has("Новый пароль", "Сохранить новый пароль", "Сервер разрешил сменить пароль. Оба секретных слова останутся прежними.")
    assertTrue(texts().any { it.startsWith("Подтверждение действительно ещё 19:5") })
    shot("17-reset")
    type("Новый пароль", "short"); press("Сохранить новый пароль")
    has("Новый пароль: от 10 до 128 символов. Можно использовать длинную фразу.")
    type("Новый пароль", " but long enough")
    val before = asked.size
    answer = { _, _ -> Result.success(mapOf("ok" to true)) }
    press("Сохранить новый пароль")
    assertEquals("resetPassword", asked[before].name)
    assertEquals(listOf("r".repeat(43), "short but long enough"), asked[before].args)
    has("Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и прежним словом подтверждения.", "1 / 3")
    assertEquals("", field("Логин").text.toString())
  }

  @Test fun aRequestTheServerNoLongerKnowsStartsOver() {
    launch()
    press("Забыл пароль?")
    type("Логин", "native_tester")
    type("Слово восстановления", "garden")
    answer = { name, _ -> if (name == "verifyRecovery") Result.success(grant + times(600_000)) else Result.failure(ServerError.Refused("Запрос отменён.", 410, null, emptyMap())) }
    press("Подтвердить слово")
    has("Восстановление", "Запрос отменён, уже использован или его срок закончился. Можно начать восстановление заново.")
    hasNot("Ожидание")
  }

  @Test fun theTimeForTheNewPasswordRunsOut() {
    launch()
    press("Забыл пароль?")
    type("Логин", "native_tester")
    type("Слово восстановления", "garden")
    // Ready at once, and valid for five seconds more.
    val now = System.currentTimeMillis()
    val short = mapOf<String, Any?>("readyAt" to java.time.Instant.ofEpochMilli(now - 1000).toString(), "expiresAt" to java.time.Instant.ofEpochMilli(now + 5000).toString(),
      "serverTime" to java.time.Instant.ofEpochMilli(now).toString())
    val ready = mapOf<String, Any?>("status" to "ready")
    answer = { name, _ -> Result.success(if (name == "verifyRecovery") grant + short else grant + short + ready) }
    press("Подтвердить слово")
    has("Новый пароль")
    idle(7_000)
    has("Восстановление", "Время для смены пароля закончилось. Начни восстановление заново.")
  }

  @Test fun goingBackToSigningInDropsTheRequest() {
    launch()
    press("Забыл пароль?")
    type("Логин", "native_tester")
    type("Слово восстановления", "garden")
    answer = { name, _ -> if (name == "verifyRecovery") Result.success(grant + times(600_000)) else Result.success(grant + times(600_000) + mapOf("status" to "waiting")) }
    press("Подтвердить слово")
    has("Ожидание")
    press("Вернуться ко входу")
    has("1 / 3", "Забыл пароль?")
    assertEquals("", field("Логин").text.toString())
    // Nothing more is asked about the request that was left.
    val before = asked.size
    idle(25_000)
    assertEquals(before, asked.size)
  }

  @Test fun theLaunchArgumentsOpenEachFlow() {
    fun open(mode: String) = launch(Intent(Intent.ACTION_MAIN).putExtra("auth", true).putExtra("authmode", mode))
    open("register"); has("1 / 5", "Создать аккаунт"); shot("20-authmode-register")
    open("recover"); has("Восстановление", "Подтвердить слово"); shot("21-authmode-recover")
    open("waiting")
    has("Ожидание", "Запрос для логина nativetester", "Проверить статус")
    assertTrue(texts().any { Regex("09:[34][0-9]").matches(it) })
    shot("22-authmode-waiting")
    // The made-up request asks no server, however long it is looked at, and pressing the button asks none either.
    idle(30_000); press("Проверить статус")
    assertEquals(0, asked.size)
    open("reset")
    has("Новый пароль", "Сохранить новый пароль", "Сервер разрешил сменить пароль. Оба секретных слова останутся прежними.")
    assertTrue(texts().any { it.startsWith("Подтверждение действительно ещё 1") })
    shot("23-authmode-reset")
    type("Новый пароль", "long enough password"); press("Сохранить новый пароль")
    assertEquals(0, asked.size)
    // Back to signing in, the plain screen.
    press("Вернуться ко входу"); has("1 / 3")
  }
}
