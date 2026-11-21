package com.linea.messenger

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.shell.Navigation
import com.linea.messenger.stories.OwnPostsScreen
import com.linea.messenger.stories.ProfilePostsBlock
import com.linea.messenger.stories.SeenPosts
import com.linea.messenger.stories.StoriesStore
import com.linea.messenger.stories.StoryComposeScreen
import com.linea.messenger.stories.StoryStripCell
import com.linea.messenger.stories.StoryTileView
import com.linea.messenger.stories.StoryViewer
import com.linea.messenger.stories.StoryViewersSheet
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** Stories and profile posts, built and drawn on the JVM with the real core behind them (`CoreSharingRunner`):
 *  the launch arguments of the emulator check (`--es storiesdemo …`) show what they should, with the words of the
 *  iPhone app. Each page is saved as a picture in build/pages/. Not a phone: nothing is picked, played or sent. */
@RunWith(CoreSharingRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class StoriesPagesTest {
  private lateinit var activity: MainActivity
  private lateinit var page: View

  @Before fun theCoreIsHere() { assumeTrue(Core.loaded) }

  @After fun nothingStaysOpen() {
    (ShadowDialog.getLatestDialog() as? StoryViewersSheet)?.dismiss()
    ShadowDialog.getShownDialogs().filterIsInstance<StoryViewer>().forEach { it.dismiss() }
    ShadowDialog.reset()
  }

  /** The strip is worked out off the main thread: the page is given the time for it. */
  private fun idle(ms: Long = 400) {
    repeat(6) {
      Thread.sleep(20)
      shadowOf(activity.mainLooper).idleFor(ms / 6, TimeUnit.MILLISECONDS)
    }
  }

  private fun launch(demo: String, wait: Long = 400) {
    activity = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN).putExtra("storiesdemo", demo)).setup().get()
    page = activity.window.decorView
    idle(wait)
  }

  private fun snap(name: String, view: View = page) {
    if (view.width <= 0 || view.height <= 0) return
    val picture = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
    view.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun all(view: View, into: MutableList<View> = ArrayList()): List<View> {
    if (view.visibility != View.VISIBLE) return into
    into.add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) all(view.getChildAt(index), into)
    return into
  }

  private fun texts(view: View): List<String> = all(view).filterIsInstance<TextView>().map { it.text.toString() }.filter { it.isNotEmpty() }
  private fun named(view: View): List<String> = all(view).mapNotNull { it.contentDescription?.toString() }
  private val top: View? get() = (all(page).first { it is Navigation } as Navigation).top

  @Test fun theStripStandsAboveTheChats() {
    launch("strip")
    snap("50-stories-strip")
    val cells = all(page).filterIsInstance<StoryStripCell>()
    // «Моя история», then those with something new (the newest first), then the one whose stories were all watched.
    assertEquals(listOf("Моя история", "Алиса Воронцова, новых историй: 2", "Дмитрий Орлов, новых историй: 2", "Лев, запись", "Игорь Белов, новых историй: 1, заявка", "Марина Ким, истории просмотрены"),
      cells.map { it.contentDescription.toString() })
    assertEquals(listOf("Моя история", "Алиса", "Дмитрий", "Лев", "запись", "Игорь", "заявка", "Марина"), cells.flatMap { texts(it) })
    assertTrue(named(cells[0]).contains("Добавить историю"))
    // The strip is the first thing of the list, and the chats are still under it.
    assertTrue(texts(page).contains("Чаты"))
    assertTrue(cells[0].width > 0 && cells[0].height > 0)
    assertEquals(listOf(true, true, "Мария Орлова"), listOf(StoriesStore.show, StoriesStore.mineHas, StoriesStore.me?.displayName))
  }

  @Test fun aFriendsStoryOpensAtTheFirstOneNotWatched() {
    launch("viewer", wait = 2000)
    val viewer = ShadowDialog.getLatestDialog() as StoryViewer
    assertTrue(viewer.isShowing)
    val shown = viewer.window!!.decorView
    idle()
    snap("51-stories-viewer", shown)
    assertEquals(listOf("demo-person-0", "demo-s-a2", true, false), listOf(viewer.shownGroup.key, viewer.shownPost?.id, viewer.shownGroup.story, viewer.shownGroup.own))
    // The check's viewer stands still.
    assertEquals(0.4, viewer.frozenAt!!, 0.0)
    val words = texts(shown)
    assertTrue(words.toString(), words.containsAll(listOf("Алиса Воронцова", "3 ч назад", "Вид с перевала. Дальше — только пешком.")))
    // Without an account there is nobody to answer to: no field, no count of views.
    assertTrue(all(shown).none { it is EditText })
    assertEquals(listOf("Фото", "Закрыть"), named(shown).filter { it == "Фото" || it == "Закрыть" || it == "Видео" })
    // Watched: the strip knows at once, without a server.
    viewer.closeNow()
    idle()
    assertFalse(viewer.isShowing)
    val alisa = all(page).filterIsInstance<StoryStripCell>().map { it.contentDescription.toString() }.first { it.startsWith("Алиса") }
    assertEquals("Алиса Воронцова, новых историй: 1", alisa)
  }

  @Test fun whoWatchedTheAccountsOwnStory() {
    launch("viewers", wait = 3000)
    val sheet = ShadowDialog.getLatestDialog() as StoryViewersSheet
    assertTrue(sheet.isShowing)
    val viewer = ShadowDialog.getShownDialogs().filterIsInstance<StoryViewer>().last()
    idle()
    snap("52-stories-viewers-story", viewer.window!!.decorView)
    snap("52-stories-viewers", sheet.window!!.decorView)
    assertEquals(listOf("demo-me", "demo-s-me1", true), listOf(viewer.shownGroup.key, viewer.shownPost?.id, viewer.shownGroup.own))
    val words = texts(sheet.window!!.decorView)
    assertEquals(listOf("Просмотры", "Просмотров: 5"), words.take(2))
    assertTrue(words.toString(), words.containsAll(listOf("Алиса Воронцова", "@alisa_v", "Дмитрий Орлов", "Марина Ким")))
    assertFalse(words.contains("Пока никто не смотрел"))
    // Under it: the story with its own count, and no field for an answer.
    val under = viewer.window!!.decorView
    assertTrue(named(under).toString(), named(under).contains("Просмотры: 5"))
    assertTrue(texts(under).containsAll(listOf("Мария Орлова", "Утро", "5")))
    assertTrue(all(under).none { it is EditText })
    sheet.dismiss()
    idle()
    assertTrue(viewer.isShowing)
  }

  @Test fun theScreenBeforePublishing() {
    launch("compose")
    snap("53-stories-compose")
    val screen = top as StoryComposeScreen
    val words = texts(screen)
    assertEquals(listOf("История", "Вид с перевала", "Добавить историю"), words)
    assertTrue(named(screen).containsAll(listOf("Назад", "Фото", "Подпись", "Добавить историю")))
    // Near the limit the count shows up; past it the core's words do, and nothing is published.
    val field = all(screen).first { it is EditText } as EditText
    field.setText("я".repeat(280))
    idle()
    assertTrue(texts(screen).contains("20"))
    field.setText("я".repeat(301))
    idle()
    assertTrue(texts(screen).containsAll(listOf("-1", "Подпись — до 300 символов.")))
    field.setText("Утро")
    idle()
    assertEquals(listOf("История", "Утро", "Добавить историю"), texts(screen))
  }

  @Test fun aPersonsProfileShowsTheirPostsAndStories() {
    launch("posts")
    snap("54-stories-posts")
    val block = all(page).first { it is ProfilePostsBlock } as ProfilePostsBlock
    assertEquals(listOf("Публикации 8", "Истории 2", "Подарки 5"), texts(block)) // Gifts: the third tab (profile/Gifts.kt)
    assertEquals("post", block.shownTab)
    val tiles = all(block).filterIsInstance<StoryTileView>()
    assertEquals(8, tiles.size)
    assertEquals(listOf("Фото", "Фото", "Видео", "Фото"), tiles.take(4).map { it.contentDescription.toString() })
    // Three in a row, each a square.
    assertEquals(listOf(0, 0, 0, tiles[1].left), tiles.take(4).map { it.top })
    assertEquals(listOf(0, tiles[0].width + (tiles[1].left - tiles[0].width), 0), listOf(tiles[0].left, tiles[1].left, tiles[3].left))
    assertTrue(tiles.all { it.width == it.height && it.width > 0 })
    // Somebody else's profile: nothing to add. The ring around the picture opens the stories.
    assertFalse(texts(block).any { it.startsWith("Добавить") })
    assertTrue(named(page).contains("Истории"))
    block.emulatorShow("story")
    idle()
    assertEquals(2, all(block).filterIsInstance<StoryTileView>().size)
    // A tile opens the viewer on it; no line of the owner here — the profile behind says whose these are.
    block.emulatorOpenFirst()
    idle()
    val viewer = ShadowDialog.getLatestDialog() as StoryViewer
    assertEquals(listOf("demo-ps-0", true, false, null), listOf(viewer.shownPost?.id, viewer.shownGroup.story, viewer.shownGroup.own, viewer.shownGroup.owner))
    assertTrue(texts(viewer.window!!.decorView).contains("2 ч назад"))
  }

  @Test fun theAccountsOwnPostsAndStories() {
    launch("own")
    snap("55-own-posts")
    val screen = top as OwnPostsScreen
    assertEquals(listOf("Публикации и истории", "Публикации 8", "Истории 2", "Подарки 5", "Добавить публикацию"), texts(screen))
    assertEquals(8, all(screen).filterIsInstance<StoryTileView>().size)
    screen.block.emulatorShow("story")
    idle()
    assertEquals(listOf("Публикации и истории", "Публикации 8", "Истории 2", "Подарки 5", "Добавить историю"), texts(screen))
    // The account's own story: who watched instead of an answer.
    screen.block.emulatorOpenFirst()
    idle()
    val viewer = ShadowDialog.getLatestDialog() as StoryViewer
    assertEquals(listOf("demo-ps-0", true, true), listOf(viewer.shownPost?.id, viewer.shownGroup.story, viewer.shownGroup.own))
    assertTrue(named(viewer.window!!.decorView).contains("Просмотры: 7"))
  }

  @Test fun openedPostsAreKeptOnThisPhoneUnderTheReferencesKey() {
    launch("strip")
    val seen = SeenPosts(activity, "u1")
    assertEquals(emptyList<String>(), seen.ids)
    assertTrue(seen.add(listOf("p1", "p2")))
    val kept = activity.getSharedPreferences(SeenPosts.PREFERENCES, Context.MODE_PRIVATE)
    assertEquals("[\"p1\",\"p2\"]", kept.getString("linea.seen-posts.v1:u1", null))
    assertEquals(listOf("p1", "p2"), SeenPosts(activity, "u1").ids)
    // Another account on the same phone has its own list.
    assertEquals(emptyList<String>(), SeenPosts(activity, "u2").ids)
    assertNull(kept.getString("linea.seen-posts.v1:u2", null))
    assertNotNull(kept.getString(seen.key, null))
  }
}
