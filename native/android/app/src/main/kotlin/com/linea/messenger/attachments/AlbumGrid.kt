package com.linea.messenger.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.Base64
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.core.Core
import java.util.UUID
import kotlin.math.ln

/** Media: several photos (or videos) sent together, shown as one message (the reference's media/albumLayout.ts and
 *  MediaBubble.tsx `AlbumGrid`; native/ios/Sources/Attachments/AlbumGrid.swift). Every part is a message of its own
 *  with `meta.album` `{id, index, count}`; consecutive parts of one album from one sender join one row. */
data class MsgAlbum(val parts: List<Part>) {
  data class Part(
    /** The row key of the part's own message (what opens it). */
    val key: String, val thumb: String, val wide: Double, val video: Boolean, val time: String,
  )

  companion object {
    fun parse(value: Any?): MsgAlbum? {
      val list = (value as? List<*>)?.mapNotNull { Core.map(it as? Map<*, *>) } ?: return null
      if (list.size < 2) return null
      val parts = list.mapNotNull { item ->
        val key = item["key"] as? String ?: return@mapNotNull null
        Part(key, item["thumb"] as? String ?: "", (item["wide"] as? Number)?.toDouble() ?: 1.0, item["video"] as? Boolean ?: false, item["mediaTime"] as? String ?: "")
      }
      return if (parts.size >= 2) MsgAlbum(parts) else null
    }
  }
}

/** One tile of the mosaic, from the album's corner (in the units it was laid out in). */
data class MsgAlbumTile(val index: Int, val x: Double, val y: Double, val width: Double, val height: Double) {
  fun contains(px: Double, py: Double) = px >= x && px < x + width && py >= y && py < y + height
}

/** The mosaic: items keep their order and are split into rows of 1–4; every row fills the width exactly and its
 *  height follows the aspect ratios in it. The split is chosen by dynamic programming so row heights stay close to a
 *  target and the whole album stays within `maxHeight` (a port of `albumLayout`, number for number). */
object AlbumLayout {
  class Laid(val tiles: List<MsgAlbumTile>, val height: Double)

  fun layout(aspects: List<Double>, width: Double, maxHeight: Double, gap: Double = 2.0): Laid {
    val n = aspects.size
    if (n == 0) return Laid(emptyList(), 0.0)
    val ratio = aspects.map { value -> (if (value.isFinite() && value > 0) value else 1.0).coerceIn(0.4, 2.5) }
    val target = if (n <= 2) width / 1.25 else if (n <= 4) width / 1.6 else width / 2.4
    fun rowHeight(from: Int, count: Int): Double = (width - gap * (count - 1)) / ratio.subList(from, from + count).sum()
    val best = arrayOfNulls<Pair<Double, List<Int>>>(n + 1)
    best[n] = 0.0 to emptyList()
    for (i in n - 1 downTo 0) {
      var choice: Pair<Double, List<Int>>? = null
      for (count in 1..minOf(4, n - i)) {
        // A lone item in a row only for wide pictures (or when it is the only one).
        if (count == 1 && n > 1 && (ratio[i] < 1.2 || (n > 3 && ratio[i] < 1.8))) continue
        val rest = best[i + count] ?: continue
        val logged = ln(rowHeight(i, count) / target)
        val cost = logged * logged + rest.first
        if (choice == null || cost < choice.first) choice = cost to (listOf(count) + rest.second)
      }
      best[i] = choice ?: run {
        val step = minOf(2, n - i)
        Double.POSITIVE_INFINITY to (listOf(step) + (best[i + step]?.second ?: emptyList()))
      }
    }
    val rows = best[0]?.second ?: listOf(n)
    var heights = ArrayList<Double>()
    var index = 0
    for (count in rows) { heights.add(rowHeight(index, count)); index += count }
    val gaps = gap * (heights.size - 1)
    val total = heights.sum() + gaps
    if (total > maxHeight) {
      val scale = (maxHeight - gaps) / (total - gaps)
      heights = ArrayList(heights.map { it * scale })
    }
    val tiles = ArrayList<MsgAlbumTile>()
    var y = 0.0
    index = 0
    rows.forEachIndexed { row, count ->
      val h = heights[row]
      val sum = ratio.subList(index, index + count).sum()
      var x = 0.0
      for (k in 0 until count) {
        val last = k == count - 1
        val w = if (last) width - x else swiftRound((width - gap * (count - 1)) * ratio[index + k] / sum)
        tiles.add(MsgAlbumTile(index + k, x, y, w, swiftRound(h)))
        x += w + gap
      }
      y += swiftRound(h) + gap
      index += count
    }
    return Laid(tiles, y - gap)
  }
}

/** Where an album goes in a row, and how it is drawn (pixels). */
class MsgAlbumLayout(val width: Float, val height: Float, val tiles: List<MsgAlbumTile>, private val density: Float) {
  companion object {
    fun make(album: MsgAlbum, screenWidth: Float, inner: Float, density: Float): MsgAlbumLayout {
      // As wide as a single photo may be: at most 300, and 36 from each edge of the screen (in points).
      val points = minOf(inner / density, swiftRound(minOf(300.0, screenWidth / density - 2 * 36.0)).toFloat())
      val laid = AlbumLayout.layout(album.parts.map { it.wide }, points.toDouble(), points * 1.45)
      return MsgAlbumLayout(points * density, laid.height.toFloat() * density, laid.tiles, density)
    }

    /** The decoded small pictures of an album, by part key. */
    fun pictures(album: MsgAlbum): Map<String, Bitmap> {
      val out = HashMap<String, Bitmap>()
      for (part in album.parts) {
        if (part.thumb.isEmpty()) continue
        try { val bytes = Base64.decode(part.thumb, Base64.DEFAULT); BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { out[part.key] = it } } catch (_: Throwable) {}
      }
      return out
    }
  }

  /** The part under a point (from the album's corner, pixels). */
  fun part(px: Float, py: Float, album: MsgAlbum): String? {
    for (tile in tiles) if (tile.contains((px / density).toDouble(), (py / density).toDouble()) && tile.index < album.parts.size) return album.parts[tile.index].key
    return null
  }

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

  fun draw(canvas: Canvas, album: MsgAlbum, pictures: Map<String, Bitmap>, x: Float, y: Float, palette: MsgPalette) {
    val d = density
    canvas.save()
    canvas.clipPath(Path().apply { addRoundRect(RectF(x, y, x + width, y + height), 16f * d, 16f * d, Path.Direction.CW) })
    for (tile in tiles) {
      if (tile.index >= album.parts.size) continue
      val part = album.parts[tile.index]
      val box = RectF(x + (tile.x * d).toFloat(), y + (tile.y * d).toFloat(), x + ((tile.x + tile.width) * d).toFloat(), y + ((tile.y + tile.height) * d).toFloat())
      val image = pictures[part.key]
      if (image != null && image.width > 0 && image.height > 0) {
        canvas.save()
        canvas.clipRect(box)
        val scale = maxOf(box.width() / image.width, box.height() / image.height)
        val w = image.width * scale; val h = image.height * scale
        canvas.drawBitmap(image, null, RectF(box.centerX() - w / 2, box.centerY() - h / 2, box.centerX() + w / 2, box.centerY() + h / 2), paint)
        canvas.restore()
      } else {
        paint.color = palette.theirs
        canvas.drawRect(box, paint)
      }
      if (part.video) {
        val cx = box.centerX(); val cy = box.centerY()
        paint.color = 0x73000000
        canvas.drawCircle(cx, cy, 20f * d, paint)
        paint.color = 0xFFFFFFFF.toInt()
        canvas.drawPath(Path().apply { moveTo(cx - 6f * d, cy - 9f * d); lineTo(cx + 10f * d, cy); lineTo(cx - 6f * d, cy + 9f * d); close() }, paint)
        if (part.time.isNotEmpty()) {
          paint.textSize = 11f * d
          paint.typeface = com.linea.messenger.design.Theme.weight(600)
          val w = paint.measureText(part.time)
          val pill = RectF(box.left + 6f * d, box.top + 6f * d, box.left + 6f * d + w + 12f * d, box.top + 6f * d + paint.textSize + 6f * d)
          paint.color = 0x73000000
          canvas.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, paint)
          paint.color = 0xFFFFFFFF.toInt()
          canvas.drawText(part.time, pill.left + 6f * d, pill.centerY() - (paint.descent() + paint.ascent()) / 2, paint)
        }
      }
    }
    canvas.restore()
  }
}

/** The album fields of a chat's rows (made off the main thread by ChatHistory). */
object AlbumRows {
  /** One part: its row key, its small picture, its shape, whether it is a video. */
  fun part(message: Map<String, Any?>, key: String): Map<String, Any?> {
    val fields = AttachmentRows.fields(message, key)
    val part = linkedMapOf<String, Any?>("key" to key, "thumb" to (fields["thumb"] as? String ?: ""), "wide" to ((fields["thumbWide"] as? Number)?.toDouble() ?: 1.0), "video" to (fields["media"] == "video"))
    (fields["mediaTime"] as? String)?.let { part["mediaTime"] = it }
    return part
  }

  /** Whether a message is a part of an album that may join the album row before it: a photo or a video, the same
   *  album id and sender, and not more parts than the album says it has. */
  fun joins(message: Map<String, Any?>, sender: String, row: Map<String, Any?>): Boolean {
    val album = Core.map(Core.map(message["meta"] as? Map<*, *>)?.get("album") as? Map<*, *>) ?: return false
    val id = album["id"] as? String ?: return false
    if (Core.map(message["attachment"] as? Map<*, *>) == null || row["albumId"] != id || row["albumSender"] != sender) return false
    val count = (album["count"] as? Number)?.toInt() ?: 0
    val have = (row["album"] as? List<*>)?.size ?: 1
    return have < count
  }

  class Group(val id: String, val index: Int, val count: Int)

  /** Up to ten photos make an album; more are split into albums of ten (a last one of one photo is no album). */
  fun groups(total: Int): List<Group?> {
    if (total < 2) return List(total) { null }
    val ids = List((total + 9) / 10) { UUID.randomUUID().toString().lowercase() }
    return List(total) { index ->
      val group = index / 10; val start = group * 10; val count = minOf(10, total - start)
      if (count >= 2) Group(ids[group], index - start, count) else null
    }
  }

  /** The album mark of one part, for its message's meta. */
  fun meta(group: Group): Map<String, Any?> = mapOf("id" to group.id, "index" to group.index, "count" to group.count)

}

/** Swift's `rounded()`: halves away from zero (Kotlin's own rounding sends halves to the even neighbour). */
internal fun swiftRound(value: Double): Double = if (value >= 0) kotlin.math.floor(value + 0.5) else -kotlin.math.floor(-value + 0.5)
