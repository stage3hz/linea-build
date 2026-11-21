package com.linea.messenger

import android.app.AlertDialog
import android.content.DialogInterface
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import com.linea.messenger.net.ServerError
import com.linea.messenger.settings.BirthdayScreen
import com.linea.messenger.settings.OwnProfile
import com.linea.messenger.settings.SettingsAccount
import com.linea.messenger.settings.SettingsScreen
import com.linea.messenger.shell.Navigation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAlertDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** The pages of «Настройки», built and driven on the JVM. The account behind them is one of the test
 *  (`SettingsAccount`): nothing leaves this machine. Each page is saved as a picture in build/pages/. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsPagesTest {
  private class Asked(val name: String, val args: List<Any?>)

  private class Account : SettingsAccount {
    override val userId = "u1"
    override val base = ""
    var profile: Map<String, Any?> = mapOf("id" to "u1", "displayName" to "Мария Орлова", "username" to "maria", "avatarColor" to "#9271C3", "bio" to "Пишу код", "birthday" to "1999-03-02", "gender" to "female")
    override val ownProfile: Map<String, Any?> get() = profile
    val asked = ArrayList<Asked>()
    val answers = HashMap<String, (List<Any?>) -> Result<Map<String, Any?>>>()
    var refreshed = 0
    var endedWith: String? = null
    var signOut: Result<String> = Result.success("")

    fun answer(name: String, body: Map<String, Any?>) { answers[name] = { Result.success(body) } }
    fun refuse(name: String, words: String, status: Int = 400) { answers[name] = { Result.failure(ServerError.Refused(words, status, null, emptyMap())) } }
    fun last(name: String): List<Any?> = asked.last { it.name == name }.args
    fun count(name: String): Int = asked.count { it.name == name }

    override fun keepOwnProfile(fresh: Map<String, Any?>) { profile = fresh; OwnProfile.tell() }
    override fun accountCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
      asked.add(Asked(name, args))
      // As the real one: the answer comes later, on the main thread.
      android.os.Handler(android.os.Looper.getMainLooper()).post { done(answers[name]?.invoke(args) ?: Result.failure(ServerError.Network("Нет связи с сервером."))) }
    }
    override fun refreshOwnProfile() { refreshed += 1 }
    override fun prepareSettingsAvatars() {}
    override fun signOut(done: (Result<String>) -> Unit) = done(signOut)
    override fun sessionEndedHere(words: String): String { endedWith = words; return words }
  }

  private lateinit var activity: MainActivity
  private lateinit var page: View
  private lateinit var stack: Navigation
  private lateinit var settings: SettingsScreen
  private val account = Account()

  /** The shell with the sample chats, and over it the settings of the test's account. */
  private fun launch() {
    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true)).setup().get()
    page = activity.window.decorView
    stack = find(page) { it is Navigation } as Navigation
    settings = SettingsScreen(activity, account)
    stack.push(settings, animated = false)
    idle()
  }

  private fun idle(ms: Long = 500) = shadowOf(activity.mainLooper).idleFor(ms, TimeUnit.MILLISECONDS)

  private fun shot(name: String) {
    idle()
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun find(view: View, test: (View) -> Boolean): View? {
    if (test(view)) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), test)?.let { return it }
    return null
  }

  /** The page on top of the stack: what the person looks at. */
  private val top: View get() = stack.top!!
  private val topName: String get() = top.javaClass.simpleName

  private fun texts(view: View = top, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    if (view is TextView && view !is EditText && view !is Switch) into.add(view.text.toString())
    if (view is ViewGroup) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun has(vararg words: String) { val all = texts(); for (word in words) assertTrue("No «$word» in $all", all.contains(word)) }
  private fun hasNot(vararg words: String) { val all = texts(); for (word in words) assertFalse("«$word» is in $all", all.contains(word)) }

  /** Presses what carries these words on the top page: the text itself, or the row or button it is in. */
  private fun press(words: String) {
    val label = find(top) { it is TextView && it.text.toString() == words && it.isShown }
    assertNotNull("No «$words» on $topName: ${texts()}", label)
    var target: View? = label
    while (target != null && !target.isClickable) target = target.parent as? View
    assertTrue(target!!.isEnabled)
    assertTrue(target.performClick())
    idle()
  }

  /** Whether what carries these words can be pressed now. */
  private fun enabled(words: String): Boolean {
    var target: View? = find(top) { it is TextView && it.text.toString() == words && it.isShown }
    while (target != null && !target.isClickable) target = target.parent as? View
    return target!!.isEnabled
  }

  private fun field(name: String): EditText = find(top) { it is EditText && it.contentDescription == name && it.isShown } as EditText
  private fun toggle(name: String): Switch = find(top) { it is Switch && it.contentDescription == name } as Switch

  private fun dialog(): AlertDialog = ShadowAlertDialog.getLatestAlertDialog()!!
  private fun dialogWords(): String = shadowOf(dialog()).message?.toString() ?: ""
  private fun agree() { dialog().getButton(DialogInterface.BUTTON_POSITIVE).performClick(); idle() }

  private val privacy = mapOf<String, Any?>("lastSeen" to "contacts", "showLastSeen" to true, "allowNewChats" to true, "showAvatar" to true, "readReceipts" to true, "posts" to "friends", "calls" to "everyone", "hideReadTime" to false)
  private val sessions = listOf(
    mapOf<String, Any?>("id" to "s-old", "deviceModel" to "iPhone 16", "platform" to "ios", "osVersion" to "iOS 18.1", "appVersion" to "0.16.2", "ip" to "198.51.100.4",
      "createdAt" to "2026-11-01T10:00:00.000Z", "lastActiveAt" to "2026-11-20T18:30:00.000Z", "expiresAt" to "2026-12-20T10:00:00.000Z"),
    mapOf<String, Any?>("id" to "s-here", "isCurrent" to true, "deviceModel" to "Google Pixel 9", "platform" to "android", "osVersion" to "Android 15", "appVersion" to "0.17.0", "ip" to "203.0.113.7",
      "createdAt" to "2026-11-10T10:00:00.000Z", "lastActiveAt" to "2026-11-21T07:00:00.000Z", "expiresAt" to "2026-12-21T10:00:00.000Z"),
  )

  private fun everythingAnswers() {
    account.answer("privacy", mapOf("privacy" to privacy, "platina" to false))
    account.answer("lastSeenRules", mapOf("allow" to listOf("a", "b"), "deny" to listOf("c")))
    account.answer("security", mapOf("confirmationConfigured" to true, "recoveryConfigured" to false))
    account.answer("sessions", mapOf("sessions" to sessions))
    account.answer("blocks", mapOf("users" to listOf(mapOf("id" to "u7", "displayName" to "Лев Никитин", "username" to "lev", "avatarColor" to "#4088C7"))))
    account.answer("usernameStatus", mapOf("accountId" to "u1", "username" to "maria", "loginName" to "native_tester", "canChangeUsername" to true, "platina" to mapOf("active" to false)))
  }

  @Test fun theSectionShowsWhoIsSignedInAndWhatCanBeSetUp() {
    launch()
    assertEquals("SettingsScreen", topName)
    has("Настройки", "Мария Орлова", "@maria", "Мой профиль", "Конфиденциальность", "Безопасность", "Активные сеансы", "Заблокированные", "Помощь и поддержка", "О приложении", "Выйти из аккаунта")
    assertTrue(texts().any { it.startsWith("INVIZENT ") && it.contains(" · ядро ") })
    // Coming to the eyes, the section asks for the profile again.
    assertTrue(account.refreshed >= 1)
    shot("30-settings-root")
    // A new name from the server is shown at once.
    account.keepOwnProfile(account.profile + mapOf("displayName" to "Маша"))
    has("Маша"); hasNot("Мария Орлова")
    press("О приложении")
    assertEquals("AboutScreen", topName)
    has("О приложении", "Приложение", "Сборка", "Ядро")
    assertTrue(texts().any { it.startsWith("Инвиз ") && it.endsWith(" · переписка защищена сквозным шифрованием") })
    shot("44-settings-about")
    find(top) { it.contentDescription == "Назад" }!!.performClick(); idle()
    assertEquals("SettingsScreen", topName)
  }

  @Test fun everyLaunchPageOpens() {
    everythingAnswers()
    val pages = listOf(
      Triple("profile", "ProfileEditScreen", "Мой профиль"), Triple("username", "UsernameScreen", "Имя пользователя"), Triple("birthday", "BirthdayScreen", "День рождения"),
      Triple("privacy", "PrivacyScreen", "Конфиденциальность"), Triple("lastseen", "LastSeenScreen", "Время захода"), Triple("security", "SecurityScreen", "Безопасность"),
      Triple("password", "SecretChangeScreen", "Изменить пароль"), Triple("confirmation", "SecretChangeScreen", "Слово подтверждения"), Triple("recovery", "SecretChangeScreen", "Слово восстановления"),
      Triple("sessions", "SessionsScreen", "Активные сеансы"), Triple("session", "SessionDetailScreen", "Это устройство"), Triple("blocked", "BlockedScreen", "Заблокированные"),
      Triple("delete", "DeleteAccountScreen", "Удалить аккаунт"), Triple("about", "AboutScreen", "О приложении"),
    )
    pages.forEachIndexed { index, (name, type, heading) ->
      launch()
      settings.openDetail(name)
      idle()
      assertEquals(name, type, topName)
      has(heading)
      shot("${31 + index}-settings-$name")
    }
    launch()
    settings.openDetail("nothing")
    assertEquals("SettingsScreen", topName)
  }

  @Test fun theProfileIsSentOnlyWhenSaved() {
    launch()
    press("Мой профиль")
    assertEquals("ProfileEditScreen", topName)
    has("Мой профиль", "Имя пользователя", "@maria", "День рождения", "2 мар 1999", "Пол", "Женский", "ПЕРСОНАЛЬНЫЙ ЦВЕТ", "Сохранить",
      "Несколько слов о себе — например, чем занимаешься. Видно в профиле.", "Этим цветом тебя видят в чатах у других, пока нет фото.")
    assertEquals("Мария Орлова", field("Имя").text.toString())
    assertEquals("Пишу код", field("О себе").text.toString())
    field("Имя").setText("   ")
    press("Сохранить")
    has("Имя не может быть пустым.")
    assertEquals(0, account.count("profile"))

    field("Имя").setText("  Маша Орлова ")
    hasNot("Имя не может быть пустым.")
    find(top) { it.contentDescription == "Цвет 7" }!!.performClick()
    account.answers["profile"] = { args -> @Suppress("UNCHECKED_CAST") Result.success(mapOf("user" to (account.profile + (args[0] as Map<String, Any?>)))) }
    press("Сохранить")
    assertEquals(mapOf("displayName" to "Маша Орлова", "bio" to "Пишу код", "birthday" to "1999-03-02", "gender" to "female", "avatarColor" to "#3FA37C"), account.last("profile")[0])
    has("Профиль сохранён.")
    assertEquals("Маша Орлова", account.profile["displayName"])

    // The gender is chosen from three; the words say what it is for.
    press("Пол")
    val choice = dialog()
    val words = ArrayList<String>()
    fun gather(view: View) { if (view is TextView) words.add(view.text.toString()); if (view is ViewGroup) for (index in 0 until view.childCount) gather(view.getChildAt(index)) }
    gather(choice.window!!.decorView)
    assertTrue(words.toString(), words.containsAll(listOf("Пол", "Нужен только для оформления в день рождения: синее или розовое. Можно не указывать.", "Мужской", "Женский", "Не указан", "Отмена")))
    find(choice.window!!.decorView) { it is TextView && it.text.toString() == "Не указан" }!!.performClick(); idle()
    has("Не указан"); hasNot("Профиль сохранён.")
    account.refuse("profile", "Слишком часто.")
    press("Сохранить")
    assertNull((account.last("profile")[0] as Map<*, *>)["gender"])
    assertTrue((account.last("profile")[0] as Map<*, *>).containsKey("gender"))
    has("Слишком часто.")
  }

  @Test fun aBirthdayIsADayAMonthAndPerhapsAYear() {
    launch()
    var chosen: String? = "none"
    stack.push(BirthdayScreen(activity, "1999-02-28") { chosen = it }, animated = false); idle()
    has("День рождения", "ГОД (НЕОБЯЗАТЕЛЬНО)", "Видят только друзья: 28 фев 1999", "Готово", "Убрать день рождения")
    val year = field("Год (необязательно)")
    year.setText("18"); idle()
    has("Год — от 1900 до ${java.time.LocalDate.now().year}")
    assertFalse(enabled("Готово"))
    year.text.append("x"); assertEquals("18", year.text.toString())   // digits only
    year.text.append("9"); year.text.append("9"); year.text.append("9"); assertEquals("1899", year.text.toString())   // four at most
    year.setText(""); idle()
    has("Видят только друзья: 28 фев"); hasNot("Год — от 1900 до ${java.time.LocalDate.now().year}")
    year.setText("2000")
    press("Готово")
    assertEquals("2000-02-28", chosen)
    assertEquals("SettingsScreen", topName)

    stack.push(BirthdayScreen(activity, "02-29") { chosen = it }, animated = false); idle()
    // The 29th of February of a year that has none becomes the 28th.
    field("Год (необязательно)").setText("2001"); idle()
    has("Видят только друзья: 28 фев 2001")
    press("Убрать день рождения")
    assertNull(chosen)

    stack.push(BirthdayScreen(activity, null) { chosen = it }, animated = false); idle()
    hasNot("Убрать день рождения")
    press("Готово")
    assertEquals("01-01", chosen)
  }

  @Test fun thePublicNameIsChangedAfterAQuestion() {
    everythingAnswers()
    launch()
    settings.openDetail("username"); idle()
    has("Имя пользователя", "Публичное имя можно менять раз в неделю, с Platina — раз в день.", "Изменить публичное имя")
    val name = field("Публичное имя пользователя")
    assertEquals("maria", name.text.toString())
    assertFalse(enabled("Изменить публичное имя"))
    name.setText("@M"); idle()
    press("Изменить публичное имя")
    has("Имя пользователя: от 3 до 24 символов a–z, 0–9 и подчёркивание.")
    field("Публичное имя пользователя").setText("@Masha"); idle()
    press("Изменить публичное имя")
    assertEquals("@maria → @masha\n\nЛогин для входа «native_tester», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.\n\nСледующая смена будет доступна через неделю, с Platina — через день.", dialogWords())
    assertEquals(0, account.count("changeUsername"))
    account.answer("changeUsername", mapOf("user" to (account.profile + mapOf("username" to "masha")),
      "status" to mapOf("accountId" to "u1", "username" to "masha", "loginName" to "native_tester", "canChangeUsername" to false, "nextUsernameChangeAt" to "2026-11-28T12:00:00.000Z", "platina" to mapOf("active" to false))))
    agree()
    assertEquals(listOf("masha"), account.last("changeUsername"))
    has("Публичное имя изменено. Логин для входа остался прежним.")
    assertTrue(texts().any { it.startsWith("Имя можно менять раз в неделю, с Platina — раз в день. Следующая смена — 28 ноября, ") })
    assertEquals("masha", account.profile["username"])
    assertFalse(field("Публичное имя пользователя").isEnabled)
  }

  @Test fun theSettingsOfAnotherAccountAreNotShown() {
    everythingAnswers()
    account.answer("usernameStatus", mapOf("accountId" to "someone-else", "username" to "other", "canChangeUsername" to true))
    launch()
    settings.openDetail("username"); idle()
    has("Сервер вернул настройки другого аккаунта.", "Повторить")
    assertEquals("maria", field("Публичное имя пользователя").text.toString())
    assertFalse(enabled("Изменить публичное имя"))
  }

  @Test fun privacyMovesAtOnceAndComesBackWhenRefused() {
    everythingAnswers()
    launch()
    press("Конфиденциальность")
    assertEquals("PrivacyScreen", topName)
    has("Время захода", "Мои друзья (−1, +2)", "Новые разговоры", "Фото профиля для других", "Отчёты о прочтении", "Platina", "Скрывать прочтение можно с Platina.",
      "Кто видит мои истории и записи", "Истории и записи видят только твои друзья.", "Кто может звонить", "Позвонить может любой, кроме тех, кто в списке «Никогда».",
      "Содержимое сообщений, ответы, реакции, правки и закрепления шифруются на устройстве. Сервер видит только служебные данные: кто, кому и когда.")
    assertTrue(toggle("Новые разговоры").isChecked)
    // Hiding the reading is for Platina only.
    assertFalse(toggle("Отчёты о прочтении").isEnabled)

    account.answers["updatePrivacy"] = { args -> @Suppress("UNCHECKED_CAST") Result.success(mapOf("privacy" to (privacy + (args[0] as Map<String, Any?>)), "platina" to false)) }
    toggle("Новые разговоры").performClick(); idle()
    assertEquals(listOf(mapOf("allowNewChats" to false)), account.last("updatePrivacy"))
    assertFalse(toggle("Новые разговоры").isChecked)

    account.refuse("updatePrivacy", "Сейчас нельзя.")
    toggle("Фото профиля для других").performClick(); idle()
    has("Сейчас нельзя.")
    assertTrue(toggle("Фото профиля для других").isChecked)

    account.answers["updatePrivacy"] = { args -> @Suppress("UNCHECKED_CAST") Result.success(mapOf("privacy" to (privacy + (args[0] as Map<String, Any?>)), "platina" to false)) }
    press("Разрешённые")
    assertEquals(listOf(mapOf("calls" to "allowed")), account.last("updatePrivacy"))
    has("Только люди из списка «Разрешить».")
    press("Все")   // the first «Все»: the audience of the stories
    assertEquals(listOf(mapOf("posts" to "everyone")), account.last("updatePrivacy"))
    has("Истории и записи видит любой, кого ты не заблокировал.")

    press("Время захода")
    assertEquals("LastSeenScreen", topName)
    has("КТО ВИДИТ, КОГДА Я В СЕТИ", "Все", "Мои друзья", "Никто", "Скрывать время прочтения")
    val before = account.count("updatePrivacy")
    press("Мои друзья")   // already chosen: nothing is sent
    assertEquals(before, account.count("updatePrivacy"))
    press("Никто")
    assertEquals(listOf(mapOf("lastSeen" to "nobody")), account.last("updatePrivacy"))
    toggle("Скрывать время прочтения").performClick(); idle()
    assertEquals(listOf(mapOf("hideReadTime" to true)), account.last("updatePrivacy"))
  }

  @Test fun privacyThatDidNotLoadCanBeAskedAgain() {
    launch()
    press("Конфиденциальность")
    has("Нет связи с сервером.", "Повторить")
    hasNot("Время захода")
    everythingAnswers()
    press("Повторить")
    has("Время захода", "Новые разговоры")
  }

  private fun secret(caption: String, text: String) { field(caption).setText(text) }

  @Test fun aSecretIsChangedWithTheCurrentOnesAndEverythingSignsOut() {
    everythingAnswers()
    launch()
    press("Безопасность")
    assertEquals("SecurityScreen", topName)
    has("Твой доступ.\nТвои устройства.", "ПАРОЛЬ", "Изменить пароль", "ПОДТВЕРЖДЕНИЕ ВХОДА", "Слово подтверждения", "Настроено", "Изменить слово подтверждения",
      "ВОССТАНОВЛЕНИЕ ДОСТУПА", "Слово восстановления", "Пока не настроено", "Настроить слово восстановления", "3 попытки → 24 часа ожидания", "Удалить аккаунт",
      "Заверши настройку двух слов. В старом аккаунте недостающие слова можно добавить, пока помнишь пароль.")
    press("Настроить слово восстановления")
    assertEquals("SecretChangeScreen", topName)
    has("Слово восстановления", "Сохранить изменения", "Отмена",
      "Подтверди текущие данные. После сохранения все устройства выйдут из аккаунта. Новое значение введи дважды вручную.",
      "От 4 до 64 букв, без пробелов. Регистр не важен; «е» и «ё» различаются. Два слова должны отличаться друг от друга, логина и пароля.")
    press("Сохранить изменения"); has("Введи текущий пароль.")
    secret("Текущий пароль", "current password")
    press("Сохранить изменения"); has("Введи текущее слово подтверждения.")
    secret("Текущее слово подтверждения", "Amber")
    secret("Новое слово восстановления", "abc")
    press("Сохранить изменения"); has("Слово: от 4 до 64 русских или английских букв, без пробелов.")
    secret("Новое слово восстановления", "amber")
    press("Сохранить изменения"); has("Два слова должны отличаться друг от друга, пароля и логина.")
    secret("Новое слово восстановления", "Garden")
    secret("Повтори новое слово", "gardens")
    press("Сохранить изменения"); has("Секретные слова не совпадают.")
    assertEquals(0, account.count("changeRecoveryWord"))

    // Refused: the current secrets are typed again, the new ones stay.
    secret("Повтори новое слово", " GARDEN ")
    account.refuse("changeRecoveryWord", "Неверный пароль.", 401)
    press("Сохранить изменения")
    assertEquals(listOf("current password", "garden", "amber"), account.last("changeRecoveryWord"))
    has("Неверный пароль.")
    assertEquals("", field("Текущий пароль").text.toString())
    assertEquals("Garden", field("Новое слово восстановления").text.toString())

    secret("Текущий пароль", "current password")
    secret("Текущее слово подтверждения", "amber")
    account.answer("changeRecoveryWord", mapOf("ok" to true))
    press("Сохранить изменения")
    // The account is closed here: signing in is shown, with the words why.
    assertEquals("Слово восстановления сохранено. Все устройства вышли из аккаунта. Войди с паролем и словом подтверждения.", account.endedWith)
    assertEquals("AuthScreen", topName)
    assertEquals(account.endedWith, dialogWords())
    shot("46-settings-closed")
  }

  @Test fun aNewPasswordIsTypedTwice() {
    launch()
    settings.openDetail("password"); idle()
    has("Изменить пароль", "Сохранить изменения")
    hasNot("От 4 до 64 букв, без пробелов. Регистр не важен; «е» и «ё» различаются. Два слова должны отличаться друг от друга, логина и пароля.")
    secret("Текущий пароль", "current password")
    secret("Текущее слово подтверждения", "amber")
    secret("Новый пароль", "short")
    press("Сохранить изменения"); has("Новый пароль: от 10 до 128 символов. Можно использовать длинную фразу.")
    secret("Новый пароль", "a new long password")
    secret("Повтори новый пароль", "a new long passwerd")
    press("Сохранить изменения"); has("Новые пароли не совпадают.")
    secret("Повтори новый пароль", "a new long password")
    account.answer("changePassword", emptyMap())
    press("Сохранить изменения")
    assertEquals(listOf("current password", "a new long password", "amber"), account.last("changePassword"))
    assertEquals("Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и словом подтверждения.", account.endedWith)
    assertEquals("AuthScreen", topName)
  }

  @Test fun theAccountIsDeletedOnlyWithItsSecrets() {
    everythingAnswers()
    launch()
    press("Безопасность"); press("Удалить аккаунт")
    assertEquals("DeleteAccountScreen", topName)
    has("Удалить аккаунт навсегда?", "Удалить навсегда")
    press("Удалить навсегда"); has("Введи пароль.")
    secret("Пароль", "current password")
    press("Удалить навсегда"); has("Введи слово подтверждения.")
    secret("Слово подтверждения", " amber ")
    account.refuse("deleteAccount", "Неверный пароль.", 401)
    press("Удалить навсегда")
    assertEquals(listOf("current password", "amber"), account.last("deleteAccount"))
    has("Неверный пароль.")
    assertEquals("DeleteAccountScreen", topName)
    account.answer("deleteAccount", emptyMap())
    press("Удалить навсегда")
    assertEquals("Аккаунт удалён.", account.endedWith)
    assertEquals("AuthScreen", topName)
    assertEquals("Аккаунт удалён.", dialogWords())
  }

  @Test fun aSessionThatEndedClosesTheAccount() {
    account.refuse("security", "Войдите заново.", 401)
    launch()
    press("Безопасность")
    assertEquals("Сессия завершилась. Войди в аккаунт снова.", account.endedWith)
    assertEquals("AuthScreen", topName)
  }

  @Test fun sessionsAreListedAndEnded() {
    everythingAnswers()
    launch()
    press("Активные сеансы")
    assertEquals("SessionsScreen", topName)
    val shown = texts()
    // This device first.
    assertTrue(shown.indexOf("Google Pixel 9") in 0 until shown.indexOf("iPhone 16"))
    has("Это устройство", "Android 15 · Инвиз 0.17.0", "203.0.113.7 · в сети", "Завершить все другие сеансы", "ДРУГИЕ УСТРОЙСТВА", "iOS 18.1 · Инвиз 0.16.2")
    assertTrue(shown.any { it.startsWith("198.51.100.4 · 20 нояб., ") || it.startsWith("198.51.100.4 · 21 нояб., ") })

    press("iPhone 16")
    assertEquals("SessionDetailScreen", topName)
    has("Сеанс", "Действующий сеанс на другом устройстве", "Устройство", "Система", "iOS 18.1", "Приложение", "Инвиз 0.16.2", "IP-адрес", "198.51.100.4", "Первый вход", "Последняя активность", "Действует до", "Завершить сеанс")
    account.answer("revokeSession", emptyMap())
    account.answer("sessions", mapOf("sessions" to sessions.filter { it["id"] == "s-here" }))
    press("Завершить сеанс")
    assertEquals(listOf("s-old"), account.last("revokeSession"))
    assertEquals("SessionsScreen", topName)
    has("Выбранный сеанс завершён.")
    hasNot("iPhone 16", "ДРУГИЕ УСТРОЙСТВА")
    assertFalse(enabled("Завершить все другие сеансы"))

    // Ending this device's own session leaves the account.
    press("Google Pixel 9")
    has("Это устройство", "Текущий сеанс на этом устройстве", "Сейчас", "Выйти на этом устройстве", "Выход завершит сеанс на этом устройстве. Переписка останется на сервере.")
    press("Выйти на этом устройстве")
    assertEquals(listOf("s-here"), account.last("revokeSession"))
    assertEquals("Сеанс на этом устройстве завершён. Войди снова, чтобы продолжить.", account.endedWith)
    assertEquals("AuthScreen", topName)
  }

  @Test fun allTheOtherSessionsAreEndedAfterAQuestion() {
    everythingAnswers()
    launch()
    press("Активные сеансы")
    press("Завершить все другие сеансы")
    assertEquals("Этот сеанс останется открытым. На остальных устройствах понадобится снова ввести логин, пароль и слово подтверждения.", dialogWords())
    assertEquals(0, account.count("revokeOtherSessions"))
    account.refuse("revokeOtherSessions", "Не вышло.")
    agree()
    has("Не вышло.", "iPhone 16")
    account.answer("revokeOtherSessions", emptyMap())
    press("Завершить все другие сеансы"); agree()
    has("Все другие сеансы завершены.")
    // The list is read again, by the button in the header too.
    val read = account.count("sessions")
    find(top) { it.contentDescription == "Обновить список сеансов" }!!.performClick(); idle()
    assertEquals(read + 1, account.count("sessions"))
  }

  @Test fun aBlockedPersonIsLetBack() {
    everythingAnswers()
    launch()
    press("Заблокированные")
    assertEquals("BlockedScreen", topName)
    has("Лев Никитин", "@lev", "Разблокировать")
    account.refuse("unblock", "Не удалось.")
    press("Разблокировать")
    assertEquals(listOf("u7"), account.last("unblock"))
    has("Не удалось.", "Лев Никитин")
    account.answer("unblock", emptyMap())
    press("Разблокировать")
    has("Никого нет. Заблокировать можно в профиле собеседника через «⋯».")
    hasNot("Лев Никитин")
  }

  @Test fun leavingAsksFirstAndSaysWhatTheServerDidNotConfirm() {
    launch()
    press("Выйти из аккаунта")
    assertEquals("Сеанс на этом устройстве завершится. Для следующего входа понадобятся логин, пароль и слово подтверждения. Публичное имя может отличаться от логина.", dialogWords())
    // Not finished: the person is told, and stays in the account.
    account.signOut = Result.failure(ServerError.Network("Не удалось удалить сохранённую сессию с устройства. Выход не завершён. Попробуй ещё раз."))
    agree()
    assertEquals("SettingsScreen", topName)
    assertEquals("Не удалось удалить сохранённую сессию с устройства. Выход не завершён. Попробуй ещё раз.", dialogWords())
    dialog().dismiss()
    account.signOut = Result.success("Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось.")
    press("Выйти из аккаунта"); agree()
    assertEquals("AuthScreen", topName)
    assertEquals("Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось.", dialogWords())
  }

  @Test fun withoutAnAccountTheSectionShowsTheSamplePersonAndOpensOnlyAbout() {
    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("settings", "root")).setup().get()
    page = activity.window.decorView
    stack = find(page) { it is Navigation } as Navigation
    idle(1500)
    val section = find(page) { it is SettingsScreen && it.isShown }
    assertNotNull(section)
    val words = texts(section!!)
    assertTrue(words.toString(), words.containsAll(listOf("Настройки", "Мария Орлова", "@maria", "Мой профиль", "Выйти из аккаунта")))
    for (row in listOf("Мой профиль", "Конфиденциальность", "Безопасность", "Активные сеансы", "Заблокированные", "Помощь и поддержка", "Выйти из аккаунта")) {
      var target: View? = find(section) { it is TextView && it.text.toString() == row }
      while (target != null && !target.isClickable) target = target.parent as? View
      target!!.performClick(); idle()
      assertEquals(row, 1, stack.depth)
    }
    assertNull(ShadowAlertDialog.getLatestAlertDialog())

    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("settings", "about")).setup().get()
    page = activity.window.decorView
    stack = find(page) { it is Navigation } as Navigation
    idle(1500)
    assertEquals("AboutScreen", topName)
    // A page that needs an account does not open without one.
    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("settings", "security")).setup().get()
    page = activity.window.decorView
    stack = find(page) { it is Navigation } as Navigation
    idle(1500)
    assertEquals(1, stack.depth)
  }
}
