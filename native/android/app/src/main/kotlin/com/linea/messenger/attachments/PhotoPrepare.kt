package com.linea.messenger.attachments

import android.annotation.TargetApi
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Base64
import com.linea.messenger.core.Core
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** A photo made ready to send, the way the previous app's photo module did it (mobile/modules/linea-photo and
 *  mobile/src/photo/pipeline.ts): the picture is decoded upright and drawn into a fresh sRGB bitmap, and that
 *  bitmap alone is written out — as PNG, or as JPEG when the original was a big picture without transparency.
 *  Nothing of the original file is copied: no EXIF, no GPS, no camera or author data, no thumbnails, no name.
 *  What was written is then passed through a gate that keeps only the picture's own parts. */
object PhotoPrepare {
  class Prepared(
    /** The bytes that are sealed and sent. */
    val bytes: ByteArray,
    val name: String,
    val mimeType: String,
    val width: Int,
    val height: Int,
    /** The small picture that rides inside the message (the core's checked object), if one could be made. */
    val preview: Map<String, Any?>?,
  )

  class Failure(val words: String) : Exception()

  const val maxBytes = 20 * 1024 * 1024
  private const val maxPixels = 16_000_000
  val unreadable = Failure("Не удалось обработать фото. Файл не отправлен.")

  /** The size a picture is worked at: its own when it has at most `limit` pixels, else scaled down to that.
   *  Null for a size no picture is worked at. */
  fun fit(width: Int, height: Int, limit: Int = maxPixels): Pair<Int, Int>? {
    if (width <= 0 || height <= 0 || width > 20000 || height > 20000 || width.toLong() * height > 100_000_000) return null
    val pixels = width.toLong() * height
    if (pixels <= limit) return Pair(width, height)
    val scale = sqrt(limit.toDouble() / pixels.toDouble())
    return Pair(maxOf(1, floor(width * scale).toInt()), maxOf(1, floor(height * scale).toInt()))
  }

  /** A fresh 8-bit sRGB bitmap of the picture at the given size. */
  private fun redraw(image: Bitmap, width: Int, height: Int, opaque: Boolean): Bitmap? = try {
    val fresh = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(fresh)
    if (opaque) canvas.drawColor(Color.WHITE)
    canvas.drawBitmap(image, null, android.graphics.Rect(0, 0, width, height), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
    fresh
  } catch (_: Throwable) { null }

  /** Only the bitmap is given to the encoder: there is nothing of the source left to pass on. */
  private fun encode(image: Bitmap, jpeg: Boolean, quality: Int = 100): ByteArray? = try {
    val out = ByteArrayOutputStream()
    if (image.compress(if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, quality, out)) out.toByteArray() else null
  } catch (_: Throwable) { null }

  private val signature = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)

  /** The PNG with only the parts a still picture needs (IHDR, PLTE, tRNS, IDAT, IEND), each with a correct
   *  checksum; text, time, EXIF, colour-profile and every other side part is dropped. Null: not a sound PNG.
   *  (The reference's `sanitizePng` for an ordinary, non-HDR picture; the system writes only such here.) */
  fun cleanPng(png: ByteArray): ByteArray? {
    if (png.size > maxBytes || png.size <= signature.size || !png.copyOfRange(0, 8).contentEquals(signature)) return null
    fun byte(index: Int) = png[index].toInt() and 0xFF
    val out = ByteArrayOutputStream(png.size)
    out.write(signature)
    var offset = 8
    var header = false; var pixels = false; var ended = false
    val crc = CRC32()
    while (offset < png.size) {
      if (ended || png.size - offset < 12) return null
      val length = (byte(offset).toLong() shl 24) or (byte(offset + 1).toLong() shl 16) or (byte(offset + 2).toLong() shl 8) or byte(offset + 3).toLong()
      val end = offset + length + 12
      if (end > png.size) return null
      val last = end.toInt()
      val kind = String(png, offset + 4, 4, Charsets.ISO_8859_1)
      val stored = (byte(last - 4).toLong() shl 24) or (byte(last - 3).toLong() shl 16) or (byte(last - 2).toLong() shl 8) or byte(last - 1).toLong()
      crc.reset(); crc.update(png, offset + 4, last - 4 - (offset + 4))
      if (crc.value != stored) return null
      if (!header && kind != "IHDR") return null
      when (kind) {
        "IHDR" -> { if (header || length != 13L) return null; header = true; out.write(png, offset, last - offset) }
        "PLTE", "tRNS" -> { if (pixels) return null; out.write(png, offset, last - offset) }
        "IDAT" -> { pixels = true; out.write(png, offset, last - offset) }
        "IEND" -> { if (!pixels || length != 0L) return null; ended = true; out.write(png, offset, last - offset) }
        "acTL", "fcTL", "fdAT" -> return null
        // A part the picture cannot be read without, of a kind this app does not write.
        else -> if (byte(offset + 4) and 32 == 0) return null
      }
      offset = last
    }
    return if (ended) out.toByteArray() else null
  }

  /** What a picture file says of itself before it is decoded: its size as it is shown (upright). */
  private class Header(val width: Int, val height: Int)

  private fun header(resolver: ContentResolver, uri: Uri): Header? = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    // A PDF or any other document is not a picture, whatever its name says: only what the decoder knows.
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outMimeType?.startsWith("image/") != true) null
    else if (turned(resolver, uri) % 180 != 0) Header(bounds.outHeight, bounds.outWidth) else Header(bounds.outWidth, bounds.outHeight)
  } catch (_: Throwable) { null }

  /** How many degrees the file asks its picture to be turned by (and whether to mirror it: see `upright`). */
  private fun orientation(resolver: ContentResolver, uri: Uri): Int = try {
    resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } ?: ExifInterface.ORIENTATION_NORMAL
  } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }

  private fun turned(resolver: ContentResolver, uri: Uri): Int = when (orientation(resolver, uri)) {
    ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSPOSE -> 90
    ExifInterface.ORIENTATION_ROTATE_180, ExifInterface.ORIENTATION_FLIP_VERTICAL -> 180
    ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
    else -> 0
  }

  /** Whether the bytes are a picture the system can decode (a photo picked as a file is prepared as a photo). */
  fun isPicture(resolver: ContentResolver, uri: Uri): Boolean = header(resolver, uri) != null

  /** The picture decoded upright (the orientation is applied to the pixels, then forgotten) at the working
   *  size, in memory the app owns. */
  private fun decode(resolver: ContentResolver, uri: Uri, size: Pair<Int, Int>): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 28) NewDecoder.decode(resolver, uri, size) else decodeOld(resolver, uri, size)
  } catch (_: Throwable) { null }

  @TargetApi(28)
  private object NewDecoder {
    /** The system's decoder turns the picture upright by itself and scales while it decodes. */
    fun decode(resolver: ContentResolver, uri: Uri, size: Pair<Int, Int>): Bitmap =
      ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.isMutableRequired = false
        decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
        // The decoder's own word about the size is the one that counts.
        val fitted = fit(info.size.width, info.size.height) ?: size
        decoder.setTargetSize(fitted.first, fitted.second)
      }
  }

  /** Before Android 9: decoded at the nearest half-size not under the working size, then turned as the file asks. */
  private fun decodeOld(resolver: ContentResolver, uri: Uri, size: Pair<Int, Int>): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxOf(size.first, size.second)) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val raw = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
    val matrix = Matrix()
    when (orientation(resolver, uri)) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
      else -> return raw
    }
    return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
  }

  /** Prepares the picture of an image file. `fileSize`: the size of the original, which decides the format. */
  fun prepare(resolver: ContentResolver, uri: Uri, fileSize: Long): Result<Prepared> {
    val header = header(resolver, uri) ?: return Result.failure(unreadable)
    val size = fit(header.width, header.height) ?: return Result.failure(unreadable)
    val decoded = decode(resolver, uri, size) ?: return Result.failure(unreadable)
    val (width, height) = fit(decoded.width, decoded.height) ?: return Result.failure(unreadable)
    // A big original without transparency (a camera JPEG, HEIC, RAW) becomes JPEG, so it stays sharp within
    // 20 MiB; everything else is PNG, exact to the pixel.
    val jpeg = fileSize > maxBytes && !decoded.hasAlpha()
    val first = redraw(decoded, width, height, opaque = jpeg)
    decoded.recycle()
    return finish(first ?: return Result.failure(unreadable), jpeg)
  }

  /** Writes the fresh bitmap out, cleans what was written and makes the small picture. */
  fun finish(bitmap: Bitmap, jpeg: Boolean, limit: Int = maxBytes): Result<Prepared> {
    var current = bitmap
    try {
      for (turn in 0 until 4) {
        val written = encode(current, jpeg) ?: return Result.failure(unreadable)
        if (written.size <= limit) {
          val clean = (if (jpeg) FileCore.cleanJpeg(written).getOrNull() else cleanPng(written)) ?: return Result.failure(unreadable)
          return Result.success(Prepared(clean, if (jpeg) "photo.jpg" else "photo.png", if (jpeg) "image/jpeg" else "image/png", current.width, current.height, preview(current)))
        }
        // Sending never fails on size: a picture whose clean file is over 20 MiB is scaled down and written again.
        val factor = minOf(0.9, sqrt(limit.toDouble() / written.size.toDouble()) * 0.9)
        val width = maxOf(1, floor(current.width * factor).toInt()); val height = maxOf(1, floor(current.height * factor).toInt())
        val smaller = redraw(current, width, height, opaque = jpeg) ?: return Result.failure(unreadable)
        current.recycle()
        current = smaller
      }
      return Result.failure(Failure("Фото больше 20 МиБ. Выбери уменьшение и повтори обработку."))
    } finally {
      current.recycle()
    }
  }

  /** The small picture for inside the message: a JPEG of the cleaned bitmap, tried at three sizes until the
   *  core's gate (at most 256 px a side and 8 KiB, cleaned, checked) takes one. Never the original. */
  fun preview(image: Bitmap): Map<String, Any?>? {
    for ((edge, quality) in listOf(240f to 60, 160f to 40, 96f to 30)) {
      val scale = edge / maxOf(image.width, image.height)
      val small = redraw(image, maxOf(1, (image.width * scale).roundToInt()), maxOf(1, (image.height * scale).roundToInt()), opaque = true) ?: continue
      val jpeg = encode(small, jpeg = true, quality = quality)
      small.recycle()
      if (jpeg == null) continue
      Core.map(FileCore.call("preview", listOf(Base64.encodeToString(jpeg, Base64.NO_WRAP))))?.let { return it }
    }
    return null
  }

  /** The words of a failed preparation. */
  fun words(result: Result<*>): String = (result.exceptionOrNull() as? Failure)?.words ?: unreadable.words
}
