package com.linea.messenger.chatsplus

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.util.Base64
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.AttachmentLoad
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileOpen
import com.linea.messenger.attachments.PhotoViewer
import com.linea.messenger.chatactions.ChatForward
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.chatactions.ForwardPicker
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.pages
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.shell.Screen
import java.time.Instant
import java.time.ZoneId

/** ChatsPlus: the «Избранное» screen (the reference's saved/SavedScreen.tsx): notes and saved messages, newest at the
 *  bottom with a quiet day above each day, the search, a field for a new note, and by a long press: copy, change (own
 *  notes), choose several, send on to a chat, open the file, delete. Notes are the person's own words, so they stand
 *  at the right edge without a bubble (the owner's «open» look), the time after the last word
 *  (native/ios/Sources/ChatsPlus/SavedViewController.swift). */
@SuppressLint("ViewConstructor")
class SavedScreen(context: Context, private val messenger: Messenger?, private val saved: SavedMessages) : Screen(context) {
  private sealed class Line {
    class Day(val words: String) : Line()
    class Note(val item: Map<String, Any?>) : Line()
  }

  private val main = Handler(Looper.getMainLooper())
  private val bar = GlassPlate(context, 27f)
  private val back = PlusIconView(context, "chevron.left", 19f, Theme.text)
  private val tile = FrameLayout(context)
  private val titleLabel = context.words("Избранное", 16f, Theme.text, 700)
  private val countLabel = context.words("", 11f, Theme.muted)
  private val searchButton = PlusIconView(context, "search", 18f, Theme.muted)
  private val searchBox = GlassPlate(context, 22f)
  private val searchField = EditText(context)
  private val list = ListView(context)
  private val empty = EmptyStateView(context)
  private val notice = context.words("", 12f, Theme.accent)
  private val composer = GlassPlate(context, 28f)
  private val field = EditText(context)
  private val send = PlusIconView(context, "arrow.up", 19f, Theme.onAccent)
  private val clip = PlusIconView(context, "paperclip", 19f, Theme.muted)
  private val editBanner = context.words("Редактирование заметки", 12f, Theme.accent, 700)
  private val editClose = PlusIconView(context, "xmark", 14f, Theme.muted)
  private val selectCancel = context.words("Отмена", 16f, Theme.accent)
  private val selectCount = context.words("", 15f, Theme.text, 600)
  private val selectDelete = LinearLayout(context)
  private val attach = SavedAttach(this, messenger, saved)

  private var lines: List<Line> = emptyList()
  private var searching = false
  private var editingRow: Map<String, Any?>? = null
  private var selection: Set<String>? = null
  private var noticeRun = 0
  private val changed: (Unit) -> Unit = { rebuild(scrollToNewest = false) }
  private val isSample: Boolean get() = ChatsPlusDemo.present && messenger == null
  private val ownName: String get() = messenger?.user?.get("displayName") as? String ?: ""

  private val adapter = object : BaseAdapter() {
    override fun getCount() = lines.size
    override fun getItem(position: Int) = lines[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getViewTypeCount() = 2
    override fun getItemViewType(position: Int) = if (lines[position] is Line.Day) 0 else 1
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View = when (val line = lines[position]) {
      is Line.Day -> (convertView as? TextView ?: dayPill()).also { it.text = line.words }
      is Line.Note -> (convertView as? SavedNoteRow ?: SavedNoteRow(context)).also {
        val id = line.item["id"] as? String ?: ""
        it.show(line.item, ownName, selection?.contains(id))
      }
    }
  }

  init {
    setBackgroundColor(Theme.bg)
    isClickable = true
    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Color.TRANSPARENT)
    list.isVerticalScrollBarEnabled = false
    list.clipToPadding = false
    list.transcriptMode = ListView.TRANSCRIPT_MODE_DISABLED
    list.adapter = adapter
    list.setOnItemClickListener { _, view, position, _ -> pressed(position, view) }
    list.setOnItemLongClickListener { view, _, position, _ -> held(position, view); true }
    addView(list)
    empty.visibility = View.GONE
    addView(empty)

    addView(bar)
    back.contentDescription = "Назад к чатам"
    back.isClickable = true
    back.setOnClickListener { pages()?.pop() }
    tile.background = context.plate(Theme.accent, 16f)
    tile.addView(PlusIconView(context, "bookmark.fill", 18f, Theme.onAccent), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    searchButton.isClickable = true
    searchButton.setOnClickListener { toggleSearch() }
    titleLabel.maxLines = 1
    countLabel.maxLines = 1
    for (part in listOf(back, tile, titleLabel, countLabel, searchButton)) addView(part)

    searchBox.visibility = View.GONE
    searchBox.gravity = Gravity.CENTER_VERTICAL
    searchBox.addView(PlusIconView(context, "search", 16f, Theme.muted), LinearLayout.LayoutParams(context.px(36f), context.px(46f)))
    searchField.hint = "Поиск в Избранном"
    searchField.setHintTextColor(Theme.muted)
    searchField.setTextColor(Theme.text)
    searchField.textSize = 15f
    searchField.background = null
    searchField.isSingleLine = true
    searchField.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    searchField.addTextChangedListener(watcher { rebuild(scrollToNewest = true) })
    searchBox.addView(searchField, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    addView(searchBox)

    notice.gravity = Gravity.CENTER
    notice.background = context.plate(ThemeStore.look.accentSoft, 16f, ThemeStore.look.border)
    notice.setPadding(context.px(14f), 0, context.px(14f), 0)
    notice.alpha = 0f
    addView(notice)

    addView(composer)
    field.hint = if (messenger == null && !isSample) "Заметки доступны в приложении" else "Заметка…"
    field.setHintTextColor(Theme.muted)
    field.setTextColor(Theme.text)
    field.textSize = 15f
    field.background = null
    field.maxLines = 6
    field.contentDescription = "Заметка"
    field.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    field.filters = arrayOf(InputFilter.LengthFilter(SavedMessages.TEXT_LIMIT))
    field.setPadding(context.px(6f), context.px(11f), context.px(6f), context.px(11f))
    field.addTextChangedListener(watcher { refreshComposer() })
    send.background = context.plate(Theme.accent, 22f)
    send.contentDescription = "Сохранить заметку"
    send.isClickable = true
    send.setOnClickListener { submit() }
    clip.contentDescription = "Добавить фото или файл"
    clip.isClickable = true
    clip.setOnClickListener { hideKeyboard(); attach.openMenu() }
    editBanner.visibility = View.GONE
    editClose.contentDescription = "Отменить редактирование"
    editClose.isClickable = true
    editClose.visibility = View.GONE
    editClose.setOnClickListener { stopEditing() }
    selectCancel.gravity = Gravity.CENTER
    selectCancel.isClickable = true
    selectCancel.setOnClickListener { stopSelecting() }
    selectCount.gravity = Gravity.CENTER
    selectDelete.orientation = LinearLayout.HORIZONTAL
    selectDelete.gravity = Gravity.CENTER
    selectDelete.isClickable = true
    selectDelete.contentDescription = "Удалить выбранное"
    selectDelete.addView(PlusIconView(context, "trash", 16f, Theme.danger), LinearLayout.LayoutParams(context.px(20f), context.px(20f)).apply { rightMargin = context.px(4f) })
    selectDelete.addView(context.words("Удалить", 16f, Theme.danger))
    selectDelete.setOnClickListener { deleteSelected() }
    for (part in listOf(field, send, clip, editBanner, editClose, selectCancel, selectCount, selectDelete)) addView(part)
    attach.say = { flash(it) }
    attach.onBusy = { busy -> clip.isEnabled = !busy; refreshComposer() }
    rebuild(scrollToNewest = true)
    refreshComposer()
  }

  private fun watcher(then: () -> Unit) = object : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
    override fun afterTextChanged(s: Editable?) { then() }
  }

  private fun dayPill(): TextView = context.words("", 10f, Theme.muted, 600).apply {
    gravity = Gravity.CENTER
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, context.px(57f))
    background = DayPill(context)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    SavedMessages.changed.watch(changed)
    if (ChatsPlusDemo.savedSearch) main.postDelayed({
      if (!searching) toggleSearch()
      searchField.setText("адрес")
      hideKeyboard()
    }, 600)
  }

  override fun onDetachedFromWindow() {
    SavedMessages.changed.unwatch(changed)
    hideKeyboard()
    super.onDetachedFromWindow()
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(bar, dp(12f), top + dp(12f), width - dp(24f), dp(70f))
    val barLeft = dp(12f); val barTop = top + dp(12f); val barWidth = width - dp(24f)
    put(back, barLeft + dp(8f), barTop + dp(13f), dp(38f), dp(43f))
    put(tile, barLeft + dp(50f), barTop + dp(13f), dp(43f), dp(43f))
    put(searchButton, barLeft + barWidth - dp(8f + 39f), barTop + dp(13f), dp(39f), dp(43f))
    put(titleLabel, barLeft + dp(103f), barTop + dp(15f), barWidth - dp(103f + 55f), dp(20f))
    put(countLabel, barLeft + dp(103f), barTop + dp(38f), barWidth - dp(103f + 55f), dp(15f))
    var y = barTop + dp(70f) + dp(8f)
    if (searching) { put(searchBox, dp(12f), y, width - dp(24f), dp(46f)); y += dp(52f) }
    // The field grows with the text up to 136 dp, as the reference's composer.
    val bottomGap = maxOf(edges.bottom, edges.keyboard) + dp(10f)
    val choosing = selection != null
    val fieldWidth = width - dp(24f) - dp(16f) - dp(44f) - dp(6f) - (if (clip.visibility == View.VISIBLE) dp(34f) else 0)
    field.measure(MeasureSpec.makeMeasureSpec(maxOf(1, fieldWidth), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val wanted = field.measuredHeight.coerceIn(dp(44f), dp(136f))
    val banner = if (editingRow != null && !choosing) dp(36f) else 0
    val inner = if (choosing) dp(44f) else wanted
    val composerHeight = dp(16f) + banner + inner
    val cx = dp(12f); val cy = height - bottomGap - composerHeight; val cw = width - dp(24f)
    put(composer, cx, cy, cw, composerHeight)
    put(editBanner, cx + dp(16f), cy + dp(8f), cw - dp(70f), dp(28f))
    put(editClose, cx + cw - dp(44f), cy + dp(4f), dp(36f), dp(36f))
    val fieldLeft = cx + dp(8f) + (if (clip.visibility == View.VISIBLE) dp(34f) else 0)
    put(field, fieldLeft, cy + dp(8f) + banner, fieldWidth, inner)
    put(send, cx + cw - dp(8f + 44f), cy + composerHeight - dp(8f + 44f), dp(44f), dp(44f))
    put(clip, cx + dp(4f), cy + composerHeight - dp(8f + 44f), dp(36f), dp(44f))
    put(selectCancel, cx + dp(8f), cy + dp(8f), dp(80f), dp(44f))
    put(selectDelete, cx + cw - dp(8f + 110f), cy + dp(8f), dp(110f), dp(44f))
    put(selectCount, cx + dp(90f), cy + dp(8f), cw - dp(200f), dp(44f))
    put(list, 0, y, width, maxOf(0, cy - dp(5f) - y))
    put(empty, 0, y, width, maxOf(0, cy - dp(5f) - y))
    val noticeWidth = minOf(width - dp(40f), notice.paint.measureText(notice.text.toString()).toInt() + dp(28f))
    put(notice, (width - noticeWidth) / 2, y + dp(4f), noticeWidth, dp(30f))
  }

  // The list

  private fun rebuild(scrollToNewest: Boolean) {
    val shown = if (searching) SavedMessages.search(saved.items, searchField.text.toString()) else saved.items
    val next = ArrayList<Line>()
    var day = ""
    val now = Instant.now(); val zone = ZoneId.systemDefault()
    for (item in shown) {
      val words = Messenger.date(item["savedAt"] as? String)?.let { Messenger.dayWords(it, now, zone) } ?: ""
      if (words != day) { day = words; next.add(Line.Day(words)) }
      next.add(Line.Note(item))
    }
    lines = next
    val count = saved.items.size
    countLabel.text = if (count > 0) "$count · только на этом устройстве" else "Хранится только на этом устройстве"
    searchButton.symbol = if (searching) "xmark" else "search"
    searchButton.color = if (searching) Theme.accent else Theme.muted
    searchButton.contentDescription = if (searching) "Закрыть поиск" else "Поиск в Избранном"
    searchButton.invalidate()
    adapter.notifyDataSetChanged()
    val nothing = shown.isEmpty() && saved.loaded
    empty.visibility = if (nothing) View.VISIBLE else View.GONE
    if (nothing) {
      if (searching) empty.show("search", "Ничего не найдено", "Попробуй другое слово.")
      else empty.show("bookmark", "Здесь пока пусто", "Пиши заметки, сохраняй файлы и голосовые. Любое сообщение из чата можно отправить сюда через долгое нажатие → «В Избранное».")
    }
    if (saved.error.isNotEmpty()) flash(saved.error)
    if (scrollToNewest && lines.isNotEmpty()) list.post { list.setSelection(lines.size - 1) }
  }

  private fun pressed(position: Int, view: View) {
    val item = (lines.getOrNull(position) as? Line.Note)?.item ?: return
    val id = item["id"] as? String ?: return
    val chosen = selection
    if (chosen != null) {
      selection = if (chosen.contains(id)) chosen - id else chosen + id
      view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      adapter.notifyDataSetChanged()
      refreshComposer()
      return
    }
    Core.map(item["attachment"])?.let { open(it) }
  }

  // Menu

  private fun held(position: Int, view: View) {
    if (selection != null) return
    val item = (lines.getOrNull(position) as? Line.Note)?.item ?: return
    view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    val text = item["text"] as? String ?: ""
    val choices = ArrayList<ChoiceSheet.Choice>()
    if (text.isNotEmpty()) choices.add(ChoiceSheet.Choice("copy", "Скопировать текст") {
      (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("Заметка", text))
      flash("Скопировано")
    })
    if (!item.containsKey("origin") && text.isNotEmpty()) choices.add(ChoiceSheet.Choice("pencil", "Изменить") { startEditing(item) })
    choices.add(ChoiceSheet.Choice("checkmark.circle", "Выбрать") {
      val id = item["id"] as? String ?: return@Choice
      selection = setOf(id)
      adapter.notifyDataSetChanged()
      refreshComposer()
    })
    choices.add(ChoiceSheet.Choice("forward", "Переслать в чат") { forward(item) })
    Core.map(item["attachment"])?.let { attachment ->
      choices.add(ChoiceSheet.Choice("arrow.down.circle", if (ChatRowLooks.isVideoNote(attachment)) "Сохранить видео" else "Сохранить файл") { open(attachment) })
    }
    choices.add(ChoiceSheet.Choice("trash", "Удалить из Избранного", danger = true) {
      val id = item["id"] as? String ?: return@Choice
      saved.remove(id) { failure -> failure?.let { flash(it.words) } }
    })
    val preview = if (text.isEmpty()) SavedMessages.line(item).first else text.take(120)
    ChoiceSheet(context, "Избранное", preview, choices).show()
  }

  /** «Переслать в чат»: the same picker as in chats; a touch sends at once. */
  private fun forward(item: Map<String, Any?>) {
    val picker = ForwardPicker(context, messenger, 1)
    val author = (Core.map(item["origin"])?.get("author") as? String ?: ownName).ifEmpty { "Я" }
    val message = HashMap<String, Any?>()
    message["text"] = item["text"] as? String ?: ""
    message["senderId"] = messenger?.userId ?: ""
    Core.map(item["attachment"])?.let { message["attachment"] = it }
    picker.onPick = { target ->
      val messenger = messenger
      if (messenger == null) flash("Переслано: " + target.name)
      else ChatForward.send(messenger, target.chatId, target.peerId, message, author) { problem -> flash(problem ?: "Переслано: " + target.name) }
    }
    picker.show()
  }

  /** A photo opens in the viewer, any other file in the system's own app (attachments/ChatAttachments.kt does the
   *  same for a chat). */
  private fun open(attachment: Map<String, Any?>) {
    val about = FileCore.describe(attachment)
    about.refusal?.let { return flash(it) }
    val messenger = messenger ?: return
    val cipherSize = about.cipherSize ?: return
    val load = AttachmentLoad(messenger.server, attachment, cipherSize)
    hideKeyboard()
    if (about.kind == "photo") {
      val small = (Core.map(attachment["preview"])?.get("base64") as? String)?.let { text ->
        try { Base64.decode(text, Base64.DEFAULT).let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) } } catch (_: Throwable) { null }
      }
      PhotoViewer(context, small, load).show()
    } else FileOpen(this, attachment["name"] as? String ?: "Файл", about.fileName, load).show()
  }

  // Writing

  private fun refreshComposer() {
    val choosing = selection != null
    field.visibility = if (choosing) View.GONE else View.VISIBLE
    val text = field.text.toString()
    val ready = text.isNotBlank() && (messenger != null || isSample)
    send.visibility = if (choosing) View.GONE else View.VISIBLE
    send.isEnabled = ready
    send.alpha = if (ready) 1f else 0.4f
    send.symbol = if (editingRow != null) "checkmark" else "arrow.up"
    send.contentDescription = if (editingRow != null) "Сохранить изменения" else "Сохранить заметку"
    send.invalidate()
    clip.visibility = if (choosing || editingRow != null) View.GONE else View.VISIBLE
    editBanner.visibility = if (editingRow == null || choosing) View.GONE else View.VISIBLE
    editClose.visibility = editBanner.visibility
    for (part in listOf(selectCancel, selectCount, selectDelete)) part.visibility = if (choosing) View.VISIBLE else View.GONE
    selectCount.text = "Выбрано: ${selection?.size ?: 0}"
    val some = (selection?.size ?: 0) > 0
    selectDelete.isEnabled = some
    selectDelete.alpha = if (some) 1f else 0.4f
    requestLayout()
  }

  private fun submit() {
    val value = field.text.toString().trim()
    if (value.isEmpty()) return
    val editing = editingRow
    val id = editing?.get("id") as? String
    if (editing != null && id != null) {
      saved.edit(id, value) { failure ->
        if (failure != null) return@edit flash(failure.words)
        editingRow = null
        field.setText("")
        refreshComposer()
      }
      return
    }
    saved.save(value, null) { result ->
      val failure = result.exceptionOrNull() as? SavedMessages.Failure
      if (failure != null) return@save flash(failure.words)
      field.setText("")
      refreshComposer()
      rebuild(scrollToNewest = true)
    }
  }

  private fun startEditing(item: Map<String, Any?>) {
    editingRow = item
    field.setText(item["text"] as? String ?: "")
    field.setSelection(field.text.length)
    refreshComposer()
    field.requestFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(field, 0)
  }

  private fun stopEditing() {
    editingRow = null
    field.setText("")
    refreshComposer()
  }

  private fun stopSelecting() {
    selection = null
    adapter.notifyDataSetChanged()
    refreshComposer()
  }

  private fun deleteSelected() {
    val ids = selection ?: return
    if (ids.isEmpty()) return
    selection = null
    saved.remove(ids) { failure -> failure?.let { flash(it.words) } }
    refreshComposer()
  }

  // Search, notices

  private fun toggleSearch() {
    searching = !searching
    searchBox.visibility = if (searching) View.VISIBLE else View.GONE
    searchField.setText("")
    if (searching) {
      searchField.requestFocus()
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(searchField, 0)
    } else hideKeyboard()
    rebuild(scrollToNewest = true)
    requestLayout()
  }

  private fun hideKeyboard() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun flash(words: String) {
    noticeRun += 1
    val run = noticeRun
    notice.text = words
    requestLayout()
    notice.animate().alpha(1f).setDuration(180).start()
    main.postDelayed({ if (run == noticeRun) notice.animate().alpha(0f).setDuration(250).start() }, 2200)
  }

  /** The quiet capsule behind a day's words. */
  private class DayPill(context: Context) : android.graphics.drawable.Drawable() {
    private val d = context.resources.displayMetrics.density
    private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = Theme.veil(0.07f) }
    override fun draw(canvas: android.graphics.Canvas) {
      val b = bounds
      val w = 120f * d
      val left = b.exactCenterX() - w / 2
      canvas.drawRoundRect(left, b.top + 15f * d, left + w, b.top + 43f * d, 14f * d, 14f * d, paint)
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
  }

  companion object {
    /** Opens «Избранное» over the page `from` stands in. */
    fun open(from: View, messenger: Messenger?) {
      val saved = SavedMessages.shared(messenger) ?: return
      val stack = from.pages() ?: return
      (from.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(from.windowToken, 0)
      stack.push(SavedScreen(from.context, messenger, saved))
    }
  }
}

/** One note at the right edge: where it came from, its file, its words, and the time after the last word. */
@SuppressLint("ViewConstructor")
private class SavedNoteRow(context: Context) : LinearLayout(context) {
  private val check = PlusIconView(context, "circle", 21f, Theme.subtle)
  private val column = LinearLayout(context)
  private val origin = context.words("", 11f, Theme.accent, 600).apply { gravity = Gravity.END; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
  private val file = context.words("", 14f, Theme.accent, 500).apply { gravity = Gravity.END; maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE }
  private val body = TextView(context).apply { gravity = Gravity.END; textSize = 16f; setTextColor(Theme.text) }

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
    setPadding(context.px(10f), context.px(4f), context.px(15f), context.px(10f))
    addView(check, LayoutParams(context.px(30f), context.px(30f)).apply { rightMargin = context.px(5f) })
    column.orientation = VERTICAL
    column.gravity = Gravity.END
    column.addView(origin, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = context.px(4f) })
    column.addView(file, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { bottomMargin = context.px(4f) })
    column.addView(body, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(column, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
  }

  fun show(item: Map<String, Any?>, own: String, checked: Boolean?) {
    check.visibility = if (checked == null) View.GONE else View.VISIBLE
    check.symbol = if (checked == true) "circle.fill.check" else "circle"
    check.color = if (checked == true) Theme.accent else Theme.subtle
    check.invalidate()
    val now = Instant.now(); val zone = ZoneId.systemDefault()
    val from = Core.map(item["origin"])
    if (from != null) {
      val author = from["author"] as? String ?: ""
      val day = Messenger.date(from["sentAt"] as? String)?.let { Messenger.dayWords(it, now, zone) } ?: ""
      origin.text = (if (author == own && own.isNotEmpty()) "Твоё сообщение" else "От $author") + (if (day.isEmpty()) "" else " · $day")
      origin.visibility = View.VISIBLE
    } else origin.visibility = View.GONE
    val attachment = Core.map(item["attachment"])
    if (attachment != null) {
      val (text, icon) = ChatRowLooks.attachmentLine(attachment)
      file.text = (if (icon == "mic") "🎤 " else "") + text
      file.visibility = View.VISIBLE
    } else file.visibility = View.GONE
    val time = (if (item.containsKey("editedAt")) "изм. " else "") + (Messenger.date(item["savedAt"] as? String)?.let { Messenger.clock(it, zone) } ?: "")
    val text = item["text"] as? String ?: ""
    // The open look: the time stands after the last word, small and quiet.
    val words = SpannableStringBuilder(text)
    val start = words.length
    words.append((if (text.isEmpty()) "" else "  ") + time)
    words.setSpan(AbsoluteSizeSpan(10, true), start, words.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    words.setSpan(ForegroundColorSpan(Theme.muted), start, words.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    body.text = words
    // The words take at most 85 % of the row, at its right edge.
    val room = (resources.displayMetrics.widthPixels * 0.85f).toInt()
    body.maxWidth = room; file.maxWidth = room; origin.maxWidth = room
    contentDescription = (if (text.isEmpty()) (if (file.visibility == View.VISIBLE) file.text.toString() else "Запись") else text) + ", " + time
  }
}
