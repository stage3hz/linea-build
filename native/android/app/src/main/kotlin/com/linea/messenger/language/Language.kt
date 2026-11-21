package com.linea.messenger.language

import android.app.Activity
import android.content.Context
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.EditText
import android.widget.TextView
import com.linea.messenger.net.Live
import org.json.JSONObject
import java.util.Locale

/** The language of the interface (Настройки → Язык), the way the previous app does it (`mobile/src/i18n/index.ts`;
 *  iOS Language/Language.swift): the app is written in Russian; another language is a dictionary keyed by the Russian
 *  text (`assets/i18n/en.json`, the reference's own file, bundled as it is), applied where text is put on the screen —
 *  a text's words and an empty field's hint. Unknown text stays as it is (names, numbers, messages). Kept on this
 *  device.
 *
 *  iOS puts the dictionary on the way of every label; Android's views cannot be changed that way, so the window is
 *  looked at whenever it lays itself out (and a few times a second while it draws): a text whose words are a key of
 *  the dictionary is given the translation. A translated text is no key, so nothing is translated twice. */
object Language {
  class Choice(val id: String, val name: String, val native: String)
  val choices = listOf(Choice("ru", "Russian", "Русский"), Choice("en", "English", "English"))
  val changed = Live.Signal<Unit>()
  private const val KEY = "linea.language.v1"
  private const val STORE = "invizent.language"

  /** "ru" unless English was chosen in the settings. */
  var current = "ru"
    private set
  private var app: Context? = null

  val chosenName: String get() = choices.firstOrNull { it.id == current }?.native ?: "Русский"

  /** Reads the choice (before the first screen is made). */
  fun start(context: Context) {
    app = context.applicationContext
    current = if (prefs(context)?.getString(KEY, null) == "en") "en" else "ru"
  }

  private fun prefs(context: Context?) = try { context?.applicationContext?.getSharedPreferences(STORE, Context.MODE_PRIVATE) } catch (_: Exception) { null }

  fun set(id: String) {
    val next = if (id == "en") "en" else "ru"
    prefs(app)?.edit()?.putString(KEY, next)?.apply()
    if (next == current) return
    current = next
    changed.post(Unit)
  }

  private var english: Map<String, String> = emptyMap()
  private var englishUpper: Map<String, String> = emptyMap()
  private var loaded = false

  /** For the tests: the dictionary as text (the bundled file otherwise). */
  internal var source: (() -> String?)? = null

  private fun load() {
    if (loaded) return
    loaded = true
    val text = try { source?.invoke() ?: app?.assets?.open("i18n/en.json")?.use { it.readBytes().toString(Charsets.UTF_8) } } catch (_: Exception) { null } ?: return
    val table = HashMap<String, String>()
    try {
      val json = JSONObject(text)
      for (key in json.keys()) (json.opt(key) as? String)?.let { table[key] = it }
    } catch (_: Exception) { return }
    english = table
    // Captions are put on the screen in capitals («ТЕМА»): they are found by their capitals too.
    val upper = HashMap<String, String>()
    for ((russian, translated) in table) upper[russian.uppercase(Locale.ROOT)] = translated.uppercase(Locale.ROOT)
    englishUpper = upper
  }

  /** For the tests: the dictionary is read again. */
  internal fun reload() { loaded = false; load() }

  /** The text in `language` (the current one by default); unknown text is returned as is. Surrounding spaces are kept. */
  fun tr(text: String, language: String = current): String {
    if (language == "ru" || text.isEmpty()) return text
    load()
    english[text]?.let { return it }
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return text
    if (trimmed != text) english[trimmed]?.let { return text.replace(trimmed, it) }
    englishUpper[trimmed]?.let { return if (trimmed == text) it else text.replace(trimmed, it) }
    return text
  }

  // ---- The window ----

  private var lastWalk = 0L

  /** Puts the dictionary on the way of the window's texts (once, at start). */
  fun install(activity: Activity) {
    start(activity)
    val decor = activity.window?.decorView ?: return
    val observer = decor.viewTreeObserver
    observer.addOnGlobalLayoutListener { walkSoon(decor) }
    observer.addOnPreDrawListener(ViewTreeObserver.OnPreDrawListener {
      val now = SystemClock.uptimeMillis()
      if (current != "ru" && now - lastWalk > 300) { lastWalk = now; walk(decor) }
      true
    })
  }

  private fun walkSoon(root: View) { if (current != "ru") { lastWalk = SystemClock.uptimeMillis(); walk(root) } }

  /** Every text under `root` in the current language. */
  fun walk(root: View) {
    if (current == "ru") return
    load()
    visit(root, 0)
  }

  private fun visit(view: View, depth: Int) {
    if (depth > 60) return
    if (view is TextView) {
      if (view is EditText) {
        view.hint?.toString()?.let { hint -> val next = tr(hint); if (next != hint) view.hint = next }
      } else {
        val text = view.text
        // Only plain words: a text with its own spans (links, mentions) is a message and stays as it is.
        if (text != null && text !is android.text.Spanned && text.isNotEmpty()) {
          val plain = text.toString()
          val next = tr(plain)
          if (next != plain) view.text = next
        }
      }
      view.contentDescription?.toString()?.let { said -> val next = tr(said); if (next != said) view.contentDescription = next }
      return
    }
    view.contentDescription?.toString()?.let { said -> val next = tr(said); if (next != said) view.contentDescription = next }
    if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index), depth + 1)
  }
}
