package com.linea.messenger.composer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.view.Gravity
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.chatactions.ChatIconView
import com.linea.messenger.chatlook.GlassPill
import com.linea.messenger.core.Core
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate

/** The rules of formatting in the field (iOS: Sources/Composer/FormatBar.swift; the reference's format/entities.ts
 *  and format/markdown.ts, run by the shared core so both phones format alike): an entity is
 *  `{type, offset, length, url?, language?}` with offsets in UTF-16 units, as the reference counts them. It travels
 *  inside the encrypted message, never to the server. */
object ComposeRules {
  /** The toolbar's labels, in the reference's order (ENTITY_LABELS). */
  val labels = mapOf("bold" to "Жирный", "italic" to "Курсив", "underline" to "Подчёркнутый", "strikethrough" to "Зачёркнутый", "code" to "Моноширинный",
    "pre" to "Моноширинный блок", "spoiler" to "Спойлер", "quote" to "Цитата", "text_link" to "Ссылка")

  private fun list(value: Any?): List<Map<String, Any?>>? = (value as? List<*>)?.mapNotNull { Core.map(it as? Map<*, *>) }

  /** Adds `type` over the selection, or takes it off when the whole selection has it (`toggleEntity`). */
  fun toggle(entities: List<Map<String, Any?>>, text: String, start: Int, end: Int, type: String, url: String? = null): List<Map<String, Any?>> =
    list(Core.view("composeToggle", listOf(entities, text, start, end, type, url))) ?: entities

  /** «Очистить форматирование» over the selection (`clearFormatting`). */
  fun clear(entities: List<Map<String, Any?>>, text: String, start: Int, end: Int): List<Map<String, Any?>> =
    list(Core.view("composeClear", listOf(entities, text, start, end))) ?: entities

  /** The types every character of the selection carries (`activeTypes`). */
  fun active(entities: List<Map<String, Any?>>, start: Int, end: Int): Set<String> =
    (Core.view("composeActive", listOf(entities, start, end)) as? List<*>).orEmpty().filterIsInstance<String>().toSet()

  /** Keeps the entities in place while the person types (`shiftEntities`). */
  fun shift(entities: List<Map<String, Any?>>, old: String, new: String): List<Map<String, Any?>> {
    if (entities.isEmpty()) return emptyList()
    return list(Core.view("composeShift", listOf(entities, old, new))) ?: emptyList()
  }

  /** What goes out: the typed shortcuts (**жирный**, __курсив__…) turned into entities, the text trimmed, the
   *  entities cut to it — null entities when there is nothing to say (the reference's ChatScreen `composed`). */
  fun compose(text: String, entities: List<Map<String, Any?>>): Pair<String, List<Map<String, Any?>>?> {
    val made = Core.map(Core.view("composeOut", listOf(text, entities)) as? Map<*, *>)
    val out = made?.get("text") as? String ?: return Pair(text.trim(), null)
    val found = list(made["entities"])
    return Pair(out, if (found.isNullOrEmpty()) null else found)
  }

  /** Only http(s) addresses, at most 2048 units (`validLinkUrl`); «https://» is added when no scheme was typed. */
  fun linkAddress(typed: String): String? {
    val trimmed = typed.trim()
    if (trimmed.isEmpty()) return null
    val hasScheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(trimmed)
    val url = if (hasScheme) trimmed else "https://$trimmed"
    if (url.length > 2048 || !Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(url)) return null
    return url
  }
}

/** The formatting bar above the field (the reference's FormatToolbar.tsx): shown while text is selected; a tap puts
 *  the style on the selection or takes it off; «Ссылка» asks for an address. */
@SuppressLint("ViewConstructor")
class FormatBar(context: Context, source: GlassSource?) : GlassPill(context, source) {
  companion object {
    const val HEIGHT = 44f
    val items = listOf("bold" to "Ж", "italic" to "К", "underline" to "Ч", "strikethrough" to "З", "code" to "</>", "spoiler" to "▒", "quote" to "❝", "text_link" to "🔗")
  }

  /** A style was chosen ("clear": take every style off the selection). */
  var onAction: ((String) -> Unit)? = null
  /** «Ссылка» was chosen: the address is to be asked for. */
  var onLink: (() -> Unit)? = null
  private val buttons = ArrayList<TextView>()
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  init {
    placesChildren = true
    radius = 22 * d
    val row = LinearLayout(context)
    row.gravity = Gravity.CENTER_VERTICAL
    row.setPadding(dp(8f), 0, dp(8f), 0)
    for ((type, label) in items) {
      val button = TextView(context)
      button.text = title(type, label)
      button.textSize = 15f
      button.gravity = Gravity.CENTER
      button.contentDescription = ComposeRules.labels[type]
      button.isClickable = true; button.isFocusable = true
      button.setOnClickListener { if (type == "text_link") onLink?.invoke() else onAction?.invoke(type) }
      row.addView(button, LinearLayout.LayoutParams(dp(if (label.length > 1 && type != "text_link") 46f else 38f), dp(32f)).apply { rightMargin = dp(6f) })
      buttons.add(button)
    }
    val clear = ChatIconView(context, "xmark", 18f, Theme.muted)
    clear.contentDescription = "Очистить форматирование"
    clear.isClickable = true
    clear.setOnClickListener { onAction?.invoke("clear") }
    row.addView(clear, LinearLayout.LayoutParams(dp(36f), dp(32f)))
    addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(row) }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    show(emptySet())
  }

  private fun title(type: String, label: String): CharSequence {
    val out = SpannableString(label)
    fun put(span: Any) = out.setSpan(span, 0, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    when (type) {
      "bold" -> put(StyleSpan(Typeface.BOLD))
      "italic" -> put(StyleSpan(Typeface.ITALIC))
      "underline" -> put(UnderlineSpan())
      "strikethrough" -> put(StrikethroughSpan())
      "code" -> put(TypefaceSpan("monospace"))
    }
    return out
  }

  /** Lights the styles the selection already has. */
  fun show(active: Set<String>) {
    buttons.forEachIndexed { index, button ->
      val on = active.contains(items[index].first)
      button.background = context.plate(if (on) Theme.accent else Theme.veil(0.07f), 10f)
      button.setTextColor(if (on) Theme.onAccent else Theme.text)
      button.isSelected = on
    }
  }
}
