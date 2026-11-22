package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.AttachmentStore
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chatactions.ChoiceSheet
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.net.Server
import java.lang.ref.WeakReference
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale

// What a person's profile offers when it is opened from the chat with them (the reference's UserProfile.tsx with
// ChatScreen.tsx's props `onMute`, `onSearch`, `shared`, `onOpenAttachment`, `onWallpaper`, `rules`, `onRules`,
// `onClear`, and SharedMedia.tsx, ChatSheets.tsx, notifications/MuteSheet.tsx; iOS Profile/ProfileChatExtras.swift):
//   ProfileChatLink     the open chat as the profile sees it: its decrypted history, its encrypted rules, its sound
//   ProfileChatExtras   the «Звук» tile's words, the sheets (sound, «Автоудаление», «Очистить историю?»), the
//                       items of «Ещё» (auto-delete, no copying, wallpaper, search, clear history)
//   SharedMediaView     «Фото · Видео · Файлы · Голосовые · Ссылки» of the chat, from this device's history only

/** The chat a profile was opened from. Everything goes through the chat screen's own objects: the rules and the
 *  clearing are end-to-end encrypted chat actions (`settings`, `clear`) folded by the core like any other. */
class ProfileChatLink(chat: ChatScreen, val chatId: String) {
  private val chatRef = WeakReference(chat)
  val chat: ChatScreen? get() = chatRef.get()

  companion object {
    /** The chats' own settings as the list last gave them (the sound), by chat id. Filled when a chat opens. */
    val settingsOf = HashMap<String, Map<String, Any?>>()
    /** Where the chat screen can search its messages and change its wallpaper, when the app has those (set by
     *  whoever builds them); null: the profile offers neither. */
    var searchHook: ((ChatScreen) -> Unit)? = null
    var wallpaperHook: ((ChatScreen) -> Unit)? = null
  }

  /** The debug build's sample history for the shared media (no account). */
  var sampleMessages: List<Map<String, Any?>>? = null

  /** The chat's messages as this device decrypted them, oldest first (what SharedMedia.tsx is given). */
  val messages: List<Map<String, Any?>>
    get() {
      sampleMessages?.let { return it }
      val shown = chat?.actions?.history?.shown ?: return emptyList()
      return shown.order.mapNotNull { key -> shown.messages[key]?.let { LinkedHashMap(it).apply { put("rowKey", key) } } }
    }

  /** The encrypted rules: «Автоудаление» (seconds, 0 = off) and «копирование запрещено». */
  val ttl: Int get() = (chat?.actions?.history?.shown?.ttl ?: 0L).toInt()
  val noCopy: Boolean get() = chat?.actions?.history?.shown?.noCopy ?: false

  fun setRules(ttl: Int, noCopy: Boolean) { chat?.actions?.history?.sendAction(mapOf("type" to "settings", "ttl" to ttl, "noCopy" to noCopy)) }

  /** «Удалить у обоих». */
  fun clearForBoth() { chat?.actions?.history?.sendAction(mapOf("type" to "clear")) }

  var settings: Map<String, Any?>
    get() = settingsOf[chatId] ?: emptyMap()
    set(value) { settingsOf[chatId] = value }

  val canSearch: Boolean get() = searchHook != null
  val canWallpaper: Boolean get() = wallpaperHook != null

  /** The profile closes, then the chat does the rest (as the reference: `onClose()` and the chat's own action). */
  fun afterClosing(profile: View, delay: Long, run: (ChatScreen) -> Unit) {
    val chat = chat ?: return
    profile.pages()?.pop()
    chat.postDelayed({ run(chat) }, delay)
  }

  fun openSearch(profile: View) = afterClosing(profile, 350) { searchHook?.invoke(it) }
  fun openWallpaper(profile: View) = afterClosing(profile, 350) { wallpaperHook?.invoke(it) }

  /** An attachment of the shared media: the profile closes and the chat opens it as a touch on its row would. */
  fun openAttachment(key: String, attachment: Map<String, Any?>, profile: View) {
    AttachmentStore.remember(key, attachment)
    afterClosing(profile, 250) { it.openAttachment(key) }
  }
}

/** The stack of pages a view stands in. */
fun View.pages(): com.linea.messenger.shell.Navigation? {
  var above = parent
  while (above != null && above !is com.linea.messenger.shell.Navigation) above = above.parent
  return above as? com.linea.messenger.shell.Navigation
}

object ProfileChatExtras {
  // The sound (notifications/model.ts)

  /** The sound is off: for good, or until a moment the clock has not reached (`isMuted`). */
  fun muted(settings: Map<String, Any?>, now: Instant = Instant.now()): Boolean {
    if (settings["muted"] != true) return false
    val until = settings["mutedUntil"] as? String
    if (until.isNullOrEmpty()) return true
    val end = Messenger.date(until) ?: return true
    return end.isAfter(now)
  }

  private val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

  /** «18:30», «завтра, 09:15», «12 марта, 09:15», «3 января 2027, 09:15» (`muteEndLabel`). */
  fun endLabel(end: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val at = end.atZone(zone); val today = now.atZone(zone).toLocalDate()
    val time = String.format(Locale.ROOT, "%02d:%02d", at.hour, at.minute)
    if (at.toLocalDate() == today) return time
    if (at.toLocalDate() == today.plusDays(1)) return "завтра, $time"
    val year = if (at.year == today.year) "" else " ${at.year}"
    return "${at.dayOfMonth} ${months[at.monthValue - 1]}$year, $time"
  }

  /** «до 18:30», «до завтра, 09:15», «навсегда» (`muteUntilLabel`). */
  fun untilLabel(until: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val end = if (until.isNullOrEmpty()) null else Messenger.date(until)
    return if (end == null) "навсегда" else "до " + endLabel(end, now, zone)
  }

  /** «Выключить звук» (MuteSheet.tsx): «На 1 час / На 8 часов / На 2 дня / Навсегда / Настроить…». `pick` gets the
   *  end (ISO) or null for «Навсегда». */
  fun muteSheet(context: Context, title: String, pick: (String?) -> Unit) {
    val spans = listOf("На 1 час" to 3600L, "На 8 часов" to 8 * 3600L, "На 2 дня" to 2 * 86400L)
    val choices = ArrayList<ChoiceSheet.Choice>()
    for ((label, seconds) in spans) {
      val preview = Instant.now().plusSeconds(seconds)
      // Counted from the moment of the choice, not from the moment the sheet was opened.
      choices.add(ChoiceSheet.Choice("ion:time-outline", label, "Без звука до " + endLabel(preview) + ".") { pick(Instant.now().plusSeconds(seconds).truncatedTo(ChronoUnit.MILLIS).toString()) })
    }
    choices.add(ChoiceSheet.Choice("ion:notifications-off-outline", "Навсегда", "Пока не включишь снова. Звонки продолжат звонить.") { pick(null) })
    choices.add(ChoiceSheet.Choice("ion:options-outline", "Настроить…", "Своё время: дни, часы и минуты.") {
      val custom = com.linea.messenger.chatsplus.MuteCustomSheet(context) { until -> pick(until) }
      custom.onBack = { muteSheet(context, title, pick) }
      custom.show()
    })
    ChoiceSheet(context, "Выключить звук", title, choices).show()
  }

  /** Sends a change of the chat's sound to the server (`chatSettings`) and keeps the copy the list and the profile
   *  read in step. `done` gets null on success or the words of the failure (main thread). */
  fun changeSound(link: ProfileChatLink, messenger: Messenger?, update: Map<String, Any?>, done: (String?) -> Unit) {
    val kept = LinkedHashMap(link.settings)
    (update["muted"] as? Boolean)?.let { kept["muted"] = it; kept["mutedUntil"] = null }
    (update["mutedUntil"] as? String)?.let { kept["muted"] = true; kept["mutedUntil"] = it }
    if (messenger == null) { link.settings = kept; return done(null) }
    messenger.server.op("chatSettings", listOf(link.chatId, update)) { result ->
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        if (result.isSuccess) { link.settings = kept; messenger.noteChanged(link.chatId); done(null) }
        else done(Server.error(result).words.ifEmpty { "Не удалось изменить уведомления." })
      }
    }
  }

  // The rules (ChatSheets.tsx, messageMeta.ts)

  val autoDelete = listOf(0, 86400, 604800, 2592000)

  fun autoDeleteLabel(ttl: Int): String = when (ttl) { 86400 -> "1 день"; 604800 -> "1 неделя"; 2592000 -> "1 месяц"; else -> "Выкл." }
  fun autoDeleteNotice(ttl: Int): String = if (ttl != 0) "Автоудаление: " + autoDeleteLabel(ttl) else "Автоудаление выключено"
  fun noCopyNotice(wasNoCopy: Boolean): String = if (wasNoCopy) "Копирование снова разрешено" else "Копировать и пересылать сообщения этого чата теперь нельзя обоим"

  /** «Автоудаление»: `pick` gets a new value only (the sheet closes either way). */
  fun autoDeleteSheet(context: Context, current: Int, pick: (Int) -> Unit) {
    val choices = autoDelete.map { ttl ->
      ChoiceSheet.Choice(if (ttl == current) "ion:checkmark-circle" else "ion:ellipse-outline", if (ttl != 0) autoDeleteLabel(ttl) else "Выключено") { if (ttl != current) pick(ttl) }
    }
    ChoiceSheet(context, "Автоудаление", "Новые сообщения в этом чате удалятся у вас обоих через выбранное время. Собеседник увидит, что автоудаление включено.", choices).show()
  }

  /** «Очистить историю?» → «Удалить у обоих». */
  fun clearSheet(context: Context, name: String, confirm: () -> Unit) {
    ChoiceSheet(context, "Очистить историю?", "", listOf(ChoiceSheet.Choice("ion:trash-outline", "Удалить у обоих", "Все сообщения исчезнут у тебя и у $name. Вернуть не получится.", danger = true, run = confirm))).show()
  }

  /** `icon`: the reference's MenuItem icon (an Ionicons name). */
  class Item(val title: String, val danger: Boolean = false, val icon: String = "", val run: () -> Unit)

  /** The items of «Ещё» that belong to the chat, in the reference's order: «Автоудаление · …», «Запретить /
   *  Разрешить пересылку и копирование», «Обои», «Поиск»; and, apart, «Очистить историю». */
  fun menuItems(link: ProfileChatLink, profile: View, name: String, notice: (String) -> Unit): Pair<List<Item>, Item> {
    val context = profile.context
    val ttl = link.ttl; val noCopy = link.noCopy
    val top = ArrayList<Item>()
    top.add(Item("Автоудаление · " + autoDeleteLabel(ttl), icon = "timer-outline") {
      autoDeleteSheet(context, link.ttl) { next -> link.setRules(next, link.noCopy); notice(autoDeleteNotice(next)) }
    })
    top.add(Item(if (noCopy) "Разрешить пересылку и копирование" else "Запретить пересылку и копирование", icon = if (noCopy) "lock-closed" else "lock-open-outline") {
      profile.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
      link.setRules(link.ttl, !noCopy)
      notice(noCopyNotice(noCopy))
    })
    if (link.canWallpaper) top.add(Item("Обои", icon = "image-outline") { link.openWallpaper(profile) })
    if (link.canSearch) top.add(Item("Поиск", icon = "search-outline") { link.openSearch(profile) })
    val clear = Item("Очистить историю", danger = true, icon = "trash-bin-outline") {
      clearSheet(context, name) { link.clearForBoth(); notice("История очищена у обоих") }
    }
    return top to clear
  }
}

/** «Фото · Видео · Файлы · Голосовые · Ссылки» (SharedMedia.tsx): everything shared in the chat, from the history
 *  decrypted on this device — nothing is asked from the server. Only tabs with something in them are shown; a
 *  sideways swipe over the content moves between them (the content follows the finger at 0.35 and dims). */
class SharedMediaView(context: Context) : LinearLayout(context) {
  enum class Tab { PHOTOS, VIDEOS, FILES, VOICE, LINKS }

  private class Item(val attachment: Map<String, Any?>, val message: Map<String, Any?>)
  private class LinkItem(val url: String, val message: Map<String, Any?>)

  /** A touch on a photo, a video, a file or a voice message: the message's row key and its attachment. */
  var onOpen: ((String, Map<String, Any?>) -> Unit)? = null

  private val strip = HorizontalScrollView(context)
  private val stripRow = LinearLayout(context)
  private val body = FrameLayout(context)
  private var photos = listOf<Item>(); private var videos = listOf<Item>(); private var files = listOf<Item>(); private var voice = listOf<Item>(); private var links = listOf<LinkItem>()
  private var tabs = listOf<Pair<Tab, String>>()
  private var active: Tab? = null
  private var builtWidth = 0

  companion object {
    private val urlPattern = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE)
    private val invitePattern = Regex("(^|[\\s(«\"'])(?:(?:invizent|linea)://invite/|https://(?:(?:api\\.)?invizent\\.com|141-133-194-51\\.nip\\.io)/i/)([A-Za-z0-9]{6,16})(?![A-Za-z0-9])")
    private val voiceName = Regex("^voice-[0-9]{1,16}\\.m4a$")
    private val noteName = Regex("^circle-[0-9]{1,16}\\.mp4$")
    private val dayMonths = listOf("янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек.")

    fun isVoice(attachment: Map<String, Any?>) = attachment["mimeType"] == "audio/mp4" && voiceName.matches(attachment["name"] as? String ?: "")
    fun isVideoNote(attachment: Map<String, Any?>) = attachment["mimeType"] == "video/mp4" && noteName.matches(attachment["name"] as? String ?: "")

    /** media/formats.ts `mediaPreviewKind` (photo/formats.ts `isPhotoCandidate` first). */
    fun kind(attachment: Map<String, Any?>): String {
      val type = attachment["mimeType"] as? String ?: ""
      val name = attachment["name"] as? String ?: ""
      fun matches(pattern: String, text: String) = Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(text)
      if (matches("^image/", type) || matches("\\.(?:jpe?g|png|webp|hei[cf]|hif|bmp|tiff?|gif|avif|dng|nef|arw|cr2|cr3|raf|orf|rw2|srw|pef|dcr|raw|psd|psb|svg|jxl|jp2|j2k|jpf|jpx|exr|hdr|pic|tga|ico|cur|pcx|pnm|ppm|pgm|pbm|dds|qoi)$", name)) return "photo"
      if (matches("^video/", type) || matches("\\.(?:mp4|m4v|mov|qt|3gp|3g2|mkv|webm|avi|wmv|asf|flv|f4v|mpg|mpeg|mpe|m2v|mts|m2ts|ts|vob|ogv|mxf)$", name)) return "video"
      if (matches("^audio/", type) || matches("\\.(?:mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|alac|amr|caf|wma)$", name)) return "audio"
      return "file"
    }

    /** theme.ts `formatSize` (Russian units). */
    fun size(bytes: Long): String = when {
      bytes < 1024 -> "$bytes Б"
      bytes < 1024 * 1024 -> String.format(Locale.ROOT, "%.0f КБ", bytes / 1024.0)
      bytes >= 1024L * 1024 * 1024 -> String.format(Locale.ROOT, "%.1f ГБ", bytes / 1024.0 / 1024 / 1024)
      else -> String.format(Locale.ROOT, "%.1f МБ", bytes / 1024.0 / 1024)
    }

    /** The links of a text, without invitations, trailing punctuation cut. */
    fun linksOf(text: String): List<String> = urlPattern.findAll(text).map { it.value }.filter { !invitePattern.containsMatchIn(it) }.map { it.replace(Regex("[).,!?»]+$"), "") }.toList()

    /** The tabs there are for these counts, in the reference's order. */
    fun tabsFor(photos: Int, videos: Int, files: Int, voice: Int, links: Int): List<Pair<Tab, String>> = listOfNotNull(
      if (photos > 0) Tab.PHOTOS to "Фото" else null, if (videos > 0) Tab.VIDEOS to "Видео" else null, if (files > 0) Tab.FILES to "Файлы" else null,
      if (voice > 0) Tab.VOICE to "Голосовые" else null, if (links > 0) Tab.LINKS to "Ссылки" else null,
    )

    /** listSwipes.ts `pageRelease`: where a released sideways swipe lands. */
    fun pageRelease(index: Int, count: Int, translation: Float, velocity: Float, width: Float): Int {
      if (count <= 1 || width <= 0f) return index
      val flickBack = translation != 0f && (velocity < 0) != (translation < 0) && velocity != 0f && Math.abs(velocity) > 300
      var step = 0
      if (!flickBack && (Math.abs(translation) > width * 0.25f || Math.abs(velocity) > 600)) step = if (translation < 0 || (translation == 0f && velocity < 0)) 1 else -1
      return (index + step).coerceIn(0, count - 1)
    }
  }

  init {
    orientation = VERTICAL
    strip.isHorizontalScrollBarEnabled = false
    strip.background = context.plate(Theme.surface2, 18f)
    stripRow.orientation = HORIZONTAL
    stripRow.setPadding(context.px(4f), context.px(4f), context.px(4f), context.px(4f))
    strip.addView(stripRow)
    addView(strip, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(body, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(10f) })
    visibility = GONE
  }

  /** The chat's messages, oldest first (each with its `rowKey`). */
  fun show(messages: List<Map<String, Any?>>) {
    val p = ArrayList<Item>(); val v = ArrayList<Item>(); val f = ArrayList<Item>(); val a = ArrayList<Item>(); val l = ArrayList<LinkItem>()
    for (message in messages.reversed()) {
      com.linea.messenger.core.Core.map(message["attachment"] as? Map<*, *>)?.let { attachment ->
        val item = Item(attachment, message)
        when {
          isVoice(attachment) || isVideoNote(attachment) -> a.add(item)
          kind(attachment) == "photo" -> p.add(item)
          kind(attachment) == "video" -> v.add(item)
          else -> f.add(item)
        }
      }
      val text = message["text"] as? String ?: ""
      if (text.isNotEmpty()) for (url in linksOf(text)) l.add(LinkItem(url, message))
    }
    photos = p; videos = v; files = f; voice = a; links = l
    tabs = tabsFor(p.size, v.size, f.size, a.size, l.size)
    if (active != null && tabs.none { it.first == active }) active = null
    if (active == null) active = tabs.firstOrNull()?.first
    visibility = if (tabs.isEmpty()) GONE else VISIBLE
    rebuild()
  }

  fun select(tab: Tab) {
    if (tabs.none { it.first == tab }) return
    active = tab
    rebuild()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w != builtWidth) post { rebuild() }
  }

  private fun rebuild() {
    builtWidth = width
    stripRow.removeAllViews()
    body.removeAllViews()
    val active = active ?: return
    if (width <= 0) return
    for ((tab, label) in tabs) {
      val on = tab == active
      val button = context.words(label, 14f, if (on) Theme.accent else Theme.text, 600)
      button.setPadding(context.px(14f), context.px(8f), context.px(14f), context.px(8f))
      button.background = if (on) context.plate(Theme.alpha(Theme.accent, 0.16f), 14f) else null
      button.isClickable = true; button.isSelected = on
      button.setOnClickListener { this.active = tab; rebuild() }
      stripRow.addView(button)
    }
    body.addView(when (active) {
      Tab.PHOTOS -> grid(photos)
      Tab.VIDEOS -> grid(videos)
      Tab.FILES -> list(files, voiceList = false)
      Tab.VOICE -> list(voice, voiceList = true)
      Tab.LINKS -> linkList()
    })
  }

  /** Three columns with 2 dp between, rounded 14 as a whole; a video shows its length. */
  private fun grid(items: List<Item>): View {
    val gap = context.px(2f)
    val cell = (width - 2 * gap) / 3
    val holder = FrameLayout(context)
    holder.background = context.plate(0, 14f)
    holder.clipToOutline = true
    items.forEachIndexed { index, item ->
      val tile = FrameLayout(context)
      tile.setBackgroundColor(Theme.surface2)
      val picture = ImageView(context)
      picture.scaleType = ImageView.ScaleType.CENTER_CROP
      val base64 = com.linea.messenger.core.Core.map(item.attachment["preview"] as? Map<*, *>)?.get("base64") as? String ?: ""
      val bitmap = try { Base64.decode(base64, Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) } } catch (_: Throwable) { null }
      if (bitmap != null) {
        picture.setImageBitmap(bitmap)
        tile.addView(picture, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      } else tile.addView(ProfileIconView(context, "ion:image-outline", 22f, Theme.muted), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      val video = kind(item.attachment) == "video"
      if (video) {
        val ms = (com.linea.messenger.core.Core.map(item.attachment["media"] as? Map<*, *>)?.get("durationMs") as? Number)?.toLong() ?: 0L
        val seconds = ms / 1000
        val length = context.words(String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60), 11f, 0xFFFFFFFF.toInt(), 600)
        length.background = context.plate(0x80000000.toInt(), 6f)
        length.setPadding(context.px(5f), context.px(2f), context.px(5f), context.px(2f))
        tile.addView(length, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply { leftMargin = context.px(5f); bottomMargin = context.px(5f) })
      }
      tile.contentDescription = if (video) "Видео" else "Фото"
      tile.isClickable = true
      val key = item.message["rowKey"] as? String ?: ""
      tile.setOnClickListener { onOpen?.invoke(key, item.attachment) }
      holder.addView(tile, FrameLayout.LayoutParams(cell, cell).apply { leftMargin = (index % 3) * (cell + gap); topMargin = (index / 3) * (cell + gap) })
    }
    val rows = (items.size + 2) / 3
    holder.minimumHeight = if (rows == 0) 0 else rows * cell + (rows - 1) * gap
    return holder
  }

  private fun plate(): LinearLayout = LinearLayout(context).apply {
    orientation = VERTICAL
    background = context.plate(Theme.surface2, 16f)
    setPadding(0, context.px(4f), 0, context.px(4f))
  }

  private fun row(icon: View, title: String, titleColor: Int, titleSize: Float, bold: Boolean, subtitle: String, run: () -> Unit): View {
    val line = LinearLayout(context)
    line.orientation = HORIZONTAL
    line.gravity = Gravity.CENTER_VERTICAL
    line.setPadding(context.px(12f), context.px(9f), context.px(12f), context.px(9f))
    line.addView(icon, LayoutParams(context.px(42f), context.px(42f)))
    val texts = LinearLayout(context).apply { orientation = VERTICAL }
    texts.addView(context.words(title, titleSize, titleColor, if (bold) 600 else 400).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    texts.addView(context.words(subtitle, 12f, Theme.muted).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = context.px(3f) })
    line.addView(texts, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = context.px(12f) })
    line.isClickable = true
    line.contentDescription = "$title, $subtitle"
    line.setOnClickListener { run() }
    return line
  }

  private fun dayWords(text: String?): String {
    val at = Messenger.date(text)?.atZone(ZoneId.systemDefault()) ?: return ""
    return "${at.dayOfMonth} ${dayMonths[at.monthValue - 1]} ${at.year} г."
  }

  private fun list(items: List<Item>, voiceList: Boolean): View {
    val stack = plate()
    for (item in items) {
      val note = isVideoNote(item.attachment)
      val icon = FrameLayout(context)
      icon.background = context.plate(Theme.accent, if (voiceList) 21f else 10f)
      icon.addView(ProfileIconView(context, if (voiceList) (if (note) "ion:videocam" else "ion:play") else "ion:document-text", 20f, Theme.onAccent), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      val title = if (voiceList) (if (note) "Видеосообщение" else "Голосовое сообщение") else (item.attachment["name"] as? String ?: "Файл")
      val bytes = (item.attachment["size"] as? Number)?.toLong() ?: 0L
      val key = item.message["rowKey"] as? String ?: ""
      stack.addView(row(icon, title, Theme.text, 15f, true, size(bytes) + " · " + dayWords(item.message["createdAt"] as? String)) { onOpen?.invoke(key, item.attachment) })
    }
    return stack
  }

  private fun linkList(): View {
    val stack = plate()
    for (item in links) {
      val bare = item.url.replace(Regex("^https?://(www\\.)?", RegexOption.IGNORE_CASE), "")
      val icon = context.words(bare.firstOrNull()?.uppercase() ?: "?", 17f, Theme.accent, 700)
      icon.gravity = Gravity.CENTER
      icon.background = context.plate(Theme.alpha(Theme.accent, 0.16f), 10f)
      val shown = item.url.replace(Regex("^https?://", RegexOption.IGNORE_CASE), "")
      stack.addView(row(icon, shown, Theme.accent, 14f, false, item.message["text"] as? String ?: "") {
        // As the reference (Linking.openURL): the link opens in the system's browser.
        try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.url))) } catch (_: Exception) {}
      })
    }
    return stack
  }

  // The sideways swipe (listSwipes.ts axisLock, pageRelease)

  private var downX = 0f; private var downY = 0f; private var swiping = false; private var downAt = 0L
  private val slop = ViewConfiguration.get(context).scaledTouchSlop

  private val activeIndex: Int get() = maxOf(0, tabs.indexOfFirst { it.first == active })

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    if (tabs.size < 2) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { downX = event.x; downY = event.y; swiping = false; downAt = event.eventTime }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.x - downX; val dy = event.y - downY
        // Mostly sideways (2:1); right on the first tab and left on the last are left to the screen.
        if (Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy) * 2 && event.y > body.top) {
          if ((activeIndex == 0 && dx > 0) || (activeIndex == tabs.size - 1 && dx < 0)) return false
          swiping = true
          parent?.requestDisallowInterceptTouchEvent(true)
          return true
        }
      }
    }
    return false
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!swiping) return super.onTouchEvent(event)
    val dx = event.x - downX
    val motion = com.linea.messenger.avatars.AvatarMotion.enabled(context)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        val shift = if (motion) dx * 0.35f else 0f
        com.linea.messenger.effects.MotionBlur.attach(body) // MotionBlur: blurred along its move on screens below 90 Hz
        body.translationX = shift
        body.alpha = 1 - minOf(0.4f, Math.abs(shift) / (300 * resources.displayMetrics.density))
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val seconds = maxOf(0.016f, (event.eventTime - downAt) / 1000f)
        val to = pageRelease(activeIndex, tabs.size, dx / resources.displayMetrics.density, dx / resources.displayMetrics.density / seconds, width / resources.displayMetrics.density)
        body.animate().translationX(0f).alpha(1f).setDuration(if (motion) 180 else 0).start()
        if (event.actionMasked == MotionEvent.ACTION_UP && to != activeIndex) {
          performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          active = tabs[to].first
          rebuild()
        }
        swiping = false
      }
    }
    return true
  }
}
