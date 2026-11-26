package com.linea.messenger.calls

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import com.linea.messenger.effects.MusicAmbientView
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.shell.Screen
import kotlin.math.abs

/** One round button of the call screen with its word under it (the reference's `CallButton`).
 *  `color`: the button's own colour (red, green); without one it is white when `active`, else translucent. */
@SuppressLint("ViewConstructor")
class CallRoundButton(context: Context, private val symbol: String, val words: String, private val active: Boolean = false, private val color: Int? = null) : View(context) {
  private val d = resources.displayMetrics.density
  private val circle = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = this@CallRoundButton.color ?: if (active) 0xFFFFFFFF.toInt() else 0x38FFFFFF }
  private val caption = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; textSize = 12f * resources.displayMetrics.scaledDensity; typeface = Theme.weight(400) }
  var onPress: (() -> Unit)? = null

  init {
    isClickable = true
    isFocusable = true
    isSelected = active
    contentDescription = words
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    alpha = if (isPressed) 0.7f else 1f
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    canvas.drawCircle(cx, 31f * d, 31f * d, circle)
    val ink = if (color != null) 0xFFFFFFFF.toInt() else if (active) 0xFF1B2440.toInt() else 0xFFFFFFFF.toInt()
    IonIcon.draw(canvas, symbol, cx, 31f * d, 27f * d, ink) // the reference's Ionicons at 27
    // The word shrinks to fit its place (down to 0.8 of its size).
    val size = 12f * resources.displayMetrics.scaledDensity
    caption.textSize = size
    val wide = caption.measureText(words)
    if (wide > width && wide > 0f) caption.textSize = size * maxOf(0.8f, width / wide)
    canvas.drawText(words, cx, 69f * d - caption.ascent(), caption)
  }
}

/** The call on the whole screen: the reference's `CallScreen`. Behind everything — the other person's picture,
 *  blurred and dimmed (without one, their colour over black); the key emoji at the top; the picture, the name and
 *  the status in the middle (in a video call the other side's camera fills the screen and this phone's own sits in
 *  a small frame that can be dragged); the buttons at the bottom. Pulled down, the call is minimised. */
class CallScreenView(context: Context) : Screen(context) {
  /** The music screen's still ambient under everything (the reference's `<MusicAmbient still>`). */
  private val ambient = MusicAmbientView(context, if (Theme.dark && ThemeStore.look.black) "black" else "dark", still = true)
  private val backdrop = Backdrop(context)
  /** «Звук», opened over the call. */
  private var audioPanel: CallAudioPanel? = null
  private val remoteVideo = CallVideoView(context)
  private val localBox = FrameLayout(context)
  private val localVideo = CallVideoView(context).apply { onTop = true }
  private val minimizeButton = object : View(context) {
    override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, "chevron-down", width / 2f, height / 2f, 24f * d, 0xFFFFFFFF.toInt())
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  }
  private val keyLabel = TextView(context)
  private val pulse = View(context)
  private val avatar = PersonAvatarView(context)
  private val nameLabel = context.words("", 28f, 0xFFFFFFFF.toInt(), 700)
  private val statusButton = context.words("", 16f, 0xD9FFFFFF.toInt())
  private val statsLabel = context.words("", 12f, 0xE6FFFFFF.toInt())
  private val clockLabel = context.words("", 14f, 0x99FFFFFF.toInt())
  private var buttons: List<CallRoundButton> = emptyList()

  private var shown: CallState? = null
  private var statsOpen = false
  private var buttonsKey = ""
  private var pulsing: ValueAnimator? = null
  /** Where the small picture was dragged to (its centre, px); null — its own corner. */
  private var localCentre: Pair<Float, Float>? = null
  private val clock = object : Runnable { override fun run() { refreshStatus(); postDelayed(this, 1000) } }
  private var clockRuns = false

  init {
    setBackgroundColor(0xFF000000.toInt())
    clipChildren = true
    addView(ambient)
    addView(backdrop)
    remoteVideo.visibility = GONE
    addView(remoteVideo)

    minimizeButton.background = context.plate(0x33000000, 20f)
    minimizeButton.contentDescription = "Свернуть звонок"
    minimizeButton.isClickable = true
    minimizeButton.setOnClickListener { Calls.minimize() }
    addView(minimizeButton)

    keyLabel.includeFontPadding = false
    keyLabel.gravity = Gravity.CENTER
    keyLabel.maxLines = 1
    keyLabel.ellipsize = TextUtils.TruncateAt.END
    addView(keyLabel)

    pulse.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x59FFFFFF) }
    pulse.alpha = 0f
    addView(pulse)
    addView(avatar)
    for (label in listOf(nameLabel, statusButton, clockLabel)) { label.gravity = Gravity.CENTER; label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END }
    addView(nameLabel)
    // A tap on the status shows how the call travels (direct or through the server), its delay, losses and bitrates.
    statusButton.setOnClickListener { statsOpen = !statsOpen; refreshStatus() }
    addView(statusButton)
    statsLabel.gravity = Gravity.CENTER
    statsLabel.background = context.plate(0x59000000, 12f)
    statsLabel.setPadding(dp(12f), dp(8f), dp(12f), dp(8f))
    statsLabel.visibility = GONE
    addView(statsLabel)
    clockLabel.fontFeatureSettings = "tnum"
    clockLabel.visibility = GONE
    addView(clockLabel)

    localBox.background = context.plate(0xFF000000.toInt(), 16f)
    localBox.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, 16f * d)
    }
    localBox.clipToOutline = true
    localBox.foreground = GradientDrawable().apply { cornerRadius = 16f * d; setStroke(maxOf(1, dp(1f)), 0x66FFFFFF) }
    localBox.visibility = GONE
    localBox.contentDescription = "Повернуть"
    localBox.addView(localVideo, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    localBox.setOnTouchListener(LocalTouch())
    addView(localBox)
  }

  /** What lies behind everything: the person's colour over black; their picture, blurred and dimmed, when they
   *  have one; in the debug build's samples — the other side's «camera», drawn in the person's colours. */
  private inner class Backdrop(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var blurredOf: Bitmap? = null
    private var blurred: Bitmap? = null
    private val place = RectF()

    override fun onDraw(canvas: Canvas) {
      val call = shown ?: return
      val w = width.toFloat(); val h = height.toFloat()
      val color = call.peer.avatarColor and 0x00FFFFFF
      val address = Calls.pictureAddress(call.peer)
      // The store draws this view again when the picture has come.
      val face = if (call.peer.avatarId.isNotEmpty() && address.isNotEmpty()) AvatarStore.get(context, call.peer.avatarId, address, this) else null
      if (face == null) {
        // Without a photo: their colour over the ambient, fading down to nothing (CC → 55 → clear).
        paint.shader = LinearGradient(0f, 0f, 0f, h, intArrayOf(color or (0xCC shl 24), color or (0x55 shl 24), color), null, Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
      } else {
        if (blurredOf !== face) {
          // The reference's `blurRadius={60}`: a Gaussian of 60 of the picture's own pixels.
          blurred = try { gaussian(face, 60f) } catch (_: Throwable) { null }
          blurredOf = face
        }
        blurred?.let { soft ->
          // 1.25 times the screen (`scale: 1.25` over a cover fit).
          val scale = maxOf(w / soft.width, h / soft.height) * 1.25f
          place.set((w - soft.width * scale) / 2, (h - soft.height * scale) / 2, (w + soft.width * scale) / 2, (h + soft.height * scale) / 2)
          canvas.drawBitmap(soft, null, place, paint)
        }
      }
      paint.color = 0x52000000
      canvas.drawRect(0f, 0f, w, h, paint)
      if (Calls.isDemo && showsVideo) {
        paint.shader = LinearGradient(0f, 0f, w, h, color or (0xFF shl 24), 0xFF10131A.toInt(), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
      }
      paint.color = 0xFF000000.toInt()
    }
  }

  /** A Gaussian blur of `sigma` px of `source`: the picture made 4 times smaller, then three box passes each way
   *  (the usual stand-in for a Gaussian, as the image libraries do), drawn back at its size. */
  private fun gaussian(source: Bitmap, sigma: Float): Bitmap {
    val step = 4
    val w = maxOf(1, source.width / step); val h = maxOf(1, source.height / step)
    val small = Bitmap.createScaledBitmap(source, w, h, true).copy(Bitmap.Config.ARGB_8888, true)
    val s = sigma / step
    // Three boxes whose sum of variances is s²: the box width from the standard formula.
    val box = maxOf(1, Math.round(Math.sqrt(12.0 * s * s / 3 + 1)).toInt()) or 1
    val radius = box / 2
    val pixels = IntArray(w * h)
    small.getPixels(pixels, 0, w, 0, 0, w, h)
    val spare = IntArray(w * h)
    repeat(3) {
      boxPass(pixels, spare, w, h, radius, true)
      boxPass(spare, pixels, w, h, radius, false)
    }
    small.setPixels(pixels, 0, w, 0, 0, w, h)
    return small
  }

  private fun boxPass(from: IntArray, to: IntArray, w: Int, h: Int, radius: Int, across: Boolean) {
    val lines = if (across) h else w; val length = if (across) w else h
    val span = radius * 2 + 1
    for (line in 0 until lines) {
      var a = 0; var r = 0; var g = 0; var b = 0
      fun at(i: Int): Int { val k = i.coerceIn(0, length - 1); return if (across) from[line * w + k] else from[k * w + line] }
      for (i in -radius..radius) { val p = at(i); a += p ushr 24; r += (p shr 16) and 255; g += (p shr 8) and 255; b += p and 255 }
      for (i in 0 until length) {
        val index = if (across) line * w + i else i * w + line
        to[index] = ((a / span) shl 24) or ((r / span) shl 16) or ((g / span) shl 8) or (b / span)
        val out = at(i - radius); val inn = at(i + radius + 1)
        a += (inn ushr 24) - (out ushr 24); r += ((inn shr 16) and 255) - ((out shr 16) and 255)
        g += ((inn shr 8) and 255) - ((out shr 8) and 255); b += (inn and 255) - (out and 255)
      }
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    syncClock()
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(clock)
    clockRuns = false
    pulsing?.cancel()
    pulsing = null
    super.onDetachedFromWindow()
  }

  private fun openAudio() {
    if (audioPanel != null) return
    val panel = CallAudioPanel(context) { closeAudio() }
    audioPanel = panel
    addView(panel)
    requestLayout()
  }

  private fun closeAudio() {
    val panel = audioPanel ?: return
    audioPanel = null
    removeView(panel)
  }

  /** The screen leaves: its pictures are let go, its clock stops. */
  fun retire() {
    closeAudio()
    removeCallbacks(clock)
    clockRuns = false
    setPulse(false)
    remoteVideo.showRemote(null)
    localVideo.showLocal(null)
  }

  // What is shown

  private val showsVideo: Boolean get() = shown?.let { it.video && it.remoteVideo } ?: false
  private val showsLocal: Boolean get() = shown?.let { it.video && it.localVideo && !it.cameraOff } ?: false

  fun update(call: CallState) {
    val before = shown
    val peerChanged = before == null || before.peer.id != call.peer.id || before.peer.avatarId != call.peer.avatarId || before.peer.avatarColor != call.peer.avatarColor
    shown = call
    if (peerChanged) avatar.show(call.peer, Calls.pictureAddress(call.peer))
    nameLabel.text = call.peer.displayName

    // The key of the call, or — before it is known — what protects it.
    val key = call.key
    if (key != null) {
      keyLabel.text = key.joinToString(" ")
      keyLabel.setCompoundDrawables(IonIcon.drawable(context, "lock-closed", dp(13f), 0xFFFFFFFF.toInt()).apply { setBounds(0, 0, dp(13f), dp(13f)) }, null, null, null)
      keyLabel.compoundDrawablePadding = dp(6f)
      keyLabel.setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
      keyLabel.textSize = 15f
      keyLabel.letterSpacing = 2f / 15f
      keyLabel.setTextColor(0xFFFFFFFF.toInt())
      keyLabel.background = context.plate(0x2E000000, 16f)
      keyLabel.contentDescription = "Ключ звонка: " + key.joinToString(" ")
    } else {
      keyLabel.text = "🔒 Звонок защищён сквозным шифрованием"
      keyLabel.setCompoundDrawables(null, null, null, null)
      keyLabel.setPadding(0, 0, 0, 0)
      keyLabel.textSize = 12f
      keyLabel.letterSpacing = 0f
      keyLabel.setTextColor(0xCCFFFFFF.toInt())
      keyLabel.background = null
      keyLabel.contentDescription = null
    }

    minimizeButton.visibility = if (call.status != "incoming" && !call.isOver) VISIBLE else GONE
    if (call.status == "incoming" || call.isOver) closeAudio()

    // In the debug build's samples the pictures are drawn in the person's colours: nothing is filmed.
    if (Calls.isDemo) {
      remoteVideo.visibility = GONE
      localVideo.visibility = GONE
      localBox.background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xFF3A3F4B.toInt(), 0xFF14161B.toInt())).apply { cornerRadius = 16f * d }
    } else {
      remoteVideo.visibility = if (showsVideo) VISIBLE else GONE
      remoteVideo.showRemote(if (showsVideo) Calls.media else null)
      localVideo.visibility = VISIBLE
      localVideo.showLocal(if (showsLocal) Calls.media else null)
    }
    localBox.visibility = if (showsLocal) VISIBLE else GONE

    val ringing = call.status == "ringing" || call.status == "incoming" || call.status == "requesting"
    setPulse(ringing && !showsVideo)
    avatar.visibility = if (showsVideo) GONE else VISIBLE
    nameLabel.textSize = if (showsVideo) 18f else 28f

    rebuildButtons(call)
    refreshStatus()
    syncClock()
    backdrop.invalidate()
    requestLayout()
  }

  private fun syncClock() {
    val wanted = shown?.status == "active" && isAttachedToWindow
    if (wanted == clockRuns) return
    clockRuns = wanted
    removeCallbacks(clock)
    if (wanted) postDelayed(clock, 1000)
  }

  /** The status under the name; a weak link is said in words next to it, so it is clear the trouble is the
   *  network and not the app. With the diagnostics open — how the call travels. */
  private fun refreshStatus() {
    val call = shown ?: return
    val status = CallRules.status(call, Calls.signalNetwork)
    val reconnecting = call.status == "active" && call.reconnecting
    val words = statusWords(call, status, CallRules.linkWords(call.grade).takeIf { call.status == "active" && !call.reconnecting && call.grade != "good" } ?: "", showsVideo)
    if (statusButton.text.toString() != words) statusButton.text = words
    statusButton.contentDescription = "$words. Диагностика звонка"
    clockLabel.text = status.clock ?: ""
    clockLabel.visibility = if (reconnecting && !showsVideo) VISIBLE else GONE
    // An ended call of the preview build: what it went through, in one grey line (CallReport.kt).
    val report = if (call.isOver) Calls.endReport else null
    val lines = if (report != null) listOf(report) else if (statsOpen && call.status == "active") Calls.linkLines else emptyList()
    statsLabel.setTextColor(if (report != null) 0x99FFFFFF.toInt() else 0xE6FFFFFF.toInt())
    statsLabel.text = lines.joinToString("\n")
    val wanted = if (lines.isEmpty()) GONE else VISIBLE
    if (statsLabel.visibility != wanted) statsLabel.visibility = wanted
    requestLayout()
  }

  private fun rebuildButtons(call: CallState) {
    // Built again only when the set of buttons or what they show changes.
    val key = CallRules.buttons(call).joinToString("|") + (if (call.video) "|video" else "|audio") + (if (call.cameraOff) "|off" else "|on") +
      (if (call.muted) "|muted" else "|heard") + (if (call.speaker) "|loud" else "|quiet") + (if (call.isOver && Calls.endReport != null) "|report" else "")
    if (key == buttonsKey) return
    buttonsKey = key
    for (old in buttons) removeView(old)
    val red = 0xFFFF3B30.toInt(); val green = 0xFF34C759.toInt()
    val callSymbol = if (call.video) "videocam" else "call"
    val made = ArrayList<CallRoundButton>()
    fun add(symbol: String, words: String, active: Boolean = false, color: Int? = null, press: () -> Unit) {
      made.add(CallRoundButton(context, symbol, words, active, color).also { it.onPress = press })
    }
    if (call.status == "incoming") {
      add("close", "Отклонить", color = red) { Calls.hangup() }
      add(callSymbol, "Ответить", color = green) { Calls.accept() }
    } else if (call.isOver) {
      if (call.retry) {
        add("close", "Закрыть") { Calls.close() }
        add(callSymbol, "Повторить", color = green) { Calls.retry() }
      } else if (Calls.endReport != null) {
        // The preview build keeps a call that did not come up on the screen for a while (its grey line): it can be put away.
        add("close", "Закрыть") { Calls.close() }
      }
    } else {
      val cameraOn = call.video && !call.cameraOff
      // «Звук»: the device of this call (CallAudioPanel.kt), as the reference on Android.
      add("volume-high", "Звук", active = call.speaker) { openAudio() }
      add(if (cameraOn) "videocam" else "videocam-off", "Видео", active = cameraOn) { Calls.toggleCamera() }
      if (cameraOn) add("camera-reverse", "Повернуть") { Calls.flipCamera() }
      add(if (call.muted) "mic-off" else "mic", if (call.muted) "Звук выкл" else "Убрать звук", active = call.muted) { Calls.toggleMute() }
      add("close", "Завершить", color = red) { Calls.hangup() }
    }
    buttons = made
    for (button in made) addView(button)
  }

  private fun setPulse(on: Boolean) {
    if (on == (pulsing != null)) return
    pulsing?.cancel()
    pulsing = null
    pulse.alpha = 0f
    pulse.scaleX = 1f; pulse.scaleY = 1f
    if (!on) return
    pulsing = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 1400
      repeatCount = ValueAnimator.INFINITE
      interpolator = DecelerateInterpolator()
      addUpdateListener { step ->
        val t = step.animatedValue as Float
        pulse.scaleX = 1f + 0.35f * t; pulse.scaleY = 1f + 0.35f * t
        pulse.alpha = 0.45f * (1f - t)
      }
      start()
    }
  }

  // Places

  override fun place(width: Int, height: Int) {
    val top = edges.top + dp(10f); val bottom = edges.bottom + dp(24f)
    put(backdrop, 0, 0, width, height)
    put(remoteVideo, 0, 0, width, height)
    put(minimizeButton, dp(16f), edges.top + dp(6f), dp(40f), dp(40f))

    // With the key: its own padding (12 × 6) around the lock and the emoji; before it — the words, centred in 34, a
    // plain line in the reference with all the width between the «Свернуть» buttons' columns (cut short at
    // width − 140 they lost their end).
    val keyed = shown?.key != null
    val room = if (keyed) width - dp(140f) else maxOf(0, width - 2 * dp(16f + 40f))
    keyLabel.measure(MeasureSpec.makeMeasureSpec(room, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val pillWidth = if (keyed) minOf(room, keyLabel.measuredWidth) else room
    put(keyLabel, (width - pillWidth) / 2, top, pillWidth, if (keyed) keyLabel.measuredHeight else dp(34f))
    put(ambient, 0, 0, width, height)
    audioPanel?.let { it.bottomInset = edges.bottom; put(it, 0, 0, width, height) }

    val buttonsTop = height - bottom - dp(88f)
    if (buttons.isNotEmpty()) {
      val inset = if (buttons.size <= 2) dp(30f) else dp(8f)
      val wide = if (buttons.size > 4) dp(68f) else dp(76f)
      // Spread evenly: the first at the left edge, the last at the right one.
      val gap = if (buttons.size > 1) (width - inset * 2 - wide * buttons.size).toFloat() / (buttons.size - 1) else 0f
      val first = if (buttons.size > 1) inset.toFloat() else (width - wide) / 2f
      buttons.forEachIndexed { index, button -> put(button, Math.round(first + index * (wide + gap)), buttonsTop, wide, dp(88f)) }
    }

    var statsWidth = 0; var statsHeight = 0
    if (statsLabel.visibility == VISIBLE) {
      statsLabel.measure(MeasureSpec.makeMeasureSpec(width - dp(48f), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      statsWidth = statsLabel.measuredWidth; statsHeight = statsLabel.measuredHeight
    }
    if (showsVideo) {
      // The other side's camera fills the screen: the name and the status sit above the buttons.
      var y = buttonsTop - dp(14f)
      if (statsHeight > 0) {
        y -= statsHeight
        put(statsLabel, (width - statsWidth) / 2, y, statsWidth, statsHeight)
        y -= dp(6f)
      }
      y -= dp(22f)
      put(statusButton, dp(24f), y, width - dp(48f), dp(22f))
      y -= dp(24f)
      put(nameLabel, dp(24f), y, width - dp(48f), dp(24f))
    } else {
      val block = dp(170f + 14f + 34f + 14f + 22f)
      var y = maxOf(top + dp(44f), (top + dp(34f) + buttonsTop - block) / 2)
      put(pulse, (width - dp(140f)) / 2, y + dp(15f), dp(140f), dp(140f))
      put(avatar, (width - dp(130f)) / 2, y + dp(20f), dp(130f), dp(130f))
      y += dp(170f + 14f)
      put(nameLabel, dp(24f), y, width - dp(48f), dp(34f))
      y += dp(34f + 14f)
      put(statusButton, dp(24f), y, width - dp(48f), dp(22f))
      y += dp(22f + 6f)
      if (statsHeight > 0) {
        put(statsLabel, (width - statsWidth) / 2, y, statsWidth, statsHeight)
        y += statsHeight + dp(8f)
      }
      put(clockLabel, dp(24f), y + dp(8f), width - dp(48f), dp(18f))
    }

    // This phone's own picture: the upper right corner, or where it was dragged to.
    val localWidth = Math.round(width * 0.28f); val localHeight = Math.round(localWidth * 4f / 3f)
    val home = Pair(width - dp(16f) - localWidth / 2f, edges.top + dp(56f) + localHeight / 2f)
    val centre = keptInside(localCentre ?: home, localWidth, localHeight)
    put(localBox, Math.round(centre.first - localWidth / 2f), Math.round(centre.second - localHeight / 2f), localWidth, localHeight)
  }

  private fun keptInside(centre: Pair<Float, Float>, wide: Int, tall: Int): Pair<Float, Float> {
    val left = dp(12f) + wide / 2f; val right = width - dp(12f) - wide / 2f
    val high = edges.top + dp(8f) + tall / 2f; val low = height - edges.bottom - dp(130f) - tall / 2f
    return Pair(minOf(maxOf(centre.first, left), maxOf(left, right)), minOf(maxOf(centre.second, high), maxOf(high, low)))
  }

  // Touches

  /** The small picture: a touch turns the camera, a drag moves it; let go, it settles at the nearer side. */
  private inner class LocalTouch : OnTouchListener {
    private var lastX = 0f; private var lastY = 0f
    private var dragged = false
    private val slop = ViewConfiguration.get(context).scaledTouchSlop

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(view: View, event: MotionEvent): Boolean {
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> { lastX = event.rawX; lastY = event.rawY; dragged = false; parent?.requestDisallowInterceptTouchEvent(true) }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - lastX; val dy = event.rawY - lastY
          if (!dragged && abs(dx) < slop && abs(dy) < slop) return true
          dragged = true
          lastX = event.rawX; lastY = event.rawY
          localCentre = keptInside(Pair(view.left + view.width / 2f + dx, view.top + view.height / 2f + dy), view.width, view.height)
          requestLayout()
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          if (!dragged) { if (event.actionMasked == MotionEvent.ACTION_UP) Calls.flipCamera(); return true }
          val centreX = view.left + view.width / 2f
          val side = if (centreX < width / 2f) dp(12f) + view.width / 2f else width - dp(12f) - view.width / 2f
          localCentre = Pair(side, view.top + view.height / 2f)
          // The box is put at its new place and slides there from where the finger left it.
          view.translationX = centreX - side
          view.animate().translationX(0f).setDuration(250).setInterpolator(DecelerateInterpolator()).start()
          requestLayout()
        }
      }
      return true
    }
  }

  // Pulled down far or fast enough, the call is minimised (the same as the chevron).
  private var pullY = 0f
  private var pullX = 0f
  private var pulling = false
  private var speed: VelocityTracker? = null

  private fun mayPull(): Boolean = shown?.let { it.status != "incoming" && !it.isOver } ?: false

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { pullX = event.rawX; pullY = event.rawY; pulling = false }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.rawX - pullX; val dy = event.rawY - pullY
        if (mayPull() && dy > ViewConfiguration.get(context).scaledTouchSlop && dy > abs(dx)) {
          pulling = true
          speed = VelocityTracker.obtain()
          return true
        }
      }
    }
    return false
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) { pullX = event.rawX; pullY = event.rawY; pulling = mayPull(); if (pulling) speed = VelocityTracker.obtain() }
    if (!pulling) return true
    speed?.addMovement(event)
    // The reference's useSwipeDismiss (swipeDismissModel.ts), in dp: down 1:1, up only 14 with resistance.
    val travel = (event.rawY - pullY) / d
    val offset = if (travel >= 0f) travel else -14f * (1f - Math.exp(travel / (14.0 * 3)).toFloat())
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> translationY = offset * d
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        speed?.computeCurrentVelocity(1000)
        val velocity = (speed?.yVelocity ?: 0f) / d
        speed?.recycle(); speed = null
        pulling = false
        val tall = if (height > 0) height / d else 400f
        val distance = minOf(240f, maxOf(56f, tall * 0.25f))
        val close = event.actionMasked == MotionEvent.ACTION_UP && offset > 0f && velocity > -400f && ((velocity >= 1000f && offset >= 8f) || offset >= distance)
        if (close) {
          // Out of sight below (out-quad, 120…280 ms by the speed), then minimised.
          val target = maxOf(tall, ((parent as? View)?.height ?: 0) / d) + 24f
          val left = maxOf(0f, target - maxOf(0f, offset))
          val duration = Math.round(maxOf(120f, minOf(280f, left / maxOf(1200f, velocity) * 1000f))).toLong()
          animate().translationY(target * d).setDuration(duration).setInterpolator(DecelerateInterpolator()).withEndAction { Calls.minimize() }.start()
        } else {
          springBack(velocity)
        }
      }
    }
    return true
  }

  /** Back in place on the reference's spring (damping 22, stiffness 260, mass 0.8), from the finger's speed. */
  private fun springBack(velocity: Float) {
    val mass = 0.8; val stiffness = 260.0; val damping = 22.0
    var x = (translationY / d).toDouble(); var v = velocity.toDouble()
    val run = ValueAnimator.ofFloat(0f, 1f).setDuration(1200)
    var last = 0L
    run.addUpdateListener { step ->
      val now = step.currentPlayTime
      var left = (now - last).coerceIn(0L, 64L) / 1000.0
      last = now
      // Small steps of the spring's own equation (semi-implicit Euler at 1 ms).
      while (left > 0) {
        val dt = minOf(0.001, left)
        v += (-stiffness * x - damping * v) / mass * dt
        x += v * dt
        left -= dt
      }
      translationY = (x * d).toFloat()
      if (Math.abs(x) < 0.01 && Math.abs(v) < 2) { translationY = 0f; step.cancel() }
    }
    run.start()
  }

  companion object {
    /** The line under the name: the status; « · слабая связь» after it while the link is weak; in a video call
     *  that is reconnecting, the clock as well (it has no line of its own there). */
    fun statusWords(call: CallState, status: CallRules.Status, linkWords: String, showsVideo: Boolean): String {
      var words = status.text
      if (linkWords.isNotEmpty()) words += " · $linkWords"
      if (showsVideo && call.status == "active" && call.reconnecting && status.clock != null) words += " · " + status.clock
      return words
    }
  }
}
