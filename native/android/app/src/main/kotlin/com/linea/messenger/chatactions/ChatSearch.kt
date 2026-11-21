package com.linea.messenger.chatactions

import android.annotation.SuppressLint
import android.content.Context
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.chatlook.GlassPill
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import java.util.Locale

/** «Поиск в этом чате» (iOS: Sources/ChatActions/ChatSearch.swift; the reference's ChatScreen.tsx search bar): a glass
 *  line under the header with the words to look for, «Найдено: N» or «Ничего», and a cross that closes it. While it is
 *  open the chat shows only the messages whose text (or file name) holds the words; the search runs over what this
 *  device has opened. */
@SuppressLint("ViewConstructor")
class ChatSearchBar(context: Context, source: GlassSource?) : GlassPill(context, source) {
  companion object {
    const val HEIGHT = 46f
    private val ru = Locale.forLanguageTag("ru-RU")

    /** Whether a message holds the words of the search (its text, or the name of its file). */
    fun matches(message: Map<String, Any?>, needle: String): Boolean {
      if (needle.isEmpty()) return true
      if ((message["text"] as? String ?: "").lowercase(ru).contains(needle)) return true
      val name = (message["attachment"] as? Map<*, *>)?.get("name") as? String ?: ""
      return name.lowercase(ru).contains(needle)
    }
  }

  /** The words changed (already trimmed and lower-cased; empty: everything shows). */
  var onChange: ((String) -> Unit)? = null
  /** The cross was pressed. */
  var onClose: (() -> Unit)? = null

  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  val input = EditText(context)
  private val count = TextView(context)

  init {
    placesChildren = true
    radius = 22 * d
    val row = LinearLayout(context)
    row.gravity = Gravity.CENTER_VERTICAL
    row.addView(ChatIconView(context, "search", 16f, Theme.muted), LinearLayout.LayoutParams(dp(18f), dp(18f)).apply { leftMargin = dp(14f); rightMargin = dp(9f) })
    input.textSize = 15f
    input.setTextColor(Theme.text)
    input.setHintTextColor(Theme.muted)
    input.hint = "Поиск в этом чате"
    input.contentDescription = "Поиск в этом чате"
    input.background = null
    input.isSingleLine = true
    input.imeOptions = EditorInfo.IME_ACTION_SEARCH
    input.setPadding(0, 0, 0, 0)
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { onChange?.invoke(needle) }
    })
    input.setOnEditorActionListener { _, _, _ -> keyboard()?.hideSoftInputFromWindow(input.windowToken, 0); true }
    row.addView(input, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    count.textSize = 11f
    count.setTextColor(Theme.muted)
    row.addView(count, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(6f) })
    val close = ChatIconView(context, "xmark", 15f, Theme.muted)
    close.contentDescription = "Закрыть поиск"
    close.isClickable = true
    close.setOnClickListener { onClose?.invoke() }
    row.addView(close, LinearLayout.LayoutParams(dp(34f), dp(38f)).apply { leftMargin = dp(4f); rightMargin = dp(6f) })
    addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private fun keyboard() = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

  /** The words as the list compares them (the reference: trimmed, lower case by the Russian rules). */
  val needle: String get() = input.text.toString().trim().lowercase(ru)

  fun begin() {
    input.setText("")
    count.text = ""
    input.requestFocus()
    keyboard()?.showSoftInput(input, 0)
  }

  fun end() { keyboard()?.hideSoftInputFromWindow(input.windowToken, 0) }

  /** «Найдено: N», or «Ничего» — only while there are words. */
  fun show(found: Int) {
    count.text = if (needle.isEmpty()) "" else if (found > 0) "Найдено: $found" else "Ничего"
    count.visibility = if (count.text.isEmpty()) View.GONE else View.VISIBLE
  }
}
