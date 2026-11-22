package com.linea.messenger.rooms

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.calls.CallHost
import com.linea.messenger.calls.Calls
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.shell.Screen
import java.lang.ref.WeakReference

/** A sheet of glass with rounded corners (the reference's `GlassSurface`): the ring's banner and the room's bar are
 *  made of it. Over every page there is nothing to blur from: the glass is its dense fill. */
abstract class RoomGlassView(context: Context, private val radius: Float) : RoomPartsView(context) {
  private val glass = Glass(this).apply {
    plain = Theme.alpha(Theme.surface2, 0.97f)
    tint = Theme.alpha(Theme.surface2, 0.7f)
    rim = Theme.veil(0.12f)
  }

  init { setWillNotDraw(false) }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
  override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), radius * d)
}

/** «Зовёт в комнату» over any page (the reference's `RoomsHost`): who calls, how many are inside already, «Не сейчас»
 *  and «Зайти». Goes by itself after half a minute. */
class RoomRingBanner(context: Context) : RoomGlassView(context, 26f) {
  private val avatar = PersonAvatarView(context)
  private val nameLabel = context.words("", 15.5f, Theme.text, 700)
  private val lineLabel = context.words("", 13f, RoomRules.talk)
  private val laterButton = RoomIconView(context, "xmark", 20f, Theme.text)
  private val enterButton = context.words("Зайти", 14f, 0xFF04210F.toInt(), 700)

  init {
    for (label in listOf(nameLabel, lineLabel)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.gravity = Gravity.CENTER_VERTICAL }
    laterButton.background = context.plate(0, 21f, Theme.veil(0.18f))
    laterButton.contentDescription = "Не сейчас"
    laterButton.isClickable = true
    laterButton.setOnClickListener { Rooms.dismissRing() }
    enterButton.gravity = Gravity.CENTER
    enterButton.background = context.plate(RoomRules.talk, 21f)
    enterButton.contentDescription = "Зайти в комнату"
    enterButton.isClickable = true
    enterButton.setOnClickListener { Rooms.answerRing() }
    for (part in listOf(avatar, nameLabel, lineLabel, laterButton, enterButton)) addView(part)
    isClickable = true
  }

  val shownName: String get() = nameLabel.text.toString()
  val shownLine: String get() = lineLabel.text.toString()

  fun show(ring: RoomRing, room: Room?) {
    avatar.show(ring.from, Rooms.pictureAddress(ring.from))
    nameLabel.text = RoomRules.callerName(ring.from)
    var line = "зовёт в комнату"
    if (room != null) line += " · " + RoomRules.insideLine(room.inside.size)
    lineLabel.text = line
    requestLayout()
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    put(avatar, dp(10f), dp(10f), dp(46f), dp(46f))
    val enterWide = wideOf(enterButton) + dp(32f)
    put(enterButton, width - dp(10f) - enterWide, dp(12f), enterWide, dp(42f))
    val laterLeft = width - dp(10f) - enterWide - dp(12f) - dp(42f)
    put(laterButton, laterLeft, dp(12f), dp(42f), dp(42f))
    val left = dp(68f)
    val wide = laterLeft - dp(12f) - left
    put(nameLabel, left, dp(13f), wide, dp(20f))
    put(lineLabel, left, dp(35f), wide, dp(18f))
  }
}

/** The strip shown over every page while this phone is inside a room and the room's own screen is not the one on
 *  top (the reference's `VoiceBar`): the state of the voice, the room's name and how many are inside; a tap opens
 *  the room; the microphone and the way out are on the right. */
class RoomBarView(context: Context) : RoomGlassView(context, 18f) {
  private val opener = object : RoomPartsView(context) {
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val width = r - l; val height = b - t
      put(dot, dp(12f), (height - dp(8f)) / 2, dp(8f), dp(8f))
      put(heading, dp(29f), dp(7f), width - dp(29f), dp(17f))
      put(words, dp(29f), dp(25f), width - dp(29f), dp(16f))
    }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  }
  private val dot = View(context)
  private val heading = context.words("", 13f, Theme.muted, 700)
  private val words = context.words("", 12f, Theme.muted)
  private val micButton = RoomIconView(context, "ion:mic", 21f, Theme.text).apply { background = com.linea.messenger.design.GlassDrawable(this) }
  private val leaveButton = RoomIconView(context, "ion:call", 18f, 0xFFFFFFFF.toInt())
  /** ScreenShare: «Остановить демонстрацию» while this phone shares its screen (the reference's VoiceBar). */
  private val stopShareButton = object : View(context) {
    init { background = com.linea.messenger.design.GlassDrawable(this) }
    override fun onDraw(canvas: android.graphics.Canvas) {
      // `IconButton` «stop-circle-outline» 23 in the danger colour, on clear glass.
      com.linea.messenger.design.IonIcon.draw(canvas, "stop-circle-outline", width / 2f, height / 2f, 23f * resources.displayMetrics.density, Theme.danger)
    }
  }
  private var roomId = ""

  init {
    for (label in listOf(heading, words)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    opener.addView(dot)
    opener.addView(heading)
    opener.addView(words)
    opener.isClickable = true
    opener.setOnClickListener { RoomRouter.open(roomId) }
    addView(opener)
    micButton.isClickable = true
    micButton.setOnClickListener { RoomVoice.toggleMute() }
    addView(micButton)
    leaveButton.background = context.plate(0xFFFF4D5E.toInt(), 20f)
    leaveButton.contentDescription = "Отключиться"
    leaveButton.isClickable = true
    leaveButton.setOnClickListener { Rooms.exit() }
    addView(leaveButton)
    stopShareButton.contentDescription = "Остановить демонстрацию" // ScreenShare
    stopShareButton.isClickable = true
    stopShareButton.setOnClickListener { com.linea.messenger.screenshare.ScreenShare.stop() }
    stopShareButton.visibility = GONE
    addView(stopShareButton)
  }

  val shownHeading: String get() = heading.text.toString()
  val shownLine: String get() = words.text.toString()
  val micWords: String get() = micButton.contentDescription?.toString() ?: ""

  fun show(voice: RoomVoiceState) {
    roomId = voice.roomId
    val connected = voice.status == "connected"
    val green = 0xFF2FD27A.toInt()
    dot.background = context.plate(if (connected) green else 0xFFF5C542.toInt(), 4f)
    heading.text = if (connected) "Голосовая связь" else "Подключение…"
    heading.setTextColor(if (connected) green else Theme.muted)
    words.text = RoomRules.barLine(voice)
    opener.contentDescription = "Комната " + voice.name
    micButton.symbol = if (voice.muted) "ion:mic-off" else "ion:mic"
    micButton.color = if (voice.muted) Theme.danger else Theme.text
    micButton.ink = Theme.surface2
    micButton.contentDescription = if (voice.muted) "Включить микрофон" else "Выключить микрофон"
    stopShareButton.visibility = if (com.linea.messenger.screenshare.ScreenShare.sharing == null) GONE else VISIBLE // ScreenShare
    requestLayout()
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l; val height = b - t
    // paddingRight 4, gap 8: the way out (40), the microphone and the stop button (`IconButton`, 44 each).
    val leaveLeft = width - dp(4f) - dp(40f)
    put(leaveButton, leaveLeft, (height - dp(40f)) / 2, dp(40f), dp(40f))
    val micLeft = leaveLeft - dp(8f) - dp(44f)
    put(micButton, micLeft, (height - dp(44f)) / 2, dp(44f), dp(44f))
    // ScreenShare: the stop button left of the microphone while sharing.
    val stopLeft = micLeft - dp(8f) - dp(44f)
    put(stopShareButton, stopLeft, (height - dp(44f)) / 2, dp(44f), dp(44f))
    put(opener, 0, 0, (if (stopShareButton.visibility == VISIBLE) stopLeft else micLeft) - dp(8f), height)
  }

  companion object {
    /** The bar's height, dp. */
    const val TALL = 48f
  }
}

/** What the room's ring and bar are shown in, above the app's own pages (and under the calls'). A touch that lands
 *  on neither goes through to the app underneath. */
@SuppressLint("ViewConstructor")
class RoomHost(context: Context) : Screen(context) {
  val banner = RoomRingBanner(context)
  val bar = RoomBarView(context)

  init {
    banner.visibility = GONE
    bar.visibility = GONE
    addView(bar)
    addView(banner)
  }

  override fun place(width: Int, height: Int) {
    put(bar, dp(12f), edges.top + dp(2f), width - dp(24f), dp(RoomBarView.TALL))
    val wide = minOf(dp(460f), Math.round(width * 0.94f))
    put(banner, (width - wide) / 2, edges.top + dp(8f), wide, dp(66f))
  }
}

/** Puts the room's ring and bar on the screen and takes them off: the ring wherever the person is in the app, the
 *  bar while this phone is inside a room whose screen is not on top (every page then starts lower by the bar's
 *  height, so nothing hides under it). Main thread. */
object RoomOverlay {
  private var window = WeakReference<Activity>(null)
  private var host: RoomHost? = null
  private var watching = false
  private var barRoom = false

  /** Begins to follow the rooms and the voice, in this window. Called by the shell. */
  fun start(context: Context) {
    val activity = context as? Activity
    if (activity != null && window.get() !== activity) {
      // Another window: what was shown in the old one is gone with it.
      host = null
      barRoom = false
      window = WeakReference(activity)
    }
    RoomRouter.attach(activity)
    if (!watching) {
      watching = true
      Rooms.changed.watch { refresh() }
      RoomVoice.changed.watch { refresh() }
      com.linea.messenger.screenshare.ScreenShare.changed.watch { refresh() } // ScreenShare: the stop button
      // The overlay of calls gives the pages their room back when a call is gone (calls/CallOverlay.kt): the
      // room's bar, if it is shown, takes its own room again right after.
      Calls.changed.watch {
        window.get()?.window?.decorView?.post {
          barRoom = false
          refresh()
        }
      }
    }
    refresh()
  }

  private fun content(): ViewGroup? {
    val activity = window.get() ?: return null
    if (activity.isFinishing || activity.isDestroyed) return null
    return activity.findViewById(android.R.id.content)
  }

  private fun makeHost(): RoomHost? {
    host?.let { if (it.parent != null) return it }
    val content = content() ?: return null
    val made = RoomHost(content.context)
    // Under the calls' own host, when there is one.
    var at = content.childCount
    for (index in 0 until content.childCount) if (content.getChildAt(index) is CallHost) { at = index; break }
    content.addView(made, at, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    host = made
    return made
  }

  /** The app's pages start lower while the bar is shown. */
  private fun setBarRoom(on: Boolean) {
    val content = content() ?: return
    val activity = window.get() ?: return
    val room = if (on) Math.round((RoomBarView.TALL + 6f) * activity.resources.displayMetrics.density) else 0
    barRoom = on
    for (index in 0 until content.childCount) {
      val page = content.getChildAt(index)
      if (page is RoomHost || page is CallHost) continue
      val place = page.layoutParams as? ViewGroup.MarginLayoutParams ?: continue
      if (place.topMargin == room) continue
      place.topMargin = room
      page.layoutParams = place
    }
  }

  /** Also asked by the room's own screen when it comes to the top or leaves it. */
  fun refresh() {
    val ring = Rooms.ring
    var voice = RoomVoice.state
    // The room's own screen has the same controls: no bar over it. A one-to-one call has its own bar.
    val top = RoomRouter.navigation()?.top
    if (voice != null && top is RoomScreen && top.roomId == voice.roomId && top.isAttachedToWindow) voice = null
    if (Calls.call != null) voice = null
    if (ring == null && voice == null) {
      if (barRoom) setBarRoom(false)
      host?.let { gone -> (gone.parent as? ViewGroup)?.removeView(gone) }
      host = null
      return
    }
    val shown = makeHost() ?: return
    if (voice != null) {
      shown.bar.show(voice)
      shown.bar.visibility = View.VISIBLE
      setBarRoom(true)
    } else {
      shown.bar.visibility = View.GONE
      if (barRoom) setBarRoom(false)
    }
    if (ring != null) {
      shown.banner.show(ring, Rooms.room(ring.roomId))
      shown.banner.visibility = View.VISIBLE
    } else shown.banner.visibility = View.GONE
    shown.requestLayout()
  }

  /** What is shown now, for the checks. */
  val shownHost: RoomHost? get() = host

  /** The room the pages give up at the top while the bar is shown, dp (the calls' bar has its own: CallBarView.room). */
  val room: Float get() = if (barRoom) RoomBarView.TALL + 6f else 0f
}
