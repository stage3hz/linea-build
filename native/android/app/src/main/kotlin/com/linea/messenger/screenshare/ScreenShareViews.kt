package com.linea.messenger.screenshare

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import com.linea.messenger.calls.CallMedia
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.profile.pages
import com.linea.messenger.rooms.RoomVoice
import com.linea.messenger.rooms.RoomVoiceState
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.shell.Screen
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.SurfaceViewRenderer
import livekit.org.webrtc.VideoTrack

/** One screen's picture: the live track drawn by WebRTC's own renderer, or (the emulator check) a drawn still. 16:9 unless
 *  told otherwise; the picture fits inside, the rest is black. (iOS ScreenShare/ScreenShareViews.swift, ScreenVideoView.) */
class ScreenVideoView(context: Context, private val ratio: Float = 9f / 16f) : FrameLayout(context) {
  private var renderer: SurfaceViewRenderer? = null
  private var track: VideoTrack? = null
  private val still = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER }

  init {
    setBackgroundColor(0xFF000000.toInt())
    background = context.plate(0xFF000000.toInt(), 10f)
    clipToOutline = true
    addView(still, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    if (ratio <= 0f) return super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = (width * ratio).toInt()
    super.onMeasure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
  }

  /** A person's screen (or this phone's own, `peer` "self"): the live track, else the emulator check's still. */
  fun show(peer: String, next: VideoTrack?) {
    if (next == null) { detach(); still.setImageBitmap(ScreenShare.demoFrames[peer]); return }
    still.setImageBitmap(null)
    if (track === next) return
    detach()
    val made = renderer ?: SurfaceViewRenderer(context).also { view ->
      try { view.init(CallMedia.egl.eglBaseContext, null) } catch (_: Throwable) {}
      view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
      addView(view, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      renderer = view
    }
    try { next.addSink(made) } catch (_: Throwable) {}
    track = next
  }

  fun showStill(image: Bitmap?) { detach(); still.setImageBitmap(image) }

  private fun detach() {
    val shown = track ?: return
    renderer?.let { try { shown.removeSink(it) } catch (_: Throwable) {} }
    track = null
  }

  override fun onDetachedFromWindow() {
    detach()
    renderer?.let { try { it.release() } catch (_: Throwable) {}; removeView(it) }
    renderer = null
    super.onDetachedFromWindow()
  }
}

/** The «Демонстрация экрана» part of a voice channel's panel: the reference's ScreenSharePanel.tsx — the two qualities (or
 *  «Остановить демонстрацию»), the warning, «Отменить запуск» while the system's question is up, the notice of what went
 *  wrong, «Твой экран», and every person's screen with their name and quality. A touch on a screen opens it on the whole
 *  screen (ScreenViewerScreen). */
class ScreenSharePanel(context: Context) : LinearLayout(context) {
  /** The name of a person by id (the community's people); null: «Участник». */
  var names: ((String) -> String?)? = null
  private val buttons = LinearLayout(context)
  private val low = ScreenShareButton(context)
  private val high = ScreenShareButton(context)
  private val stopButton = ScreenShareButton(context)
  private val cancel = context.words("Отменить запуск", 14f, Theme.accent, 500)
  private val problem = context.words("", 13f, Theme.danger)
  private val ownTitle = context.words("Твой экран", 13f, Theme.muted)
  private val ownVideo = ScreenVideoView(context)
  private val screensColumn = LinearLayout(context)
  private val tiles = HashMap<String, Triple<LinearLayout, android.widget.TextView, ScreenVideoView>>()
  private val changed: (Unit) -> Unit = { RoomVoice.state?.let { show(it) } }

  init {
    orientation = VERTICAL
    fun put(view: View, gap: Float) = addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (childCount > 0) topMargin = context.px(gap) })
    val heading = context.words("Демонстрация экрана", 15f, Theme.text, 700)
    if (android.os.Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    put(heading, 0f)
    buttons.orientation = HORIZONTAL
    for ((index, button) in listOf(low, high, stopButton).withIndex()) buttons.addView(button, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { if (index > 0) leftMargin = context.px(8f) })
    low.setOnClickListener { start(ScreenQuality.P720) }
    high.setOnClickListener { start(ScreenQuality.P1080) }
    stopButton.setOnClickListener { ScreenShare.stop() }
    put(buttons, 10f)
    put(context.words("Фактическое качество зависит от устройства и сети. Всё, что видно на экране, может попасть в трансляцию.", 12f, Theme.muted), 10f)
    cancel.isClickable = true
    cancel.minHeight = context.px(36f)
    cancel.gravity = Gravity.CENTER_VERTICAL
    cancel.setOnClickListener { ScreenShare.stop() }
    put(cancel, 10f)
    problem.setOnClickListener { ScreenShare.clearError() }
    put(problem, 10f)
    put(ownTitle, 10f)
    put(ownVideo, 4f)
    screensColumn.orientation = VERTICAL
    put(screensColumn, 10f)
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); ScreenShare.changed.watch(changed) }
  override fun onDetachedFromWindow() { ScreenShare.changed.unwatch(changed); super.onDetachedFromWindow() }

  private fun start(quality: ScreenQuality) {
    val activity = context as? Activity ?: return
    ScreenShare.start(activity, quality) { }
  }

  fun show(voice: RoomVoiceState) {
    val connected = voice.status == "connected"
    val sharing = ScreenShare.sharing != null
    val starting = ScreenShare.starting
    low.visibility = if (sharing) GONE else VISIBLE
    high.visibility = if (sharing) GONE else VISIBLE
    stopButton.visibility = if (sharing) VISIBLE else GONE
    // Alone in the row (the two qualities are hidden while sharing) it starts at the card's edge like everything
    // else: no 8 dp gap before it.
    (stopButton.layoutParams as? LayoutParams)?.let { params -> val gap = if (sharing) 0 else context.px(8f); if (params.leftMargin != gap) { params.leftMargin = gap; stopButton.layoutParams = params } }
    low.show(ScreenQuality.P720.label, danger = false, enabled = !starting && connected, dim = starting)
    high.show(ScreenQuality.P1080.label, danger = false, enabled = !starting && connected, dim = starting)
    stopButton.show("Остановить демонстрацию", danger = true, enabled = true, dim = false)
    cancel.visibility = if (starting) VISIBLE else GONE
    problem.text = ScreenShare.error
    problem.visibility = if (ScreenShare.error.isEmpty()) GONE else VISIBLE
    val own = sharing && (ScreenShare.localTrack != null || ScreenShare.isDemo)
    ownTitle.visibility = if (own) VISIBLE else GONE
    ownVideo.visibility = if (own) VISIBLE else GONE
    if (own) ownVideo.show("self", ScreenShare.localTrack)
    val screens = ScreenShare.screens
    val wanted = screens.map { it.peer }.toSet()
    for (peer in tiles.keys.toList()) if (peer !in wanted) { tiles.remove(peer)?.let { screensColumn.removeView(it.first) } }
    for ((index, screen) in screens.withIndex()) {
      val tile = tiles[screen.peer] ?: makeTile(screen.peer)
      val name = names?.invoke(screen.userId)?.takeIf { it.isNotEmpty() } ?: "Участник"
      tile.second.text = name + " · " + screen.quality.label
      tile.first.contentDescription = "Экран: $name"
      tile.third.show(screen.peer, screen.track)
      if (screensColumn.indexOfChild(tile.first) != index) {
        screensColumn.removeView(tile.first)
        screensColumn.addView(tile.first, minOf(index, screensColumn.childCount), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { if (index > 0) topMargin = context.px(10f) })
      }
    }
    screensColumn.visibility = if (screens.isEmpty()) GONE else VISIBLE
  }

  private fun makeTile(peer: String): Triple<LinearLayout, android.widget.TextView, ScreenVideoView> {
    val box = LinearLayout(context).apply { orientation = VERTICAL; isClickable = true; isFocusable = true }
    val title = context.words("", 14f, Theme.text, 500)
    val video = ScreenVideoView(context)
    box.addView(title)
    box.addView(video, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(4f) })
    box.setOnClickListener { pages()?.push(ScreenViewerScreen(context, peer, names)) }
    val tile = Triple(box, title, video)
    tiles[peer] = tile
    return tile
  }
}

/** A button of the panel: «720p · 60 FPS» in the accent's soft colour, «Остановить демонстрацию» in red. */
class ScreenShareButton(context: Context) : FrameLayout(context) {
  private val words = context.words("", 14f, Theme.accent, 600).apply { gravity = Gravity.CENTER; maxLines = 1 }

  init {
    addView(words, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { topMargin = context.px(12f); bottomMargin = context.px(12f); leftMargin = context.px(8f); rightMargin = context.px(8f) })
    isClickable = true
    isFocusable = true
  }

  fun show(text: String, danger: Boolean, enabled: Boolean, dim: Boolean) {
    words.text = text
    words.setTextColor(if (danger) 0xFFFFFFFF.toInt() else Theme.accent)
    background = context.plate(if (danger) Theme.danger else ThemeStore.look.accentSoft, 12f)
    isEnabled = enabled
    alpha = if (dim) 0.5f else 1f
    contentDescription = text
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun setPressed(pressed: Boolean) { super.setPressed(pressed); if (isEnabled) alpha = if (pressed) 0.7f else 1f }
}

/** A person's screen on the whole phone screen: pinch or double-tap to look closer, «Повернуть» for a computer's wide
 *  screen (the app itself stays upright), the name and the quality on top, «Закрыть». Closes by itself when the person
 *  stops sharing. */
@SuppressLint("ViewConstructor")
class ScreenViewerScreen(context: Context, private val peer: String, private val names: ((String) -> String?)?) : Screen(context) {
  private val holder = FrameLayout(context)
  private val video = ScreenVideoView(context, ratio = 0f)
  // The iPhone's top strip (ScreenShareViews.swift `ScreenViewerController`): black at 0.45 under the status bar and
  // 52 more, ✕ (Ionicons close 22) at the left, the name and the quality centred, the turn (phone-landscape-outline)
  // at the right.
  private val strip = View(context).apply { setBackgroundColor(0x73000000) }
  private val title = context.words("", 15f, 0xFFFFFFFF.toInt(), 600).apply { gravity = Gravity.CENTER; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
  private val close = com.linea.messenger.chatactions.ChatIconView(context, "ion:close", 22f, 0xFFFFFFFF.toInt()).apply { contentDescription = "Закрыть" }
  private val turn = com.linea.messenger.chatactions.ChatIconView(context, "ion:phone-landscape-outline", 22f, 0xFFFFFFFF.toInt()).apply { contentDescription = "Повернуть" }
  private var turned = false
  private var zoom = 1f
  private val changed: (Unit) -> Unit = { refresh() }
  private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScale(detector: ScaleGestureDetector): Boolean { zoom = (zoom * detector.scaleFactor).coerceIn(1f, 4f); apply(); return true }
  })
  private val taps = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDoubleTap(e: MotionEvent): Boolean { zoom = if (zoom > 1.01f) 1f else 2.5f; apply(); return true }
    override fun onSingleTapConfirmed(e: MotionEvent): Boolean { val shown = title.visibility != VISIBLE; for (v in listOf(strip, title, close, turn)) v.visibility = if (shown) VISIBLE else GONE; return true }
  })

  init {
    setBackgroundColor(0xFF000000.toInt())
    isClickable = true
    holder.addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(holder)
    for (button in listOf(close, turn)) { button.isClickable = true; button.isFocusable = true }
    addView(strip)
    close.setOnClickListener { leave() }
    turn.setOnClickListener { turned = !turned; requestLayout() }
    addView(title); addView(close); addView(turn)
    refresh()
  }

  // The viewer covers the whole screen, the room's bar included (the iPhone presents it over everything): the bar is
  // asked again when it comes and goes.
  override fun onAttachedToWindow() { super.onAttachedToWindow(); ScreenShare.changed.watch(changed); RoomVoice.changed.watch(changed); post { com.linea.messenger.rooms.RoomOverlay.refresh() } }
  override fun onDetachedFromWindow() {
    ScreenShare.changed.unwatch(changed); RoomVoice.changed.unwatch(changed)
    android.os.Handler(android.os.Looper.getMainLooper()).post { com.linea.messenger.rooms.RoomOverlay.refresh() }
    super.onDetachedFromWindow()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean { pinch.onTouchEvent(event); taps.onTouchEvent(event); return true }

  private fun apply() { holder.scaleX = zoom; holder.scaleY = zoom }

  private fun leave() { pages()?.let { if (it.top === this) it.pop() } }

  private fun refresh() {
    val screen = ScreenShare.screens.firstOrNull { it.peer == peer } ?: return leave()
    val name = names?.invoke(screen.userId)?.takeIf { it.isNotEmpty() } ?: "Участник"
    title.text = name + " · " + screen.quality.label
    video.show(peer, screen.track)
  }

  override fun place(width: Int, height: Int) {
    if (turned) {
      put(holder, (width - height) / 2, (height - width) / 2, height, width)
      holder.rotation = 90f
    } else {
      holder.rotation = 0f
      put(holder, 0, 0, width, height)
    }
    val inset = edges.top
    put(strip, 0, 0, width, inset + dp(52f))
    put(close, dp(8f), inset + dp(4f), dp(44f), dp(44f))
    put(turn, width - dp(52f), inset + dp(4f), dp(44f), dp(44f))
    put(title, dp(60f), inset + dp(4f), maxOf(0, width - dp(120f)), dp(44f))
  }
}

/** The room's screen: whoever shares their screen there, as small live pictures under the room's bar; a touch opens the
 *  picture on the whole screen. (The reference's rooms show no panel of their own; a computer in a room can still share,
 *  and this is where it is seen.) */
class ScreenShareStrip(context: Context, private val roomId: String, private val name: (String) -> String) : LinearLayout(context) {
  private val chips = HashMap<String, Pair<LinearLayout, ScreenVideoView>>()
  private val changed: (Unit) -> Unit = { refresh() }

  init { orientation = HORIZONTAL; refresh() }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); ScreenShare.changed.watch(changed); RoomVoice.changed.watch(changed); refresh() }
  override fun onDetachedFromWindow() { ScreenShare.changed.unwatch(changed); RoomVoice.changed.unwatch(changed); super.onDetachedFromWindow() }

  fun refresh() {
    val here = RoomVoice.state?.roomId == roomId
    val screens = if (here) ScreenShare.screens else emptyList()
    val wanted = screens.map { it.peer }.toSet()
    for (peer in chips.keys.toList()) if (peer !in wanted) chips.remove(peer)?.let { removeView(it.first) }
    for (screen in screens) {
      val chip = chips[screen.peer] ?: run {
        val box = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; background = context.plate(Theme.surface2, 14f); setPadding(context.px(6f), context.px(6f), context.px(12f), context.px(6f)); isClickable = true }
        val video = ScreenVideoView(context, ratio = 0f)
        box.addView(video, LayoutParams(context.px(64f), context.px(36f)))
        val words = LinearLayout(context).apply { orientation = VERTICAL }
        words.addView(context.words("", 13f, Theme.text, 600).apply { tag = "name"; maxLines = 1 })
        words.addView(context.words("показывает экран", 11f, Theme.muted))
        box.addView(words, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { leftMargin = context.px(8f) })
        // The monitor after the words (iOS ScreenShareViews.swift: Ionicons desktop-outline 13 in the accent), 10 in
        // from the chip's end.
        box.addView(com.linea.messenger.chatactions.ChatIconView(context, "ion:desktop-outline", 13f, Theme.accent), LayoutParams(context.px(13f), context.px(13f)).apply { leftMargin = context.px(8f) })
        box.setPadding(context.px(6f), context.px(6f), context.px(10f), context.px(6f))
        box.setOnClickListener { pages()?.push(ScreenViewerScreen(context, screen.peer) { id -> name(id) }) }
        addView(box, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { if (childCount > 0) leftMargin = context.px(8f) })
        Pair(box, video).also { chips[screen.peer] = it }
      }
      (chip.first.findViewWithTag<android.widget.TextView>("name"))?.text = name(screen.userId)
      chip.first.contentDescription = "Экран: " + name(screen.userId)
      chip.second.show(screen.peer, screen.track)
    }
    visibility = if (screens.isEmpty()) GONE else VISIBLE
  }
}
