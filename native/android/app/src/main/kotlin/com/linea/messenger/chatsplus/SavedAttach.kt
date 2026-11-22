package com.linea.messenger.chatsplus

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.ContextWrapper
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.View
import android.webkit.MimeTypeMap
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileRules
import com.linea.messenger.attachments.FileTransfer
import com.linea.messenger.attachments.PhotoPrepare
import com.linea.messenger.attachments.Picks
import com.linea.messenger.attachments.uploadSealedFile
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.core.Core
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** ChatsPlus: what can be added to «Избранное» besides words (saved/SavedScreen.tsx): a photo or a file through the
 *  paperclip. The same pieces as a chat's attachments: the photo comes from the system's picker (no permission) and
 *  is drawn anew without its metadata (PhotoPrepare); each file is sealed under a key of its own and uploaded
 *  (end-to-end encrypted, as in a chat); only the attachment's description goes into the note, kept in the device's
 *  encrypted storage (native/ios/Sources/ChatsPlus/SavedAttach.swift, its paperclip part). Main thread only. */
class SavedAttach(private val host: View, private val messenger: Messenger?, private val saved: SavedMessages) {
  private val context: Context get() = host.context
  private val main = Handler(Looper.getMainLooper())
  /** Words for the person (a notice over the list). */
  var say: ((String) -> Unit)? = null
  /** Something is being prepared or uploaded: the composer waits. */
  var busy = false
    private set(value) { field = value; onBusy?.invoke(value) }
  var onBusy: ((Boolean) -> Unit)? = null

  /** Record: a voice note held on the microphone, a round video (a tap switches), with the same take, lock and
   *  preview as a chat's composer (voice/MediaRecording.kt); what is recorded is sealed and uploaded as any file. */
  val recording = com.linea.messenger.voice.MediaRecording(host.context)
  val isRecording: Boolean get() = recording.isRecording

  /** `holder`: a layer over the composer's glass; `screen`: the page (the blob and the lock stand over it). */
  fun installRecording(holder: android.widget.FrameLayout, screen: android.view.ViewGroup) {
    recording.install(holder, screen, null)
    recording.brokenWords = "Микрофон записал тишину — голосовое не сохранено. Запиши ещё раз."
    recording.canStart = { mode ->
      if (messenger == null) (if (mode == com.linea.messenger.voice.RecordControl.Mode.VOICE) "Голосовые в Избранном доступны в приложении." else "Видео в Избранном доступны в приложении.") else null
    }
    recording.say = { words -> say?.invoke(words) }
    recording.sendVoice = { file, ms, waveform -> saveVoice(file, ms, waveform) }
    recording.sendNote = { file -> saveNote(file) }
  }

  private fun saveVoice(file: java.io.File, durationMs: Long, waveform: String?) {
    val name = FileCore.call("voiceName", listOf(System.currentTimeMillis())) as? String ?: "voice.m4a"
    val media = LinkedHashMap<String, Any?>()
    media["durationMs"] = durationMs
    waveform?.let { media["waveform"] = it }
    busy = true
    work.execute {
      val bytes = try { file.readBytes() } catch (_: Exception) { null }
      file.delete()
      main.post {
        if (bytes == null || bytes.isEmpty() || bytes.size > MAX_FILE) return@post done("Не удалось прочитать файл.")
        upload(Prepared(bytes, name, "audio/mp4", media, null))
      }
    }
  }

  private fun saveNote(file: java.io.File) {
    busy = true
    com.linea.messenger.video.VideoPrepare.prepare(context, file, com.linea.messenger.video.VideoPrepare.Job()) { result ->
      file.delete()
      val prepared = result.getOrNull()
      val noteName = FileCore.call("noteName", listOf(System.currentTimeMillis())) as? String ?: "video.mp4"
      val bytes = try { prepared?.file?.readBytes() } catch (_: Exception) { null }
      prepared?.file?.delete()
      main.post {
        if (prepared == null) return@post done(FileCore.words(result))
        if (bytes == null || bytes.isEmpty() || bytes.size > MAX_FILE) return@post done("Не удалось обработать видео. Файл не отправлен.")
        upload(Prepared(bytes, noteName, "video/mp4", prepared.media, prepared.preview))
      }
    }
  }

  private fun activity(): Activity? {
    var current: Context? = context
    while (current is ContextWrapper && current !is Activity) current = current.baseContext
    return current as? Activity
  }

  /** The paperclip: «Фото» or «Файл». */
  fun openMenu() {
    if (messenger == null) { say?.invoke("Файлы в Избранном доступны в приложении."); return }
    ChoiceSheet(context, "Добавить в Избранное", choices = listOf(
      ChoiceSheet.Choice("photo", "Фото") { main.postDelayed({ pickPhoto() }, 350) },
      ChoiceSheet.Choice("doc", "Файл") { main.postDelayed({ pickFile() }, 350) },
    )).show()
  }

  private fun pickPhoto() {
    val activity = activity() ?: return
    val asked = Picks.ask(activity, ChatAttachments.photoPicker()) { chosen -> chosen.firstOrNull()?.let { picked(it, photo = true) } }
      || Picks.ask(activity, ChatAttachments.documentPicker("image/*")) { chosen -> chosen.firstOrNull()?.let { picked(it, photo = true) } }
    if (!asked) say?.invoke("Не удалось открыть галерею.")
  }

  private fun pickFile() {
    val activity = activity() ?: return
    if (!Picks.ask(activity, ChatAttachments.documentPicker("*/*")) { chosen -> chosen.firstOrNull()?.let { picked(it, photo = false) } }) say?.invoke("Не удалось открыть файлы.")
  }

  private class Prepared(val bytes: ByteArray, val name: String, val mime: String, val media: Map<String, Any?>?, val preview: Map<String, Any?>?)

  private fun picked(uri: Uri, photo: Boolean) {
    busy = true
    val resolver = context.contentResolver
    work.execute {
      val prepared = if (photo) photo(resolver, uri, size(resolver, uri).second) else file(resolver, uri)
      main.post {
        val made = prepared.getOrNull()
        if (made == null) done(PhotoPrepare.words(prepared)) else upload(made)
      }
    }
  }

  private fun size(resolver: ContentResolver, uri: Uri): Pair<String, Long> {
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
    // Only the last part of a name: never a path.
    return name.substringAfterLast('/').trim().ifEmpty { "file" } to size
  }

  private fun photo(resolver: ContentResolver, uri: Uri, fileSize: Long): Result<Prepared> =
    PhotoPrepare.prepare(resolver, uri, fileSize).map { Prepared(it.bytes, it.name, it.mimeType, mapOf("width" to it.width, "height" to it.height, "hdr" to "sdr"), it.preview) }

  /** A picture is prepared as a photo whatever its name says; a video is not sent (it cannot be cleaned of its
   *  metadata here); anything else goes as it is, up to 20 MB. */
  private fun file(resolver: ContentResolver, uri: Uri): Result<Prepared> {
    val unread = Result.failure<Prepared>(PhotoPrepare.Failure("Не удалось прочитать файл."))
    val (name, size) = size(resolver, uri)
    if (size == 0L) return unread
    if (PhotoPrepare.isPicture(resolver, uri)) return photo(resolver, uri, size)
    val type = try { resolver.getType(uri) } catch (_: Exception) { null } ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
    val head = try { resolver.openInputStream(uri)?.use { input -> ByteArray(16).let { it.copyOf(maxOf(0, input.read(it))) } } } catch (_: Exception) { null } ?: return unread
    if (FileRules.isVideo(type, head)) return Result.failure(PhotoPrepare.Failure("Видео пока нельзя отправить в этой версии приложения."))
    if (size > MAX_FILE) return Result.failure(PhotoPrepare.Failure("Файл слишком большой. Максимум — 20 МБ."))
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
    return Result.success(Prepared(bytes, name, type ?: "application/octet-stream", null, null))
  }

  /** Seals the bytes under a fresh key, uploads them as this session and keeps the attachment as a note. */
  private fun upload(prepared: Prepared) {
    val messenger = messenger ?: return done("")
    busy = true
    say?.invoke("Сохраняем в Избранное…")
    val transfer = FileTransfer()
    work.execute {
      fun failed(words: String) { main.post { done(words) } }
      // A new key, nonce and key id for every upload: the same key never seals two files.
      val encryption = Core.map(FileCore.call("newEncryption")) ?: return@execute run { failed("Шифрование ещё не готово. Попробуй ещё раз.") }
      val sealed = FileCore.seal(prepared.bytes, encryption)
      val cipher = sealed.getOrNull() ?: return@execute run { failed(FileCore.words(sealed)) }
      val uploaded = messenger.server.uploadSealedFile(cipher, transfer)
      val id = uploaded.getOrNull()
      if (id == null) {
        if (uploaded.exceptionOrNull() is FileTransfer.Failure.Cancelled) failed("")
        else failed(FileTransfer.words(uploaded.exceptionOrNull(), proof = "Не удалось подтвердить устройство. Попробуй ещё раз."))
        return@execute
      }
      val attachment = Core.map(FileCore.call("attachment", listOf(id, prepared.name, prepared.mime, prepared.bytes.size, encryption, prepared.media, prepared.preview)))
        ?: return@execute run { failed("Не удалось сохранить файл.") }
      main.post {
        saved.save("", attachment) { result -> done((result.exceptionOrNull() as? SavedMessages.Failure)?.words ?: "") }
      }
    }
  }

  private fun done(words: String) {
    busy = false
    if (words.isNotEmpty()) say?.invoke(words)
  }

  companion object {
    private const val MAX_FILE = 20 * 1024 * 1024
    private val work = Executors.newSingleThreadExecutor()
  }
}
