package com.linea.messenger

import android.app.AlertDialog
import android.content.DialogInterface
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.view.ViewGroup
import android.widget.Switch
import android.widget.TextView
import com.linea.messenger.chat.MsgRowView
import com.linea.messenger.core.Core
import com.linea.messenger.linkpreview.LinkComposer
import com.linea.messenger.linkpreview.LinkComposerCard
import com.linea.messenger.linkpreview.LinkDemo
import com.linea.messenger.linkpreview.LinkFetcher
import com.linea.messenger.linkpreview.LinkOpen
import com.linea.messenger.linkpreview.LinkPicture
import com.linea.messenger.linkpreview.LinkSettings
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
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit

/** The cards of links, built and drawn on the JVM as `PagesTest` does: the launch arguments of the emulator
 *  check show what they should, with the words of the iPhone app; the card above the field follows the typing;
 *  the switch of the settings is kept. Each page is saved as a picture in build/pages/. Not a phone, and no
 *  network: the fetcher's place is taken by the test wherever a page would be asked for. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LinkPreviewPagesTest {
  private fun snap(name: String, page: View) {
    if (page.width <= 0 || page.height <= 0) return
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun launch(name: String, intent: Intent, wait: Long = 1000): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    snap(name, activity.window.decorView)
    return activity
  }

  private fun idle(activity: MainActivity, wait: Long = 600) = shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)

  private fun find(view: View, className: String): View? {
    if (view.javaClass.simpleName == className) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), className)?.let { return it }
    return null
  }

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view is TextView && view.visibility == View.VISIBLE) into.add(view.text.toString())
    if (view is ViewGroup && view.visibility == View.VISIBLE) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun rows(view: View, into: MutableList<MsgRowView> = ArrayList()): List<MsgRowView> {
    if (view is MsgRowView) into.add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) rows(view.getChildAt(index), into)
    return into
  }

  /** The part of a row its card takes: left, top, right, bottom, found by asking the row point by point. */
  private fun cardBox(row: MsgRowView, url: String): List<Int> {
    var left = Int.MAX_VALUE; var top = Int.MAX_VALUE; var right = -1; var bottom = -1
    for (y in 0 until row.height step 3) for (x in 0 until row.width step 3) {
      val hit = row.cardAt(x.toFloat(), y.toFloat()) ?: continue
      assertEquals(url, hit)
      left = minOf(left, x); top = minOf(top, y); right = maxOf(right, x); bottom = maxOf(bottom, y)
    }
    return listOf(left, top, right, bottom)
  }

  private fun demo() = Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("chat", true)
  private val long = "https://journal.example.org/2026/11/kak-my-pereezzhali-v-novyj-ofis-i-nichego-ne-poteryali?utm_source=chat&page=2"
  private val short = "https://docs.example.org/plan"
  private val about = "Сорок коробок, три этажа и один лифт. Рассказываем, как спланировать переезд команды за выходные, что подписать на каждой коробке и почему проектор лучше нести в руках."

  @Test fun theSampleCardsOfLinks() {
    val activity = launch("44-link-cards", demo().putExtra("linkdemo", "1"))
    val chat = find(activity.window.decorView, "ChatScreen")!!
    val d = chat.resources.displayMetrics.density
    val own = rows(chat).single { it.rowKey == "link-demo-1" }
    val theirs = rows(chat).single { it.rowKey == "link-demo-2" }
    // A screen reader hears the message, then its card, then the time.
    assertEquals("Смотри, как у них получилось: $long. Журнал «Пример». Как мы переезжали в новый офис и ничего не потеряли. " + (if (Core.loaded) "$about. " else "") + "09:44", own.contentDescription.toString())
    assertEquals("Класс! А вот наш план $short. docs.example.org. План встречи: три пункта на полчаса. " + (if (Core.loaded) "Повестка, кто что готовит и таблица с цифрами за квартал.. " else "") + "09:46", theirs.contentDescription.toString())

    // The own message stands at the right edge of the page and its card starts where its text does (with a
    // picture the card is as wide as the text may be, so it reaches the edge); the other side's at the left one.
    val ownBox = cardBox(own, long); val theirBox = cardBox(theirs, short)
    assertTrue(ownBox.toString(), ownBox[0] > own.width * 0.2f && ownBox[2] <= own.width - 13f * d)
    assertEquals(Pair(long, long), own.runAt(ownBox[0] + 30f * d, ownBox[1] - 16f * d))
    if (Core.loaded) assertTrue(ownBox.toString(), ownBox[2] > own.width - 20f * d)
    assertTrue(theirBox.toString(), theirBox[0] >= 13f * d && theirBox[0] < 20f * d)
    // At most 320 dp wide; with a picture it takes all it may, without one it is as wide as its words.
    val widest = minOf(320f * d, own.width * 0.78f - 26f * d)
    if (Core.loaded) assertTrue(ownBox.toString(), ownBox[2] - ownBox[0] > widest - 8 && ownBox[2] - ownBox[0] <= widest)
    assertTrue(theirBox.toString(), theirBox[2] - theirBox[0] <= widest && theirBox[2] - theirBox[0] >= 140f * d - 4)
    // The picture makes the own card much the taller one.
    if (Core.loaded) assertTrue(ownBox[3] - ownBox[1] > theirBox[3] - theirBox[1] + 100f * d)
    // The link in the text above the card is still a link; the time stands under the card, not on the text's line.
    assertEquals(Pair(short, short), theirs.runAt(theirBox[0] + 120f * d, theirBox[1] - 16f * d))
    assertNull(theirs.cardAt(theirBox[0] + 20f * d, theirBox[1] - 16f * d))
    assertTrue(theirs.height - theirBox[3] in (16f * d).toInt()..(40f * d).toInt())
    // A row without a card has none; no card stands above the field.
    assertTrue(rows(chat).filter { !it.rowKey.startsWith("link-demo") }.all { row -> (0 until row.height step 5).all { y -> row.cardAt(row.width / 2f, y.toFloat()) == null } })
    assertFalse(find(chat, "LinkComposerCard")!!.visibility == View.VISIBLE)

    // A tap on a card opens its link at once (it is the link written in the message itself).
    LinkOpen.cardPressed(activity, short)
    val opened = shadowOf(activity).nextStartedActivity
    assertEquals(listOf(Intent.ACTION_VIEW, short), listOf(opened.action, opened.dataString))
  }

  @Test fun aCardWithItsPictureInARow() {
    val activity = launch("44-link-picture", demo())
    val d = activity.resources.displayMetrics.density
    val picture = android.util.Base64.encodeToString(LinkDemo.picture()!!, android.util.Base64.NO_WRAP)
    fun row(key: String, mine: Boolean) = com.linea.messenger.chat.MsgRow.parse(listOf(mapOf("key" to key, "kind" to 0, "mine" to mine, "text" to "Смотри: $short", "time" to "09:44", "ticks" to (if (mine) 2 else 0), "tail" to true,
      "fmt" to listOf(64, 8, short.length), "urls" to listOf(short),
      "card" to mapOf("url" to short, "site" to "Журнал «Пример»", "title" to "Как мы переезжали в новый офис и ничего не потеряли", "description" to about,
        "image" to mapOf("mimeType" to "image/jpeg", "base64" to picture, "width" to 480, "height" to 252))))).single()
    val page = android.widget.LinearLayout(activity).apply { orientation = android.widget.LinearLayout.VERTICAL; setBackgroundColor(com.linea.messenger.design.Theme.bg) }
    val views = listOf(row("a", true), row("b", false)).map { item -> MsgRowView(activity).also { it.bind(item, com.linea.messenger.design.Theme.messages, 17f); page.addView(it) } }
    val width = Math.round(411f * d)
    page.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    page.layout(0, 0, width, page.measuredHeight)
    snap("44-link-picture", page)
    val own = cardBox(views[0], short); val theirs = cardBox(views[1], short)
    // With a picture the card is as wide as a message's text may be (at most 320 dp): the own one reaches the
    // right edge of the page, the other side's starts at the left one.
    val widest = minOf(320f * d, width * 0.78f - 26f * d)
    for (box in listOf(own, theirs)) assertTrue(box.toString(), box[2] - box[0] > widest - 8 && box[2] - box[0] <= widest)
    assertTrue(own.toString(), own[2] > width - 20f * d && own[2] <= width - 13f * d)
    assertTrue(theirs.toString(), theirs[0] >= 13f * d && theirs[0] < 20f * d)
    // Site, title in two lines, description, the picture at its proportions under them, the time under the card.
    val column = widest - 24f * d
    assertTrue(own.toString(), own[3] - own[1] > column * 252f / 480f + 100f * d)
    assertTrue(views[0].height - own[3] in (16f * d).toInt()..(40f * d).toInt())
    assertEquals("Смотри: $short. Журнал «Пример». Как мы переезжали в новый офис и ничего не потеряли. $about. 09:44", views[0].contentDescription.toString())
  }

  @Test fun theSampleCardAboveTheField() {
    val activity = launch("45-link-composer", demo().putExtra("linkdemo", "composer"))
    val chat = find(activity.window.decorView, "ChatScreen")!!
    val card = find(chat, "LinkComposerCard") as LinkComposerCard
    assertEquals(View.VISIBLE, card.visibility)
    assertEquals(listOf("Журнал «Пример»", "Как мы переезжали в новый офис и ничего не потеряли", Core.loaded), listOf(card.site, card.title, card.hasPicture))
    val d = chat.resources.displayMetrics.density
    assertEquals(Math.round(56f * d), card.height)
    // Above the field, as wide as it, with a little air between; the rows are there as well.
    val composer = (chat as ViewGroup).let { group -> (0 until group.childCount).map { group.getChildAt(it) }.single { it is ViewGroup && find(it, "ComposerField") != null && it !== card } }
    assertEquals(listOf(composer.left, composer.right, composer.top - Math.round(6f * d)), listOf(card.left, card.right, card.bottom))
    assertEquals(2, rows(chat).count { it.rowKey.startsWith("link-demo") })
    // The cross: the card goes, and the field keeps its place.
    card.close()
    idle(activity)
    assertEquals(View.GONE, card.visibility)
    snap("45-link-composer-closed", activity.window.decorView)
  }

  /** A composer whose fetcher is the test's: what was asked for, and the answers the test gives. */
  private class Typing(activity: MainActivity) {
    val asked = ArrayList<String>()
    val tickets = ArrayList<LinkFetcher.Ticket>()
    val answers = ArrayList<(Map<String, Any?>?) -> Unit>()
    var changes = 0
    val links = LinkComposer(activity).apply {
      fetch = { url, done -> asked.add(url); answers.add(done); LinkFetcher.Ticket().also { tickets.add(it) } }
      // The first word that starts with https:// (the core's rule is checked with the core itself).
      candidate = { text -> text.split(" ", "\n").firstOrNull { it.startsWith("https://") } }
      onChanged = { changes += 1 }
    }
  }

  private fun card(url: String, title: String) = mapOf<String, Any?>("url" to url, "site" to "example.org", "title" to title, "description" to "")

  @Test fun theCardFollowsWhatIsTyped() {
    val activity = launch("46-link-typing", demo())
    LinkSettings.set(activity, true)
    val typing = Typing(activity); val links = typing.links
    // Nothing is asked for while the person is still typing: only after 600 ms of quiet.
    links.typed("смотри https://example.org/a", active = true)
    idle(activity, 500)
    links.typed("смотри https://example.org/ab", active = true)
    idle(activity, 599)
    assertEquals(emptyList<String>(), typing.asked)
    idle(activity, 2)
    assertEquals(listOf("https://example.org/ab"), typing.asked)
    assertFalse(links.shown)
    // The page answered: the card is there; typing on after the link asks for nothing more.
    typing.answers[0](card("https://example.org/ab", "Страница"))
    assertEquals(listOf(true, "example.org", "Страница", 1), listOf(links.shown, links.cardView.site, links.cardView.title, typing.changes))
    links.typed("смотри https://example.org/ab вот", active = true)
    idle(activity, 700)
    assertEquals(1, typing.asked.size)
    assertTrue(links.shown)
    // It goes with the message it was made for — and with no other text.
    assertNull(Typing(activity).links.take("смотри https://example.org/ab"))
    assertEquals("Страница", links.take("смотри https://example.org/ab вот")!!["title"])
    assertFalse(links.shown)
    assertNull(links.take("смотри https://example.org/ab вот"))

    // Another link: the work for the first one is given up, and its late answer is not shown.
    links.typed("https://example.org/one", active = true); idle(activity, 601)
    links.typed("https://example.org/two", active = true); idle(activity, 601)
    assertEquals(listOf("https://example.org/ab", "https://example.org/one", "https://example.org/two"), typing.asked)
    assertEquals(listOf(true, false), listOf(typing.tickets[1].cancelled, typing.tickets[2].cancelled))
    typing.answers[1](card("https://example.org/one", "Первая"))
    assertFalse(links.shown)
    typing.answers[2](card("https://example.org/two", "Вторая"))
    assertEquals("Вторая", links.cardView.title)
    // The text changed to another link before sending: the card of the old one does not go with it.
    assertNull(links.take("https://example.org/three"))
    // The link was removed: the card goes at once, without the wait.
    links.typed("https://example.org/two", active = true); idle(activity, 601)
    typing.answers.last()(card("https://example.org/two", "Вторая"))
    assertTrue(links.shown)
    links.typed("просто слова", active = true)
    assertFalse(links.shown)
    // A page that gave nothing shows nothing.
    links.typed("https://example.org/empty", active = true); idle(activity, 601)
    typing.answers.last()(null)
    assertFalse(links.shown)
    assertNull(links.take("https://example.org/empty"))
  }

  @Test fun theCrossDropsTheCardForThisMessage() {
    val activity = launch("46-link-cross", demo())
    LinkSettings.set(activity, true)
    val typing = Typing(activity); val links = typing.links
    links.typed("https://example.org/a", active = true); idle(activity, 601)
    typing.answers[0](card("https://example.org/a", "Страница"))
    assertEquals("Не прикладывать предпросмотр ссылки", (0 until links.cardView.childCount).mapNotNull { links.cardView.getChildAt(it).contentDescription?.toString() }.single { it.startsWith("Не ") })
    links.cardView.close()
    assertFalse(links.shown)
    // Whatever is typed after the link, its card is not offered again and nothing is fetched again.
    links.typed("https://example.org/a и ещё слова", active = true); idle(activity, 601)
    assertEquals(1, typing.asked.size)
    assertNull(links.take("https://example.org/a и ещё слова"))
    // The next message starts afresh.
    links.typed("https://example.org/a", active = true); idle(activity, 601)
    assertEquals(2, typing.asked.size)
  }

  @Test fun nothingIsFetchedForAnEditAForwardOrWithTheSettingOff() {
    val activity = launch("46-link-off", demo())
    LinkSettings.set(activity, true)
    val typing = Typing(activity); val links = typing.links
    // The field belongs to an edit or to the comment of a forward: no page is asked for.
    links.typed("https://example.org/a", active = false); idle(activity, 2000)
    assertEquals(emptyList<String>(), typing.asked)
    // A card made before the edit began goes, and is not sent with anything.
    links.typed("https://example.org/a", active = true); idle(activity, 601)
    typing.answers[0](card("https://example.org/a", "Страница"))
    links.typed("https://example.org/a", active = false)
    assertFalse(links.shown)
    assertNull(links.take("https://example.org/a"))
    links.reset()

    // «Предпросмотр ссылок» is off: nothing is asked for, a card made earlier is not sent, and the real fetcher
    // refuses as well (no request is made: the answer comes at once, empty).
    links.typed("https://example.org/b", active = true); idle(activity, 601)
    typing.answers.last()(card("https://example.org/b", "Страница"))
    assertTrue(links.shown)
    LinkSettings.set(activity, false)
    assertFalse(LinkSettings.on(activity))
    assertNull(links.take("https://example.org/b"))
    val before = typing.asked.size
    links.typed("https://example.org/c", active = true); idle(activity, 2000)
    assertEquals(before, typing.asked.size)
    var answers = 0; var answer: Map<String, Any?>? = card("", "")
    LinkFetcher.shared.card(activity, "https://example.org/c") { answers += 1; answer = it }
    idle(activity, 10)
    assertEquals(listOf(1, null), listOf(answers, answer))
    // In the chat itself: a link typed into the field with the setting off brings no card.
    val chat = find(activity.window.decorView, "ChatScreen")!!
    (find(chat, "ComposerField") as TextView).text = "смотри https://example.org/d"
    idle(activity, 3000)
    assertFalse(find(chat, "LinkComposerCard")!!.visibility == View.VISIBLE)
    LinkSettings.set(activity, true)
  }

  @Test fun theSwitchOfTheSettingsIsKeptOnThisPhone() {
    val activity = launch("47-link-setting", demo())
    activity.getSharedPreferences("invizent.links", 0).edit().clear().commit()
    // On unless the person switched it off.
    assertTrue(LinkSettings.on(activity))
    val row = LinkSettings.row(activity)
    assertEquals(listOf("Предпросмотр ссылок", "Когда ты пишешь ссылку, телефон сам загружает страницу и прикладывает её карточку к зашифрованному сообщению. Сервер ссылку не видит, а телефон собеседника на сайт не заходит. Если выключить, страницы не загружаются; карточки от собеседников показываются по-прежнему."), texts(row).filter { it.isNotEmpty() })
    val toggle = find(row, "Switch") as Switch
    assertTrue(toggle.isChecked)
    toggle.performClick()
    assertFalse(LinkSettings.on(activity))
    assertTrue(activity.getSharedPreferences("invizent.links", 0).getBoolean("linkPreviews.off", false))
    assertFalse((find(LinkSettings.row(activity), "Switch") as Switch).isChecked)
    (find(LinkSettings.row(activity), "Switch") as Switch).performClick()
    assertTrue(LinkSettings.on(activity))
  }

  @Test fun aLinkWhoseWordsHideItsAddressIsConfirmedFirst() {
    val activity = launch("48-link-open", demo())
    // The words show the address: opened at once.
    LinkOpen.pressed(activity, "https://example.org/page", "example.org/page")
    assertEquals("https://example.org/page", shadowOf(activity).nextStartedActivity.dataString)
    assertNull(ShadowAlertDialog.getLatestAlertDialog())
    // They do not: the whole address is shown and asked about first.
    LinkOpen.pressed(activity, "https://elsewhere.example/login", "мой банк")
    idle(activity, 100)
    assertNull(shadowOf(activity).nextStartedActivity)
    val asked = ShadowAlertDialog.getLatestAlertDialog()
    val shown = texts(asked.window!!.decorView)
    assertTrue(shown.toString(), shown.containsAll(listOf("Открыть ссылку?", "https://elsewhere.example/login")))
    assertEquals(listOf("Отмена", "Открыть"), listOf(asked.getButton(DialogInterface.BUTTON_NEGATIVE).text.toString(), asked.getButton(DialogInterface.BUTTON_POSITIVE).text.toString()))
    asked.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
    idle(activity, 100)
    assertNull(shadowOf(activity).nextStartedActivity)
    LinkOpen.pressed(activity, "https://elsewhere.example/login", "мой банк")
    idle(activity, 100)
    ShadowAlertDialog.getLatestAlertDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick()
    idle(activity, 100)
    val opened = shadowOf(activity).nextStartedActivity
    assertEquals(listOf(Intent.ACTION_VIEW, "https://elsewhere.example/login", true), listOf(opened.action, opened.dataString, opened.hasCategory(Intent.CATEGORY_BROWSABLE)))
    // Anything that is not an address of the web opens nothing and asks nothing.
    for (url in listOf("javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/a")) { LinkOpen.pressed(activity, url, url); LinkOpen.cardPressed(activity, url) }
    idle(activity, 100)
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test fun aDownloadedPictureBecomesASmallOne() {
    // A large picture with detail in it (and a transparent corner, which becomes white).
    val big = Bitmap.createBitmap(1600, 900, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(big); val paint = Paint()
    for (index in 1 until 400) { paint.color = Color.rgb(index * 37 % 256, index * 91 % 256, index * 53 % 256); canvas.drawRect((index % 20) * 80f, (index / 20) * 45f, (index % 20) * 80f + 80f, (index / 20) * 45f + 45f, paint) }
    val png = ByteArrayOutputStream().also { big.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    val small = LinkPicture.small(png, 480, 24 * 1024)!!
    assertTrue(small.size <= 24 * 1024 - 512)
    assertEquals(listOf(0xFF.toByte(), 0xD8.toByte()), small.take(2))
    val decoded = BitmapFactory.decodeByteArray(small, 0, small.size)
    assertTrue("${decoded.width}×${decoded.height}", maxOf(decoded.width, decoded.height) <= 480 && decoded.width >= 240 && decoded.width * 9 in decoded.height * 16 - 16..decoded.height * 16 + 16)
    val corner = decoded.getPixel(4, 4)
    assertTrue(Color.red(corner) > 215 && Color.green(corner) > 215 && Color.blue(corner) > 215)
    // The core takes it as a card's picture, cleans it and gives its true size; the card carries it.
    if (Core.loaded) {
      val cleaned = com.linea.messenger.linkpreview.LinkCore.image(small)!!
      assertEquals(listOf("image/jpeg", decoded.width.toDouble(), decoded.height.toDouble()), listOf(cleaned["mimeType"], cleaned["width"], cleaned["height"]))
      val card = com.linea.messenger.linkpreview.LinkCore.wire("https://example.org/a", "", "Заголовок", "", small)!!
      assertEquals(listOf("example.org", cleaned), listOf(card["site"], card["image"]))
      assertEquals(decoded.width.toDouble() / decoded.height, com.linea.messenger.linkpreview.MsgLinkCard.parse(card)!!.imageWide, 0.0001)
      assertNotNull(com.linea.messenger.linkpreview.MsgLinkCard.parse(card)!!.picture())
      assertTrue(com.linea.messenger.linkpreview.LinkCore.valid(card, "вот https://example.org/a"))
    }
    // A small picture is not made larger; a sliver and what is no picture give nothing.
    val little = ByteArrayOutputStream().also { Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
    assertEquals(listOf(200, 100), BitmapFactory.decodeByteArray(LinkPicture.small(little, 480, 24 * 1024), 0, LinkPicture.small(little, 480, 24 * 1024)!!.size).let { listOf(it.width, it.height) })
    val sliver = ByteArrayOutputStream().also { Bitmap.createBitmap(500, 30, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    assertNull(LinkPicture.small(sliver, 480, 24 * 1024))
    assertNull(LinkPicture.small("<svg xmlns='http://www.w3.org/2000/svg'/>".toByteArray(), 480, 24 * 1024))
    assertNull(LinkPicture.small(ByteArray(0), 480, 24 * 1024))
    // The sample picture of the emulator check fits a card as it is.
    assertTrue(LinkDemo.picture()!!.size in 1000..24 * 1024 - 512)
  }
}
