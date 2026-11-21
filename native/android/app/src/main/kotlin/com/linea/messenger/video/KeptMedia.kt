package com.linea.messenger.video

import android.content.Context
import java.io.File
import java.security.MessageDigest

/** Media: «Сохранить для просмотра без сети» (the reference's mediaCache.ts `keepMedia`; native/ios/Sources/Video/
 *  VideoPlayer.swift `KeptMedia`): a played video is kept, decrypted, in the app's own private storage (never backed
 *  up: the app allows no backup) instead of being removed when the player closes, and opens from there next time
 *  without the network. One folder per file and key (the reference's `mediaKey`); everything goes on leaving the
 *  account and with «Очистить кэш». */
object KeptMedia {
  private fun root(context: Context) = File(context.applicationContext.filesDir, "invizent-kept")

  /** The reference's `mediaKey`: the file's id and its key id, hashed into a safe folder name. */
  fun folderName(attachment: Map<String, Any?>): String? {
    val id = attachment["id"] as? String ?: return null
    if (id.isEmpty()) return null
    val keyId = (attachment["encryption"] as? Map<*, *>)?.get("fileKeyId") as? String ?: ""
    return MessageDigest.getInstance("SHA-256").digest("$id:$keyId".toByteArray()).joinToString("") { String.format(java.util.Locale.ROOT, "%02x", it) }
  }

  private fun place(context: Context, attachment: Map<String, Any?>): File? = folderName(attachment)?.let { File(root(context), it) }

  /** The kept file of an attachment, if there is one. */
  fun file(context: Context, attachment: Map<String, Any?>): File? =
    place(context, attachment)?.listFiles()?.firstOrNull { it.isFile && !it.name.startsWith(".") }

  fun isKept(context: Context, attachment: Map<String, Any?>): Boolean = file(context, attachment) != null

  /** Copies the decrypted file in (from the player's temporary copy). Any thread. */
  fun keep(context: Context, source: File, attachment: Map<String, Any?>): Boolean {
    val folder = place(context, attachment) ?: return false
    return try {
      folder.deleteRecursively()
      if (!folder.mkdirs()) throw IllegalStateException("folder")
      source.copyTo(File(folder, source.name.ifEmpty { "video" }), overwrite = true)
      true
    } catch (_: Exception) {
      folder.deleteRecursively()
      false
    }
  }

  fun remove(context: Context, attachment: Map<String, Any?>) { place(context, attachment)?.deleteRecursively() }

  fun wipe(context: Context) { root(context).deleteRecursively() }

  /** The bytes kept (for «Данные и память»). */
  fun bytes(context: Context): Long = root(context).walkBottomUp().filter { it.isFile }.sumOf { it.length() }
}
