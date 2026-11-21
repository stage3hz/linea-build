package com.linea.messenger.rooms

import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.BaseAdapter
import android.widget.ListView
import com.linea.messenger.app.Messenger
import com.linea.messenger.calls.CallEntry
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.words
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.people.personAvatarAddress
import java.lang.ref.WeakReference

/** «Выбрать» in the list of chats (the reference's «Изм.» with its «Звонок»): the people of the chats with a mark by
 *  each; «Звонок» rings one person the ordinary way, and several at once — «Звонок · 3» — becomes a room: the room of
 *  exactly these people is found or made, entered, and everyone is called. */
class RoomPicker(context: Context, private val messenger: Messenger?, first: String) : Dialog(context) {
  class Choice(val chatId: String, val person: Person)

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private var everyone: List<Choice> = emptyList()
  private val chosen = ArrayList<String>()
  private val headingLabel = context.words("Чаты", 17f, Theme.text, 700)
  private val countLabel = context.words("", 12.5f, Theme.muted)
  private val cancelButton = context.words("Отмена", 16f, Theme.accent, 600)
  private val list = ListView(context)
  private val emptyLabel = context.words("Загрузка…", 15f, Theme.muted)
  private val callButton = context.words("Звонок", 16f, Theme.onAccent, 600)
  private val notice = context.words("", 13f, Theme.danger)
  private var busy = false

  private val adapter = object : BaseAdapter() {
    override fun getCount() = everyone.size
    override fun getItem(position: Int) = everyone[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val row = (convertView as? RoomPickerCell) ?: RoomPickerCell(context)
      val choice = everyone[position]
      row.show(choice.person, messenger?.personAvatarAddress(choice.person.avatarId) ?: "", choice.chatId in chosen)
      return row
    }
  }

  /** The page of the sheet: its parts are put in place by hand. */
  private val page = object : RoomPartsView(context) {
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val width = r - l; val height = b - t
      val top = dp(10f)
      put(headingLabel, dp(100f), top + dp(14f), width - dp(200f), dp(22f))
      put(countLabel, dp(100f), top + dp(36f), width - dp(200f), dp(16f))
      put(cancelButton, dp(16f), top + dp(12f), dp(84f), dp(40f))
      val bottom = height - dp(20f)
      put(callButton, dp(18f), bottom - dp(50f), width - dp(36f), dp(50f))
      var listBottom = bottom - dp(60f)
      if (notice.text.isNotEmpty()) {
        notice.measure(MeasureSpec.makeMeasureSpec(width - dp(36f), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val high = notice.measuredHeight
        put(notice, dp(18f), listBottom - high, width - dp(36f), high)
        listBottom -= high + dp(8f)
      } else put(notice, 0, 0, 0, 0)
      put(list, 0, top + dp(62f), width, listBottom - top - dp(62f))
      val middle = (top + dp(62f) + listBottom) / 2
      put(emptyLabel, dp(24f), middle - dp(30f), width - dp(48f), dp(60f))
    }
  }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    if (first.isNotEmpty()) chosen.add(first)
    headingLabel.gravity = Gravity.CENTER
    countLabel.gravity = Gravity.CENTER
    cancelButton.gravity = Gravity.START or Gravity.CENTER_VERTICAL
    cancelButton.isClickable = true
    cancelButton.setOnClickListener { dismiss() }
    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Theme.veil(0.07f)); list.cacheColorHint = Color.TRANSPARENT
    list.isVerticalScrollBarEnabled = false
    list.adapter = adapter
    list.setOnItemClickListener { _, row, position, _ -> pick(position, row) }
    emptyLabel.gravity = Gravity.CENTER
    notice.gravity = Gravity.CENTER
    callButton.gravity = Gravity.CENTER
    callButton.background = context.plate(Theme.accent, 25f)
    callButton.isClickable = true
    callButton.contentDescription = "Позвонить выбранным"
    callButton.setOnClickListener { call() }
    for (part in listOf(headingLabel, countLabel, cancelButton, list, emptyLabel, notice, callButton)) page.addView(part)
    page.background = GradientDrawable().apply { setColor(Theme.bg); cornerRadii = floatArrayOf(28f * d, 28f * d, 28f * d, 28f * d, 0f, 0f, 0f, 0f) }
    setContentView(page, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      val screen = context.resources.displayMetrics.heightPixels
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, Math.round(screen * 0.92f))
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
    setCanceledOnTouchOutside(true)
    showCount()
    load()
  }

  private fun load() {
    val messenger = messenger
    if (messenger == null) return show(RoomsDemo.pickerChoices())
    messenger.chats { result ->
      val chats = result.getOrNull()
      if (chats == null) {
        emptyLabel.text = com.linea.messenger.net.Server.error(result).words
        emptyLabel.visibility = View.VISIBLE
        return@chats
      }
      show(chats.mapNotNull { chat -> Person.from(chat.chat["peer"])?.let { Choice(chat.id, it) } })
    }
  }

  private fun show(found: List<Choice>) {
    everyone = found
    val known = found.map { it.chatId }.toSet()
    chosen.retainAll(known)
    emptyLabel.text = "Пока нет чатов"
    emptyLabel.visibility = if (found.isEmpty()) View.VISIBLE else View.GONE
    adapter.notifyDataSetChanged()
    showCount()
  }

  private fun showCount() {
    countLabel.text = if (chosen.isEmpty()) "Отметь чаты" else "Выбрано: ${chosen.size}"
    callButton.text = if (chosen.size > 1) "Звонок · ${chosen.size}" else "Звонок"
    val ready = chosen.isNotEmpty() && !busy
    callButton.isEnabled = ready
    callButton.alpha = if (ready) 1f else 0.4f
  }

  private fun pick(position: Int, row: View?) {
    val id = everyone.getOrNull(position)?.chatId ?: return
    if (id in chosen) chosen.remove(id)
    else {
      // A room holds twelve, this account included.
      if (chosen.size >= RoomRules.limit - 1) {
        notice.text = "В комнате максимум ${RoomRules.limit} человек."
        page.requestLayout()
        return
      }
      chosen.add(id)
    }
    notice.text = ""
    row?.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    adapter.notifyDataSetChanged()
    showCount()
    page.requestLayout()
  }

  /** One chosen person is an ordinary call; several become a room and everyone is called at once. */
  private fun call() {
    if (busy) return
    val picked = everyone.filter { it.chatId in chosen }
    val first = picked.firstOrNull() ?: return
    page.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
    if (picked.size == 1) {
      dismiss()
      CallEntry.call(messenger, first.chatId, first.person.id, first.person.displayName, first.person, video = false)
      return
    }
    if (messenger == null) return dismiss()
    busy = true
    notice.text = ""
    showCount()
    // The picker closes first: the room opens over «Каналы» underneath it.
    val ids = picked.map { it.person.id }
    val owner = ownerContext
    dismiss()
    Rooms.startCall(ids) { words ->
      if (words == null) return@startCall
      try { AlertDialog.Builder(owner, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(words).setPositiveButton("Понятно", null).show() } catch (_: Exception) {}
    }
  }

  private val ownerContext: Context = context

  /** The people and the marks, for the checks. */
  val shownPeople: List<String> get() = everyone.map { it.person.displayName }
  val chosenCount: Int get() = chosen.size
  val callWords: String get() = callButton.text.toString()
  val countWords: String get() = countLabel.text.toString()

  /** For the emulator check: marks the first few people. */
  fun emulatorChoose(count: Int) {
    chosen.clear()
    chosen.addAll(everyone.take(count).map { it.chatId })
    adapter.notifyDataSetChanged()
    showCount()
  }

  override fun show() {
    shown = WeakReference(this)
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  companion object {
    private var shown = WeakReference<RoomPicker>(null)

    /** The picker on the screen now, if any. */
    val current: RoomPicker? get() = shown.get()?.takeIf { it.isShowing }

    /** A room is being opened: the picker over it goes. */
    fun dismissShown() { try { current?.dismiss() } catch (_: Exception) {} }
  }
}

/** A person in «Выбрать»: the mark, the round picture, the name. */
class RoomPickerCell(context: Context) : RoomPartsView(context) {
  private val mark = RoomIconView(context, "circle", 24f, Theme.subtle)
  private val avatar = PersonAvatarView(context)
  private val nameLabel = context.words("", 16f, Theme.text, 600)

  init {
    nameLabel.maxLines = 1
    nameLabel.ellipsize = TextUtils.TruncateAt.END
    nameLabel.gravity = Gravity.CENTER_VERTICAL
    for (part in listOf(mark, avatar, nameLabel)) { part.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO; addView(part) }
  }

  var checked = false
    private set

  fun show(person: Person, address: String, checked: Boolean) {
    this.checked = checked
    mark.symbol = if (checked) "checkmark.circle.fill" else "circle"
    mark.color = if (checked) Theme.accent else Theme.subtle
    mark.ink = Theme.onAccent
    avatar.show(person, address)
    nameLabel.text = person.displayName
    contentDescription = person.displayName
    isSelected = checked
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(64f))

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    put(mark, dp(16f), dp(18f), dp(28f), dp(28f))
    put(avatar, dp(54f), dp(8f), dp(48f), dp(48f))
    put(nameLabel, dp(114f), dp(21f), width - dp(134f), dp(22f))
  }
}
