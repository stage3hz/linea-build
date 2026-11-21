package com.linea.messenger.attachments

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

/** Media: the numbers and rules of the photo editor (the reference's photo/editor/editorModel.ts, editorHistory.ts and
 *  PhotoDimensions, as native/ios/Sources/Attachments/PhotoEditor.swift has them): plain values, so they can be
 *  checked without a phone. Everything is normalized (0…1) to the picture as it stands on screen (turned and mirrored). */
object PhotoEditModel {
  data class Point(val x: Double, val y: Double)
  data class Box(val x: Double, val y: Double, val width: Double, val height: Double) {
    val right get() = x + width
    val bottom get() = y + height
  }

  /** The pen («Рисование»): colour 0xRRGGBB, width as a share of the shorter side. */
  data class Stroke(val color: Int, val width: Double, val points: List<Point>)
  /** The brush of «Убрать объект»: radius as a share of the picture's shorter side. */
  data class Mask(val radius: Double, val points: List<Point>)

  /** One state of the edit (the reference's EditState). */
  data class Edit(
    val rotation: Int = 0,
    val flip: Boolean = false,
    /** null: the whole picture. */
    val crop: Box? = null,
    val strokes: List<Stroke> = emptyList(),
    val masks: List<Mask> = emptyList(),
    /** keep · transparent · white */
    val background: String = "keep",
    /** none · bw · color */
    val document: String = "none",
    /** 1, 2 or 4. */
    val scale: Int = 1,
    /** png · jpeg */
    val format: String = "png",
    /** 1 or 0.5. */
    val resolution: Double = 1.0,
  )

  class Aspect(val label: String, val spoken: String, val value: Double?)
  class Choice(val label: String, val value: Double)
  class Tab(val id: String, val symbol: String, val label: String)

  val penColors = intArrayOf(0xFFFFFF, 0x111111, 0xFF3B30, 0xFF9500, 0xFFCC00, 0x34C759, 0x0A84FF, 0xAF52DE)
  val colorNames = listOf("Белый", "Чёрный", "Красный", "Оранжевый", "Жёлтый", "Зелёный", "Синий", "Фиолетовый")
  val penWidths = listOf(Choice("Тонкая", 0.006), Choice("Средняя", 0.012), Choice("Широкая", 0.024))
  val brushRadii = listOf(Choice("Тонкая", 0.008), Choice("Средняя", 0.02), Choice("Широкая", 0.05))
  val aspects = listOf(Aspect("Свободно", "Свободная обрезка", null), Aspect("1:1", "Квадрат", 1.0), Aspect("4:3", "Четыре к трём", 4.0 / 3.0),
    Aspect("3:4", "Три к четырём", 3.0 / 4.0), Aspect("16:9", "Шестнадцать к девяти", 16.0 / 9.0))
  /** The reference's TABS. */
  val tabs = listOf(Tab("crop", "crop", "Обрезка"), Tab("draw", "brush", "Рисование"), Tab("remove", "bandage", "Убрать объект"),
    Tab("background", "photo", "Фон"), Tab("enhance", "sparkles", "Улучшить"), Tab("size", "resize", "Размер и формат"))
  /** The reference's MAX_STROKES / MAX_STROKE_POINTS and HISTORY_LIMIT. */
  const val maxMasks = 64
  const val maxMaskPoints = 1024
  const val historyLimit = 51

  /** The history of edits: undo, redo, at most 51 kept. */
  class History {
    var states: List<Edit> = listOf(Edit()); private set
    var at = 0; private set
    val shown: Edit get() = states[at]
    val canUndo get() = at > 0
    val canRedo get() = at + 1 < states.size

    /** False when nothing changed. */
    fun commit(next: Edit): Boolean {
      if (next == shown) return false
      var list = states.take(at + 1) + next
      if (list.size > historyLimit) list = list.drop(list.size - historyLimit)
      states = list
      at = list.size - 1
      return true
    }
    fun undo(): Boolean { if (!canUndo) return false; at -= 1; return true }
    fun redo(): Boolean { if (!canRedo) return false; at += 1; return true }
  }

  /** The reference's `centeredCrop`: the largest frame of that shape in the middle. */
  fun centered(aspect: Double, turnedWidth: Double, turnedHeight: Double): Box {
    val sourceAspect = turnedWidth / maxOf(1.0, turnedHeight)
    val width = minOf(1.0, aspect / sourceAspect); val height = minOf(1.0, sourceAspect / aspect)
    return Box((1 - width) / 2, (1 - height) / 2, width, height)
  }

  /** The reference's `rotated`: a quarter turn to the left on screen; the frame, lines and painted areas turn too. */
  fun rotated(edit: Edit): Edit {
    val turn = { p: Point -> Point(p.y, 1 - p.x) }
    return edit.copy(
      rotation = ((edit.rotation + (if (edit.flip) 90 else -90)) % 360 + 360) % 360,
      crop = edit.crop?.let { Box(it.y, 1 - it.x - it.width, it.height, it.width) },
      strokes = edit.strokes.map { it.copy(points = it.points.map(turn)) },
      masks = edit.masks.map { it.copy(points = it.points.map(turn)) },
    )
  }

  /** The reference's `flipped`: a mirror across the screen's vertical axis. */
  fun flipped(edit: Edit): Edit {
    val mirror = { p: Point -> Point(1 - p.x, p.y) }
    return edit.copy(
      flip = !edit.flip,
      crop = edit.crop?.let { Box(1 - it.x - it.width, it.y, it.width, it.height) },
      strokes = edit.strokes.map { it.copy(points = it.points.map(mirror)) },
      masks = edit.masks.map { it.copy(points = it.points.map(mirror)) },
    )
  }

  /** The reference's withStroke limit: at most 64 areas and 1024 points in all. */
  fun maskFits(edit: Edit, mask: Mask): Boolean {
    val used = edit.masks.sumOf { it.points.size }
    return mask.points.isNotEmpty() && edit.masks.size < maxMasks && used + mask.points.size <= maxMaskPoints
  }

  /** «Без фона» / «Белый» / «Исходный». */
  fun withBackground(edit: Edit, background: String): Edit = when (background) {
    "transparent" -> edit.copy(background = "transparent", document = "none", format = "png")
    "white" -> edit.copy(background = "white", document = "none")
    else -> edit.copy(background = "keep")
  }

  fun withDocument(edit: Edit, document: String): Edit = if (document != "none") edit.copy(document = document, background = "keep") else edit.copy(document = "none")

  /** JPEG is not offered with a transparent background: null then. */
  fun withFormat(edit: Edit, format: String): Edit? = if (format == "jpeg" && edit.background == "transparent") null else edit.copy(format = format)

  /** The effects that need the pixels (the reference's `effectKey`); null: none. */
  fun effectKey(edit: Edit): String? {
    if (edit.background == "keep" && edit.document == "none" && edit.masks.isEmpty()) return null
    val masks = edit.masks.joinToString("|") { mask -> "${mask.radius}:" + mask.points.joinToString(";") { "${it.x},${it.y}" } }
    return "${edit.rotation}/${edit.flip}/${edit.background}/${edit.document}/$masks"
  }

  class Plan(val cropLeft: Int, val cropTop: Int, val cropWidth: Int, val cropHeight: Int, val width: Int, val height: Int, val baseWidth: Int, val baseHeight: Int, val downsampled: Boolean)

  /** The reference's PhotoDimensions.fit. */
  fun fit(width: Int, height: Int, limit: Int): Pair<Int, Int> {
    if (width <= 0 || height <= 0 || width > 20000 || height > 20000 || width.toLong() * height > 100_000_000L) throw PhotoFailure("IMAGE_TOO_LARGE")
    val pixels = width.toLong() * height
    if (pixels <= limit) return width to height
    val scale = sqrt(limit.toDouble() / pixels.toDouble())
    return maxOf(1, floor(width * scale).toInt()) to maxOf(1, floor(height * scale).toInt())
  }

  /** The reference's PhotoDimensions.plan for this picture (pixel limits of PhotoOptions). */
  fun plan(turnedWidth: Int, turnedHeight: Int, edit: Edit): Plan {
    val width = maxOf(1, turnedWidth); val height = maxOf(1, turnedHeight)
    var left = 0; var top = 0; var cropWidth = width; var cropHeight = height
    edit.crop?.let { selected ->
      left = floor(selected.x * width).toInt().coerceIn(0, width - 1)
      top = floor(selected.y * height).toInt().coerceIn(0, height - 1)
      val right = maxOf(left + 1, minOf(width, ceil(selected.right * width).toInt()))
      val bottom = maxOf(top + 1, minOf(height, ceil(selected.bottom * height).toInt()))
      cropWidth = right - left; cropHeight = bottom - top
    }
    val requestedWidth = maxOf(1, floor(cropWidth * edit.resolution).toInt())
    val requestedHeight = maxOf(1, floor(cropHeight * edit.resolution).toInt())
    val plain = edit.background == "keep" && edit.document == "none" && edit.scale == 1 && edit.masks.isEmpty()
    val limit = if (plain) 16_000_000 else minOf(4_000_000, 8_000_000 / (edit.scale * edit.scale))
    val fitted = try { fit(requestedWidth, requestedHeight, limit) } catch (_: PhotoFailure) { requestedWidth to requestedHeight }
    val downsampled = fitted.first != requestedWidth || fitted.second != requestedHeight
    return Plan(left, top, cropWidth, cropHeight, fitted.first * edit.scale, fitted.second * edit.scale, fitted.first, fitted.second, downsampled)
  }

  /** «Результат: 1200 × 800 · PNG. EXIF, GPS и личные метаданные удаляются.» */
  fun resultWords(plan: Plan, edit: Edit): String =
    "Результат: ${plan.width} × ${plan.height} · ${if (edit.format == "jpeg") "JPEG" else "PNG"}${if (plan.downsampled) " · фото будет уменьшено" else ""}. EXIF, GPS и личные метаданные удаляются."

  /** The reference's `cropFromDrag` (and a fixed shape kept inside the drag); null: too small. */
  fun frame(start: Point, end: Point, aspect: Double?, turnedWidth: Double, turnedHeight: Double): Box? {
    var x = minOf(start.x, end.x); var y = minOf(start.y, end.y)
    var width = minOf(1.0, maxOf(start.x, end.x)) - x
    var height = minOf(1.0, maxOf(start.y, end.y)) - y
    if (aspect != null && width > 0 && height > 0) {
      val wanted = aspect * turnedHeight / turnedWidth
      if (width / height > wanted) width = height * wanted else height = width / wanted
      if (end.x < start.x) x = start.x - width
      if (end.y < start.y) y = start.y - height
    }
    if (width < 0.01 || height < 0.01) return null
    return Box(x, y, width, height)
  }
}
