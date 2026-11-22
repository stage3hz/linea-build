package com.linea.messenger.chatsplus

import android.content.Context
import android.content.res.ColorStateList
import android.provider.Settings
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.chats.ChatListView
import com.linea.messenger.chats.ChatRow
import com.linea.messenger.design.Theme
import com.linea.messenger.design.titled
import com.linea.messenger.design.words
import com.linea.messenger.net.Live
import com.linea.messenger.net.ServerError
import com.linea.messenger.people.openChat
import com.linea.messenger.people.pages
import com.linea.messenger.shell.ScrollEdgeView
import java.time.Instant
import java.time.ZoneId

/** ChatsPlus: what the reference's chat list (ChatListScreen.tsx) shows around the rows, for the list's screen
 *  (chats/ChatsScreen.kt) and its actions (chatactions/ChatListActions.kt):
 *  - the title with the state of the connection («Ожидание сети…» → «Соединение…» → «Обновление…» → «Чаты») and,
 *    under it, how much is waiting («3 чата ждут ответа» / «всё прочитано»);
 *  - the number on the «Чаты» tab (UnreadTotal);
 *  - the skeleton rows until the first chats, and the empty states with their buttons;
 *  - the folder tabs and the sideways swipe between folders (ChatFolders.kt);
 *  - the «Избранное» row above the chats, its screen and its long-press menu (SavedMessages.kt);
 *  - «Выбрать» (ChatListEdit.kt), «Архив» behind the pull, people by @name in the search, the peek card.
 *  Main thread only (native/ios/Sources/ChatsPlus/ChatListPlus.swift). */
class ChatListPlus(private val context: Context, private val messenger: Messenger?) {
  private var host: ViewGroup? = null
  private var heading: TextView? = null
  private var oldEmpty: TextView? = null
  private var list: ChatListView? = null
  private var actions: ChatListActions? = null
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)

  private val subtitle = context.words("", 12.5f, Theme.muted)
  private val statusSpinner = ProgressBar(context)
  private val statusWords = context.words("", 15f, Theme.text, 600)
  private val skeleton = ChatListSkeletonView(context)
  private val emptyState = EmptyStateView(context)
  private val tabs = FolderTabsView(context)
  /** «Выбрать» and the choosing of chats (ChatListEdit.kt). */
  val edit = ChatListEdit(context, messenger)
  /** People by @name in the search (ListExtras.kt). */
  private val people = ListPeopleSearch(messenger)
  /** «Архив» behind the pull (ListExtras.kt). */
  private val archivePullView = ArchivePullView(context)
  /** The floating header: rows passing under the title, the search and the folders fade out (tabInset.tsx). */
  private val headerEdge = ScrollEdgeView(context, top = true)
  /** Where on the screen the last hold on a row was (the peek card comes up from there), px. */
  var holdY = 0f

  private var serverLoaded = false
  private var hardError = false
  private var updating = false
  private var unreadChats = 0
  private var chatsOnScreen = 0
  private var savedOnScreen = false
  private var chats: List<Messenger.ChatSummary> = emptyList()
  /** The folder shown: "all" or a folder's id. */
  var filter = "all"
    private set
  /** «Новый чат» / «Найти собеседника»: the screen opens «Люди». */
  var onNewChat: (() -> Unit)? = null

  private val userKey: String get() = messenger?.userId ?: "sample"
  private val folders: ChatFolderStore get() = ChatFolderStore.of(context, userKey)
  private val demo: String get() = ChatsPlusDemo.chatsdemo ?: ""

  private val lineChanged: (Map<String, Any?>) -> Unit = { event -> if (event["type"] == "ready") updating = true; refreshTitle() }
  private val networkChanged: (Unit) -> Unit = { refreshTitle() }
  private val foldersChanged: (Unit) -> Unit = { foldersChanged() }
  private val savedChanged: (Unit) -> Unit = { actions?.redraw() }
  private var watching = false

  // Setting up

  fun install(host: ViewGroup, heading: TextView, empty: TextView, list: ChatListView, actions: ChatListActions) {
    this.host = host
    this.heading = heading
    this.oldEmpty = empty
    this.list = list
    this.actions = actions
    // The reference's title face: Unbounded ExtraBold, 30.
    heading.titled(Theme.TypeSize.chatsTitle)
    heading.maxLines = 1
    heading.setAutoSizeTextTypeUniformWithConfiguration(21, 30, 1, TypedValue.COMPLEX_UNIT_SP)
    host.addView(subtitle)
    statusSpinner.isIndeterminate = true
    statusSpinner.indeterminateTintList = ColorStateList.valueOf(Theme.muted)
    statusSpinner.visibility = View.GONE
    host.addView(statusSpinner)
    statusWords.visibility = View.GONE
    statusWords.gravity = android.view.Gravity.CENTER_VERTICAL
    statusWords.isFocusable = true
    host.addView(statusWords)
    skeleton.setBackgroundColor(Theme.bg)
    skeleton.visibility = View.GONE
    host.addView(skeleton)
    emptyState.setBackgroundColor(Theme.bg)
    emptyState.visibility = View.GONE
    host.addView(emptyState)
    tabs.visibility = View.GONE
    tabs.onChange = { choose(it) }
    tabs.onEdit = { editFolder(it) }
    host.addView(tabs)
    // The floating header's edge: above the rows, under the title and the buttons.
    host.addView(headerEdge, host.indexOfChild(list) + 1)
    headerEdge.source = list // EdgeFade: the rows behind the header, blurred progressively (shell/EdgeFade.kt)
    edit.install(host, actions)
    edit.onChange = { actions.redraw(); refreshTitle() }
    people.onChange = { actions.redraw() }
    archivePullView.setOnClickListener { actions.pressed(ChatListActions.archiveRow) }
    list.folderClaims = { startX, dx -> claims(startX, dx) }
    list.onFolderDrag = { dx -> dragged(dx) }
    list.onFolderRelease = { dx, velocity -> released(dx, velocity) }
    NetworkWatch.start(context)
    if (messenger == null) serverLoaded = true
    // The screen's own one-line «Загрузка…» / «Пока нет чатов» gives way to the skeleton and the empty states; it
    // comes back only for a real error (a refusal), as the reference's notice.
    empty.alpha = 0f
    skeleton.visibility = if (messenger == null) View.GONE else View.VISIBLE
    if (messenger != null) SavedMessages.of(messenger)
    prepareDemo()
    tabs.set(folders.folders, filter)
    refreshTitle()
  }

  /** The screen is in the window: the connection, the folders and «Избранное» are followed. */
  fun attached() {
    if (watching) return
    watching = true
    Live.callEvent.watch(lineChanged)
    NetworkWatch.changed.watch(networkChanged)
    ChatFolderStore.changed.watch(foldersChanged)
    SavedMessages.changed.watch(savedChanged)
    refreshTitle()
  }

  fun detached() {
    if (!watching) return
    watching = false
    Live.callEvent.unwatch(lineChanged)
    NetworkWatch.changed.unwatch(networkChanged)
    ChatFolderStore.changed.unwatch(foldersChanged)
    SavedMessages.changed.unwatch(savedChanged)
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(View.MeasureSpec.makeMeasureSpec(width.coerceAtLeast(0), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height.coerceAtLeast(0), View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
  }

  /** Places the line under the title, the connection words, the folder tabs, the skeleton and the empty state; gives
   *  the top of the list. `listTop`: where the list would start without them. */
  fun place(width: Int, height: Int, safeTop: Int, safeBottom: Int, listTop: Int, barRoom: Int): Int {
    val searching = listTop > safeTop + dp(60f)
    put(subtitle, dp(21f), safeTop + dp(47f), width - dp(42f + 96f), dp(16f))
    subtitle.visibility = if (searching || statusWords.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    put(statusSpinner, dp(20f), safeTop + dp(18f), dp(20f), dp(21f))
    put(statusWords, dp(46f), safeTop + dp(8f), width - dp(40f + 100f + 26f), dp(41f))
    var top = listTop + if (searching) 0 else dp(10f)
    val showTabs = folders.folders.isNotEmpty() && actions?.showingArchive != true && !searching
    tabs.visibility = if (showTabs) View.VISIBLE else View.GONE
    if (showTabs) {
      put(tabs, dp(16f), top, width - dp(32f), dp(40f))
      top += dp(48f)
    }
    edit.place(width, height, safeTop, safeBottom, width - dp(20f + 40f + 8f + 40f))
    val below = top + (if (savedOnScreen) dp(76f) else 0) + (if (actions?.showingArchive == true) dp(76f) else 0)
    put(skeleton, 0, below, width, maxOf(0, height - below))
    put(emptyState, 0, below, width, maxOf(0, height - below - barRoom))
    return top
  }

  // What the actions tell

  /** Every chat of the list (not removed), with what counts: the tab's badge. */
  fun listed(items: List<ChatListStatus.Counted>, summaries: List<Messenger.ChatSummary>) {
    chats = summaries
    UnreadTotal.set(ChatListStatus.total(items))
  }

  /** Whether a chat stands in the folder shown (not in «Архив»). */
  fun keeps(chatId: String, unread: Boolean): Boolean = folders.matches(chatId, unread, filter)

  /** The parts of the list («Сегодня», «Вчера»…) are shown only in «Все», and not while choosing chats. */
  val showsSections: Boolean get() = filter == "all" && !edit.selecting

  // Choosing, the floating header, «Архив» behind the pull, people, the peek

  val selecting: Boolean get() = edit.selecting
  fun isChosen(id: String): Boolean = edit.isChosen(id)
  fun toggle(id: String) = edit.toggle(id)

  /** The room the list keeps at its bottom: the bar's, or the choosing bar's while choosing. */
  fun listBottom(normal: Int, safeBottom: Int): Int = if (edit.selecting) edit.listBottom(safeBottom) else normal

  /** The edge under the floating header, as tall as the header (the status bar included). */
  fun placeHeaderEdge(top: Int, width: Int) {
    headerEdge.color = Theme.bg
    // Owner (device photo): at rest nothing under the header is blurred — the edge ends at the header's lower edge,
    // not 24 dp into the first row, and it shows only once rows go up under the header.
    headerEdge.reach = 0f
    headerEdge.place(width, top, 0)
    headerEdge.alpha = scrolledUnder
  }

  /** 0 at rest, 1 once the rows have gone 16 dp up under the header (ChatListView.onScrolledUnder). */
  private var scrolledUnder = 0f
  fun rowsUnder(distance: Int) {
    val next = (distance / (16f * context.resources.displayMetrics.density)).coerceIn(0f, 1f)
    if (Math.abs(next - scrolledUnder) < 0.001f) return
    scrolledUnder = next
    headerEdge.alpha = next
  }

  /** «Архив» goes behind the pull in «Все» (not while searching or choosing). True: it is there, the actions must not
   *  add its row. `count`: the archived chats (0 takes it away). */
  fun archivePull(count: Int): Boolean {
    if (count <= 0 || filter != "all" || edit.selecting) {
      list?.setPull(null)
      return false
    }
    archivePullView.set(count)
    list?.setPull(archivePullView)
    return true
  }

  /** «Люди» under the chats the search found. */
  fun peopleRows(query: String): List<Map<String, Any?>> = people.rows(query, chats.map { it.peerId }.toSet(), messenger?.userId ?: "")

  /** A touch on a person found by the search: the chat with them (the one there is, or a new one). */
  fun openPerson(rowId: String) {
    val personId = rowId.removePrefix("user|")
    chats.firstOrNull { it.peerId == personId }?.let { actions?.open(it.id, ""); return }
    val host = host ?: return
    val person = people.person(personId) ?: return
    val messenger = messenger ?: return
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(host.windowToken, 0)
    messenger.openChat(person, host) { error ->
      if (error == null) return@openChat
      host.post {
        val words = if (error.words.isEmpty()) "Не удалось открыть чат." else error.words + " Нажми ещё раз, чтобы повторить."
        com.linea.messenger.attachments.ChatAttachments.say(context, words)
      }
    }
  }

  /** The hold menu with the chat's card over it. False: it could not be shown (the caller shows its plain list). */
  fun presentPeek(chat: Messenger.ChatSummary, choices: List<ChoiceSheet.Choice>): Boolean {
    if (host?.isAttachedToWindow != true) return false
    val peer = chat.chat["peer"] as? Map<*, *>
    val color = (chat.row["avatarColor"] as? Number)?.toInt() ?: 0xFF4B73BB.toInt()
    val lines = if (messenger == null) ChatsPlusDemo.peekLines() else emptyList()
    val card = ChatPeekMenu(context, holdY, chat.title, peer?.get("username") as? String ?: "", chat.row["initials"] as? String ?: "", color, lines, choices)
    card.show()
    messenger?.let { account -> ChatPeekMenu.peekLines(context, account, chat.id) { found -> card.setLines(found) } }
    return true
  }

  /** The chats shown in the list now: the line under the title counts those with unread messages. */
  fun shown(unread: Int) {
    unreadChats = unread
    refreshTitle()
  }

  /** The «Избранное» row (in «Все», not while searching unless the words fit «избранное»). */
  fun savedRow(query: String): Map<String, Any?>? {
    if (filter != "all") return null
    val wanted = query.trim().lowercase()
    if (wanted.isNotEmpty() && !"избранное".contains(wanted)) return null
    val saved = SavedMessages.shared(messenger) ?: return null
    return savedRowFor(saved.items.lastOrNull(), Theme.accent)
  }

  /** The rows went on screen (after the screen's own handling): the skeleton until the first answer, then the empty
   *  state that fits. */
  fun rowsShown(rows: List<ChatRow>, emptyWords: String) {
    val special = setOf(SAVED_ROW, ChatListActions.archiveRow, ChatListActions.backRow)
    val real = rows.count { it.id !in special }
    val hadSaved = savedOnScreen
    chatsOnScreen = real
    savedOnScreen = rows.any { it.id == SAVED_ROW }
    val query = actions?.searchWords ?: ""
    val archive = actions?.showingArchive ?: false
    var wantSkeleton = real == 0 && !serverLoaded && !hardError && messenger != null && query.isEmpty()
    var wantEmpty = !wantSkeleton && !hardError && real == 0 && emptyWords != "Поиск…" && (messenger != null || query.isNotEmpty() || archive || filter != "all")
    if (demo == "skeleton") { wantSkeleton = true; wantEmpty = false }
    if (demo == "empty") { wantSkeleton = false; wantEmpty = true }
    skeleton.visibility = if (wantSkeleton) View.VISIBLE else View.GONE
    emptyState.visibility = if (wantEmpty) View.VISIBLE else View.GONE
    if (wantEmpty) {
      val forced = demo == "empty"
      when {
        query.isNotEmpty() && !forced -> emptyState.show("search", "Чат не найден", "Попробуй другое имя или найди человека по @имени.", "Найти собеседника") { onNewChat?.invoke() }
        filter == "unread" -> emptyState.show("checkmark.circle", "Всё прочитано", "Здесь появятся чаты с новыми сообщениями и отмеченные как непрочитанные.")
        (filter != "all" || archive) && !forced -> emptyState.show("folder", "Здесь пока пусто", if (archive) "В архиве нет чатов." else "В этой папке нет чатов. Добавь их в настройках папки.")
        else -> emptyState.show("bubbles", "Начни разговор", "Найди своего человека по @имени. Всё начинается с простого «привет».", "Найти собеседника") { onNewChat?.invoke() }
      }
    }
    if (hadSaved != savedOnScreen) host?.requestLayout()
  }

  /** The server answered the list: the skeleton may go, «Обновление…» is over. */
  fun serverAnswered() {
    serverLoaded = true
    updating = false
    refreshTitle()
  }

  /** The list could not be read. No network is not an error to show (the title says it); a refusal is. */
  fun serverFailed(error: Throwable?) {
    updating = false
    if (error is ServerError.Refused) {
      hardError = true
      skeleton.visibility = View.GONE
      if (chatsOnScreen == 0) { emptyState.visibility = View.GONE; oldEmpty?.alpha = 1f }
    }
    refreshTitle()
  }

  // The title

  private val titleState: ChatListStatus.Title
    get() {
      when (demo) {
        "waiting" -> return ChatListStatus.Title.WAITING
        "connecting" -> return ChatListStatus.Title.CONNECTING
        "updating" -> return ChatListStatus.Title.UPDATING
      }
      val messenger = messenger ?: return ChatListStatus.Title.CHATS
      return ChatListStatus.title(messenger.live.line, NetworkWatch.online, updating)
    }

  private fun refreshTitle() {
    val state = titleState
    val connecting = state != ChatListStatus.Title.CHATS
    statusWords.visibility = if (connecting) View.VISIBLE else View.GONE
    statusSpinner.visibility = statusWords.visibility
    heading?.alpha = if (connecting) 0f else 1f
    statusWords.text = state.words
    statusWords.contentDescription = state.words
    subtitle.text = if (edit.selecting) (if (edit.count > 0) "Выбрано: ${edit.count}" else "Отметь чаты") else ChatListStatus.unreadLine(unreadChats)
    subtitle.visibility = if (connecting || actions?.searching == true) View.GONE else View.VISIBLE
    host?.requestLayout()
  }

  // Folders

  private fun foldersChanged() {
    if (filter != "all" && folders.folders.none { it.id == filter }) filter = "all"
    tabs.set(folders.folders, filter)
    actions?.redraw()
    host?.requestLayout()
  }

  private fun choose(id: String) {
    if (id == filter) return
    filter = id
    tabs.set(folders.folders, filter)
    actions?.redraw()
  }

  private fun editFolder(folder: ChatFolder?) {
    val listed = if (messenger == null) ChatsPlusDemo.sampleFolderChats() else chats.map { FolderChat(it) }
    val editor = FolderEditor(context, folder, listed)
    editor.onSave = { made -> folders.upsert(made); choose(made.id) }
    editor.onDelete = { folders.remove(it) }
    editor.show()
  }

  private val folderIndex: Int get() = maxOf(0, folders.tabIds.indexOf(filter))

  private val motion: Boolean
    get() = try { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f } catch (_: Exception) { true }

  /** listSwipes.ts `rowClaimsSwipe`: from a row's edge its buttons slide out; from the middle the folder turns. */
  private fun claims(startX: Float, dx: Float): Boolean {
    val list = list ?: return false
    if (tabs.visibility != View.VISIBLE) return false
    val ids = folders.tabIds
    if (ids.size < 2) return false
    val width = list.width.toFloat()
    val edge = maxOf(72f * d, width * 0.25f)
    val index = folderIndex
    return if (dx < 0) index < ids.size - 1 && startX < width - edge else index > 0 && startX > edge
  }

  private fun dragged(dx: Float) {
    val list = list ?: return
    val width = maxOf(1f, list.width.toFloat())
    tabs.follow(pagePosition(folderIndex, folders.tabIds.size, dx, width), animated = false)
    val shift = if (motion) dx * 0.3f else 0f
    list.translationX = shift
    list.alpha = 1f - minOf(0.35f, Math.abs(shift) / (400f * d))
  }

  private fun released(dx: Float, velocity: Float) {
    val list = list ?: return
    val ids = folders.tabIds
    val index = folderIndex
    val to = pageRelease(index, ids.size, dx, velocity, maxOf(1f, list.width.toFloat()) , d)
    list.animate().translationX(0f).alpha(1f).setDuration(if (motion) 200 else 0).start()
    tabs.follow(to.toFloat(), animated = motion)
    if (to != index && to < ids.size) {
      list.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      choose(ids[to])
    }
  }

  // «Избранное»

  /** A touch on the «Избранное» row. */
  fun openSaved() {
    val host = host ?: return
    SavedScreen.open(host, messenger)
  }

  /** A hold on «Избранное»: open it, or clear it completely (asked once more: it cannot be undone). */
  fun savedMenu() {
    host?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    ChoiceSheet(context, "Избранное", choices = listOf(
      ChoiceSheet.Choice("bookmark", "Открыть") { openSaved() },
      ChoiceSheet.Choice("trash", "Очистить Избранное", danger = true) { host?.postDelayed({ askClear() }, 350) },
    )).show()
  }

  private fun askClear() {
    val saved = SavedMessages.shared(messenger) ?: return
    try {
      val dialog = android.app.AlertDialog.Builder(context)
        .setTitle("Очистить Избранное?")
        .setMessage("Все заметки, файлы и голосовые из Избранного будут удалены с этого устройства. Вернуть их нельзя.")
        .setPositiveButton("Удалить всё: ${saved.items.size}") { _, _ -> saved.clear() }
        .setNegativeButton("Отмена", null)
        .show()
      dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE)?.apply { isEnabled = saved.items.isNotEmpty(); setTextColor(Theme.danger) }
    } catch (_: Exception) { /* the window is gone */ }
  }

  // The emulator check

  /** `--es chatsdemo …` (debug builds; with `--ez demo true` or with an account):
   *    waiting | connecting | updating     the title in that state of the connection
   *    skeleton | empty                    the skeleton rows / «Начни разговор»
   *    folders | folder                    two sample folders: the tabs on «Все» / on the first folder
   *    foldereditor | foldersettings       the editor of a new folder / Настройки → Папки с чатами
   *    savedmenu | saved | savedsearch     the hold menu of «Избранное» / the «Избранное» screen / its search
   *    select | mutecustom | archivepull   choosing with two chats marked / «Настроить…» of the sound / «Архив» pulled out */
  private fun prepareDemo() {
    if (demo.isEmpty()) return
    if (demo == "folders" || demo == "folder" || demo == "foldersettings") {
      if (folders.folders.isEmpty()) {
        folders.upsert(ChatFolder("fwork", "Работа", listOf("demo-1", "demo-4", "demo-6")))
        folders.upsert(ChatFolder("ffamily", "Семья", listOf("demo-2", "demo-5")))
      }
      if (demo == "folder") filter = "fwork"
    }
    host?.postDelayed({
      val host = host ?: return@postDelayed
      if (!host.isAttachedToWindow) return@postDelayed
      when (demo) {
        "foldereditor" -> editFolder(null)
        "foldersettings" -> host.pages()?.push(FoldersSettingsPage(context, messenger), animated = false)
        "savedmenu" -> savedMenu()
        // «Выбрать» with two chats marked: the round marks, «Выбрано: 2», the bar of actions.
        "select" -> edit.set(chats.take(2).map { it.id }.toSet().ifEmpty { setOf("demo-0", "demo-1") })
        "mutecustom" -> MuteCustomSheet(context) { }.show()
        "archivepull" -> list?.openPull()
        "saved", "savedsearch" -> openSaved()
      }
    }, 800)
  }

  companion object {
    const val SAVED_ROW = "__saved"

    /** The «Избранное» row for the newest note (null: none yet). */
    fun savedRowFor(last: Map<String, Any?>?, accent: Int, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Map<String, Any?> {
      var preview = "Заметки, файлы и сохранённые сообщения"
      var icon = ""
      var time = ""
      if (last != null) {
        val (text, mark) = SavedMessages.line(last)
        preview = text; icon = mark
        time = Messenger.listTime(last["savedAt"] as? String, now, zone)
      }
      return mapOf("id" to SAVED_ROW, "title" to "Избранное", "preview" to preview, "previewIcon" to icon, "time" to time, "unread" to 0,
        "initials" to "★", "avatarColor" to (0xFF000000.toInt() or (accent and 0xFFFFFF)), "orbA" to 0, "orbB" to 0, "section" to "")
    }

    /** listSwipes.ts `pagePosition`: the fractional page under the finger, held back past the ends. */
    fun pagePosition(index: Int, count: Int, translation: Float, width: Float): Float {
      if (width <= 0 || count <= 0) return index.toFloat()
      var p = index - translation / width
      val last = (count - 1).toFloat()
      if (p < 0) p *= 0.2f else if (p > last) p = last + (p - last) * 0.2f
      return p.coerceIn((index - 1).toFloat(), (index + 1).toFloat())
    }

    /** listSwipes.ts `pageRelease`: a quarter of the width or a flick (600 dp/s) turns one page, never past the ends.
     *  `velocity`: px/s; `density`: px per dp. */
    fun pageRelease(index: Int, count: Int, translation: Float, velocity: Float, width: Float, density: Float = 1f): Int {
      if (count <= 1 || width <= 0) return index
      val speed = velocity / density
      val flickBack = translation != 0f && Math.signum(speed) != Math.signum(translation) && Math.abs(speed) > 300
      var step = 0
      if (!flickBack && (Math.abs(translation) > width * 0.25f || Math.abs(speed) > 600)) step = if (translation < 0 || (translation == 0f && speed < 0)) 1 else -1
      return (index + step).coerceIn(0, count - 1)
    }
  }
}
