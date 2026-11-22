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
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.net.ServerError
import com.linea.messenger.settings.AccentColorScreen
import com.linea.messenger.settings.ClockScreen
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.MutedChatRow
import com.linea.messenger.settings.NotificationPrefs
import com.linea.messenger.settings.NotificationsScreen
import com.linea.messenger.settings.OwnProfile
import com.linea.messenger.settings.SettingsAccount
import com.linea.messenger.settings.SettingsScreen
import com.linea.messenger.settings.ThemeCard
import com.linea.messenger.settings.ThemeLook
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAlertDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** «Оформление», «Ночная тема», «Цвет интерфейса», «Уведомления и звуки», «Данные и память», built and driven on
 *  the JVM with the real core behind them (`CoreSharingRunner`; skipped when the core has not been built for this
 *  machine). The account is one of the test: nothing leaves this machine. Each page is saved as a picture in
 *  build/pages/. */
@RunWith(CoreSharingRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsLookPagesTest {
  private class Asked(val name: String, val args: List<Any?>)

  private class Account : SettingsAccount {
    override val userId = "u1"
    override val base = ""
    override val ownProfile: Map<String, Any?> = mapOf("id" to "u1", "displayName" to "Мария Орлова", "username" to "maria", "avatarColor" to "#9271C3")
    val asked = ArrayList<Asked>()
    val answers = HashMap<String, (List<Any?>) -> Result<Map<String, Any?>>>()
    var chats: List<Messenger.ChatSummary> = emptyList()
    var limits: Result<Map<String, Any?>> = Result.failure(ServerError.Network("Нет связи с сервером."))
    val got = ArrayList<String>()

    fun answer(name: String, body: Map<String, Any?>) { answers[name] = { Result.success(body) } }
    fun last(name: String): List<Any?> = asked.last { it.name == name }.args
    fun count(name: String): Int = asked.count { it.name == name }
    private fun later(work: () -> Unit) { android.os.Handler(android.os.Looper.getMainLooper()).post(work) }

    override fun keepOwnProfile(fresh: Map<String, Any?>) { OwnProfile.tell() }
    override fun accountCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
      asked.add(Asked(name, args))
      later { done(answers[name]?.invoke(args) ?: Result.failure(ServerError.Network("Нет связи с сервером."))) }
    }
    override fun refreshOwnProfile() {}
    override fun prepareSettingsAvatars() {}
    override fun signOut(done: (Result<String>) -> Unit) = done(Result.success(""))
    override fun sessionEndedHere(words: String): String = words
    override fun chatList(done: (Result<List<Messenger.ChatSummary>>) -> Unit) { val now = chats; later { done(Result.success(now)) } }
    override fun serverGet(path: String, done: (Result<Map<String, Any?>>) -> Unit) { got.add(path); val now = limits; later { done(now) } }
  }

  private lateinit var activity: MainActivity
  private lateinit var page: View
  private lateinit var stack: Navigation
  private val account = Account()

  @Before fun theClockAndTheScreenAreTheTests() {
    assumeTrue(Core.loaded)
    ThemeStore.minuteNow = { 12 * 60 }
    ThemeStore.systemLook = { "light" }
    ThemeStore.screenLevel = { 0.8 }
  }

  @After fun backToTheAppsOwnLook() {
    ThemeStore.use(null)
    ThemeStore.systemLook = null
    ThemeStore.screenLevel = null
    AccentColorScreen.custom = false
    AccentColorScreen.sliders = null
  }

  /** The shell with the sample chats; `extras` are launch arguments of the emulator check. */
  private fun launch(vararg extras: Pair<String, Any>) {
    val intent = Intent(Intent.ACTION_MAIN).putExtra("demo", true)
    for ((name, value) in extras) if (value is Boolean) intent.putExtra(name, value) else intent.putExtra(name, value.toString())
    activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    page = activity.window.decorView
    stack = find(page) { it is Navigation } as Navigation
    idle()
  }

  /** Over the shell: the settings of the test's account, and one of their pages. */
  private fun launchWithAccount(detail: String): SettingsScreen {
    launch()
    val settings = SettingsScreen(activity, account)
    stack.push(settings, animated = false)
    idle()
    settings.openDetail(detail)
    idle()
    return settings
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

  private fun all(view: View, test: (View) -> Boolean, into: MutableList<View> = ArrayList()): List<View> {
    if (test(view)) into.add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) all(view.getChildAt(index), test, into)
    return into
  }

  /** The page on top of the stack: what the person looks at. */
  private val top: View get() = stack.top!!
  private val topName: String get() = top.javaClass.simpleName
  private val shell: RootScreen get() = find(page) { it is RootScreen } as RootScreen

  private fun texts(view: View = top, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    if (view is TextView && view !is EditText && view !is Switch) into.add(view.text.toString())
    if (view is ViewGroup) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun has(vararg words: String) { val all = texts(); for (word in words) assertTrue("No «$word» in $all", all.contains(word)) }
  private fun hasNot(vararg words: String) { val all = texts(); for (word in words) assertFalse("«$word» is in $all", all.contains(word)) }

  /** Presses what carries these words on the top page: the text itself, or the row, card or button it is in. */
  private fun press(words: String) {
    val label = find(top) { it is TextView && it.text.toString() == words && it.isShown }
    assertNotNull("No «$words» on $topName: ${texts()}", label)
    var target: View? = label
    while (target != null && !target.isClickable) target = target.parent as? View
    assertTrue(target!!.isEnabled)
    assertTrue(target.performClick())
    idle()
  }

  /** Presses what is read aloud with these words. */
  private fun pressNamed(spoken: String) {
    val target = find(top) { it.contentDescription?.toString() == spoken && it.isClickable }
    assertNotNull("Nothing named «$spoken» on $topName", target)
    assertTrue(target!!.performClick())
    idle()
  }

  private fun back() { find(top) { it.contentDescription == "Назад" }!!.performClick(); idle() }
  private fun toggles(name: String): List<Switch> = all(top, { it is Switch && it.contentDescription == name }).map { it as Switch }
  private fun card(label: String): ThemeCard = find(top) { it is ThemeCard && it.label == label } as ThemeCard
  private fun cards(): List<ThemeCard> = all(top, { it is ThemeCard }).map { it as ThemeCard }

  private fun dialog(): AlertDialog = ShadowAlertDialog.getLatestAlertDialog()!!
  private fun dialogWords(): String = shadowOf(dialog()).message?.toString() ?: ""
  private fun agree() { dialog().getButton(DialogInterface.BUTTON_POSITIVE).performClick(); idle() }
  private fun sheet(): ChoiceSheet = ChoiceSheet.last!!.get()!!

  private fun colourOf(theme: String, field: String): Int = ThemeLook.color(ThemeStore.plainFields(theme)[field] as String)!!

  @Test fun aThemeIsChosenAndTheAppIsRedrawnInIt() {
    launch()
    assertTrue(activity.openSettings("appearance"))
    idle()
    assertEquals("AppearanceScreen", topName)
    assertEquals(2, stack.depth)
    has("Оформление", "ТЕМА", "Светлая", "Тёмная", "Чёрная", "Графит", "ПАЛИТРЫ", "  · с Platina", "Ночной режим", "Ночная тема", "Выключена",
      "СВОИ ЦВЕТА", "Цвет интерфейса", "Как в теме", "РАЗМЕР ТЕКСТА В ЧАТАХ", "Привет! Так будет выглядеть текст сообщений.", "Мелкий", "Обычный", "Крупный", "Очень крупный",
      "Тема, цвет и размер текста хранятся только на этом устройстве.")
    // The app's own look is the one that is on; the seven palettes are locked without Platina.
    assertTrue(card("Чёрная").chosen)
    assertEquals(listOf("Чёрная"), cards().filter { it.chosen }.map { it.label })
    assertEquals(11, cards().size)
    assertEquals(7, cards().count { it.locked })
    assertEquals("Чёрная тема", card("Чёрная").contentDescription)
    assertTrue(cards().first { it.locked }.contentDescription.toString().endsWith(", доступна с Platina"))
    assertEquals(0xFF08090A.toInt(), Theme.bg)
    shot("60-look-appearance")

    val before = top
    val shellBefore = shell
    press("Графит")
    // The shell was built again in the new colours, and «Оформление» stands on top of it again.
    assertEquals("AppearanceScreen", topName)
    assertNotSame(before, top)
    assertNotSame(shellBefore, shell)
    assertEquals("profile", shell.open)
    assertEquals(2, stack.depth)
    assertEquals("graphite", ThemeStore.look.id)
    assertEquals(colourOf("graphite", "bg"), Theme.bg)
    assertEquals(listOf("Графит"), cards().filter { it.chosen }.map { it.label })
    assertEquals("graphite", ThemeStore.mode)
    shot("61-look-appearance-graphite")

    // A palette without Platina is not put on: the page says where the palettes come from.
    val same = top
    cards().first { it.locked }.performClick(); idle()
    assertSame(same, top)
    has("Палитры входят в Инвиз Platina. Войди в аккаунт с Platina, чтобы их включить.")
    assertEquals("graphite", ThemeStore.look.id)

    // «Светлая»: dark signs on a light page.
    press("Светлая")
    assertFalse(Theme.dark)
    assertEquals(colourOf("light", "bg"), Theme.bg)
    shot("62-look-appearance-light")
    // The size of the text is not the look: the page stays, the sample grows.
    val light = top
    press("Крупный")
    assertSame(light, top)
    assertEquals(19f, ThemeStore.textSize)
    val sample = find(top) { it is TextView && it.text.toString() == "Привет! Так будет выглядеть текст сообщений." } as TextView
    assertEquals(19f, sample.textSize / activity.resources.displayMetrics.scaledDensity, 0.01f)

    press("Чёрная")
    assertEquals(0xFF08090A.toInt(), Theme.bg)
    // Back in the section, the row says which theme is on.
    back()
    assertEquals("RootScreen", topName)
    assertEquals(1, stack.depth)
    has("Оформление", "Чёрная", "Уведомления и звуки", "Данные и память")
  }

  @Test fun theNightSwitchTurnsTheNightThemeOnByHand() {
    launch("settheme" to "light")
    assertFalse(Theme.dark)
    activity.openSettings("appearance"); idle()
    val night = toggles("Ночной режим").single()
    assertFalse(night.isChecked)
    night.performClick(); idle()
    // «Светлая» by day, «Чёрная» (the night theme) now.
    assertEquals("AppearanceScreen", topName)
    assertEquals("black", ThemeStore.look.id)
    assertTrue(toggles("Ночной режим").single().isChecked)
    has("Включён ночной режим. Дневная тема «Светлая» вернётся, когда он выключится.")
    assertEquals(true, DevicePreferences.flag("nightForced"))
    // A light theme chosen at night turns the night off, as the switch would.
    press("Светлая")
    assertEquals("light", ThemeStore.look.id)
    assertEquals(false, DevicePreferences.flag("nightForced"))
    assertFalse(toggles("Ночной режим").single().isChecked)
  }

  @Test fun theNightThemeHasItsRuleAndItsTheme() {
    launch()
    activity.openSettings("night"); idle()
    assertEquals("NightThemeScreen", topName)
    // «Ночная тема» stands on «Оформление», as it is reached.
    assertEquals(3, stack.depth)
    has("Ночная тема", "Системная", "Выключена", "По расписанию", "Автоматически", "ВЫБРАННАЯ НОЧНАЯ ТЕМА", "Тёмная", "Чёрная", "Графит",
      "Сама по себе ночная тема включается, когда приложение открывают или возвращаются в него. Открытый чат при этом не перерисовывается.")
    assertEquals(listOf("Тёмная", "Чёрная", "Графит"), cards().map { it.label })
    assertTrue(card("Чёрная").chosen)
    shot("63-look-night")

    press("По расписанию")
    assertEquals("schedule", DevicePreferences.word("nightMode"))
    has("ВРЕМЯ ИСПОЛЬЗОВАНИЯ", "Начало", "22:00", "Конец", "07:00")
    shot("64-look-night-schedule")
    press("Начало")
    assertEquals("ClockScreen", topName)
    has("Начало", "Готово")
    (top as ClockScreen).set(21, 30)
    press("Готово")
    assertEquals("NightThemeScreen", topName)
    assertEquals("21:30", DevicePreferences.word("nightFrom"))
    has("21:30", "07:00")

    press("Автоматически")
    has("ПОРОГ ЯРКОСТИ", "10%", "25%", "40%", "60%", "Ночная тема включится, когда яркость экрана опустится до 25% и ниже.")
    press("40%")
    assertEquals(0.4, DevicePreferences.number("nightBrightness")!!, 0.0)
    has("Ночная тема включится, когда яркость экрана опустится до 40% и ниже.")
    shot("65-look-night-auto")

    press("Системная")
    has("Ночная тема включается вместе с тёмным оформлением Android.")
    hasNot("ПОРОГ ЯРКОСТИ", "ВРЕМЯ ИСПОЛЬЗОВАНИЯ")

    // The night theme is chosen for later: it is day, nothing is redrawn.
    val same = top
    press("Графит")
    assertSame(same, top)
    assertEquals("graphite", ThemeStore.darkTheme)
    assertTrue(card("Графит").chosen)
    assertEquals("black", ThemeStore.look.id)
    // The system goes dark: the app follows when it is opened again, here asked directly.
    ThemeStore.systemLook = { "dark" }
    assertTrue(ThemeStore.refresh(listOf("appearance", "night")))
    assertEquals("NightThemeScreen", topName)
    assertNotSame(same, top)
    assertEquals(3, stack.depth)
    assertEquals(colourOf("graphite", "bg"), Theme.bg)
    back()
    assertEquals("AppearanceScreen", topName)
    has("Системная")
    assertTrue(toggles("Ночной режим").single().isChecked)
  }

  @Test fun theColourOfTheInterfaceIsPutOnAtOnce() {
    launch()
    activity.openSettings("accent"); idle()
    assertEquals("AccentColorScreen", topName)
    assertEquals(3, stack.depth)
    has("Цвет интерфейса", "Нравится, оставляю", "ссылка · 12:30", "Кнопка", "Как в теме", "Свой цвет",
      "Цвет действует поверх любой темы. Если он плохо читается на её фоне, приложение слегка сдвигает его, чтобы текст оставался разборчивым.")
    hasNot("Оттенок")
    assertEquals(12, all(top, { it.contentDescription?.toString()?.startsWith("Цвет #") == true }).size)
    shot("66-look-accent")

    val before = top
    pressNamed("Цвет #FF9500")
    assertEquals("AccentColorScreen", topName)
    assertNotSame(before, top)
    assertEquals(3, stack.depth)
    assertEquals("#FF9500", DevicePreferences.word("accentColor"))
    assertEquals(0xFFFF9500.toInt(), Theme.accent)
    assertTrue(find(top) { it.contentDescription == "Цвет #FF9500" }!!.isSelected)
    // The page itself is the preview: its link is in the new colour.
    assertEquals(0xFFFF9500.toInt(), (find(top) { it is TextView && it.text.toString() == "ссылка · 12:30" } as TextView).currentTextColor)
    shot("67-look-accent-orange")

    press("Свой цвет")
    has("Оттенок", "Насыщенность", "Яркость", "#FF9500")
    // Places the sliders have: the middle of the hues, 70% of the saturation, the middle of the brightness.
    (top as AccentColorScreen).slide(179.95, 0.7, 0.56)
    val own = Core.view("settingsHsvColor", listOf(179.95, 0.7, 0.56)) as String
    assertEquals(own, DevicePreferences.word("accentColor"))
    assertEquals("AccentColorScreen", topName)
    has("Оттенок", own)
    shot("68-look-accent-own")

    press("Как в теме")
    assertNull(DevicePreferences.word("accentColor"))
    assertEquals(0xFFE5E5E6.toInt(), Theme.accent)
    hasNot("Оттенок")
    back()
    assertEquals("AppearanceScreen", topName)
    has("Цвет интерфейса", "Как в теме")
  }

  @Test fun theLaunchArgumentsSetTheLookForAShot() {
    launch("settheme" to "graphite", "setaccent" to "ff9500", "settextsize" to "large", "settings" to "accent")
    assertEquals("graphite", ThemeStore.look.id)
    assertEquals(colourOf("graphite", "bg"), Theme.bg)
    assertEquals("#FF9500", DevicePreferences.word("accentColor"))
    assertEquals(19f, ThemeStore.textSize)
    assertEquals("off", DevicePreferences.word("nightMode"))
    idle(1500)
    assertEquals("AccentColorScreen", topName)
    assertEquals(3, stack.depth)
    // The choice is kept between launches; the last shot of the script puts the app's own look back.
    launch()
    assertEquals("graphite", ThemeStore.look.id)
    launch("setaccent" to "none", "settheme" to "black")
    assertEquals("black", ThemeStore.look.id)
    assertEquals(0xFF08090A.toInt(), Theme.bg)
    assertEquals(0xFFE5E5E6.toInt(), Theme.accent)
    // A palette is shown only to an account with Platina.
    launch("settheme" to "amethyst")
    assertEquals("dark", ThemeStore.look.id)
    launch("settheme" to "amethyst", "setplatina" to true, "settings" to "appearance")
    assertEquals("amethyst", ThemeStore.look.id)
    idle(1500)
    assertEquals("AppearanceScreen", topName)
    hasNot("  · с Platina")
    assertEquals(0, cards().count { it.locked })
    assertEquals(listOf(ThemeStore.themeName("amethyst")), cards().filter { it.chosen }.map { it.label })
    shot("69-look-appearance-palette")
    // The theme first (it turns the night rule off), then the night rule asked for.
    launch("setnight" to "schedule", "settheme" to "black", "setplatina" to false)
    assertEquals("schedule", DevicePreferences.word("nightMode"))
    assertFalse(ThemeStore.platina)
  }

  @Test fun theAccountSaysWhetherThePalettesAreOpen() {
    account.answer("usernameStatus", mapOf("platina" to mapOf("active" to true)))
    launchWithAccount("appearance")
    assertEquals("AppearanceScreen", topName)
    assertEquals(1, account.count("usernameStatus"))
    assertTrue(ThemeStore.platina)
    hasNot("  · с Platina")
    assertEquals(0, cards().count { it.locked })
  }

  private fun chat(id: String, title: String, settings: Map<String, Any?>) = Messenger.ChatSummary(id, "p-$id", title, 0, emptyMap(),
    chat = mapOf("id" to id, "settings" to settings, "peer" to mapOf("id" to "p-$id", "displayName" to title, "avatarColor" to "#4088C7")))

  @Test fun notificationsSayThePushStateFirst() {
    account.chats = listOf(chat("c1", "Алиса Воронцова", mapOf("muted" to true)), chat("c2", "Саша", mapOf("muted" to false)),
      chat("c3", "Книжный клуб", mapOf("muted" to true, "mutedUntil" to "2999-01-05T09:00:00.000Z")), chat("c4", "Лев", mapOf("muted" to true, "mutedUntil" to "2020-01-05T09:00:00.000Z")))
    launchWithAccount("notifications")
    assertEquals("NotificationsScreen", topName)
    assertEquals("Разрешение на уведомления ещё не запрошено.", texts()[1])
    has("Уведомления и звуки", "ЛИЧНЫЕ ЧАТЫ", "Показывать уведомления", "Новые сообщения и реакции в личных чатах, пока приложение свёрнуто. Когда оно закрыто, уведомления показывает система.", "Звук", "Короткий сигнал при новом сообщении.",
      "СООБЩЕСТВА", "Сообщения в каналах сообществ, где ты состоишь. Сообщества без звука присылают только упоминания.", "Короткий сигнал при новом сообщении в сообществе.",
      "ЗВОНКИ", "Мелодия", "Неон", "Вибрация", "Телефон вибрирует при входящем звонке, пока приложение запущено.",
      "БЕЙДЖ НА ИКОНКЕ", "Считать непрочитанные", "Число непрочитанных сообщений на иконке приложения.", "Включая чаты без звука", "Сообщения из чатов с выключенным звуком тоже попадают в число на иконке.",
      "ЧАТЫ БЕЗ ЗВУКА", "Алиса Воронцова", "Звук выключен", "Книжный клуб", "Сбросить настройки",
      "Переключатели хранятся только на этом устройстве. Выключенный звук чата действует на всех твоих устройствах: сервер просто не отправляет уведомление, пока он выключен.")
    // Only the chats whose sound is off now; a silence that has ended is over.
    assertEquals(listOf("Алиса Воронцова", "Книжный клуб"), all(top, { it is MutedChatRow }).map { (it as MutedChatRow).name })
    assertTrue((all(top, { it is MutedChatRow })[1] as MutedChatRow).status.startsWith("Звук выключен до 5 января 2999, "))
    shot("70-look-notifications")

    // A switch is kept on this device, and nothing is asked of the server for it.
    assertEquals(listOf(true, true), toggles("Звук").map { it.isEnabled })
    toggles("Показывать уведомления")[0].performClick(); idle()
    assertFalse(NotificationPrefs.flag("chats", "show"))
    assertEquals(listOf(false, true), toggles("Звук").map { it.isEnabled })
    assertFalse(toggles("Включая чаты без звука").single().isChecked)
    toggles("Включая чаты без звука").single().performClick(); idle()
    assertTrue(NotificationPrefs.flag("badge", "countMuted", otherwise = false))
    assertTrue(account.asked.isEmpty())

    press("Мелодия")
    assertEquals("Мелодия звонка", sheet().heading)
    assertEquals(listOf("Неон", "Пульс", "Без мелодии"), sheet().choices.map { it.label })
    assertEquals(listOf("ion:checkmark-circle", "ion:ellipse-outline", "ion:ellipse-outline"), sheet().choices.map { it.symbol })
    sheet().choices[1].run(); idle()
    assertEquals("pulse", NotificationPrefs.ringtone)
    has("Пульс")

    press("Сбросить настройки")
    assertEquals("Все переключатели на этом устройстве вернутся к значениям по умолчанию. Звук в чатах останется как есть.", dialogWords())
    agree()
    assertFalse(NotificationPrefs.changed)
    assertTrue(NotificationPrefs.flag("chats", "show"))
    has("Неон")
    press("Сбросить настройки")
    assertEquals("Все переключатели уже стоят по умолчанию.", dialogWords())
    agree()
  }

  @Test fun theSoundOfAChatIsTheServersSetting() {
    account.chats = listOf(chat("c1", "Алиса Воронцова", mapOf("muted" to true)), chat("c2", "Саша", mapOf("muted" to false)))
    account.answer("chatSettings", emptyMap())
    launchWithAccount("notifications")
    has("ЧАТЫ БЕЗ ЗВУКА", "Алиса Воронцова")
    // The row: the sound back, or another time.
    pressNamed("Алиса Воронцова: изменить время без звука")
    assertEquals("Выключить звук", sheet().heading)
    assertEquals("Алиса Воронцова", sheet().note)
    assertEquals(listOf("Включить звук", "На 1 час", "На 8 часов", "На 2 дня", "Навсегда", "Настроить…"), sheet().choices.map { it.label })
    assertEquals("Сейчас звук выключен навсегда.", sheet().choices[0].note)
    assertTrue(sheet().choices[1].note, Regex("Без звука до (\\d\\d:\\d\\d|завтра, \\d\\d:\\d\\d)\\.").matches(sheet().choices[1].note))
    assertEquals("Пока не включишь снова. Звонки продолжат звонить.", sheet().choices[4].note)
    sheet().choices[2].run(); idle()
    val sent = account.last("chatSettings")
    assertEquals("c1", sent[0])
    assertTrue(Regex("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z").matches(Core.map(sent[1])!!["mutedUntil"] as String))
    sheet().choices[4].run(); idle()
    assertEquals(listOf("c1", mapOf("muted" to true)), account.last("chatSettings"))

    // The bell turns the sound back on; the list is asked again and the chat is gone from it.
    account.chats = listOf(chat("c1", "Алиса Воронцова", mapOf("muted" to false)), chat("c2", "Саша", mapOf("muted" to false)))
    pressNamed("Включить звук")
    assertEquals(listOf("c1", mapOf("muted" to false)), account.last("chatSettings"))
    hasNot("ЧАТЫ БЕЗ ЗВУКА", "Алиса Воронцова")

    // The server did not take it: the page says so and shows what the server has.
    account.chats = listOf(chat("c2", "Саша", mapOf("muted" to true)))
    account.answers["chatSettings"] = { Result.failure(ServerError.Refused("Чат недоступен.", 403, null, emptyMap())) }
    back()
    (top as SettingsScreen).openDetail("notifications"); idle()
    has("Саша")
    pressNamed("Включить звук")
    has("Чат недоступен.", "Саша")
    shot("71-look-notifications-refused")
  }

  /** The page counts and clears on another thread: wait for what it then shows. */
  private fun waitFor(words: String) {
    for (attempt in 0 until 100) {
      idle(50)
      if (texts().contains(words)) return
      Thread.sleep(20)
    }
    has(words)
  }

  @Test fun theStorageAndTheTemporaryFilesAreShown() {
    val gb = 1024.0 * 1024 * 1024
    account.limits = Result.success(mapOf("usedBytes" to 5 * gb, "storageBytes" to 20 * gb, "platina" to false))
    launch()
    val folder = File(activity.cacheDir, "invizent-view-11111111-2222-3333-4444-555555555555").apply { mkdirs() }
    File(folder, "photo.jpg").writeBytes(ByteArray(3 * 1024))
    val other = File(activity.cacheDir, "kept.bin").apply { writeBytes(ByteArray(10)) }
    val settings = SettingsScreen(activity, account)
    stack.push(settings, animated = false); idle()
    settings.openDetail("data"); idle()
    assertEquals("DataScreen", topName)
    assertEquals(listOf("/e2ee/limits"), account.got)
    has("Данные и память", "ФАЙЛЫ НА СЕРВЕРЕ", "Использовано", "5 ГБ / 20 ГБ", "Видео до 10 ГБ, файлы до 2 ГБ, всего 20 ГБ. С Platina — файлы до 4 ГБ и 40 ГБ всего.",
      "Зашифрованные вложения из личных чатов. Сервер не может их прочитать.", "КЭШ НА ЭТОМ УСТРОЙСТВЕ", "Временные файлы",
      "Расшифрованные для просмотра вложения. Всё это можно скачать и расшифровать заново.", "Очистить кэш")
    waitFor("3 КБ")
    shot("72-look-data")
    press("Очистить кэш")
    waitFor("Кэш очищен. Переписка, ключи шифрования и твои музыкальные файлы не затронуты.")
    waitFor("0 Б")
    assertFalse(folder.exists())
    // Nothing but the decrypted attachments is touched.
    assertTrue(other.exists())

    // Without an answer about the storage the page says so.
    account.limits = Result.failure(ServerError.Network("Нет связи с сервером."))
    back()
    (top as SettingsScreen).openDetail("data"); idle()
    has("Недоступно")
    hasNot("5 ГБ / 20 ГБ")
  }

  @Test fun theSectionOpensThePagesOfTheLook() {
    launchWithAccount("nothing")
    assertEquals("SettingsScreen", topName)
    has("Уведомления и звуки", "Оформление", "Чёрная", "Данные и память")
    press("Уведомления и звуки")
    assertEquals("NotificationsScreen", topName)
    back()
    press("Данные и память")
    assertEquals("DataScreen", topName)
    back()
    press("Оформление")
    assertEquals("AppearanceScreen", topName)
    press("Ночная тема")
    assertEquals("NightThemeScreen", topName)
    back()
    press("Цвет интерфейса")
    assertEquals("AccentColorScreen", topName)
    // Without an account the pages that need one do not open.
    launch()
    activity.openSettings("notifications"); idle()
    assertEquals(1, stack.depth)
    activity.openSettings("data"); idle()
    assertEquals(1, stack.depth)
  }
}
