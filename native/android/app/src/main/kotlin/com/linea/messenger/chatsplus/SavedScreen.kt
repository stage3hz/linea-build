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
import com.linea.messenger.voice.MsgMediaBoxes
import com.linea.messenger.voice.MsgMediaState
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
  // SavedScreen.tsx IconButtons: rounds of clear glass with the reference's glyphs (design/GlassKit.kt).
  private val back = com.linea.messenger.design.GlassRoundButton(context, "ion:chevron-back", "Назад к чатам", 23f, painter = PlusIcons::draw)
  private val tile = FrameLayout(context)
  private val titleLabel = context.words("Избранное", 16f, Theme.text, 700)
  private val countLabel = context.words("", 11f, Theme.muted)
  private val searchButton = com.linea.messenger.design.GlassRoundButton(context, "ion:search-outline", "Поиск в Избранном", 23f, painter = PlusIcons::draw).apply { tint = Theme.muted }
  private val searchBox = GlassPlate(context, 22f)
  private val searchField = EditText(context)
  private val list = ListView(context)
  /** The list in a frame, so a round video's player can stand over its row (video/NotePlayback.kt). */
  private val listHost = FrameLayout(context)
  /** Voice messages and round videos play here as in a chat. */
  private val voice = com.linea.messenger.voice.VoicePlayer(context, messenger?.server)
  private val notes = com.linea.messenger.video.NotePlayback(context, messenger?.server, listHost, { key -> noteHost(key) }, { visibleKeys() })
  private var mediaState: MsgMediaState? = null
  /** The note whose round video is being listened to (its slot is large); empty: none. */
  private var expandedNote = ""
  private val watch = object : Runnable {
    override fun run() { notes.refresh(); main.postDelayed(this, 500) }
  }
  private val empty = EmptyStateView(context)
  private val notice = context.words("", 12f, Theme.accent)
  private val composer = GlassPlate(context, 28f)
  private val field = EditText(context)
  private val send = PlusIconView(context, "ion:arrow-up", 23f, Theme.onAccent)
  private val clip = com.linea.messenger.design.GlassRoundButton(context, "ion:add", "Сохранить фото, видео или файл", 23f, painter = PlusIcons::draw).apply { tint = Theme.accent }
  private val editBanner = context.words("Редактирование заметки", 12f, Theme.accent, 700)
  private val editClose = com.linea.messenger.design.GlassRoundButton(context, "ion:close", "Отменить редактирование", 18f, side = 36f, painter = PlusIcons::draw).apply { tint = Theme.muted }
  private val selectCancel = context.words("Отмена", 16f, Theme.accent)
  private val selectCount = context.words("", 15f, Theme.text, 600)
  private val selectDelete = LinearLayout(context)
  private val attach = SavedAttach(this, messenger, saved)
  /** Record: the layer over the composer's glass with the record button, the take and its preview. */
  private val recordHolder = android.widget.FrameLayout(context)

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
      is Line.Day -> (convertView as? FrameLayout ?: dayPill()).also { (it.tag as? TextView)?.text = line.words }
      is Line.Note -> (convertView as? SavedNoteRow ?: SavedNoteRow(context)).also {
        val id = line.item["id"] as? String ?: ""
        val key = "saved:$id"
        it.show(line.item, ownName, selection?.contains(id), mediaState?.takeIf { state -> state.key == key }, noteRoom, key == expandedNote)
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
    // SavedScreen.tsx: the list's content stands 14 dp in from the top and the bottom.
    list.setPadding(0, context.px(14f), 0, context.px(14f))
    list.transcriptMode = ListView.TRANSCRIPT_MODE_DISABLED
    list.adapter = adapter
    list.setOnItemClickListener { _, view, position, _ -> pressed(position, view) }
    list.setOnItemLongClickListener { view, _, position, _ -> held(position, view); true }
    list.setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView?, scrollState: Int) {}
      override fun onScroll(view: AbsListView?, firstVisibleItem: Int, visibleItemCount: Int, totalItemCount: Int) { notes.follow() }
    })
    listHost.addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(listHost)
    installPlayers()
    empty.visibility = View.GONE
    addView(empty)

    addView(bar)
    back.onPress = { pages()?.pop() }
    tile.background = context.plate(Theme.accent, 16f)
    tile.addView(PlusIconView(context, "ion:bookmark", 21f, Theme.onAccent), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    searchButton.onPress = { toggleSearch() }
    titleLabel.maxLines = 1
    countLabel.maxLines = 1
    for (part in listOf(back, tile, titleLabel, countLabel, searchButton)) addView(part)

    searchBox.visibility = View.GONE
    searchBox.gravity = Gravity.CENTER_VERTICAL
    searchBox.addView(PlusIconView(context, "ion:search-outline", 18f, Theme.muted), LinearLayout.LayoutParams(context.px(36f), context.px(46f)))
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
    clip.onPress = { hideKeyboard(); attach.openMenu() }
    editBanner.visibility = View.GONE
    editClose.visibility = View.GONE
    editClose.onPress = { stopEditing() }
    selectCancel.gravity = Gravity.CENTER
    selectCancel.isClickable = true
    selectCancel.setOnClickListener { stopSelecting() }
    selectCount.gravity = Gravity.CENTER
    selectDelete.orientation = LinearLayout.HORIZONTAL
    selectDelete.gravity = Gravity.CENTER
    selectDelete.isClickable = true
    selectDelete.contentDescription = "Удалить выбранное"
    selectDelete.addView(PlusIconView(context, "ion:trash-outline", 19f, Theme.danger), LinearLayout.LayoutParams(context.px(20f), context.px(20f)).apply { rightMargin = context.px(4f) })
    selectDelete.addView(context.words("Удалить", 16f, Theme.danger))
    selectDelete.setOnClickListener { deleteSelected() }
    for (part in listOf(field, send, clip, editBanner, editClose, selectCancel, selectCount, selectDelete)) addView(part)
    attach.say = { flash(it) }
    attach.onBusy = { busy -> clip.isEnabled = !busy; refreshComposer() }
    addView(recordHolder)
    attach.installRecording(recordHolder, this)
    attach.recording.control.clipView = clip
    attach.recording.control.fieldViews = listOf(field)
    attach.recording.control.onPhase = { refreshComposer(); requestLayout() }
    attach.recording.willStart = { hideKeyboard(); voice.pause() }
    rebuild(scrollToNewest = true)
    refreshComposer()
  }

  private fun watcher(then: () -> Unit) = object : TextWatcher {
    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
    override fun afterTextChanged(s: Editable?) { then() }
  }

  /** SavedScreen.tsx: the day in a capsule — 15 above, 6 × 14 inside, 14 below; t.glass on a dark theme, white
   *  at 0.52 on a light one; 10 dp semibold muted. */
  private fun dayPill(): FrameLayout = FrameLayout(context).apply {
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
    val words = context.words("", 10f, Theme.muted, 600)
    words.gravity = Gravity.CENTER
    words.setPadding(context.px(14f), context.px(6f), context.px(14f), context.px(6f))
    words.background = context.plate(if (Theme.dark) ThemeStore.look.glass else 0x85FFFFFF.toInt(), 14f)
    addView(words, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL).apply {
      topMargin = context.px(15f); bottomMargin = context.px(14f)
    })
    tag = words
  }

  // Voice messages and round videos

  private fun installPlayers() {
    voice.onState = { state -> setMediaState(state) }
    voice.onProblem = { words -> flash(words) }
    voice.onWillPlay = { notes.quiet() }
    notes.onState = { state -> setMediaState(state) }
    notes.onProblem = { words -> flash(words) }
    notes.onWillPlay = { voice.pause() }
    notes.holdsSilence = { voice.isPlaying || attach.isRecording }
    notes.onReadyChanged = { key -> noteRow(key)?.redraw(mediaState?.takeIf { it.key == key }) }
    // VideoNote.tsx: a circle listened to grows to min(404, the row) at the right edge and shrinks back after.
    notes.anchorsRight = { true }
    notes.onExpanded = { key, open -> expandedNote = if (open) key else ""; adapter.notifyDataSetChanged() }
  }

  private fun noteRow(key: String): SavedNoteRow? {
    for (index in 0 until list.childCount) (list.getChildAt(index) as? SavedNoteRow)?.takeIf { it.key == key }?.let { return it }
    return null
  }

  private fun noteHost(key: String): android.graphics.RectF? {
    val row = noteRow(key) ?: return null
    val box = row.noteBox() ?: return null
    return box.apply { offset(row.left.toFloat(), row.top.toFloat()) }
  }

  private fun visibleKeys(): List<String> = (0 until list.childCount).mapNotNull { (list.getChildAt(it) as? SavedNoteRow)?.key }

  private fun setMediaState(next: MsgMediaState?) {
    if (next == mediaState) return
    val keys = listOf(mediaState?.key, next?.key)
    mediaState = next
    for (index in 0 until list.childCount) {
      val row = list.getChildAt(index) as? SavedNoteRow ?: continue
      if (row.key in keys) row.redraw(next?.takeIf { it.key == row.key })
    }
  }

  /** The width a round video may take: 85 % of the list without its 15 dp sides (SavedScreen.tsx `maxSide`). */
  private val noteRoom: Float get() = Math.floor(((list.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels) - 30f * d) * 0.85).toFloat()

  /** A part of a note was touched: the voice message's button or waveform (start / pause — never a seek, the
   *  owner's rule), its speed, a round video (with sound / pause), a file's card (open). */
  private fun partPressed(item: Map<String, Any?>, part: String) {
    if (part.startsWith("link:")) {
      val href = part.removePrefix("link:")
      com.linea.messenger.linkpreview.LinkOpen.pressed(context, href, href)
      return
    }
    val attachment = Core.map(item["attachment"]) ?: return
    val key = "saved:" + (item["id"] as? String ?: "")
    when (part) {
      "rate" -> flash(voice.cycleRate())
      "play", "wave" -> voice.toggle(key, attachment)
      "thumb" -> notes.toggle(key, attachment)
      "card" -> open(attachment)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    main.removeCallbacks(watch)
    main.postDelayed(watch, 500)
    SavedMessages.changed.watch(changed)
    if (ChatsPlusDemo.savedSearch) main.postDelayed({
      if (!searching) toggleSearch()
      searchField.setText("адрес")
      hideKeyboard()
    }, 600)
  }

  override fun onDetachedFromWindow() {
    main.removeCallbacks(watch)
    attach.recording.left() // Record: a take is called off, a preview thrown away
    voice.left()
    notes.left()
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
    val fieldWidth = width - dp(24f) - dp(16f) - dp(44f) - dp(6f) - (if (clip.visibility == View.VISIBLE) dp(50f) else 0)
    field.measure(MeasureSpec.makeMeasureSpec(maxOf(1, fieldWidth), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val wanted = field.measuredHeight.coerceIn(dp(44f), dp(136f))
    val banner = if (editingRow != null && !choosing) dp(36f) else 0
    val inner = if (choosing) dp(44f) else wanted
    val composerHeight = dp(16f) + banner + inner
    val cx = dp(12f); val cy = height - bottomGap - composerHeight; val cw = width - dp(24f)
    put(composer, cx, cy, cw, composerHeight)
    put(editBanner, cx + dp(16f), cy + dp(8f), cw - dp(70f), dp(28f))
    put(editClose, cx + cw - dp(44f), cy + dp(4f), dp(36f), dp(36f))
    val fieldLeft = cx + dp(8f) + (if (clip.visibility == View.VISIBLE) dp(50f) else 0)
    put(field, fieldLeft, cy + dp(8f) + banner, fieldWidth, inner)
    put(send, cx + cw - dp(8f + 44f), cy + composerHeight - dp(8f + 44f), dp(44f), dp(44f))
    put(clip, cx + dp(8f), cy + composerHeight - dp(8f + 44f), dp(44f), dp(44f))
    // Record: the take's dot, time and «slide to cancel» fill the glass up to the button; the preview starts after
    // the trash, which stands in the «add» button's place.
    put(recordHolder, cx, cy, cw, composerHeight)
    val clipRight = dp(8f + 44f + 6f).toFloat()
    val row = android.graphics.RectF(0f, 0f, (cw - dp(8f + 44f + 6f)).toFloat(), (composerHeight - dp(10f)).toFloat())
    attach.recording.control.place(
      android.graphics.RectF((cw - dp(8f + 44f)).toFloat(), (composerHeight - dp(8f + 44f)).toFloat(), (cw - dp(8f)).toFloat(), (composerHeight - dp(8f)).toFloat()),
      android.graphics.RectF(clipRight, row.top, row.right, row.bottom), row,
      android.graphics.RectF(dp(8f).toFloat(), (composerHeight - dp(8f + 44f)).toFloat(), dp(52f).toFloat(), (composerHeight - dp(8f)).toFloat()),
      width, height,
    )
    put(selectCancel, cx + dp(8f), cy + dp(8f), dp(80f), dp(44f))
    put(selectDelete, cx + cw - dp(8f + 110f), cy + dp(8f), dp(110f), dp(44f))
    put(selectCount, cx + dp(90f), cy + dp(8f), cw - dp(200f), dp(44f))
    put(listHost, 0, y, width, maxOf(0, cy - dp(5f) - y))
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
    searchButton.symbol = if (searching) "ion:close" else "ion:search-outline"
    searchButton.tint = if (searching) Theme.accent else Theme.muted
    searchButton.contentDescription = if (searching) "Закрыть поиск" else "Поиск в Избранном"
    adapter.notifyDataSetChanged()
    val nothing = shown.isEmpty() && saved.loaded
    empty.visibility = if (nothing) View.VISIBLE else View.GONE
    if (nothing) {
      if (searching) empty.show("ion:search-outline", "Ничего не найдено", "Попробуй другое слово.")
      else empty.show("ion:bookmark-outline", "Здесь пока пусто", "Пиши заметки, сохраняй файлы и голосовые. Любое сообщение из чата можно отправить сюда через долгое нажатие → «В Избранное».")
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
    // SavedScreen.tsx: outside «Выбрать» a note itself takes no tap; its attachment has its own controls.
    val row = view as? SavedNoteRow ?: return
    row.part(row.downX, row.downY)?.let { partPressed(item, it) }
  }

  // Menu

  /** SavedScreen.tsx: the same menu as in chats (ContextMenu over the note, `mine`), with the note's words or its
   *  attachment as the preview: «Скопировать текст», «Изменить», «Выбрать», «Переслать в чат», «Сохранить видео» /
   *  «Сохранить файл» (the share sheet, `shareEncryptedAttachment`), «Удалить из Избранного». */
  private fun held(position: Int, view: View) {
    if (selection != null) return
    val item = (lines.getOrNull(position) as? Line.Note)?.item ?: return
    view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    val text = item["text"] as? String ?: ""
    val choices = ArrayList<com.linea.messenger.chatactions.MessageMenu.Item>()
    if (text.isNotEmpty()) choices.add(com.linea.messenger.chatactions.MessageMenu.Item("copy", "Скопировать текст") {
      (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("Заметка", text))
      flash("Скопировано")
    })
    if (!item.containsKey("origin") && text.isNotEmpty()) choices.add(com.linea.messenger.chatactions.MessageMenu.Item("pencil", "Изменить") { startEditing(item) })
    choices.add(com.linea.messenger.chatactions.MessageMenu.Item("check.circle", "Выбрать") {
      val id = item["id"] as? String ?: return@Item
      selection = setOf(id)
      adapter.notifyDataSetChanged()
      refreshComposer()
    })
    choices.add(com.linea.messenger.chatactions.MessageMenu.Item("forward", "Переслать в чат") { forward(item) })
    Core.map(item["attachment"])?.let { attachment ->
      choices.add(com.linea.messenger.chatactions.MessageMenu.Item("square.and.arrow.down", if (ChatRowLooks.isVideoNote(attachment)) "Сохранить видео" else "Сохранить файл") {
        val messenger = messenger ?: return@Item
        com.linea.messenger.attachments.MediaSave.share(context, attachment, messenger) { words, _ -> flash(words) }
      })
    }
    choices.add(com.linea.messenger.chatactions.MessageMenu.Item("trash", "Удалить из Избранного", danger = true, separated = true) {
      val id = item["id"] as? String ?: return@Item
      saved.remove(id) { failure -> failure?.let { flash(it.words) } }
    })
    val preview = if (text.isEmpty()) SavedMessages.line(item).first else text
    val at = IntArray(2)
    view.getLocationOnScreen(at)
    val y = at[1] + ((view as? SavedNoteRow)?.downY ?: view.height / 2f)
    hideKeyboard()
    com.linea.messenger.chatactions.MessageMenu(context, y, true, preview, emptyList(), choices).show()
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
    // Record: with an empty field the microphone stands there instead (not while changing a note or choosing).
    val control = attach.recording.control
    val canRecord = text.isEmpty() && editingRow == null && !choosing && (messenger != null || isSample) && !attach.busy
    control.setVisible(canRecord)
    if (canRecord || control.isBusy) send.visibility = View.INVISIBLE
    send.isEnabled = ready
    send.alpha = if (ready) 1f else 0.4f
    send.symbol = if (editingRow != null) "ion:checkmark" else "ion:arrow-up"
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

/** One note at the right edge, drawn as the reference's SavedScreen.tsx row: where it came from, its attachment
 *  exactly as a chat draws it (VoiceBubble, VideoNoteBubble, AttachmentCard), its words and the time. A round video
 *  with no words and no origin stands alone with the time in a pill under it (`circleOnly`). The owner's open look:
 *  no plate unless bubbles are chosen in «Оформление» (then the reference's plate: radius 23, 8 at the lower right).
 *  iOS: native/ios/Sources/ChatsPlus/SavedViewController.swift (SavedNoteCanvas). */
private val URL_RE = Regex("\\b((?:https?://|www\\.)[^\\s<>\"'«»]+[^\\s<>\"'«».,:;!?)\\]])", RegexOption.IGNORE_CASE)

@SuppressLint("ViewConstructor")
private class SavedNoteRow(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  var key = ""; private set
  private var item: Map<String, Any?> = emptyMap()
  private var checked: Boolean? = null
  private var originWords = ""
  private var words = ""
  private var timeWords = ""
  private var edited = false
  /** "voice", "note", "card" or "" (no attachment). */
  private var kind = ""
  private var fileKind = "file"
  private var attachment: Map<String, Any?> = emptyMap()
  private var poster: android.graphics.Bitmap? = null
  private var posterOf = ""
  private var maxSide = 212f
  private var expanded = false
  var state: MsgMediaState? = null
  private val boxes = MsgMediaBoxes()
  /** Where the parts stand (px, in this view). */
  private val boxRect = android.graphics.RectF()
  private val originRect = android.graphics.RectF()
  private val media = android.graphics.RectF()
  private val textAt = android.graphics.PointF()
  private val timeRect = android.graphics.RectF()
  private var timeInline = false
  private var textLayout: android.text.StaticLayout? = null
  private var originLayout: android.text.StaticLayout? = null
  private var laidWidth = -1
  private var laidHeight = 0
  /** Where the last finger came down (for the list's tap). */
  var downX = 0f; private set
  var downY = 0f; private set

  private val fill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
  private val line = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.STROKE }
  private val originPaint = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG)
  private val textPaint = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG)
  private val small = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG)

  init {
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, AbsListView.LayoutParams.WRAP_CONTENT)
  }

  /** chatPreferences.ts TEXT_SIZES: the size of message text and its line (dp). */
  private val metrics: Pair<Float, Float> get() {
    val size = ThemeStore.textSize
    return when {
      size < 16f -> Pair(15f, 20f)
      size < 18f -> Pair(17f, 22f)
      size < 20f -> Pair(19f, 25f)
      else -> Pair(22f, 28f)
    }
  }

  /** `circleOnly` (SavedScreen.tsx): a round video with no words and no origin, shown alone. */
  private val circleOnly: Boolean get() = kind == "note" && words.isEmpty() && !item.containsKey("origin")
  /** A plate only when bubbles are chosen; the open look has none (the owner's rule). */
  private val plated: Boolean get() = !com.linea.messenger.chatlook.ChatBubbleLook.open && !circleOnly
  private val visual: Boolean get() = fileKind == "photo" || fileKind == "video"

  private val duration: String get() {
    val ms = (Core.map(attachment["media"])?.get("durationMs") as? Number)?.toDouble() ?: 0.0
    val seconds = (ms / 1000).toInt()
    return if (seconds > 0) "${seconds / 60}:" + String.format(java.util.Locale.ROOT, "%02d", seconds % 60) else ""
  }

  fun show(next: Map<String, Any?>, own: String, checked: Boolean?, state: MsgMediaState?, maxSide: Float, expanded: Boolean) {
    this.expanded = expanded
    item = next
    key = "saved:" + (next["id"] as? String ?: "")
    this.checked = checked
    this.state = state
    this.maxSide = maxSide
    val now = Instant.now(); val zone = ZoneId.systemDefault()
    val from = Core.map(next["origin"])
    originWords = if (from != null) {
      val author = from["author"] as? String ?: ""
      val day = Messenger.date(from["sentAt"] as? String)?.let { Messenger.dayWords(it, now, zone) } ?: ""
      (if (author == own) "Твоё сообщение" else "От $author") + " · " + day
    } else ""
    words = next["text"] as? String ?: ""
    edited = next.containsKey("editedAt")
    timeWords = Messenger.date(next["savedAt"] as? String)?.let { Messenger.clock(it, zone) } ?: ""
    attachment = Core.map(next["attachment"]) ?: emptyMap()
    if (attachment.isEmpty()) kind = "" else {
      com.linea.messenger.attachments.AttachmentStore.remember(key, attachment)
      kind = when (com.linea.messenger.voice.MediaRows.kind(attachment)) { "voice" -> "voice"; "note" -> "note"; else -> "card" }
      fileKind = FileCore.describe(attachment).kind
    }
    val picture = Core.map(attachment["preview"])?.get("base64") as? String ?: ""
    if (picture != posterOf) {
      posterOf = picture
      poster = if (picture.isEmpty()) null else try { Base64.decode(picture, Base64.DEFAULT).let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) } } catch (_: Throwable) { null }
    }
    laidWidth = -1
    val lineWords = if (attachment.isEmpty()) "" else SavedMessages.line(next).first
    contentDescription = listOf(originWords, words.ifEmpty { lineWords.ifEmpty { "Запись" } }, (if (edited) "изм. " else "") + timeWords).filter { it.isNotEmpty() }.joinToString(", ")
    requestLayout()
    invalidate()
  }

  fun redraw(next: MsgMediaState?) { state = next; invalidate() }

  /** Where a round video stands in this view (null: none). */
  fun noteBox(): android.graphics.RectF? = if (kind == "note" && !media.isEmpty) android.graphics.RectF(media) else null

  /** linkify.tsx / format/markdown.ts `URL_RE`: the addresses in the words (their places and where each leads),
   *  drawn in the text's own colour, underlined. */
  private fun links(): List<Pair<IntRange, String>> = URL_RE.findAll(words).map { match ->
    val raw = match.groupValues[1]
    val range = match.groups[1]!!.range
    Pair(range, if (raw.startsWith("http://", true) || raw.startsWith("https://", true)) raw else "https://$raw")
  }.toList()

  /** The part under a point: "play", "wave", "rate", "thumb" (a round video), "card" or "link:<address>". */
  fun part(x: Float, y: Float): String? {
    if (checked != null) return null
    textLayout?.let { layout ->
      val lx = x - textAt.x; val ly = y - textAt.y
      if (lx >= -4f * d && ly >= -4f * d && lx <= layout.width + 4f * d && ly <= layout.height + 4f * d) {
        val line = layout.getLineForVertical(ly.toInt().coerceAtLeast(0))
        if (lx <= layout.getLineWidth(line) + 4f * d) {
          val offset = layout.getOffsetForHorizontal(line, lx)
          links().firstOrNull { offset in it.first }?.let { return "link:" + it.second }
        }
      }
    }
    if (kind == "voice") return boxes.part(x, y, d)?.first
    if (kind == "note" && media.contains(x, y)) return "thumb"
    if (kind == "card" && media.contains(x, y)) return "card"
    return null
  }

  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) { downX = event.x; downY = event.y }
    return super.dispatchTouchEvent(event)
  }

  private fun cardSize(room: Float): Pair<Float, Float> {
    if (visual) return Pair(230f * d, 190f * d)
    val width = minOf(270f * d, maxOf(180f * d, room))
    val nameRoom = (width - (42f + 10f + 10f + 17f) * d).toInt().coerceAtLeast(1)
    small.textSize = 14f * d; small.typeface = Theme.weight(600)
    val name = android.text.StaticLayout.Builder.obtain(attachment["name"] as? String ?: "", 0, (attachment["name"] as? String ?: "").length, small, nameRoom).setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).build()
    small.textSize = 12f * d; small.typeface = Theme.weight(400)
    val column = name.height + 4f * d + (small.descent() - small.ascent())
    return Pair(width, maxOf(46f * d, column) + 14f * d)
  }

  private fun lay(width: Int) {
    if (width == laidWidth) return
    laidWidth = width
    val left = (if (checked == null) 15f else 45f) * d
    val room = (width - left - 15f * d) * 0.85f
    val pad = if (plated) 12f * d else 0f
    val inner = maxOf(40f * d, room - 2 * pad)
    var y = if (circleOnly) 0f else if (kind.isEmpty()) 11f * d else 7f * d
    var contentWidth = 0f
    originRect.setEmpty(); media.setEmpty(); timeRect.setEmpty(); originLayout = null; textLayout = null; timeInline = false
    if (originWords.isNotEmpty()) {
      originPaint.textSize = 11f * d; originPaint.typeface = Theme.weight(600); originPaint.color = Theme.accent
      val made = android.text.StaticLayout.Builder.obtain(originWords, 0, originWords.length, originPaint, inner.toInt()).setIncludePad(false).build()
      originLayout = made
      var widest = 0f
      for (index in 0 until made.lineCount) widest = maxOf(widest, made.getLineWidth(index))
      originRect.set(0f, y, Math.ceil(widest.toDouble()).toFloat(), y + made.height)
      y += made.height + 4f * d
      contentWidth = maxOf(contentWidth, originRect.width())
    }
    if (kind.isNotEmpty()) {
      val size = when (kind) {
        "voice" -> Pair(minOf(inner, com.linea.messenger.voice.MediaRowArt.voiceWidth * d), com.linea.messenger.voice.MediaRowArt.voiceHeight * d)
        "note" -> {
          // playback.ts `noteSizes`: 212 in the row (never past it), min(404, the row) while it is listened to.
          val room = Math.floor(maxSide.toDouble()).toFloat()
          val collapsed = minOf(212f * d, room)
          val side = if (expanded) maxOf(collapsed, minOf(404f * d, room)) else collapsed
          Pair(side, side)
        }
        else -> cardSize(inner)
      }
      media.set(0f, y, size.first, y + size.second)
      y += size.second + (if (words.isEmpty()) 1f else 7f) * d
      contentWidth = maxOf(contentWidth, size.first)
    }
    small.textSize = 9f * d; small.typeface = Theme.weight(400)
    val timeText = (if (edited) "изм. " else "") + timeWords
    val timeW = Math.ceil(small.measureText(timeText).toDouble()).toFloat()
    val timeH = small.descent() - small.ascent()
    var textLeft = 0f
    if (words.isNotEmpty()) {
      val (size, lineHeight) = metrics
      textPaint.textSize = size * d; textPaint.typeface = Theme.weight(400); textPaint.color = Theme.text
      val natural = textPaint.fontMetrics.let { it.descent - it.ascent }
      val spanned = android.text.SpannableString(words)
      for (link in links()) spanned.setSpan(android.text.style.UnderlineSpan(), link.first.first, link.first.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      val made = android.text.StaticLayout.Builder.obtain(spanned, 0, spanned.length, textPaint, inner.toInt()).setIncludePad(false)
        .setLineSpacing(lineHeight * d - natural, 1f).build()
      textLayout = made
      var widest = 0f
      for (index in 0 until made.lineCount) widest = maxOf(widest, made.getLineWidth(index))
      val textW = Math.ceil(widest.toDouble()).toFloat()
      val textH = made.lineCount * lineHeight * d
      contentWidth = maxOf(contentWidth, textW)
      // The open look: the time follows the last word when it fits on that line.
      val last = made.getLineWidth(made.lineCount - 1)
      if (!plated && last + 8f * d + timeW <= inner) {
        timeInline = true
        timeRect.set(last + 8f * d, y + textH - timeH - 3f * d, last + 8f * d + timeW, y + textH - 3f * d)
        contentWidth = maxOf(contentWidth, timeRect.right)
      }
      textAt.set(0f, y)
      y += textH
      textLeft = textW
    }
    if (circleOnly) {
      small.textSize = 11f * d
      val pillW = Math.ceil(small.measureText(timeWords).toDouble()).toFloat() + 16f * d
      val pillH = (small.descent() - small.ascent()) + 6f * d
      timeRect.set(0f, y + 3f * d, pillW, y + 3f * d + pillH)
      y += 3f * d + pillH
      contentWidth = maxOf(contentWidth, pillW)
    } else if (!timeInline) {
      timeRect.set(0f, y + 4f * d, timeW, y + 4f * d + timeH)
      y += 4f * d + timeH
      contentWidth = maxOf(contentWidth, timeW)
    }
    if (!circleOnly) y += 7f * d
    val boxWidth = maxOf(if (circleOnly) 0f else 74f * d, contentWidth + 2 * pad)
    val boxLeft = width - 15f * d - boxWidth
    boxRect.set(boxLeft, 0f, boxLeft + boxWidth, y)
    val right = boxRect.right - pad
    fun shift(rect: android.graphics.RectF) { if (!rect.isEmpty) rect.offsetTo(right - rect.width(), rect.top) }
    shift(originRect); shift(media)
    if (textLayout != null) {
      val block = maxOf(textLeft, if (timeInline) timeRect.right else 0f)
      val start = right - block
      textAt.set(start, textAt.y)
      if (timeInline) timeRect.offset(start, 0f) else shift(timeRect)
    } else shift(timeRect)
    laidHeight = Math.ceil(y.toDouble()).toInt() + Math.round(8f * d)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    lay(width)
    setMeasuredDimension(width, laidHeight)
  }

  private fun glyph(canvas: android.graphics.Canvas, name: String, cx: Float, cy: Float, size: Float, color: Int) =
    com.linea.messenger.design.IonIcon.draw(canvas, name, cx, cy, size * d, color)

  override fun onDraw(canvas: android.graphics.Canvas) {
    lay(width)
    checked?.let { on ->
      // SavedScreen.tsx: checkmark-circle / ellipse-outline, 24 dp, accent / subtle.
      glyph(canvas, if (on) "checkmark-circle" else "ellipse-outline", 30f * d, height / 2f, 24f, if (on) Theme.accent else Theme.subtle)
    }
    if (plated) {
      // SavedScreen.tsx: t.bubble, radius 23 (8 at the lower right), a 1 dp border.
      val inset = 0.5f * d
      val path = android.graphics.Path()
      val r = 23f * d; val s = 8f * d
      path.addRoundRect(boxRect.left + inset, boxRect.top + inset, boxRect.right - inset, boxRect.bottom - inset, floatArrayOf(r, r, r, r, s, s, r, r), android.graphics.Path.Direction.CW)
      fill.color = ThemeStore.look.bubble
      canvas.drawPath(path, fill)
      line.color = if (Theme.dark) 0x409DB6FF else 0xD4FFFFFF.toInt()
      line.strokeWidth = 1f * d
      canvas.drawPath(path, line)
    }
    originLayout?.let { canvas.save(); canvas.translate(originRect.left, originRect.top); it.draw(canvas); canvas.restore() }
    boxes.clear()
    when (kind) {
      "voice" -> {
        val mediaInfo = Core.map(attachment["media"])
        val row = com.linea.messenger.chat.MsgRow.parse(listOf(mapOf("key" to key, "kind" to 0, "mine" to true, "media" to "voice", "wave" to (mediaInfo?.get("waveform") as? String ?: ""),
          "mediaTime" to (FileCore.call("voiceTime", listOf((mediaInfo?.get("durationMs") as? Number)?.toDouble() ?: 0.0)) as? String ?: "")))).firstOrNull()
        if (row != null) com.linea.messenger.voice.MediaRowArt.voice(canvas, row, state, Theme.messages, media.left, media.top, media.width(), d, boxes)
      }
      "note" -> drawNote(canvas)
      "card" -> drawCard(canvas)
    }
    textLayout?.let { canvas.save(); canvas.translate(textAt.x, textAt.y); it.draw(canvas); canvas.restore() }
    if (circleOnly) {
      fill.color = if (Theme.dark) 0x73000000 else 0x52000000
      canvas.drawRoundRect(timeRect, 10f * d, 10f * d, fill)
      small.textSize = 11f * d; small.typeface = Theme.weight(400); small.color = 0xFFFFFFFF.toInt()
      canvas.drawText(timeWords, timeRect.centerX() - small.measureText(timeWords) / 2, timeRect.centerY() - (small.ascent() + small.descent()) / 2, small)
    } else {
      small.textSize = 9f * d; small.typeface = Theme.weight(400); small.color = Theme.muted
      canvas.drawText((if (edited) "изм. " else "") + timeWords, timeRect.left, timeRect.top - small.ascent(), small)
    }
  }

  /** VideoNoteBubble at rest: the poster in its circle (or the placeholder), and the marks of a chat's circle. */
  private fun drawNote(canvas: android.graphics.Canvas) {
    val picture = poster
    if (picture != null && picture.width > 0 && picture.height > 0) {
      canvas.save()
      val clip = android.graphics.Path().apply { addOval(media, android.graphics.Path.Direction.CW) }
      canvas.clipPath(clip)
      fill.color = Theme.surface2
      canvas.drawRect(media, fill)
      val scale = maxOf(media.width() / picture.width, media.height() / picture.height)
      val w = picture.width * scale; val h = picture.height * scale
      canvas.drawBitmap(picture, null, android.graphics.RectF(media.centerX() - w / 2, media.centerY() - h / 2, media.centerX() + w / 2, media.centerY() + h / 2), fill)
      canvas.restore()
    } else com.linea.messenger.voice.MediaRowArt.plate(canvas, true, Theme.messages, media, d)
    if (!com.linea.messenger.video.NotePlayback.hostedKeys.contains(key)) com.linea.messenger.voice.MediaRowArt.noteMarks(canvas, key, duration, state, media, d)
  }

  /** components.tsx AttachmentCard. */
  private fun drawCard(canvas: android.graphics.Canvas) {
    val size = FileCore.sizeText((attachment["size"] as? Number)?.toLong() ?: 0L)
    val icon = when (fileKind) { "photo" -> "image-outline"; "video" -> "videocam-outline"; "audio" -> "musical-notes-outline"; else -> "document-outline" }
    if (visual) {
      canvas.save()
      val clip = android.graphics.Path().apply { addRoundRect(media, 16f * d, 16f * d, android.graphics.Path.Direction.CW) }
      canvas.clipPath(clip)
      fill.color = Theme.surface2
      canvas.drawRect(media, fill)
      val picture = poster
      if (picture != null && picture.width > 0 && picture.height > 0) {
        val scale = maxOf(media.width() / picture.width, media.height() / picture.height)
        val w = picture.width * scale; val h = picture.height * scale
        canvas.drawBitmap(picture, null, android.graphics.RectF(media.centerX() - w / 2, media.centerY() - h / 2, media.centerX() + w / 2, media.centerY() + h / 2), fill)
      } else glyph(canvas, icon, media.centerX(), media.centerY(), 46f, Theme.muted)
      fill.color = 0x9E0A1423.toInt()
      canvas.drawCircle(media.centerX(), media.centerY(), 23f * d, fill)
      glyph(canvas, if (fileKind == "video") "play" else "arrow-down", media.centerX(), media.centerY(), 24f, 0xFFFFFFFF.toInt())
      // Two labels at the foot: «12 МБ · загрузить» at the left, the length at the right (7 × 4 inside, radius 8).
      small.textSize = 11f * d; small.typeface = Theme.weight(400); small.color = 0xFFFFFFFF.toInt()
      fun label(text: String, alignRight: Boolean) {
        val w = Math.ceil(small.measureText(text).toDouble()).toFloat() + 14f * d
        val h = (small.descent() - small.ascent()) + 8f * d
        val l = if (alignRight) media.right - 10f * d - w else media.left + 10f * d
        val frame = android.graphics.RectF(l, media.bottom - 9f * d - h, l + w, media.bottom - 9f * d)
        fill.color = 0xAD0A1423.toInt()
        canvas.drawRoundRect(frame, 8f * d, 8f * d, fill)
        canvas.drawText(text, frame.left + 7f * d, frame.centerY() - (small.ascent() + small.descent()) / 2, small)
      }
      label("$size · загрузить", false)
      if (duration.isNotEmpty()) label(duration, true)
      canvas.restore()
      return
    }
    // The file line: a 42 × 46 plate (radius 15, accentSoft, a 1 dp glassBorder) with the accent glyph, the name
    // (14 semibold, two lines) over «size · открыть» (12 muted), and the arrow at the end.
    val plate = android.graphics.RectF(media.left, media.centerY() - 23f * d, media.left + 42f * d, media.centerY() + 23f * d)
    val inset = 0.5f * d
    fill.color = ThemeStore.look.accentSoft
    canvas.drawRoundRect(plate.left + inset, plate.top + inset, plate.right - inset, plate.bottom - inset, 14.5f * d, 14.5f * d, fill)
    line.color = ThemeStore.look.glassBorder; line.strokeWidth = 1f * d
    canvas.drawRoundRect(plate.left + inset, plate.top + inset, plate.right - inset, plate.bottom - inset, 14.5f * d, 14.5f * d, line)
    glyph(canvas, icon, plate.centerX(), plate.centerY(), 22f, Theme.accent)
    val textX = plate.right + 10f * d
    val textWidth = (media.right - 10f * d - 17f * d - textX).toInt().coerceAtLeast(1)
    small.textSize = 14f * d; small.typeface = Theme.weight(600); small.color = Theme.text
    val nameText = attachment["name"] as? String ?: ""
    val name = android.text.StaticLayout.Builder.obtain(nameText, 0, nameText.length, small, textWidth).setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).setIncludePad(false).build()
    val sub = android.text.TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * d; typeface = Theme.weight(400); color = Theme.muted }
    val column = name.height + 4f * d + (sub.descent() - sub.ascent())
    val top = media.centerY() - column / 2
    canvas.save(); canvas.translate(textX, top); name.draw(canvas); canvas.restore()
    val subWords = TextUtils.ellipsize(size + (if (duration.isEmpty()) "" else " · $duration") + " · открыть", sub, textWidth.toFloat(), TextUtils.TruncateAt.END).toString()
    canvas.drawText(subWords, textX, top + name.height + 4f * d - sub.ascent(), sub)
    glyph(canvas, if (fileKind == "audio") "play" else "arrow-down-outline", media.right - 8.5f * d, media.centerY(), 17f, Theme.muted)
  }
}
