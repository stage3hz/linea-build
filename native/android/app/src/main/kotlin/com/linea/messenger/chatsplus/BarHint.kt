package com.linea.messenger.chatsplus

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.TextView
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate

/** ChatsPlus: the words above the bar about the hold — «Удержи «Чаты» — остальные разделы» (TabBar.tsx
 *  `useBarHint`): shown on the first six starts of the app until the list of the other sections has been opened once
 *  (by the hold, the swipe up or accessibility), then never again (native/ios/Sources/ChatsPlus/BarHint.swift). */
class BarHintView(context: Context) : TextView(context) {
  init {
    text = "Удержи «Чаты» — остальные разделы"
    textSize = 12.5f
    typeface = Theme.weight(600)
    gravity = Gravity.CENTER
    includeFontPadding = false
    setTextColor(Theme.text)
    background = context.plate(if (Theme.dark) 0xF016181D.toInt() else 0xF5FFFFFF.toInt(), 14f, Theme.veil(0.12f))
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    isClickable = false
    visibility = if (wanted(context)) View.VISIBLE else View.GONE
  }

  /** The gesture has been used: the words go for good. */
  fun used() {
    if (decided == false && visibility != View.VISIBLE) return
    decided = false
    prefs(context).edit().putString(KEY, "used").apply()
    animate().alpha(0f).setDuration(200).withEndAction { visibility = View.GONE }.start()
  }

  /** The width it wants, px. */
  fun wide(): Int = (paint.measureText(text.toString()) + 26f * resources.displayMetrics.density).toInt()

  companion object {
    /** The reference keeps «linea.hint.bar-scrub.v1»; this app counts its own starts under «.v2»: the copy of the
     *  old app's settings (storage/OldAppSettings.kt) brought over «used» or six starts already counted there, so
     *  on a phone that had the old app the words were never shown here (the owner's report: no hint about the hold). */
    const val KEY = "linea.hint.bar-scrub.v2"
    const val STARTS = 6
    private var decided: Boolean? = null

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("chatsplus", Context.MODE_PRIVATE)

    /** What was kept («used» or how many starts showed the words) → whether to show them now, and what to keep
     *  then (null: nothing changes). */
    fun decide(value: String?): Pair<Boolean, String?> {
      val kept = value ?: ""
      val seen = kept.toIntOrNull() ?: 0
      return if (kept != "used" && seen < STARTS) true to (seen + 1).toString() else false to null
    }

    /** Only for the checks: the next view asks the preferences again. */
    fun forget() { decided = null }

    /** Whether to show the words in this run of the app (counted once per start). */
    private fun wanted(context: Context): Boolean {
      decided?.let { return it }
      val prefs = prefs(context)
      val (wantedNow, keep) = decide(prefs.getString(KEY, ""))
      var show = wantedNow
      if (keep != null) prefs.edit().putString(KEY, keep).apply()
      // The emulator check: the shots of the other checks stay as they were; the words only when asked for.
      ChatsPlusDemo.hint?.let { show = it }
      decided = show
      return show
    }
  }
}
