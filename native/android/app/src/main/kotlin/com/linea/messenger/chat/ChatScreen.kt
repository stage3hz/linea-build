package com.linea.messenger.chat

import android.annotation.SuppressLint
import android.content.Context
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.Demo
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.AttachmentsDemo
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.chatactions.ChatScreenActions
import com.linea.messenger.chatactions.ComposerField
import com.linea.messenger.chatactions.SendButton
import com.linea.messenger.design.GlassSource
import com.linea.messenger.design.IconButton
import com.linea.messenger.design.Theme
import com.linea.messenger.people.PersonProfileScreen
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen
import java.time.Instant
import java.time.ZoneId

/** One chat: the messages, the header with the person's name, the field to write in.
 *  With a `messenger`: the real chat. Without: the debug build's sample chat. */
@SuppressLint("ViewConstructor")
class ChatScreen(
  context: Context, name: String,
  private val messenger: Messenger? = null, private val chatId: String = "", private val peerId: String = "",
  /** Up to which message the other side has read (for the two ticks). */
  private var peerLastRead: Long = 0,
  private val goBack: () -> Unit,
) : Screen(context), Messenger.Watcher {
  private val page = GlassSource(context)
  private val list = MsgListView(context)
  private val header = View(context)
  private val back = IconButton(context, "back", 24f, Theme.text)
  private val heading = TextView(context)
  // Composer: no glass of its own — three separate glass shapes under its buttons and field, as in the reference
  // (composer/ComposerPills.kt).
  private val composer = FrameLayout(context)
  private val pills = com.linea.messenger.composer.ComposerPills(context, page)
  /** ChatActions: several lines, growing with the text (chatactions/ChatParts.kt). */
  private val field = ComposerField(context)
  private val send = SendButton(context)
  /** The chat's rows as they are now (and what is being sent, until the server has taken it). */
  private var real: List<Map<String, Any?>> = emptyList()
  /** Attachments: the debug build's sample rows (`attachdemo`), kept after the chat's own. */
  private var sampleRows: List<Map<String, Any?>> = emptyList()
  /** ChatActions: the menu of a message with its reactions, answers, edits, forwards, pins, deletions, the
   *  multi-select, the draft, «печатает…», the way down and older pages (chatactions/ChatScreenActions.kt). */
  val actions = ChatScreenActions(context, messenger, chatId, peerId, name)
  /** Attachments: the paperclip, sending and opening photos and files (attachments/ChatAttachments.kt). */
  private val attachments = ChatAttachments(this, messenger, chatId, peerId)
  /** Voice/Video: the record button, voice messages, videos and round videos (voice/ChatMedia.kt). */
  private val media = com.linea.messenger.voice.ChatMedia(this, messenger, chatId, peerId)
  /** Calls: «Позвонить» in the header; a long touch offers «Видеозвонок» too (calls/CallOverlay.kt). */
  val callButton: View = com.linea.messenger.calls.CallEntry.headerButton(context, messenger, chatId, peerId, name)
  /** ChatLook: the glass header with the avatar, the person's light or the wallpaper, bubbles, the swipe to answer
   *  (chatlook/ChatLookScreen.kt). */
  val look = com.linea.messenger.chatlook.ChatLookScreen(this, messenger, chatId, peerId, name)

  init {
    setBackgroundColor(Theme.bg)
    list.setPalette(Theme.messages)
    list.setFontSize(com.linea.messenger.settings.ThemeStore.textSize) // Settings: «Размер текста в чатах» (settings/ThemeStore.kt)
    page.addView(list, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    look.installBackdrop(page) // ChatLook: the wallpaper or the person's light under the messages
    addView(page)

    header.setBackgroundColor(Theme.bg)
    addView(header)
    back.contentDescription = "Назад"
    back.setOnClickListener { leave() }
    addView(back)
    heading.text = name
    heading.textSize = 17f
    heading.typeface = Theme.weight(600)
    heading.setTextColor(Theme.text)
    heading.gravity = Gravity.CENTER
    heading.maxLines = 1
    heading.ellipsize = TextUtils.TruncateAt.END
    addView(heading)
    // People: a tap on the name opens the person's profile.
    heading.setOnClickListener { openProfile() }
    addView(callButton)

    composer.addView(pills, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)) // Composer: the glass under everything
    composer.addView(field, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT).apply { leftMargin = dp(18f); rightMargin = dp(50f) })
    // Composer: an accent circle of 40 dp with the arrow, at the row's end (ChatScreen.tsx «Отправить сообщение»).
    composer.addView(send, FrameLayout.LayoutParams(dp(40f), dp(40f), Gravity.END or Gravity.BOTTOM))
    // Attachments: the paperclip in the composer; a touch on a row opens its photo or file.
    attachments.install(composer, field)
    attachments.onPendingChanged = { showPendingAttachments() }
    addView(composer)
    // ChatActions: a touch on a message (the menu, a reaction, an attachment), the field, the bars, the header's
    // status line — and the rows themselves, with or without an account (the debug build's sample chat).
    actions.peerLastRead = peerLastRead
    actions.install(this, page, list, heading, back, composer, field, send, attachments)
    actions.onRows = { made -> showRows(made) }
    actions.onLoaded = { newestTheirs -> loaded(newestTheirs) }
    // Voice/Video: the microphone in the send button's place, the rows of what is being sent, playing.
    media.install(list, composer, field, send, attachments, actions, page)
    media.onRecordShift = { value -> pills.recordShift = value } // Record: the pills make room for a take
    media.onPendingChanged = { showPendingMedia() }
    // ChatLook: the header's views go into glass pills; the avatar on the right; the swipe to answer.
    look.installHeader(page, header, heading, back, callButton, actions.statusView, list, actions)
    look.onSearch = { actions.openSearch() } // ChatActions: «Поиск» of the avatar's hold menu
    look.onGift = { actions.sendGift() } // Composer: «Отправить подарок»
    // Profile: «Поиск» and «Обои» of the profile come back to this chat (profile/ProfileChatExtras.kt).
    com.linea.messenger.profile.ProfileChatLink.searchHook = { it.actions.openSearch() }
    com.linea.messenger.profile.ProfileChatLink.wallpaperHook = { it.look.openWallpaper() }
    if (messenger == null) com.linea.messenger.chatlook.LookDemo.run(this) // ChatLook: --es chatlook … (chatlook/LookDemo.kt of src/debug)

    if (messenger == null) {
      // Attachments: `attachdemo 1` adds sample rows with a photo and files, `attachdemo viewer` also opens the photo viewer.
      // LinkPreview: `linkdemo 1|composer` adds two rows with the cards of links (linkpreview/LinkDemo.kt of src/debug).
      sampleRows = AttachmentsDemo.rows() + com.linea.messenger.linkpreview.LinkDemo.rows((context as? android.app.Activity)?.intent)
      AttachmentsDemo.viewer(this)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    messenger?.watch(this)
    actions.attached()
    look.attached() // ChatLook: back from the profile or the settings, the wallpaper and the bubbles may have changed
    // Voice/Video: round videos move while the chat is on screen.
    media.appeared()
    load()
  }

  override fun onDetachedFromWindow() {
    messenger?.unwatch(this)
    actions.detached()
    look.detached() // ChatLook
    // Voice/Video: leaving the chat stops every sound and a take.
    media.left()
    super.onDetachedFromWindow()
  }

  /** Reads the chat's newest page and shows it.
   *  ChatActions: the pages are read, folded and turned into rows there; they come back through `actions.onRows`. */
  private fun load() {
    actions.load()
  }

  /** The chat's rows as they are now, with what the attachments add after them. */
  private fun showRows(made: List<Map<String, Any?>>) {
    // Attachments: what is still on its way out stands after the chat's own rows.
    // Voice/Video: voice messages and videos on their way out (and the debug build's sample rows).
    real = made + attachments.loaded(made) + media.loaded(made) + sampleRows
    list.setRows(MsgRow.parse(real))
  }

  /** The newest page was read: what came from the other side is reported as read. */
  private fun loaded(newestTheirs: Long) {
    // Reported once per new message: the server answers a read mark with an event, which reads the page again.
    if (isAttachedToWindow && newestTheirs > reportedRead) {
      reportedRead = newestTheirs
      messenger?.markRead(chatId, newestTheirs)
    }
  }

  /** Up to which message this screen has told the server «read». */
  private var reportedRead = 0L

  override fun changed(chatId: String?) {
    if (chatId != null && chatId != this.chatId) return
    load()
  }

  override fun peerRead(chatId: String, messageId: Long) {
    if (chatId != this.chatId || messageId <= peerLastRead) return
    peerLastRead = messageId
    actions.peerLastRead = messageId
    load()
  }

  /** Shell: the player strip under the header while music plays (shell/PlayerStrips.kt); made after the page's own
   *  parts, so it lies over them. */
  private val playerStrip = com.linea.messenger.shell.ChatPlayerStrip(this)

  override fun place(width: Int, height: Int) {
    val top = edges.top
    put(header, 0, 0, width, top + dp(52f)) // ChatLook: 8 above the 44 dp pills
    put(back, dp(6f), top + dp(2f), dp(44f), dp(44f))
    put(heading, dp(56f), top + dp(2f), width - dp(112f), dp(44f))
    put(callButton, width - dp(50f), top + dp(2f), dp(44f), dp(44f))
    // ChatActions: the composer is as tall as the field's text asks (one line at first); the send button and
    // the paperclip stay at its lower edge.
    // Composer: the row is 8 dp from the screen's sides; the field's pill leaves 40 + 8 dp on each side for the
    // paperclip and the microphone, and its text stands 14 dp in from the pill's edges (ChatScreen.tsx).
    val composerHeight = actions.composerHeight(width - dp(16f) - dp(96f) - dp(28f))
    // Above the keyboard when it is up, above the system's bar otherwise.
    var floor = if (edges.keyboard > 0) height - edges.keyboard - dp(8f) else height - maxOf(edges.bottom, dp(12f))
    // Composer: the emoji panel stands where the keyboard was (composer/EmojiPanel.kt).
    actions.extras.keyboard(edges.keyboard)
    if (edges.keyboard == 0) actions.extras.panelTop(height)?.let { floor = it - dp(8f) }
    val composerTop = floor - composerHeight
    put(composer, dp(8f), composerTop, width - dp(16f), composerHeight) // Composer: 8 from the sides
    // Voice/Video: the microphone or the send button, the lock of a take, the words over the chat.
    media.place(width, top, dp(8f), composerTop, width - dp(16f), composerHeight)
    pills.microphoneShown = send.visibility != View.VISIBLE // Composer: the microphone's round glass only while the record button stands there
    // ChatActions: the status under the name, the pinned message, the bar above the field, the way down.
    actions.keyboardUp = edges.keyboard > 0
    val strip = playerStrip.place(width, top + dp(52f), hidden = false) // Shell: the strip takes its room under the header
    val room = actions.place(width, height, top + dp(52f) + strip, top, dp(8f), composerTop, width - dp(16f), composerHeight)
    list.setPad(room.first, room.second)
    put(page, 0, 0, width, height)
    look.place(width, height, top, room.first - dp(8f)) // ChatLook: the pills of the header, after ChatActions placed the name and the status
    look.placeFloor(width, height, composerTop) // EdgeFade: the progressive edge above the composer
  }

  /** Attachments: shows the rows of what is being sent (they change while a file is prepared and uploaded). */
  private fun showPendingAttachments() {
    real = real.filter { !(it["key"] as? String ?: "").startsWith("attach-") } + attachments.pendingRows
    list.setRows(MsgRow.parse(real))
  }

  /** Voice/Video: shows the rows of voice messages and videos being sent. */
  private fun showPendingMedia() {
    real = real.filter { !(it["key"] as? String ?: "").startsWith("media-") } + media.pendingRows
    list.setRows(MsgRow.parse(real))
  }

  /** People: the profile of the person of this chat (people/PersonProfileScreen.kt). */
  fun openProfile() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
    val profile = PersonProfileScreen(context, messenger, peerId, heading.text.toString(), chatId = if (messenger == null) "demo" else chatId)
    // Profile: «Звук», «Поиск», the shared media and the chat's items of «Ещё» (profile/ProfileChatExtras.kt).
    profile.chatLink = com.linea.messenger.profile.ProfileChatLink(this, chatId)
    pages()?.push(profile)
  }

  /** ChatLook: the emulator check — a sample row added after the chat's own (a message that arrives). */
  fun addSampleRow(row: Map<String, Any?>) { sampleRows = sampleRows + row; load() }

  /** Profile: an attachment of the shared media is opened as a touch on its row would (profile/ProfileChatExtras.kt). */
  fun openAttachment(key: String) = attachments.pressed(key, inRow = false) // Attachments: not brought inside a row that is not on screen

  private fun leave() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
    goBack()
  }
}
