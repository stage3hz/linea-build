package com.linea.messenger.music

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.linea.messenger.ai.AIIconButton
import com.linea.messenger.ai.AIIconView
import com.linea.messenger.ai.AIIcons
import com.linea.messenger.ai.AIKit
import com.linea.messenger.ai.AIRoundButton
import com.linea.messenger.ai.AIShare
import com.linea.messenger.ai.AISheet
import com.linea.messenger.ai.AIWideButton
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.Picks
import com.linea.messenger.design.BarMetrics
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen
import java.io.File

/** The words of «Музыка» that are worked out: plain functions, so they can be checked without a phone. */
object MusicWords {
  fun badge(source: String): String = if (source == "local") "НА УСТРОЙСТВЕ" else if (source == "soundcloud") "SOUNDCLOUD" else "AUDIUS"

  /** The line under a track's title in a list. */
  fun rowLine(track: MusicTrack): String = track.artist + (if (track.duration > 0) " · " + MusicCatalog.time(track.duration) else "") + " · " + badge(track.source)

  /** Where a track comes from, in the full player. */
  fun origin(source: String): String = if (source == "audius") "AUDIUS · ОНЛАЙН" else if (source == "soundcloud") "SOUNDCLOUD" else "НА ЭТОМ УСТРОЙСТВЕ"

  /** The line of the strip above the bar. */
  fun miniLine(artist: String, error: Boolean, loading: Boolean): String = if (error) "Есть сообщение · открыть" else if (loading) "Загружаем трек…" else artist

  fun mixLine(mood: String?): String = if (mood == null) "Новые имена и любимый звук" else "Настроение: " + (MusicCatalog.moods.firstOrNull { it.apiMood == mood }?.label ?: "")

  /** What an empty list says: the heading and the words under it. `more`: there is a next page. */
  fun empty(section: String, more: Boolean, service: String): Pair<String, String> = when {
    section == "saved" -> "Свой звук" to "Добавь аудиофайлы с устройства. Они останутся здесь и не загрузятся на сервер мессенджера."
    section == "favorites" -> "Любимое будет здесь" to "Нажми на сердечко рядом с понравившимся треком."
    more -> "Посмотрим следующую страницу" to "На этой странице нет треков с выбранным доступом. Нажми «Показать ещё» или измени фильтры."
    else -> "Попробуем другой запрос" to "Измени название или настроение. Каталог $service отличается от других музыкальных сервисов."
  }

  fun footer(source: String): String = if (source == "soundcloud") "Треки и авторы — SoundCloud. Нажми «⋯», чтобы открыть трек на soundcloud.com." else "Музыка предоставлена авторами через Audius."

  /** What «О музыке» says. */
  fun about(soundCloud: Boolean): List<String> = listOf(
    "Здесь доступны публичные треки Audius, которые авторы открыли для сторонних плееров. Инвиз не добавляет рекламу. Доступность и качество записи определяет источник; это не полный каталог Яндекс Музыки или SoundCloud.",
    "Кнопка скачивания открывает официальный адрес Audius и появляется только при разрешении автора. Потоки не сохраняются в постоянный кэш приложения. Для личного офлайн-прослушивания можно добавить свои аудиофайлы через «+».",
    "При поиске и прослушивании Audius получает запросы и сетевые данные соединения. Токен мессенджера туда не отправляется. Импортированные файлы остаются на устройстве.",
    "Музыка принадлежит указанным авторам. Учитывай лицензию конкретного трека; для материалов Audius может применяться Open Music License или отдельная лицензия автора.",
  ) + if (soundCloud) listOf("SoundCloud подключён через сервер Инвиза по официальному API: в нём видны только треки, которые SoundCloud разрешает слушать в сторонних приложениях. Подписка SoundCloud Go здесь не действует, скачивания и офлайна нет. Треки SoundCloud и Audius играют отдельными очередями.") else emptyList()

  fun links(soundCloud: Boolean): List<Pair<String, String>> =
    (if (soundCloud) listOf("Правила SoundCloud API" to "https://developers.soundcloud.com/policies") else emptyList()) +
      listOf("Условия Audius API" to "https://audius.co/documents/ApiTerms.pdf", "Конфиденциальность Audius" to "https://audius.co/documents/PrivacyPolicy.pdf", "Open Music License" to "https://audius.org/open-music-license.pdf")
}

/** Opens an https address in the app the system chooses. False when nothing opened. */
fun openMusicLink(context: Context, address: String?): Boolean {
  if (address == null || !address.startsWith("https://", ignoreCase = true)) return false
  return try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address))); true } catch (_: Exception) {
    try { AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Ссылка не открылась").setMessage("Попробуй ещё раз.").setPositiveButton("Понятно", null).show() } catch (_: Exception) { /* the window is gone */ }
    false
  }
}

/** A track's cover: the picture, or a note on a quiet square while there is none. */
@SuppressLint("ViewConstructor")
class MusicCoverView(context: Context, private val radius: Float) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val from = Rect()
  private val into = Rect()
  private var track: MusicTrack? = null
  private val arrived: (String) -> Unit = { id -> if (id == track?.id) invalidate() }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    clipToOutline = true
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, radius * d)
    }
  }

  fun bind(track: MusicTrack?) {
    if (this.track?.id == track?.id && this.track?.artworkUrl == track?.artworkUrl) return
    this.track = track
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    MusicCovers.ready.watch(arrived)
  }

  override fun onDetachedFromWindow() {
    MusicCovers.ready.unwatch(arrived)
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    paint.color = Theme.veil(0.07f)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    val picture = track?.let { MusicCovers.image(it) }
    if (picture == null) {
      AIIcons.draw(canvas, "note", width / 2f, height / 2f, minOf(width, height) * 0.46f, Theme.muted)
      return
    }
    // Fills the square: the middle of a picture that is not one.
    val side = minOf(picture.width, picture.height)
    from.set((picture.width - side) / 2, (picture.height - side) / 2, (picture.width + side) / 2, (picture.height + side) / 2)
    into.set(0, 0, width, height)
    paint.color = Color.WHITE
    canvas.drawBitmap(picture, from, into, paint)
  }
}

/** A capsule with a picture and a word: a mood, or a switch of the player. */
@SuppressLint("ViewConstructor")
class MusicChip(context: Context, label: String, symbol: String, selected: Boolean) : LinearLayout(context) {
  private val icon = AIIconView(context, symbol, 14f, Theme.text)
  private val text = AIKit.label(context, label, 14f, 500, lines = 1)

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(12f), 0, context.px(12f), 0)
    addView(icon, LayoutParams(context.px(16f), context.px(16f)).apply { marginEnd = context.px(6f) })
    addView(text)
    isClickable = true
    isFocusable = true
    show(label, symbol, selected)
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  fun show(label: String, symbol: String, selected: Boolean) {
    background = context.plate(if (selected) Theme.text else Theme.veil(0.08f), 19f)
    val ink = if (selected) Theme.onAccent else Theme.text
    icon.symbol = symbol
    icon.color = ink
    text.text = label
    text.setTextColor(ink)
    isSelected = selected
    contentDescription = label
  }
}

/** One of several, side by side: the chosen one is filled. */
@SuppressLint("ViewConstructor")
class MusicSegments(context: Context, labels: List<String>, spoken: String = "") : LinearLayout(context) {
  var onPick: ((Int) -> Unit)? = null
  private val buttons = ArrayList<TextView>()
  var chosen = 0
    set(value) { field = value; paint() }

  init {
    orientation = HORIZONTAL
    background = context.plate(Theme.veil(0.07f), 14f)
    setPadding(context.px(3f), context.px(3f), context.px(3f), context.px(3f))
    labels.forEachIndexed { index, label ->
      val button = AIKit.label(context, label, 13f, 500, lines = 1, align = Gravity.CENTER)
      button.isClickable = true
      button.isFocusable = true
      button.contentDescription = if (spoken.isEmpty()) label else "$spoken: $label"
      button.setOnClickListener { if (index != chosen) { chosen = index; onPick?.invoke(index) } }
      buttons.add(button)
      addView(button, LayoutParams(0, context.px(36f), 1f))
    }
    paint()
  }

  private fun paint() {
    buttons.forEachIndexed { index, button ->
      val on = index == chosen
      button.setTextColor(if (on) Theme.onAccent else Theme.text)
      button.typeface = Theme.weight(if (on) 700 else 500)
      button.background = if (on) context.plate(Theme.accent, 11f) else null
      button.isSelected = on
    }
  }
}

/** The strip above the bar while a track is chosen: cover, title, the controls. A touch opens the player,
 *  a swipe down stops the music and takes the strip away. */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class MiniPlayerView(context: Context, private val player: MusicPlayer) : LinearLayout(context) {
  var onOpen: (() -> Unit)? = null
  private val d = resources.displayMetrics.density
  private val cover = MusicCoverView(context, 8f)
  private val heading = AIKit.label(context, "", 14f, 700, lines = 1)
  private val line = AIKit.label(context, "", 12f, color = Theme.muted, lines = 1)
  private val back = AIIconButton(context, "prev", 18f, Theme.text, "Предыдущий трек или начало текущего")
  private val toggle = AIIconButton(context, "play", 20f, Theme.text, "Слушать")
  private val forward = AIIconButton(context, "next", 18f, Theme.text, "Следующий трек")
  private val close = AIIconButton(context, "xmark", 16f, Theme.muted, "Закрыть плеер и остановить музыку")
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val changed: () -> Unit = { refresh() }
  private val swipe = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(event: MotionEvent): Boolean = true
    override fun onSingleTapUp(event: MotionEvent): Boolean { onOpen?.invoke(); return true }
    override fun onFling(first: MotionEvent?, second: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
      val down = second.y - (first?.y ?: second.y)
      if (down > 24 * d && velocityY > Math.abs(velocityX)) { player.stop(); return true }
      return false
    }
  })

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setWillNotDraw(false)
    background = context.plate(Theme.panel(0xF71E1F21.toInt()), 24f, Theme.veil(0.1f))
    setPadding(context.px(10f), context.px(8f), context.px(6f), context.px(8f))
    addView(cover, LayoutParams(context.px(46f), context.px(46f)))
    val words = LinearLayout(context).apply { orientation = VERTICAL }
    words.addView(heading)
    AIKit.add(words, line, 4f)
    addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = context.px(11f); marginEnd = context.px(6f) })
    for (button in listOf(back, toggle, forward, close)) addView(button, LayoutParams(context.px(36f), context.px(44f)))
    back.setOnClickListener { player.previous() }
    toggle.setOnClickListener { player.togglePlayback() }
    forward.setOnClickListener { player.next() }
    close.setOnClickListener { player.stop() }
    isClickable = true
    isFocusable = true
    setOnClickListener { onOpen?.invoke() }
    setOnTouchListener { _, event -> swipe.onTouchEvent(event) }
    refresh()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    player.changed.watch(changed)
    refresh()
  }

  override fun onDetachedFromWindow() {
    player.changed.unwatch(changed)
    super.onDetachedFromWindow()
  }

  /** How far the track has gone, as a thin line along the lower edge. */
  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    val left = 15f * d; val wide = maxOf(0f, width - 30f * d); val top = height - 2f * d
    paint.color = Theme.veil(0.1f)
    canvas.drawRect(left, top, left + wide, height.toFloat(), paint)
    val part = if (player.duration > 0) (player.position / player.duration).coerceIn(0.0, 1.0) else 0.0
    paint.color = Theme.accent
    canvas.drawRect(left, top, left + wide * part.toFloat(), height.toFloat(), paint)
  }

  private fun refresh() {
    val current = player.current
    val shown = if (current == null) View.GONE else View.VISIBLE
    if (visibility != shown) visibility = shown
    if (current == null) return
    cover.bind(current)
    if (heading.text.toString() != current.title) heading.text = current.title
    val words = MusicWords.miniLine(current.artist, player.error.isNotEmpty(), player.loading)
    if (line.text.toString() != words) line.text = words
    line.setTextColor(if (player.error.isEmpty()) Theme.muted else Theme.danger)
    toggle.symbol = if (player.playing) "pause" else "play"
    toggle.contentDescription = if (player.playing) "Пауза" else "Слушать"
    forward.isEnabled = player.queue.size >= 2
    contentDescription = "${current.title}, ${current.artist}. Смахни вниз, чтобы остановить музыку и убрать плеер"
    invalidate()
  }
}

/** One track of a list. */
@SuppressLint("ViewConstructor")
class MusicTrackCell(context: Context) : LinearLayout(context) {
  private val cover = MusicCoverView(context, 6f)
  private val heading = AIKit.label(context, "", 15f, 600, lines = 1)
  private val line = AIKit.label(context, "", 12f, color = Theme.muted, lines = 1)
  private val heart = AIIconButton(context, "heart", 20f, Theme.muted)
  private val more = AIIconButton(context, "more", 20f, Theme.muted)
  var onHeart: (() -> Unit)? = null
  var onMore: (() -> Unit)? = null

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.px(18f), context.px(7f), context.px(10f), context.px(7f))
    layoutParams = AbsListView.LayoutParams(AbsListView.LayoutParams.MATCH_PARENT, context.px(66f))
    addView(cover, LayoutParams(context.px(52f), context.px(52f)))
    val words = LinearLayout(context).apply { orientation = VERTICAL }
    words.addView(heading)
    AIKit.add(words, line, 3f)
    addView(words, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = context.px(12f); marginEnd = context.px(4f) })
    addView(heart, LayoutParams(context.px(40f), context.px(44f)))
    addView(more, LayoutParams(context.px(36f), context.px(44f)))
    // The row itself stays pressable around its buttons.
    heart.isFocusable = false
    more.isFocusable = false
    heart.setOnClickListener { onHeart?.invoke() }
    more.setOnClickListener { onMore?.invoke() }
  }

  fun show(track: MusicTrack, current: Boolean, favorite: Boolean) {
    cover.bind(track)
    heading.text = track.title
    heading.setTextColor(if (current) Theme.onBlack(Color.WHITE, Theme.accent) else Theme.text)
    line.text = MusicWords.rowLine(track)
    heart.symbol = if (favorite) "heart.fill" else "heart"
    heart.color = if (favorite) Theme.text else Theme.muted
    heart.contentDescription = if (favorite) "Убрать из любимого: ${track.title}" else "В любимое: ${track.title}"
    more.contentDescription = "Действия: ${track.title}"
    contentDescription = "Слушать: ${track.title}, ${track.artist}"
  }
}

/** The «Музыка» section: the catalogue (SoundCloud through the person's server, or Audius), the favourites and
 *  the person's own files; the strip of the playing track above the bar. After mobile/src/music/MusicScreen.tsx
 *  (iOS: Music/MusicViewController.swift). */
@SuppressLint("ViewConstructor")
class MusicScreen(context: Context, private val messenger: Messenger?) : Screen(context) {
  private class Cached(val at: Long, val tracks: List<MusicTrack>, val nextOffset: Int?)

  companion object {
    private const val sourceKey = "linea.music-source.v1"
    private val catalogCache = HashMap<String, Cached>()
  }

  /** A debug build's look without an account: sample tracks, no network, no sound. */
  private val fixed = messenger == null && MusicDemo.mode != null
  private val player: MusicPlayer = if (fixed) MusicPlayer.shared else MusicHost.attach(context)
  private val prefs = context.getSharedPreferences("linea.music", Context.MODE_PRIVATE)
  private val main = Handler(Looper.getMainLooper())

  /** catalog · favorites · saved */
  private var section = "catalog"
  private var query = ""
  private var mood: String? = null
  private var chosen = "soundcloud"
  private var scReady = false
  private var sourceNotice = ""
  private var tracks: List<MusicTrack> = emptyList()
  private var nextOffset: Int? = null
  private var loading = false
  private var loadingMore = false
  private var failure = ""
  private var generation = 0
  private var started = false
  private var lastMark = ""
  private var shownRows: List<MusicTrack> = emptyList()
  /** The copy of a file another app was last given to read. */
  private var shared: File? = null
  private val typing = Runnable {
    val wanted = search.text.toString().trim()
    if (wanted != query) {
      query = wanted
      reloadCatalog()
      refresh()
    }
  }
  private val playerChanged: () -> Unit = {
    // The position changes several times a second: the page is redrawn only when what it shows has changed.
    val mark = "${player.current?.id ?: ""}|${player.error}|${player.notice}|${player.favorites.size}|${player.saved.size}|${player.playing}"
    if (mark != lastMark) { lastMark = mark; refresh() }
  }

  private val list = ListView(context)
  private val column = LinearLayout(context)
  // F: the reference's top (MusicScreen.tsx): on the cold ambient, «Музыка» with round glass «+» and «i», the tabs as
  // a plain row with an `ink` pill on the chosen one, the source switch, and the large centred «Слушать микс»; it is
  // `MusicInk.headHeight` tall from the screen's top. Then the search on glass, the shelves, the moods (tall chips),
  // «ОТКРОЙ ДЛЯ СЕБЯ».
  private val aiPainter: com.linea.messenger.design.IconPainter = { c, n, x, y, size, color -> AIIcons.draw(c, n, x, y, size, color) }
  private val addButton = com.linea.messenger.design.GlassRoundButton(context, "plus", "Добавить аудиофайлы", 21f, painter = aiPainter)
  private val tabs = MusicTabs(context, listOf("Главная", "Любимое", "Мои файлы"))
  private val searchBox = FrameLayout(context)
  private val search = EditText(context)
  private val sources = MusicSourceSwitch(context, listOf("SoundCloud", "Audius"), "Источник музыки")
  private val headStack = LinearLayout(context)
  private lateinit var headBox: MusicHeadBox
  private val sectionWords = AIKit.label(context, "", 12f, color = Theme.muted)
  private val moodScroll = HorizontalScrollView(context)
  private val moodRow = LinearLayout(context)
  private val mixRow = LinearLayout(context)
  private val mixButton = AIRoundButton(context, "play", "Слушать микс", size = 66f, icon = 28f)
  private val mixLine = AIKit.label(context, "", 14f, color = MusicInk.soft, lines = 1, align = Gravity.CENTER)
  private val caption = AIKit.label(context, "", 11f, 700, Theme.muted, lines = 1)
  private val notices = LinearLayout(context)
  private val footer = LinearLayout(context)
  private val mini = MiniPlayerView(context, player)
  /** Music: «Любимое» and «Артисты» on «Главная» while nothing is searched (music/MusicShelves.kt); the living light
   *  behind the top of the page (effects/MusicAmbient.kt). */
  private val shelves = LinearLayout(context)
  private var shelvesMark = ""
  private val ambient = com.linea.messenger.effects.MusicAmbientView(context, com.linea.messenger.effects.MusicAmbientView.themeTone, fade = true)
  private var listHead: View? = null

  private val source: String get() = if (scReady && chosen == "soundcloud") "soundcloud" else "audius"

  private val rows: List<MusicTrack>
    get() {
      if (section == "catalog") return tracks
      val all = if (section == "favorites") player.favorites else player.saved
      val needle = query.lowercase()
      return if (needle.isEmpty()) all else all.filter { (it.title + " " + it.artist).lowercase().contains(needle) }
    }

  private val adapter = object : BaseAdapter() {
    override fun getCount() = shownRows.size
    override fun getItem(position: Int) = shownRows[position]
    override fun getItemId(position: Int) = position.toLong()
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val cell = convertView as? MusicTrackCell ?: MusicTrackCell(context)
      val track = shownRows[position]
      cell.show(track, current = player.current?.id == track.id, favorite = player.isFavorite(track))
      cell.onHeart = { player.toggleFavorite(track) }
      cell.onMore = { showMenu(track) }
      return cell
    }
  }

  init {
    setBackgroundColor(Theme.bg)
    build()
    if (fixed) {
      tracks = MusicDemo.tracks
      if (tracks.size >= 4) player.showSample(tracks, tracks[1], 74.0, listOf(tracks[0], tracks[3]))
    } else {
      prefs.getString(sourceKey, null)?.takeIf { it == "soundcloud" || it == "audius" }?.let { chosen = it }
      player.server = messenger?.server
    }
    refresh()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    player.changed.watch(playerChanged)
    refresh()
    if (started || fixed) return
    started = true
    MusicCatalog.soundCloudAvailable(messenger?.server) { available ->
      scReady = available
      refresh()
      reloadCatalog()
    }
  }

  override fun onDetachedFromWindow() {
    player.changed.unwatch(playerChanged)
    main.removeCallbacks(typing)
    super.onDetachedFromWindow()
  }

  // The catalogue

  private fun page(offset: Int, done: (Result<MusicPage>) -> Unit) {
    if (source == "soundcloud") MusicCatalog.searchSoundCloud(messenger?.server, query, mood, offset, 24, done)
    else MusicCatalog.searchAudius(query, mood, offset, 24, done)
  }

  private fun reloadCatalog() {
    if (fixed) return
    generation += 1
    val request = generation
    loadingMore = false
    if (section != "catalog") {
      loading = false
      return refresh()
    }
    val key = source + "|" + query + "|" + (mood ?: "")
    failure = ""
    val cached = catalogCache[key]
    if (cached != null && System.currentTimeMillis() - cached.at < 600_000) {
      tracks = cached.tracks
      nextOffset = cached.nextOffset
      loading = false
      return refresh()
    }
    loading = true
    refresh()
    val asked = source
    page(0) { result ->
      if (generation != request) return@page
      loading = false
      val found = result.getOrNull()
      if (found != null) {
        catalogCache[key] = Cached(System.currentTimeMillis(), found.tracks, found.nextOffset)
        tracks = found.tracks
        nextOffset = found.nextOffset
      } else {
        val words = (result.exceptionOrNull() as? MusicFailure)?.words.orEmpty()
        // SoundCloud down or over its daily cap: Audius rather than an empty page.
        if (asked == "soundcloud") {
          sourceNotice = "SoundCloud сейчас недоступен" + (if (words.isEmpty()) "" else ": $words") + ". Показываю Audius."
          chosen = "audius"
          return@page reloadCatalog()
        }
        failure = words.ifEmpty { "Не удалось найти музыку." }
      }
      refresh()
    }
  }

  private fun more() {
    val offset = nextOffset ?: return
    if (loading || loadingMore) return
    loadingMore = true
    failure = ""
    refresh()
    val request = generation
    page(offset) { result ->
      if (generation != request) return@page
      loadingMore = false
      val found = result.getOrNull()
      if (found != null) {
        val known = tracks.map { it.id }.toSet()
        tracks = tracks + found.tracks.filter { it.id !in known }
        nextOffset = found.nextOffset
      } else {
        failure = (result.exceptionOrNull() as? MusicFailure)?.words.orEmpty().ifEmpty { "Не удалось загрузить следующие треки." }
      }
      refresh()
    }
  }

  // Actions

  private fun pickMood(value: String?) {
    // A second touch on the chosen mood takes it off, as in the reference.
    mood = if (value != null && value == mood) null else value
    reloadCatalog()
    refresh()
  }

  private fun mix() { rows.firstOrNull()?.let { player.play(it, rows) } }

  private fun hideKeyboard() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
  }

  /** The system's own chooser: the app is handed only the files the person picked, and asks no permission. */
  private fun addFiles() {
    val activity = context as? Activity ?: return
    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("audio/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    Picks.ask(activity, pick) { uris ->
      if (uris.isEmpty()) return@ask
      val resolver = context.contentResolver
      player.importFiles(uris.map { uri ->
        var name = uri.lastPathSegment ?: "audio"
        var size = 0L
        try {
          resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
              cursor.getString(0)?.takeIf { it.isNotEmpty() }?.let { name = it }
              if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
          }
        } catch (_: Exception) { /* the name and the size stay unknown */ }
        MusicIncoming(name, size, try { resolver.getType(uri) } catch (_: Exception) { null }) { resolver.openInputStream(uri) }
      })
    }
  }

  private fun showMenu(track: MusicTrack) {
    val sheet = AISheet(context, track.title)
    sheet.addRow("Слушать", symbol = "play") { sheet.dismiss(); player.play(track, rows) }
    val favorite = player.isFavorite(track)
    sheet.addRow(if (favorite) "Убрать из любимого" else "В любимое", symbol = if (favorite) "heart.fill" else "heart") { sheet.dismiss(); player.toggleFavorite(track) }
    if (track.sourceUrl != null) {
      sheet.addRow(if (track.source == "soundcloud") "Открыть в SoundCloud" else "Открыть источник", symbol = "link") { sheet.dismiss(); openMusicLink(context, track.sourceUrl) }
    }
    if (track.source == "audius" && track.downloadable) {
      sheet.addRow("Скачать через Audius", "Откроется официальная загрузка трека", "download") {
        sheet.dismiss()
        MusicCatalog.resolveDownload(track) { result ->
          val address = result.getOrNull()
          if (address == null) player.report((result.exceptionOrNull() as? MusicFailure)?.words.orEmpty())
          else {
            openMusicLink(context, address)
            player.say("Скачивание открыто через Audius. Сохранённый файл можно добавить сюда через «Добавить файлы».")
          }
        }
      }
    }
    if (track.source == "local") {
      sheet.addRow("Поделиться файлом", symbol = "share") {
        sheet.dismiss()
        val file = player.file(track)?.takeIf { it.isFile } ?: return@addRow player.report("Сохранённый файл не найден.")
        val name = track.fileName?.substringAfterLast('/')?.takeIf { it.isNotEmpty() && it != "." && it != ".." } ?: file.name
        shared = AIShare.send(context, file, shared, name) ?: run { player.report("Сохранённый файл не найден."); null }
      }
      sheet.addRow("Убрать из приложения", "Исходный файл на устройстве сохранится", "trash", danger = true) { sheet.dismiss(); player.removeSaved(track) }
    }
    sheet.open()
  }

  private fun showInfo() {
    val sheet = AISheet(context, "О музыке")
    for (text in MusicWords.about(scReady)) sheet.addText(text)
    for ((words, address) in MusicWords.links(scReady)) {
      val button = AIWideButton(context, words, "doc", secondary = true)
      button.setOnClickListener { openMusicLink(context, address) }
      sheet.add(button)
    }
    sheet.open()
  }

  /** The full player over the section (also what `--es musicdemo player` asks for). */
  fun openPlayer() {
    val stack = pages() ?: return
    if (stack.top is PlayerScreen || player.current == null) return
    hideKeyboard()
    stack.push(PlayerScreen(context, player))
  }

  // The page

  private fun build() {
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    list.divider = null; list.dividerHeight = 0
    list.selector = ColorDrawable(Theme.veil(0.06f)); list.cacheColorHint = Color.TRANSPARENT
    list.isVerticalScrollBarEnabled = false; list.clipToPadding = false
    list.setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView?, state: Int) { if (state == AbsListView.OnScrollListener.SCROLL_STATE_TOUCH_SCROLL) hideKeyboard() }
      override fun onScroll(view: AbsListView?, first: Int, visible: Int, total: Int) { placeAmbient() } // Music
    })

    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(18f), dp(8f), dp(18f), dp(10f))
    headStack.orientation = LinearLayout.VERTICAL
    val titleRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    val info = com.linea.messenger.design.GlassRoundButton(context, "info", "О музыкальном разделе", 19f, painter = aiPainter)
    info.tint = MusicInk.ink
    info.onPress = { showInfo() }
    addButton.tint = MusicInk.ink
    addButton.onPress = { addFiles() }
    // TITLE: Unbounded 26, line 32, as the reference's section titles.
    titleRow.addView(AIKit.label(context, "Музыка", 34f, 700, MusicInk.ink, lines = 1).also { com.linea.messenger.design.Titles.title(it, Theme.TypeSize.sectionTitle) }, LinearLayout.LayoutParams(0, wrap, 1f))
    titleRow.addView(addButton, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { marginStart = dp(10f) })
    titleRow.addView(info, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { marginStart = dp(10f) })
    headStack.addView(titleRow, LinearLayout.LayoutParams(wide, wrap))

    tabs.onPick = { index ->
      section = listOf("catalog", "favorites", "saved")[index]
      reloadCatalog()
      refresh()
    }
    headStack.addView(tabs, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(10f) })
    sources.onPick = { index ->
      chosen = if (index == 0) "soundcloud" else "audius"
      sourceNotice = ""
      prefs.edit().putString(sourceKey, chosen).apply()
      reloadCatalog()
    }
    headStack.addView(sources, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })

    // «Слушать микс»: centred in what is left of the top (gap 9): a plain round play (66, white on dark themes,
    // #14243D on light ones, with a soft shadow), the name (21 bold) and its quiet line (14).
    mixRow.orientation = LinearLayout.VERTICAL
    mixRow.gravity = Gravity.CENTER_HORIZONTAL
    mixButton.fill = if (Theme.dark) Color.WHITE else 0xFF14243D.toInt()
    mixButton.ink = if (Theme.dark) Color.BLACK else Color.WHITE
    mixButton.bordered = false
    mixButton.elevation = dp(8f).toFloat()
    mixButton.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) { outline.setOval(0, 0, view.width, view.height) }
    }
    mixButton.setOnClickListener { mix() }
    com.linea.messenger.chatlook.Bouncy.attach(mixButton, 0.94f)
    mixRow.addView(mixButton, LinearLayout.LayoutParams(dp(66f), dp(66f)))
    mixRow.addView(AIKit.label(context, "Слушать микс", 21f, 700, MusicInk.ink, lines = 1, align = Gravity.CENTER), LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(9f) })
    mixRow.addView(mixLine, LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(9f) })
    headBox = MusicHeadBox(context, headStack, mixRow)
    column.addView(headBox, LinearLayout.LayoutParams(wide, wrap))

    // The search: a full pill on glass (radius 26, 48 tall, 16 inside), #1F1F1F on dark themes; the magnifier (20)
    // in the quiet colour, 10 before the words (15).
    val glass = com.linea.messenger.design.GlassDrawable(searchBox, 26f * d, clear = false)
    searchBox.background = if (Theme.dark) android.graphics.drawable.LayerDrawable(arrayOf(glass, context.plate(0xFF1F1F1F.toInt(), 26f))) else glass
    searchBox.addView(AIIconView(context, "search", 17f, Theme.muted), FrameLayout.LayoutParams(dp(20f), dp(48f)).apply { leftMargin = dp(16f) })
    search.setHintTextColor(Theme.muted)
    search.setTextColor(Theme.text)
    search.textSize = 15f
    search.background = null
    search.setPadding(0, 0, dp(12f), 0)
    search.maxLines = 1
    search.isSingleLine = true
    search.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    search.imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    search.gravity = Gravity.CENTER_VERTICAL
    search.filters = arrayOf(InputFilter.LengthFilter(160))
    search.contentDescription = "Поиск музыки"
    search.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_SEARCH) { hideKeyboard(); true } else false }
    search.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) { main.removeCallbacks(typing); main.postDelayed(typing, 450) }
    })
    searchBox.addView(search, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(48f)).apply { leftMargin = dp(46f); rightMargin = dp(8f) })
    column.addView(searchBox, LinearLayout.LayoutParams(wide, dp(48f)).apply { topMargin = dp(16f) })
    shelves.orientation = LinearLayout.VERTICAL // Music
    AIKit.add(column, shelves, 16f)

    // The moods: tall chips (at least 62 × 100), gap 8.
    moodScroll.isHorizontalScrollBarEnabled = false
    moodScroll.clipChildren = false
    moodRow.orientation = LinearLayout.HORIZONTAL
    moodScroll.addView(moodRow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, dp(64f)))
    column.addView(moodScroll, LinearLayout.LayoutParams(wide, dp(64f)).apply { topMargin = dp(16f) })
    AIKit.add(column, caption, 16f)
    // «Любимое» and «Мои файлы»: a few words about the section in place of the moods.
    AIKit.add(column, sectionWords, 16f)

    notices.orientation = LinearLayout.VERTICAL
    AIKit.add(column, notices, 16f)

    footer.orientation = LinearLayout.VERTICAL
    footer.gravity = Gravity.CENTER_HORIZONTAL
    footer.setPadding(dp(24f), dp(16f), dp(24f), dp(16f))
    // A list's own parts above and below the tracks: they scroll with them.
    val head = FrameLayout(context).apply { addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)) }
    val foot = FrameLayout(context).apply { addView(footer, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT)) }
    list.addHeaderView(head, null, false)
    listHead = head // Music
    list.addFooterView(foot, null, false)
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ ->
      val index = position - list.headerViewsCount
      shownRows.getOrNull(index)?.let { player.play(it, shownRows) }
    }
    addView(ambient) // Music: under the list
    addView(list)
    mini.onOpen = { openPlayer() }
    addView(mini)
  }

  override fun place(width: Int, height: Int) {
    val clearance = dp(BarMetrics.bottomGap(edges.bottom / d) + BarMetrics.height + 8f)
    val miniShown = mini.visibility == View.VISIBLE
    // Above the keyboard when it is up, above the bar (and the strip of the playing track) otherwise.
    val bottom = maxOf(clearance + (if (miniShown) dp(72f) else 0), edges.keyboard + dp(12f))
    if (list.paddingBottom != bottom) list.setPadding(0, 0, 0, bottom)
    // F: the top is `headHeight` tall from the screen's top; the column starts 8 under the status bar.
    val tall = dp(MusicInk.headHeight(section == "catalog", query.isNotEmpty(), height / d)) + edges.top
    headBox.wanted = maxOf(0, tall - edges.top - dp(8f))
    put(list, 0, edges.top, width, height - edges.top)
    placeAmbient() // Music
    put(mini, dp(12f), height - clearance - dp(64f), width - dp(24f), dp(64f))
  }

  /** Music: the ambient's height — most of the top half on «Главная» without a search, a strip otherwise; it scrolls
   *  away with the top of the list. */
  private fun placeAmbient() {
    if (width <= 0) return
    val tall = (if (section == "catalog" && query.isEmpty()) minOf(dp(430f), height / 2) else dp(132f)) + edges.top
    val head = listHead
    val scrolled = if (list.firstVisiblePosition == 0 && head != null && head.parent != null) -head.top else tall
    if (ambient.width != width || ambient.height != tall) put(ambient, 0, 0, width, tall)
    ambient.translationY = -scrolled.toFloat()
  }

  /** Music: the shelves, built again only when what they show changed. */
  private fun refreshShelves(list: List<MusicTrack>) {
    val open = section == "catalog" && query.isEmpty()
    val favorites = if (open) player.favorites.take(12) else emptyList()
    val artists = if (open) MusicShelves.artists(list) else emptyList()
    val mark = favorites.joinToString(",") { it.id } + "|" + (if (artists.size > 1) artists.joinToString(",") { it.id } else "")
    if (mark == shelvesMark) return
    shelvesMark = mark
    shelves.removeAllViews()
    if (favorites.isNotEmpty()) {
      val all = player.favorites
      AIKit.add(shelves, MusicShelves.shelf(context, "Любимое", favorites.map { track -> MusicShelves.coverCard(context, track) { player.play(track, all) } }, 18f), 0f)
    }
    if (artists.size > 1) {
      AIKit.add(shelves, MusicShelves.shelf(context, "Артисты", artists.map { track -> MusicShelves.artistCircle(context, track) { searchArtist(track.artist) } }, 18f), if (shelves.childCount > 0) 16f else 0f)
    }
    shelves.visibility = if (shelves.childCount == 0) View.GONE else View.VISIBLE
  }

  private fun searchArtist(name: String) {
    search.setText(name)
    search.setSelection(name.length)
  }

  private fun noticeBox(text: String, error: Boolean, close: (() -> Unit)?): View {
    val box = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      background = context.plate(Theme.veil(0.06f), 14f)
      setPadding(dp(14f), dp(12f), dp(8f), dp(12f))
    }
    box.addView(AIKit.label(context, text, 13f, color = if (error) Theme.danger else Theme.text), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    if (close != null) {
      val shut = AIIconButton(context, "xmark", 14f, Theme.muted, "Закрыть сообщение")
      shut.setOnClickListener { close() }
      box.addView(shut, LinearLayout.LayoutParams(dp(30f), dp(24f)).apply { marginStart = dp(6f) })
    }
    if (error) box.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    return box
  }

  private fun refresh() {
    val catalog = section == "catalog"
    tabs.chosen = listOf("catalog", "favorites", "saved").indexOf(section).coerceAtLeast(0)
    search.hint = if (section == "saved") "Поиск в моих файлах" else "Трек или исполнитель"
    sources.visibility = if (catalog && scReady) View.VISIBLE else View.GONE
    sources.chosen = if (source == "soundcloud") 0 else 1
    moodScroll.visibility = if (catalog) View.VISIBLE else View.GONE
    moodRow.removeAllViews()
    val chips = listOf(Triple<String?, String, String>(null, "Любое", "sparkles")) + MusicCatalog.moods.drop(1).map { Triple(it.apiMood, it.label, it.symbol) }
    for ((value, label, symbol) in chips) {
      val chip = MusicMoodChip(context, label, symbol, selected = value == mood)
      chip.setOnClickListener { pickMood(value) }
      moodRow.addView(chip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(62f)).apply { if (moodRow.childCount > 0) marginStart = dp(8f) })
    }
    sectionWords.visibility = if (catalog) View.GONE else View.VISIBLE
    sectionWords.text = if (section == "saved") "Твои файлы на этом устройстве. Добавляй аудио через «+» и слушай без интернета." else "Треки, которые ты отметил сердцем. Для воспроизведения Audius нужен интернет."
    val shown = rows
    mixRow.visibility = if (catalog && query.isEmpty()) View.VISIBLE else View.GONE
    mixButton.isEnabled = shown.isNotEmpty()
    mixLine.text = MusicWords.mixLine(mood)
    caption.visibility = if (catalog) View.VISIBLE else View.GONE
    caption.text = if (query.isEmpty()) "ОТКРОЙ ДЛЯ СЕБЯ" else "РЕЗУЛЬТАТЫ"

    notices.removeAllViews()
    if (player.error.isNotEmpty()) AIKit.add(notices, noticeBox(player.error, error = true) { player.clearError() }, 8f)
    if (player.notice.isNotEmpty()) AIKit.add(notices, noticeBox(player.notice, error = false) { player.clearNotice() }, 8f)
    if (sourceNotice.isNotEmpty() && catalog) AIKit.add(notices, noticeBox(sourceNotice, error = false, close = null), 8f)
    if (failure.isNotEmpty() && catalog) AIKit.add(notices, noticeBox(failure, error = true, close = null), 8f)
    notices.visibility = if (notices.childCount == 0) View.GONE else View.VISIBLE

    footer.removeAllViews()
    val centre = Gravity.CENTER_HORIZONTAL
    if (catalog && loading && shown.isEmpty()) {
      footer.addView(AIKit.spinner(context), LinearLayout.LayoutParams(dp(24f), dp(24f)))
      AIKit.add(footer, AIKit.label(context, "Ищем музыку…", 13f, color = Theme.muted, align = centre), 10f)
    } else if (shown.isEmpty() && failure.isEmpty()) {
      val (heading, words) = MusicWords.empty(section, nextOffset != null, if (source == "soundcloud") "SoundCloud" else "Audius")
      AIKit.add(footer, AIKit.label(context, heading, 18f, 700, align = centre), 10f)
      AIKit.add(footer, AIKit.label(context, words, 13f, color = Theme.muted, align = centre), 10f)
      if (section == "saved") {
        val add = AIWideButton(context, "Добавить файлы", "plus")
        add.setOnClickListener { addFiles() }
        AIKit.add(footer, add, 10f, wide = false)
      }
    }
    if (catalog && nextOffset != null && !loading) {
      val button = AIWideButton(context, "Показать ещё", secondary = true)
      button.isEnabled = !loadingMore
      button.setOnClickListener { more() }
      AIKit.add(footer, button, 10f, wide = false)
    }
    if (catalog && (shown.isNotEmpty() || !loading)) AIKit.add(footer, AIKit.label(context, MusicWords.footer(source), 11f, color = Theme.subtle, align = centre), 10f)
    shownRows = shown
    refreshShelves(shown) // Music
    adapter.notifyDataSetChanged()
    requestLayout()
  }
}
