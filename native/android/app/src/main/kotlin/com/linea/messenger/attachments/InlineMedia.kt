package com.linea.messenger.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.chat.MsgRow
import com.linea.messenger.net.Server
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Attachments: photos shown whole inside their row and files brought inside their row, as in the reference
 *  (mobile/src/media/MediaBubble.tsx: `MediaTile` — a photo up to 10 MB comes by itself and appears in the
 *  bubble, a tap while it comes stops it; `FileBubble` — the round button: ↓, a ring with the progress and a
 *  cross, then the file's icon, and the file opens once it is here). The iPhone's Sources/Attachments/InlineMedia.swift.
 *
 *  What is brought is checked and decrypted by the core (`AttachmentLoad`); the pictures and files stay in memory
 *  only (a few dozen pictures, files up to 25 MB), nothing decrypted is written here. Main thread only. */
object InlineMedia {
  /** MediaBubble.tsx `AUTO_PHOTO_BYTES`: photos up to this size come by themselves. */
  const val AUTO_PHOTO_BYTES = 10 * 1024 * 1024
  private const val KEEP_FILE_BYTES = 25 * 1024 * 1024
  private const val KEEP_PICTURES = 40

  enum class Status { IDLE, LOADING, READY, FAILED }

  /** `progress`: how much has arrived, 0…1; `words` while coming: «1,2 МБ / 3,4 МБ» (a photo) or «1,2 МБ из 3,4 МБ» (a file). */
  data class Entry(val status: Status = Status.IDLE, val progress: Float = 0f, val words: String = "")

  private val main by lazy { Handler(Looper.getMainLooper()) }
  private val decoding = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.inline-media").apply { isDaemon = true } }
  private var server: WeakReference<Server>? = null
  private val entries = HashMap<String, Entry>()
  private val loads = HashMap<String, AttachmentLoad>()
  private val pictures = HashMap<String, Bitmap>()
  private val pictureOrder = ArrayList<String>()
  private val files = HashMap<String, ByteArray>()
  private val blurredPreviews = HashMap<String, Bitmap>()
  /** Rows whose photo was asked for once: one that was stopped or failed is not asked for again by itself. */
  private val tried = HashSet<String>()
  /** Keys whose rows show a photo or a file card (an album's tile or the profile's media is not one of them). */
  private val inRows = HashSet<String>()
  /** Called (with the row's key) when a row's photo or file changed its state: the list draws that row again. */
  private val listeners = LinkedHashSet<(String) -> Unit>()

  fun listen(listener: (String) -> Unit) { listeners.add(listener) }
  fun unlisten(listener: (String) -> Unit) { listeners.remove(listener) }

  /** The account whose server brings the files; another account forgets everything of the previous one. */
  fun use(next: Server?) {
    if (next == null || next === server?.get()) return
    for (load in loads.values) load.cancel()
    entries.clear(); loads.clear(); pictures.clear(); pictureOrder.clear(); files.clear(); blurredPreviews.clear(); tried.clear()
    server = WeakReference(next)
  }

  fun entry(key: String): Entry = entries[key] ?: Entry()

  /** The photo of a row once it is here. */
  fun picture(key: String): Bitmap? = pictures[key]

  /** Whether the row of `key` shows its photo or file itself (a touch on it brings it there). */
  fun inRow(key: String): Boolean = key in inRows

  /** A row with a photo or a file card was laid out (`MsgRowView`); a photo up to 10 MB is brought by itself (once). */
  fun shown(key: String, photo: Boolean) {
    if (inRows.size > 4000) inRows.clear()
    inRows.add(key)
    if (photo) want(key)
  }

  /** The row of `key` became an album's: its photo opens from the tile, straight in the viewer. */
  fun gone(key: String) { inRows.remove(key) }

  private fun want(key: String) {
    if (entries.containsKey(key) || key in tried || server?.get() == null) return
    val attachment = AttachmentStore.attachment(key) ?: return
    val size = (attachment["size"] as? Number)?.toLong() ?: 0L
    if (size <= 0L || size > AUTO_PHOTO_BYTES) return
    tried.add(key)
    // Not while the list is laying out its rows: the state change draws them again.
    main.post { if (!entries.containsKey(key)) start(key, attachment, null) }
  }

  /** A touch on the row of a photo or a file (`press` of MediaTile and FileBubble). True: it was dealt with here
   *  (`openPhoto`: the photo is here — show it on the whole screen; `openFile`: the file is here — show it). */
  fun pressed(key: String, attachment: Map<String, Any?>, haptic: View?, openPhoto: () -> Unit, openFile: (ByteArray) -> Unit): Boolean {
    if (server?.get() == null) return false
    val about = FileCore.describe(attachment)
    if (about.refusal != null || about.kind == "video") return false
    val photo = about.kind == "photo"
    val after: ((ByteArray) -> Unit)? = if (photo) null else openFile
    when (entry(key).status) {
      Status.LOADING -> { light(haptic); cancel(key) }
      Status.READY -> {
        val data = files[key]
        if (photo && pictures[key] != null) openPhoto()
        else if (!photo && data != null) openFile(data)
        else { light(haptic); start(key, attachment, after) }
      }
      // A photo simply appears in the bubble; a file opens.
      Status.IDLE, Status.FAILED -> { light(haptic); start(key, attachment, after) }
    }
    return true
  }

  /** Stops what is being brought for a row; its button is the ↓ again. */
  fun cancel(key: String) {
    loads.remove(key)?.cancel()
    set(key, Entry())
  }

  /** ChatActions (chatactions/ForwardQueue.kt): the ring and ✕ of a forwarded attachment being copied, on its row on
   *  the way out (`progress` 0…1, the words in the pill or under the name). */
  fun showSending(key: String, progress: Float, words: String) {
    tried.add(key)
    set(key, Entry(Status.LOADING, progress.coerceIn(0f, 1f), words))
  }

  /** ChatActions: the forward's row is gone or failed — its ring goes with it. */
  fun forgetSending(key: String) {
    if (entries.remove(key) == null) return
    for (listener in listeners.toList()) listener(key)
  }

  private fun light(view: View?) = com.linea.messenger.chatlook.Haptic.light(view)

  private fun set(key: String, entry: Entry) {
    entries[key] = entry
    for (listener in listeners.toList()) listener(key)
  }

  /** «1,2 МБ / 3,4 МБ» for a photo, «1,2 МБ из 3,4 МБ» for a file. */
  fun loadingWords(size: Long, fraction: Float, photo: Boolean, sizeText: (Long) -> String = FileCore::sizeText): String {
    val got = sizeText((size * fraction.coerceIn(0f, 1f)).toLong())
    return got + (if (photo) " / " else " из ") + sizeText(size)
  }

  private fun start(key: String, attachment: Map<String, Any?>, then: ((ByteArray) -> Unit)?) {
    val server = server?.get() ?: return
    val about = FileCore.describe(attachment)
    tried.add(key)
    val cipherSize = about.cipherSize
    if (about.refusal != null || cipherSize == null) { set(key, Entry(Status.FAILED)); return }
    loads[key]?.cancel()
    val load = AttachmentLoad(server, attachment, cipherSize)
    loads[key] = load
    val size = (attachment["size"] as? Number)?.toLong() ?: maxOf(0, cipherSize - 16).toLong()
    val photo = about.kind == "photo"
    set(key, Entry(Status.LOADING, 0f, loadingWords(size, 0f, photo)))
    load.onFraction = { fraction -> if (loads[key] === load) set(key, Entry(Status.LOADING, fraction, loadingWords(size, fraction, photo))) }
    load.start { result ->
      if (loads[key] !== load) return@start
      loads.remove(key)
      val data = result.getOrNull()
      if (data == null) { set(key, Entry(Status.FAILED)); return@start }
      if (photo) {
        decoding.execute {
          val made = decode(data)
          main.post {
            if (made == null) { set(key, Entry(Status.FAILED)); return@post }
            keep(made, key)
            set(key, Entry(Status.READY, 1f))
          }
        }
      } else {
        val kept = data.size <= KEEP_FILE_BYTES
        if (kept) files[key] = data
        set(key, if (kept) Entry(Status.READY, 1f) else Entry())
        then?.invoke(data)
      }
    }
  }

  private fun keep(image: Bitmap, key: String) {
    pictures[key] = image
    pictureOrder.remove(key)
    pictureOrder.add(key)
    while (pictureOrder.size > KEEP_PICTURES) {
      val old = pictureOrder.removeAt(0)
      pictures.remove(old)
      // Shown again later, it is brought again.
      entries.remove(old)
      tried.remove(old)
    }
  }

  /** The photo, decoded and made no bigger than a row needs (1000 px on its longest side). */
  private fun decode(data: ByteArray): Bitmap? = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) null else {
      var sample = 1
      while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1000) sample *= 2
      val image = BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })
      if (image == null) null else {
        val longest = max(image.width, image.height)
        if (longest <= 1000) image else {
          val factor = 1000f / longest
          Bitmap.createScaledBitmap(image, max(1, (image.width * factor).roundToInt()), max(1, (image.height * factor).roundToInt()), true)
        }
      }
    }
  } catch (_: Throwable) { null }

  /** The small picture of a photo, blurred as the reference shows it until the photo is here (`blurRadius 12` at
   *  the size of the tile, `width` in dp). */
  fun blurred(key: String, small: Bitmap, width: Float): Bitmap {
    blurredPreviews[key]?.let { return it }
    val made = try {
      // Made a little bigger first, so that the blur is smooth, then blurred three times over (nearly Gaussian).
      val wide = 96
      val high = max(1, (wide * small.height / max(1, small.width).toFloat()).roundToInt()).coerceAtMost(400)
      val copy = Bitmap.createScaledBitmap(small, wide, high, true).copy(Bitmap.Config.ARGB_8888, true)
      val radius = max(1, (12f * wide / max(1f, width)).roundToInt())
      boxBlur(copy, radius); boxBlur(copy, radius); boxBlur(copy, radius)
      copy
    } catch (_: Throwable) { small }
    if (blurredPreviews.size > 80) blurredPreviews.clear()
    blurredPreviews[key] = made
    return made
  }

  private fun boxBlur(bitmap: Bitmap, radius: Int) {
    val w = bitmap.width; val h = bitmap.height
    val pixels = IntArray(w * h)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
    val out = IntArray(w * h)
    fun pass(source: IntArray, target: IntArray, length: Int, lines: Int, step: Int, lineStep: Int) {
      for (line in 0 until lines) {
        val base = line * lineStep
        for (i in 0 until length) {
          var a = 0; var r = 0; var g = 0; var b = 0; var n = 0
          for (k in -radius..radius) {
            val j = (i + k).coerceIn(0, length - 1)
            val p = source[base + j * step]
            a += p ushr 24; r += (p shr 16) and 0xFF; g += (p shr 8) and 0xFF; b += p and 0xFF; n++
          }
          target[base + i * step] = ((a / n) shl 24) or ((r / n) shl 16) or ((g / n) shl 8) or (b / n)
        }
      }
    }
    pass(pixels, out, w, h, 1, w)
    pass(out, pixels, h, w, w, 1)
    bitmap.setPixels(pixels, 0, w, 0, 0, w, h)
  }

  /** «44 Б · PDF»: the size, then the name's ending in capitals (FileBubble). */
  fun sizeLine(attachment: Map<String, Any?>, sizeText: String): String {
    val name = attachment["name"] as? String ?: ""
    val ending = Regex("\\.([A-Za-z0-9]{1,5})$").find(name)?.groupValues?.get(1)?.uppercase() ?: ""
    return if (ending.isEmpty()) sizeText else "$sizeText · $ending"
  }

  /** The file's icon once it is here (FileBubble `fileIcon`). */
  fun fileIcon(name: String): String {
    val lower = name.lowercase()
    return when {
      Regex("\\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|alac|amr|caf|wma)$").containsMatchIn(lower) -> "ion:musical-notes"
      lower.endsWith("pdf") -> "ion:document-text"
      Regex("\\.(zip|rar|7z|tar|gz)$").containsMatchIn(lower) -> "ion:archive"
      else -> "ion:document"
    }
  }

  /** For the emulator check (src/debug `attachdemo 1`): a photo that is here. */
  fun showReady(key: String, picture: Bitmap) {
    keep(picture, key)
    entries[key] = Entry(Status.READY, 1f)
    tried.add(key)
  }

  /** For the emulator check: a photo or a file on its way. */
  fun showLoading(key: String, progress: Float, size: Long, photo: Boolean) {
    entries[key] = Entry(Status.LOADING, progress, loadingWords(size, progress, photo))
    tried.add(key)
  }
}

/** The drawing of a photo shown whole and of a file's card inside a row of the chat (`MsgRowView` calls it).
 *  Numbers from MessageRow.tsx and MediaBubble.tsx: media up to 300×380 dp and at least 170×74 dp, proportions kept
 *  between 0.45 and 2.2; the button 48 dp on a dark veil (55 %), the size in a pill at the upper left, the time of a
 *  photo alone in a pill (50 %) 8 dp from the lower right corner; a file's button 48 dp in the accent colour, the
 *  name 14 dp semibold on up to two lines, «44 Б · PDF» 12 dp. */
object InlineMediaArt {
  private const val VEIL = 0x8C0A0F1E.toInt()
  private const val TIME_VEIL = 0x800A0F1E.toInt()
  private const val PLATE = 0x523C465F
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val pillFont = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = com.linea.messenger.design.Theme.weight(400) }
  private val nameFont = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = com.linea.messenger.design.Theme.weight(600) }
  private val lineFont = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = com.linea.messenger.design.Theme.weight(400) }
  private val matrix = Matrix()
  private val path = Path()
  private val box = RectF()

  private fun fonts(d: Float) { pillFont.textSize = 11f * d; nameFont.textSize = 14f * d; lineFont.textSize = 12f * d }

  /** MessageRow.tsx `mediaBox` (a photo alone) and `captionedMediaBox` (a photo with words); px, `width` the row's. */
  fun photoSize(row: MsgRow, width: Float, d: Float): Pair<Float, Float> {
    val most = min(300f, width / d - 2 * 36f).roundToInt().toFloat()
    val ratio = row.thumbWide.toFloat().coerceIn(0.45f, 2.2f)
    if (row.text.isNotEmpty()) return Pair(most * d, (most / ratio).coerceIn(120f, 380f).roundToInt() * d)
    var w = most
    var h = w / ratio
    if (h > 380f) { h = 380f; w = h * ratio }
    return Pair(max(170f, w).roundToInt() * d, max(74f, h).roundToInt() * d)
  }

  private fun parts(row: MsgRow): Pair<String, String> {
    val split = row.label.split("\n", limit = 2)
    return Pair(split.firstOrNull()?.takeIf { it.isNotEmpty() } ?: "Файл", if (split.size > 1) split[1] else "")
  }

  private fun nameLayout(name: String, width: Int): StaticLayout =
    StaticLayout.Builder.obtain(name, 0, name.length, nameFont, width.coerceAtLeast(1)).setAlignment(Layout.Alignment.ALIGN_NORMAL)
      .setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).build()

  private fun widest(layout: StaticLayout): Float { var w = 0f; for (i in 0 until layout.lineCount) w = max(w, layout.getLineWidth(i)); return w }

  /** The card of a file: at least 200, at most 270 dp wide (and never wider than the row allows); px. */
  fun fileSize(row: MsgRow, inner: Float, d: Float): Pair<Float, Float> {
    fonts(d)
    val (name, line) = parts(row)
    val room = min(270f * d, inner) - 59f * d
    val laid = nameLayout(name, room.toInt())
    val wide = 59f * d + max(ceil(widest(laid)), ceil(lineFont.measureText(line)))
    val width = min(inner, min(270f * d, max(200f * d, wide)))
    val lineHeight = ceil(lineFont.fontSpacing)
    val textHeight = laid.height + 3f * d + lineHeight
    return Pair(width, max(48f * d, textHeight) + 8f * d)
  }

  /** The ring of what has arrived: a track, and the arc from the top, clockwise. */
  private fun ring(canvas: Canvas, cx: Float, cy: Float, side: Float, progress: Float, color: Int, track: Int, d: Float) {
    val width = 3f * d
    val radius = (side - width) / 2
    stroke.strokeWidth = width; stroke.color = track
    canvas.drawCircle(cx, cy, radius, stroke)
    stroke.color = color
    box.set(cx - radius, cy - radius, cx + radius, cy + radius)
    canvas.drawArc(box, -90f, 360f * progress.coerceIn(0.03f, 1f), false, stroke)
  }

  /** The small marks of the round buttons, in a box of 24 units: ↓, ✕, ↻ and the kinds of files. */
  private fun mark(canvas: Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) {
    // "ion:<name>": the reference's own Ionicons glyph (MediaBubble.tsx <Icon>).
    if (name.startsWith("ion:")) return com.linea.messenger.design.IonIcon.draw(canvas, name.substring(4), cx, cy, size, color)
    stroke.color = color; fill.color = color
    canvas.save()
    canvas.translate(cx - size / 2, cy - size / 2)
    canvas.scale(size / 24f, size / 24f)
    stroke.strokeWidth = 2.2f
    path.reset()
    when (name) {
      "arrow.down" -> { canvas.drawLine(12f, 4f, 12f, 19.5f, stroke); path.moveTo(5.5f, 13.5f); path.lineTo(12f, 20f); path.lineTo(18.5f, 13.5f); canvas.drawPath(path, stroke) }
      "xmark" -> { canvas.drawLine(6f, 6f, 18f, 18f, stroke); canvas.drawLine(18f, 6f, 6f, 18f, stroke) }
      "arrow.clockwise" -> {
        box.set(4.5f, 4.5f, 19.5f, 19.5f); canvas.drawArc(box, -60f, 300f, false, stroke)
        path.moveTo(13.8f, 2.8f); path.lineTo(16.3f, 5.9f); path.lineTo(12.6f, 7.6f); canvas.drawPath(path, stroke)
      }
      "music.note" -> {
        box.set(4.5f, 14f, 11.5f, 20f); canvas.drawOval(box, fill)
        canvas.drawLine(10.6f, 17f, 10.6f, 4.5f, stroke); path.moveTo(10.6f, 4.5f); path.lineTo(18.5f, 3f); path.lineTo(18.5f, 7.5f); path.lineTo(10.6f, 9f); path.close(); canvas.drawPath(path, fill)
      }
      "archivebox.fill" -> {
        canvas.drawRoundRect(3.5f, 4f, 20.5f, 8.5f, 1.2f, 1.2f, fill)
        canvas.drawRoundRect(5f, 9.5f, 19f, 20f, 1.5f, 1.5f, fill)
      }
      else -> {
        // A page with its corner turned; «doc.text.fill» also has lines on it.
        path.moveTo(6f, 3f); path.lineTo(14f, 3f); path.lineTo(19f, 8f); path.lineTo(19f, 21f); path.lineTo(6f, 21f); path.close()
        canvas.drawPath(path, fill)
      }
    }
    canvas.restore()
    if (name == "archivebox.fill" || name == "doc.text.fill" || name == "doc.fill") {
      // The cut-outs in the background's colour are drawn as thin dark lines over the filled shape.
      canvas.save(); canvas.translate(cx - size / 2, cy - size / 2); canvas.scale(size / 24f, size / 24f)
      stroke.color = 0x55000000; stroke.strokeWidth = 1.5f
      when (name) {
        "archivebox.fill" -> canvas.drawLine(10f, 12.5f, 14f, 12.5f, stroke)
        "doc.text.fill" -> { canvas.drawLine(9f, 12f, 16f, 12f, stroke); canvas.drawLine(9f, 15f, 16f, 15f, stroke); canvas.drawLine(9f, 18f, 13.5f, 18f, stroke); path.reset(); path.moveTo(14f, 3f); path.lineTo(14f, 8f); path.lineTo(19f, 8f); canvas.drawPath(path, stroke) }
        else -> { path.reset(); path.moveTo(14f, 3f); path.lineTo(14f, 8f); path.lineTo(19f, 8f); canvas.drawPath(path, stroke) }
      }
      canvas.restore()
    }
  }

  /** A photo in `box` (px): the photo once it is here; before, the blurred small picture (or a quiet plate) with
   *  the round button and the size. `alone`: the time stands in its corner. */
  fun drawPhoto(canvas: Canvas, row: MsgRow, left: Float, top: Float, width: Float, height: Float, palette: MsgPalette, small: Bitmap?, radius: Float, alone: Boolean, d: Float) {
    fonts(d)
    val state = InlineMedia.entry(row.key)
    val full = if (state.status == InlineMedia.Status.READY) InlineMedia.picture(row.key) else null
    fill.color = PLATE
    canvas.drawRoundRect(left, top, left + width, top + height, radius, radius, fill)
    val shown = full ?: small?.let { InlineMedia.blurred(row.key, it, width / d) }
    if (shown != null && shown.width > 0 && shown.height > 0) {
      picture.shader = BitmapShader(shown, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      val scale = max(width / shown.width, height / shown.height)
      matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate(left + (width - shown.width * scale) / 2, top + (height - shown.height * scale) / 2)
      picture.shader?.setLocalMatrix(matrix)
      canvas.drawRoundRect(left, top, left + width, top + height, radius, radius, picture)
      picture.shader = null
    }
    if (full == null) {
      val cx = left + width / 2; val cy = top + height / 2
      fill.color = VEIL
      canvas.drawCircle(cx, cy, 24f * d, fill)
      when (state.status) {
        InlineMedia.Status.LOADING -> {
          ring(canvas, cx, cy, 48f * d, state.progress, 0xFFFFFFFF.toInt(), 0x40FFFFFF, d)
          mark(canvas, "ion:close", cx, cy, 22f * d, 0xFFFFFFFF.toInt())
        }
        InlineMedia.Status.FAILED, InlineMedia.Status.READY -> mark(canvas, "ion:refresh", cx, cy, 24f * d, 0xFFFFFFFF.toInt())
        InlineMedia.Status.IDLE -> mark(canvas, "ion:arrow-down", cx, cy, 24f * d, 0xFFFFFFFF.toInt())
      }
      // A photo row keeps the photo's size in `mediaTime` («2 КБ»).
      val words = if (state.status == InlineMedia.Status.LOADING) state.words else row.mediaTime
      if (words.isNotEmpty()) {
        pillFont.color = 0xFFFFFFFF.toInt()
        val textW = ceil(pillFont.measureText(words)); val textH = ceil(pillFont.fontSpacing)
        val pl = left + 7f * d; val pt = top + 7f * d
        fill.color = VEIL
        canvas.drawRoundRect(pl, pt, pl + textW + 12f * d, pt + textH + 6f * d, 8f * d, 8f * d, fill)
        canvas.drawText(words, pl + 6f * d, pt + 3f * d - pillFont.ascent(), pillFont)
      }
    }
    if (alone) timePill(canvas, row, left + width, top + height, palette, d)
  }

  /** The time of a photo alone: white in a dark pill 8 dp from the lower right corner, with the ticks of one's own. */
  /** A video's poster (the small picture that came with it, unblurred) on the quiet plate (MediaBubble.tsx `MediaTile`). */
  fun drawVideo(canvas: Canvas, row: MsgRow, left: Float, top: Float, width: Float, height: Float, palette: MsgPalette, small: Bitmap?, radius: Float, d: Float) {
    fonts(d)
    fill.color = PLATE
    canvas.drawRoundRect(left, top, left + width, top + height, radius, radius, fill)
    if (small != null && small.width > 0 && small.height > 0) {
      picture.shader = BitmapShader(small, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      val scale = max(width / small.width, height / small.height)
      matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate(left + (width - small.width * scale) / 2, top + (height - small.height * scale) / 2)
      picture.shader?.setLocalMatrix(matrix)
      canvas.drawRoundRect(left, top, left + width, top + height, radius, radius, picture)
      picture.shader = null
    }
  }

  fun timePill(canvas: Canvas, row: MsgRow, right: Float, bottom: Float, palette: MsgPalette, d: Float) {
    fonts(d)
    val color = if (row.ticks == 4) palette.danger else 0xFFFFFFFF.toInt()
    pillFont.color = color
    val timeW = ceil(pillFont.measureText(row.time)); val timeH = ceil(pillFont.fontSpacing)
    val marks = if (row.mine && row.ticks > 0) 19f * d else 0f
    val bell = if (row.silent) 15f * d else 0f
    val pw = timeW + 14f * d + marks + bell; val ph = timeH + 4f * d
    val pl = right - 8f * d - pw; val pt = bottom - 8f * d - ph
    fill.color = TIME_VEIL
    canvas.drawRoundRect(pl, pt, pl + pw, pt + ph, 10f * d, 10f * d, fill)
    val my = pt + ph / 2
    var x = pl + 7f * d
    if (row.silent) { com.linea.messenger.design.Symbols.draw(canvas, "bell.slash.fill", x + 5f * d, my, 11f * d, 0xFFFFFFFF.toInt()); x += 15f * d }
    canvas.drawText(row.time, x, my - (pillFont.ascent() + pillFont.descent()) / 2, pillFont)
    if (marks <= 0f) return
    val bx = x + timeW + 4f * d
    stroke.color = color
    path.reset()
    if (row.ticks == 1 || row.ticks == 2) {
      stroke.strokeWidth = 1.5f * d
      path.moveTo(bx, my); path.lineTo(bx + 3.5f * d, my + 3.5f * d); path.lineTo(bx + 10f * d, my - 4f * d)
      if (row.ticks == 2) { path.moveTo(bx + 5f * d, my + 1.5f * d); path.lineTo(bx + 7f * d, my + 3.5f * d); path.lineTo(bx + 13.5f * d, my - 4f * d) }
      canvas.drawPath(path, stroke)
    } else {
      stroke.strokeWidth = 1.4f * d
      val cx = bx + 6f * d
      canvas.drawCircle(cx, my, 5f * d, stroke)
      path.moveTo(cx, my - 2.5f * d); path.lineTo(cx, my)
      if (row.ticks == 3) path.lineTo(cx + 2f * d, my + 1f * d)
      canvas.drawPath(path, stroke)
    }
  }

  /** A file's card in its box (px): the round button, the name, the size line (or the progress, or the failure). */
  fun drawFile(canvas: Canvas, row: MsgRow, left: Float, top: Float, width: Float, height: Float, palette: MsgPalette, d: Float) {
    fonts(d)
    val state = InlineMedia.entry(row.key)
    val (name, sizeLine) = parts(row)
    val cx = left + 24f * d; val cy = top + height / 2
    fill.color = palette.accent
    canvas.drawCircle(cx, cy, 24f * d, fill)
    when (state.status) {
      InlineMedia.Status.LOADING -> {
        ring(canvas, cx, cy, 48f * d, state.progress, palette.onAccent, 0x4DFFFFFF, d)
        mark(canvas, "ion:close", cx, cy, 20f * d, palette.onAccent)
      }
      InlineMedia.Status.READY -> mark(canvas, InlineMedia.fileIcon(name), cx, cy, 22f * d, palette.onAccent)
      InlineMedia.Status.FAILED -> mark(canvas, "ion:refresh", cx, cy, 22f * d, palette.onAccent)
      InlineMedia.Status.IDLE -> mark(canvas, "ion:arrow-down", cx, cy, 22f * d, palette.onAccent)
    }
    val textX = left + 59f * d
    val room = left + width - textX
    nameFont.color = palette.text
    val laid = nameLayout(name, room.toInt())
    var lineColor = palette.muted
    val line = when (state.status) {
      InlineMedia.Status.LOADING -> state.words
      InlineMedia.Status.FAILED -> { lineColor = palette.danger; "Ошибка · нажми, чтобы повторить" }
      else -> sizeLine
    }
    val lineHeight = ceil(lineFont.fontSpacing)
    val textTop = cy - (laid.height + 3f * d + lineHeight) / 2
    canvas.save(); canvas.translate(textX, textTop); laid.draw(canvas); canvas.restore()
    lineFont.color = lineColor
    val shown = TextUtils.ellipsize(line, lineFont, room, TextUtils.TruncateAt.END)
    canvas.drawText(shown, 0, shown.length, textX, textTop + laid.height + 3f * d - lineFont.ascent(), lineFont)
  }
}
