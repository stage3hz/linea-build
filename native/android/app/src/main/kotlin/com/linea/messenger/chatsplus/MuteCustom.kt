package com.linea.messenger.chatsplus

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.titled
import com.linea.messenger.design.words
import com.linea.messenger.settings.NotificationsScreen

/** ChatsPlus: «Настроить…» of «Выключить звук» (notifications/MuteSheet.tsx `DurationPicker`): chips for days, hours
 *  and minutes, the chosen span in words, a live «Без звука до …» line, and «Выключить звук». The span and its end
 *  come from the core (`settingsCustomMute`, the reference's `customMuteUntil` / `durationLabel`), the end's words
 *  from `settingsMuteState` — the same as on the other phone (native/ios/Sources/ChatsPlus/MuteCustom.swift). */
class MuteCustomSheet(context: Context, private val done: (String) -> Unit) : Dialog(context) {
  /** «Назад»: the list of spans again. */
  var onBack: (() -> Unit)? = null
  private var days = 0
  private var hours = 1
  private var minutes = 0
  private var until: String? = null
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val span = context.words("", 22f, Theme.text, 700).apply { gravity = Gravity.CENTER }
  private val endLine = context.words("", 12f, Theme.muted).apply { maxLines = 2 }
  private val confirm = context.words("Выключить звук", 16f, Theme.onAccent, 600).apply { gravity = Gravity.CENTER }
  private class Group(val part: Int, val values: List<Int>, val chips: List<TextView>)
  private val groups = ArrayList<Group>()

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val stack = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20f), dp(24f), dp(20f), dp(24f))
      background = GradientDrawable().apply { setColor(Theme.panel(Theme.surface2)); cornerRadii = floatArrayOf(28f * d, 28f * d, 28f * d, 28f * d, 0f, 0f, 0f, 0f) }
    }
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    stack.addView(TextView(context).apply { text = "На какое время?"; setTextColor(Theme.text); titled(Theme.TypeSize.sheetTitle) })
    val back = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; isClickable = true; contentDescription = "Назад"
      addView(PlusIconView(context, "chevron.left", 13f, Theme.accent), LinearLayout.LayoutParams(dp(16f), dp(16f)))
      addView(context.words(" Назад", 14f, Theme.accent, 600))
      setOnClickListener { val then = onBack; dismiss(); then?.invoke() }
    }
    stack.addView(back, LinearLayout.LayoutParams(wrap, dp(24f)).apply { topMargin = dp(9f) })
    stack.addView(span, LinearLayout.LayoutParams(wide, dp(28f)).apply { topMargin = dp(10f) })
    val parts = listOf("Дни" to DAYS, "Часы" to HOURS, "Минуты" to MINUTES)
    parts.forEachIndexed { index, (caption, values) ->
      stack.addView(context.words(caption, 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(14f) })
      val flow = Flow(context, dp(6f))
      val chips = values.map { value ->
        context.words(value.toString(), 15f, Theme.text, 500).apply {
          gravity = Gravity.CENTER; minWidth = dp(52f); setPadding(dp(12f), 0, dp(12f), 0); isClickable = true
          setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            when (index) { 0 -> days = value; 1 -> hours = value; else -> minutes = value }
            refresh()
          }
        }.also { flow.addView(it, ViewGroup.LayoutParams(wrap, dp(40f))) }
      }
      groups.add(Group(index, values, chips))
      stack.addView(flow, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(6f) })
    }
    stack.addView(endLine, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(14f) })
    confirm.background = context.plate(Theme.accent, 16f)
    confirm.isClickable = true
    confirm.setOnClickListener { confirmed() }
    stack.addView(confirm, LinearLayout.LayoutParams(wide, dp(50f)).apply { topMargin = dp(10f) })
    val scroll = ScrollView(context).apply { addView(stack); isVerticalScrollBarEnabled = false }
    setContentView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
    setCanceledOnTouchOutside(true)
    refresh()
  }

  private fun refresh() {
    val answer = answer(days, hours, minutes, System.currentTimeMillis())
    until = answer.first
    span.text = answer.second.ifEmpty { "—" }
    val end = until
    endLine.text = if (end != null) {
      val words = NotificationsScreen.muteState(mapOf("muted" to true, "mutedUntil" to end))["until"] as? String ?: ""
      "Без звука $words."
    } else "Выбери хотя бы несколько минут."
    confirm.isEnabled = end != null
    confirm.alpha = if (end != null) 1f else 0.45f
    for (group in groups) {
      val current = when (group.part) { 0 -> days; 1 -> hours; else -> minutes }
      group.chips.forEachIndexed { index, chip ->
        val on = group.values[index] == current
        chip.background = context.plate(if (on) Theme.accent else Theme.veil(0.08f), 12f)
        chip.setTextColor(if (on) Theme.onAccent else Theme.text)
        chip.typeface = Theme.weight(if (on) 700 else 500)
        chip.isSelected = on
      }
    }
  }

  /** The end is counted again from the moment of the touch, not from when the sheet was opened. */
  private fun confirmed() {
    refresh()
    val end = until ?: return
    confirm.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    dismiss()
    done(end)
  }

  override fun show() {
    last = java.lang.ref.WeakReference(this)
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  /** Chips in rows that wrap. */
  private class Flow(context: Context, private val gap: Int) : ViewGroup(context) {
    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
      val width = MeasureSpec.getSize(widthSpec)
      var x = 0; var y = 0; var line = 0
      for (index in 0 until childCount) {
        val child = getChildAt(index)
        child.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(child.layoutParams.height, MeasureSpec.EXACTLY))
        if (x > 0 && x + child.measuredWidth > width) { x = 0; y += line + gap; line = 0 }
        x += child.measuredWidth + gap
        line = maxOf(line, child.measuredHeight)
      }
      setMeasuredDimension(width, y + line)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val width = r - l
      var x = 0; var y = 0; var line = 0
      for (index in 0 until childCount) {
        val child = getChildAt(index)
        if (x > 0 && x + child.measuredWidth > width) { x = 0; y += line + gap; line = 0 }
        child.layout(x, y, x + child.measuredWidth, y + child.measuredHeight)
        x += child.measuredWidth + gap
        line = maxOf(line, child.measuredHeight)
      }
    }
  }

  companion object {
    val DAYS = listOf(0, 1, 2, 3, 5, 7, 14, 30)
    val HOURS = listOf(0, 1, 2, 3, 4, 6, 8, 12, 18)
    val MINUTES = listOf(0, 15, 30, 45)
    /** The sheet on the screen now, if any (for the checks). */
    var last: java.lang.ref.WeakReference<MuteCustomSheet>? = null

    /** The core's `settingsCustomMute`: the end (null for nothing chosen) and the span in words. */
    fun answer(days: Int, hours: Int, minutes: Int, nowMs: Long): Pair<String?, String> {
      val made = Core.map(Core.view("settingsCustomMute", listOf(mapOf("days" to days, "hours" to hours, "minutes" to minutes), nowMs))) ?: emptyMap()
      return (made["until"] as? String) to (made["label"] as? String ?: "")
    }
  }
}
