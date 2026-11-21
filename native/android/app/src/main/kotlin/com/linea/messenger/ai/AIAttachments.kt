package com.linea.messenger.ai

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** A picture ready to send: a small cleaned JPEG (no EXIF / GPS) as a data URL, and its preview. */
class AIPicture(val id: String, val preview: Bitmap, val data: String, val video: Boolean = false)

/** How a photo or a video becomes pictures for the model (ai/attach.ts; iOS AI/AIViewController.swift, `AIAttach`): a
 *  photo is re-encoded as JPEG (longest side at most 1280, quality .8 — which drops the metadata), a video becomes three
 *  frames (beginning, middle, end). Everything here runs off the main thread. */
object AIAttach {
  const val MAX_PICTURES = 8
  const val MAX_DOCUMENT = 15 * 1024 * 1024
  const val MEDIA_AS_DOCUMENT = "Фото и видео прикрепляй кнопкой «Фото и видео»: модель получит копию без метаданных (места съёмки, даты, модели камеры)."

  /** The largest side a picture keeps. */
  fun fitted(width: Int, height: Int, edge: Int = 1280): Pair<Int, Int> {
    val longest = max(width, height)
    if (longest <= edge) return width to height
    val scale = edge.toDouble() / longest
    return (width * scale).roundToInt() to (height * scale).roundToInt()
  }

  /** A data URL of a JPEG at most 1280 on its longest side; the decoded bitmap carries no metadata. */
  fun jpeg(image: Bitmap): Pair<String, Bitmap> {
    val (w, h) = fitted(image.width, image.height)
    val small = if (w == image.width && h == image.height) image else Bitmap.createScaledBitmap(image, w, h, true)
    val out = ByteArrayOutputStream()
    if (!small.compress(Bitmap.CompressFormat.JPEG, 80, out)) throw AIFailure("Не удалось подготовить фото.")
    val text = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    if (text.length > 5_000_000) throw AIFailure("Фото слишком большое для вопроса.")
    return ("data:image/jpeg;base64,$text") to small
  }

  /** A photo of the system's chooser, turned upright (the decoder applies the orientation) and kept small. */
  fun photo(context: Context, uri: Uri): Bitmap? = try {
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
      val (w, h) = fitted(info.size.width, info.size.height, 2560)
      decoder.setTargetSize(w, h)
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
  } catch (_: Exception) { try { context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } } catch (_: Exception) { null } }

  /** Frames of a video at 10 %, 50 % and 90 % of its length (or its first frame). */
  fun frames(context: Context, uri: Uri): List<Bitmap> {
    val reader = MediaMetadataRetriever()
    return try {
      reader.setDataSource(context, uri)
      val length = (reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000.0
      val stops = if (length > 1) listOf(length * 0.1, length * 0.5, length * 0.9) else listOf(0.0)
      stops.mapNotNull { reader.getFrameAtTime((it * 1_000_000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST_SYNC) }
    } catch (_: Exception) { emptyList() } finally { try { reader.release() } catch (_: Exception) {} }
  }

  /** The name and the type of a chosen file. */
  fun describe(context: Context, uri: Uri): Pair<String, String> {
    var name = "файл"
    try { context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0)?.takeIf { n -> n.isNotEmpty() }?.let { n -> name = n.take(150) } } } catch (_: Exception) {}
    return name to (context.contentResolver.getType(uri) ?: "")
  }

  /** At most `limit` bytes of a file; null when it is larger or cannot be read (the second value: it was too large). */
  fun bytes(context: Context, uri: Uri, limit: Int): Pair<ByteArray?, Boolean> {
    try {
      context.contentResolver.openInputStream(uri)?.use { stream ->
        val out = ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        while (true) {
          val got = stream.read(chunk)
          if (got < 0) break
          if (out.size() + got > limit) return null to true
          out.write(chunk, 0, got)
        }
        return (if (out.size() > 0) out.toByteArray() else null) to false
      }
    } catch (_: Exception) {}
    return null to false
  }
}

/** The strip of attachments above the question: the pictures (a mark on video frames, a cross to take one away), the
 *  documents read into text, and «Читаю документ…» while the server reads one. */
class AIAttachmentStrip(context: Context) : HorizontalScrollView(context) {
  var onRemovePicture: ((String) -> Unit)? = null
  var onRemoveDocument: ((String) -> Unit)? = null
  private val row = LinearLayout(context)
  private val d = resources.displayMetrics.density

  init {
    isHorizontalScrollBarEnabled = false
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(context.px(4f), context.px(4f), context.px(4f), 0)
    addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, context.px(62f)))
  }

  fun show(pictures: List<AIPicture>, documents: List<AIDocumentText>, reading: Int) {
    row.removeAllViews()
    fun put(view: View, width: Int) = row.addView(view, LinearLayout.LayoutParams(width, context.px(58f)).apply { if (row.childCount > 0) leftMargin = context.px(8f) })
    for (item in pictures) {
      val box = FrameLayout(context)
      val face = ImageView(context).apply {
        setImageBitmap(item.preview); scaleType = ImageView.ScaleType.CENTER_CROP
        background = context.plate(Theme.surface2, 12f); clipToOutline = true
      }
      box.addView(face, FrameLayout.LayoutParams(context.px(54f), context.px(54f)).apply { topMargin = context.px(4f) })
      if (item.video) {
        val mark = AIIconView(context, "play", 9f, 0xFFFFFFFF.toInt()).apply { background = context.plate(0x8C000000.toInt(), 6f) }
        box.addView(mark, FrameLayout.LayoutParams(context.px(20f), context.px(13f)).apply { leftMargin = context.px(4f); topMargin = context.px(42f) })
      }
      val remove = AIIconButton(context, "xmark", 9f, if (Theme.dark) 0xFF111111.toInt() else 0xFFFFFFFF.toInt(), "Убрать").apply { background = context.plate(Theme.text, 10f) }
      remove.setOnClickListener { onRemovePicture?.invoke(item.id) }
      box.addView(remove, FrameLayout.LayoutParams(context.px(20f), context.px(20f)).apply { leftMargin = context.px(39f) })
      put(box, context.px(60f))
    }
    for (doc in documents) {
      val chip = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; background = context.plate(Theme.surface2, 12f); setPadding(context.px(10f), 0, context.px(6f), 0) }
      chip.addView(AIIconView(context, "doc", 17f, Theme.accent), LinearLayout.LayoutParams(context.px(20f), context.px(20f)))
      val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
      words.addView(AIKit.label(context, doc.name, 13f, 600, lines = 1))
      words.addView(AIKit.label(context, (doc.pages?.let { "$it стр. · " } ?: "") + (if (doc.truncated) "прочитано начало" else "прочитан"), 10f, color = Theme.muted, lines = 1))
      chip.addView(words, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(7f); rightMargin = context.px(7f) })
      val remove = AIIconButton(context, "xmark", 12f, Theme.muted, "Убрать документ ${doc.name}")
      remove.setOnClickListener { onRemoveDocument?.invoke(doc.name) }
      chip.addView(remove, LinearLayout.LayoutParams(context.px(28f), context.px(28f)))
      chip.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(context.px(54f), MeasureSpec.EXACTLY))
      put(chip, minOf(chip.measuredWidth, context.px(220f)))
    }
    if (reading > 0) {
      val chip = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; background = context.plate(Theme.surface2, 12f); setPadding(context.px(12f), 0, context.px(12f), 0) }
      chip.addView(AIKit.spinner(context), LinearLayout.LayoutParams(context.px(18f), context.px(18f)))
      chip.addView(AIKit.label(context, "Читаю документ…", 12f, color = Theme.muted, lines = 1), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(7f) })
      put(chip, LinearLayout.LayoutParams.WRAP_CONTENT)
    }
  }

  val empty: Boolean get() = row.childCount == 0
}

/** The emulator check's samples for AI (`--es aidemo photo|quick`, music/MusicDemo.kt). */
object AIParity {
  /** Two drawn pictures (a video frame among them) and a document above «Сделай из этого аниме»; or the quick dialog. */
  fun demo(screen: AIScreen, kind: String) {
    if (kind == "quick") return screen.openQuick()
    fun drawn(a: Int, b: Int): Bitmap {
      val made = Bitmap.createBitmap(120, 120, Bitmap.Config.ARGB_8888)
      val paint = Paint().apply { shader = LinearGradient(0f, 0f, 120f, 120f, 0xFF000000.toInt() or a, 0xFF000000.toInt() or b, Shader.TileMode.CLAMP) }
      Canvas(made).drawRect(0f, 0f, 120f, 120f, paint)
      return made
    }
    screen.demoAttachments(listOf(AIPicture("demo-1", drawn(0x2F5BE0, 0x58B7F2), ""), AIPicture("demo-2", drawn(0x0E7C66, 0x2BD4A0), "", video = true)),
      listOf(AIDocumentText("Отчёт.pdf", "", pages = 12)), "Сделай из этого аниме")
  }
}
