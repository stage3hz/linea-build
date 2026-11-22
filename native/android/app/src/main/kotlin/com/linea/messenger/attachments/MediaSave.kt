package com.linea.messenger.attachments

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.linea.messenger.app.Messenger
import com.linea.messenger.voice.MediaRows
import java.util.concurrent.Executors

/** «Сохранить фото», «Сохранить видео», «Сохранить» of a message's menu (iOS: Sources/Attachments/SaveMedia.swift; the
 *  reference's ChatScreen.tsx `download`). A photo or a video is brought, opened on this device and added to the
 *  gallery through MediaStore — writing only, so the app asks for nothing and never sees what else is in the gallery
 *  (Android 10 and later); any other file, and everything on older Android, goes to the system's share sheet. The
 *  decrypted bytes are in memory only (a share leaves a copy in the app's own folder, removed with the others). */
object MediaSave {
  private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.media-save").apply { isDaemon = true } }

  /** The words of the menu item for an attachment. */
  fun label(attachment: Map<String, Any?>): String = when (kind(attachment)) {
    "video" -> "Сохранить видео"
    "photo" -> "Сохранить фото"
    else -> "Сохранить"
  }

  /** "photo", "video" or "file" (a voice message is a file here, as in the reference; a round video is a video). */
  fun kind(attachment: Map<String, Any?>): String {
    val about = FileCore.describe(attachment).kind
    if (about == "photo") return "photo"
    val media = MediaRows.kind(attachment)
    if (media == "video" || media == "note" || about == "video") return "video"
    return "file"
  }

  /** Brings the attachments one after another and saves them; `say` gets the words of the result (main thread). */
  fun save(context: Context, attachments: List<Map<String, Any?>>, messenger: Messenger, say: (String, Boolean) -> Unit) {
    val first = attachments.firstOrNull() ?: return
    val visual = attachments.all { kind(it) != "file" }
    if (!visual || Build.VERSION.SDK_INT < 29) return share(context, first, messenger, say)
    say("Сохраняется…", false)
    next(context, attachments, 0, 0, messenger, say)
  }

  private fun next(context: Context, attachments: List<Map<String, Any?>>, index: Int, saved: Int, messenger: Messenger, say: (String, Boolean) -> Unit) {
    if (index >= attachments.size) {
      if (saved == attachments.size) say(if (saved > 1) "Сохранено в галерею: $saved" else "Сохранено в галерею", false)
      return
    }
    val attachment = attachments[index]
    val video = kind(attachment) == "video"
    bring(messenger, attachment) { result ->
      val bytes = result.getOrNull() ?: return@bring say((result.exceptionOrNull() as? FileCore.Failure)?.words ?: "Не удалось загрузить зашифрованный файл.", true)
      val app = context.applicationContext
      val main = android.os.Handler(android.os.Looper.getMainLooper())
      work.execute {
        val fine = write(app, bytes, attachment["name"] as? String ?: (if (video) "video.mp4" else "photo.jpg"), video)
        main.post {
          if (!fine) say(if (video) "Не удалось сохранить видео." else "Не удалось сохранить фото.", true)
          else next(context, attachments, index + 1, saved + 1, messenger, say)
        }
      }
    }
  }

  private fun bring(messenger: Messenger, attachment: Map<String, Any?>, done: (Result<ByteArray>) -> Unit) {
    val about = FileCore.describe(attachment)
    about.refusal?.let { return done(Result.failure(FileCore.Failure(it))) }
    val size = about.cipherSize ?: return done(Result.failure(FileCore.Failure("Не удалось загрузить зашифрованный файл.")))
    AttachmentLoad(messenger.server, attachment, size).start(done)
  }

  /** Adds the bytes to the gallery (Pictures/INVIZENT or Movies/INVIZENT). Android 10 and later. */
  private fun write(context: Context, bytes: ByteArray, name: String, video: Boolean): Boolean {
    if (Build.VERSION.SDK_INT < 29) return false
    return try {
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name.replace('/', '_'))
        put(MediaStore.MediaColumns.MIME_TYPE, DecryptedFiles.mimeType(name))
        put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/INVIZENT")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val collection = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val uri = resolver.insert(collection, values) ?: return false
      val written = try { resolver.openOutputStream(uri)?.use { it.write(bytes); true } ?: false } catch (_: Throwable) { false }
      if (!written) { resolver.delete(uri, null, null); return false }
      values.clear(); values.put(MediaStore.MediaColumns.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
      true
    } catch (_: Throwable) { false }
  }

  /** Any other file: the system's share sheet with the opened copy. */
  fun share(context: Context, attachment: Map<String, Any?>, messenger: Messenger, say: (String, Boolean) -> Unit) {
    bring(messenger, attachment) { result ->
      val bytes = result.getOrNull() ?: return@bring say((result.exceptionOrNull() as? FileCore.Failure)?.words ?: "Не удалось загрузить зашифрованный файл.", true)
      val written = DecryptedFiles.write(context, bytes, attachment["name"] as? String ?: "file") ?: return@bring say("Не удалось сохранить.", true)
      val uri = DecryptedFiles.address(context, written)
      val send = Intent(Intent.ACTION_SEND).setType(DecryptedFiles.mimeType(attachment["name"] as? String ?: "file")).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try { context.startActivity(Intent.createChooser(send, null)) } catch (_: Exception) { say("Не удалось открыть «Поделиться».", true) }
    }
  }
}
