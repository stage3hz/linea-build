package com.linea.messenger.polls

import android.content.Context
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.composer.ComposerSheet
import com.linea.messenger.design.Theme
import com.linea.messenger.design.Titles
import com.linea.messenger.design.plate
import com.linea.messenger.design.words

/** «Новый опрос» (iOS: Sources/Polls/PollComposer.swift; the reference's PollBubble.tsx `PollComposer`): the question,
 *  from two to ten options, «Несколько ответов», «Отправить опрос». Limits as the reference's POLL_LIMITS (the core
 *  checks them once more). */
class PollComposer(context: Context) : ComposerSheet(context, full = true) {
  companion object {
    const val QUESTION_LIMIT = 255
    const val OPTION_LIMIT = 100
    const val MIN_OPTIONS = 2
    const val MAX_OPTIONS = 10
  }

  /** The poll to send: `{question, options, multiple}` (the sheet is already closing). */
  var onSend: ((Map<String, Any?>) -> Unit)? = null

  private val questionField = field("Вопрос", QUESTION_LIMIT)
  private val optionsBox = LinearLayout(context)
  private val optionFields = ArrayList<EditText>()
  private val addButton = LinearLayout(context)
  @Suppress("DEPRECATION")
  private val multipleSwitch = Switch(context)
  private val sendButton = LinearLayout(context)

  init {
    stack.setPadding(dp(16f), dp(30f), dp(16f), dp(40f))
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    val heading = context.words("Новый опрос", 19f, Theme.text, 700)
    Titles.title(heading, Theme.TypeSize.sheetTitle) // Fonts
    stack.addView(heading, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(4f); bottomMargin = dp(18f) })
    stack.addView(questionField, LinearLayout.LayoutParams(wide, dp(46f)).apply { bottomMargin = dp(10f) })
    optionsBox.orientation = LinearLayout.VERTICAL
    stack.addView(optionsBox, LinearLayout.LayoutParams(wide, wrap))
    addButton.gravity = Gravity.CENTER_VERTICAL
    addButton.isClickable = true
    addButton.addView(ChatIconView(context, "plus.circle", 19f, Theme.accent), LinearLayout.LayoutParams(dp(24f), dp(24f)))
    addButton.addView(context.words("Добавить вариант", 14f, Theme.accent, 600), LinearLayout.LayoutParams(wrap, wrap).apply { leftMargin = dp(8f) })
    addButton.setOnClickListener { addOption(); optionFields.lastOrNull()?.requestFocus(); showReady() }
    stack.addView(addButton, LinearLayout.LayoutParams(wide, dp(36f)).apply { bottomMargin = dp(8f) })
    val multiple = LinearLayout(context)
    multiple.gravity = Gravity.CENTER_VERTICAL
    multiple.addView(context.words("Несколько ответов", 14f, Theme.text), LinearLayout.LayoutParams(0, wrap, 1f))
    multipleSwitch.contentDescription = "Несколько ответов"
    com.linea.messenger.settings.SettingsLook.paint(multipleSwitch) // E: the reference's switch colours
    multiple.addView(multipleSwitch)
    stack.addView(multiple, LinearLayout.LayoutParams(wide, dp(46f)))
    sendButton.gravity = Gravity.CENTER
    sendButton.background = context.plate(Theme.accent, 16f)
    sendButton.isClickable = true
    sendButton.addView(ChatIconView(context, "chart.bar", 16f, Theme.onAccent), LinearLayout.LayoutParams(dp(20f), dp(20f)))
    sendButton.addView(context.words("Отправить опрос", 15f, Theme.onAccent, 700), LinearLayout.LayoutParams(wrap, wrap).apply { leftMargin = dp(8f) })
    sendButton.setOnClickListener { send() }
    stack.addView(sendButton, LinearLayout.LayoutParams(wide, dp(50f)).apply { topMargin = dp(8f) })
    addOption(); addOption()
    showReady()
    questionField.requestFocus()
  }

  private fun field(hint: String, limit: Int): EditText = EditText(context).apply {
    textSize = 15f
    setTextColor(Theme.text)
    setHintTextColor(Theme.muted)
    this.hint = hint
    contentDescription = hint
    background = context.plate(Theme.surface2, 14f, Theme.veil(0.08f))
    setPadding(dp(13f), 0, dp(13f), 0)
    isSingleLine = true
    imeOptions = EditorInfo.IME_ACTION_NEXT
    filters = arrayOf(InputFilter.LengthFilter(limit))
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { showReady() }
    })
  }

  private fun addOption() {
    if (optionFields.size >= MAX_OPTIONS) return
    val made = field("Вариант ${optionFields.size + 1}", OPTION_LIMIT)
    optionFields.add(made)
    renumber()
  }

  /** The hints follow the order («Вариант 1», «Вариант 2»…) and the rows are made again. */
  private fun renumber() {
    optionsBox.removeAllViews()
    val many = optionFields.size > MIN_OPTIONS
    optionFields.forEachIndexed { index, field ->
      field.hint = "Вариант ${index + 1}"; field.contentDescription = field.hint
      (field.parent as? android.view.ViewGroup)?.removeView(field)
      val row = LinearLayout(context)
      row.gravity = Gravity.CENTER_VERTICAL
      row.addView(field, LinearLayout.LayoutParams(0, dp(46f), 1f))
      if (many) {
        val remove = ChatIconView(context, "xmark", 15f, Theme.muted)
        remove.contentDescription = "Убрать вариант"
        remove.isClickable = true
        remove.setOnClickListener { optionFields.remove(field); renumber(); showReady() }
        row.addView(remove, LinearLayout.LayoutParams(dp(34f), dp(34f)).apply { leftMargin = dp(6f) })
      }
      optionsBox.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(10f) })
    }
    addButton.visibility = if (optionFields.size >= MAX_OPTIONS) View.GONE else View.VISIBLE
  }

  private val question: String get() = questionField.text.toString().trim()
  private val options: List<String> get() = optionFields.map { it.text.toString().trim() }.filter { it.isNotEmpty() }
  private val ready: Boolean get() = question.isNotEmpty() && options.size >= MIN_OPTIONS

  private fun showReady() {
    sendButton.isEnabled = ready
    sendButton.alpha = if (ready) 1f else 0.4f
  }

  private fun send() {
    if (!ready) return
    val poll = mapOf("question" to question, "options" to options, "multiple" to multipleSwitch.isChecked)
    val send = onSend
    dismiss()
    send?.invoke(poll)
  }
}
