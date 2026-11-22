package com.linea.messenger.rooms

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.Build
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.calls.CallRules
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.design.Glass
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen

/** One person's place in a room: the round picture with its ring (green while they talk, the text's colour around
 *  this account when it is inside), the crossed microphone when theirs is off, the first name under it. A member
 *  who is not inside right now is shown small and dim in their usual place. */
class RoomSeatView(context: Context) : RoomPartsView(context) {
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val avatar = PersonAvatarView(context)
  private val badge = RoomIconView(context, "mic.slash.fill", 13f, Theme.text)
  private val nameLabel = context.words("", 13f, Theme.text, 500)
  private var side = 58f
  private var ringWidth = 1.5f
  private var ringColor = 0
  /** Where the picture's middle is on the stage, px. */
  var centerX = 0
    private set
  var centerY = 0
    private set

  init {
    setWillNotDraw(false)
    badge.background = context.plate(Theme.surface2, 13f, Theme.bg)
    badge.ink = Theme.surface2
    nameLabel.gravity = Gravity.CENTER
    nameLabel.maxLines = 1
    nameLabel.ellipsize = TextUtils.TruncateAt.END
    for (part in listOf(avatar, badge, nameLabel)) { part.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO; addView(part) }
  }

  /** The words a seat says, read aloud. */
  val words: String get() = contentDescription?.toString() ?: ""
  val firstName: String get() = nameLabel.text.toString()
  val talking: Boolean get() = ringColor == RoomRules.talk && ringWidth >= 3f
  val mutedShown: Boolean get() = badge.visibility == VISIBLE

  /** `x`, `y`: where the picture's middle is on the stage, px; `side`: the picture's size, dp. */
  fun show(person: Person, mine: Boolean, present: Boolean, talking: Boolean, muted: Boolean, side: Float, x: Int, y: Int) {
    this.side = side
    centerX = x
    centerY = y
    avatar.show(person, Rooms.pictureAddress(person))
    ringWidth = if (talking) 3f else 1.5f
    ringColor = if (talking) RoomRules.talk else if (mine && present) Theme.text else 0
    badge.visibility = if (present && muted) VISIBLE else GONE
    nameLabel.text = if (mine) "ты" else RoomRules.firstName(person)
    nameLabel.setTextColor(if (present) Theme.text else Theme.muted)
    alpha = if (present) 1f else if (mine) 0.7f else 0.3f
    val state = if (present) (if (talking) ", говорит" else if (muted) ", микрофон выключен" else ", в комнате") else ", не в комнате"
    contentDescription = (if (mine) "Ты" else person.displayName) + state
    invalidate()
  }

  /** The box of a seat around its centre, px: (left, top, width, height). */
  fun frame(): IntArray {
    val box = dp(side + 56f)
    return intArrayOf(centerX - box / 2, centerY - dp(side) / 2 - dp(6f), box, dp(side + 12f + 6f + 18f))
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    val outer = dp(side + 12f)
    val face = dp(side)
    val faceLeft = (width - face) / 2
    put(avatar, faceLeft, dp(6f), face, face)
    put(badge, faceLeft + face - dp(21f), dp(6f) + face - dp(21f), dp(26f), dp(26f))
    put(nameLabel, 0, outer + dp(6f), width, dp(18f))
  }

  override fun onDraw(canvas: Canvas) {
    if (ringColor == 0) return
    // A thin ring sits a little inside the place of the thick one, so the picture never moves.
    val outer = dp(side + 12f) / 2f
    ring.color = ringColor
    ring.strokeWidth = ringWidth * d
    canvas.drawCircle(width / 2f, outer, outer - (if (ringWidth >= 3f) 0f else 1.5f * d) - ring.strokeWidth / 2, ring)
  }
}

/** The light behind the people who are inside: each has a soft glow of their own colour, a little brighter while
 *  they talk. The colours are kept quiet (little saturation, low alpha), so the stage reads as a calm room and not
 *  as a bright many-coloured gradient (as on the iPhone: RoomViewController.swift, RoomLightsView). */
class RoomLightsView(context: Context) : View(context) {
  class Light(val x: Float, val y: Float, val radius: Float, val color: Int, val strength: Float)

  companion object {
    /** How strong a person's light is: while talking and while quiet. */
    const val TALKING_STRENGTH = 0.2f
    const val QUIET_STRENGTH = 0.11f
    /** How far the light reaches, in seats. */
    const val REACH = 2.1f

    /** A person's colour (0xRRGGBB) made quiet for the light behind their seat: the same hue, far less saturated,
     *  a little lighter on a dark theme and a little deeper on a light one. Opaque 0xAARRGGBB. */
    fun calm(rgb: Int, dark: Boolean = Theme.dark): Int {
      val r = ((rgb shr 16) and 255) / 255f; val g = ((rgb shr 8) and 255) / 255f; val b = (rgb and 255) / 255f
      val top = maxOf(r, g, b); val low = minOf(r, g, b); val span = top - low
      val hue = when {
        span == 0f -> 0f
        top == r -> ((g - b) / span).let { if (it < 0f) it + 6f else it }
        top == g -> (b - r) / span + 2f
        else -> (r - g) / span + 4f
      } / 6f
      val saturation = if (top == 0f) 0f else span / top
      val quiet = minOf(saturation * 0.45f, 0.32f)
      val level = if (dark) maxOf(top, 0.72f) else minOf(maxOf(top, 0.55f), 0.78f)
      // Back from hue, saturation and brightness.
      val turn = hue * 6f; val sector = turn.toInt() % 6; val part = turn - turn.toInt()
      val p = level * (1 - quiet); val q = level * (1 - quiet * part); val t = level * (1 - quiet * (1 - part))
      val (red, green, blue) = when (sector) {
        0 -> Triple(level, t, p); 1 -> Triple(q, level, p); 2 -> Triple(p, level, t)
        3 -> Triple(p, q, level); 4 -> Triple(t, p, level); else -> Triple(level, p, q)
      }
      fun byte(v: Float) = Math.round(v * 255f).coerceIn(0, 255)
      return (0xFF shl 24) or (byte(red) shl 16) or (byte(green) shl 8) or byte(blue)
    }
  }

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  var lights: List<Light> = emptyList()
    set(value) { field = value; invalidate() }

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onDraw(canvas: Canvas) {
    for (light in lights) {
      if (light.radius <= 0f) continue
      paint.shader = RadialGradient(light.x, light.y, light.radius, Theme.alpha(light.color, light.strength), Theme.alpha(light.color, 0f), Shader.TileMode.CLAMP)
      canvas.drawCircle(light.x, light.y, light.radius, paint)
    }
    paint.shader = null
  }
}

/** A round button of the room's controls (no word under it: its name is read aloud). */
class RoomRoundButton(context: Context, private val size: Float) : View(context) {
  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private var symbol = ""
  private var plate = 0
  private var tint = 0
  private var bordered = false
  var onPress: (() -> Unit)? = null
  /** What the button says, read aloud. */
  val words: String get() = contentDescription?.toString() ?: ""
  val shownSymbol: String get() = symbol

  init {
    isClickable = true
    isFocusable = true
    setOnClickListener { onPress?.invoke() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun drawableStateChanged() { super.drawableStateChanged(); alpha = if (isPressed) 0.75f else 1f }

  fun show(symbol: String, words: String, fill: Int, tint: Int, bordered: Boolean) {
    this.symbol = symbol
    plate = fill
    this.tint = tint
    this.bordered = bordered
    contentDescription = words
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val radius = minOf(width, height) / 2f
    if (plate != 0) { fill.color = plate; canvas.drawCircle(width / 2f, height / 2f, radius, fill) }
    if (bordered) {
      line.color = com.linea.messenger.settings.ThemeStore.look.glassBorder; line.strokeWidth = maxOf(1f, d)
      canvas.drawCircle(width / 2f, height / 2f, radius - line.strokeWidth / 2, line)
    }
    // RoomScreen.tsx: the mic 28, the close 26, the others 24.
    val glyph = if (symbol == "mic.fill" || symbol == "mic.slash.fill") 28f else if (symbol == "xmark") 26f else 24f
    RoomIcons.draw(canvas, symbol, width / 2f, height / 2f, glyph * d, tint, plate)
  }
}

/** «Зайти»: the microphone and the word in the middle, a turning ring at the end while it works. */
private class RoomEnterButton(context: Context) : RoomPartsView(context) {
  private val words = context.words("Зайти", 16f, Theme.onAccent, 600)
  private val icon = RoomIconView(context, "mic.fill", 20f, Theme.onAccent)
  private val spinner = ProgressBar(context)

  var busy = false
    set(value) {
      field = value
      spinner.visibility = if (value) VISIBLE else GONE
      alpha = if (value) 0.7f else 1f
      isEnabled = !value
    }

  init {
    background = context.plate(Theme.accent, 25f)
    isClickable = true
    isFocusable = true
    contentDescription = "Зайти"
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.onAccent)
    spinner.visibility = GONE
    for (part in listOf(words, icon, spinner)) { part.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO; addView(part) }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l; val height = b - t
    val wide = wideOf(words)
    val left = (width - wide + dp(26f)) / 2
    put(icon, left - dp(26f), 0, dp(22f), height)
    put(words, left, 0, wide, height)
    put(spinner, width - dp(38f), (height - dp(20f)) / 2, dp(20f), dp(20f))
  }
}

/** The glass bar at the top of a room's screen (the stage behind it, blurred). */
private class RoomBar(context: Context) : RoomPartsView(context) {
  val glass = Glass(this)
  val back = RoomIconView(context, "chevron.left", 23f, Theme.text)
  val name = context.words("", 20f, Theme.text, 700)
  val status = context.words("", 12f, Theme.muted, 600)
  val more = RoomIconView(context, "ellipsis", 23f, Theme.text)

  init {
    setWillNotDraw(false)
    glass.tint = Theme.alpha(Theme.surface2, 0.62f)
    glass.plain = Theme.alpha(Theme.surface2, 0.97f)
    glass.rim = Theme.veil(0.12f)
    back.contentDescription = "Назад"
    back.isClickable = true
    more.contentDescription = "Действия с комнатой"
    more.isClickable = true
    for (label in listOf(name, status)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.gravity = Gravity.CENTER_VERTICAL }
    if (Build.VERSION.SDK_INT >= 28) name.isAccessibilityHeading = true
    for (part in listOf(back, name, status, more)) addView(part)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    put(back, dp(6f), dp(10f), dp(44f), dp(44f))
    put(more, width - dp(50f), dp(10f), dp(44f), dp(44f))
    put(name, dp(54f), dp(9f), width - dp(108f), dp(26f))
    put(status, dp(54f), dp(36f), width - dp(108f), dp(17f))
  }

  override fun onDraw(canvas: Canvas) = glass.draw(canvas, 0f, 0f, width.toFloat(), height.toFloat(), 27f * d)
}

/** The stage the people sit on: the lights fill it, every seat is where the screen put it. */
private class RoomStage(context: Context) : GlassSource(context) {
  val lights = RoomLightsView(context)

  init { addView(lights) }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    lights.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    lights.layout(0, 0, width, height)
    for (index in 0 until childCount) {
      val seat = getChildAt(index) as? RoomSeatView ?: continue
      val box = seat.frame()
      seat.measure(MeasureSpec.makeMeasureSpec(box[2], MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(box[3], MeasureSpec.EXACTLY))
      seat.layout(box[0], box[1], box[0] + box[2], box[1] + box[3])
    }
  }
}

/** A room on screen (the reference's `RoomScreen`): this account in the middle, the others around it, each with
 *  their own light behind them. Whoever is talking gets a green ring. Above — a glass bar with the room's name, how
 *  many are inside, and the room's actions; below — «Позвать всех» (rings like a call for those who are not
 *  inside) and either «Зайти» or the microphone, the sound's route and the way out.
 *  Pushed over «Каналы»: Back goes back (the voice goes on — see RoomOverlay.kt). */
@SuppressLint("ViewConstructor")
class RoomScreen(context: Context, val roomId: String) : Screen(context) {
  /** ScreenShare: the screens shared in this room, under its bar (screenshare/ScreenShareViews.kt). */
  private val screenStrip = com.linea.messenger.screenshare.ScreenShareStrip(context, roomId) { id -> Rooms.room(roomId)?.members?.firstOrNull { it.id == id }?.displayName?.takeIf { it.isNotEmpty() } ?: "Участник" }
  private val stage = RoomStage(context)
  private val bar = RoomBar(context)
  private val seatViews = HashMap<String, RoomSeatView>()
  private val goneLabel = context.words("", 15f, Theme.muted)
  private val goneButton = context.words("Назад", 15f, Theme.text, 600)
  private val notice = context.words("", 13f, Theme.danger)
  private val musicLine = RoomMusicLine(context)
  private val ringButton = context.words("Позвать всех", 14f, Theme.text, 500)
  private val enterButton = RoomEnterButton(context)
  private val speakerButton = RoomRoundButton(context, 60f)
  private val micButton = RoomRoundButton(context, 74f)
  private val leaveButton = RoomRoundButton(context, 60f)

  private var speaking: Set<String> = emptySet()
  private var speakingTimer: Runnable? = null
  private var busy = false
  private var problem = ""
  private var rang = 0
  private var rangTimer: Runnable? = null
  private val refreshOnChange: (Unit) -> Unit = { refresh() }

  private val room: Room? get() = Rooms.room(roomId)
  private val here: Boolean get() = RoomVoice.state?.roomId == roomId

  init {
    setBackgroundColor(Theme.bg)
    addView(stage)
    bar.glass.source = stage
    addView(bar)
    bar.back.setOnClickListener { back() }
    bar.more.setOnClickListener { openMenu() }

    goneLabel.gravity = Gravity.CENTER
    addView(goneLabel)
    goneButton.gravity = Gravity.CENTER
    goneButton.background = context.plate(Theme.surface2, 22f)
    goneButton.isClickable = true
    goneButton.setOnClickListener { back() }
    addView(goneButton)

    notice.gravity = Gravity.CENTER
    addView(notice)
    addView(musicLine)

    ringButton.gravity = Gravity.CENTER
    ringButton.background = context.plate(0, 18f, com.linea.messenger.settings.ThemeStore.look.glassBorder)
    ringButton.isClickable = true
    ringButton.contentDescription = "Позвать всех"
    ringButton.setOnClickListener { ringAll() }
    addView(ringButton)

    enterButton.setOnClickListener { enter() }
    addView(enterButton)

    speakerButton.onPress = { RoomVoice.toggleSpeaker() }
    micButton.onPress = { RoomVoice.toggleMute() }
    leaveButton.onPress = { Rooms.exit() }
    leaveButton.show("xmark", "Выйти из комнаты", 0xFFFF4D5E.toInt(), 0xFFFFFFFF.toInt(), bordered = false)
    for (button in listOf(speakerButton, micButton, leaveButton)) addView(button)
    addView(screenStrip) // ScreenShare: whoever shares their screen in the room
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    Rooms.changed.watch(refreshOnChange)
    RoomVoice.changed.watch(refreshOnChange)
    RoomMusic.changed.watch(refreshOnChange)
    refresh()
    // The room's own screen has the same controls as its bar: the bar goes while it is on top.
    post { RoomOverlay.refresh() }
  }

  override fun onDetachedFromWindow() {
    Rooms.changed.unwatch(refreshOnChange)
    RoomVoice.changed.unwatch(refreshOnChange)
    RoomMusic.changed.unwatch(refreshOnChange)
    speakingTimer?.let { removeCallbacks(it) }
    speakingTimer = null
    rangTimer?.let { removeCallbacks(it) }
    super.onDetachedFromWindow()
    // The room goes on without its screen: its bar takes over.
    RoomOverlay.refresh()
  }

  // What is shown

  /** The size the parts were last worked out for (0: not yet). */
  private var appliedWidth = 0
  private var appliedHeight = 0
  private val frames = LinkedHashMap<View, IntArray>()

  private fun refresh() {
    watchSpeaking()
    if (width > 0 && height > 0) apply(width, height)
    requestLayout()
    invalidate()
  }

  /** A part's place, px; laid there by `place`. */
  private fun frame(view: View, left: Int, top: Int, width: Int, height: Int) { frames[view] = intArrayOf(left, top, width, height) }

  private fun setText(view: TextView, words: String) { if (view.text.toString() != words) view.text = words }

  /** Lays out what was worked out last; a new size is worked out afresh (outside the layout pass: what is shown
   *  changes then, and the parts ask for another layout). */
  override fun place(width: Int, height: Int) {
    if (width != appliedWidth || height != appliedHeight) post { if (this.width > 0 && this.height > 0 && (this.width != appliedWidth || this.height != appliedHeight)) refresh() }
    for ((view, box) in frames) if (view.visibility != GONE) put(view, box[0], box[1], box[2], box[3])
    if (screenStrip.visibility != GONE) putText(screenStrip, dp(14f), edges.top + dp(86f), width - dp(28f)) // ScreenShare
  }

  /** Who is talking: asked of the connections a few times a second, only while this phone is inside and the screen
   *  is shown. */
  private fun watchSpeaking() {
    val wanted = here && isAttachedToWindow
    if (!wanted) {
      speakingTimer?.let { removeCallbacks(it) }
      speakingTimer = null
      if (speaking.isNotEmpty() && !here) speaking = emptySet()
      return
    }
    if (speakingTimer != null) return
    val ticks = object : Runnable { override fun run() { readSpeaking(); postDelayed(this, RoomRules.speakingPoll) } }
    speakingTimer = ticks
    readSpeaking()
    postDelayed(ticks, RoomRules.speakingPoll)
  }

  private fun readSpeaking() {
    RoomVoice.speaking(Rooms.userId) { heard ->
      if (!here || heard == speaking) return@speaking
      speaking = heard
      refresh()
    }
  }

  /** The seats of the stage, for the checks. */
  val seats: List<RoomSeatView> get() = seatViews.values.sortedBy { it.centerY * 10_000 + it.centerX }

  /** Works out what is shown and where, for a page of this size. */
  private fun apply(width: Int, height: Int) {
    appliedWidth = width
    appliedHeight = height
    frames.clear()
    val top = edges.top
    frame(bar, dp(14f), top + dp(12f), width - dp(28f), dp(64f))
    val barBottom = top + dp(76f)
    val me = Rooms.userId
    val room = room
    if (room == null) {
      // Not in the list: the list is still being read, could not be read, or the room is gone.
      val loading = Rooms.rooms == null
      setText(bar.name, "Комната")
      setText(bar.status, "")
      bar.more.visibility = GONE
      setText(goneLabel, if (loading) Rooms.failure.ifEmpty { "Загрузка…" } else "Этой комнаты больше нет.")
      goneLabel.visibility = VISIBLE
      goneButton.visibility = if (loading) GONE else VISIBLE
      for (part in listOf(stage, notice, musicLine, ringButton, enterButton, speakerButton, micButton, leaveButton)) part.visibility = GONE
      goneLabel.measure(MeasureSpec.makeMeasureSpec(width - dp(48f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      val high = goneLabel.measuredHeight
      frame(goneLabel, dp(24f), height / 2 - high - dp(7f), width - dp(48f), high)
      frame(goneButton, (width - dp(140f)) / 2, height / 2 + dp(7f), dp(140f), dp(44f))
      return
    }
    goneLabel.visibility = GONE
    goneButton.visibility = GONE
    bar.more.visibility = VISIBLE
    stage.visibility = VISIBLE

    val voice = if (here) RoomVoice.state else null
    // While inside, the engine's own list is the freshest; outside, the server's.
    val inside = HashSet<String>()
    val muted = HashSet<String>()
    for (member in room.inside) if (member.muted) muted.add(member.userId)
    if (voice != null) {
      inside.add(me)
      for (peer in voice.peers) {
        inside.add(peer.userId)
        if (peer.muted) muted.add(peer.userId)
      }
      if (voice.muted) muted.add(me) else muted.remove(me)
    } else for (member in room.inside) inside.add(member.userId)

    setText(bar.name, room.name)
    setText(bar.status, RoomRules.statusLine(room, voice, inside.size) { CallRules.linkWords(it) })
    bar.status.setTextColor(if (inside.isEmpty()) Theme.muted else RoomRules.talk)

    // The controls, from the bottom up.
    var bottom = height - dp(18f) - edges.bottom
    val inRoom = voice != null
    enterButton.visibility = if (inRoom) GONE else VISIBLE
    for (button in listOf(speakerButton, micButton, leaveButton)) button.visibility = if (inRoom) VISIBLE else GONE
    if (voice != null) {
      speakerButton.show(if (voice.speaker) "speaker.wave.2.fill" else "ear", if (voice.speaker) "Звук на динамике" else "Звук в трубке", 0, Theme.text, bordered = true)
      if (voice.muted) micButton.show("mic.slash.fill", "Включить микрофон", com.linea.messenger.settings.ThemeStore.look.glassOpaque, Theme.text, bordered = true)
      else micButton.show("mic.fill", "Выключить микрофон", Theme.text, Theme.bg, bordered = false)
      val rowTop = bottom - dp(74f)
      val micLeft = (width - dp(74f)) / 2
      frame(micButton, micLeft, rowTop, dp(74f), dp(74f))
      frame(speakerButton, micLeft - dp(16f) - dp(60f), rowTop + dp(7f), dp(60f), dp(60f))
      frame(leaveButton, micLeft + dp(74f) + dp(16f), rowTop + dp(7f), dp(60f), dp(60f))
      bottom = rowTop - dp(14f)
    } else {
      val wide = minOf(dp(420f), width - dp(36f))
      frame(enterButton, (width - wide) / 2, bottom - dp(50f), wide, dp(50f))
      enterButton.busy = busy
      bottom -= dp(50f) + dp(14f)
    }
    ringButton.visibility = VISIBLE
    val ringWords = if (rang > 0) "Позвали: $rang" else "Позвать всех"
    if (ringButton.text.toString() != ringWords) ringButton.text = ringWords
    ringButton.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val ringWide = ringButton.measuredWidth + dp(32f)
    frame(ringButton, (width - ringWide) / 2, bottom - dp(36f), ringWide, dp(36f))
    bottom -= dp(36f) + dp(14f)

    musicLine.show(inRoom, room.members)
    if (musicLine.tall > 0f) {
      val wide = minOf(dp(460f), width - dp(36f))
      frame(musicLine, (width - wide) / 2, bottom - dp(musicLine.tall), wide, dp(musicLine.tall))
      bottom -= dp(musicLine.tall) + dp(14f)
    }

    var words = problem
    if (voice != null && voice.error.isNotEmpty()) words = if (words.isEmpty()) voice.error else words + "\n" + voice.error
    if (voice == null && words.isEmpty() && RoomVoice.lastErrorRoom == roomId) words = RoomVoice.lastError
    if (notice.text.toString() != words) notice.text = words
    notice.visibility = if (words.isEmpty()) GONE else VISIBLE
    if (words.isNotEmpty()) {
      notice.measure(MeasureSpec.makeMeasureSpec(width - dp(36f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      val high = notice.measuredHeight
      frame(notice, dp(18f), bottom - high, width - dp(36f), high)
      bottom -= high + dp(14f)
    }

    // The stage and everyone's place on it (the stage lies under the bar, so the bar's glass shows it blurred).
    val stageTop = barBottom
    val stageHigh = maxOf(0, bottom - stageTop)
    frame(stage, 0, stageTop, width, stageHigh)
    val places = RoomRules.seats(room, me)
    // On a wide screen the people stay together in the middle instead of drifting to the edges.
    val span = minOf(width.toFloat(), 620f * d)
    val left = (width - span) / 2
    val size = RoomRules.seatSize(room.members.size, if (span > 0) span / d else 360f)
    val pad = size * 0.62f * d
    val lit = ArrayList<RoomLightsView.Light>()
    val kept = HashSet<String>()
    for (member in room.members) {
      val place = places[member.id] ?: Pair(0.5, 0.5)
      val roomWide = maxOf(0f, span - pad * 2); val roomHigh = maxOf(0f, stageHigh - pad * 2.1f)
      val x = left + pad + place.first.toFloat() * roomWide
      val y = pad * 0.9f + place.second.toFloat() * roomHigh
      val mine = member.id == me
      val present = member.id in inside
      val talking = present && member.id in speaking
      val full = if (mine) size * 0.82f else size
      val scale = if (present || mine) 1f else 0.72f
      val side = Math.round(full * scale).toFloat()
      val seat = seatViews.getOrPut(member.id) { RoomSeatView(context).also { stage.addView(it) } }
      seat.show(member, mine, present, talking, member.id in muted, side, Math.round(x), Math.round(y))
      kept.add(member.id)
      if (present) {
        val strength = if (talking) RoomLightsView.TALKING_STRENGTH else RoomLightsView.QUIET_STRENGTH
        lit.add(RoomLightsView.Light(x, y, size * RoomLightsView.REACH * d, RoomLightsView.calm(member.avatarColor), strength))
      }
    }
    for (id in seatViews.keys.toList()) if (id !in kept) seatViews.remove(id)?.let { stage.removeView(it) }
    stage.lights.lights = lit
    stage.requestLayout()
  }

  // What the person does

  private fun back() { pages()?.pop() }

  private fun enter() {
    val room = room ?: return
    if (busy) return
    busy = true
    problem = ""
    refresh()
    Rooms.enter(room) { words ->
      busy = false
      problem = words ?: ""
      refresh()
    }
  }

  private fun ringAll() {
    problem = ""
    Rooms.ringAll(roomId) { count, words ->
      if (words != null) problem = words
      else {
        rang = count
        rangTimer?.let { removeCallbacks(it) }
        val timer = Runnable { rang = 0; refresh() }
        rangTimer = timer
        postDelayed(timer, 4000)
      }
      refresh()
    }
  }

  private fun openMenu() {
    val room = room ?: return
    ChoiceSheet(context, room.name, choices = listOf(
      ChoiceSheet.Choice("pencil", "Переименовать") { askName() },
      ChoiceSheet.Choice("exit", "Уйти из комнаты насовсем", "Она пропадёт из твоего списка. Остальные останутся.", danger = true) { leaveForGood() },
    )).show()
  }

  /** «Название комнаты»: an empty field brings back the name made of the members' names. */
  private fun askName() {
    val room = room ?: return
    val field = EditText(context).apply {
      setText(if (room.auto) "" else room.name)
      hint = "Например, Наши"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      // A room's name holds no more than the server takes.
      filters = arrayOf(InputFilter.LengthFilter(RoomRules.maxName))
      setSingleLine()
    }
    val box = FrameLayout(context).apply { setPadding(dp(20f), dp(4f), dp(20f), 0); addView(field) }
    AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle("Название комнаты")
      .setMessage("Пустое поле вернёт название из имён участников.")
      .setView(box)
      .setNegativeButton("Отмена", null)
      .setPositiveButton("Сохранить") { _, _ ->
        Rooms.rename(roomId, field.text.toString()) { words ->
          if (words != null) { problem = words; refresh() }
        }
      }
      .show()
  }

  private fun leaveForGood() {
    Rooms.leaveForGood(roomId) { words ->
      if (words != null) { problem = words; refresh() } else back()
    }
  }

  /** For the emulator check: the room's actions, or the form of its name. */
  fun emulatorShow(what: String) { if (what == "menu") openMenu() else if (what == "rename") askName() }

  /** For the emulator check: who is drawn as talking. */
  fun emulatorSpeaking(ids: Set<String>) {
    speaking = ids
    refresh()
  }

  /** The words of the bar and the controls, for the checks. */
  val shownName: String get() = bar.name.text.toString()
  val shownStatus: String get() = bar.status.text.toString()
  val buttons: List<String> get() = listOf(speakerButton, micButton, leaveButton).filter { it.visibility == VISIBLE }.map { it.words }
  val texts: List<String> get() = listOf(goneLabel, goneButton, notice, ringButton).filter { it.visibility == VISIBLE }.map { it.text.toString() } +
    (if (enterButton.visibility == VISIBLE) listOf("Зайти") else emptyList())
}
