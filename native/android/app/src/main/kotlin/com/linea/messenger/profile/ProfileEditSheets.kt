package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.BirthdayWords
import com.linea.messenger.settings.SettingsButton
import com.linea.messenger.settings.SettingsField
import com.linea.messenger.settings.SettingsLook
import java.time.LocalDate

/** The sheets of the profile editor (the reference's ProfileScreen.tsx; iOS Profile/ProfileEditSheets.swift):
 *  «Персональный цвет», «Узор фона» and «День рождения», each the content of a `ChoiceSheet`. */
object ProfileEditSheets {
  /** «Персональный цвет»: the words (13, line 19, `muted`), the eight colours and «Готово», 14 apart. A colour is
   *  taken as it is touched; «Готово» only closes. */
  fun color(context: Context, current: String, picked: (String) -> Unit): ChoiceSheet {
    val ready = SettingsButton(context, "Готово")
    val sheet = ChoiceSheet(context, "Персональный цвет", "", emptyList(), listOf(
      SettingsLook.para(context, "Этим цветом тебя видят в чатах у других, пока нет фото.", 13f, Theme.muted, line = 19f),
      ProfileColorGrid(context, current, picked),
      ready,
    ), 14f)
    ready.onPress = { sheet.dismiss() }
    return sheet
  }

  /** «Узор фона»: the words, «Без узора» and the emoji (tiles of 48, 8 apart, in the middle) and «Готово», 14 apart. */
  fun pattern(context: Context, current: String?, picked: (String?) -> Unit): ChoiceSheet {
    val ready = SettingsButton(context, "Готово")
    val sheet = ChoiceSheet(context, "Узор фона", "", emptyList(), listOf(
      SettingsLook.para(context, "Значок, которым усыпан фон вокруг твоего фото в профиле.", 13f, Theme.muted, line = 19f),
      ProfilePatternGrid(context, current, picked),
      ready,
    ), 14f)
    ready.onPress = { sheet.dismiss() }
    return sheet
  }

  /** «День рождения»: the months, the days, the year if the person wants it, «Готово» (and «Убрать день рождения»
   *  when there is one). `done` gets the chosen day, or null when it was removed. */
  fun birthday(context: Context, value: String?, done: (String?) -> Unit): ChoiceSheet {
    val picker = BirthdayPickerView(context, value)
    val sheet = ChoiceSheet(context, "День рождения", "", emptyList(), listOf(picker), 14f)
    picker.onDone = { chosen -> sheet.dismiss(); done(chosen) }
    return sheet
  }
}

/** Square tiles of one size in rows that wrap: tile `index` stands in column `index % columns`, whether it is shown
 *  or not, so a grid keeps its height while some of its tiles are hidden. `centred`: every row stands in the middle. */
@SuppressLint("ViewConstructor")
internal class TileGrid(context: Context, private val side: Int, private val gap: Int, private val centred: Boolean) : ViewGroup(context) {
  private fun columns(width: Int): Int = maxOf(1, (width + gap) / (side + gap))

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val width = MeasureSpec.getSize(widthSpec)
    val columns = columns(width)
    val rows = (childCount + columns - 1) / columns
    val exact = MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY)
    for (index in 0 until childCount) getChildAt(index).measure(exact, exact)
    setMeasuredDimension(width, if (rows == 0) 0 else rows * side + (rows - 1) * gap)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    val columns = columns(width)
    val rows = (childCount + columns - 1) / columns
    for (index in 0 until childCount) {
      val row = index / columns
      // The last row may be shorter; like every row it stands in the middle.
      val inRow = if (row == rows - 1) childCount - row * columns else columns
      val left = if (centred) (width - (inRow * side + (inRow - 1) * gap)) / 2 else 0
      val x = left + (index % columns) * (side + gap); val y = row * (side + gap)
      getChildAt(index).layout(x, y, x + side, y + side)
    }
  }
}

/** The colours a person can be seen in while there is no photo: rounds of 46, 12 apart, wrapping; the chosen one has
 *  a 3 rim in the text colour and a white «checkmark» 20. */
@SuppressLint("ViewConstructor")
class ProfileColorGrid(context: Context, private var current: String, private val picked: (String) -> Unit) : FrameLayout(context) {
  private val dots = ArrayList<FrameLayout>()
  private val marks = ArrayList<View>()

  init {
    val grid = TileGrid(context, context.px(46f), context.px(12f), centred = false)
    colors.forEachIndexed { index, value ->
      val dot = FrameLayout(context)
      val mark = ProfileIconView(context, "ion:checkmark", 20f, Color.WHITE)
      dot.addView(mark, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      dot.contentDescription = "Цвет ${index + 1}"
      dot.isClickable = true
      dot.isFocusable = true
      dot.setOnClickListener {
        current = value
        show()
        picked(value)
      }
      grid.addView(dot)
      dots.add(dot)
      marks.add(mark)
    }
    addView(grid, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    show()
  }

  private fun show() {
    dots.forEachIndexed { index, dot ->
      val value = ProfileColorGrid.colors[index]
      val on = value.equals(current, ignoreCase = true)
      dot.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(0xFF000000.toInt() or Messenger.color(value))
        if (on) setStroke(context.px(3f), Theme.text)
      }
      marks[index].visibility = if (on) View.VISIBLE else View.INVISIBLE
      dot.isSelected = on
    }
  }

  companion object {
    /** The reference's eight. */
    val colors = listOf("#596FE8", "#4088C7", "#9271C3", "#B78358", "#AD6C8C", "#667FA4", "#3FA37C", "#D0644E")
  }
}

/** «Без узора» and the emoji the background around the photo can be strewn with: tiles of 48 (radius 14, `surface2`),
 *  8 apart, wrapping, each row in the middle; the chosen one has a 2 rim in the accent. */
@SuppressLint("ViewConstructor")
class ProfilePatternGrid(context: Context, private var current: String?, private val picked: (String?) -> Unit) : FrameLayout(context) {
  private val cells = ArrayList<Pair<String?, View>>()

  init {
    val grid = TileGrid(context, context.px(48f), context.px(8f), centred = true)
    val options: List<String?> = listOf<String?>(null) + AvatarCatalog.patterns
    for (option in options) {
      val cell = FrameLayout(context)
      if (option != null) cell.addView(context.words(option, 24f, Theme.text).apply { gravity = Gravity.CENTER }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      else cell.addView(ProfileIconView(context, "ion:close", 20f, Theme.muted), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      cell.contentDescription = option ?: "Без узора"
      cell.isClickable = true
      cell.isFocusable = true
      cell.setOnClickListener {
        current = option
        show()
        picked(option)
      }
      grid.addView(cell)
      cells.add(option to cell)
    }
    addView(grid, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    show()
  }

  private fun show() {
    val d = resources.displayMetrics.density
    for ((option, cell) in cells) {
      val on = option == current
      cell.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 14f * d; setStroke(Math.round(2 * d), if (on) Theme.accent else Color.TRANSPARENT) }
      cell.isSelected = on
    }
  }
}

/** The content of «День рождения» (ProfileScreen.tsx `BirthdaySheet`), 14 between its parts: the months as chips in
 *  one row that scrolls sideways (34 tall, 12 inside, 6 apart; the chosen one in the accent, 14 Bold), the days as
 *  rounds of 40, 6 apart, wrapping (the chosen one in the accent, 15 Bold), «Год (необязательно)», «Видят только
 *  друзья: …» (13, `muted`), «Готово» and — when there is a birthday — «Убрать день рождения». */
@SuppressLint("ViewConstructor")
class BirthdayPickerView(context: Context, value: String?) : LinearLayout(context) {
  /** The chosen day («MM-DD» or «YYYY-MM-DD»), or null when the birthday is removed. */
  var onDone: ((String?) -> Unit)? = null
  private var month = 1
  private var day = 1
  private val monthChips = ArrayList<TextView>()
  private val dayButtons = ArrayList<TextView>()
  private val yearField = SettingsField(context, "Год (необязательно)", "Например, 1999")
  private val yearError = context.words("", 12f, Theme.danger)
  private val yearErrorBox = SettingsLook.inset(yearError, side = 3f)
  private val preview = context.words("", 13f, Theme.muted)
  private val doneButton = SettingsButton(context, "Готово")
  private val thisYear = LocalDate.now().year

  init {
    orientation = VERTICAL
    val made = BirthdayWords.parse(value)
    made?.takeIf { it.month in 1..12 }?.let {
      month = it.month
      day = it.day.coerceIn(1, 31)
    }
    val wide = LayoutParams.MATCH_PARENT; val wrap = LayoutParams.WRAP_CONTENT

    val chipRow = LinearLayout(context).apply { orientation = HORIZONTAL }
    BirthdayWords.months.forEachIndexed { index, label ->
      val chip = context.words(label, 14f, Theme.text, 500)
      chip.gravity = Gravity.CENTER
      chip.maxLines = 1
      chip.setPadding(context.px(12f), 0, context.px(12f), 0)
      chip.isClickable = true
      chip.isFocusable = true
      chip.setOnClickListener { month = index + 1; show() }
      chipRow.addView(chip, LayoutParams(wrap, context.px(34f)).apply { if (index > 0) leftMargin = context.px(6f) })
      monthChips.add(chip)
    }
    val chips = HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(chipRow) }
    addView(chips, LayoutParams(wide, context.px(34f)))

    // Room for the longest month (31 days), so the sheet keeps its height from month to month.
    val dayGrid = TileGrid(context, context.px(40f), context.px(6f), centred = false)
    for (number in 1..31) {
      val button = context.words(number.toString(), 15f, Theme.text, 500)
      button.gravity = Gravity.CENTER
      button.isClickable = true
      button.isFocusable = true
      button.contentDescription = "День $number"
      button.setOnClickListener { day = number; show() }
      dayGrid.addView(button)
      dayButtons.add(button)
    }
    addView(dayGrid, LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })

    yearField.limit = 4
    yearField.allowed = { it in '0'..'9' }
    yearField.input.inputType = InputType.TYPE_CLASS_NUMBER
    made?.year?.let { yearField.value = it.toString() }
    yearField.onEdit = { show() }
    addView(yearField, LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    addView(yearErrorBox, LayoutParams(wide, wrap).apply { topMargin = context.px(8f) })
    addView(preview, LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })

    doneButton.onPress = { finish() }
    addView(doneButton, LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    if (value != null) {
      val remove = SettingsButton(context, "Убрать день рождения", SettingsButton.Kind.DANGER)
      remove.onPress = { onDone?.invoke(null) }
      addView(remove, LayoutParams(wide, wrap).apply { topMargin = context.px(14f) })
    }
    show()
  }

  /** The typed year when it is four digits; null otherwise. */
  private val year: Int? get() = yearField.value.takeIf { it.length == 4 }?.toIntOrNull()

  private val yearProblem: String
    get() {
      if (yearField.value.isEmpty()) return ""
      val typed = year
      return if (typed != null && typed in 1900..thisYear) "" else "Год — от 1900 до $thisYear"
    }

  private val chosen: BirthdayWords.Day get() = BirthdayWords.Day(minOf(day, BirthdayWords.daysInMonth(month, year)), month, year)

  private fun show() {
    val made = chosen
    monthChips.forEachIndexed { index, chip ->
      val on = index + 1 == month
      chip.typeface = Theme.weight(if (on) 700 else 500)
      chip.setTextColor(if (on) Theme.onAccent else Theme.text)
      chip.background = context.plate(if (on) Theme.accent else Theme.surface2, 17f)
      chip.isSelected = on
    }
    val most = BirthdayWords.daysInMonth(month, year)
    dayButtons.forEachIndexed { index, button ->
      val on = index + 1 == made.day
      button.visibility = if (index >= most) View.INVISIBLE else View.VISIBLE
      button.typeface = Theme.weight(if (on) 700 else 500)
      button.setTextColor(if (on) Theme.onAccent else Theme.text)
      button.background = if (on) context.plate(Theme.accent, 20f) else null
      button.isSelected = on
    }
    val problem = yearProblem
    yearError.text = problem
    yearErrorBox.visibility = if (problem.isEmpty()) View.GONE else View.VISIBLE
    preview.text = "Видят только друзья: " + BirthdayWords.format(BirthdayWords.value(made))
    doneButton.isEnabled = problem.isEmpty()
  }

  private fun finish() {
    if (yearProblem.isNotEmpty()) return
    onDone?.invoke(BirthdayWords.value(chosen))
  }
}
