package com.linea.messenger.profile

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.avatars.AvatarCatalog
import com.linea.messenger.avatars.PlatinaGemView
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words

/** The emoji status picker (the reference's StatusPicker.tsx; iOS Profile/StatusPicker.swift): a panel right under
 *  the name — the default Platina gem first, then the emoji; a tap sets the status and closes it. Opaque from its
 *  first frame, it slides 8 dp into place in 0.16 s; a tap outside closes it. Without an active Platina the emoji
 *  are locked. `status`: the server's `UsernameStatus`; `anchorY`: where the name ends on the screen, px. */
class StatusPicker(context: Context, private val anchorY: Int, status: Map<String, Any?>, private val current: String?) : Dialog(context, android.R.style.Theme_Translucent_NoTitleBar) {
  private val offered = (status["statusEmojiChoices"] as? List<*>)?.mapNotNull { it as? String } ?: AvatarCatalog.statusEmoji
  private val choices = offered.filter { it in AvatarCatalog.statusEmoji }
  private val platina = Core.map(status["platina"])?.get("active") as? Boolean ?: false
  private val canSet = status["canSetStatusEmoji"] as? Boolean ?: platina
  var onPick: ((String?) -> Unit)? = null
  private val panel = FrameLayout(context)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val outside = FrameLayout(context)
    outside.contentDescription = "Закрыть"
    outside.setOnClickListener { close() }
    outside.clipChildren = false
    panel.background = GradientDrawable().apply { setColor(Theme.panel(0xFF1C1D20.toInt())); cornerRadius = 22f * context.resources.displayMetrics.density }
    panel.elevation = 24f * context.resources.displayMetrics.density
    panel.isClickable = true
    outside.addView(panel, FrameLayout.LayoutParams(0, 0))
    setContentView(outside, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
    }
    outside.post { build(outside) }
  }

  private fun build(outside: FrameLayout) {
    val c = context
    val screenW = outside.width; val screenH = outside.height
    val width = minOf(screenW, c.px(520f)) - c.px(24f)
    val columns = 8; val pad = c.px(10f); val gap = c.px(4f)
    val cell = (width - pad * 2 - gap * (columns - 1)) / columns
    var y = pad
    if (!canSet) {
      val note = c.words("Статус меняется с активной Platina", 12f, Theme.muted)
      note.gravity = Gravity.CENTER
      panel.addView(note, FrameLayout.LayoutParams(width - pad * 2, c.px(16f)).apply { leftMargin = pad; topMargin = y })
      y += c.px(16f + 8f)
    }
    var index = 0
    fun place(view: View) {
      val column = index % columns; val row = index / columns
      panel.addView(view, FrameLayout.LayoutParams(cell, cell).apply { leftMargin = pad + column * (cell + gap); topMargin = y + row * (cell + gap) })
      index += 1
    }
    fun cellView(selected: Boolean, label: String, enabled: Boolean): FrameLayout = FrameLayout(c).apply {
      background = GradientDrawable().apply {
        cornerRadius = 12f * c.resources.displayMetrics.density
        setColor(if (selected) Theme.alpha(Theme.accent, 0.16f) else Color.TRANSPARENT)
        if (selected) setStroke(Math.round(1.5f * c.resources.displayMetrics.density), Theme.accent)
      }
      contentDescription = label
      isClickable = enabled
      isEnabled = enabled
      alpha = if (enabled) 1f else 0.4f
    }
    if (platina) {
      val gemCell = cellView(current == null, "Значок Platina по умолчанию", true)
      gemCell.addView(PlatinaGemView(c, Math.round(cell / c.resources.displayMetrics.density * 0.5f).toFloat()), FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
      gemCell.setOnClickListener { pick(null, it) }
      place(gemCell)
    }
    for (emoji in choices) {
      val button = cellView(current == emoji, "Статус $emoji", canSet)
      button.addView(TextView(c).apply { text = emoji; gravity = Gravity.CENTER; textSize = cell / c.resources.displayMetrics.density * 0.62f; includeFontPadding = false }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      button.setOnClickListener { pick(emoji, it) }
      place(button)
    }
    val rows = (index + columns - 1) / columns
    val bottomInset = outside.rootWindowInsets?.systemWindowInsetBottom ?: 0
    val topInset = outside.rootWindowInsets?.systemWindowInsetTop ?: 0
    val height = minOf(c.px(360f), (screenH * 0.45f).toInt(), y + rows * (cell + gap) - gap + pad)
    val top = maxOf(topInset + c.px(8f), minOf(anchorY + c.px(14f), screenH - bottomInset - height - c.px(8f)))
    panel.layoutParams = FrameLayout.LayoutParams(width, height).apply { leftMargin = (screenW - width) / 2; topMargin = top }
    panel.translationY = -c.px(8f).toFloat()
    panel.animate().translationY(0f).setDuration(160).start()
  }

  private fun pick(emoji: String?, view: View) {
    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    val done = onPick
    dismiss()
    done?.invoke(emoji)
  }

  private fun close() {
    panel.animate().alpha(0f).setDuration(120).withEndAction { dismiss() }.start()
  }
}
