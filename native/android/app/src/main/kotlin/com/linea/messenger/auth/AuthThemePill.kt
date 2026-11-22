package com.linea.messenger.auth

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import com.linea.messenger.core.Core
import com.linea.messenger.design.GlassBacking
import com.linea.messenger.design.SymbolView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.ThemeStore

/** L: the theme pill of the sign-in screen (the reference's App.tsx `ThemeAccess`; iOS Auth/AuthViewController.swift
 *  `paintThemePill`): clear glass (radius 24, 44 tall, 14 inside), the moon / sun / half circle (17), the theme's
 *  name (12, semibold), a small chevron (12, quiet). It names the theme on screen (the night theme at night), as the
 *  «Оформление» row in the settings does; a touch offers the four built-in themes (the palettes belong to Platina,
 *  which needs an account). */
@SuppressLint("ViewConstructor")
class AuthThemePill(context: Context) : LinearLayout(context) {
  /** A theme was put on: the owner draws the screen again in the new look. */
  var onChanged: (() -> Unit)? = null

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), 0, context.px(14f), 0)
    GlassBacking.put(this, 0.94f, context.px(24f).toFloat())
    val state = ThemeStore.nightState()
    val shown = state["shown"] as? String ?: "black"
    val night = state["night"] as? Boolean ?: false
    val symbol = if (ThemeStore.mode == "system" && !night) "halfcircle" else if (shown == "light") "sun" else "moon"
    addView(if (symbol == "halfcircle") HalfCircle(context) else SymbolView(context, symbol, 17f, Theme.text), LayoutParams(context.px(20f), context.px(20f)))
    addView(context.words(ThemeStore.themeName(shown), 12f, Theme.text, 600), LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = context.px(8f) })
    addView(SymbolView(context, "chevron.down", 12f, Theme.muted), LayoutParams(context.px(14f), context.px(14f)).apply { marginStart = context.px(8f) })
    isClickable = true
    isFocusable = true
    contentDescription = "Оформление: " + ThemeStore.themeName(shown)
    setOnClickListener { offer() }
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  private fun offer() {
    val shown = ThemeStore.nightState()["shown"] as? String ?: "black"
    val items = ThemeStore.list("appearances").mapNotNull { item ->
      val id = item["value"] as? String ?: return@mapNotNull null
      val label = item["label"] as? String ?: return@mapNotNull null
      id to (if (id == shown) "$label ✓" else label)
    }
    if (items.isEmpty()) return
    AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert)
      .setTitle("Оформление")
      .setItems(items.map { it.second }.toTypedArray()) { _, which -> choose(items[which].first) }
      .setNegativeButton("Отмена", null)
      .show()
  }

  /** The choice follows the settings' theme cards (`settingsThemeTap`, settings/Appearance.kt `choose`). */
  private fun choose(id: String) {
    val state = ThemeStore.nightState()
    val night = state["night"] as? Boolean ?: false
    val known = state["known"] as? Boolean ?: true
    val auto = state["auto"] as? Boolean ?: false
    val plan = Core.map(Core.view("settingsThemeTap", listOf(id, night))) ?: return
    if (plan["nightOff"] == true) DevicePreferences.set(mapOf("nightForced" to false, "nightForcedAt" to if (known) auto else true))
    (plan["darkTheme"] as? String)?.let { ThemeStore.darkTheme = it }
    (plan["mode"] as? String)?.let { mode ->
      if (DevicePreferences.word("nightMode") == null) DevicePreferences.set(mapOf("nightMode" to if (ThemeStore.mode == "system") "system" else "off"))
      ThemeStore.mode = mode
    }
    if (ThemeStore.refresh()) onChanged?.invoke()
  }

  /** «Как в системе»: a ring with its left half filled. */
  private class HalfCircle(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val box = RectF()
    override fun onDraw(canvas: Canvas) {
      val d = resources.displayMetrics.density
      val r = 7.5f * d; val cx = width / 2f; val cy = height / 2f
      paint.color = Theme.text
      paint.style = Paint.Style.STROKE; paint.strokeWidth = 1.6f * d
      canvas.drawCircle(cx, cy, r, paint)
      paint.style = Paint.Style.FILL
      box.set(cx - r, cy - r, cx + r, cy + r)
      canvas.drawArc(box, 90f, 180f, true, paint)
    }
  }
}
