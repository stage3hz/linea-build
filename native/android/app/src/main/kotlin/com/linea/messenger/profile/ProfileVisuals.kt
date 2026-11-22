package com.linea.messenger.profile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.view.View
import android.widget.FrameLayout
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.AvatarMedia
import com.linea.messenger.avatars.AvatarMotion
import com.linea.messenger.avatars.DecorTicker
import com.linea.messenger.avatars.LiveCanvasView
import com.linea.messenger.avatars.LoopVideoView
import com.linea.messenger.avatars.PersonLook
import com.linea.messenger.avatars.decorRand
import com.linea.messenger.avatars.lookColor
import com.linea.messenger.design.Theme
import java.io.File
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

// What the top of a profile is made of (the reference's music/MusicAmbient.tsx, platina/Decor.tsx ProfileBanner,
// platina/Effects.tsx, design/peerLight.tsx ProfileLight and ProfilePosts.tsx ProfilePattern; iOS
// Profile/ProfileVisuals.swift):
//   ProfileAmbientView  the animated banner presets: soft light patches drifting, their colours flowing
//   ProfileBannerView   the banner: an uploaded photo / video or a preset, soft edges, fading out below
//   ProfileEffectView   particles over the top of an open profile (snow, sparks, petals, bubbles, stars, embers)
//   ProfileLightView    the person's colour falling from the top when there is no banner
//   ProfilePatternView  the chosen emoji repeated in rings around the avatar

/** The phone-proportioned head of a profile (banner height 200 under a ~59 dp status bar). */
const val profileHeroRatio = 259f / 393f

/** The animated Platina banners (the music ambient's palettes, MusicAmbient.tsx): five colour layers per patch,
 *  one showing at a time and passing to the next, the patches drifting slowly. Still while animations are off or
 *  when asked (`still`). */
class ProfileAmbientView(context: Context) : LiveCanvasView(context) {
  class Palette(val base: Int, val colors: IntArray, val accent: Int = 4, val green: Int = 1)

  companion object {
    val palettes = mapOf(
      "deep" to Palette(0x050B1C, intArrayOf(0x0D3480, 0x0A2F6E, 0x143F9E, 0x08245A, 0x8FB3D9)),
      "glacier" to Palette(0x0B1B2E, intArrayOf(0x4C8FD6, 0x7FC8E8, 0x2F6DB5, 0x9FD6F2, 0xFFFFFF)),
      "aurora" to Palette(0x04131C, intArrayOf(0x0B6450, 0x1AA889, 0x0D3480, 0x2EE6C8, 0xCFF7EE)),
      "ocean" to Palette(0x031424, intArrayOf(0x0A4E8A, 0x0C7A9E, 0x063A6B, 0x1593B8, 0xB8E4F5)),
      "mint" to Palette(0x061A16, intArrayOf(0x118A6A, 0x4FD1A5, 0x0B5C4A, 0x7BE8C3, 0xE6FFF6)),
      "night" to Palette(0x000000, intArrayOf(0x0A1A40, 0x101F4D, 0x06122E, 0x1A2C66, 0x5D7BB8)),
    )

    /** The opacity of colour layer `index` at a point of the cycle (smoothstep of the circular distance). */
    fun layerOpacity(phase: Double, index: Int, count: Int): Double {
      val n = count.toDouble()
      var d = abs((((phase - index) % n) + n) % n)
      d = minOf(d, n - d)
      val k = maxOf(0.0, 1 - d)
      return k * k * (3 - 2 * k)
    }
  }

  private var tone = "deep"
  private var still = false
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  // Made once per palette and size, not on every frame: each colour's soft patch at radius 1 about (0, 0) (scaled,
  // moved and faded by the paint where it is drawn), and the patches' plan.
  private var glows: Array<Shader>? = null
  private var glowsFor = ""
  private var plan: Array<FloatArray>? = null
  private var planW = 0f; private var planH = 0f
  private val points = FloatArray(5)

  fun show(tone: String, still: Boolean) {
    this.tone = if (palettes.containsKey(tone)) tone else "deep"
    this.still = still
    live = !still
    invalidate()
  }

  override fun paint(canvas: Canvas, width: Float, height: Float) {
    val palette = palettes[tone] ?: return
    canvas.drawColor(0xFF000000.toInt() or palette.base)
    val w = width; val h = height
    if (w <= 0 || h <= 0) return
    val moving = live
    val t = if (moving) seconds else 0.0
    if (glowsFor != tone || glows == null) {
      glows = Array(palette.colors.size) { val c = palette.colors[it] and 0xFFFFFF; RadialGradient(0f, 0f, 1f, intArrayOf(c or (0xFF shl 24), c), null, Shader.TileMode.CLAMP) }
      glowsFor = tone
    }
    if (plan == null || planW != w || planH != h) {
      // x, y, size, offset, drift, strength
      plan = arrayOf(
        floatArrayOf(w * 0.25f, h * 0.35f, w * 1.3f, 0f, 50f, 0.55f), floatArrayOf(w * 0.85f, h * 0.55f, w * 1.2f, 1.7f, 45f, 0.45f),
        floatArrayOf(w * 0.5f, h * 0.85f, w * 1.3f, 3.1f, 40f, 0.5f), floatArrayOf(w * 0.55f, h * 0.3f, w * 0.8f, 4.2f, 55f, 0.3f),
      )
      planW = w; planH = h
    }
    val shaders = glows ?: return
    val d = resources.displayMetrics.density
    for (item in plan ?: return) {
      val offset = item[3].toDouble(); val drift = item[4] * d; val strength = item[5]
      val x = item[0] + sway(moving, t, drift, 9 + offset * 0.9); val y = item[1] + sway(moving, t, -drift * 0.7f, 11 + offset * 0.7)
      val radius = item[2] / 2
      val phase = offset + (if (moving) t / 6.0 else 0.0)
      for (index in palette.colors.indices) {
        val opacity = (if (index == palette.accent) strength * 0.35f else if (index == palette.green) strength * 0.7f else strength) * layerOpacity(phase, index, palette.colors.size).toFloat()
        if (opacity <= 0.005f) continue
        paint.shader = shaders[index]
        paint.alpha = Math.round(opacity * 255)
        canvas.save(); canvas.translate(x, y); canvas.scale(radius, radius)
        canvas.drawCircle(0f, 0f, 1f, paint)
        canvas.restore()
      }
    }
    paint.shader = null
    paint.alpha = 255
  }

  private fun sway(moving: Boolean, t: Double, amount: Float, leg: Double): Float {
    if (!moving) return 0f
    val k = (t % (leg * 4)) / leg
    val seg = k.toInt(); val f = k - seg
    val e = (-(cos(Math.PI * f) - 1) / 2).toFloat()
    points[0] = 0f; points[1] = amount; points[2] = -amount; points[3] = amount; points[4] = 0f
    return points[seg] + (points[seg + 1] - points[seg]) * e
  }
}

/** The profile banner (Decor.tsx `ProfileBanner`): the uploaded photo or video, or an animated preset; empty when the
 *  person has none (`hasContent` false, the view GONE). Soft edges over a photo and a video; below, it fades out by
 *  transparency (`preview` keeps it whole: the editor's tile, the studio's swatches). */
class ProfileBannerView(context: Context) : FrameLayout(context) {
  private val photo = object : View(context) {
    override fun onDraw(canvas: Canvas) = drawPicture(canvas, width.toFloat(), height.toFloat())
  }
  private val video = LoopVideoView(context)
  private val ambient = ProfileAmbientView(context)
  private val fade = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN) }
  private val soft = Paint(Paint.ANTI_ALIAS_FLAG)
  private val picturePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val matrix = Matrix()
  private var look = PersonLook()
  private var base = ""
  private var preview = false
  private var localPicture: Bitmap? = null
  private var localVideo: File? = null
  private var still: Bitmap? = null
  private var blurred: Bitmap? = null
  private var moving: Drawable? = null
  var hasContent = false
    private set
  private val arrived: (String) -> Unit = { id -> if (id == look.bannerId) refresh() }

  init {
    setWillNotDraw(false)
    clipChildren = true
    addView(photo, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(video, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(ambient, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    visibility = GONE
  }

  /** `localPicture` / `localVideo`: picked on this device and not uploaded yet (the «так будет выглядеть» preview). */
  fun show(look: PersonLook, base: String, preview: Boolean = false, localPicture: Bitmap? = null, localVideo: File? = null) {
    this.look = look; this.base = base; this.preview = preview; this.localPicture = localPicture; this.localVideo = localVideo
    refresh()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); AvatarMedia.ready.watch(arrived) }
  override fun onDetachedFromWindow() { AvatarMedia.ready.unwatch(arrived); super.onDetachedFromWindow() }

  private fun refresh() {
    val motion = AvatarMotion.enabled(context) && AvatarMotion.fastNet
    setBackgroundColor(Theme.surface2)
    var playing: File? = null
    photo.visibility = GONE; video.visibility = GONE; ambient.visibility = GONE
    still = null; moving = null
    val local = localPicture; val localFile = localVideo
    hasContent = true
    when {
      localFile != null -> { playing = localFile; video.visibility = VISIBLE }
      local != null -> { still = local; photo.visibility = VISIBLE }
      look.bannerId.isNotEmpty() && look.bannerKind == "video" && motion -> { playing = AvatarMedia.video(context, look.bannerId, base); video.visibility = VISIBLE }
      look.bannerId.isNotEmpty() -> {
        if (look.bannerKind != "video") {
          when (val found = AvatarMedia.drawable(context, look.bannerId, base, maxOf(width, Math.round(320 * resources.displayMetrics.density)), AvatarMotion.feature("gif", context))) {
            is Bitmap -> still = found
            is Drawable -> { moving = found; found.callback = photo; (found as? Animatable)?.start() }
          }
        }
        photo.visibility = VISIBLE
      }
      look.bannerPreset.isNotEmpty() && AvatarCatalog.banners.any { it.id == look.bannerPreset } -> {
        ambient.show(look.bannerPreset, still = !motion)
        ambient.visibility = VISIBLE
      }
      else -> hasContent = false
    }
    blurred = still?.let { if (!preview) softCopy(it) else null }
    video.play(playing)
    visibility = if (hasContent) VISIBLE else GONE
    photo.invalidate()
    invalidate()
  }

  /** The reference's `blurRadius={22}` copy for the soft edges: drawn small and scaled up with filtering. */
  private fun softCopy(picture: Bitmap): Bitmap? = try {
    val small = Bitmap.createScaledBitmap(picture, maxOf(4, picture.width / 24), maxOf(4, picture.height / 24), true)
    Bitmap.createScaledBitmap(small, picture.width, picture.height, true)
  } catch (_: Throwable) { null }

  private fun drawCover(canvas: Canvas, bitmap: Bitmap, w: Float, h: Float, paint: Paint) {
    val scale = maxOf(w / bitmap.width, h / bitmap.height)
    matrix.setScale(scale, scale); matrix.postTranslate((w - bitmap.width * scale) / 2, (h - bitmap.height * scale) / 2)
    paint.shader = BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
    canvas.drawRect(0f, 0f, w, h, paint)
    paint.shader = null
  }

  private fun drawPicture(canvas: Canvas, w: Float, h: Float) {
    if (w <= 0 || h <= 0) return
    still?.let { drawCover(canvas, it, w, h, picturePaint) }
    moving?.let { drawable ->
      val iw = drawable.intrinsicWidth.coerceAtLeast(1); val ih = drawable.intrinsicHeight.coerceAtLeast(1)
      val scale = maxOf(w / iw, h / ih)
      drawable.setBounds(((w - iw * scale) / 2).toInt(), ((h - ih * scale) / 2).toInt(), ((w + iw * scale) / 2).toInt(), ((h + ih * scale) / 2).toInt())
      drawable.draw(canvas)
      photo.postInvalidateOnAnimation()
    }
    blurred?.let { copy ->
      // Soft top and bottom edges: the blurred copy shows only near the edges, the sharp picture in between.
      val layer = canvas.saveLayer(0f, 0f, w, h, null)
      drawCover(canvas, copy, w, h, soft)
      val mask = Paint().apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN)
        shader = LinearGradient(0f, 0f, 0f, h, intArrayOf(0xFF000000.toInt(), 0, 0, 0xFF000000.toInt()), floatArrayOf(0f, 0.3f, 0.55f, 1f), Shader.TileMode.CLAMP)
      }
      canvas.drawRect(0f, 0f, w, h, mask)
      canvas.restoreToCount(layer)
    }
  }

  override fun draw(canvas: Canvas) {
    // The background is part of what fades.
    val w = width.toFloat(); val h = height.toFloat()
    if (preview || w <= 0 || h <= 0) return super.draw(canvas)
    val layer = canvas.saveLayer(0f, 0f, w, h, null)
    super.draw(canvas)
    fade.shader = LinearGradient(0f, 0f, 0f, h, intArrayOf(0xFF000000.toInt(), 0xFF000000.toInt(), 0), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, fade)
    canvas.restoreToCount(layer)
  }

}

/** Particles over the top of an open profile (Effects.tsx `ProfileEffect`); off when animations are off, unless
 *  `preview` (the picker's swatch, which then stands still). */
class ProfileEffectView(context: Context) : LiveCanvasView(context) {
  private class Kind(val count: Int, val rise: Boolean, val colors: List<Int>, val size: Pair<Float, Float>, val duration: Pair<Double, Double>, val shape: String, val twinkle: Boolean)

  companion object {
    private val kinds = mapOf(
      "snow" to Kind(22, false, listOf(0xFFFFFFFF.toInt(), lookColor("#E6F0FF")), 3f to 7f, 5200.0 to 9000.0, "dot", false),
      "sparks" to Kind(16, true, listOf(lookColor("#FFF4C2"), 0xFFFFFFFF.toInt(), lookColor("#FFD86B")), 6f to 11f, 3200.0 to 5200.0, "star", true),
      "petals" to Kind(14, false, listOf(lookColor("#FFB8CF"), lookColor("#FFD3E1"), lookColor("#FF9DBB")), 7f to 11f, 6000.0 to 9500.0, "petal", false),
      "bubbles" to Kind(14, true, listOf(0xE6AADCFF.toInt(), 0xCCFFFFFF.toInt()), 8f to 18f, 5000.0 to 8500.0, "ring", false),
      "stars" to Kind(20, false, listOf(0xFFFFFFFF.toInt(), lookColor("#CFE0FF"), lookColor("#FFF2C7")), 5f to 9f, 1800.0 to 3400.0, "star", true),
      "embers" to Kind(18, true, listOf(lookColor("#FF8A3D"), lookColor("#FFB347"), lookColor("#FF5A36")), 3f to 6f, 3600.0 to 6400.0, "dot", false),
    )
  }

  private var effect = ""
  private var preview = false
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val petalBox = RectF()
  private val petalRadii = FloatArray(8)
  // Each colour's soft glow at radius 1 about (0, 0), made once per effect (scaled and faded where it is drawn).
  private var glows: Array<Shader>? = null
  private var glowsFor = ""

  init { isClickable = false }

  fun show(effect: String, preview: Boolean = false) {
    this.effect = effect
    this.preview = preview
    live = kinds.containsKey(effect)
    invalidate()
  }

  override fun paint(canvas: Canvas, width: Float, height: Float) {
    val kind = kinds[effect] ?: return
    val enabled = DecorTicker.allowed
    if (!enabled && !preview) return
    if (glowsFor != effect || glows == null) {
      glows = Array(kind.colors.size) { val c = kind.colors[it] and 0xFFFFFF; RadialGradient(0f, 0f, 1f, intArrayOf(c or (0xFF shl 24), c), null, Shader.TileMode.CLAMP) }
      glowsFor = effect
    }
    val shaders = glows ?: return
    val d = resources.displayMetrics.density
    for (index in 0 until kind.count) {
      fun r(n: Double) = decorRand(index * 7.0 + n)
      val size = (kind.size.first + r(1.0).toFloat() * (kind.size.second - kind.size.first)) * d
      val x = r(2.0).toFloat() * (width - size); val sway = (8 + r(3.0) * 18).toFloat() * d
      val duration = (kind.duration.first + r(4.0) * (kind.duration.second - kind.duration.first)) / 1000
      val colorIndex = minOf(kind.colors.size - 1, (r(5.0) * kind.colors.size).toInt())
      val color = kind.colors[colorIndex]
      val phase = r(6.0)
      val tall = if (kind.shape == "petal") size * 0.7f else size
      // Every particle is already on its way, each at its own point of the loop: full at once.
      val p = if (enabled) ((seconds / duration + phase) % 1.0) else phase
      val y = if (kind.rise) height - p * (height + size * 2) else -size + p * (height + size * 2)
      val opacity = if (kind.twinkle) 0.25 + 0.75 * abs(sin(p * Math.PI * 3)) else minOf(1.0, p * 6, (1 - p) * 4)
      val alpha = (Math.round(opacity * ((color ushr 24) / 255.0) * 255).toInt()).coerceIn(0, 255)
      canvas.save()
      canvas.translate(x + sin(p * Math.PI * 2).toFloat() * sway, y.toFloat())
      if (kind.shape == "petal") canvas.rotate((p * 360).toFloat(), size / 2, tall / 2)
      // A soft glow of its own colour.
      paint.style = Paint.Style.FILL
      paint.shader = shaders[colorIndex]
      paint.alpha = (alpha * (if (kind.shape == "dot") 0.35 else 0.5)).toInt()
      canvas.save(); canvas.translate(size / 2, tall / 2); canvas.scale(size, size)
      canvas.drawCircle(0f, 0f, 1f, paint)
      canvas.restore()
      paint.shader = null
      paint.color = (color and 0xFFFFFF) or (alpha shl 24)
      when (kind.shape) {
        "ring" -> { paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.2f * d; canvas.drawCircle(size / 2, size / 2, size / 2, paint) }
        "petal" -> {
          val big = minOf(size, tall) / 2
          petalBox.set(0f, 0f, size, tall)
          petalRadii[0] = big; petalRadii[1] = big; petalRadii[2] = 2 * d; petalRadii[3] = 2 * d
          petalRadii[4] = big; petalRadii[5] = big; petalRadii[6] = 2 * d; petalRadii[7] = 2 * d
          path.reset(); path.addRoundRect(petalBox, petalRadii, Path.Direction.CW)
          canvas.drawPath(path, paint)
        }
        "star" -> { canvas.rotate(45f, size / 2, tall / 2); canvas.drawRoundRect(0f, 0f, size, tall, 1.5f * d, 1.5f * d, paint) }
        else -> canvas.drawOval(0f, 0f, size, tall, paint)
      }
      canvas.restore()
    }
  }
}

/** The person's light (the reference's design/peerLight.tsx `ProfileLight`): their colour falling softly from the top
 *  of the page when there is no banner. */
class ProfileLightView(context: Context) : View(context) {
  var color: Int = 0x5E7BFF
    set(value) { field = value; invalidate() }
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0 || h <= 0) return
    val c = color and 0xFFFFFF
    val strength = if (Theme.dark) 0.42f else 0.26f
    paint.shader = RadialGradient(w / 2, -h * 0.15f, h * 0.95f, intArrayOf(c or (Math.round(strength * 255) shl 24), c or (Math.round(strength * 0.4f * 255) shl 24), c), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, w, h, paint)
  }
}

/** The profile background pattern (ProfilePosts.tsx `ProfilePattern`): the chosen emoji repeated in three rings
 *  around the avatar, smaller and fainter further out, clear of the name under the photo. `avatarX` / `avatarY`:
 *  the avatar's centre in this view, px. */
class ProfilePatternView(context: Context) : View(context) {
  private var emoji = ""
  private val paint = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
  var avatarX = 0f
  var avatarY = 0f

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  fun show(emoji: String) {
    this.emoji = emoji
    visibility = if (emoji.isEmpty()) GONE else VISIBLE
    invalidate()
  }

  fun center(x: Float, y: Float) { if (x != avatarX || y != avatarY) { avatarX = x; avatarY = y; invalidate() } }

  override fun onDraw(canvas: Canvas) {
    if (emoji.isEmpty() || width <= 0) return
    val d = resources.displayMetrics.density
    val rings = listOf(floatArrayOf(84f, 6f, 20f, 0.3f), floatArrayOf(124f, 9f, 17f, 0.18f), floatArrayOf(166f, 12f, 14f, 0.1f))
    rings.forEachIndexed { k, ring ->
      val n = ring[1].toInt(); val size = ring[2] * d
      for (i in 0 until n) {
        val a = i.toFloat() / n * Math.PI.toFloat() * 2 + k * 0.4f
        val x = avatarX + cos(a) * ring[0] * d * 1.3f; val y = avatarY + sin(a) * ring[0] * d * 0.72f
        if (y > avatarY + 50 * d && abs(x - avatarX) < 110 * d) continue
        if (y < -size || y > height + size || x < -size || x > width + size) continue
        paint.textSize = size
        paint.alpha = Math.round(ring[3] * 255)
        canvas.drawText(emoji, x, y - (paint.ascent() + paint.descent()) / 2, paint)
      }
    }
  }
}

