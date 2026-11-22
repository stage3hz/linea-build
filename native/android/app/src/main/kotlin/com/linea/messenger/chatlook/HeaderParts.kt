package com.linea.messenger.chatlook

import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.design.Theme
import com.linea.messenger.shell.ProgressiveEdgeView

/** The soft edge under the chat's header and above its composer (the reference's tabInset.tsx `ScrollEdgeEffect` with
 *  ChatScreen.tsx's numbers, drawn as the progressive edge of shell/EdgeFade.kt; iOS ChatLook/HeaderParts.swift): the
 *  messages that pass under the glass are blurred hardest at the screen's edge (Android 12 and later) and covered by
 *  the page's colour (the wallpaper's own colour at that edge), so they cannot be read through the glass, and dissolve
 *  `FADE` dp past it. The owner lays it out and sets `size`, the bar's height from the screen's edge, px. */
class HeaderEdgeView(context: Context, top: Boolean = true) : ProgressiveEdgeView(context, top) {
  /** How strongly the colour covers (owner: as in the messenger he compared with — a plain colour .85, a gradient
   *  wallpaper .75, a picture .7). */
  var alphaOfEdge = 0.85f
    set(value) { field = value; peak = value }

  // Header: 34 dp past it, fading over 80 dp; composer: from 20 dp above it, fading over 60 dp.
  // The header's pills are clear glass: the colour stays solid behind the whole header and fades past it.
  init { peak = alphaOfEdge; reach = if (top) 34f else 20f; fade = if (top) 80f else 60f; solidThroughBar = top }
}

/** A long touch on the avatar in the header (the reference's ChatScreen.tsx avatar `ContextMenu`): a large card with
 *  the picture (220 dp), the name and the status, and under it «Открыть профиль», «Поиск», «Отправить подарок». */
class AvatarPeek(context: Context, picture: View, name: String, status: String, top: Int, val items: List<Item>) : Dialog(context) {
  class Item(val symbol: String, val label: String, val run: () -> Unit)

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val card = FrameLayout(context)
  private val menu = LinearLayout(context)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val root = FrameLayout(context)
    root.setOnClickListener { dismiss() }
    val cardFill = if (Theme.dark) 0xFF1C1C1E.toInt() else 0xFFFFFFFF.toInt()
    card.background = GradientDrawable().apply { setColor(cardFill); cornerRadius = 28 * d }
    card.isClickable = true
    card.addView(picture, FrameLayout.LayoutParams(dp(220f), dp(220f)).apply { leftMargin = dp(18f); topMargin = dp(18f) })
    card.addView(TextView(context).apply {
      text = name; textSize = 18f; typeface = Theme.weight(700); setTextColor(Theme.text); gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
    }, FrameLayout.LayoutParams(dp(232f), dp(22f)).apply { leftMargin = dp(12f); topMargin = dp(18f + 220f + 14f) })
    card.addView(TextView(context).apply {
      text = status; textSize = 14f; setTextColor(Theme.muted); gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
    }, FrameLayout.LayoutParams(dp(232f), dp(18f)).apply { leftMargin = dp(12f); topMargin = dp(18f + 220f + 14f + 24f) })
    val cardHeight = dp(18f + 220f + 14f + 22f + 2f + 18f + 18f)
    root.addView(card, FrameLayout.LayoutParams(dp(256f), cardHeight, Gravity.CENTER_HORIZONTAL).apply { topMargin = top })

    menu.orientation = LinearLayout.VERTICAL
    menu.background = GradientDrawable().apply { setColor(if (Theme.dark) 0xF22A2B2E.toInt() else 0xF7F7F7F9.toInt()); cornerRadius = 18 * d }
    menu.clipToOutline = true
    for (item in items) {
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(16f), 0, dp(16f), 0)
        isClickable = true; isFocusable = true
        contentDescription = item.label
        background = android.graphics.drawable.StateListDrawable().apply { addState(intArrayOf(android.R.attr.state_pressed), ColorDrawable(Theme.veil(0.08f))) }
        setOnClickListener { dismiss(); item.run() }
      }
      row.addView(ChatIconView(context, item.symbol, 18f, Theme.text), LinearLayout.LayoutParams(dp(24f), dp(24f)).apply { rightMargin = dp(12f) })
      row.addView(TextView(context).apply { text = item.label; textSize = 16f; setTextColor(Theme.text) })
      menu.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48f)))
    }
    root.addView(menu, FrameLayout.LayoutParams(dp(250f), dp(48f) * items.size, Gravity.CENTER_HORIZONTAL).apply { topMargin = top + cardHeight + dp(10f) })
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      setDimAmount(if (Theme.dark) 0.55f else 0.3f)
      addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      // The chat behind is blurred, as the reference's thin material (Android 12 and later, where the device allows).
      if (Build.VERSION.SDK_INT >= 31) { addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND); attributes = attributes.apply { blurBehindRadius = dp(24f) } }
    }
    setCanceledOnTouchOutside(true)
  }

  override fun show() {
    try { super.show() } catch (_: Exception) { return }
    last = java.lang.ref.WeakReference(this)
    // The card grows from 0.86 with a spring, the menu comes down 12 dp into place.
    card.scaleX = 0.86f; card.scaleY = 0.86f
    card.animate().scaleX(1f).scaleY(1f).setDuration(320).setInterpolator(OvershootInterpolator(1.4f)).start()
    menu.alpha = 0f; menu.translationY = -12 * d
    menu.animate().alpha(1f).translationY(0f).setDuration(260).start()
  }

  companion object {
    /** The card on the screen now, if any (for the checks). */
    var last: java.lang.ref.WeakReference<AvatarPeek>? = null
  }
}
