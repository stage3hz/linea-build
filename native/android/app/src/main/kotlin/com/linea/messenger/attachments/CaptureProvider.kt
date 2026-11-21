package com.linea.messenger.attachments

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/** Media: where the system's camera writes the photo taken from the paperclip's panel (the reference's
 *  expo-image-picker `launchCameraAsync` does the same through its own provider). It is not exported: only the
 *  camera app handed one address with a write grant can write that one file, inside the app's own cache; nothing
 *  can be read, listed or deleted through it. The panel reads the file itself and removes it once it is sent or
 *  dropped. */
class CaptureProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  private fun file(uri: Uri): File? {
    val context = context ?: return null
    val parts = uri.pathSegments
    if (parts.size != 1 || !nameRule.matches(parts[0])) return null
    return File(folder(context), parts[0])
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (!mode.startsWith("w") && mode != "rw" && mode != "rwt") throw SecurityException("write only")
    val file = file(uri) ?: throw FileNotFoundException()
    file.parentFile?.mkdirs()
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE)
  }

  override fun getType(uri: Uri): String? = if (file(uri) != null) "image/jpeg" else null
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()

  companion object {
    private val nameRule = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg")

    fun folder(context: Context): File = File(context.cacheDir, "invizent-capture")

    /** A fresh place for one photo: the file (not there yet) and the address the camera writes it through. */
    fun fresh(context: Context): Pair<File, Uri> {
      val name = UUID.randomUUID().toString().lowercase() + ".jpg"
      val file = File(folder(context), name)
      return file to Uri.parse("content://" + context.packageName + ".capture/" + name)
    }

    /** Leftovers of earlier runs. */
    fun sweep(context: Context) { folder(context).listFiles()?.forEach { it.delete() } }
  }
}
