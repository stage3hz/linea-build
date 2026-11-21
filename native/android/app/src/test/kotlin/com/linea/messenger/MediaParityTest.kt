package com.linea.messenger

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.linea.messenger.attachments.AlbumLayout
import com.linea.messenger.attachments.AlbumRows
import com.linea.messenger.attachments.AttachmentPanel
import com.linea.messenger.attachments.GalleryAccess
import com.linea.messenger.attachments.MsgAlbum
import com.linea.messenger.attachments.PhotoEditModel
import com.linea.messenger.attachments.PhotoEditor
import com.linea.messenger.attachments.PhotoFailure
import com.linea.messenger.attachments.PhotoPixels
import com.linea.messenger.attachments.PhotoPoint
import com.linea.messenger.attachments.PhotoStroke
import com.linea.messenger.attachments.PixelImage
import com.linea.messenger.video.KeptMedia
import com.linea.messenger.video.PlayerModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.util.concurrent.TimeUnit

/** Media: the paperclip's panel, the photo editor, albums, the video player and keeping films — the rules as plain
 *  values, and the pages the emulator check opens, built on the JVM as `PagesTest` does (pictures in build/pages/). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MediaParityTest {
  // The rules

  @Test fun galleryAccess() {
    assertEquals(listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED), GalleryAccess.permissions(34))
    assertEquals(listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO), GalleryAccess.permissions(33))
    assertEquals(listOf(Manifest.permission.READ_EXTERNAL_STORAGE), GalleryAccess.permissions(30))
    // Android 14: only some photos allowed is «limited»; all of them «full»; nothing «denied».
    assertEquals("limited", GalleryAccess.state(34) { it == Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED })
    assertEquals("full", GalleryAccess.state(34) { true })
    assertEquals("denied", GalleryAccess.state(34) { false })
    assertEquals("denied", GalleryAccess.state(33) { it == Manifest.permission.READ_MEDIA_IMAGES })
    assertEquals("full", GalleryAccess.state(29) { it == Manifest.permission.READ_EXTERNAL_STORAGE })
    assertEquals(listOf("Видео", "0:07", "12:40", "1:02:03"), listOf(0.0, 7.4, 760.0, 3723.0).map { GalleryAccess.durationText(it) })
    assertEquals("В этом сообщении осталось мест для вложений: 3. Убери лишнее из выбора.", GalleryAccess.limitWords(3))
    assertEquals("В сообщении уже максимальное число вложений. Сначала отправь или убери часть файлов.", GalleryAccess.limitWords(0))
  }

  @Test fun editorHistoryAndTurns() {
    val history = PhotoEditModel.History()
    assertFalse(history.commit(PhotoEditModel.Edit()))
    for (index in 1..60) history.commit(PhotoEditModel.Edit(scale = if (index % 2 == 0) 2 else 4, resolution = index.toDouble()))
    assertEquals(51, history.states.size)
    assertTrue(history.undo())
    assertTrue(history.canRedo)
    history.commit(PhotoEditModel.Edit(format = "jpeg"))
    assertFalse(history.canRedo)
    // A quarter turn to the left: the frame turns with the picture; four turns bring it back.
    val framed = PhotoEditModel.Edit(crop = PhotoEditModel.Box(0.1, 0.2, 0.3, 0.4))
    val turned = PhotoEditModel.rotated(framed)
    assertEquals(270, turned.rotation)
    assertEquals(PhotoEditModel.Box(0.2, 0.6, 0.4, 0.3), turned.crop!!.let { PhotoEditModel.Box(round(it.x), round(it.y), round(it.width), round(it.height)) })
    var back = framed
    repeat(4) { back = PhotoEditModel.rotated(back) }
    assertEquals(0, back.rotation)
    val mirrored = PhotoEditModel.flipped(framed)
    assertEquals(0.6, round(mirrored.crop!!.x), 1e-9)
    assertEquals(90, PhotoEditModel.rotated(mirrored).rotation)
    // «Без фона» is PNG and leaves the document; JPEG is refused with it.
    val clear = PhotoEditModel.withBackground(PhotoEditModel.Edit(document = "bw", format = "jpeg"), "transparent")
    assertEquals(listOf("transparent", "none", "png"), listOf(clear.background, clear.document, clear.format))
    assertNull(PhotoEditModel.withFormat(clear, "jpeg"))
    assertEquals("keep", PhotoEditModel.withDocument(clear, "color").background)
    assertNull(PhotoEditModel.effectKey(PhotoEditModel.Edit(strokes = listOf(PhotoEditModel.Stroke(0, 0.1, emptyList())))))
    assertNotNull(PhotoEditModel.effectKey(PhotoEditModel.Edit(background = "white")))
    // At most 64 areas and 1024 points to remove.
    val mask = PhotoEditModel.Mask(0.02, List(1000) { PhotoEditModel.Point(0.5, 0.5) })
    assertTrue(PhotoEditModel.maskFits(PhotoEditModel.Edit(), mask))
    assertFalse(PhotoEditModel.maskFits(PhotoEditModel.Edit(masks = listOf(PhotoEditModel.Mask(0.02, List(30) { PhotoEditModel.Point(0.1, 0.1) }))), mask))
  }

  private fun round(value: Double) = Math.round(value * 1e9) / 1e9

  @Test fun editorPlanAndWords() {
    val plain = PhotoEditModel.plan(1200, 800, PhotoEditModel.Edit(format = "jpeg"))
    assertEquals(listOf(1200, 800, false), listOf(plain.width, plain.height, plain.downsampled))
    assertEquals("Результат: 1200 × 800 · JPEG. EXIF, GPS и личные метаданные удаляются.", PhotoEditModel.resultWords(plain, PhotoEditModel.Edit(format = "jpeg")))
    // ×4 of a big photo: at most 8 MP out, so the base is made smaller first.
    val big = PhotoEditModel.Edit(scale = 4)
    val laid = PhotoEditModel.plan(4000, 3000, big)
    assertTrue(laid.downsampled)
    assertTrue(laid.width.toLong() * laid.height <= 8_000_000L)
    assertTrue(PhotoEditModel.resultWords(laid, big).contains(" · фото будет уменьшено"))
    val half = PhotoEditModel.plan(1000, 1000, PhotoEditModel.Edit(resolution = 0.5, crop = PhotoEditModel.Box(0.0, 0.0, 0.5, 0.5)))
    assertEquals(listOf(250, 250, 500, 500), listOf(half.width, half.height, half.cropWidth, half.cropHeight))
    val square = PhotoEditModel.centered(1.0, 1200.0, 800.0)
    assertEquals(2.0 / 3.0, square.width, 1e-9)
    assertNull(PhotoEditModel.frame(PhotoEditModel.Point(0.5, 0.5), PhotoEditModel.Point(0.505, 0.6), null, 100.0, 100.0))
    val fixed = PhotoEditModel.frame(PhotoEditModel.Point(0.1, 0.1), PhotoEditModel.Point(0.9, 0.5), 1.0, 100.0, 100.0)!!
    assertEquals(fixed.width, fixed.height, 1e-9)
    try { PhotoEditModel.fit(30000, 10, 100); throw AssertionError("too large") } catch (failure: PhotoFailure) { assertEquals("IMAGE_TOO_LARGE", failure.reason) }
  }

  @Test fun pixels() {
    // The painted spot is filled from its neighbours: a red dot in grey becomes grey.
    val grey = 0xFF808080.toInt()
    val pixels = IntArray(40 * 40) { grey }.also { it[20 * 40 + 20] = 0xFFFF0000.toInt() }
    val filled = PhotoPixels.inpaint(PixelImage(40, 40, pixels), listOf(PhotoStroke(0.05, listOf(PhotoPoint(20 / 39.0, 20 / 39.0)))))
    assertEquals(grey, filled.pixels[20 * 40 + 20])
    try { PhotoPixels.inpaint(PixelImage(10, 10, IntArray(100) { grey }), listOf(PhotoStroke(0.5, listOf(PhotoPoint(0.5, 0.5))))); throw AssertionError("mask") }
    catch (failure: PhotoFailure) { assertEquals("MASK_TOO_LARGE", failure.reason) }
    val doubled = PhotoPixels.upscale(PixelImage(3, 2, IntArray(6) { grey }), 2)
    assertEquals(listOf(6, 4, grey), listOf(doubled.width, doubled.height, doubled.pixels[7]))
    val white = PhotoPixels.whiteBackground(PixelImage(1, 1, intArrayOf(0x00000000)))
    assertEquals(0xFFFFFFFF.toInt(), white.pixels[0])
    val scan = PhotoPixels.document(PixelImage(4, 4, IntArray(16) { 0xFFEEEEEE.toInt() }), true)
    assertTrue(scan.pixels.all { it == 0xFFFFFFFF.toInt() })
  }

  @Test fun albums() {
    val laid = AlbumLayout.layout(listOf(1.5, 0.67, 1.33), 300.0, 300 * 1.45)
    assertEquals(3, laid.tiles.size)
    assertTrue(laid.height <= 300 * 1.45 + 0.5)
    // Every row fills the width exactly.
    for (row in laid.tiles.groupBy { it.y }.values) assertEquals(300.0, row.maxOf { it.x + it.width }, 0.001)
    assertEquals(listOf(0, 1, 2), laid.tiles.map { it.index })
    // Up to ten photos in an album; more are split; a lone last photo is no album.
    val thirteen = AlbumRows.groups(13)
    assertEquals(listOf(10, 3), thirteen.map { it!!.count }.distinct())
    assertEquals(9, thirteen[9]!!.index)
    assertEquals(0, thirteen[10]!!.index)
    assertTrue(thirteen[0]!!.id != thirteen[10]!!.id)
    assertNull(AlbumRows.groups(11)[10])
    assertEquals(listOf<AlbumRows.Group?>(null), AlbumRows.groups(1))
    assertNull(MsgAlbum.parse(listOf(mapOf("key" to "a"))))
    assertEquals(2, MsgAlbum.parse(listOf(mapOf("key" to "a", "wide" to 1.5), mapOf("key" to "b", "video" to true)))!!.parts.size)
  }

  @Test fun albumsJoinOneRow() {
    val album = { index: Int -> mapOf("album" to mapOf("id" to "a1", "index" to index, "count" to 3)) }
    val attachment = mapOf("id" to "f1", "name" to "photo.jpg", "mimeType" to "image/jpeg", "size" to 10, "encryption" to mapOf("scheme" to "aes-256-gcm-siv"))
    val messages = (1..3).map { index ->
      mapOf("id" to index, "chatId" to "c", "senderId" to "peer", "clientId" to "client-$index", "text" to (if (index == 2) "Подпись" else ""), "attachment" to attachment,
        "createdAt" to "2026-11-21T09:5$index:00Z", "cryptoState" to "decrypted", "meta" to album(index - 1))
    }
    val row = mutableMapOf<String, Any?>("key" to "peer:client-1", "albumId" to "a1", "albumSender" to "peer")
    assertTrue(AlbumRows.joins(messages[1], "peer", row))
    assertFalse(AlbumRows.joins(messages[1], "me", row))
    row["album"] = listOf(1, 2, 3)
    assertFalse(AlbumRows.joins(messages[2], "peer", row))
  }

  @Test fun player() {
    assertEquals(listOf("0:07", "12:40", "75:03", "0:00"), listOf(7.9, 760.0, 4503.0, Double.NaN).map { PlayerModel.clock(it) })
    assertEquals(listOf("0.25×", "Обычная", "1.5×", "2×"), listOf(0.25f, 1f, 1.5f, 2f).map { PlayerModel.speedLabel(it) })
    assertEquals(0.0, PlayerModel.seekTarget(5.0, 60.0, -10.0), 0.0)
    assertEquals(60.0, PlayerModel.seekTarget(55.0, 60.0, 10.0), 0.0)
    // A double tap on the right seeks forward 10 s; a third tap in the burst makes it 20.
    val (first, none) = PlayerModel.tapStep(PlayerModel.TapState(), 300f, 1.0, 400f)
    assertEquals(0, none)
    val (second, forward) = PlayerModel.tapStep(first, 310f, 1.2, 400f)
    assertEquals(1, forward)
    assertEquals(10.0, second.acc, 0.0)
    val (third, again) = PlayerModel.tapStep(second, 320f, 1.6, 400f)
    assertEquals(listOf(1, 20.0), listOf(again, third.acc))
    assertEquals(0.5f, PlayerModel.scrubMove(0.4f, 50f, 100f, fine = true), 1e-6f)
    assertEquals(0.9f, PlayerModel.scrubMove(0.4f, 50f, 100f, fine = false), 1e-6f)
    assertEquals(0.18f * 300, PlayerModel.tooltipCenter(0.05f, 300f), 1e-4f)
    assertEquals(30.0, PlayerModel.thumbTime(30.2, 60.0), 1e-9)
    assertEquals(1f, PlayerModel.chevronOpacity(0.3, 0, true), 1e-6f)
  }

  @Test fun keptFilms() {
    val context = RuntimeEnvironment.getApplication()
    val attachment = mapOf("id" to "file-1", "encryption" to mapOf("fileKeyId" to "key-1"))
    val name = KeptMedia.folderName(attachment)!!
    assertEquals(64, name.length)
    assertEquals(name, KeptMedia.folderName(attachment))
    assertTrue(name != KeptMedia.folderName(mapOf("id" to "file-1")))
    assertNull(KeptMedia.folderName(emptyMap()))
    val source = File(context.cacheDir, "film.mp4").apply { writeBytes(ByteArray(64) { 7 }) }
    assertFalse(KeptMedia.isKept(context, attachment))
    assertTrue(KeptMedia.keep(context, source, attachment))
    assertEquals("film.mp4", KeptMedia.file(context, attachment)!!.name)
    // Leaving the account and «Очистить кэш» take every kept film.
    KeptMedia.wipe(context)
    assertFalse(KeptMedia.isKept(context, attachment))
  }

  // The pages

  private fun demo() = Intent(Intent.ACTION_MAIN).putExtra("demo", true).putExtra("chat", true)

  private fun launch(intent: Intent, wait: Long = 1800): MainActivity {
    val activity = Robolectric.buildActivity(MainActivity::class.java, intent).setup().get()
    shadowOf(activity.mainLooper).idleFor(wait, TimeUnit.MILLISECONDS)
    return activity
  }

  private fun snap(name: String, page: View) {
    if (page.width <= 0 || page.height <= 0) return
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    File(File("build/pages").apply { mkdirs() }, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view is TextView && view.visibility == View.VISIBLE) into.add(view.text.toString())
    if (view is ViewGroup && view.visibility == View.VISIBLE) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  private fun named(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    view.contentDescription?.let { into.add(it.toString()) }
    if (view is ViewGroup) for (index in 0 until view.childCount) named(view.getChildAt(index), into)
    return into
  }

  @Test fun thePanelWithChosenTiles() {
    val activity = launch(demo().putExtra("attachdemo", "panelselected"), wait = 2600)
    val panel = ShadowDialog.getLatestDialog()
    assertTrue(panel is AttachmentPanel)
    val page = panel.window!!.decorView
    shadowOf(activity.mainLooper).idleFor(400, TimeUnit.MILLISECONDS)
    snap("362-attach-panel-selected", page)
    val words = texts(page)
    assertTrue(words.toString(), words.containsAll(listOf("Выбрано: 3", "↑  Добавить · 3", "Несколько фото и видео отправятся одним альбомом.", "Галерея", "Файл", "Опрос", "Аудио")))
    assertTrue(named(page).containsAll(listOf("Снять фото или видео", "Закрыть выбор вложений")))
  }

  @Test fun thePanelWithLimitedAndNoAccess() {
    launch(demo().putExtra("attachdemo", "panellimited"), wait = 2600)
    val limited = ShadowDialog.getLatestDialog().window!!.decorView
    assertTrue(texts(limited).containsAll(listOf("Показаны только разрешённые фото и видео.", "Добавить доступ", "Недавние")))
    launch(demo().putExtra("attachdemo", "paneldenied"), wait = 2600)
    val denied = ShadowDialog.getLatestDialog().window!!.decorView
    assertTrue(texts(denied).containsAll(listOf("Открой доступ к галерее", "Можно разрешить только выбранные фото и видео. Остальные файлы останутся недоступны приложению.",
      "Открыть настройки", "Выбрать через системное окно")))
  }

  @Test fun theEditorTabs() {
    for ((tool, words) in listOf("crop" to listOf("Свободно", "1:1", "↺  Повернуть на 90°", "⇋  Отразить"), "draw" to listOf("Тонкая", "Средняя", "Широкая"),
      "size" to listOf("Полное", "50 %", "JPEG", "PNG", "Результат: 1200 × 800 · JPEG. EXIF, GPS и личные метаданные удаляются."),
      "remove" to listOf("Закрась объект — область заполнится соседними цветами. Маска — до 20% кадра."), "enhance" to listOf("Фото", "Ч/б документ", "Цветной документ", "×1", "×2", "×4"))) {
      val activity = launch(demo().putExtra("photoeditor", tool), wait = 2600)
      val editor = ShadowDialog.getLatestDialog()
      assertTrue(editor is PhotoEditor)
      shadowOf(activity.mainLooper).idleFor(600, TimeUnit.MILLISECONDS)
      val page = editor.window!!.decorView
      snap("photo-editor-$tool", page)
      val shown = texts(page)
      assertTrue("$tool: $shown", shown.containsAll(words + "Сбросить"))
      assertTrue(named(page).containsAll(listOf("Обрезка", "Рисование", "Убрать объект", "Фон", "Улучшить", "Размер и формат", "Отправить фото", "Отменить действие")))
      editor.dismiss()
    }
  }

  @Test fun theForwardPickerHasFolderTabs() {
    val activity = launch(demo(), wait = 1200)
    val store = com.linea.messenger.chatsplus.ChatFolderStore.of(activity, "sample")
    val people = com.linea.messenger.chatactions.ChatActionsDemo.forwardTargets()
    store.upsert(com.linea.messenger.chatsplus.ChatFolder("work", "Работа", listOf(people.first().chatId)))
    try {
      val picker = com.linea.messenger.chatactions.ForwardPicker(activity, null, 1)
      picker.show()
      shadowOf(activity.mainLooper).idleFor(300, TimeUnit.MILLISECONDS)
      val page = picker.window!!.decorView
      assertTrue(texts(page).containsAll(listOf("Все чаты", "Работа")))
      val all = picker.names.size
      picker.chooseTab("work")
      assertEquals(listOf(people.first().name), picker.names)
      picker.chooseTab("all")
      assertEquals(all, picker.names.size)
      picker.dismiss()
    } finally { store.remove("work") }
  }
}
