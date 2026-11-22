package com.linea.messenger.calls

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.plate
import com.linea.messenger.design.words

/** Звонок › «Звук» on Android (the reference's calls/CallAudioPanel.tsx): one device takes both the sound and the
 *  microphone — the system does not let an app split them in a call. Drawn inside the call screen, a dark card at
 *  the bottom over a dim. */
@SuppressLint("ViewConstructor")
class CallAudioPanel(context: Context, private val onClose: () -> Unit) : FrameLayout(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float): Int = Math.round(value * d)
  private val card = LinearLayout(context)
  private val list = LinearLayout(context)
  private val scroll = ScrollView(context)
  private var shownKey = ""
  private val refresh = object : Runnable { override fun run() { rebuild(); postDelayed(this, 1500) } }
  var bottomInset = 0
    set(value) { if (field != value) { field = value; requestLayout() } }

  init {
    val backdrop = View(context)
    backdrop.setBackgroundColor(0x73000000)
    backdrop.contentDescription = "Закрыть"
    backdrop.setOnClickListener { onClose() }
    addView(backdrop, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    card.orientation = LinearLayout.VERTICAL
    card.background = context.plate(0xF71C1E26.toInt(), 26f)
    card.setPadding(0, dp(8f), 0, dp(8f))
    card.isClickable = true
    val header = LinearLayout(context)
    header.orientation = LinearLayout.HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    header.minimumHeight = dp(44f)
    header.setPadding(dp(14f), 0, dp(14f), 0)
    val title = context.words("Звук", 18f, 0xFFFFFFFF.toInt(), 700)
    header.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    val close = object : View(context) {
      override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, "close", width / 2f, height / 2f, 22f * d, 0xFFFFFFFF.toInt())
    }
    close.contentDescription = "Закрыть"
    close.setOnClickListener { onClose() }
    header.addView(close, LinearLayout.LayoutParams(dp(22f), dp(22f)))
    card.addView(header)
    list.orientation = LinearLayout.VERTICAL
    list.setPadding(dp(6f), 0, dp(6f), dp(6f))
    scroll.overScrollMode = OVER_SCROLL_NEVER
    scroll.addView(list)
    card.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    addView(card)
    rebuild()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    postDelayed(refresh, 1500)
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(refresh)
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left; val height = bottom - top
    getChildAt(0).layout(0, 0, width, height)
    val cardWidth = width - dp(20f)
    card.measure(MeasureSpec.makeMeasureSpec(cardWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec((height * 0.72f).toInt(), MeasureSpec.AT_MOST))
    val cardBottom = height - bottomInset - dp(10f)
    card.layout(dp(10f), cardBottom - card.measuredHeight, dp(10f) + cardWidth, cardBottom)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    getChildAt(0).measure(widthSpec, heightSpec)
  }

  private fun label(kind: String): String = when (kind) {
    "earpiece" -> "Телефон"
    "speaker" -> "Громкий динамик"
    "bluetooth" -> "Bluetooth-наушники"
    "wired" -> "Проводные наушники"
    else -> kind
  }

  private fun icon(kind: String): String = when (kind) {
    "speaker" -> "volume-high"
    "earpiece" -> "call"
    else -> "headset-outline"
  }

  private fun rebuild() {
    val devices = CallAudio.devicesNow()
    val chosen = CallAudio.chosenKind
    val selected = CallAudio.deviceNow()
    val key = devices.joinToString(",") + "|" + chosen + "|" + selected
    if (key == shownKey) return
    shownKey = key
    list.removeAllViews()
    val heading = context.words("УСТРОЙСТВО ЗВУКА", 12f, 0x99FFFFFF.toInt(), 700)
    heading.letterSpacing = 1.2f / 12f
    heading.setPadding(dp(14f), dp(10f), dp(14f), dp(4f))
    list.addView(heading)
    list.addView(row("phone-portrait-outline", "Как в системе", chosen == null) { CallAudio.choose(null); rebuild() })
    for (device in devices) list.addView(row(icon(device), label(device), chosen != null && selected == device) { CallAudio.choose(device); rebuild() })
    val note = context.words("На Android звук и микрофон идут через одно устройство: система не даёт приложению разделить их в звонке.", 12f, 0x99FFFFFF.toInt())
    note.setPadding(dp(14f), dp(8f), dp(14f), 0)
    if (android.os.Build.VERSION.SDK_INT >= 28) note.lineHeight = dp(17f)
    list.addView(note)
    requestLayout()
  }

  private fun row(icon: String, words: String, on: Boolean, press: () -> Unit): View {
    val row = object : LinearLayout(context) {
      override fun drawableStateChanged() {
        super.drawableStateChanged()
        background = context.plate(if (isPressed) 0x24FFFFFF else if (on) 0x1AFFFFFF else 0, 14f)
      }
    }
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    row.minimumHeight = dp(50f)
    row.setPadding(dp(14f), 0, dp(14f), 0)
    row.background = context.plate(if (on) 0x1AFFFFFF else 0, 14f)
    row.isClickable = true
    row.contentDescription = words
    row.isSelected = on
    row.setOnClickListener { press() }
    val picture = object : View(context) {
      override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, icon, width / 2f, height / 2f, 20f * d, 0xFFFFFFFF.toInt())
    }
    row.addView(picture, LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { marginEnd = dp(12f) })
    val text: TextView = context.words(words, 16f, 0xFFFFFFFF.toInt())
    row.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    if (on) {
      val tick = object : View(context) {
        override fun onDraw(canvas: Canvas) = IonIcon.draw(canvas, "checkmark", width / 2f, height / 2f, 20f * d, 0xFFFFFFFF.toInt())
      }
      row.addView(tick, LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { marginStart = dp(12f) })
    }
    return row
  }
}
