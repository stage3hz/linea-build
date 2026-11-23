package com.linea.messenger.chats

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.LinearGradient
import android.graphics.Shader
import android.graphics.SweepGradient
import android.util.Base64
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View

/** One row, drawn on the canvas in a single pass (no child views): avatar, title, time, two lines of preview,
 *  unread badge, ticks and the «Изм.» circle. Layout of the texts is rebuilt only when the row or the width changes. */
class ChatRowView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val orb = Paint(Paint.ANTI_ALIAS_FLAG)
  private val sectionPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d; typeface = com.linea.messenger.design.Theme.weight(700); letterSpacing = 0.12f }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
  // ChatsPlus: Montserrat, as the reference's row (design/Fonts.kt): the name 16 semibold, the line 15, the time 13.
  private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 16f * d; typeface = com.linea.messenger.design.Theme.weight(600) }
  private val previewPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 15f * d; typeface = com.linea.messenger.design.Theme.weight(400) }
  private val timePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13f * d; typeface = com.linea.messenger.design.Theme.weight(400) }
  private val badgePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = com.linea.messenger.design.Theme.weight(700); textAlign = Paint.Align.CENTER }
  private val avatarPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 21f * d; typeface = com.linea.messenger.design.Theme.weight(700); textAlign = Paint.Align.CENTER; color = 0xFFFFFFFF.toInt() }
  private val path = Path()
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val matrix = Matrix()
  private val dst = android.graphics.RectF()
  // The avatar's shader, kept in its own field while the picture stays: the `picture` paint is shared with the
  // nameplate and the thumbnail, which reset its shader — keeping the avatar's shader only on the paint made a row
  // with a nameplate draw its photo with no shader at all (a solid black circle) from its second frame on.
  private var shaderOf: Bitmap? = null
  private var faceShader: BitmapShader? = null
  private var thumbOf = ""
  private var thumb: Bitmap? = null

  /** `bitmap` centre-cropped into the rounded rectangle (x, y, side, side). */
  private fun drawPicture(canvas: Canvas, bitmap: Bitmap, x: Float, y: Float, side: Float, radius: Float, own: Boolean) {
    val shader = if (own && shaderOf === bitmap && faceShader != null) faceShader!!
      else BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).also { if (own) { faceShader = it; shaderOf = bitmap } }
    val scale = maxOf(side / bitmap.width, side / bitmap.height)
    matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate(x + (side - bitmap.width * scale) / 2, y + (side - bitmap.height * scale) / 2)
    shader.setLocalMatrix(matrix)
    picture.shader = shader
    canvas.drawRoundRect(x, y, x + side, y + side, radius, radius, picture)
    picture.shader = null
  }

  private var row: ChatRow? = null
  private var palette = ChatPalette.DARK
  private var title: CharSequence = ""
  private var preview: StaticLayout? = null
  private var builtFor: ChatRow? = null
  private var builtWidth = 0

  /** Sideways shift under a finger, px: above zero the `lead` buttons show on the left, below zero `trail` on the right. */
  var swipeX = 0f
    set(value) { if (field != value) { field = value; invalidate() } }
  private val actionPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = com.linea.messenger.design.Theme.weight(700); textAlign = Paint.Align.CENTER; color = 0xFFFFFFFF.toInt() }
  val rowId: String get() = row?.id ?: ""
  fun buttons(side: Int): List<String> = (if (side > 0) row?.lead else row?.trail).orEmpty()
  /** How far the row rests when its buttons are open. */
  fun buttonsWidth(side: Int) = buttons(side).size * BUTTON_DP * d
  /** The action of the button under `x` while the row is shifted; null = the row itself. */
  fun actionAt(x: Float): String? {
    if (swipeX == 0f) return null
    val specs = buttons(if (swipeX > 0) 1 else -1); if (specs.isEmpty()) return null
    val each = Math.abs(swipeX) / specs.size
    val index = if (swipeX > 0) { if (x > swipeX) return null; (x / each).toInt() } else { if (x < width + swipeX) return null; ((width - x) / each).toInt() }
    return specs.getOrNull(index.coerceIn(0, specs.size - 1))?.substringBefore(':')
  }
  private fun drawButtons(canvas: Canvas) {
    val side = if (swipeX > 0) 1 else -1; val specs = buttons(side); if (specs.isEmpty()) return
    val each = Math.abs(swipeX) / specs.size; val h = height.toFloat()
    specs.forEachIndexed { i, spec ->
      val name = spec.substringBefore(':'); val label = spec.substringAfter(':', name)
      val l = if (side > 0) i * each else width - (i + 1) * each
      fill.color = when (name) { "delete" -> 0xFFE5484D.toInt(); "archive", "unarchive" -> 0xFF7B8497.toInt(); "mute", "unmute" -> 0xFFF29D38.toInt(); else -> 0xFF3B82F6.toInt() }
      canvas.drawRect(l, 0f, l + each + 1f, h, fill)
      canvas.save(); canvas.clipRect(l, 0f, l + each, h)
      canvas.drawText(label, l + each / 2, h / 2 - (actionPaint.descent() + actionPaint.ascent()) / 2, actionPaint)
      canvas.restore()
    }
  }
  override fun onDraw(canvas: Canvas) {
    if (swipeX == 0f) { drawRow(canvas); return }
    drawButtons(canvas)
    canvas.save(); canvas.translate(swipeX, 0f)
    fill.color = palette.bg; canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fill)
    drawRow(canvas); canvas.restore()
  }

  fun bind(next: ChatRow, colors: ChatPalette) {
    if (row == next && palette == colors) return
    if (row?.id != next.id) swipeX = 0f
    val taller = row?.section.isNullOrEmpty() != next.section.isEmpty()
    row = next; palette = colors; contentDescription = next.title + ". " + next.preview
    if (taller) requestLayout()
    if (next.thumb != thumbOf) {
      thumbOf = next.thumb
      thumb = if (next.thumb.isEmpty()) null else try { val bytes = Base64.decode(next.thumb, Base64.DEFAULT); BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } catch (_: Throwable) { null }
    }
    invalidate()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    // A row that opens a part of the list is taller by its heading.
    setMeasuredDimension(MeasureSpec.getSize(widthSpec), ((ROW_DP + if (row?.section.isNullOrEmpty()) 0f else SECTION_DP) * d).toInt())
  }

  override fun drawableStateChanged() { super.drawableStateChanged(); invalidate() }

  private fun build(item: ChatRow, textWidth: Int, titleWidth: Float) {
    title = TextUtils.ellipsize(item.title, titlePaint, titleWidth.coerceAtLeast(0f), TextUtils.TruncateAt.END)
    val width = textWidth.coerceAtLeast(1)
    // The word «Черновик:» of a draft is red.
    val line: CharSequence = if (item.previewRed > 0 && item.preview.isNotEmpty())
      android.text.SpannableString(item.preview).apply { setSpan(android.text.style.ForegroundColorSpan(palette.danger), 0, minOf(item.previewRed, length), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
      // The reference draws a line this device cannot open like any other line (no italic, no lock).
      else item.preview
    preview = StaticLayout.Builder.obtain(line, 0, line.length, previewPaint, width)
      .setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).build()
    builtFor = item; builtWidth = this.width
  }

  private fun drawRow(canvas: Canvas) {
    val item = row ?: return
    val top = if (item.section.isEmpty()) 0f else SECTION_DP * d
    if (top == 0f) { drawBody(canvas, item, height.toFloat()); return }
    sectionPaint.color = palette.subtle
    canvas.drawText(item.section.uppercase(), 18f * d, top - 8f * d, sectionPaint)
    canvas.save(); canvas.translate(0f, top)
    drawBody(canvas, item, height.toFloat() - top)
    canvas.restore()
  }

  private fun drawBody(canvas: Canvas, item: ChatRow, h: Float) {
    val w = width.toFloat()
    // Pinned chats stand on a slightly different ground than the rest of the list.
    if (item.pinned) { fill.color = palette.pinned; canvas.drawRect(0f, 0f, w, h, fill) }
    if (item.selected || isPressed) { fill.color = if (item.selected) palette.selected else palette.pressed; canvas.drawRect(0f, 0f, w, h, fill) }

    // The nameplate: a picture behind the whole row (right-aligned, cropped to fill), darkened towards the name.
    val plate = if (item.plate.isEmpty()) null else DecorStore.plates[item.plate]
    if (plate != null) {
      val l = 10f * d; val t = 3f * d; val r = w - 10f * d; val b = h - 3f * d; val rad = 20f * d
      val scale = maxOf((r - l) / plate.width, (b - t) / plate.height)
      picture.shader = BitmapShader(plate, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate(r - plate.width * scale, t + ((b - t) - plate.height * scale) / 2)
      picture.shader?.setLocalMatrix(matrix); canvas.drawRoundRect(l, t, r, b, rad, rad, picture); picture.shader = null
      fill.shader = LinearGradient(l, 0f, r, 0f, intArrayOf(0x9E000000.toInt(), 0x52000000, 0x0D000000), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
      fill.color = 0xFFFFFFFF.toInt(); canvas.drawRoundRect(l, t, r, b, rad, rad, fill); fill.shader = null
      stroke.color = 0x29FFFFFF; stroke.strokeWidth = maxOf(1f, d / 2); canvas.drawRoundRect(l, t, r, b, rad, rad, stroke)
    }
    val textColor = if (plate != null) 0xFFFFFFFF.toInt() else palette.text
    val mutedColor = if (plate != null) 0xCCFFFFFF.toInt() else palette.muted

    var x = 16f * d
    if (item.checked >= 0) {
      val cx = x + 12f * d; val cy = h / 2
      if (item.checked == 1) {
        fill.color = palette.accent; canvas.drawCircle(cx, cy, 11f * d, fill)
        stroke.color = palette.onAccent; stroke.strokeWidth = 2f * d
        path.reset(); path.moveTo(cx - 5f * d, cy); path.lineTo(cx - 1.5f * d, cy + 3.5f * d); path.lineTo(cx + 5f * d, cy - 3.5f * d); canvas.drawPath(path, stroke)
      } else { stroke.color = palette.subtle; stroke.strokeWidth = 1.6f * d; canvas.drawCircle(cx, cy, 10.5f * d, stroke) }
      x += 36f * d
    }

    val avatar = 60f * d
    // The avatar is a circle (the owner's choice, 18 Nov 2026; it was a rounded square before).
    val avatarTop = (h - avatar) / 2
    val art = if (item.deco.isEmpty()) null else DecorStore.art(context, item.deco)
    // As DecoratedAvatar does at list sizes: a ring is drawn inside the box (the photo shrinks a little); under an
    // art decoration the photo is a circle, and it shrinks so the art reaches at most 1.3× the box.
    var photo = avatar; var photoX = x; var photoY = avatarTop; var corner = avatar * 0.5f
    if (art != null) {
      photo = if (item.decoScale > 1.3) avatar * 1.3f / item.decoScale.toFloat() else avatar
      photoX = x + (avatar - photo) / 2; photoY = avatarTop + (avatar - photo) / 2; corner = photo / 2
    } else if (item.ring.size >= 2) {
      val ring = 3f * d; val gap = 2f * d
      fill.shader = SweepGradient(x + avatar / 2, h / 2, item.ring.toIntArray(), null)
      fill.color = 0xFFFFFFFF.toInt(); canvas.drawRoundRect(x, avatarTop, x + avatar, avatarTop + avatar, avatar * 0.5f, avatar * 0.5f, fill); fill.shader = null
      val inside = avatar - 2 * ring
      fill.color = palette.bg; canvas.drawRoundRect(x + ring, avatarTop + ring, x + ring + inside, avatarTop + ring + inside, inside * 0.5f, inside * 0.5f, fill)
      photo = avatar - 2 * (ring + gap); photoX = x + ring + gap; photoY = avatarTop + ring + gap; corner = photo * 0.5f
    }
    val face = if (item.avatarUrl.isNotEmpty() && item.avatarKey.isNotEmpty()) AvatarStore.get(context, item.avatarKey, item.avatarUrl, this) else null
    if (face != null) drawPicture(canvas, face, photoX, photoY, photo, corner, true)
    else {
      if (item.orbA != 0 && item.orbB != 0) {
        // A lit ball: the person's colour between a lighter and a deeper neighbour hue, a highlight from the top left.
        orb.shader = LinearGradient(photoX + photo * 0.9f, photoY + photo, photoX + photo * 0.1f, photoY, intArrayOf(item.orbA, item.avatarColor, item.orbB), null, Shader.TileMode.CLAMP)
        canvas.drawRoundRect(photoX, photoY, photoX + photo, photoY + photo, corner, corner, orb)
        orb.shader = LinearGradient(photoX + photo * 0.12f, photoY + photo * 0.02f, photoX + photo * 0.7f, photoY + photo * 0.8f, intArrayOf(0x6BFFFFFF, 0x0FFFFFFF, 0x00FFFFFF), floatArrayOf(0f, 0.38f, 0.6f), Shader.TileMode.CLAMP)
        canvas.drawRoundRect(photoX, photoY, photoX + photo, photoY + photo, corner, corner, orb)
        orb.shader = null
      } else { fill.color = item.avatarColor; canvas.drawRoundRect(photoX, photoY, photoX + photo, photoY + photo, corner, corner, fill) }
      canvas.drawText(item.initials, x + avatar / 2, h / 2 - (avatarPaint.descent() + avatarPaint.ascent()) / 2, avatarPaint)
    }
    if (art != null) {
      val side = photo * item.decoScale.toFloat()
      dst.set(x + avatar / 2 - side / 2, h / 2 - side / 2, x + avatar / 2 + side / 2, h / 2 + side / 2)
      canvas.drawBitmap(art, null, dst, picture)
    }
    x += avatar + 12f * d

    val right = w - 16f * d
    timePaint.color = if (item.unread > 0 && !item.muted) palette.accent else mutedColor
    val timeWidth = timePaint.measureText(item.time)
    // ChatsPlus: the reference's badgeText — exact up to 999, then «4,3K».
    val badge = if (item.unread > 0) com.linea.messenger.chatsplus.ChatListStatus.badgeText(item.unread) else ""
    val badgeWidth = if (badge.isEmpty()) 0f else maxOf(22f * d, badgePaint.measureText(badge) + 12f * d)
    // The ticks stand before the time; under the time is the unread badge or, without one, the pin.
    val tickWidth = if (item.ticks > 0) 22f * d else 0f
    val markWidth = if (badge.isEmpty() && item.pinned) 20f * d else badgeWidth
    // A chat without sound carries « 🔕» at the end of its title (ChatListScreen.tsx nativeRows).
    val titleWidth = right - x - timeWidth - 8f * d - tickWidth
    val small = thumb
    val mic = small == null && item.previewIcon == "mic"
    val thumbRoom = if (small != null) 26f * d else if (mic) 19f * d else 0f
    val textWidth = (right - x - thumbRoom - (if (markWidth > 0f) markWidth + 8f * d else 0f)).toInt()
    if (builtFor != item || builtWidth != width) build(item, textWidth, titleWidth)

    val top = 12f * d
    titlePaint.color = textColor
    val nameEnd = if (item.metal.size >= 2) minOf(item.nameLen, title.length) else 0
    if (nameEnd > 0) {
      // A Platina name: the letters of the name show polished metal, the rest of the line stays plain.
      val nameWidth = titlePaint.measureText(title, 0, nameEnd)
      titlePaint.shader = LinearGradient(x, top + 6f * d, x + nameWidth, top + 15f * d, item.metal.toIntArray(), null, Shader.TileMode.CLAMP)
      canvas.drawText(title, 0, nameEnd, x, top - titlePaint.ascent(), titlePaint)
      titlePaint.shader = null
      if (nameEnd < title.length) canvas.drawText(title, nameEnd, title.length, x + nameWidth, top - titlePaint.ascent(), titlePaint)
    } else canvas.drawText(title, 0, title.length, x, top - titlePaint.ascent(), titlePaint)
    canvas.drawText(item.time, right - timeWidth, top - timePaint.ascent() + 1.5f * d, timePaint)

    previewPaint.color = if (item.accentPreview) palette.accent else mutedColor
    if (small != null) drawPicture(canvas, small, x, top + 23f * d, 20f * d, if (item.thumbRound) 10f * d else 4f * d, false)
    if (mic) {
      // A voice message is a grey microphone before its name. The capsule, the cradle and the stand.
      val mx = x + 6f * d; val my = top + 23f * d + 9.5f * d
      fill.color = palette.subtle
      canvas.drawRoundRect(mx - 2.6f * d, my - 6.5f * d, mx + 2.6f * d, my + 1.5f * d, 2.6f * d, 2.6f * d, fill)
      stroke.color = palette.subtle; stroke.strokeWidth = 1.3f * d
      canvas.drawArc(mx - 4.6f * d, my - 5.5f * d, mx + 4.6f * d, my + 4f * d, 0f, 180f, false, stroke)
      canvas.drawLine(mx, my + 4f * d, mx, my + 6.5f * d, stroke)
    }
    preview?.let { layout -> canvas.save(); canvas.translate(x + thumbRoom, top + 23f * d); layout.draw(canvas); canvas.restore() }

    val markY = top + 23f * d + 11f * d
    if (badge.isNotEmpty()) {
      fill.color = if (item.muted) palette.badgeMuted else palette.accent
      canvas.drawRoundRect(right - badgeWidth, markY - 11f * d, right, markY + 11f * d, 11f * d, 11f * d, fill)
      badgePaint.color = if (item.muted) palette.text else palette.onAccent
      canvas.drawText(badge, right - badgeWidth / 2, markY - (badgePaint.descent() + badgePaint.ascent()) / 2, badgePaint)
    } else if (item.pinned) {
      // A pin leaning to the right: the head, its base and the needle.
      val cx = right - 8f * d
      canvas.save(); canvas.rotate(45f, cx, markY)
      fill.color = palette.subtle
      canvas.drawRoundRect(cx - 3.2f * d, markY - 7f * d, cx + 3.2f * d, markY - 1f * d, 1.2f * d, 1.2f * d, fill)
      canvas.drawRoundRect(cx - 5f * d, markY - 1.6f * d, cx + 5f * d, markY + 0.4f * d, 1f * d, 1f * d, fill)
      canvas.drawRect(cx - 0.7f * d, markY + 0.4f * d, cx + 0.7f * d, markY + 7f * d, fill)
      canvas.restore()
    }
    if (item.ticks > 0) {
      val tickY = top + 11f * d
      stroke.color = if (item.ticks == 2) palette.accent else palette.muted; stroke.strokeWidth = 1.7f * d
      val bx = right - timeWidth - 6f * d - 16f * d
      path.reset(); path.moveTo(bx, tickY); path.lineTo(bx + 4f * d, tickY + 4f * d); path.lineTo(bx + 12f * d, tickY - 5f * d)
      if (item.ticks == 2) { path.moveTo(bx + 6f * d, tickY + 2f * d); path.lineTo(bx + 8f * d, tickY + 4f * d); path.lineTo(bx + 16f * d, tickY - 5f * d) }
      canvas.drawPath(path, stroke)
    }

    fill.color = palette.border; canvas.drawRect(x, h - maxOf(1f, d / 2), w, h, fill)
  }

  companion object { const val ROW_DP = 76f; const val BUTTON_DP = 78f; const val SECTION_DP = 30f }
}
