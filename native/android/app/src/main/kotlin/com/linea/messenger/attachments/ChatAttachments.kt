package com.linea.messenger.attachments

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.composer.ComposerPills
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PeopleIcons
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Executors

/** What the system's pickers hand back to the window (`MainActivity.onActivityResult`), carried to whoever asked.
 *  Main thread only. */
object Picks {
  private const val FIRST = 0x4956
  private var next = FIRST
  private val waiting = HashMap<Int, (List<Uri>) -> Unit>()

  /** Opens a picker; `done` gets what was chosen (nothing when the person chose nothing). False: no picker. */
  fun ask(activity: Activity, intent: Intent, done: (List<Uri>) -> Unit): Boolean {
    val code = next
    next = if (next >= FIRST + 4000) FIRST else next + 1
    waiting[code] = done
    return try { @Suppress("DEPRECATION") activity.startActivityForResult(intent, code); true } catch (_: ActivityNotFoundException) { waiting.remove(code); false }
  }

  /** The window's word about a picker that closed. True when it was one of these. */
  fun result(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
    val done = waiting.remove(requestCode) ?: return false
    done(if (resultCode == Activity.RESULT_OK) chosen(data) else emptyList())
    return true
  }

  /** The addresses in a picker's answer: several in the clip, or the one in the data. */
  fun chosen(data: Intent?): List<Uri> {
    val clip = data?.clipData
    if (clip != null && clip.itemCount > 0) return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    return listOfNotNull(data?.data)
  }
}

/** Attachments of one chat: the paperclip in the composer, choosing a photo or a file, getting it ready, sealing
 *  and uploading it, sending the message — and opening the attachments of the messages on screen.
 *
 *  A photo comes from the system's photo picker, which runs outside the app and hands over only what was chosen,
 *  so no permission to the gallery is asked. Every picture is drawn anew before it leaves (`PhotoPrepare`):
 *  what is sent has no EXIF, no place, no camera data and not the original name. A file is sent as it is.
 *  The key of a file exists only in memory and inside the encrypted message. */
class ChatAttachments(private val host: View, private val messenger: Messenger?, private val chatId: String, private val peerId: String) {
  /** What is sealed and sent: the cleaned photo or the file itself, and how the message describes it. */
  class Prepared(val bytes: ByteArray, val name: String, val mimeType: String, val media: Map<String, Any?>?, val preview: Map<String, Any?>?)

  /** An attachment on its way out, shown as a row of the chat until the server has the message. */
  private class Pending(var heading: String) {
    val key = "attach-" + UUID.randomUUID().toString().lowercase()
    val time = Messenger.clock(Instant.now(), ZoneId.systemDefault())
    var note = ""
    var thumb = ""
    var wide = 1.0
    var failed: String? = null
    var prepared: Prepared? = null
    var transfer: FileTransfer? = null
    var removed = false
    var percent = -1
    /** What goes with the message inside the ciphertext: the answer it is, or null. */
    var meta: Map<String, Any?>? = null
    /** Media: the upload has begun (the photos of an album start in their order). */
    var started = false
  }

  private val context: Context = host.context
  private val main = Handler(Looper.getMainLooper())
  private val d = context.resources.displayMetrics.density
  private val button = object : View(context) {
    init { isClickable = true; isFocusable = true; contentDescription = "Вложения: галерея, файлы, опрос" }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }
    override fun onDraw(canvas: android.graphics.Canvas) =
      PeopleIcons.draw(canvas, "paperclip", width / 2f, height / 2f, 24f * d, if (isPressed) Theme.alpha(Theme.text, 0.5f) else Theme.text)
  }
  private var pending: List<Pending> = emptyList()
  /** One picture or file at a time is read and made ready; one at a time is sealed and uploaded. */
  private val preparing = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.attachments.prepare").apply { isDaemon = true } }
  private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.attachments").apply { isDaemon = true } }
  /** Called on the main thread when the rows of outgoing attachments changed. */
  var onPendingChanged: (() -> Unit)? = null
  /** Voice/Video (voice/ChatMedia.kt): a touched row is offered there first — a voice message, a video, a round
   *  video, a big (chunked) file of any kind or one of its own unsent rows; true: it took it. */
  var mediaPressed: ((String) -> Boolean)? = null
  /** Voice/Video: «Видео» of the paperclip's list. */
  var onVideo: (() -> Unit)? = null
  /** Polls: «Опрос» of the paperclip (polls/PollComposer.kt); set by the chat's actions. */
  var onPoll: (() -> Unit)? = null
  /** Voice/Video: a video chosen in «Файл» goes the way of «Видео» (written anew without its metadata), with the
   *  answer it is. True: it was taken. */
  var onVideoFile: ((Uri, Map<String, Any?>?) -> Boolean)? = null
  /** ChatActions: the answer being written, taken by the first thing sent (see `ChatScreenActions.takeReply`). */
  var takeReply: (() -> Map<String, Any?>?)? = null

  /** ChatActions: a forward into this chat came, went, started or failed. */
  private val forwardsChanged: (String) -> Unit = { id -> if (id == chatId) onPendingChanged?.invoke() }

  init {
    val app = context.applicationContext
    sweeping.execute { DecryptedFiles.sweep(app); CaptureProvider.sweep(app) /* Media: camera shots of earlier runs */ }
    InlineMedia.use(messenger?.server) // Attachments: photos and files brought inside their rows
    // ChatActions: forwards on their way into this chat stand among these rows (chatactions/ForwardQueue.kt), followed
    // while the chat is in the window.
    host.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) {
        com.linea.messenger.chatactions.ForwardQueue.changed.watch(forwardsChanged)
        onPendingChanged?.invoke() // what went or failed meanwhile
      }
      override fun onViewDetachedFromWindow(view: View) { com.linea.messenger.chatactions.ForwardQueue.changed.unwatch(forwardsChanged) }
    })
    if (host.isAttachedToWindow) com.linea.messenger.chatactions.ForwardQueue.changed.watch(forwardsChanged)
    if (messenger == null) com.linea.messenger.chatactions.ForwardPendingDemo.seed(chatId) // `chatdemo forwardpending`
  }

  // The composer

  /** Puts the paperclip at the composer's leading edge, on its own round glass (composer/ComposerPills.kt), and
   *  the text field 14 dp inside the field's pill beside it.
   *  At the composer's lower edge: the field grows upwards with its text (ChatActions). */
  fun install(composer: FrameLayout, field: View) {
    button.setOnClickListener { choose() }
    val side = Math.round(ComposerPills.SIDE * d)
    composer.addView(button, FrameLayout.LayoutParams(side, side, Gravity.START or Gravity.BOTTOM))
    (field.layoutParams as? FrameLayout.LayoutParams)?.let { it.leftMargin = Math.round((ComposerPills.SIDE + ComposerPills.GAP + 14f) * d); field.layoutParams = it }
  }

  private fun activity(): Activity? {
    var owner: Context? = context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    return owner as? Activity
  }

  private fun hideKeyboard() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(host.windowToken, 0)
  }

  private fun choose() {
    hideKeyboard()
    // Media: the reference's own panel — «Недавние» from the gallery, the camera, «Файл», «Опрос», «Аудио»
    // (attachments/AttachmentPanel.kt). The gallery is read only once the panel is open.
    if (openPanel() != null) return
    // Voice/Video: «Видео» stands between the two when there is somebody to take it.
    val video = onVideo
    val base = if (video != null) listOf("Галерея", "Видео", "Файл") else listOf("Галерея", "Файл")
    val poll = onPoll
    val items = (if (poll != null) base + "Опрос" else base).toTypedArray() // Polls
    AlertDialog.Builder(context)
      .setItems(items) { _, which -> when (items[which]) { "Галерея" -> pickPhotos(); "Видео" -> video?.invoke(); "Опрос" -> poll?.invoke(); else -> pickFiles() } }
      .setNegativeButton("Отмена", null)
      .show()
  }

  private fun pickPhotos() {
    val activity = activity() ?: return
    // The system's photo picker returns only the chosen pictures, readable for this one time: no permission.
    // Where the phone has none, the system's own file chooser shows pictures the same way.
    val asked = Picks.ask(activity, photoPicker()) { chosen -> photosPicked(chosen.take(MAX_PHOTOS)) }
      || Picks.ask(activity, documentPicker("image/*")) { chosen -> photosPicked(chosen.take(MAX_PHOTOS)) }
    if (!asked) say(context, "Не удалось открыть галерею.")
  }

  private fun pickFiles() {
    val activity = activity() ?: return
    if (!Picks.ask(activity, documentPicker("*/*")) { chosen -> filesPicked(chosen) }) say(context, "Не удалось открыть файлы.")
  }

  /** Media: opens the paperclip's panel; false when there is no window for it. */
  fun openPanel(): AttachmentPanel? {
    val activity = activity() ?: return null
    val panel = AttachmentPanel(activity, onPoll != null)
    panel.onPoll = { onPoll?.invoke() }
    panel.onSend = { items -> take(items) }
    panel.show()
    return panel
  }

  /** Media: what the panel added — the photos as one album (up to ten per album) in their order, each video the way
   *  of «Видео» (written anew without its metadata), each file as it is. */
  private fun take(items: List<AttachmentPanel.Picked>) {
    if (messenger == null) { for (item in items) (item as? AttachmentPanel.Picked.Photo)?.temporary?.delete(); return }
    val photos = ArrayList<AttachmentPanel.Picked.Photo>()
    val files = ArrayList<Uri>()
    for (item in items) {
      when (item) {
        is AttachmentPanel.Picked.Photo -> photos.add(item)
        is AttachmentPanel.Picked.Video -> {
          val meta = takeReply?.invoke()
          if (onVideoFile?.invoke(item.uri, meta) != true) fail(add(Pending("🎬 Видео")), "Видео пока нельзя отправить в этой версии приложения.")
        }
        is AttachmentPanel.Picked.File -> files.add(item.uri)
      }
    }
    if (files.isNotEmpty()) filesPicked(files)
    val albums = AlbumRows.groups(photos.size)
    val resolver = context.contentResolver
    photos.forEachIndexed { index, photo ->
      val item = add(Pending("🖼 Фотография"))
      item.meta = withAlbum(takeReply?.invoke(), albums.getOrNull(index))
      preparing.execute {
        val prepared = if (photo.edited != null) edited(photo.edited, photo.format)
          else photo.uri?.let { photo(resolver, it) } ?: Result.failure(PhotoPrepare.Failure("Не удалось обработать фото. Файл не отправлен."))
        photo.temporary?.delete()
        main.post { ready(item, prepared) }
      }
    }
  }

  /** Media: the album mark joined to what goes with a photo's message. */
  private fun withAlbum(meta: Map<String, Any?>?, group: AlbumRows.Group?): Map<String, Any?>? {
    if (group == null) return meta
    return (meta ?: emptyMap()) + ("album" to AlbumRows.meta(group))
  }

  /** Media: the editor's bitmap written in its chosen format (JPEG over white: it has no transparency). */
  private fun edited(bitmap: android.graphics.Bitmap, format: String?): Result<Prepared> {
    val jpeg = format == "jpeg"
    var fresh = bitmap
    if (jpeg && bitmap.hasAlpha()) {
      fresh = android.graphics.Bitmap.createBitmap(bitmap.width, bitmap.height, android.graphics.Bitmap.Config.ARGB_8888)
      android.graphics.Canvas(fresh).apply { drawColor(android.graphics.Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
    }
    return PhotoPrepare.finish(fresh, jpeg).map { photo ->
      Prepared(photo.bytes, photo.name, photo.mimeType, mapOf("width" to photo.width, "height" to photo.height, "hdr" to "sdr"), photo.preview)
    }
  }

  // What was chosen

  private fun photosPicked(chosen: List<Uri>) {
    if (messenger == null) return
    val resolver = context.contentResolver
    // Media: two or more photos go out as one album — up to ten per album (attachments/AlbumGrid.kt).
    val albums = AlbumRows.groups(chosen.size)
    for ((index, uri) in chosen.withIndex()) {
      val item = add(Pending("🖼 Фотография"))
      item.meta = withAlbum(takeReply?.invoke(), albums.getOrNull(index))
      // What the picker gave is read and drawn anew right here, one picture at a time.
      preparing.execute {
        val prepared = photo(resolver, uri)
        main.post { ready(item, prepared) }
      }
    }
  }

  private fun filesPicked(chosen: List<Uri>) {
    if (messenger == null) return
    val resolver = context.contentResolver
    for (uri in chosen) {
      val item = add(Pending("📎 Файл"))
      item.meta = takeReply?.invoke()
      preparing.execute {
        val about = about(resolver, uri)
        main.post { if (!item.removed) { item.heading = "📎 " + about.name; onPendingChanged?.invoke() } }
        if (onVideoFile != null && looksLikeVideo(resolver, uri, about)) {
          main.post {
            if (item.removed) return@post
            // A video goes the way of «Видео»: its own row there replaces this one.
            if (onVideoFile?.invoke(uri, item.meta) == true) remove(item)
            else fail(item, "Видео пока нельзя отправить в этой версии приложения.")
          }
          return@execute
        }
        val prepared = file(resolver, uri, about)
        main.post { ready(item, prepared) }
      }
    }
  }

  /** What a chosen file says of itself. */
  class About(val name: String, val size: Long, val mimeType: String?)

  private fun about(resolver: ContentResolver, uri: Uri): About {
    var name = ""; var size = -1L
    try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameAt = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); val sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameAt >= 0 && !cursor.isNull(nameAt)) name = cursor.getString(nameAt) ?: ""
          if (sizeAt >= 0 && !cursor.isNull(sizeAt)) size = cursor.getLong(sizeAt)
        }
      }
    } catch (_: Exception) {}
    // Media: a track of «Моя музыка» is a file of the app's own: its name and size are its own.
    if (uri.scheme == "file") uri.path?.let { java.io.File(it) }?.let { file -> name = file.name; size = file.length() }
    // Only the last part of a name: never a path.
    name = name.substringAfterLast('/').trim()
    val type = try { resolver.getType(uri) } catch (_: Exception) { null }
    return About(name.ifEmpty { "file" }, size, type)
  }

  private fun photo(resolver: ContentResolver, uri: Uri): Result<Prepared> {
    val size = about(resolver, uri).size
    return PhotoPrepare.prepare(resolver, uri, size).map { photo ->
      Prepared(photo.bytes, photo.name, photo.mimeType, mapOf("width" to photo.width, "height" to photo.height, "hdr" to "sdr"), photo.preview)
    }
  }

  /** Whether a chosen file is a video, by its kind or by how it begins (a picture is never one). */
  private fun looksLikeVideo(resolver: ContentResolver, uri: Uri, about: About): Boolean {
    if (PhotoPrepare.isPicture(resolver, uri)) return false
    val type = about.mimeType ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(about.name.substringAfterLast('.', "").lowercase())
    val head = try { resolver.openInputStream(uri)?.use { input -> ByteArray(16).let { it.copyOf(maxOf(0, input.read(it))) } } } catch (_: Exception) { null } ?: return false
    return FileRules.isVideo(type, head)
  }

  /** A file chosen in the system's files: a picture is prepared as a photo whatever its name says, a video goes the
   *  way of «Видео» (see `onVideoFile`; with nobody to take it, it is not sent — it cannot be cleaned of its
   *  metadata here), anything else goes as it is. */
  private fun file(resolver: ContentResolver, uri: Uri, about: About): Result<Prepared> {
    val unread = Result.failure<Prepared>(PhotoPrepare.Failure("Не удалось прочитать файл."))
    if (about.size == 0L) return unread
    if (PhotoPrepare.isPicture(resolver, uri)) return photo(resolver, uri)
    val type = about.mimeType ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(about.name.substringAfterLast('.', "").lowercase())
    val head = try { resolver.openInputStream(uri)?.use { input -> ByteArray(16).let { it.copyOf(maxOf(0, input.read(it))) } } } catch (_: Exception) { null } ?: return unread
    if (FileRules.isVideo(type, head)) return Result.failure(PhotoPrepare.Failure("Видео пока нельзя отправить в этой версии приложения."))
    if (about.size > MAX_FILE) return Result.failure(PhotoPrepare.Failure("Файл слишком большой. Максимум — 20 МБ."))
    // Read with the limit in hand: a file that says nothing of its size, or lies about it, is not read past it.
    val bytes = try {
      resolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream(); val chunk = ByteArray(64 * 1024)
        while (true) {
          val got = input.read(chunk)
          if (got < 0) break
          if (out.size() + got > MAX_FILE) return Result.failure(PhotoPrepare.Failure("Файл слишком большой. Максимум — 20 МБ."))
          out.write(chunk, 0, got)
        }
        out.toByteArray()
      }
    } catch (_: Exception) { null }
    if (bytes == null || bytes.isEmpty()) return unread
    return Result.success(Prepared(bytes, about.name, type ?: "application/octet-stream", null, null))
  }

  // On the way out

  private fun add(item: Pending): Pending {
    pending = pending + item
    onPendingChanged?.invoke()
    return item
  }

  private fun fail(item: Pending, words: String) {
    item.failed = words
    item.transfer = null
    onPendingChanged?.invoke()
    sendAlbumInOrder() // Media: the next photo of an album need not wait for this one
  }

  /** Media: starts the photos of albums whose turn it is — each once the ones before it are ready (or failed), so
   *  the album keeps its order on both sides. */
  private fun sendAlbumInOrder() {
    for (item in pending) {
      if (item.meta?.get("album") == null || item.started) continue
      if (item.failed != null) continue
      if (item.prepared == null) return
      item.started = true
      send(item)
    }
  }

  private fun remove(item: Pending) {
    item.removed = true
    item.transfer?.cancel()
    pending = pending.filter { it !== item }
    onPendingChanged?.invoke()
  }

  /** The picture or file is ready (main thread): it is shown, then sealed and sent. */
  private fun ready(item: Pending, prepared: Result<Prepared>) {
    if (item.removed) return
    val made = prepared.getOrNull() ?: return fail(item, PhotoPrepare.words(prepared))
    item.prepared = made
    val picture = made.preview?.get("base64") as? String
    val width = (made.preview?.get("width") as? Number)?.toDouble(); val height = (made.preview?.get("height") as? Number)?.toDouble()
    if (picture != null && width != null && height != null && height > 0) {
      item.thumb = picture
      item.wide = width / height
    }
    item.note = FileCore.sizeText(made.bytes.size.toLong())
    if (item.meta?.get("album") != null) sendAlbumInOrder() else { item.started = true; send(item) }
  }

  /** Seals the prepared bytes under a key of their own, uploads them and sends the message (from the main thread). */
  private fun send(item: Pending) {
    val messenger = messenger ?: return
    val prepared = item.prepared ?: return
    if (item.removed) return
    item.failed = null
    val transfer = FileTransfer()
    item.transfer = transfer
    onPendingChanged?.invoke()
    val size = prepared.bytes.size.toLong()
    val whole = FileCore.sizeText(size)
    item.percent = -1
    transfer.onProgress = { sent, total ->
      val percent = if (total > 0) (sent * 100 / total).toInt() else 0
      main.post {
        if (item.removed || item.failed != null || item.transfer !== transfer || percent == item.percent) return@post
        item.percent = percent
        item.note = FileCore.sizeText(size * percent / 100) + " из " + whole
        onPendingChanged?.invoke()
      }
    }
    work.execute {
      fun failed(words: String) { main.post { if (!item.removed && item.transfer === transfer) fail(item, words) } }
      // A new key, nonce and key id for every attempt: the same key never seals two uploads.
      val encryption = Core.map(FileCore.call("newEncryption")) ?: return@execute failed("Шифрование ещё не готово. Попробуй ещё раз.")
      val sealed = FileCore.seal(prepared.bytes, encryption)
      val cipher = sealed.getOrNull() ?: return@execute failed(FileCore.words(sealed))
      val uploaded = messenger.server.uploadSealedFile(cipher, transfer)
      val id = uploaded.getOrNull()
      if (id == null) {
        if (uploaded.exceptionOrNull() !is FileTransfer.Failure.Cancelled) failed(FileTransfer.words(uploaded.exceptionOrNull(), proof = "Не удалось подтвердить устройство. Попробуй ещё раз."))
        return@execute
      }
      val attachment = Core.map(FileCore.call("attachment", listOf(id, prepared.name, prepared.mimeType, prepared.bytes.size, encryption, prepared.media, prepared.preview)))
        ?: return@execute failed("Не удалось отправить файл.")
      main.post {
        if (item.removed) return@post
        messenger.send(chatId, peerId, "", attachment, item.meta) { result ->
          // Without an answer the message stays among the unsent ones and goes out by itself later, with this
          // very attachment: the row has done its part either way.
          val failure = CryptoService.failure(result)
          if (failure != null && failure.name != "NetworkError") return@send fail(item, failure.words)
          remove(item)
          messenger.noteChanged(chatId)
        }
      }
    }
  }

  /** The rows of what is on its way out, to stand after the chat's own. */
  val pendingRows: List<Map<String, Any?>>
    get() = pending.map { item -> pendingRow(item.key, item.time, item.heading, item.note, item.thumb, item.wide, item.failed, uploading = item.transfer != null) } +
      com.linea.messenger.chatactions.ForwardQueue.rows(chatId) // ChatActions: then the forwards on their way into this chat

  // A touch on a row

  /** A row of the chat was touched: an unsent attachment offers to try again, a received one is opened.
   *  Attachments: `inRow` false — opened from elsewhere (an album's tile, the profile's media): straight to the
   *  viewer, not brought inside a row. */
  fun pressed(key: String, inRow: Boolean = true) {
    // ChatActions: a forward on its way — ✕ stops it, a failed one offers «Повторить» (chatactions/ForwardQueue.kt).
    if (com.linea.messenger.chatactions.ForwardQueue.pressed(key, context)) return
    // Voice/Video: voice messages, videos, round videos and big files are played and opened there.
    if (mediaPressed?.invoke(key) == true) return
    val item = pending.firstOrNull { it.key == key }
    if (item != null) {
      val failed = item.failed ?: return
      val sheet = AlertDialog.Builder(context).setMessage(failed)
      if (item.prepared != null) sheet.setPositiveButton("Повторить отправку") { _, _ -> send(item) }
      sheet.setNeutralButton("Удалить") { _, _ -> remove(item) }
      sheet.setNegativeButton("Отмена", null)
      sheet.show()
      return
    }
    val attachment = AttachmentStore.attachment(key) ?: return
    // Attachments: a photo is brought inside its row and a file inside its card first (MediaBubble.tsx); a touch
    // while it comes stops it; once here, the photo opens on the whole screen and the file in the chosen app.
    if (inRow && InlineMedia.inRow(key)) {
      val opened = InlineMedia.pressed(key, attachment, host, openPhoto = { open(attachment, key) }, openFile = { data ->
        hideKeyboard()
        FileOpen.hand(host, data, FileCore.describe(attachment).fileName, attachment["name"] as? String ?: "Файл")
      })
      if (opened) return
    }
    open(attachment, key)
  }

  private fun open(attachment: Map<String, Any?>, key: String = "") {
    val about = FileCore.describe(attachment)
    about.refusal?.let { return say(context, it) }
    val messenger = messenger ?: return
    val cipherSize = about.cipherSize ?: return
    val load = AttachmentLoad(messenger.server, attachment, cipherSize)
    hideKeyboard()
    if (about.kind == "photo") {
      val small = InlineMedia.picture(key) ?: (Core.map(attachment["preview"] as? Map<*, *>)?.get("base64") as? String)?.let { text ->
        try { Base64.decode(text, Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) } } catch (_: Throwable) { null }
      }
      PhotoViewer(context, small, load).show()
    } else {
      FileOpen(host, attachment["name"] as? String ?: "Файл", about.fileName, load).show()
    }
  }

  // The emulator check

  /** The chat's rows were read: gives the rows of outgoing attachments to add to them. */
  fun loaded(rows: List<Map<String, Any?>>): List<Map<String, Any?>> {
    AttachmentsDemo.opened(rows, host) { key -> pressed(key, inRow = false) }
    AttachmentsDemo.media(this, host) // Media: the editor, the player, the round video, the panel
    return pendingRows
  }

  companion object {
    const val MAX_FILE = 20L * 1024 * 1024
    private const val MAX_PHOTOS = 10
    private val sweeping = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.attachments.sweep").apply { isDaemon = true } }

    /** A few words with «Понятно» under them. */
    fun say(context: Context, words: String) {
      try { AlertDialog.Builder(context).setMessage(words).setPositiveButton("Понятно", null).show() } catch (_: Exception) { /* the window is gone */ }
    }

    /** The system's photo picker (Android 13, and earlier phones the system update brought it to). */
    fun photoPicker(): Intent {
      val has = Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= 30 && Extensions.photoPicker())
      if (!has) return documentPicker("image/*")
      return Extensions.pickImages(MAX_PHOTOS)
    }

    /** The system's file chooser: it hands over what was chosen, to read, for this one time. */
    fun documentPicker(type: String): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      setType(type)
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }

    /** One row of an attachment on its way out (`MsgRow`'s fields). */
    fun pendingRow(key: String, time: String, heading: String, note: String, thumb: String, wide: Double, failed: String?, uploading: Boolean): Map<String, Any?> {
      val label = if (failed != null) "Не отправлено · повторить\n$failed"
        else if (thumb.isEmpty()) (if (note.isEmpty()) heading else heading + "\n" + note)
        else if (uploading) note else ""
      val row = linkedMapOf<String, Any?>("key" to key, "kind" to 0, "mine" to true, "text" to "", "time" to time, "ticks" to (if (failed == null) 3 else 4), "tail" to true, "label" to label)
      if (thumb.isNotEmpty()) { row["thumb"] = thumb; row["thumbWide"] = wide }
      return row
    }
  }

  @android.annotation.TargetApi(30)
  private object Extensions {
    fun photoPicker(): Boolean = try { SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2 } catch (_: Throwable) { false }

    @android.annotation.SuppressLint("InlinedApi")
    fun pickImages(most: Int): Intent = Intent(MediaStore.ACTION_PICK_IMAGES).apply {
      type = "image/*"
      putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, most)
    }
  }
}

/** Rules about a chosen file: plain functions, so they can be checked without a phone. */
object FileRules {
  private fun starts(head: ByteArray, at: Int, text: String): Boolean =
    head.size >= at + text.length && text.indices.all { head[at + it] == text[it].code.toByte() }

  /** A video by its kind or by its first bytes (an ISO container that is not sound, Matroska/WebM, AVI). */
  fun isVideo(mimeType: String?, head: ByteArray): Boolean {
    val audio = mimeType?.startsWith("audio/") ?: false
    val named = mimeType?.startsWith("video/") ?: false
    val iso = head.size >= 12 && starts(head, 4, "ftyp")
    val matroska = head.size >= 4 && head[0] == 0x1a.toByte() && head[1] == 0x45.toByte() && head[2] == 0xdf.toByte() && head[3] == 0xa3.toByte()
    val avi = head.size >= 12 && starts(head, 0, "RIFF") && starts(head, 8, "AVI ")
    return named || (iso && !audio) || matroska || avi
  }
}
