package com.linea.messenger.composer

import android.app.AlertDialog
import android.content.Context
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.chatactions.ComposerField
import com.linea.messenger.chatlook.Haptic
import com.linea.messenger.chatlook.LookDemo
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import java.time.Instant
import java.util.UUID

/** What the composer of a chat has beyond the field and the send button (iOS: Sources/Composer/ComposerExtras.swift;
 *  the reference's ChatScreen.tsx): the long touch on «Отправить» («Отправить без звука», «Отправить позже»), the
 *  pill of the chat's scheduled messages, the emoji button with its panel, and the formatting bar over a selection
 *  with the styles shown in the field. ChatScreenActions owns it and hands it the views in `install`. Main thread. */
class ComposerExtras(private val context: Context) {
  companion object {
    /** The room the emoji button takes inside the composer, right of the field (dp). */
    const val EMOJI_ROOM = 38f
  }

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  private var host: ViewGroup? = null
  private var behind: GlassSource? = null
  private var field: ComposerField? = null
  private var messenger: Messenger? = null
  private var chatId = ""
  private var peerName = ""

  /** A message is to go out with these options (the long touch on the send button). */
  var onSend: ((silent: Boolean, deliverAt: Instant?) -> Unit)? = null
  /** Whether the send button may offer its options now (not while editing or forwarding). */
  var canOffer: (() -> Boolean)? = null
  /** The layout changed (the panel, the bar, the pill). */
  var onLayout: (() -> Unit)? = null
  /** A short line to show under the header. */
  var onSay: ((String) -> Unit)? = null

  private lateinit var emojiButton: ChatIconView
  private var panel: EmojiPanel? = null
  /** The keyboard's last height, px. */
  private var keyboardHeight = 0
  private lateinit var formatBar: FormatBar
  private lateinit var pill: ScheduledPill
  /** The emulator check's sample list (no account). */
  private var sampleScheduled: MutableList<ScheduledItem> = ArrayList()

  /** The styles of the text in the field, as entities over its whole (untrimmed) text. */
  var entities: List<Map<String, Any?>> = emptyList()
    private set
  private var lastText = ""
  /** The field shows styles now (so plain text is set back once they are gone). */
  private var styled = false
  private val scheduledWatcher: (Unit) -> Unit = { showPill() }

  // Setting up

  fun install(host: ViewGroup, behind: GlassSource?, field: ComposerField, send: View, composer: FrameLayout, messenger: Messenger?, chatId: String, peerId: String, peerName: String) {
    this.host = host; this.behind = behind; this.field = field; this.messenger = messenger; this.chatId = chatId; this.peerName = peerName

    send.setOnLongClickListener { sendHeld(); true }
    // TalkBack says what the long touch does (the iPhone's hint «Удержи: без звука или отправить позже»).
    send.accessibilityDelegate = object : View.AccessibilityDelegate() {
      override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(host, info)
        info.addAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_LONG_CLICK, "без звука или отправить позже"))
      }
    }

    emojiButton = ChatIconView(context, "face.smiling", 21f, Theme.muted)
    emojiButton.contentDescription = "Стикеры и эмодзи"
    emojiButton.isClickable = true
    emojiButton.setOnClickListener { toggleEmoji() }
    composer.addView(emojiButton, FrameLayout.LayoutParams(dp(EMOJI_ROOM), dp(44f), Gravity.END or Gravity.BOTTOM).apply { rightMargin = dp(2f + 44f - 4f); bottomMargin = dp(2f) })
    (field.layoutParams as? FrameLayout.LayoutParams)?.let { it.rightMargin += dp(EMOJI_ROOM - 4f); field.layoutParams = it }

    formatBar = FormatBar(context, behind)
    formatBar.visibility = View.GONE
    formatBar.onAction = { type -> apply(type, null) }
    formatBar.onLink = { askLink() }
    host.addView(formatBar)

    pill = ScheduledPill(context, behind)
    pill.visibility = View.GONE
    pill.setOnClickListener { openScheduled() }
    host.addView(pill)

    // A selection shows the formatting bar; the keyboard coming back puts the panel away.
    field.onSelection = { selectionChanged() }
    field.setOnFocusChangeListener { _, focused -> if (focused && panel != null) closeEmoji(false); selectionChanged() }
    field.setOnClickListener { if (panel != null) closeEmoji(false) }

    messenger?.let { ScheduledStore.of(it).remember(chatId, peerId); ScheduledStore.of(it).refresh() }
    lastText = field.text?.toString() ?: ""
    if (messenger == null) demoSeed()
    showPill()
  }

  fun attached() { ScheduledStore.changed.watch(scheduledWatcher) }
  fun detached() { ScheduledStore.changed.unwatch(scheduledWatcher); closeEmoji(false) }

  // Layout

  /** The keyboard's height now (px; 0: down): the panel takes the keyboard's last height. */
  fun keyboard(height: Int) {
    if (height > 0) {
      keyboardHeight = height
      // The keyboard came back: the panel gives way to it.
      if (panel != null) closeEmoji(false)
    }
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** Places the formatting bar above `above` and the scheduled pill under the header; gives the new top of what
   *  stands above the field (px). */
  fun place(width: Int, height: Int, composerLeft: Int, composerWidth: Int, above: Int, top: Int, hidden: Boolean): Int {
    emojiButton.visibility = if (hidden) View.INVISIBLE else View.VISIBLE
    emojiButton.symbol = if (panel == null) "face.smiling" else "keyboard"
    emojiButton.color = if (panel == null) Theme.muted else Theme.accent
    emojiButton.invalidate()
    var next = above
    if (formatBar.visibility == View.VISIBLE && !hidden) {
      next = above - dp(6f) - dp(FormatBar.HEIGHT)
      put(formatBar, composerLeft, next, composerWidth, dp(FormatBar.HEIGHT))
    }
    if (pill.visibility == View.VISIBLE) {
      val wide = pill.wantedWidth()
      put(pill, width - dp(12f) - wide, top, wide, dp(36f))
    }
    panel?.let { put(it, dp(12f), height - panelHeight() - dp(10f), width - dp(24f), panelHeight()) }
    return next
  }

  /** The emoji panel's height: the keyboard's last height (at least 250 dp), or 300 dp before any keyboard. */
  private fun panelHeight(): Int = if (keyboardHeight > 0) maxOf(dp(250f), keyboardHeight) else dp(300f)

  /** Where the composer must stand above while the emoji panel is open (null: no panel), px from the top. */
  fun panelTop(height: Int): Int? = if (panel == null) null else height - panelHeight() - dp(10f)

  // The keyboard and the emoji panel

  private fun keyboardManager() = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

  private fun toggleEmoji() {
    val field = field ?: return
    if (panel != null) {
      // The keyboard replaces the panel.
      closeEmoji(false)
      field.requestFocus()
      keyboardManager()?.showSoftInput(field, 0)
      return
    }
    val host = host ?: return
    Haptic.tap(emojiButton)
    val made = EmojiPanel(context, behind)
    made.onPick = { emoji -> insert(emoji) }
    made.onErase = { eraseBack() }
    made.onClose = { closeEmoji(true) }
    panel = made
    host.addView(made)
    keyboardManager()?.hideSoftInputFromWindow(host.windowToken, 0)
    onLayout?.invoke()
    made.appear()
  }

  fun closeEmoji(animated: Boolean) {
    val made = panel ?: return
    panel = null
    if (animated) made.animate().alpha(0f).setDuration(200).withEndAction { (made.parent as? ViewGroup)?.removeView(made) }.start()
    else (made.parent as? ViewGroup)?.removeView(made)
    onLayout?.invoke()
  }

  /** The emoji goes in at the cursor, as if typed: it replaces the selection. */
  private fun insert(emoji: String) {
    val field = field ?: return
    val text = field.text ?: return
    val start = minOf(field.selectionStart, field.selectionEnd).coerceAtLeast(0)
    val end = maxOf(field.selectionStart, field.selectionEnd).coerceAtLeast(0)
    text.replace(start, end, emoji)
  }

  /** «Стереть символ»: one character (a whole emoji) before the cursor. */
  private fun eraseBack() {
    val field = field ?: return
    field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
    field.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL))
  }

  // Sending with options

  private fun sendHeld() {
    if (canOffer?.invoke() == false) return
    val field = field ?: return
    if (field.text.isNullOrBlank()) return
    Haptic.impact(field)
    keyboardManager()?.hideSoftInputFromWindow(field.windowToken, 0)
    closeEmoji(false)
    sendSheet { silent -> if (silent) { Haptic.tap(field); onSend?.invoke(true, null) } else pickTime() }.show()
  }

  private fun sendSheet(chosen: (Boolean) -> Unit): ChoiceSheet = ChoiceSheet(context, "Отправить", choices = listOf(
    ChoiceSheet.Choice("bell.slash", "Отправить без звука", "Собеседник получит сообщение без звука и вибрации") { chosen(true) },
    ChoiceSheet.Choice("clock", "Отправить позже", "Выбери день и время — сообщение уйдёт само") { chosen(false) },
  ))

  /** «Отправить позже»: the picker opens once the first sheet is gone. */
  private fun pickTime() {
    val picker = SchedulePicker(context)
    picker.onPick = { at -> field?.let { Haptic.tap(it) }; onSend?.invoke(false, at) }
    host?.postDelayed({ picker.show() }, 250)
  }

  /** A message of this chat was handed to the server for later (the sample chat keeps it here). */
  fun scheduled(deliverAt: String, text: String, silent: Boolean) {
    if (messenger == null) {
      sampleScheduled.add(ScheduledItem(UUID.randomUUID().toString(), chatId, UUID.randomUUID().toString(), deliverAt, "scheduled", null, ScheduleModel.iso(Instant.now()),
        text = text, cryptoState = "decrypted", meta = if (silent) mapOf("silent" to true) else null))
    }
    onSay?.invoke("Запланировано: " + ScheduleModel.formatDeliverAt(deliverAt))
    showPill()
  }

  // The scheduled messages of the chat

  private val scheduledHere: List<ScheduledItem> get() = messenger?.let { ScheduledStore.of(it).items(chatId) } ?: sampleScheduled

  private fun showPill() {
    val list = scheduledHere
    val hidden = list.isEmpty()
    pill.show(list.size, list.any { it.failed })
    val wanted = if (hidden) View.GONE else View.VISIBLE
    if (pill.visibility != wanted) { pill.visibility = wanted; onLayout?.invoke() }
  }

  private fun openScheduled() {
    host?.let { keyboardManager()?.hideSoftInputFromWindow(it.windowToken, 0) }
    ScheduledScreen(context, messenger?.let { ScheduledStore.of(it) }, chatId, peerName, if (messenger == null) sampleScheduled else null).show()
  }

  // Formatting

  /** The field's text changed: the styles move with it, and the field shows them. */
  fun textChanged(text: String) {
    if (entities.isNotEmpty()) entities = ComposeRules.shift(entities, lastText, text)
    lastText = text
    restyle()
    selectionChanged()
  }

  /** The selection changed: the bar shows over a selection, with the styles it already has. */
  fun selectionChanged() {
    val field = field ?: return
    val start = minOf(field.selectionStart, field.selectionEnd); val end = maxOf(field.selectionStart, field.selectionEnd)
    val wanted = end > start && field.hasFocus()
    if (wanted) formatBar.show(ComposeRules.active(entities, start, end))
    val shown = formatBar.visibility == View.VISIBLE
    if (shown != wanted) { formatBar.visibility = if (wanted) View.VISIBLE else View.GONE; onLayout?.invoke() }
  }

  private fun apply(type: String, url: String?) {
    val field = field ?: return
    val start = minOf(field.selectionStart, field.selectionEnd); val end = maxOf(field.selectionStart, field.selectionEnd)
    if (end <= start) return
    val text = field.text?.toString() ?: ""
    entities = if (type == "clear") ComposeRules.clear(entities, text, start, end) else ComposeRules.toggle(entities, text, start, end, type, url)
    Haptic.tap(field)
    restyle()
    formatBar.show(ComposeRules.active(entities, start, end))
  }

  /** «Ссылка»: the address for the selected text. */
  private fun askLink() {
    val field = field ?: return
    val start = minOf(field.selectionStart, field.selectionEnd); val end = maxOf(field.selectionStart, field.selectionEnd)
    val input = EditText(context)
    input.hint = "https://"
    input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    input.contentDescription = "Адрес ссылки"
    try {
      AlertDialog.Builder(context).setTitle("Ссылка").setView(input)
        .setNegativeButton("Отмена", null)
        .setPositiveButton("Готово") { _, _ ->
          val url = ComposeRules.linkAddress(input.text.toString())
          if (url == null) { onSay?.invoke("Нужен адрес вида https://…"); return@setPositiveButton }
          field.setSelection(start, end)
          apply("text_link", url)
        }.show()
    } catch (_: Exception) { }
  }

  /** Shows the styles in the field itself, without touching its text or the cursor. */
  private fun restyle() {
    val field = field ?: return
    // Plain text stays untouched until there is a style to show (and once more after the last one goes).
    if (entities.isEmpty() && !styled) return
    styled = entities.isNotEmpty()
    val text: Editable = field.text ?: return
    val total = text.length
    for (span in text.getSpans(0, total, CharacterStyle::class.java)) if (span is Marked) text.removeSpan(span)
    for (entity in entities) {
      val type = entity["type"] as? String ?: continue
      val offset = (entity["offset"] as? Number)?.toInt() ?: continue
      val length = (entity["length"] as? Number)?.toInt() ?: continue
      if (offset < 0 || length <= 0 || offset + length > total) continue
      val span: CharacterStyle = when (type) {
        "bold" -> MarkedStyle(Typeface.BOLD)
        "italic" -> MarkedStyle(Typeface.ITALIC)
        "underline" -> MarkedUnderline()
        "strikethrough" -> MarkedStrike()
        "code", "pre" -> MarkedMono()
        "spoiler" -> MarkedBack(Theme.alpha(Theme.text, 0.18f))
        "quote" -> MarkedColor(Theme.muted)
        "text_link" -> { text.setSpan(MarkedUnderline(), offset, offset + length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); MarkedColor(Theme.accent) }
        else -> continue
      }
      text.setSpan(span, offset, offset + length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }

  private interface Marked
  private class MarkedStyle(style: Int) : StyleSpan(style), Marked
  private class MarkedUnderline : UnderlineSpan(), Marked
  private class MarkedStrike : StrikethroughSpan(), Marked
  private class MarkedMono : TypefaceSpan("monospace"), Marked
  private class MarkedBack(color: Int) : BackgroundColorSpan(color), Marked
  private class MarkedColor(color: Int) : ForegroundColorSpan(color), Marked

  /** What goes out of the field: the text trimmed, with its entities (null: none). */
  fun compose(full: String): Pair<String, List<Map<String, Any?>>?> = ComposeRules.compose(full, entities)

  /** The field was emptied or given another text (an edit): its styles start again from `with`. */
  fun reset(text: String, with: List<Map<String, Any?>> = emptyList()) {
    entities = with
    lastText = text
    styled = true
    restyle()
    selectionChanged()
  }

  // The emulator check

  /** `--es composerdemo silent|later|scheduled|list|emoji|format` with the sample chat: what the composer shows. */
  private fun demoSeed() {
    val ask = LookDemo.composer ?: return
    if (ask == "scheduled" || ask == "list") sampleScheduled = ScheduledScreen.demoItems()
    host?.postDelayed({
      val field = field ?: return@postDelayed
      if (host?.isAttachedToWindow != true) return@postDelayed
      when (ask) {
        "silent" -> { field.setText("Буду через десять минут"); onLayout?.invoke(); sendSheet { }.show() }
        "later" -> SchedulePicker(context).show()
        "list" -> openScheduled()
        "emoji" -> toggleEmoji()
        "format" -> {
          field.setText("Встреча завтра в десять, не опаздывай")
          field.requestFocus()
          field.setSelection(0, 14)
          apply("bold", null)
          field.setSelection(15, 22)
          selectionChanged()
        }
      }
    }, 1000)
  }
}
