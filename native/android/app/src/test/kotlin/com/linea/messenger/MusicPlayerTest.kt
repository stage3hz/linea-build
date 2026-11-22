package com.linea.messenger

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.music.MusicEngine
import com.linea.messenger.music.MusicFailure
import com.linea.messenger.music.MusicIncoming
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.music.MusicStore
import com.linea.messenger.music.MusicSurroundings
import com.linea.messenger.music.MusicTrack
import com.linea.messenger.net.Server
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
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/** The player's own rules — the queue, the order, what ends and what fails, the library on the device — with a
 *  made-up engine in place of the sound and a made-up answer in place of the catalogue (no network, no audio);
 *  and the pages of «AI» and «Музыка» built from the debug build's samples.
 *  Not a phone: no service, no notification, no audio focus — those are checked on the emulator. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MusicPlayerTest {
  private class Engine : MusicEngine {
    override var onState: (() -> Unit)? = null
    override var onEnded: (() -> Unit)? = null
    override var onFailed: (() -> Unit)? = null
    override var playing = false
    override var ready = false
    override var waiting = false
    override var position = 0.0
    override var duration = 0.0
    var loaded = ArrayList<Pair<String, Boolean>>()
    var mayPlay = true
    var rested = 0
    override fun load(source: String, local: Boolean) { loaded.add(source to local); ready = false; playing = false; position = 0.0 }
    override fun play(): Boolean { if (mayPlay) playing = true; return mayPlay }
    override fun pause() { playing = false }
    override fun seek(seconds: Double) { position = seconds }
    override fun silence() { playing = false; ready = false }
    override fun rest() { rested += 1 }
    fun prepared(length: Double) { ready = true; duration = length; onState?.invoke() }
  }

  private class Store(override val folder: File?, var text: String? = null) : MusicStore {
    override fun read(): String? = text
    override fun write(text: String) { this.text = text }
  }

  private class Around : MusicSurroundings {
    var started = 0; var stopped = 0
    override fun started() { started += 1 }
    override fun stopped() { stopped += 1 }
  }

  private class Kit(text: String? = null, random: Random = Random(7)) {
    val engine = Engine()
    val folder = File(System.getProperty("java.io.tmpdir"), "music-test-" + System.nanoTime())
    val store = Store(folder, text)
    val around = Around()
    val asked = ArrayList<String>()
    var answer: (MusicTrack) -> Result<String> = { Result.success("https://cdn.example.org/${it.sourceId}.mp3") }
    val restored = ArrayList<String>()
    val player = MusicPlayer({ track, _: Server?, done -> asked.add(track.id); done(answer(track)) }, { id, done -> restored.add(id); done(Result.failure(MusicFailure("нет сети"))) }, random)
    var changes = 0
    init { player.changed.watch { changes += 1 } }
    fun attach(): Kit { player.attach(engine, store, around); return this }
  }

  private fun audius(index: Int) = MusicTrack(id = "audius:a$index", source = "audius", sourceId = "a$index", title = "Трек $index", artist = "Автор", duration = 100.0)
  private fun cloud(index: Int) = MusicTrack(id = "sc:soundcloud:tracks:$index", source = "soundcloud", sourceId = "soundcloud:tracks:$index", title = "Облако $index", artist = "Автор")
  private val three = listOf(audius(1), audius(2), audius(3))

  @Test fun aTrackIsAskedOfItsCatalogueAndPlayed() {
    val kit = Kit().attach()
    val player = kit.player
    assertNull(player.current)
    assertFalse(player.playing || player.loading)
    player.play(three[0], three)
    assertEquals(listOf("audius:a1"), kit.asked)
    assertEquals(listOf("https://cdn.example.org/a1.mp3" to false), kit.engine.loaded)
    assertEquals(three, player.queue)
    assertEquals(1, kit.around.started)
    // Asked to play, but the sound is not open yet: playing, and still loading.
    assertTrue(player.playing && player.loading)
    assertEquals(100.0, player.duration, 0.0)
    kit.engine.prepared(98.5)
    assertTrue(player.playing)
    assertFalse(player.loading)
    assertEquals(98.5, player.duration, 0.0)
    kit.engine.position = 12.0
    assertEquals(12.0, player.position, 0.0)
    player.togglePlayback()
    assertFalse(player.playing)
    player.setPlaying(false)
    assertFalse(kit.engine.playing)
    player.setPlaying(true)
    assertTrue(player.playing)
    player.seek(500.0)
    assertEquals(98.5, kit.engine.position, 0.0)
    player.seek(-3.0)
    assertEquals(0.0, kit.engine.position, 0.0)
    player.stop()
    assertNull(player.current)
    assertTrue(player.queue.isEmpty())
    assertEquals(1, kit.engine.rested)
    assertEquals(1, kit.around.stopped)
    assertEquals(0.0, player.position, 0.0)
  }

  @Test fun theQueueGoesOnAndBack() {
    val kit = Kit().attach()
    val player = kit.player
    player.play(three[0], three)
    kit.engine.prepared(100.0)
    player.next()
    assertEquals("audius:a2", player.current?.id)
    // More than three seconds in: «back» is the beginning of this track; at its beginning — the track before.
    kit.engine.prepared(100.0)
    kit.engine.position = 40.0
    player.previous()
    assertEquals("audius:a2", player.current?.id)
    assertEquals(0.0, kit.engine.position, 0.0)
    player.previous()
    assertEquals("audius:a1", player.current?.id)
    player.previous()
    assertEquals("audius:a1", player.current?.id)
    // The track played to its end: the next one starts by itself.
    kit.engine.prepared(100.0)
    kit.engine.onEnded?.invoke()
    assertEquals("audius:a2", player.current?.id)
    player.next()
    assertEquals("audius:a3", player.current?.id)
    // The end of the queue: the last track stays, paused, with a few words.
    kit.engine.prepared(100.0)
    kit.engine.onEnded?.invoke()
    assertEquals("audius:a3", player.current?.id)
    assertFalse(player.playing)
    assertEquals("Очередь закончилась. Выбери следующий трек.", player.notice)
    player.clearNotice()
    assertEquals("", player.notice)
    // «Play» after the end starts the track again from its beginning.
    kit.engine.position = 100.0
    player.togglePlayback()
    assertTrue(player.playing)
    assertEquals(0.0, kit.engine.position, 0.0)
  }

  @Test fun repeatingTheQueueAndOneTrack() {
    val kit = Kit().attach()
    val player = kit.player
    player.play(three[2], three)
    kit.engine.prepared(100.0)
    assertEquals("off", player.repeatMode)
    player.toggleRepeat()
    assertEquals("all", player.repeatMode)
    player.next()
    assertEquals("audius:a1", player.current?.id)
    player.previous()
    assertEquals("audius:a3", player.current?.id)
    player.toggleRepeat()
    assertEquals("one", player.repeatMode)
    kit.engine.prepared(100.0)
    kit.engine.position = 99.0
    val loads = kit.engine.loaded.size
    kit.engine.playing = false
    kit.engine.onEnded?.invoke()
    // The same track again, without asking the catalogue anew.
    assertEquals("audius:a3", player.current?.id)
    assertEquals(loads, kit.engine.loaded.size)
    assertEquals(0.0, kit.engine.position, 0.0)
    assertTrue(player.playing)
    player.toggleRepeat()
    assertEquals("off", player.repeatMode)
  }

  @Test fun aShuffledQueuePlaysEveryTrackOnce() {
    val many = (1..8).map { audius(it) }
    val kit = Kit().attach()
    val player = kit.player
    player.play(many[0], many)
    player.toggleShuffle()
    assertTrue(player.shuffle)
    val heard = arrayListOf(player.current!!.id)
    repeat(7) { player.next(); heard.add(player.current!!.id) }
    assertEquals(many.map { it.id }.toSet(), heard.toSet())
    assertEquals(8, heard.size)
    assertTrue(heard != many.map { it.id })
    // «Back» walks the way it came.
    kit.engine.position = 0.0
    player.previous()
    assertEquals(heard[6], player.current?.id)
    player.previous()
    assertEquals(heard[5], player.current?.id)
    // Everything was heard: nothing more without «repeat», the whole round again with it.
    repeat(2) { player.next() }
    player.next()
    assertEquals("Очередь закончилась. Выбери следующий трек.", player.notice)
    player.toggleRepeat()
    val last = player.current!!.id
    player.next()
    assertTrue(player.current!!.id != last)
  }

  @Test fun oneServicePerQueue() {
    val kit = Kit().attach()
    val player = kit.player
    val mixed = listOf(audius(1), cloud(1), audius(2), cloud(2), audius(1))
    player.play(cloud(2), mixed)
    assertEquals(listOf("sc:soundcloud:tracks:1", "sc:soundcloud:tracks:2"), player.queue.map { it.id })
    // A track that is not in the given list stands first in its own queue.
    player.play(audius(9), listOf(audius(1), audius(2)))
    assertEquals(listOf("audius:a9", "audius:a1", "audius:a2"), player.queue.map { it.id })
    // A track of the queue that is on keeps the queue; another one alone starts its own.
    player.play(audius(2))
    assertEquals(3, player.queue.size)
    player.play(audius(5))
    assertEquals(listOf("audius:a5"), player.queue.map { it.id })
  }

  @Test fun whatDoesNotPlaySaysWhy() {
    val kit = Kit().attach()
    val player = kit.player
    kit.answer = { Result.failure(MusicFailure("Автор ограничил доступ к треку, или он больше недоступен.")) }
    player.play(three[0], three)
    assertEquals("Автор ограничил доступ к треку, или он больше недоступен.", player.error)
    assertFalse(player.playing || player.loading)
    assertTrue(kit.engine.loaded.isEmpty())
    // Only a plain https address is ever given to the engine.
    for (address in listOf("http://cdn.example.org/a.mp3", "file:///data/a.mp3", "content://x/a", "https://user:pass@cdn.example.org/a.mp3")) {
      kit.answer = { Result.success(address) }
      player.play(three[0], three)
      assertEquals(address, "Источник музыки вернул неподходящий адрес.", player.error)
    }
    assertTrue(kit.engine.loaded.isEmpty())
    // «Play» on a track that did not start asks for it again.
    kit.answer = { Result.success("https://cdn.example.org/a.mp3") }
    player.togglePlayback()
    assertEquals("", player.error)
    assertEquals(1, kit.engine.loaded.size)
    // The source broke while playing.
    kit.engine.prepared(100.0)
    kit.engine.onFailed?.invoke()
    assertEquals("Не удалось воспроизвести трек. Попробуй другой источник.", player.error)
    assertFalse(player.playing)
    player.clearError()
    assertEquals("", player.error)
    // The system does not let the app sound now (a call).
    kit.engine.mayPlay = false
    player.play(three[1], three)
    assertEquals("Не удалось включить трек. Проверь соединение и попробуй ещё раз.", player.error)
    // A track that never opens is given up after half a minute.
    kit.engine.mayPlay = true
    player.play(three[2], three)
    assertTrue(player.loading)
    shadowOf(android.os.Looper.getMainLooper()).idleFor(31, TimeUnit.SECONDS)
    assertEquals("Трек загружается слишком долго. Проверь соединение и попробуй ещё раз.", player.error)
    // A file of the device that is not in the library.
    player.play(MusicTrack(id = "local:x", source = "local", title = "Файл", artist = "На этом устройстве"))
    assertEquals("Файл не найден. Импортируй его с устройства ещё раз.", player.error)
    kit.folder.deleteRecursively()
  }

  @Test fun aLateAnswerOfTheCatalogueStartsNothing() {
    val kit = Kit()
    var late: ((Result<String>) -> Unit)? = null
    val player = MusicPlayer({ _, _: Server?, done -> late = done }, { _, _ -> }, Random(1))
    player.attach(kit.engine, kit.store, kit.around)
    player.play(three[0], three)
    val first = late!!
    player.play(three[1], three)
    first(Result.success("https://cdn.example.org/old.mp3"))
    assertTrue(kit.engine.loaded.isEmpty())
    late!!(Result.success("https://cdn.example.org/new.mp3"))
    assertEquals(listOf("https://cdn.example.org/new.mp3" to false), kit.engine.loaded)
    player.stop()
    player.play(three[2], three)
    val stopped = late!!
    player.stop()
    stopped(Result.success("https://cdn.example.org/x.mp3"))
    assertEquals(1, kit.engine.loaded.size)
  }

  private fun wait(until: () -> Boolean) {
    val end = System.currentTimeMillis() + 5000
    while (!until() && System.currentTimeMillis() < end) { shadowOf(android.os.Looper.getMainLooper()).idle(); Thread.sleep(10) }
    assertTrue(until())
  }

  @Test fun thePersonsOwnFilesAndTheFavourites() {
    val kit = Kit().attach()
    val player = kit.player
    var done = false
    player.importFiles(listOf(
      MusicIncoming("Запись.mp3", 5, "audio/mpeg") { "звук1".byteInputStream() },
      MusicIncoming("recording", 0, "audio/flac") { "звук22".byteInputStream() },
    )) { done = true }
    wait { done }
    assertEquals("Добавлено файлов: 2. Музыка сохранена только на этом устройстве.", player.notice)
    assertEquals(listOf("recording", "Запись"), player.saved.map { it.title })
    val own = player.saved[1]
    val file = player.file(own)!!
    assertEquals("звук1", file.readText())
    assertTrue(file.parentFile == kit.folder && Regex("[0-9a-f-]{36}\\.mp3").matches(file.name))
    assertEquals("audio/flac", player.saved[0].mimeType)
    assertEquals("На этом устройстве", player.saved[0].artist)
    // Not audio, or empty: not taken, with the words why; what was taken before it stays.
    done = false
    player.importFiles(listOf(MusicIncoming("ok.wav", 3, null) { "abc".byteInputStream() }, MusicIncoming("notes.txt", 3, "text/plain") { "abc".byteInputStream() }, MusicIncoming("late.mp3", 3, null) { "abc".byteInputStream() })) { done = true }
    wait { done }
    assertEquals("Выбери аудиофайл: MP3, M4A, WAV, FLAC или другой поддерживаемый формат.", player.error)
    assertEquals(3, player.saved.size)
    done = false
    player.importFiles(listOf(MusicIncoming("empty.mp3", 0, null) { ByteArray(0).inputStream() })) { done = true }
    wait { done }
    assertEquals("Аудиофайл пустой или больше 250 МБ.", player.error)
    assertEquals(3, kit.folder.listFiles()!!.size)
    player.clearError()

    // A file of the library plays from the app's own folder, without any catalogue.
    player.play(own, player.saved)
    assertEquals(listOf(file.path to true), kit.engine.loaded)
    assertTrue(kit.asked.isEmpty())

    // Favourites: a catalogue's track is kept by its id only, a file — as it is.
    player.toggleFavorite(audius(1))
    player.toggleFavorite(cloud(4))
    player.toggleFavorite(own)
    assertTrue(player.isFavorite(audius(1)) && player.isFavorite(own))
    val kept = Core.map(Core.value(kit.store.text))!!
    assertEquals(1.0, kept["version"])
    assertEquals(listOf("a1"), kept["audiusFavoriteIds"])
    assertEquals(listOf("soundcloud:tracks:4"), kept["soundcloudFavoriteIds"])
    assertEquals(listOf(own.id), (kept["favorites"] as List<*>).map { Core.map(it)!!["id"] })
    assertEquals(3, (kept["saved"] as List<*>).size)
    assertFalse(kit.store.text!!.contains("Трек 1") || kit.store.text!!.contains("Облако"))

    // The next start reads it back; a catalogue's favourite that cannot be asked now is said so.
    val again = Kit(kit.store.text)
    again.store.text = kit.store.text
    val next = MusicPlayer({ _, _: Server?, _ -> }, { id, done -> again.restored.add(id); done(Result.failure(MusicFailure("нет сети"))) })
    next.attach(again.engine, Store(kit.folder, kit.store.text), null)
    assertEquals(player.saved, next.saved)
    assertEquals(listOf(own.id), next.favorites.map { it.id })
    assertEquals(listOf("a1"), again.restored)
    assertEquals("Часть избранного Audius сейчас недоступна. Локальная музыка остаётся на устройстве.", next.notice)

    // Taking a file out of the app stops it, deletes the copy and forgets it everywhere.
    player.removeSaved(own)
    assertNull(player.current)
    assertFalse(file.exists())
    assertFalse(player.isFavorite(own))
    assertEquals(2, player.saved.size)
    player.toggleFavorite(audius(1))
    assertEquals(emptyList<Any>(), Core.map(Core.value(kit.store.text))!!["audiusFavoriteIds"])
    kit.folder.deleteRecursively()
  }

  @Test fun aLibraryThatIsNotOursIsLeftAlone() {
    val kit = Kit("""{"version":2,"saved":[]}""").attach()
    assertEquals("Не удалось прочитать музыкальную библиотеку.", kit.player.error)
    val broken = Kit("не JSON").attach()
    assertEquals("", broken.player.error)
    // A kept file that is gone from the folder, and a name that would leave the folder, are not shown.
    val lost = Kit("""{"version":1,"saved":[{"track":{"id":"local:1","source":"local","title":"a","artist":"b"},"file":"00000000-0000-4000-8000-000000000001.mp3"},
      {"track":{"id":"local:2","source":"local","title":"a","artist":"b"},"file":"../../outside.mp3"}],"favorites":[],"audiusFavoriteIds":["bad id!"],"soundcloudFavoriteIds":["x"]}""").attach()
    assertTrue(lost.player.saved.isEmpty())
    assertTrue(lost.restored.isEmpty())
    for (made in listOf(kit, broken, lost)) made.folder.deleteRecursively()
  }

  // The pages (the debug build's samples: no server, no network, no sound)

  private fun launch(name: String, intent: Intent, wait: Long = 400): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    shot(name, activity.window.decorView)
    return activity
  }

  private fun shot(name: String, page: View) {
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun find(view: View, className: String): View? {
    if (view.javaClass.simpleName == className) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), className)?.let { return it }
    return null
  }

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    if (view is TextView) into.add(view.text.toString())
    if (view is ViewGroup) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun spoken(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    view.contentDescription?.let { into.add(it.toString()) }
    if (view is ViewGroup) for (index in 0 until view.childCount) spoken(view.getChildAt(index), into)
    return into
  }

  private fun intent() = Intent(Intent.ACTION_MAIN)

  @Test fun theAISectionWithItsSamples() {
    val activity = launch("20-ai-demo", intent().putExtra("aidemo", "1"))
    val page = find(activity.window.decorView, "AIScreen")
    assertNotNull(page)
    val words = texts(page!!)
    assertTrue(words.containsAll(listOf("Чем отличается val от var в Kotlin?", "Покажи пример со списком", "А если добавить элемент в names?", "Ответ за 3 с", "Ответ за 5 с",
      "AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз.", "Повторить этот вопрос", "Умная ⌄")))
    // The block of code is shown without its fence.
    assertTrue(words.any { it.contains("val names = listOf") && !it.contains("```") })
    val names = spoken(page)
    assertTrue(names.containsAll(listOf("История AI-бесед", "Начать новую AI-беседу", "Приватная беседа: не сохранять в историю", "Режимы AI и вложения", "Отправить вопрос AI", "Скопировать ответ AI", "Как получен ответ", "Модель AI: Умная. Выбрать другую")))
    assertEquals(2, (find(activity.window.decorView, "TabBarView") as ViewGroup).childCount)
  }

  @Test fun theHistoryOfTheAISection() {
    val activity = launch("21-ai-history", intent().putExtra("aidemo", "history"), wait = 2500)
    assertNotNull(find(activity.window.decorView, "AIScreen"))
    val sheet = ShadowDialog.getLatestDialog()
    assertNotNull(sheet)
    assertTrue(sheet.isShowing)
    val content = sheet.window!!.decorView
    shot("21-ai-history-sheet", content)
    val words = texts(content)
    assertTrue(words.containsAll(listOf("История AI", "Чем отличается val от var в Kotlin?", "Рецепт сырников без муки")))
    assertTrue(words.any { it.endsWith(" · 3 вопроса") } && words.any { it.endsWith(" · 1 вопрос") })
    assertTrue(spoken(content).contains("Удалить беседу Рецепт сырников без муки"))
    sheet.dismiss()
  }

  @Test fun withoutAnAccountTheAISectionAsksNothing() {
    val activity = launch("22-ai-empty", intent().putExtra("demo", true).putExtra("tab", "ai"))
    val page = find(activity.window.decorView, "AIScreen")!!
    assertTrue(texts(page).containsAll(listOf("AI пока не подключён на этом сервере", "Когда администратор подключит сервис, здесь можно будет задать вопрос.", "Проверить снова")))
  }

  @Test fun theMusicSectionWithItsSamples() {
    val activity = launch("23-music-demo", intent().putExtra("musicdemo", "1"))
    val page = find(activity.window.decorView, "MusicScreen")
    assertNotNull(page)
    // A list builds its rows when it is laid out.
    val words = texts(page!!)
    assertTrue(words.toString(), words.containsAll(listOf("Музыка", "Главная", "Любимое", "Мои файлы", "Любое", "Спокойно", "Слушать микс", "Новые имена и любимый звук", "ОТКРОЙ ДЛЯ СЕБЯ",
      "Северное сияние", "Полночь над рекой")))
    // F: the reference's order — «Слушать микс» (the hero of the top) comes before the search, the search before the shelves.
    assertTrue(words.indexOf("Слушать микс") < words.indexOf("Артисты"))
    assertTrue(spoken(page).indexOf("Слушать микс") < spoken(page).indexOf("Поиск музыки"))
    // Music: the shelves «Любимое» and «Артисты» stand above the list now (music/MusicShelves.kt); the footer is further down.
    assertTrue(words.containsAll(listOf("Артисты", "Артист")))
    // The strip of the «playing» track above the bar.
    val mini = find(page, "MiniPlayerView")!!
    assertEquals(View.VISIBLE, mini.visibility)
    assertTrue(texts(mini).containsAll(listOf("Полночь над рекой", "Квартал 9")))
    assertTrue(spoken(mini).containsAll(listOf("Предыдущий трек или начало текущего", "Пауза", "Следующий трек", "Закрыть плеер и остановить музыку")))
    val bar = find(activity.window.decorView, "TabBarView")!!
    assertTrue(mini.bottom <= bar.top + (bar.parent as View).top)
    // Music: the tall top and the shelves push the rows below the screen: the list is scrolled to them; the rows say
    // what their buttons do.
    val list = find(page, "ListView") as android.widget.ListView
    list.setSelection(list.headerViewsCount)
    shadowOf(activity.mainLooper).idleFor(300, TimeUnit.MILLISECONDS)
    assertTrue(texts(page).toString(), texts(page).contains("Лера Туман · 3:34 · AUDIUS"))
    assertTrue(spoken(page).containsAll(listOf("Убрать из любимого: Северное сияние", "В любимое: Полночь над рекой", "Слушать: Северное сияние, Лера Туман")))
  }

  @Test fun theFullPlayerOverTheSamples() {
    val activity = launch("24-music-player", intent().putExtra("musicdemo", "player"), wait = 2500)
    val page = find(activity.window.decorView, "PlayerScreen")
    assertNotNull(page)
    val words = texts(page!!)
    assertTrue(words.containsAll(listOf("Сейчас играет", "AUDIUS · ОНЛАЙН", "Полночь над рекой", "Квартал 9", "Перемешать", "В любимое", "1:14", "3:07", "Очередь · 6", "Текст")))
    assertTrue(spoken(page).containsAll(listOf("Свернуть плеер", "Закрыть плеер и остановить музыку", "Добавить в избранное", "Ещё", "Позиция воспроизведения", "Повтор выключен", "Приостановить", "Показать очередь")))
    // Back folds the player away; the section and its strip are still there.
    @Suppress("DEPRECATION") activity.onBackPressed()
    shadowOf(activity.mainLooper).idleFor(600, TimeUnit.MILLISECONDS)
    assertNull(find(activity.window.decorView, "PlayerScreen"))
    assertNotNull(find(activity.window.decorView, "MiniPlayerView"))
  }
}
