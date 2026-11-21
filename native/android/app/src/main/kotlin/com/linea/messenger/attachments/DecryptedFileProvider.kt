package com.linea.messenger.attachments

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/** Lets the one app the person chose read the one decrypted file it was asked to show (see `FileOpen`).
 *
 *  It is not exported: no app can ask it anything on its own — only the holder of an address this app has just
 *  handed over with a read grant, and only for that address. An address names a folder of `DecryptedFiles` and
 *  the file in it; anything else is not found. Reading only: nothing can be written, changed or deleted here. */
class DecryptedFileProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  /** The file an address names, or null: exactly `/<folder of DecryptedFiles>/<name>`, and really inside it. */
  private fun file(uri: Uri): File? {
    val context = context ?: return null
    val parts = uri.pathSegments
    if (parts.size != 2 || !DecryptedFiles.folderName.matches(parts[0])) return null
    val name = parts[1]
    if (name.isEmpty() || name == "." || name == ".." || name.contains('/') || name.contains('\u0000')) return null
    return try {
      val folder = File(context.cacheDir, parts[0]).canonicalFile
      val file = File(folder, name).canonicalFile
      if (file.parentFile == folder && folder.parentFile == context.cacheDir.canonicalFile && file.isFile) file else null
    } catch (_: Exception) { null }
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw SecurityException("read only")
    val file = file(uri) ?: throw FileNotFoundException()
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri): String? = file(uri)?.let { DecryptedFiles.mimeType(it.name) }

  /** The name and the size, as the system's «openable» files tell them. */
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
    val file = file(uri) ?: return null
    val columns = (projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).filter { it == OpenableColumns.DISPLAY_NAME || it == OpenableColumns.SIZE }
    val cursor = MatrixCursor(columns.toTypedArray(), 1)
    cursor.addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) file.name else file.length() })
    return cursor
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
