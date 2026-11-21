package com.linea.messenger.rooms

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView

/** A view of fixed parts laid out by hand (the rooms' small helper). */
abstract class RoomPartsView(context: Context) : ViewGroup(context) {
  protected val d = resources.displayMetrics.density
  protected fun dp(value: Float) = Math.round(value * d)

  protected fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** How wide a text wants to be on one line, px. */
  protected fun wideOf(view: View): Int {
    view.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    return view.measuredWidth
  }
}

/** The members of a room as overlapping round pictures (a row of the list, the ring's banner): three at most. */
class RoomFacesView(context: Context) : RoomPartsView(context) {
  private val rims = ArrayList<FrameLayout>()
  private val faces = ArrayList<PersonAvatarView>()
  private var side = 40f
  private var shownCount = 0

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    // The later pictures lie under the earlier ones.
    isChildrenDrawingOrderEnabled = true
  }

  override fun getChildDrawingOrder(childCount: Int, drawingPosition: Int): Int = childCount - 1 - drawingPosition

  /** `ring`: the colour around the first picture (somebody is inside, 0: none); the others are rimmed with the page's own. */
  fun show(people: List<Person>, size: Float, ring: Int) {
    side = size
    val shown = people.take(3)
    while (rims.size < shown.size) {
      val rim = FrameLayout(context)
      val face = PersonAvatarView(context)
      rim.setPadding(dp(2.5f), dp(2.5f), dp(2.5f), dp(2.5f))
      rim.addView(face, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      addView(rim)
      rims.add(rim)
      faces.add(face)
    }
    for (index in rims.indices) {
      rims[index].visibility = if (index < shown.size) VISIBLE else GONE
      if (index >= shown.size) continue
      rims[index].background = context.plate(if (index == 0 && ring != 0) ring else Theme.bg, (side + 5f) / 2)
      faces[index].show(shown[index], Rooms.pictureAddress(shown[index]))
    }
    shownCount = shown.size
    requestLayout()
  }

  /** How wide the pictures are together, dp. */
  val wide: Float
    get() {
      if (shownCount == 0) return 0f
      val step = (side + 5f) - side * 0.28f
      return (side + 5f) + (shownCount - 1) * step
    }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val box = dp(side + 5f)
    val step = (side + 5f) - side * 0.28f
    val height = b - t
    for (index in rims.indices) {
      put(rims[index], dp(index * step), (height - box) / 2, box, box)
    }
  }
}

/** One room in the list of «Каналы». Somebody inside (or this phone is): a lit card with the people inside, how many
 *  they are and «Зайти». Nobody: a quiet row — when the room was last used, and how many people it is for. */
class RoomRowView(context: Context) : RoomPartsView(context) {
  private val card = View(context)
  private val faces = RoomFacesView(context)
  private val nameLabel = context.words("", 16f, Theme.text, 600)
  private val lineLabel = context.words("", 13f, Theme.muted)
  private val countLabel = context.words("", 12f, Theme.subtle)
  private val enterButton = context.words("Зайти", 14f, Theme.bg, 600)
  var lit = false
    private set
  private var roomId = ""
  var onOpen: ((String) -> Unit)? = null
  var onEnter: ((String) -> Unit)? = null

  init {
    for (label in listOf(nameLabel, lineLabel)) { label.maxLines = 1; label.ellipsize = TextUtils.TruncateAt.END; label.gravity = Gravity.CENTER_VERTICAL }
    countLabel.gravity = Gravity.END or Gravity.CENTER_VERTICAL
    enterButton.gravity = Gravity.CENTER
    enterButton.background = context.plate(Theme.text, 20f)
    enterButton.isClickable = true
    enterButton.isFocusable = true
    enterButton.contentDescription = "Зайти"
    enterButton.setOnClickListener { onEnter?.invoke(roomId) }
    for (part in listOf(card, faces, nameLabel, lineLabel, countLabel, enterButton)) addView(part)
    isClickable = true
    isFocusable = true
    setOnClickListener { onOpen?.invoke(roomId) }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  /** How tall a row of this kind is, dp. */
  val tall: Float get() = if (lit) 78f + 8f else 64f

  fun show(room: Room, me: String, here: Boolean, busy: Boolean) {
    roomId = room.id
    val inside = room.inside.map { it.userId }.toMutableSet()
    if (here) inside.add(me)
    lit = inside.isNotEmpty()
    nameLabel.text = room.name
    val talk = RoomRules.talk
    if (lit) {
      // This account is not drawn among the faces of its own room, unless it is there alone.
      faces.show(room.members.filter { it.id in inside && (inside.size <= 1 || it.id != me) }, 44f, talk)
      nameLabel.textSize = 17f
      lineLabel.textSize = 13f
      lineLabel.setTextColor(talk)
      val count = RoomRules.insideLine(inside.size)
      lineLabel.text = if (here) (if (inside.size > 1) "ты внутри · $count" else "ты внутри, пока один") else count
      contentDescription = "Комната ${room.name}, $count"
      alpha = 1f
    } else {
      faces.show(room.members.filter { it.id != me }, 42f, 0)
      nameLabel.textSize = 16f
      lineLabel.textSize = 13.5f
      lineLabel.setTextColor(Theme.muted)
      lineLabel.text = if (room.awake) "никого · ещё не спит" else RoomRules.sleepLine(room)
      contentDescription = "Комната ${room.name}, спит"
      alpha = if (room.awake) 0.85f else 0.55f
    }
    paintCard()
    countLabel.text = "${room.members.size} чел"
    countLabel.visibility = if (lit) GONE else VISIBLE
    enterButton.visibility = if (!lit || here) GONE else VISIBLE
    enterButton.isEnabled = !busy
    enterButton.alpha = if (busy) 0.7f else 1f
    requestLayout()
  }

  private fun paintCard() {
    val talk = RoomRules.talk
    card.background = if (lit) {
      val rest = if (Theme.dark) 0.06f else 0.10f
      context.plate(Theme.alpha(talk, if (isPressed) 0.14f else rest), 26f, Theme.alpha(talk, 0.28f))
    } else context.plate(if (isPressed) Theme.veil(0.07f) else 0, 16f)
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    paintCard()
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(tall))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    val facesWide = dp(faces.wide)
    if (lit) {
      put(card, dp(12f), 0, width - dp(24f), dp(78f))
      put(faces, dp(26f), dp(14f), facesWide, dp(50f))
      var right = width - dp(26f)
      if (enterButton.visibility == VISIBLE) {
        val wide = wideOf(enterButton) + dp(32f)
        put(enterButton, right - wide, dp(19f), wide, dp(40f))
        right -= wide + dp(12f)
      }
      val left = dp(26f) + facesWide + dp(12f)
      put(nameLabel, left, dp(17f), right - left, dp(22f))
      put(lineLabel, left, dp(41f), right - left, dp(18f))
    } else {
      put(card, dp(12f), 0, width - dp(24f), dp(64f))
      put(faces, dp(20f), dp(8f), facesWide, dp(48f))
      put(countLabel, width - dp(80f), dp(22f), dp(60f), dp(20f))
      val left = dp(20f) + facesWide + dp(12f)
      put(nameLabel, left, dp(11f), width - dp(84f) - left, dp(21f))
      put(lineLabel, left, dp(34f), width - dp(84f) - left, dp(19f))
    }
  }
}

/** The dashed card that says how a room is made. */
private class RoomHintBox(context: Context) : RoomPartsView(context) {
  val icon = RoomIconView(context, "mic", 19f, Theme.text)
  val words = context.words("Комнат пока нет. В чатах удержи собеседника, нажми «Выбрать», отметь людей и позвони всем сразу — получится комната.", 13.5f, Theme.muted)
  private val dash = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = maxOf(1f, d)
    color = Theme.veil(0.18f)
    pathEffect = DashPathEffect(floatArrayOf(5f * d, 4f * d), 0f)
  }

  init {
    setWillNotDraw(false)
    icon.background = context.plate(Theme.veil(0.08f), 22f)
    addView(icon)
    addView(words)
  }

  /** The height for a width, px. */
  fun tallFor(width: Int): Int {
    words.measure(MeasureSpec.makeMeasureSpec((width - dp(80f)).coerceAtLeast(0), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    return maxOf(dp(44f), words.measuredHeight) + dp(24f)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l; val height = b - t
    put(icon, dp(12f), (height - dp(44f)) / 2, dp(44f), dp(44f))
    put(words, dp(68f), dp(12f), width - dp(80f), height - dp(24f))
  }

  override fun onDraw(canvas: Canvas) {
    val half = dash.strokeWidth / 2
    canvas.drawRoundRect(half, half, width - half, height - half, 20f * d, 20f * d, dash)
  }
}

/** «Комнаты» in «Каналы» — the first thing there (the reference's `RoomsSection`): the rooms somebody is in on top,
 *  the sleeping ones under them; without any room — how one is made. Nothing at all until the list is read.
 *  Sits above the communities as the list's header and is as tall as it needs. */
class RoomsSectionView(context: Context) : RoomPartsView(context) {
  /** The section's height changed: the list gives it the room. */
  var onResize: (() -> Unit)? = null
  private val heading = context.words("КОМНАТЫ", 11f, Theme.muted, 700)
  private val problem = context.words("", 13f, Theme.danger)
  private val hint = RoomHintBox(context)
  private val rows = ArrayList<RoomRowView>()
  private var busy = ""
  private var problemWords = ""
  private var known = false
  private var empty = false
  private var lastTall = -1
  private val reloadOnChange: (Unit) -> Unit = { reload() }

  init {
    heading.letterSpacing = 1.2f / 11f
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    addView(heading)
    addView(problem)
    addView(hint)
    reload()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    Rooms.changed.watch(reloadOnChange)
    reload()
  }

  override fun onDetachedFromWindow() {
    Rooms.changed.unwatch(reloadOnChange)
    super.onDetachedFromWindow()
  }

  /** The rows of the section, for the checks. */
  val shownRows: List<RoomRowView> get() = rows.filter { it.visibility == VISIBLE }

  fun reload() {
    val list = Rooms.rooms
    known = list != null
    val shown = list ?: emptyList()
    empty = shown.isEmpty()
    val me = Rooms.userId
    val hereId = RoomVoice.state?.roomId
    while (rows.size < shown.size) {
      val row = RoomRowView(context)
      row.onOpen = { id -> RoomRouter.open(id) }
      row.onEnter = { id -> enter(id) }
      addView(row)
      rows.add(row)
    }
    for (index in rows.indices) {
      rows[index].visibility = if (index < shown.size) VISIBLE else GONE
      if (index < shown.size) rows[index].show(shown[index], me, hereId == shown[index].id, busy == shown[index].id)
    }
    heading.visibility = if (known) VISIBLE else GONE
    hint.visibility = if (known && empty) VISIBLE else GONE
    problem.text = problemWords
    problem.visibility = if (problemWords.isEmpty() || !known) GONE else VISIBLE
    requestLayout()
    if (width > 0 && tallFor(width) != lastTall) onResize?.invoke()
  }

  /** «Зайти» on a row: the room opens and this phone walks in. */
  private fun enter(id: String) {
    val room = Rooms.room(id) ?: return
    busy = id
    problemWords = ""
    RoomRouter.open(id)
    Rooms.enter(room) { words ->
      busy = ""
      problemWords = words ?: ""
      reload()
    }
    reload()
  }

  /** How tall the section wants to be for a width, px. */
  fun tallFor(width: Int): Int {
    if (!known || width <= 0) return 0
    var y = dp(34f)
    if (problem.visibility == VISIBLE) {
      problem.measure(MeasureSpec.makeMeasureSpec(width - dp(40f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      y += problem.measuredHeight + dp(6f)
    }
    y += if (empty) hint.tallFor(width - dp(24f)) + dp(8f) else rows.filter { it.visibility == VISIBLE }.sumOf { dp(it.tall) } + dp(4f)
    return y
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val tall = tallFor(width)
    lastTall = tall
    setMeasuredDimension(width, tall)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    if (!known) return
    put(heading, dp(20f), dp(10f), width - dp(40f), dp(18f))
    var y = dp(34f)
    if (problem.visibility == VISIBLE) {
      problem.measure(MeasureSpec.makeMeasureSpec(width - dp(40f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      put(problem, dp(20f), y, width - dp(40f), problem.measuredHeight)
      y += problem.measuredHeight + dp(6f)
    }
    if (empty) {
      val high = hint.tallFor(width - dp(24f))
      put(hint, dp(12f), y, width - dp(24f), high)
    } else {
      for (row in rows) {
        if (row.visibility != VISIBLE) continue
        put(row, 0, y, width, dp(row.tall))
        y += dp(row.tall)
      }
    }
  }
}
