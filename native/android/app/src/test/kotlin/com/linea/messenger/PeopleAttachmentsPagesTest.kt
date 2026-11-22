package com.linea.messenger

import android.app.AlertDialog
import android.app.Dialog
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import android.view.View
import android.view.ViewGroup
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.DecryptedFileProvider
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.PhotoPrepare
import com.linea.messenger.attachments.PhotoViewer
import com.linea.messenger.attachments.Picks
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
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.TimeUnit

/** The pages of «Люди», of a profile and of attachments, built and drawn on the JVM as `PagesTest` does: every
 *  launch argument of the emulator check opens what it should, with the words of the iPhone app. Each page is
 *  saved as a picture in build/pages/. Not a phone: no system bars, no blur, and the core only when it happens
 *  to be loadable here. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-port-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PeopleAttachmentsPagesTest {
  private fun snap(name: String, page: View) {
    if (page.width <= 0 || page.height <= 0) return
    val picture = Bitmap.createBitmap(page.width, page.height, Bitmap.Config.ARGB_8888)
    page.draw(Canvas(picture))
    val folder = File("build/pages").apply { mkdirs() }
    File(folder, "$name.png").outputStream().use { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  private fun launch(name: String, intent: Intent, wait: Long = 600): MainActivity {
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

  private fun shown(view: View): Boolean = view.visibility == View.VISIBLE && ((view.parent as? View)?.let { shown(it) } ?: true)

  private fun texts(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view is TextView && view.visibility == View.VISIBLE) into.add(view.text.toString())
    if (view is ViewGroup && view.visibility == View.VISIBLE) for (index in 0 until view.childCount) texts(view.getChildAt(index), into)
    return into
  }

  /** What a screen reader would name: the views with a description. */
  private fun named(view: View, into: MutableList<String> = ArrayList()): List<String> {
    if (view.visibility != View.VISIBLE) return into
    view.contentDescription?.let { into.add(it.toString()) }
    if (view is ViewGroup) for (index in 0 until view.childCount) named(view.getChildAt(index), into)
    return into
  }

  private fun press(view: View, description: String): Boolean {
    if (view.visibility != View.VISIBLE) return false
    if (view.contentDescription?.toString() == description && view.isClickable) { view.performClick(); return true }
    if (view is ViewGroup) for (index in 0 until view.childCount) if (press(view.getChildAt(index), description)) return true
    return false
  }

  private fun demo() = Intent(Intent.ACTION_MAIN).putExtra("demo", true)

  @Test fun people() {
    val activity = launch("10-people", demo().putExtra("tab", "people"))
    val page = find(activity.window.decorView, "PeopleScreen")!!
    val words = texts(page)
    assertTrue(words.toString(), words.containsAll(listOf("Люди", "Друзья, заявки и поиск по @имени", "ЗАЯВКИ В ДРУЗЬЯ  1", "Вера Соколова", "@vera_s", "ОТПРАВЛЕННЫЕ  1", "Игорь Белов",
      "@belov · Ждёт ответа", "ДРУЗЬЯ  5", "Алиса Воронцова", "@alisa_v")))
    val names = named(page)
    assertTrue(names.toString(), names.containsAll(listOf("Принять: Вера Соколова", "Отклонить: Вера Соколова", "Отменить заявку: Игорь Белов", "Профиль Вера Соколова",
      "Профиль Алиса Воронцова", "Написать: Алиса Воронцова")))
    // Accepting a request makes a friend of the person; taking one back removes it.
    assertTrue(press(page, "Принять: Вера Соколова")); idle(activity)
    assertTrue(press(page, "Отменить заявку: Игорь Белов")); idle(activity)
    val after = texts(page)
    assertTrue(after.toString(), after.contains("ДРУЗЬЯ  6") && !after.contains("ЗАЯВКИ В ДРУЗЬЯ  1") && !after.contains("ОТПРАВЛЕННЫЕ  1"))
    snap("10-people-accepted", activity.window.decorView)
    // A touch on a friend opens the chat with them.
    val list = find(page, "ListView") as ListView
    val row = (0 until list.childCount).map { list.getChildAt(it) }.first { it.contentDescription == "Алиса Воронцова" }
    list.performItemClick(row, list.getPositionForView(row), 0)
    idle(activity)
    assertNotNull(find(activity.window.decorView, "ChatScreen"))
  }

  @Test fun theSearchOfPeople() {
    val activity = launch("11-people-search", demo().putExtra("peoplesearch", "мар"), wait = 900)
    val page = find(activity.window.decorView, "PeopleScreen")!!
    assertEquals(listOf("РЕЗУЛЬТАТЫ ПОИСКА", "Марина Ким", "@marina.kim"), texts(find(page, "ListView")!!))
    assertTrue(named(page).contains("Очистить поиск"))
    val none = launch("11-people-search-none", demo().putExtra("peoplesearch", "@zz"), wait = 900)
    assertTrue(texts(none.window.decorView).containsAll(listOf("Пока никого", "По началу @имени ищется с 4 символов. Введи ещё или напиши @имя целиком.")))
    val wrong = launch("11-people-search-wrong", demo().putExtra("peoplesearch", "никтошка"), wait = 900)
    assertTrue(texts(wrong.window.decorView).containsAll(listOf("Пока никого", "По этому запросу никого нет. Проверь написание @имени.")))
    // The cross empties the field: the friends are back.
    assertTrue(press(wrong.window.decorView, "Очистить поиск")); idle(wrong)
    assertTrue(texts(wrong.window.decorView).contains("ДРУЗЬЯ  5"))
  }

  @Test fun newChatOpensPeople() {
    val activity = launch("10-chats-new", demo())
    assertNull(find(activity.window.decorView, "PeopleScreen"))
    assertTrue(press(activity.window.decorView, "Новый чат")); idle(activity)
    assertNotNull(find(activity.window.decorView, "PeopleScreen"))
  }

  @Test fun theProfileOfAFriend() {
    val activity = launch("12-profile", demo().putExtra("profile", "friend"))
    val page = find(activity.window.decorView, "PersonProfileScreen")!!
    assertTrue(texts(page).toString(), texts(page).containsAll(listOf("Алиса Воронцова", "в сети", "имя пользователя", "@alisa_v", "день рождения", "2 мар", "о себе",
      "Рисую карты и собираю гербарий. Пишите в любое время.", "Переписка защищена сквозным шифрованием")))
    assertTrue(named(page).toString(), named(page).containsAll(listOf("Назад", "Ещё", "Написать", "В друзьях")))
    // Removing a friend asks first.
    assertTrue(press(page, "В друзьях")); idle(activity)
    val sheet = ShadowAlertDialog.getLatestAlertDialog()!!
    assertTrue(sheet.isShowing)
    assertEquals("Удалить из друзей", sheet.getButton(AlertDialog.BUTTON_POSITIVE).text.toString())
    assertEquals("Отмена", sheet.getButton(AlertDialog.BUTTON_NEGATIVE).text.toString())
    sheet.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); idle(activity)
    assertTrue(texts(page).contains("Удалён из друзей"))
    assertTrue(named(page).contains("В друзья"))
    // Asking again sends a request; once more takes it back.
    assertTrue(press(page, "В друзья")); idle(activity)
    assertTrue(texts(page).contains("Заявка отправлена") && named(page).contains("Заявка"))
    snap("12-profile-requested", activity.window.decorView)
    assertTrue(press(page, "Заявка")); idle(activity)
    assertTrue(texts(page).contains("Заявка отменена"))
    // A touch on the @username copies it.
    val username = (page as ViewGroup).let { findText(it, "@alisa_v")!!.parent as View }
    username.performClick(); idle(activity, 100)
    assertTrue(texts(page).contains("Скопировано"))
    idle(activity, 2000)
    assertTrue(texts(page).contains("@alisa_v"))
    // A complaint: the reason is chosen, then sent.
    assertTrue(press(page, "Ещё")); idle(activity)
    // «Написать» opens the chat; Back from the profile returns to «Люди».
    assertTrue(press(page, "Написать")); idle(activity)
    assertNotNull(find(activity.window.decorView, "ChatScreen"))
    @Suppress("DEPRECATION") activity.onBackPressed(); idle(activity)
    @Suppress("DEPRECATION") activity.onBackPressed(); idle(activity)
    assertNull(find(activity.window.decorView, "PersonProfileScreen"))
    assertNotNull(find(activity.window.decorView, "PeopleScreen"))
  }

  private fun findText(view: View, words: String): TextView? {
    if (view is TextView && view.text.toString() == words) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) findText(view.getChildAt(index), words)?.let { return it }
    return null
  }

  @Test fun theProfileOpenedFromAChat() {
    val activity = launch("13-profile-chat", demo().putExtra("profile", "chat"), wait = 2500)
    val page = find(activity.window.decorView, "PersonProfileScreen")!!
    snap("13-profile-chat", activity.window.decorView)
    assertNotNull(find(activity.window.decorView, "ChatScreen"))
    // The chat is one step back: there is no «Написать» here.
    assertFalse(named(page).contains("Написать"))
    // Calls: the row is «Звонок», «Видео», «Ещё» there (the friends action is inside «Ещё»), as on the iPhone.
    assertTrue(named(page).containsAll(listOf("Звонок", "Видео", "Ещё")))
    assertFalse(named(page).contains("В друзьях"))
    assertTrue(texts(page).contains("Алиса Воронцова"))
  }

  @Test fun theReportSheet() {
    val activity = launch("12-profile-report", demo().putExtra("profile", "friend"))
    var sent: String? = null
    val sheet = com.linea.messenger.people.ReportSheet(activity) { sent = it }
    sheet.show(); idle(activity)
    val page = sheet.window!!.decorView
    snap("12-report", page)
    assertTrue(texts(page).containsAll(listOf("Пожаловаться", "Переписка зашифрована: модератор увидит только причину и профиль, но не сообщения.", "Отправить жалобу")))
    assertTrue(named(page).containsAll(listOf("Спам", "Мошенничество", "Оскорбления и травля", "Насилие", "Откровенный контент", "Незаконное", "Другое")))
    // Nothing is sent until a reason is chosen.
    findText(page, "Отправить жалобу")!!.let { assertFalse(it.isEnabled) }
    assertTrue(press(page, "Мошенничество")); idle(activity)
    findText(page, "Отправить жалобу")!!.let { assertTrue(it.isEnabled); it.performClick() }
    idle(activity)
    assertEquals("scam", sent)
    assertFalse(sheet.isShowing)
  }

  @Test fun theSampleAttachments() {
    val activity = launch("14-attachments", demo().putExtra("chat", true).putExtra("attachdemo", "1"))
    val chat = find(activity.window.decorView, "ChatScreen")!!
    val rows = named(chat)
    // Attachments: a file card (the name, then «1.2 МБ · PDF»), a photo shown whole in its row (attachments/InlineMedia.kt).
    assertTrue(rows.toString(), rows.any { it.startsWith("Договор № 7.pdf") && it.contains("Договор и приложение к нему") })
    assertTrue(rows.toString(), rows.any { it.startsWith("Фото. 09:38") })
    assertTrue(rows.any { it.startsWith("🎬 Видео") })
    // Media: the paperclip opens its own panel — «Галерея», «Файл», «Опрос», «Аудио» (attachments/AttachmentPanel.kt).
    assertTrue(press(chat, "Вложения: галерея, файлы, опрос")); idle(activity)
    val sheet = ShadowDialog.getLatestDialog()
    assertTrue(sheet is com.linea.messenger.attachments.AttachmentPanel)
    assertTrue(named(sheet.window!!.decorView).containsAll(listOf("Галерея", "Файл", "Опрос", "Аудио")))
    sheet.dismiss()
    // Without the argument the sample chat has no such rows.
    val plain = launch("14-attachments-none", demo().putExtra("chat", true))
    assertFalse(named(plain.window.decorView).any { it.startsWith("🎬 Видео") })
  }

  @Test fun theSamplePhotoViewer() {
    val activity = launch("15-viewer-under", demo().putExtra("chat", true).putExtra("attachdemo", "viewer"), wait = 1800)
    val viewer = ShadowDialog.getLatestDialog()
    assertTrue(viewer is PhotoViewer && viewer.isShowing)
    val page = (viewer as Dialog).window!!.decorView
    idle(activity)
    snap("15-viewer", page)
    assertTrue(named(page).containsAll(listOf("Фото", "Закрыть просмотр")))
    assertTrue(press(page, "Закрыть просмотр")); idle(activity)
    assertFalse(viewer.isShowing)
  }

  @Test fun thePickers() {
    // The system's photo picker, at most ten pictures; the system's file chooser for anything.
    val photos = ChatAttachments.photoPicker()
    assertEquals("android.provider.action.PICK_IMAGES", photos.action)
    assertEquals(10, photos.getIntExtra("android.provider.extra.PICK_IMAGES_MAX", 0))
    val files = ChatAttachments.documentPicker("*/*")
    assertEquals(listOf(Intent.ACTION_OPEN_DOCUMENT, "*/*", true, true), listOf(files.action, files.type, files.hasCategory(Intent.CATEGORY_OPENABLE), files.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)))
    // What a picker hands back: several in the clip, or the one in the data.
    val one = Uri.parse("content://media/picker/0/1"); val two = Uri.parse("content://media/picker/0/2")
    assertEquals(listOf(one), Picks.chosen(Intent().setData(one)))
    assertEquals(listOf(one, two), Picks.chosen(Intent().apply { clipData = ClipData.newRawUri("", one).apply { addItem(ClipData.Item(two)) } }))
    assertEquals(emptyList<Uri>(), Picks.chosen(null))
    // The window carries a picker's answer to whoever asked, once.
    val activity = Robolectric.buildActivity(MainActivity::class.java, demo()).setup().get()
    var got: List<Uri>? = null
    assertTrue(Picks.ask(activity, files) { got = it })
    val asked = shadowOf(activity).nextStartedActivityForResult
    assertEquals(Intent.ACTION_OPEN_DOCUMENT, asked.intent.action)
    shadowOf(activity).receiveResult(asked.intent, android.app.Activity.RESULT_OK, Intent().setData(one))
    assertEquals(listOf(one), got)
    assertFalse(Picks.result(asked.requestCode, android.app.Activity.RESULT_OK, Intent().setData(two)))
    // A picker closed without a choice gives nothing.
    assertTrue(Picks.ask(activity, files) { got = it })
    val again = shadowOf(activity).nextStartedActivityForResult
    shadowOf(activity).receiveResult(again.intent, android.app.Activity.RESULT_CANCELED, null)
    assertEquals(emptyList<Uri>(), got)
  }

  private fun chunks(png: ByteArray): List<String> {
    val kinds = ArrayList<String>(); var offset = 8
    while (offset + 8 <= png.size) {
      val length = ((png[offset].toInt() and 255) shl 24) or ((png[offset + 1].toInt() and 255) shl 16) or ((png[offset + 2].toInt() and 255) shl 8) or (png[offset + 3].toInt() and 255)
      kinds.add(String(png, offset + 4, 4, Charsets.ISO_8859_1)); offset += length + 12
    }
    return kinds
  }

  @Test fun aPictureIsWrittenAnewWithNothingButThePicture() {
    // A picture with transparency, as the phone's own encoder writes it, and what the gate lets out of it.
    val drawn = Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888)
    Canvas(drawn).apply { drawColor(Color.TRANSPARENT); drawCircle(32f, 24f, 20f, android.graphics.Paint().apply { color = 0xFF3366CC.toInt() }) }
    val prepared = PhotoPrepare.finish(drawn, jpeg = false).getOrThrow()
    assertEquals(listOf("photo.png", "image/png", 64, 48), listOf(prepared.name, prepared.mimeType, prepared.width, prepared.height))
    val kinds = chunks(prepared.bytes)
    assertEquals("IHDR", kinds.first()); assertEquals("IEND", kinds.last())
    assertTrue(kinds.toString(), kinds.all { it in setOf("IHDR", "PLTE", "tRNS", "IDAT", "IEND") })
    // It is still the same picture.
    val back = android.graphics.BitmapFactory.decodeByteArray(prepared.bytes, 0, prepared.bytes.size)
    assertEquals(listOf(64, 48, 0xFF3366CC.toInt(), 0), listOf(back.width, back.height, back.getPixel(32, 24), back.getPixel(1, 1)))
    // Sending never fails on size: a picture whose file is over the limit is scaled down and written again.
    val noise = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
    val random = java.util.Random(7)
    noise.setPixels(IntArray(200 * 200) { 0xFF000000.toInt() or random.nextInt(0xFFFFFF) }, 0, 200, 0, 0, 200, 200)
    val smaller = PhotoPrepare.finish(noise, jpeg = false, limit = 40_000).getOrThrow()
    assertTrue(smaller.bytes.size <= 40_000 && smaller.width < 200 && smaller.width == smaller.height)
    // …and one that cannot be made small enough in four tries says so.
    val noise2 = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
    noise2.setPixels(IntArray(200 * 200) { 0xFF000000.toInt() or random.nextInt(0xFFFFFF) }, 0, 200, 0, 0, 200, 200)
    assertEquals("Фото больше 20 МиБ. Выбери уменьшение и повтори обработку.", PhotoPrepare.words(PhotoPrepare.finish(noise2, jpeg = false, limit = 10)))
  }

  @Test fun aDecryptedFileIsGivenOutToReadOnlyAndRemoved() {
    val context = RuntimeEnvironment.getApplication()
    val provider = Robolectric.setupContentProvider(DecryptedFileProvider::class.java, context.packageName + ".files")
    // (A Latin name: the JVM of this machine cannot spell others in a file name; a phone can.)
    val written = DecryptedFiles.write(context, "содержимое".toByteArray(), "Contract 7.pdf")!!
    assertTrue(written.file.isFile && written.folder.parentFile == context.cacheDir && DecryptedFiles.folderName.matches(written.folder.name))
    val address = DecryptedFiles.address(context, written)
    assertEquals("content", address.scheme); assertEquals(context.packageName + ".files", address.authority)
    assertEquals("содержимое", provider.openFile(address, "r").use { java.io.FileInputStream(it.fileDescriptor).readBytes().toString(Charsets.UTF_8) })
    provider.query(address, null, null, null, null)!!.use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("Contract 7.pdf", cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)))
      assertEquals(written.file.length(), cursor.getLong(cursor.getColumnIndexOrThrow(OpenableColumns.SIZE)))
    }
    // Reading only, and only the files of this folder.
    assertTrue(runCatching { provider.openFile(address, "rw") }.exceptionOrNull() is SecurityException)
    assertTrue(runCatching { provider.delete(address, null, null) }.isFailure)
    File(context.cacheDir, "secret.txt").writeText("x")
    File(context.filesDir, "keys.db").writeText("x")
    val base = "content://" + context.packageName + ".files/"
    for (wrong in listOf("secret.txt", written.folder.name, written.folder.name + "/..%2Fsecret.txt", written.folder.name + "/../secret.txt", "..%2Ffiles/keys.db",
      "invizent-view-x/a", written.folder.name + "/nothing.pdf", written.folder.name + "/a/b")) {
      assertTrue(wrong, runCatching { provider.openFile(Uri.parse(base + wrong), "r") }.exceptionOrNull() is FileNotFoundException)
      assertNull(wrong, provider.query(Uri.parse(base + wrong), null, null, null, null))
    }
    // A name that would leave the folder is not used.
    val odd = DecryptedFiles.write(context, ByteArray(3), "../../keys.db")!!
    assertEquals(listOf("file", odd.folder), listOf(odd.file.name, odd.file.parentFile))
    // Removed after the viewing; whatever an interrupted one left is swept.
    DecryptedFiles.remove(written.folder)
    assertFalse(written.folder.exists())
    assertTrue(runCatching { provider.openFile(address, "r") }.exceptionOrNull() is FileNotFoundException)
    DecryptedFiles.sweep(context)
    assertFalse(odd.folder.exists())
    assertTrue(File(context.cacheDir, "secret.txt").exists())
  }
}
