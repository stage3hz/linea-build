package com.linea.messenger.chatsplus

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Live
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsPage
import com.linea.messenger.settings.SettingsRow
import com.linea.messenger.settings.ThemeStore

/** ChatsPlus: chat folders (the reference's ChatFolders.tsx and SettingsScreen.tsx `FoldersSection`): tabs above
 *  the chat list — «Все», then the person's own folders made of chosen chats —, a sideways swipe over the list that
 *  walks them, and the editor. Folders are kept on this device only: the server does not learn how chats are
 *  grouped. No bar at all until a folder exists (made in Настройки → Папки с чатами, or from a tab's long press)
 *  (native/ios/Sources/ChatsPlus/ChatFolders.swift). */
data class ChatFolder(val id: String, val name: String, val chatIds: List<String>)

/** One shared copy per account: the chat list's tabs and the settings page stay in step. Main thread. */
class ChatFolderStore private constructor(private val context: Context?, userId: String) {
  private val key = "linea.folders.v1:$userId"
  /** The sample list (no account) keeps its folders in memory only. */
  private val kept = userId != "sample" && context != null
  var folders: List<ChatFolder> = emptyList()
    private set

  init {
    // The reference's AsyncStorage entry, here in the app's own preferences; a broken entry is ignored.
    if (kept) folders = parse(prefs()?.getString(key, null))
  }

  private fun prefs() = context?.applicationContext?.getSharedPreferences("chatsplus", Context.MODE_PRIVATE)

  private fun save(next: List<ChatFolder>) {
    folders = next
    if (kept) Core.text(next.map { mapOf("id" to it.id, "name" to it.name, "chatIds" to it.chatIds) })?.let { prefs()?.edit()?.putString(key, it)?.apply() }
    changed.post(Unit)
  }

  fun upsert(folder: ChatFolder) {
    save(if (folders.any { it.id == folder.id }) folders.map { if (it.id == folder.id) folder else it } else folders + folder)
  }

  fun remove(id: String) = save(folders.filter { it.id != id })

  /** The reference lets a folder move one place up or down. */
  fun move(id: String, delta: Int) {
    val list = folders.toMutableList()
    val from = list.indexOfFirst { it.id == id }
    val to = from + delta
    if (from < 0 || to < 0 || to >= list.size) return
    val moved = list[from]; list[from] = list[to]; list[to] = moved
    save(list)
  }

  /** The reference's `folderTabIds`: «Все», then the folders. */
  val tabIds: List<String> get() = listOf("all") + folders.map { it.id }

  /** The reference's `matchesFolder` (`unread`: chats marked unread by hand count as unread). */
  fun matches(chatId: String, unread: Boolean, filter: String): Boolean = when (filter) {
    "all" -> true
    "unread" -> unread
    else -> folders.firstOrNull { it.id == filter }?.chatIds?.contains(chatId) ?: false
  }

  companion object {
    val changed = Live.Signal<Unit>()
    private val byAccount = HashMap<String, ChatFolderStore>()

    fun of(context: Context?, userId: String): ChatFolderStore = byAccount.getOrPut(userId) { ChatFolderStore(context, userId) }

    /** The kept entry: at most 20 folders; anything malformed is left out. */
    fun parse(raw: String?): List<ChatFolder> = (Core.value(raw) as? List<*>).orEmpty().mapNotNull { item ->
      val fields = Core.map(item) ?: return@mapNotNull null
      val id = fields["id"] as? String ?: return@mapNotNull null
      val name = fields["name"] as? String ?: return@mapNotNull null
      val ids = fields["chatIds"] as? List<*> ?: return@mapNotNull null
      ChatFolder(id, name, ids.mapNotNull { it as? String })
    }.take(20)

    /** A new folder's id, as the reference makes it: «f» and the time in base 36. */
    fun newId(now: Long = System.currentTimeMillis()): String = "f" + java.lang.Long.toString(now, 36)
  }
}

/** The bar of folder tabs: one glass bar across the screen; tabs share it equally while they fit (up to four tabs
 *  with short names), else it scrolls. The chosen tab is a grey capsule that slides — with the finger while the list
 *  is being swiped. */
@SuppressLint("ViewConstructor")
class FolderTabsView(context: Context) : HorizontalScrollView(context) {
  var onChange: ((String) -> Unit)? = null
  var onEdit: ((ChatFolder) -> Unit)? = null
  private val d = resources.displayMetrics.density
  private class Tab(val id: String, val label: String, val folder: ChatFolder?)
  private var tabs: List<Tab> = emptyList()
  var filter = "all"
    private set
  /** The fractional index of the shown tab (the list drives it while a swipe is on). */
  private var position = 0f
  private var fits = true
  private var settle: ValueAnimator? = null
  private val strip = Strip(context)

  init {
    isHorizontalScrollBarEnabled = false
    overScrollMode = OVER_SCROLL_NEVER
    isFillViewport = true
    addView(strip, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
    paint()
  }

  fun paint() {
    background = context.plate(if (Theme.dark) 0x1AFFFFFF else 0xB8FFFFFF.toInt(), 20f, Theme.veil(0.1f))
    clipToOutline = true
    for (index in 0 until strip.childCount) (strip.getChildAt(index) as? TextView)?.setTextColor(Theme.text)
    strip.invalidate()
  }

  fun set(folders: List<ChatFolder>, filter: String) {
    val next = listOf(Tab("all", "Все", null)) + folders.map { Tab(it.id, it.name, it) }
    val same = next.map { it.id + "|" + it.label } == tabs.map { it.id + "|" + it.label }
    tabs = next
    if (!same) {
      strip.removeAllViews()
      next.forEachIndexed { index, tab ->
        val button = context.words(tab.label, 14f, Theme.text, 600)
        button.gravity = Gravity.CENTER
        button.maxLines = 1
        button.ellipsize = TextUtils.TruncateAt.END
        button.setPadding(context.px(12f), 0, context.px(12f), 0)
        button.isClickable = true
        button.isFocusable = true
        button.setOnClickListener {
          it.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          tabs.getOrNull(index)?.let { chosen -> onChange?.invoke(chosen.id) }
        }
        button.setOnLongClickListener {
          val folder = tabs.getOrNull(index)?.folder ?: return@setOnLongClickListener false
          it.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
          onEdit?.invoke(folder)
          true
        }
        strip.addView(button)
      }
      fits = next.size <= 4 && next.sumOf { it.label.length } <= 28
    }
    this.filter = filter
    position = maxOf(0, next.indexOfFirst { it.id == filter }).toFloat()
    for (index in 0 until strip.childCount) {
      val on = tabs.getOrNull(index)?.id == filter
      strip.getChildAt(index).isSelected = on
      strip.getChildAt(index).contentDescription = (tabs.getOrNull(index)?.label ?: "") + if (on) ", выбрано" else ""
    }
    requestLayout()
    strip.invalidate()
  }

  /** The highlight follows a swipe: `value` is the fractional index of the shown tab. */
  fun follow(value: Float, animated: Boolean) {
    settle?.cancel()
    if (!animated) { position = value; strip.invalidate(); scrollToCapsule(); return }
    settle = ValueAnimator.ofFloat(position, value).apply {
      duration = 220; interpolator = DecelerateInterpolator()
      addUpdateListener { position = it.animatedValue as Float; strip.invalidate() }
      start()
    }
  }

  private fun scrollToCapsule() {
    if (fits) return
    val child = strip.getChildAt(maxOf(0, Math.round(position))) ?: return
    val wanted = (child.left - (40 * d).toInt()).coerceIn(0, maxOf(0, strip.width - width))
    if (Math.abs(scrollX - wanted) > 1) smoothScrollTo(wanted, 0)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    strip.wide = if (fits) MeasureSpec.getSize(widthMeasureSpec) else 0
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  /** The tabs in a row, and the capsule under the chosen one. */
  private inner class Strip(context: Context) : ViewGroup(context) {
    var wide = 0
    private val capsule = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    init { setWillNotDraw(false) }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
      val h = MeasureSpec.getSize(heightSpec)
      val tall = MeasureSpec.makeMeasureSpec((32 * d).toInt(), MeasureSpec.EXACTLY)
      var total = (4 * d).toInt()
      if (wide > 0 && childCount > 0) {
        val each = ((wide - 8 * d - (childCount - 1) * 2 * d) / childCount).toInt()
        for (index in 0 until childCount) getChildAt(index).measure(MeasureSpec.makeMeasureSpec(each, MeasureSpec.EXACTLY), tall)
        total = wide
      } else {
        for (index in 0 until childCount) {
          val child = getChildAt(index)
          child.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), tall)
          total += child.measuredWidth + (2 * d).toInt()
        }
        total += (2 * d).toInt()
      }
      setMeasuredDimension(total, h)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      var x = (4 * d).toInt()
      val top = ((b - t) - (32 * d).toInt()) / 2
      for (index in 0 until childCount) {
        val child = getChildAt(index)
        child.layout(x, top, x + child.measuredWidth, top + child.measuredHeight)
        x += child.measuredWidth + (2 * d).toInt()
      }
    }

    override fun onDraw(canvas: Canvas) {
      if (childCount == 0) return
      val p = position.coerceIn(0f, (childCount - 1).toFloat())
      val i = p.toInt(); val f = p - i
      val a = getChildAt(i); val b = getChildAt(minOf(i + 1, childCount - 1))
      val left = a.left + (b.left - a.left) * f
      val width = a.width + (b.width - a.width) * f
      capsule.color = if (Theme.dark) 0x29FFFFFF else 0x14141E3C
      canvas.drawRoundRect(left, a.top.toFloat(), left + width, a.bottom.toFloat(), 16 * d, 16 * d, capsule)
      line.color = if (Theme.dark) 0x1AFFFFFF else 0x14141E3C
      line.strokeWidth = maxOf(1f, d / 2)
      canvas.drawRoundRect(left, a.top.toFloat(), left + width, a.bottom.toFloat(), 16 * d, 16 * d, line)
    }
  }
}

/** A chat as the folder editor lists it. */
class FolderChat(val id: String, val title: String, val avatarColor: Int, val initials: String, val avatarUrl: String, val avatarKey: String) {
  constructor(summary: Messenger.ChatSummary) : this(summary.id, summary.title, (summary.row["avatarColor"] as? Number)?.toInt() ?: 0xFF5E7BFF.toInt(),
    summary.row["initials"] as? String ?: Messenger.initials(summary.title), summary.row["avatarUrl"] as? String ?: "", summary.row["avatarKey"] as? String ?: "")
}

/** A small round avatar: the person's picture when it is here, else their initials on their colour. */
class SmallAvatarView(context: Context) : View(context) {
  private var chat: FolderChat? = null
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val letters = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; color = Color.WHITE; typeface = Theme.weight(700) }
  private val clip = android.graphics.Path()

  fun show(chat: FolderChat) { this.chat = chat; invalidate() }

  override fun onDraw(canvas: Canvas) {
    val chat = chat ?: return
    val side = minOf(width, height).toFloat()
    val cx = width / 2f; val cy = height / 2f
    val face = if (chat.avatarKey.isNotEmpty() && chat.avatarUrl.isNotEmpty()) AvatarStore.get(context, chat.avatarKey, chat.avatarUrl, this) else null
    if (face != null && face.width > 0 && face.height > 0) {
      clip.reset(); clip.addCircle(cx, cy, side / 2, android.graphics.Path.Direction.CW)
      canvas.save(); canvas.clipPath(clip)
      val scale = maxOf(side / face.width, side / face.height)
      val w = face.width * scale; val h = face.height * scale
      canvas.drawBitmap(face, null, android.graphics.RectF(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2), paint)
      canvas.restore()
      return
    }
    paint.color = 0xFF000000.toInt() or (chat.avatarColor and 0xFFFFFF)
    canvas.drawCircle(cx, cy, side / 2, paint)
    letters.textSize = side * 0.36f
    canvas.drawText(chat.initials, cx, cy - (letters.descent() + letters.ascent()) / 2, letters)
  }
}

/** «Новая папка» / «Папка»: a name and the chats in it; «Удалить папку» for one that exists. */
class FolderEditor(context: Context, private val folder: ChatFolder?, private val chats: List<FolderChat>) : Dialog(context) {
  var onSave: ((ChatFolder) -> Unit)? = null
  var onDelete: ((String) -> Unit)? = null
  private val picked = ArrayList(folder?.chatIds ?: emptyList())
  private val nameField = EditText(context)
  private val save = LinearLayout(context)
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  private val adapter = object : BaseAdapter() {
    override fun getCount() = chats.size
    override fun getItem(position: Int) = chats[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val row = convertView as? FolderChatRow ?: FolderChatRow(context)
      val chat = chats[position]
      row.show(chat, picked.contains(chat.id))
      return row
    }
  }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val page = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Theme.bg)
      setPadding(0, dp(12f), 0, dp(12f))
    }
    val head = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    head.addView(context.words(if (folder == null) "Новая папка" else "Папка", 18f, Theme.text, 700), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(20f) })
    val close = PlusIconView(context, "xmark", 15f, Theme.muted).apply { contentDescription = "Закрыть"; isClickable = true; setOnClickListener { dismiss() } }
    head.addView(close, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { rightMargin = dp(8f) })
    page.addView(head, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48f)))
    nameField.setText(folder?.name ?: "")
    nameField.hint = "Название, например «Работа»"
    nameField.setHintTextColor(Theme.muted)
    nameField.setTextColor(Theme.text)
    nameField.textSize = 15f
    nameField.typeface = Theme.weight(400)
    nameField.isSingleLine = true
    // maxLength 24, as in the reference.
    nameField.filters = arrayOf(InputFilter.LengthFilter(24))
    nameField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    nameField.imeOptions = EditorInfo.IME_ACTION_DONE
    nameField.background = context.plate(Theme.surface2, 14f, ThemeStore.look.border)
    nameField.setPadding(dp(14f), 0, dp(14f), 0)
    nameField.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) { refresh() }
    })
    page.addView(nameField, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(46f)).apply { leftMargin = dp(16f); rightMargin = dp(16f); topMargin = dp(6f) })
    val caption = context.words("ЧАТЫ В ПАПКЕ", 11f, Theme.muted, 700).apply { letterSpacing = 0.11f }
    page.addView(caption, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(18f); topMargin = dp(14f); bottomMargin = dp(6f) })
    val list = ListView(context).apply {
      divider = null; dividerHeight = 0; selector = ColorDrawable(Color.TRANSPARENT); isVerticalScrollBarEnabled = false
      this.adapter = this@FolderEditor.adapter
      setOnItemClickListener { view, _, position, _ ->
        val id = chats.getOrNull(position)?.id ?: return@setOnItemClickListener
        if (picked.contains(id)) picked.remove(id) else picked.add(id)
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        this@FolderEditor.adapter.notifyDataSetChanged()
        refresh()
      }
    }
    page.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    save.orientation = LinearLayout.HORIZONTAL
    save.gravity = Gravity.CENTER
    save.background = context.plate(Theme.accent, 24f)
    save.addView(PlusIconView(context, "folder", 15f, Theme.onAccent), LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { rightMargin = dp(8f) })
    save.addView(context.words("Сохранить", 16f, Theme.onAccent, 600))
    save.isClickable = true
    save.contentDescription = "Сохранить"
    save.setOnClickListener { saved() }
    page.addView(save, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48f)).apply { leftMargin = dp(16f); rightMargin = dp(16f); topMargin = dp(10f) })
    if (folder != null) {
      val remove = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; isClickable = true
        contentDescription = "Удалить папку. Чаты останутся во «Всех»"
        addView(PlusIconView(context, "trash", 15f, Theme.danger), LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { rightMargin = dp(8f) })
        addView(context.words("Удалить папку", 15f, Theme.danger, 600))
        setOnClickListener { dismiss(); onDelete?.invoke(folder.id) }
      }
      page.addView(remove, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44f)).apply { topMargin = dp(6f) })
    }
    setContentView(page)
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Theme.bg))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
    refresh()
  }

  private val ready: Boolean get() = nameField.text.toString().trim().isNotEmpty() && picked.isNotEmpty()

  private fun refresh() {
    save.isEnabled = ready
    save.alpha = if (ready) 1f else 0.45f
  }

  private fun saved() {
    if (!ready) return
    val made = ChatFolder(folder?.id ?: ChatFolderStore.newId(), nameField.text.toString().trim(), picked.toList())
    dismiss()
    onSave?.invoke(made)
  }

  override fun show() {
    last = java.lang.ref.WeakReference(this)
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  companion object {
    /** The editor on the screen now, if any (for the checks). */
    var last: java.lang.ref.WeakReference<FolderEditor>? = null
  }
}

/** A chat of the folder editor: avatar, name, a ticked or empty circle. */
@SuppressLint("ViewConstructor")
private class FolderChatRow(context: Context) : LinearLayout(context) {
  private val avatar = SmallAvatarView(context)
  private val name = context.words("", 15f, Theme.text)
  private val mark = PlusIconView(context, "circle", 22f, Theme.subtle)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    layoutParams = android.widget.AbsListView.LayoutParams(android.widget.AbsListView.LayoutParams.MATCH_PARENT, context.px(50f))
    setPadding(context.px(16f), 0, context.px(16f), 0)
    addView(avatar, LayoutParams(context.px(38f), context.px(38f)))
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    addView(name, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f); rightMargin = context.px(8f) })
    addView(mark, LayoutParams(context.px(28f), context.px(28f)))
  }

  fun show(chat: FolderChat, on: Boolean) {
    avatar.show(chat)
    name.text = chat.title
    mark.symbol = if (on) "circle.fill.check" else "circle"
    mark.color = if (on) Theme.accent else Theme.subtle
    mark.invalidate()
    contentDescription = chat.title + ", " + if (on) "в папке" else "не в папке"
  }
}

/** Настройки → «Папки с чатами»: the folders, each one place up or down, «Создать папку», and the words that folders
 *  stay on this device. */
@SuppressLint("ViewConstructor")
class FoldersSettingsPage(context: Context, private val messenger: Messenger?) : SettingsPage(context, "Папки с чатами") {
  private var chats: List<FolderChat> = emptyList()
  private val store: ChatFolderStore get() = ChatFolderStore.of(context, messenger?.userId ?: "sample")
  private val foldersChanged: (Unit) -> Unit = { if (built) build() }

  init {
    messenger?.chats { result -> result.getOrNull()?.let { list -> post { chats = list.map { FolderChat(it) } } } }
    if (messenger == null) chats = ChatsPlusDemo.sampleFolderChats()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ChatFolderStore.changed.watch(foldersChanged)
  }

  override fun onDetachedFromWindow() {
    ChatFolderStore.changed.unwatch(foldersChanged)
    super.onDetachedFromWindow()
  }

  override fun build() {
    clear()
    val list = store.folders
    val rows = ArrayList<View>()
    if (list.isEmpty()) {
      rows.add(SettingsLook.inset(context.words("Папок пока нет. Создай папку — она появится вкладкой над списком чатов.", 13f, Theme.muted), top = 16f, side = 16f, bottom = 16f))
    } else {
      list.forEachIndexed { index, folder ->
        rows.add(FolderSettingsRow(context, folder, index == 0, index == list.size - 1, onOpen = { edit(folder) }, onMove = { store.move(folder.id, it) }))
      }
    }
    addGroup("Мои папки", rows)
    // The reference's `Item` (SettingsScreen.tsx): the Ionicons «add» and the chevron every row but a dangerous one has.
    val create = SettingsRow(context, symbol = "ion:add", label = "Создать папку")
    create.onPress = { edit(null) }
    addGroup(rows = listOf(create))
    add(SettingsLook.foot(context, "Папки хранятся только на этом устройстве; сервер не знает, как ты группируешь чаты."), 8f) // SettingsScreen.tsx: plain muted words (12), not a caption
  }

  fun edit(folder: ChatFolder?) {
    val editor = FolderEditor(context, folder, chats)
    editor.onSave = { store.upsert(it) }
    editor.onDelete = { store.remove(it) }
    editor.show()
  }
}

/** One folder on the settings page: its name and the number of chats, ▲ and ▼. */
@SuppressLint("ViewConstructor")
private class FolderSettingsRow(context: Context, folder: ChatFolder, first: Boolean, last: Boolean, onOpen: () -> Unit, onMove: (Int) -> Unit) : LinearLayout(context) {
  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.px(54f)
    setPadding(context.px(14f), 0, context.px(6f), 0)
    addView(PlusIconView(context, "folder", 19f, Theme.accent), LayoutParams(context.px(24f), context.px(24f)).apply { rightMargin = context.px(12f) })
    val words = LinearLayout(context).apply { orientation = VERTICAL }
    words.addView(context.words(folder.name, 15f, Theme.text, 600).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    words.addView(context.words(folder.chatIds.size.toString(), 12f, Theme.muted).apply { setPadding(0, context.px(3f), 0, 0) })
    addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    val up = PlusIconView(context, "chevron.up", 15f, Theme.muted).apply {
      contentDescription = "Выше"; isClickable = !first; isEnabled = !first; alpha = if (first) 0.3f else 1f
      setOnClickListener { onMove(-1) }
    }
    val down = PlusIconView(context, "chevron.down", 15f, Theme.muted).apply {
      contentDescription = "Ниже"; isClickable = !last; isEnabled = !last; alpha = if (last) 0.3f else 1f
      setOnClickListener { onMove(1) }
    }
    addView(up, LayoutParams(context.px(36f), context.px(36f)))
    addView(down, LayoutParams(context.px(36f), context.px(36f)))
    isClickable = true
    isFocusable = true
    contentDescription = folder.name + ", чатов: " + folder.chatIds.size
    setOnClickListener { onOpen() }
  }
}
