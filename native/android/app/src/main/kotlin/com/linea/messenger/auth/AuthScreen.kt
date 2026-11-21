package com.linea.messenger.auth

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.shell.Screen
import java.text.Normalizer
import java.util.Locale

/** Signing in: the login, then the password, then the confirmation word — one field at a time. All three go to
 *  the server together at the last step; which of them was wrong is never told. */
@SuppressLint("ViewConstructor")
class AuthScreen(context: Context, private val server: Server) : Screen(context) {
  private enum class Step { NAME, PASSWORD, WORD }

  /** Called with the session's token and the account (`user` of the server's answer) once signed in. */
  var onSignedIn: ((token: String, user: Map<String, Any?>) -> Unit)? = null

  private var step = Step.NAME
  private var login = ""
  private var password = ""
  private var word = ""
  private var busy = false
  /** On the clock that only counts forward (`SystemClock.elapsedRealtime`); 0 = not locked. */
  private var lockedUntil = 0L

  private val brand = label(40f, 700, Theme.text)
  private val motto = label(17f, 400, Theme.muted)
  private val heading = label(22f, 600, Theme.text)
  private val hint = label(15f, 400, Theme.muted)
  private val failure = label(15f, 400, Theme.danger)
  private val field = EditText(context)
  private val plate = FrameLayout(context)
  private val proceed = label(17f, 600, Theme.onAccent)
  private val back = label(16f, 400, Theme.muted)
  private val spinner = ProgressBar(context)
  private val main = Handler(Looper.getMainLooper())

  private fun label(size: Float, weight: Int, color: Int) = TextView(context).apply {
    textSize = size
    typeface = Theme.weight(weight)
    setTextColor(color)
    includeFontPadding = false
  }

  init {
    setBackgroundColor(Theme.bg)
    brand.text = "Инвиз"
    motto.text = "Твоя линия связи."
    failure.visibility = View.GONE
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true

    plate.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = dp(16f).toFloat() }
    field.textSize = 17f
    field.setTextColor(Theme.text)
    field.setHintTextColor(Theme.subtle)
    field.background = null
    field.setPadding(0, 0, 0, 0)
    field.isSingleLine = true
    field.gravity = Gravity.CENTER_VERTICAL
    field.setOnEditorActionListener { _, _, _ -> goOn(); true }
    plate.addView(field, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(16f); rightMargin = dp(16f) })

    proceed.gravity = Gravity.CENTER
    proceed.background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = dp(27f).toFloat() }
    proceed.isClickable = true
    proceed.isFocusable = true
    proceed.setOnClickListener { goOn() }
    back.text = "Назад"
    back.gravity = Gravity.CENTER
    back.isClickable = true
    back.isFocusable = true
    back.setOnClickListener { goBack() }
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.muted)
    spinner.visibility = View.GONE

    for (part in listOf(brand, motto, heading, hint, plate, failure, proceed, back, spinner)) addView(part)
    show(Step.NAME)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    field.requestFocus()
    field.post { (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT) }
  }

  override fun onDetachedFromWindow() {
    forgetSecrets()
    field.setText("")
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
    super.onDetachedFromWindow()
  }

  /** One column, 24 from each side, 56 under the status bar; 10 between the parts unless said otherwise. */
  override fun place(width: Int, height: Int) {
    val left = dp(24f); val wide = width - dp(48f)
    var y = edges.top + dp(56f)
    y += putText(brand, left, y, wide) + dp(4f)
    y += putText(motto, left, y, wide) + dp(40f)
    y += putText(heading, left, y, wide) + dp(10f)
    y += putText(hint, left, y, wide) + dp(18f)
    put(plate, left, y, wide, dp(54f)); y += dp(54f) + dp(10f)
    if (failure.visibility == View.VISIBLE) y += putText(failure, left, y, wide) + dp(18f)
    put(proceed, left, y, wide, dp(54f)); y += dp(54f) + dp(10f)
    if (back.visibility == View.VISIBLE) { put(back, left, y, wide, dp(44f)); y += dp(44f) + dp(10f) }
    put(spinner, (width - dp(28f)) / 2, y, dp(28f), dp(28f))
  }

  private fun show(next: Step, error: String = "") {
    step = next
    failure.text = error
    failure.visibility = if (error.isEmpty()) View.GONE else View.VISIBLE
    back.visibility = if (next == Step.NAME) View.GONE else View.VISIBLE
    field.setText("")
    when (next) {
      Step.NAME -> {
        heading.text = "Логин"
        hint.text = "Вход без почты и номера телефона. Данные проверим вместе на последнем шаге."
        field.hint = "Введите логин"
        // A plain line: nothing is corrected, capitalised or suggested.
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        fillWith(View.AUTOFILL_HINT_USERNAME)
        field.setText(login)
        field.setSelection(field.text.length)
        field.imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_EXTRACT_UI
      }
      Step.PASSWORD -> {
        heading.text = "Пароль"
        hint.text = "Введи пароль вручную. Следом понадобится слово подтверждения."
        field.hint = "Пароль"
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        fillWith(View.AUTOFILL_HINT_PASSWORD)
        field.imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_EXTRACT_UI
      }
      Step.WORD -> {
        heading.text = "Слово подтверждения"
        hint.text = "Введи слово подтверждения, которое выбрал при регистрации."
        field.hint = "Твоё слово для входа"
        field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        fillWith(null)
        field.imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI
      }
    }
    // A hidden field would otherwise take the fixed-width font.
    field.typeface = Typeface.DEFAULT
    proceed.text = if (next == Step.WORD) "Войти в Инвиз" else "Продолжить"
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.restartInput(field)
    requestLayout()
    // A screen reader says where the person is now, and what went wrong if something did.
    announceForAccessibility(if (error.isEmpty()) heading.text else "$error ${heading.text}")
  }

  private fun fillWith(hint: String?) {
    if (hint != null) { field.setAutofillHints(hint); field.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES }
    else { field.setAutofillHints(*emptyArray<String>()); field.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO }
  }

  private fun forgetSecrets() { password = ""; word = "" }

  private fun goBack() {
    if (busy) return
    when (step) {
      Step.NAME -> {}
      Step.PASSWORD -> { forgetSecrets(); show(Step.NAME) }
      Step.WORD -> { forgetSecrets(); show(Step.PASSWORD) }
    }
  }

  private fun goOn() {
    if (busy) return
    val typed = field.text.toString()
    when (step) {
      Step.NAME -> {
        if (lockedUntil > SystemClock.elapsedRealtime()) return show(Step.NAME, "Слишком много неверных попыток. Вход снова откроется через 5 минут.")
        login = typed.trim()
        if (!validLogin(login)) return show(Step.NAME, "Логин: 3–24 символа — латинские буквы, цифры и знак _.")
        show(Step.PASSWORD)
      }
      Step.PASSWORD -> {
        if (!validPassword(typed)) return show(Step.PASSWORD, "Введи свой пароль. Максимум — 128 символов.")
        password = typed
        show(Step.WORD)
      }
      Step.WORD -> {
        // An empty word is sent as it is: only the server decides whether an older account may enter without one.
        word = confirmationWord(typed)
        signIn()
      }
    }
  }

  private fun signIn() {
    val body = linkedMapOf<String, Any?>("username" to login, "password" to password, "confirmationWord" to word)
    body.putAll(Account.deviceFields)
    val json = Core.text(body) ?: return
    busy = true
    spinner.visibility = View.VISIBLE
    proceed.isEnabled = false
    proceed.alpha = 0.5f
    server.send("POST", "/auth/login", json) { result ->
      main.post {
        busy = false
        spinner.visibility = View.GONE
        proceed.isEnabled = true
        proceed.alpha = 1f
        // Whatever the answer, the password and the word are not kept a moment longer.
        forgetSecrets()
        if (result.isSuccess) {
          val session = Core.map(result.getOrNull())
          val token = session?.get("token") as? String
          val user = Core.map(session?.get("user"))
          if (token.isNullOrEmpty() || user == null) return@post show(Step.NAME, "Не удалось выполнить запрос. Попробуй ещё раз.")
          field.setText("")
          onSignedIn?.invoke(token, user)
          return@post
        }
        // Wrong login, password or word: back to the first step, with how many tries are left.
        val error = Server.error(result)
        if (error is ServerError.Refused && (error.code == "LOGIN_FAILED" || error.code == "LOGIN_LOCKED" || error.status == 401)) {
          val wait = (error.details["retryAfterSeconds"] as? Number)?.toDouble()
          if (error.code == "LOGIN_LOCKED" && wait != null) {
            lockedUntil = SystemClock.elapsedRealtime() + (wait * 1000).toLong()
            return@post show(Step.NAME, "Слишком много неверных попыток. Вход снова откроется через 5 минут.")
          }
          val left = wholeNumber(error.details["attemptsLeft"])
          if (left != null) return@post show(Step.NAME, "Неверный логин, пароль или слово подтверждения. Осталось попыток: $left.")
          return@post show(Step.NAME, error.words)
        }
        show(Step.NAME, error.words)
      }
    }
  }

  companion object {
    /** 3–24 characters: Latin letters, digits and `_`. */
    fun validLogin(login: String): Boolean = Regex("^[A-Za-z0-9_]{3,24}$").matches(login)

    /** Not empty and at most 128 characters, counted as a person sees them (an emoji is one). */
    fun validPassword(password: String): Boolean = password.isNotEmpty() && characters(password) <= 128

    private fun characters(text: String): Int {
      val breaks = java.text.BreakIterator.getCharacterInstance(Locale.ROOT)
      breaks.setText(text)
      var count = 0
      while (breaks.next() != java.text.BreakIterator.DONE) count += 1
      return count
    }

    /** The word as the server compares it: without the spaces around it, composed (NFC), in small letters. */
    fun confirmationWord(typed: String): String = Normalizer.normalize(typed.trim(), Normalizer.Form.NFC).lowercase(Locale.ROOT)

    /** A JSON number that is a whole one. */
    fun wholeNumber(value: Any?): Long? = (value as? Number)?.toDouble()?.takeIf { it == Math.rint(it) && Math.abs(it) < 1e15 }?.toLong()
  }
}
