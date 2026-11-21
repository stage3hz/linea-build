package com.linea.messenger.avatars

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.os.SystemClock
import android.text.TextPaint
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.design.Theme
import com.linea.messenger.design.orbPair
import com.linea.messenger.people.Person

/** The round face of a person: their picture, or their colour as a lit ball with their initials (as in the chat
 *  list). `animated`: a GIF avatar moves (with «Автозапуск GIF» on and no power saving). */
class AvatarFaceView(context: Context) : View(context) {
  private val orb = Paint(Paint.ANTI_ALIAS_FLAG)
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val letters = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; typeface = Theme.weight(700) }
  private val matrix = Matrix()
  private val clip = Path()
  private var colors = intArrayOf(0, 0, 0)
  private var initials = ""
  private var pictureId = ""
  private var base = ""
  private var animated = false
  private var moving: Drawable? = null
  /** A picture given directly (samples, a photo just chosen): shown instead of the person's. */
  var overridePicture: Bitmap? = null
    set(value) { field = value; invalidate() }
  private val arrived: (String) -> Unit = { id -> if (id == pictureId) invalidate() }

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  fun show(person: Person, base: String, animated: Boolean) {
    val pair = orbPair(person.avatarColor)
    colors = intArrayOf(pair.first, 0xFF000000.toInt() or person.avatarColor, pair.second)
    initials = Messenger.initials(person.displayName).take(2)
    pictureId = person.avatarId
    this.base = base
    this.animated = animated
    invalidate()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); AvatarMedia.ready.watch(arrived) }
  override fun onDetachedFromWindow() { AvatarMedia.ready.unwatch(arrived); (moving as? Animatable)?.stop(); super.onDetachedFromWindow() }

  private fun drawBitmap(canvas: Canvas, face: Bitmap, w: Float, h: Float) {
    val scale = maxOf(w / face.width, h / face.height)
    matrix.setScale(scale, scale); matrix.postTranslate((w - face.width * scale) / 2, (h - face.height * scale) / 2)
    picture.shader = BitmapShader(face, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
    canvas.drawCircle(w / 2, h / 2, minOf(w, h) / 2, picture)
    picture.shader = null
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    overridePicture?.let { return drawBitmap(canvas, it, w, h) }
    if (pictureId.isNotEmpty() && base.isNotEmpty()) {
      val pixels = maxOf(width, Math.round(54 * resources.displayMetrics.density))
      if (pixels <= 180 && !animated) {
        // List sizes: the chat list's own store (its 180 px copy is the same picture, already decoded).
        AvatarStore.get(context, pictureId, AvatarMedia.address(base, pictureId), this)?.let { return drawBitmap(canvas, it, w, h) }
      } else {
        when (val found = AvatarMedia.drawable(context, pictureId, base, maxOf(240, pixels), animated && AvatarMotion.feature("gif", context))) {
          is Bitmap -> return drawBitmap(canvas, found, w, h)
          is Drawable -> {
            if (moving !== found) { (moving as? Animatable)?.stop(); moving = found; found.callback = this; (found as? Animatable)?.start() }
            clip.reset(); clip.addCircle(w / 2, h / 2, minOf(w, h) / 2, Path.Direction.CW)
            canvas.save(); canvas.clipPath(clip)
            val iw = found.intrinsicWidth.coerceAtLeast(1); val ih = found.intrinsicHeight.coerceAtLeast(1)
            val scale = maxOf(w / iw, h / ih)
            val dw = iw * scale; val dh = ih * scale
            found.setBounds(((w - dw) / 2).toInt(), ((h - dh) / 2).toInt(), ((w + dw) / 2).toInt(), ((h + dh) / 2).toInt())
            found.draw(canvas)
            canvas.restore()
            return
          }
        }
      }
    }
    orb.shader = LinearGradient(w * 0.9f, h, w * 0.1f, 0f, colors, null, Shader.TileMode.CLAMP)
    canvas.drawCircle(w / 2, h / 2, minOf(w, h) / 2, orb)
    orb.shader = null
    letters.textSize = maxOf(8f * resources.displayMetrics.density, w * 0.36f)
    val room = w * 0.76f
    val wide = letters.measureText(initials)
    if (wide > room && wide > 0f) letters.textSize *= maxOf(0.5f, room / wide)
    canvas.drawText(initials, w / 2, h / 2 - (letters.ascent() + letters.descent()) / 2, letters)
  }

  override fun verifyDrawable(who: Drawable): Boolean = who === moving || super.verifyDrawable(who)
}

/** A person's avatar with their Platina decoration (Decor.tsx `DecoratedAvatar`; iOS Avatars/DecoratedAvatarView.swift):
 *  the turning ring, a frame drawn in code, or painted art around the photo; on their birthday a festive ring and a
 *  🎂; the silent video avatar. The view's own size is the avatar's — rings of list sizes are drawn inside,
 *  everything else reaches outside (so rows keep their layout; the parents must not clip). Round always. */
class DecoratedAvatarView(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private val face = AvatarFaceView(context)
  private val video = LoopVideoView(context)
  private var codeFrame: CodeFrameView? = null
  private var art: DecorationArtView? = null
  private val cake = TextView(context)
  private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val holePaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val born = SystemClock.uptimeMillis()
  private var ringColors: List<String>? = null
  private var cakeShown = false

  var person = Person("", "", "", "", "", 0x5E7BFF, "")
    private set
  var look = PersonLook()
    private set
  private var base = ""
  private var animated = false
  /** The colour of the gap between a ring and the photo (the page behind; Theme.bg by default). */
  var ringBackground: Int = Theme.bg
    set(value) { field = value; invalidate(); cakeBackground() }
  /** A picture given directly (samples, a photo just chosen). */
  var overridePicture: Bitmap?
    get() = face.overridePicture
    set(value) { face.overridePicture = value }
  private val arrived: (String) -> Unit = { id -> if (id == look.avatarVideoId && id.isNotEmpty()) refreshVideo() }

  init {
    clipChildren = false
    clipToPadding = false
    setWillNotDraw(false)
    addView(face)
    video.visibility = GONE
    video.outlineProvider = object : ViewOutlineProvider() { override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) } }
    video.clipToOutline = true
    addView(video)
    cake.text = "🎂"
    cake.gravity = Gravity.CENTER
    cake.includeFontPadding = false
    cake.contentDescription = "День рождения"
    cake.visibility = GONE
    addView(cake)
    cakeBackground()
  }

  private fun cakeBackground() {
    cake.background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(ringBackground) }
  }

  /** `base`: the server pictures are asked from (empty: none asked). `animated`: motion and the video avatar
   *  (profiles); false in lists. */
  fun show(person: Person, look: PersonLook = person.look, base: String, animated: Boolean) {
    // A label given by the page (the ring of stories: «Истории») stays; otherwise the person's name.
    if (contentDescription.isNullOrEmpty() || contentDescription == this.person.displayName) contentDescription = person.displayName
    this.person = person
    this.look = look
    this.base = base
    this.animated = animated
    rebuild()
  }

  /** Frames, art and sweeps move: `animated` and the app's animations are on. */
  private val live: Boolean get() = animated && AvatarMotion.enabled(context)

  private fun rebuild() {
    val birthday = look.birthdayToday()
    val coded = if (!birthday && AvatarCatalog.isCodeFrame(look.avatarFrame)) look.avatarFrame else ""
    val decoration = if (birthday) null else AvatarCatalog.decoration(look.avatarFrame)
    ringColors = if (coded.isEmpty() && decoration == null) AvatarCatalog.ringColors(look) else null
    if (coded.isNotEmpty()) {
      if (codeFrame?.frameId != coded) { codeFrame?.let { removeView(it) }; codeFrame = CodeFrameView(context, coded).also { addView(it) } }
    } else { codeFrame?.let { removeView(it) }; codeFrame = null }
    if (decoration != null) {
      if (art?.decoration?.id != decoration.id) { art?.let { removeView(it) }; art = DecorationArtView(context, decoration).also { addView(it) } }
    } else { art?.let { removeView(it) }; art = null }
    cakeShown = birthday && ringColors != null
    cake.visibility = if (cakeShown) VISIBLE else GONE
    cake.bringToFront()
    face.show(person, base, animated)
    codeFrame?.live = live
    art?.live = live
    refreshVideo()
    requestLayout()
    invalidate()
  }

  private fun refreshVideo() {
    // On a slow link a looping video would eat what messages need; with power saving it stays the photo.
    val allowed = live && AvatarMotion.feature("video", context) && AvatarMotion.fastNet && look.avatarVideoId.isNotEmpty()
    val file = if (allowed) AvatarMedia.video(context, look.avatarVideoId, base) else null
    video.play(file)
    video.visibility = if (file == null) GONE else VISIBLE
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); AvatarMedia.ready.watch(arrived) }
  override fun onDetachedFromWindow() { AvatarMedia.ready.unwatch(arrived); super.onDetachedFromWindow() }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(getDefaultSize(Math.round(54 * d), widthMeasureSpec), getDefaultSize(Math.round(54 * d), heightMeasureSpec))
  }

  private fun place(view: View, cx: Float, cy: Float, side: Float) {
    val s = Math.round(side)
    view.measure(MeasureSpec.makeMeasureSpec(s, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(s, MeasureSpec.EXACTLY))
    val l = Math.round(cx - side / 2); val t = Math.round(cy - side / 2)
    view.layout(l, t, l + s, t + s)
  }

  private var ringOuter = 0f
  private var holeSide = 0f

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val size = minOf(r - l, b - t).toFloat()
    if (size <= 0f) return
    val cx = (r - l) / 2f; val cy = (b - t) / 2f
    val small = size < 64 * d
    var faceSide = size
    art?.let {
      // Small (list) sizes: the art reaches at most 1.3× the box; the photo shrinks inside to fill the opening.
      val scale = it.decoration.scale
      faceSide = if (small && scale > 1.3f) Math.round(size * 1.3f / scale).toFloat() else size
      place(it, cx, cy, faceSide * scale)
    }
    codeFrame?.let { place(it, cx, cy, size * AvatarCatalog.codeFrameScale) }
    if (ringColors != null) {
      val ring = maxOf(2 * d, Math.round(size * 0.045f).toFloat()); val gap = maxOf(1.5f * d, Math.round(size * 0.035f).toFloat())
      val badge = maxOf(16 * d, size * 0.34f)
      if (small) {
        // Inside the same box: a framed avatar keeps the column of plain ones.
        ringOuter = size; holeSide = size - 2 * ring
        faceSide = size - 2 * (ring + gap)
        place(cake, (r - l) + 2 * d - badge / 2, (b - t) + 2 * d - badge / 2, badge)
      } else {
        ringOuter = size + 2 * (ring + gap); holeSide = size + 2 * gap
        place(cake, cx + ringOuter / 2 - badge / 2, cy + ringOuter / 2 - badge / 2, badge)
      }
      cake.textSize = maxOf(10f, size / d * 0.22f)
    } else {
      ringOuter = 0f
      cake.layout(0, 0, 0, 0)
    }
    place(face, cx, cy, faceSide)
    place(video, cx, cy, faceSide)
  }

  override fun onDraw(canvas: Canvas) {
    val colors = ringColors ?: return
    if (ringOuter <= 0f) return
    val cx = width / 2f; val cy = height / 2f
    val argb = colors.map { lookColor(it) }.toIntArray()
    // A square gradient 1.5× the ring, turning once in 5.2 s, seen through the round window (Decor.tsx `Spin`).
    val spinning = live
    val angle = if (spinning) ((SystemClock.uptimeMillis() - born) % 5200L) / 5200f * 360f else 0f
    val big = ringOuter * 1.5f
    val shader = LinearGradient(cx - big / 2, cy - big / 2, cx + big / 2, cy + big / 2, argb, null, Shader.TileMode.CLAMP)
    shader.setLocalMatrix(Matrix().apply { setRotate(angle, cx, cy) })
    ringPaint.shader = shader
    canvas.drawCircle(cx, cy, ringOuter / 2, ringPaint)
    holePaint.color = ringBackground
    canvas.drawCircle(cx, cy, holeSide / 2, holePaint)
    if (spinning && isShown) postInvalidateOnAnimation()
  }
}
