package com.linea.messenger.settings

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.InputType
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.NumberPicker
import android.widget.Space
import com.linea.messenger.app.Messenger
import com.linea.messenger.auth.AuthRules
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import java.time.LocalDate
import java.time.YearMonth
import java.util.Locale

/** «Мой профиль»: the name, a few words about oneself, the public @username, the birthday, the colour.
 *  (The previous app: the editor of `mobile/src/ProfileScreen.tsx`.) Nothing is sent until «Сохранить». */
@SuppressLint("ViewConstructor")
class ProfileEditScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Мой профиль") {
  private var birthday: String? = account.ownProfile["birthday"] as? String
  private var gender: String? = account.ownProfile["gender"] as? String
  private var color: String = account.ownProfile["avatarColor"] as? String ?: "#5E7BFF"
  private var busy = false

  // Profile: the banner and the decorated avatar at the top, tapped to change (photo, GIF, video up to 10 s), the
  // background pattern and «Рамки и анимации» (profile/, platina/).
  private val top = com.linea.messenger.profile.ProfileEditTop(context)
  private var pattern: String? = account.ownProfile["profilePattern"] as? String
  private val patternRow = SettingsRow(context, symbol = "ion:sparkles", label = "Узор фона")
  private val media: com.linea.messenger.profile.ProfilePhotoChange? = account.messenger?.let { com.linea.messenger.profile.ProfilePhotoChange(context, it) }
  private val noticeBox = LinearLayout(context)
  private val nameField = SettingsField(context, "", "Имя")
  private val bioArea = SettingsTextArea(context, "О себе")
  private val handleRow = SettingsRow(context, symbol = "ion:at", label = "Имя пользователя")
  private val birthdayRow = SettingsRow(context, symbol = "ion:gift", label = "День рождения")
  private val genderRow = SettingsRow(context, symbol = "ion:person", label = "Пол")
  private val saveButton = SettingsButton(context, "Сохранить")
  private val swatches = ArrayList<View>()
  private val profileChanged: () -> Unit = { showValues() }

  override fun build() {
    val own = account.ownProfile
    // The @username was changed on its own page: the row follows.
    OwnProfile.watch(profileChanged)

    add(top, 0f) // Profile
    top.banner.setOnClickListener { media?.ask("banner") }
    top.avatar.setOnClickListener { media?.ask("avatar") }
    top.words.setOnClickListener { media?.ask("avatar") }
    media?.onBusy = { busy -> top.words.text = if (busy) "Загружаем…" else "Изменить фотографию" }
    media?.onNotice = { words, error -> if (words.isNotEmpty()) showNotice(words, error) }
    com.linea.messenger.platina.PlatinaState.start(account.messenger)

    noticeBox.orientation = LinearLayout.VERTICAL
    add(noticeBox, 10f)

    nameField.limit = 50
    nameField.input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    nameField.value = own["displayName"] as? String ?: ""
    nameField.onEdit = { edited() }
    add(nameField, 10f)

    bioArea.limit = 160
    bioArea.value = own["bio"] as? String ?: ""
    bioArea.onEdit = { clearNotice() }
    add(bioArea, 10f)
    add(SettingsLook.foot(context, "Несколько слов о себе — например, чем занимаешься. Видно в профиле."), 6f)

    handleRow.onPress = { if (!busy) open(UsernameScreen(context, account)) }
    addGroup(rows = listOf(handleRow))

    birthdayRow.onPress = {
      if (!busy) open(BirthdayScreen(context, birthday) { chosen ->
        birthday = chosen
        showValues()
        clearNotice()
      })
    }
    genderRow.onPress = { chooseGender() }
    // Profile: «Узор фона» — the emoji around the photo in the profile (saved with «Сохранить»).
    patternRow.onPress = {
      if (!busy) com.linea.messenger.profile.PatternPicker(context, pattern) { chosen -> pattern = chosen; showValues(); clearNotice() }.show()
    }
    addGroup(rows = listOf(birthdayRow, genderRow, patternRow))

    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    palette.forEachIndexed { index, _ ->
      if (index > 0) row.addView(Space(context), LinearLayout.LayoutParams(0, 1, 1f))
      val dot = View(context)
      dot.contentDescription = "Цвет ${index + 1}"
      dot.isClickable = true
      dot.isFocusable = true
      dot.setOnClickListener { colorPicked(index) }
      row.addView(dot, LinearLayout.LayoutParams(dp(32f), dp(32f)))
      swatches.add(dot)
    }
    addGroup("Персональный цвет", listOf(SettingsLook.inset(row, top = 12f, side = 14f, bottom = 12f)))
    add(SettingsLook.foot(context, "Этим цветом тебя видят в чатах у других, пока нет фото."), 7f)

    saveButton.onPress = { save() }
    add(saveButton, 20f)
    // Profile: «Рамки и анимации» — the decorations of Platina, saved at once (platina/PlatinaStudio.kt).
    add(SettingsLook.caption(context, "Рамки и анимации"), 24f)
    add(com.linea.messenger.profile.ProfileEditTop.card(com.linea.messenger.platina.PlatinaStudioView(context, account.messenger, compact = true)), 7f)
    showValues()
  }

  override fun onDetachedFromWindow() {
    OwnProfile.unwatch(profileChanged)
    super.onDetachedFromWindow()
  }

  private fun edited() {
    clearNotice()
    showBall()
  }

  private fun showBall() {
    val shown = LinkedHashMap(account.ownProfile)
    val typed = nameField.value.trim()
    if (typed.isNotEmpty()) shown["displayName"] = typed
    shown["avatarColor"] = color
    // Profile: the decorated avatar and the banner as they are now.
    com.linea.messenger.people.Person.from(shown)?.let { person ->
      top.avatar.show(person, person.look, account.base, animated = true)
      top.art.show(person.look, account.base, preview = true)
    }
  }

  private fun showValues() {
    if (!built) return
    val handle = account.ownProfile["username"] as? String ?: ""
    handleRow.setValue(if (handle.isEmpty()) "" else "@$handle")
    birthdayRow.setValue(BirthdayWords.format(birthday).ifEmpty { "Не указан" })
    genderRow.setValue(if (gender == "male") "Мужской" else if (gender == "female") "Женский" else "Не указан")
    patternRow.setValue(pattern ?: "Нет") // Profile
    swatches.forEachIndexed { index, dot ->
      val on = palette[index].equals(color, ignoreCase = true)
      dot.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(0xFF000000.toInt() or Messenger.color(palette[index]))
        if (on) setStroke(dp(3f), Theme.text)
      }
      dot.isSelected = on
    }
    showBall()
  }

  private fun colorPicked(index: Int) {
    if (busy || index !in palette.indices) return
    color = palette[index]
    clearNotice()
    showValues()
  }

  private fun chooseGender() {
    if (busy) return
    // The reference's Sheet «Пол»: SheetActions with «checkmark-circle» on the chosen one, «ellipse-outline» on the others.
    val choices = listOf("male" to "Мужской", "female" to "Женский", null to "Не указан").map { (value, label) ->
      com.linea.messenger.chatactions.ChoiceSheet.Choice(if (gender == value) "ion:checkmark-circle" else "ion:ellipse-outline", label, selected = gender == value) { setGender(value) }
    }
    com.linea.messenger.chatactions.ChoiceSheet(context, "Пол", "Нужен только для оформления в день рождения: синее или розовое. Можно не указывать.", choices).show()
  }

  private fun setGender(value: String?) {
    gender = value
    clearNotice()
    showValues()
  }

  private fun clearNotice() {
    noticeBox.removeAllViews()
  }

  private fun showNotice(words: String, error: Boolean) {
    clearNotice()
    noticeBox.addView(SettingsNotice(context, words, error = error))
    scroll.smoothScrollTo(0, 0)
  }

  private fun setBusy(value: Boolean) {
    busy = value
    saveButton.setBusy(value)
    nameField.isEnabled = !value
    bioArea.isEnabled = !value
  }

  private fun save() {
    if (busy) return
    val name = nameField.value.trim()
    if (name.isEmpty()) return showNotice("Имя не может быть пустым.", error = true)
    val fields = linkedMapOf<String, Any?>("displayName" to name, "bio" to bioArea.value.trim(), "birthday" to birthday, "gender" to gender, "avatarColor" to color, "profilePattern" to pattern)
    endEditing()
    setBusy(true)
    account.accountCall("profile", listOf(fields)) { result ->
      setBusy(false)
      val body = result.getOrNull()
      if (body != null) {
        Core.map(body["user"])?.let { fresh ->
          account.keepOwnProfile(fresh)
          birthday = fresh["birthday"] as? String
          gender = fresh["gender"] as? String
          color = fresh["avatarColor"] as? String ?: color
          pattern = fresh["profilePattern"] as? String // Profile
          showValues()
        }
        showNotice("Профиль сохранён.", error = false)
      } else {
        showNotice(result.failureWords("Не удалось сохранить профиль."), error = true)
      }
    }
  }

  companion object {
    /** The colours a person can be seen in while there is no photo (the reference's eight). */
    val palette = listOf("#596FE8", "#4088C7", "#9271C3", "#B78358", "#AD6C8C", "#667FA4", "#3FA37C", "#D0644E")
  }
}

/** A birthday as it is kept («MM-DD» or «YYYY-MM-DD») and as it is shown («2 мар», «2 мар 1999»).
 *  The rules of `mobile/src/birthday.ts`. */
object BirthdayWords {
  val monthsShort = listOf("янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек")
  val months = listOf("Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь")

  data class Day(val day: Int, val month: Int, val year: Int?)

  private fun number(text: String, digits: Int): Int? = if (text.length == digits && text.all { it in '0'..'9' }) text.toInt() else null

  fun parse(value: String?): Day? {
    val parts = value?.split("-") ?: return null
    if (parts.size == 2) {
      val month = number(parts[0], 2); val day = number(parts[1], 2)
      if (month != null && day != null) return Day(day, month, null)
    }
    if (parts.size == 3) {
      val year = number(parts[0], 4); val month = number(parts[1], 2); val day = number(parts[2], 2)
      if (year != null && month != null && day != null) return Day(day, month, year)
    }
    return null
  }

  fun format(value: String?): String {
    val made = parse(value)?.takeIf { it.month in 1..12 } ?: return ""
    return "${made.day} ${monthsShort[made.month - 1]}" + (made.year?.let { " $it" } ?: "")
  }

  /** Without a year February has 29 days (2000 is a leap year). */
  fun daysInMonth(month: Int, year: Int?): Int = if (month !in 1..12) 31 else try { YearMonth.of(year ?: 2000, month).lengthOfMonth() } catch (_: Exception) { 31 }

  fun value(made: Day): String {
    val tail = String.format(Locale.ROOT, "%02d-%02d", made.month, made.day)
    return if (made.year != null) "${made.year}-$tail" else tail
  }
}

/** «День рождения»: the day and the month, the year if the person wants («2 мар» or «2 мар 1999»). */
@SuppressLint("ViewConstructor")
class BirthdayScreen(context: Context, private val initial: String?, private val done: (String?) -> Unit) : SettingsPage(context, "День рождения") {
  private var month = 1
  private var day = 1
  // The wheels are the system's own; they are given the dark look whatever the window's theme says.
  private val wheels = ContextThemeWrapper(context, android.R.style.Theme_DeviceDefault)
  private val dayPicker = NumberPicker(wheels)
  private val monthPicker = NumberPicker(wheels)
  private val yearField = SettingsField(context, "Год (необязательно)", "Например, 1999")
  private val yearError = context.words("", 12f, Theme.danger)
  private val preview = context.words("", 13f, Theme.muted)
  private val doneButton = SettingsButton(context, "Готово")
  private val thisYear = LocalDate.now().year

  init {
    BirthdayWords.parse(initial)?.takeIf { it.month in 1..12 }?.let {
      month = it.month
      day = it.day.coerceIn(1, 31)
    }
  }

  override fun build() {
    val pickers = LinearLayout(context)
    pickers.orientation = LinearLayout.HORIZONTAL
    pickers.gravity = Gravity.CENTER
    for (picker in listOf(dayPicker, monthPicker)) {
      picker.wrapSelectorWheel = false
      // The wheels are turned, not typed in.
      picker.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
      if (Build.VERSION.SDK_INT >= 29) picker.textColor = Theme.text
    }
    dayPicker.minValue = 1
    dayPicker.maxValue = BirthdayWords.daysInMonth(month, year)
    dayPicker.contentDescription = "День"
    monthPicker.minValue = 1
    monthPicker.maxValue = 12
    monthPicker.displayedValues = BirthdayWords.months.toTypedArray()
    monthPicker.contentDescription = "Месяц"
    dayPicker.setOnValueChangedListener { _, _, value -> day = value; show() }
    monthPicker.setOnValueChangedListener { _, _, value -> month = value; show() }
    pickers.addView(dayPicker, LinearLayout.LayoutParams(dp(84f), dp(180f)))
    pickers.addView(monthPicker, LinearLayout.LayoutParams(dp(170f), dp(180f)).apply { leftMargin = dp(12f) })
    addGroup(rows = listOf(pickers))

    yearField.limit = 4
    yearField.allowed = { it in '0'..'9' }
    yearField.input.inputType = InputType.TYPE_CLASS_NUMBER
    BirthdayWords.parse(initial)?.year?.let { yearField.value = it.toString() }
    yearField.onEdit = { show() }
    add(yearField, 16f)
    add(SettingsLook.inset(yearError, side = 2f), 6f)
    add(SettingsLook.inset(preview, side = 2f), 10f)

    doneButton.onPress = { finish() }
    add(doneButton, 18f)
    if (initial != null) {
      val remove = SettingsButton(context, "Убрать день рождения", SettingsButton.Kind.DANGER)
      remove.onPress = {
        done(null)
        goBack()
      }
      add(remove, 10f)
    }
    monthPicker.value = month
    dayPicker.value = minOf(day, BirthdayWords.daysInMonth(month, year))
    show()
  }

  /** The typed year when it is four digits; null otherwise. */
  private val year: Int? get() = yearField.value.takeIf { it.length == 4 }?.toIntOrNull()

  private val yearProblem: String
    get() {
      if (yearField.value.isEmpty()) return ""
      val typed = year
      return if (typed != null && typed in 1900..thisYear) "" else "Год — от 1900 до $thisYear"
    }

  private val chosen: BirthdayWords.Day get() = BirthdayWords.Day(minOf(day, BirthdayWords.daysInMonth(month, year)), month, year)

  private fun show() {
    val made = chosen
    dayPicker.maxValue = BirthdayWords.daysInMonth(month, year)
    if (dayPicker.value != made.day) dayPicker.value = made.day
    val problem = yearProblem
    yearError.text = problem
    (yearError.parent as? View)?.visibility = if (problem.isEmpty()) View.GONE else View.VISIBLE
    preview.text = "Видят только друзья: " + BirthdayWords.format(BirthdayWords.value(made))
    doneButton.isEnabled = problem.isEmpty()
  }

  private fun finish() {
    if (yearProblem.isNotEmpty()) return
    done(BirthdayWords.value(chosen))
    goBack()
  }
}

/** «Имя пользователя»: the public @username. It is not the login: changing it changes nothing about signing in. */
@SuppressLint("ViewConstructor")
class UsernameScreen(context: Context, private val account: SettingsAccount) : SettingsPage(context, "Имя пользователя") {
  private var status: Map<String, Any?>? = null
  private var loading = true
  private var statusError = ""
  private var failure = ""
  private var notice = ""
  private var busy = false
  private var request = 0
  private val field = SettingsField(context, "Публичное имя пользователя", "@username")
  private val change = SettingsButton(context, "Изменить публичное имя", SettingsButton.Kind.SECONDARY, icon = "at-outline")

  override fun build() {
    field.limit = 25
    field.value = account.ownProfile["username"] as? String ?: ""
    field.onEdit = { showButton() }
    field.onReturn = { review() }
    change.onPress = { review() }
    fill()
    loadStatus(resetDraft = true)
  }

  private val ready: Boolean get() = status != null && !loading && statusError.isEmpty()
  private val canChange: Boolean get() = status?.get("canChangeUsername") as? Boolean ?: false
  private val platina: Boolean get() = Core.map(status?.get("platina"))?.get("active") as? Boolean ?: false
  private val currentName: String get() = status?.get("username") as? String ?: ""

  private fun fill() {
    clear()
    if (statusError.isNotEmpty()) add(SettingsNotice(context, statusError, error = true, onRetry = { loadStatus(resetDraft = false) }))
    if (failure.isNotEmpty()) add(SettingsNotice(context, failure, error = true))
    if (notice.isNotEmpty()) add(SettingsNotice(context, notice))
    add(field, 12f)
    if (loading && status == null) {
      add(SettingsLook.foot(context, "Загрузка…"), 8f)
    } else if (status != null) {
      add(SettingsLook.foot(context, changeWords(canChange, platina, SettingsLook.longMomentWords(status?.get("nextUsernameChangeAt") as? String))), 8f)
    }
    add(change, 16f)
    field.isEnabled = !busy && ready && canChange
    showButton()
  }

  private fun showButton() {
    change.isEnabled = !busy && ready && canChange && AuthRules.handle(field.value) != currentName
  }

  private fun loadStatus(resetDraft: Boolean) {
    request += 1
    val mine = request
    loading = true
    statusError = ""
    fill()
    account.accountCall("usernameStatus", emptyList()) { result ->
      if (mine != request) return@accountCall
      loading = false
      val body = result.getOrNull()
      if (body == null) {
        statusError = result.failureWords("Не удалось получить настройки имени и статуса.")
      } else if (body["accountId"] as? String != account.userId) {
        statusError = "Сервер вернул настройки другого аккаунта."
      } else {
        status = body
        if (resetDraft) (body["username"] as? String)?.let { field.value = it }
      }
      fill()
    }
  }

  private fun review() {
    val wanted = AuthRules.handle(field.value)
    failure = ""
    notice = ""
    if (!AuthRules.validName(wanted)) {
      failure = "Имя пользователя: от 3 до 24 символов a–z, 0–9 и подчёркивание."
      return fill()
    }
    fill()
    if (busy || !ready || !canChange || wanted == currentName) return
    val previous = currentName
    val login = status?.get("loginName") as? String ?: ""
    endEditing()
    confirm("Изменить публичное имя?", reviewWords(previous, wanted, login, platina), "Подтвердить смену имени") { applyChange(previous, wanted) }
  }

  private fun applyChange(previous: String, wanted: String) {
    if (busy || !ready || !canChange) return
    if (previous != currentName) {
      failure = "Имя уже изменилось. Проверь новый вариант ещё раз."
      return fill()
    }
    busy = true
    request += 1
    change.setBusy(true)
    field.isEnabled = false
    account.accountCall("changeUsername", listOf(wanted)) { result ->
      busy = false
      change.setBusy(false)
      val body = result.getOrNull()
      if (body == null) {
        failure = result.failureWords("Не удалось изменить имя пользователя.")
        fill()
        loadStatus(resetDraft = false)
        return@accountCall
      }
      val fresh = Core.map(body["user"]) ?: emptyMap()
      val state = Core.map(body["status"]) ?: emptyMap()
      if (fresh["id"] as? String != account.userId || state["accountId"] as? String != account.userId) {
        failure = "Сервер вернул настройки другого аккаунта."
        fill()
        loadStatus(resetDraft = false)
        return@accountCall
      }
      status = state
      field.value = state["username"] as? String ?: wanted
      account.keepOwnProfile(fresh)
      notice = "Публичное имя изменено. Логин для входа остался прежним."
      fill()
    }
  }

  companion object {
    /** The words under the field: how often the name can be changed, and when next. `later`: the next time, in words (empty: not known). */
    fun changeWords(canChange: Boolean, platina: Boolean, later: String): String {
      if (canChange) return if (platina) "С Platina публичное имя можно менять раз в день." else "Публичное имя можно менять раз в неделю, с Platina — раз в день."
      val words = if (platina) "С Platina имя можно менять раз в день." else "Имя можно менять раз в неделю, с Platina — раз в день."
      return if (later.isEmpty()) words else "$words Следующая смена — $later."
    }

    /** The question before the name is changed. */
    fun reviewWords(previous: String, wanted: String, login: String, platina: Boolean): String {
      val later = if (platina) "Следующая смена будет доступна через день." else "Следующая смена будет доступна через неделю, с Platina — через день."
      return "@$previous → @$wanted\n\nЛогин для входа «$login», ID аккаунта и ключи переписки останутся прежними. Старое публичное имя перестанет вести на твой профиль.\n\n$later"
    }
  }
}
