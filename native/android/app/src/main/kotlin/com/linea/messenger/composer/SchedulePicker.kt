package com.linea.messenger.composer

import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.chatactions.ChatIcons
import com.linea.messenger.chatlook.Haptic
import com.linea.messenger.design.Theme
import com.linea.messenger.design.Titles
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import java.time.Instant
import java.time.ZoneId

/** A sheet from the bottom of the screen, in the look of the chat's sheets (ChoiceSheet): `content` scrolls. */
open class ComposerSheet(context: Context, full: Boolean) : Dialog(context) {
  protected val d = context.resources.displayMetrics.density
  protected fun dp(value: Float) = Math.round(value * d)
  protected val stack = LinearLayout(context)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    stack.orientation = LinearLayout.VERTICAL
    val box = FrameLayout(context)
    box.background = GradientDrawable().apply { setColor(Theme.page(0xFF141516.toInt())); cornerRadii = floatArrayOf(28 * d, 28 * d, 28 * d, 28 * d, 0f, 0f, 0f, 0f) }
    box.addView(ScrollView(context).apply { addView(stack); isVerticalScrollBarEnabled = false; isFillViewport = true }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    setContentView(box, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, if (full) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      val height = if (full) (context.resources.displayMetrics.heightPixels * 0.92f).toInt() else WindowManager.LayoutParams.WRAP_CONTENT
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, height)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
    setCanceledOnTouchOutside(true)
  }

  override fun show() {
    try { super.show() } catch (_: Exception) { return }
    shownLast = java.lang.ref.WeakReference(this)
  }

  companion object {
    /** The sheet on the screen now, if any (for the checks). */
    var shownLast: java.lang.ref.WeakReference<ComposerSheet>? = null
  }
}

/** «Отправить позже» (iOS: Sources/Composer/SchedulePicker.swift; the reference's scheduled/SchedulePicker.tsx): quick
 *  presets, or a day (stepped with ‹ ›, up to a year ahead) with an hour and a minute typed in. The chosen moment is
 *  handed back; the message is encrypted now and the server releases it then. */
class SchedulePicker(context: Context) : ComposerSheet(context, full = true) {
  /** The moment chosen (the sheet is already closing). */
  var onPick: ((Instant) -> Unit)? = null

  private val zone = ZoneId.systemDefault()
  // Every time the sheet opens: «now» and the suggested time (the next whole hour, tomorrow after 23:00).
  private val now = Instant.now()
  private var dayOffset = 0
  private val presets = ScheduleModel.presets(now, zone)
  private val earlier = ChatIconView(context, "chevron.left", 18f, Theme.accent)
  private val later = ChatIconView(context, "chevron.right", 18f, Theme.accent)
  private val dayLabel = context.words("", 17f, Theme.text, 600).apply { gravity = Gravity.CENTER }
  private val hourField = digits("Часы")
  private val minuteField = digits("Минуты")
  private val problemLabel = context.words("", 12f, Theme.muted).apply { gravity = Gravity.CENTER; maxLines = 2 }
  private val planButton = context.words("Запланировать", 15f, Theme.onAccent, 700).apply { gravity = Gravity.CENTER; background = context.plate(Theme.accent, 16f) }

  init {
    stack.setPadding(dp(8f), dp(30f), dp(8f), dp(40f))
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    val heading = context.words("Отправить позже", 19f, Theme.text, 700)
    Titles.title(heading, Theme.TypeSize.sheetTitle) // Fonts
    stack.addView(heading, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(12f); bottomMargin = dp(14f) })
    presets.forEach { preset -> stack.addView(presetRow(preset.first, ScheduleModel.formatDeliverAt(preset.second, now, zone)) { pick(preset.second) }, LinearLayout.LayoutParams(wide, dp(64f))) }

    val card = LinearLayout(context)
    card.orientation = LinearLayout.VERTICAL
    card.setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
    card.background = context.plate(Theme.surface2, 20f, Theme.veil(0.08f))
    card.addView(context.words("ДРУГОЕ ВРЕМЯ", 12f, Theme.muted, 700).apply { letterSpacing = 0.1f })
    val dayRow = LinearLayout(context)
    dayRow.gravity = Gravity.CENTER_VERTICAL
    earlier.contentDescription = "Днём раньше"; earlier.isClickable = true
    earlier.setOnClickListener { dayOffset = maxOf(0, dayOffset - 1); Haptic.tap(earlier); showCustom() }
    later.contentDescription = "Днём позже"; later.isClickable = true
    later.setOnClickListener { dayOffset = minOf(365, dayOffset + 1); Haptic.tap(later); showCustom() }
    dayRow.addView(earlier, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    dayRow.addView(dayLabel, LinearLayout.LayoutParams(0, dp(40f), 1f))
    dayRow.addView(later, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    card.addView(dayRow, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(10f) })
    val timeRow = LinearLayout(context)
    timeRow.gravity = Gravity.CENTER
    timeRow.addView(hourField, LinearLayout.LayoutParams(dp(56f), dp(46f)))
    timeRow.addView(context.words(":", 22f, Theme.text, 700).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(dp(24f), dp(46f)))
    timeRow.addView(minuteField, LinearLayout.LayoutParams(dp(56f), dp(46f)))
    card.addView(timeRow, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    card.addView(problemLabel, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
    planButton.isClickable = true
    planButton.setOnClickListener { custom()?.let { pick(it) } }
    card.addView(planButton, LinearLayout.LayoutParams(wide, dp(46f)).apply { topMargin = dp(12f) })
    stack.addView(card, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(8f); rightMargin = dp(8f); topMargin = dp(10f) })

    val next = (now.atZone(zone).hour + 1) % 24
    hourField.setText(if (next < 10) "0$next" else "$next")
    minuteField.setText("00")
    dayOffset = if (next == 0) 1 else 0
    showCustom()
  }

  private fun digits(label: String): EditText = EditText(context).apply {
    textSize = 22f
    typeface = Theme.weight(700)
    setTextColor(Theme.text)
    gravity = Gravity.CENTER
    inputType = InputType.TYPE_CLASS_NUMBER
    filters = arrayOf(InputFilter.LengthFilter(2))
    background = context.plate(Theme.veil(0.07f), 12f)
    setPadding(0, 0, 0, 0)
    contentDescription = label
    setSelectAllOnFocus(true)
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { showCustom() }
    })
  }

  private fun presetRow(label: String, note: String, action: () -> Unit): View {
    val row = LinearLayout(context)
    row.gravity = Gravity.CENTER_VERTICAL
    row.isClickable = true; row.isFocusable = true
    row.contentDescription = "$label. $note"
    row.background = StateListDrawable().apply { addState(intArrayOf(android.R.attr.state_pressed), GradientDrawable().apply { setColor(Theme.veil(0.07f)); cornerRadius = 14 * d }) }
    row.addView(ChatIconView(context, "clock", 19f, Theme.text), LinearLayout.LayoutParams(dp(36f), dp(36f)).apply { leftMargin = dp(8f); rightMargin = dp(8f) })
    val texts = LinearLayout(context)
    texts.orientation = LinearLayout.VERTICAL
    texts.addView(context.words(label, 17f, Theme.text))
    texts.addView(context.words(note, 13f, Theme.muted))
    row.addView(texts)
    row.setOnClickListener { action() }
    return row
  }

  private val day: Instant get() = now.atZone(zone).plusDays(dayOffset.toLong()).toInstant()

  /** The moment the custom part makes, or null when the time is not «ЧЧ:ММ». */
  private fun custom(): Instant? {
    val hourText = hourField.text?.toString() ?: ""; val minuteText = minuteField.text?.toString() ?: ""
    if (hourText.length !in 1..2 || minuteText.length !in 1..2) return null
    val hour = hourText.toIntOrNull() ?: return null; val minute = minuteText.toIntOrNull() ?: return null
    if (hour > 23 || minute > 59) return null
    return ScheduleModel.withDayTime(day, hour, minute, zone)
  }

  private fun showCustom() {
    dayLabel.text = ScheduleModel.dayLabel(day, now, zone)
    earlier.isEnabled = dayOffset > 0
    later.isEnabled = dayOffset < 365
    val made = custom()
    val problem = if (made == null) "Укажи время в виде ЧЧ:ММ." else ScheduleModel.validate(made, now)
    problemLabel.text = problem ?: ""
    problemLabel.visibility = if (problem == null) View.GONE else View.VISIBLE
    planButton.text = if (made != null && problem == null) "Запланировать: " + ScheduleModel.formatDeliverAt(made, now, zone) else "Запланировать"
    planButton.isEnabled = problem == null
    planButton.alpha = if (problem == null) 1f else 0.4f
  }

  private fun pick(at: Instant) {
    // Checked once more against the clock of this moment.
    if (ScheduleModel.validate(at, Instant.now()) != null) return
    val picked = onPick
    dismiss()
    picked?.invoke(at)
  }
}

/** «Отложенные сообщения» of one chat (iOS: Sources/Composer/ScheduledScreen.swift; the reference's
 *  scheduled/ScheduledScreen.tsx): each item shows when it goes out and its text as this device still holds it;
 *  «Отправить сейчас» releases it at once, the bin deletes it before it is sent. A failed item (the other side's
 *  devices changed) is encrypted afresh and sent by the app by itself as soon as it is online — the row says so. */
class ScheduledScreen(context: Context, private val store: ScheduledStore?, private val chatId: String, private val peerName: String, private var samples: MutableList<ScheduledItem>?) : ComposerSheet(context, full = true) {
  private val subtitle = context.words("", 12f, Theme.muted)
  private val list = LinearLayout(context)
  private val watcher: (Unit) -> Unit = { fill() }

  init {
    stack.setPadding(0, dp(14f), 0, dp(40f))
    val head = LinearLayout(context)
    head.gravity = Gravity.CENTER_VERTICAL
    val close = ChatIconView(context, "xmark", 17f, Theme.text)
    close.contentDescription = "Закрыть"; close.isClickable = true
    close.setOnClickListener { dismiss() }
    head.addView(close, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { leftMargin = dp(10f) })
    val titles = LinearLayout(context)
    titles.orientation = LinearLayout.VERTICAL
    titles.addView(context.words("Отложенные сообщения", 17f, Theme.text, 700))
    titles.addView(subtitle)
    head.addView(titles, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(6f) })
    stack.addView(head)
    list.orientation = LinearLayout.VERTICAL
    stack.addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT))
    fill()
    store?.refresh()
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); ScheduledStore.changed.watch(watcher) }
  override fun onDetachedFromWindow() { ScheduledStore.changed.unwatch(watcher); super.onDetachedFromWindow() }

  private val items: List<ScheduledItem> get() = samples ?: store?.items(chatId) ?: emptyList()

  private fun fill() {
    val items = items
    subtitle.text = if (items.isEmpty()) peerName else ScheduleModel.countScheduled(items.size)
    list.removeAllViews()
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    if (items.isEmpty()) {
      val empty = LinearLayout(context)
      empty.orientation = LinearLayout.VERTICAL
      empty.gravity = Gravity.CENTER
      empty.addView(ChatIconView(context, "clock", 40f, Theme.muted), LinearLayout.LayoutParams(dp(52f), dp(52f)))
      empty.addView(context.words("Нет отложенных сообщений", 17f, Theme.text, 600).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
      empty.addView(context.words("Удержи кнопку отправки и выбери «Отправить позже» — сообщение уйдёт в нужное время.", 14f, Theme.muted).apply { gravity = Gravity.CENTER },
        LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(8f) })
      list.addView(empty, LinearLayout.LayoutParams(wide, wide).apply { leftMargin = dp(24f); rightMargin = dp(24f); topMargin = dp(120f) })
      return
    }
    list.addView(context.words("Сообщение уже зашифровано на этом устройстве и уйдёт само в выбранное время, даже если телефон будет выключен. Сервер видит только зашифрованные данные.", 12f, Theme.muted),
      LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(20f); rightMargin = dp(20f); topMargin = dp(12f); bottomMargin = dp(10f) })
    for (item in items) list.addView(card(item, store?.busy?.contains(item.id) == true), LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(16f); rightMargin = dp(16f); bottomMargin = dp(10f) })
  }

  /** One scheduled message: when it goes out, «без звука», its text, why it failed, «Отправить сейчас» and the bin. */
  private fun card(item: ScheduledItem, busy: Boolean): View {
    val ink = if (item.failed) Theme.danger else Theme.accent
    val card = LinearLayout(context)
    card.orientation = LinearLayout.VERTICAL
    card.setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
    card.background = context.plate(Theme.surface2, 20f, if (item.failed) Theme.danger else Theme.veil(0.08f))
    val top = LinearLayout(context)
    top.gravity = Gravity.CENTER_VERTICAL
    top.addView(ChatIconView(context, if (item.failed) "exclamation.circle" else "clock", 16f, ink), LinearLayout.LayoutParams(dp(18f), dp(20f)))
    top.addView(context.words(ScheduleModel.formatDeliverAt(item.deliverAt), 13f, ink, 700), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(8f) })
    if (item.silent) {
      val pill = LinearLayout(context)
      pill.gravity = Gravity.CENTER_VERTICAL
      pill.background = context.plate(Theme.alpha(Theme.accent, 0.16f), 10f)
      pill.setPadding(dp(8f), 0, dp(8f), 0)
      pill.addView(ChatIconView(context, "bell.slash", 11f, Theme.accent), LinearLayout.LayoutParams(dp(13f), dp(20f)))
      pill.addView(context.words("без звука", 11f, Theme.accent, 600), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(4f) })
      top.addView(pill, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(20f)))
    }
    card.addView(top)
    card.addView(context.words(item.body, 15f, Theme.text).apply { maxLines = 6 }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
    if (item.failed) {
      val words = if (item.canResend) ScheduleModel.failureText(item.failure) else ScheduleModel.failureText(item.failure) + " Отправить заново можно только с устройства, где сообщение написано."
      card.addView(context.words(words, 12f, Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
    }
    val buttons = LinearLayout(context)
    val sendable = !busy && !(item.failed && !item.canResend)
    val send = LinearLayout(context)
    send.gravity = Gravity.CENTER
    send.background = context.plate(Theme.accent, 14f)
    send.alpha = if (sendable) 1f else 0.45f
    send.isEnabled = sendable; send.isClickable = sendable
    if (!busy) {
      send.addView(ChatIconView(context, "send", 15f, Theme.onAccent), LinearLayout.LayoutParams(dp(18f), dp(18f)))
      send.addView(context.words("Отправить сейчас", 14f, Theme.onAccent, 700), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
    } else send.addView(android.widget.ProgressBar(context).apply { isIndeterminate = true }, LinearLayout.LayoutParams(dp(22f), dp(22f)))
    send.setOnClickListener { sendNow(item, send) }
    buttons.addView(send, LinearLayout.LayoutParams(0, dp(40f), 1f))
    val bin = ChatIconView(context, "trash", 17f, Theme.danger)
    bin.background = context.plate(Theme.alpha(Theme.accent, 0.16f), 14f)
    bin.contentDescription = "Удалить отложенное сообщение"
    bin.isEnabled = !busy; bin.isClickable = !busy
    bin.setOnClickListener { delete(item, bin) }
    buttons.addView(bin, LinearLayout.LayoutParams(dp(44f), dp(40f)).apply { leftMargin = dp(8f) })
    card.addView(buttons, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10f) })
    return card
  }

  private fun sendNow(item: ScheduledItem, view: View) {
    Haptic.light(view)
    val store = store
    if (store == null) { samples?.removeAll { it.id == item.id }; fill(); return }
    store.sendNow(item) { problem -> problem?.let { say(it) } }
  }

  private fun delete(item: ScheduledItem, view: View) {
    Haptic.light(view)
    val store = store
    if (store == null) { samples?.removeAll { it.id == item.id }; fill(); return }
    store.delete(item) { problem -> problem?.let { say(it) } }
  }

  private fun say(words: String) {
    try { AlertDialog.Builder(context).setMessage(words).setPositiveButton("Понятно", null).show() } catch (_: Exception) { }
  }

  companion object {
    /** The emulator check's sample list: one message for this evening, without sound, and one that could not go out. */
    fun demoItems(): MutableList<ScheduledItem> {
      val now = Instant.now()
      val tonight = ScheduleModel.withDayTime(now, 20, 0)
      val tomorrow = ScheduleModel.withDayTime(now.plusSeconds(86_400), 9, 0)
      return mutableListOf(
        ScheduledItem("s1", "demo", "c1", ScheduleModel.iso(tonight), "scheduled", null, ScheduleModel.iso(now), text = "Не забудь распечатки к встрече", meta = mapOf("silent" to true), cryptoState = "decrypted"),
        ScheduledItem("s2", "demo", "c2", ScheduleModel.iso(tomorrow), "failed", "BLOCKED", ScheduleModel.iso(now), text = "С днём рождения! 🎉", cryptoState = "decrypted"),
      )
    }
  }
}

/** The pill of a chat's scheduled messages: a clock and how many (red when one could not go out). */
class ScheduledPill(context: Context, source: com.linea.messenger.design.GlassSource?) : com.linea.messenger.chatlook.GlassPill(context, source) {
  private val mark = ChatIconView(context, "clock", 17f, Theme.accent)
  private val count = context.words("", 13f, Theme.accent, 700)

  init {
    placesChildren = true
    val row = LinearLayout(context)
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(dp(12f), 0, dp(14f), 0)
    row.addView(mark, LinearLayout.LayoutParams(dp(20f), dp(20f)))
    row.addView(count, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(4f) })
    addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
    isClickable = true; isFocusable = true
  }

  private fun dp(value: Float) = Math.round(value * resources.displayMetrics.density)

  fun show(n: Int, failed: Boolean) {
    val ink = if (failed) Theme.danger else Theme.accent
    mark.color = ink; mark.invalidate()
    count.text = n.toString(); count.setTextColor(ink)
    contentDescription = "Отложенные сообщения: $n"
  }

  /** Its width for the count shown, px. */
  fun wantedWidth(): Int = dp(12f + 20f + 4f + 14f) + Math.ceil(count.paint.measureText(count.text.toString()).toDouble()).toInt()

  override fun setPressed(pressed: Boolean) { super.setPressed(pressed); alpha = if (pressed) 0.7f else 1f }
}
