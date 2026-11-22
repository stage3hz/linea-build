package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import com.linea.messenger.core.Core
import com.linea.messenger.design.SymbolButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import java.util.Locale

// Security: the lists of «Конфиденциальность» (iOS Settings/PrivacyLists.swift): «Всегда показывать» / «Никогда не
// показывать» of «Время захода» (the previous app: `LastSeenExceptions` of `mobile/src/SettingsScreen.tsx`) and «Разрешить»
// / «Никогда» of «Кто может звонить» (`RuleList` of `mobile/src/privacy/CallPrivacy.tsx`).

/** A person in one line: the round picture, the name, the @login, a button on the right. */
@SuppressLint("ViewConstructor")
class PersonListRow(context: Context, person: Map<String, Any?>, base: String, adding: Boolean) : LinearLayout(context) {
  var onPress: (() -> Unit)? = null
  private val name = person["displayName"] as? String ?: ""
  private val button = SymbolButton(context, if (adding) "ion:add-circle" else "ion:close-circle", 22f, if (adding) Theme.accent else Theme.muted)
  private val spinner = ProgressBar(context)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(14f), context.px(9f), context.px(14f), context.px(9f))
    val ball = SettingsAvatar(context)
    ball.show(person, base)
    addView(ball, LayoutParams(context.px(36f), context.px(36f)))
    val texts = LinearLayout(context).apply { orientation = VERTICAL }
    texts.addView(context.words(name, 15f, Theme.text).apply { maxLines = 1 })
    val login = person["username"] as? String ?: ""
    if (login.isNotEmpty()) texts.addView(context.words("@$login", 12.5f, Theme.muted).apply { maxLines = 1 }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(1f) })
    addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f); rightMargin = context.px(12f) })
    button.contentDescription = (if (adding) "Добавить в список" else "Убрать из списка") + ": " + name
    button.setOnClickListener { performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); onPress?.invoke() }
    addView(button, LayoutParams(context.px(36f), context.px(36f)))
    spinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent)
    spinner.visibility = GONE
    addView(spinner, LayoutParams(context.px(22f), context.px(22f)))
  }

  fun setBusy(busy: Boolean) {
    button.visibility = if (busy) GONE else VISIBLE
    spinner.visibility = if (busy) VISIBLE else GONE
  }
}

/** A plain line of typing for these pages: a search, a login. */
private fun Context.lineField(hint: String, spoken: String): EditText = EditText(this).apply {
  this.hint = hint
  textSize = 15f
  setTextColor(Theme.text)
  setHintTextColor(Theme.subtle)
  background = null
  setPadding(0, 0, 0, 0)
  isSingleLine = true
  inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
  contentDescription = spoken
}

/** «Всегда показывать» / «Никогда не показывать» of «Время захода»: who is in the list, and friends or anyone found by
 *  @login to add. */
@SuppressLint("ViewConstructor")
class LastSeenExceptionsScreen(context: Context, private val account: SettingsAccount, private val model: SettingsPrivacyModel, private val rule: String) :
  SettingsPage(context, if (rule == "allow") "Всегда показывать" else "Никогда не показывать") {
  private var listed: List<Map<String, Any?>>? = null
  private var friends: List<Map<String, Any?>> = emptyList()
  private var found: List<Map<String, Any?>> = emptyList()
  private var query = ""
  private var busy = ""
  private var failure = ""
  private val timer = Handler(Looper.getMainLooper())
  private val field = context.lineField("Имя или @логин", "Поиск людей")
  private val lists = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

  override fun build() {
    field.imeOptions = EditorInfo.IME_ACTION_SEARCH
    field.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { typed() }
    })
    loadRules()
    account.accountCall("contacts", emptyList()) { result ->
      friends = (result.getOrNull()?.get("users") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      fillLists()
    }
    add(lists, 0f)
    fillLists()
  }

  override fun onDetachedFromWindow() { timer.removeCallbacksAndMessages(null); super.onDetachedFromWindow() }

  private fun loadRules() {
    account.accountCall("lastSeenRules", emptyList()) { result ->
      val body = result.getOrNull()
      if (body != null) { listed = (body[rule] as? List<*>).orEmpty().mapNotNull { Core.map(it) }; failure = "" }
      else failure = result.failureWords("Не удалось загрузить списки.")
      fillLists()
    }
  }

  private val needle: String get() = query.trim().removePrefix("@").lowercase(Locale.ROOT)

  private fun typed() {
    val now = field.text?.toString() ?: ""
    if (now == query) return
    query = now
    found = emptyList()
    timer.removeCallbacksAndMessages(null)
    val trimmed = query.trim()
    // The app's rules for the global search: an exact @login, or four letters and more.
    if (needle.length >= 2 && (trimmed.startsWith("@") || needle.length >= 4)) {
      timer.postDelayed({
        account.accountCall("users", listOf(trimmed)) { result ->
          val body = result.getOrNull() ?: return@accountCall
          found = (body["users"] as? List<*>).orEmpty().mapNotNull { Core.map(it) }
          fillLists()
        }
      }, 350)
    }
    fillLists()
  }

  private fun note(text: String, top: Float = 16f): View = SettingsLook.inset(context.words(text, 13f, Theme.muted), top = top, side = 16f, bottom = if (top == 0f) 14f else 16f)

  private fun fillLists() {
    lists.removeAllViews()
    fun put(view: View, gap: Float) = lists.addView(view, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(gap) })
    val base = account.base
    if (failure.isNotEmpty()) put(SettingsNotice(context, failure, error = true, onRetry = { loadRules() }), 0f)
    val inList = HashSet<String>()
    val rows = ArrayList<View>()
    val known = listed
    if (known != null) {
      for (person in known) {
        val id = person["id"] as? String ?: continue
        inList.add(id)
        val row = PersonListRow(context, person, base, adding = false)
        row.setBusy(busy == id)
        row.onPress = { toggle(id, add = false) }
        rows.add(row)
      }
      if (rows.isEmpty()) rows.add(note("Список пуст. Выбери людей ниже."))
    } else rows.add(note("Загрузка…"))
    put(SettingsLook.caption(context, if (rule == "allow") "Всегда показывать" else "Никогда не показывать"), 8f)
    put(SettingsGroup(context, rows), 7f)
    put(SettingsLook.foot(context, if (rule == "allow") "Эти люди всегда будут видеть время вашего захода, независимо от настроек выше." else "Эти люди никогда не будут видеть время вашего захода, независимо от настроек выше."), 8f)

    val own = account.userId
    val seen = HashSet<String>()
    val candidates = ArrayList<Map<String, Any?>>()
    for (person in friends + found) {
      val id = person["id"] as? String ?: continue
      if (id == own || id in seen || id in inList) continue
      seen.add(id)
      val name = (person["displayName"] as? String ?: "").lowercase(Locale.ROOT)
      val login = (person["username"] as? String ?: "").lowercase(Locale.ROOT)
      if (needle.isNotEmpty() && !name.contains(needle) && !login.contains(needle)) continue
      candidates.add(person)
      if (candidates.size >= 50) break
    }
    val search = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    search.addView(com.linea.messenger.design.SymbolView(context, "ion:search", 18f, Theme.muted), LinearLayout.LayoutParams(context.px(18f), context.px(18f)))
    (field.parent as? android.view.ViewGroup)?.removeView(field)
    search.addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(10f) })
    val addRows = ArrayList<View>()
    addRows.add(SettingsLook.inset(search, top = 13f, side = 14f, bottom = 13f))
    for (person in candidates) {
      val id = person["id"] as? String ?: continue
      val row = PersonListRow(context, person, base, adding = true)
      row.setBusy(busy == id)
      row.onPress = { toggle(id, add = true) }
      addRows.add(row)
    }
    if (candidates.isEmpty()) addRows.add(note(if (needle.isEmpty()) "Здесь появятся друзья и люди из твоих чатов." else "Никого не нашли. Введи точный @логин.", 0f))
    put(SettingsLook.caption(context, "Добавить пользователей"), 14f)
    put(SettingsGroup(context, addRows), 7f)
  }

  private fun toggle(id: String, add: Boolean) {
    if (busy.isNotEmpty()) return
    busy = id
    fillLists()
    val call = if (add) "setLastSeenRule" else "removeLastSeenRule"
    val args: List<Any?> = if (add) listOf(id, rule) else listOf(id)
    account.accountCall(call, args) { result ->
      busy = ""
      val body = result.getOrNull()
      if (body != null) {
        val fresh = body[rule] as? List<*>
        if (fresh != null) listed = fresh.mapNotNull { Core.map(it) } else loadRules()
        if (add) { field.setText(""); query = ""; found = emptyList() }
        failure = ""
        // «Время захода» shows how many are in the lists.
        model.load()
      } else failure = result.failureWords("Не удалось сохранить.")
      fillLists()
    }
  }
}

/** The two lists of «Кто может звонить»: «Разрешить» (not with «Все») and «Никогда», added to by @login. A page of
 *  its own, opened from the «Звонки» group of «Конфиденциальность». */
@SuppressLint("ViewConstructor")
class CallRulesScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Звонки") {
  private var rules: Map<String, Any?>? = null
  private var failure = ""
  private var mode = "everyone"
  private val fields = HashMap<String, EditText>()
  private val errors = HashMap<String, String>()
  private var busy = false

  override fun build() {
    load()
    account.accountCall("privacy", emptyList()) { result ->
      val body = result.getOrNull() ?: return@accountCall
      mode = Core.map(body["privacy"])?.get("calls") as? String ?: "everyone"
      fill()
    }
    fill()
  }

  private fun load() {
    failure = ""
    account.accountCall("callRules", emptyList()) { result ->
      val body = result.getOrNull()
      if (body != null) rules = body else failure = result.failureWords("Не удалось загрузить списки.")
      fill()
    }
  }

  private fun fill() {
    clear()
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true, onRetry = { load() }))
    val known = rules
    if (known == null) {
      if (failure.isEmpty()) add(SettingsLook.foot(context, "Загрузка…"), 16f)
      return
    }
    if (mode != "everyone") list("Разрешить", "allow", (known["allow"] as? List<*>).orEmpty().mapNotNull { Core.map(it) })
    list("Никогда", "deny", (known["deny"] as? List<*>).orEmpty().mapNotNull { Core.map(it) })
    add(SettingsLook.foot(context, "Проверяет сервер; телефон получателя дополнительно не звонит, если звонящему нельзя."), 10f)
  }

  private fun list(title: String, rule: String, users: List<Map<String, Any?>>) {
    val field = fields.getOrPut(rule) { context.lineField("логин", "Добавить в список «$title» по логину") }
    field.imeOptions = EditorInfo.IME_ACTION_DONE
    field.setOnEditorActionListener { _, _, _ -> addLogin(rule); true }
    (field.parent as? android.view.ViewGroup)?.removeView(field)
    val line = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    line.addView(context.words("@", 15f, Theme.muted))
    line.addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(8f); rightMargin = context.px(8f) })
    val plus = FrameLayout(context).apply { background = context.plate(ThemeStore.look.accentSoft, 11f) }
    plus.addView(SymbolButton(context, "ion:add", 20f, Theme.accent).apply { isClickable = false; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO })
    plus.contentDescription = "Добавить в «$title»"
    plus.isClickable = true
    plus.isEnabled = !busy
    plus.setOnClickListener { addLogin(rule) }
    line.addView(plus, LinearLayout.LayoutParams(context.px(36f), context.px(36f)))
    val rows = ArrayList<View>()
    rows.add(SettingsLook.inset(line, top = 4f, side = 12f, bottom = 4f))
    errors[rule]?.takeIf { it.isNotEmpty() }?.let { rows.add(SettingsLook.inset(context.words(it, 12f, Theme.danger), top = 6f, side = 14f, bottom = 8f)) }
    for (user in users) {
      val id = user["id"] as? String ?: continue
      val row = PersonListRow(context, user, account.base, adding = false)
      row.onPress = { remove(id, rule) }
      rows.add(row)
    }
    addGroup(title + (if (users.isEmpty()) "" else " · ${users.size}"), rows)
  }

  private fun addLogin(rule: String) {
    val login = (fields[rule]?.text?.toString() ?: "").trim().lowercase(Locale.ROOT).removePrefix("@")
    if (login.length < 2 || busy) return
    busy = true
    errors[rule] = ""
    account.accountCall("users", listOf("@$login")) { result ->
      val users = (result.getOrNull()?.get("users") as? List<*>).orEmpty().mapNotNull { Core.map(it) }
      val person = users.firstOrNull { (it["username"] as? String ?: "").lowercase(Locale.ROOT) == login }
      val id = person?.get("id") as? String
      if (id == null) {
        busy = false
        errors[rule] = if (result.isFailure) result.failureWords("") else "Пользователь @$login не найден."
        fill()
        return@accountCall
      }
      account.accountCall("setCallRule", listOf(id, rule)) { answer ->
        busy = false
        val body = answer.getOrNull()
        if (body != null) { rules = body; fields[rule]?.setText("") } else errors[rule] = answer.failureWords("Не удалось добавить.")
        fill()
      }
    }
  }

  private fun remove(id: String, rule: String) {
    account.accountCall("removeCallRule", listOf(id)) { result ->
      val body = result.getOrNull()
      if (body != null) rules = body else errors[rule] = result.failureWords("Не удалось убрать.")
      fill()
    }
  }
}
