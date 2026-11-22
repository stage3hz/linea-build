package com.linea.messenger.music

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.ai.AIIconButton
import com.linea.messenger.ai.AIIconView
import com.linea.messenger.ai.AIKit
import com.linea.messenger.design.GlassDrawable
import com.linea.messenger.design.IonIcon
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.pages
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.shell.Screen
import kotlin.math.abs

/** The full player, laid out as the reference's `FullPlayer` (mobile/src/music/PlayerControls.tsx; iOS:
 *  Music/PlayerViewController.swift): a full-screen page sliding up over the blurred cover (or the music ambient);
 *  the top bar (collapse, «Сейчас играет», the track's page); the cover, swiped left / right between tracks and down
 *  to collapse; the title with the 46 dp «в любимое» and «ещё»; a row of chips; the seek line; the controls; and
 *  «Очередь · N | Текст» on a raised bar, which opens the panel of the queue and of the words. */
@SuppressLint("ViewConstructor")
class PlayerScreen(context: Context, private val player: MusicPlayer) : Screen(context) {
  private val soft: Int get() = if (Theme.dark) 0x1FFFFFFF else 0x12000000

  private val ambient = com.linea.messenger.effects.MusicAmbientView(context, com.linea.messenger.effects.MusicAmbientView.themeTone, com.linea.messenger.effects.MusicAmbientView.themeCustom)
  private val backdrop = Backdrop(context)

  private val fold = AIIconButton(context, "ion:chevron-down", 26f, Theme.text, "Свернуть плеер")
  private val kicker = context.words("", 16f, Theme.text, 500).apply { gravity = Gravity.CENTER; maxLines = 1 }
  private val source = AIIconButton(context, "ion:arrow-redo-outline", 23f, Theme.text, "Открыть страницу трека")

  private val cover = MusicCoverView(context, 36f, artwork = true)

  private val heading = context.words("", 22f, Theme.text, 700).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; letterSpacing = -0.3f / 22f }
  private val artist = context.words("", 15f, Theme.muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
  private val like = RoundGlyph(context)
  private val more = RoundGlyph(context)

  private val chips = HorizontalScrollView(context)
  private val chipRow = LinearLayout(context)
  private var chipMark = ""

  private val seek = SeekLine(context)

  private val shuffleButton = AIIconButton(context, "ion:shuffle", 26f, Theme.muted)
  private val backButton = AIIconButton(context, "ion:play-skip-back", 36f, Theme.text, "Предыдущий трек или начало текущего")
  private val playButton = object : AIIconButton(context, "ion:play", 52f, Theme.text, "Воспроизвести") {
    override fun setPressed(pressed: Boolean) { super.setPressed(pressed); scaleX = if (pressed) 0.96f else 1f; scaleY = scaleX }
  }
  private val forwardButton = AIIconButton(context, "ion:play-skip-forward", 36f, Theme.text, "Следующий трек")
  private val repeatButton = AIIconButton(context, "ion:repeat", 26f, Theme.muted)
  private val waiting = AIKit.spinner(context, Theme.text)
  private var notice: View? = null
  private var noticeMark = ""

  private val bottomBar = LinearLayout(context)
  private val queueWords = context.words("Очередь", 16f, Theme.text, 600)
  private val queueCount = context.words("", 12f, Theme.muted).apply { gravity = Gravity.CENTER }
  private val lyricsWords = context.words("Текст", 16f, Theme.text, 600).apply { gravity = Gravity.CENTER }

  private val panelDim = View(context)
  private val panel = LinearLayout(context)
  private val panelTabs = listOf(TextView(context), TextView(context))
  private val panelScroll = ScrollView(context)
  private val panelList = LinearLayout(context)
  private var panelShown: String? = null
  private var panelMark = ""

  private val changed: () -> Unit = { refresh() }

  init {
    setBackgroundColor(Theme.bg)
    isClickable = true
    addView(ambient)
    addView(backdrop)

    for (button in listOf(fold, source, shuffleButton, backButton, forwardButton, repeatButton)) button.background = GlassDrawable(button)
    fold.setOnClickListener { leave() }
    source.setOnClickListener { player.current?.sourceUrl?.let { openMusicLink(context, it) } }
    for (part in listOf(fold, kicker, source, cover, heading, artist, like, more, seek, shuffleButton, backButton, playButton, forwardButton, repeatButton, waiting)) addView(part)

    like.setOnClickListener { player.current?.let { player.toggleFavorite(it) } }
    more.glyph = "ellipsis-horizontal"; more.glyphSize = 22f; more.contentDescription = "Ещё"
    more.setOnClickListener { showPanel("queue") }

    chips.isHorizontalScrollBarEnabled = false
    chips.overScrollMode = OVER_SCROLL_NEVER
    chipRow.orientation = LinearLayout.HORIZONTAL
    chipRow.gravity = Gravity.CENTER_VERTICAL
    chips.addView(chipRow)
    addView(chips)

    seek.onSeek = { seconds -> player.seek(seconds) }
    shuffleButton.setOnClickListener { player.toggleShuffle() }
    backButton.setOnClickListener { player.previous() }
    playButton.setOnClickListener { player.togglePlayback() }
    forwardButton.setOnClickListener { player.next() }
    repeatButton.setOnClickListener { player.toggleRepeat() }
    waiting.visibility = View.INVISIBLE

    // The raised bar: 56 tall, radius 20.
    bottomBar.orientation = LinearLayout.HORIZONTAL
    bottomBar.background = context.plate(if (Theme.dark) 0x14FFFFFF else 0x0D000000, 20f)
    val queueTab = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; isClickable = true; isFocusable = true }
    queueTab.addView(queueWords)
    queueCount.background = context.plate(soft, 10f)
    queueCount.minWidth = context.px(22f)
    queueCount.setPadding(context.px(6f), 0, context.px(6f), 0)
    queueTab.addView(queueCount, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.px(20f)).apply { marginStart = context.px(8f) })
    queueTab.setOnClickListener { showPanel("queue") }
    val lyricsTab = LinearLayout(context).apply { gravity = Gravity.CENTER; isClickable = true; isFocusable = true; contentDescription = "Текст" }
    lyricsTab.addView(lyricsWords)
    lyricsTab.setOnClickListener { showPanel("lyrics") }
    bottomBar.addView(queueTab, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    bottomBar.addView(lyricsTab, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    addView(bottomBar)

    // The panel over a 0.4 dim.
    panelDim.setBackgroundColor(0x66000000)
    panelDim.contentDescription = "Закрыть"
    panelDim.setOnClickListener { closePanel() }
    panelDim.visibility = View.GONE
    addView(panelDim)
    panel.orientation = LinearLayout.VERTICAL
    panel.background = android.graphics.drawable.GradientDrawable().apply {
      setColor(if (Theme.dark) 0xFF141A26.toInt() else 0xFFF4F7FC.toInt())
      val r = 24f * d
      cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
    }
    panel.setPadding(0, dp(10f), 0, 0)
    panel.isClickable = true
    val grab = View(context).apply { background = context.plate(Theme.subtle, 2f) }
    panel.addView(grab, LinearLayout.LayoutParams(dp(36f), dp(4f)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(8f) })
    val tabs = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(12f), 0, dp(12f), dp(6f)) }
    panelTabs.forEachIndexed { index, tab ->
      tab.textSize = 15f
      tab.typeface = Theme.weight(600)
      tab.gravity = Gravity.CENTER
      tab.includeFontPadding = false
      tab.setPadding(0, dp(8f), 0, dp(8f))
      tab.setOnClickListener { showPanel(if (index == 0) "queue" else "lyrics") }
      tabs.addView(tab, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    }
    panel.addView(tabs)
    panelList.orientation = LinearLayout.VERTICAL
    panelList.setPadding(dp(10f), 0, dp(10f), 0)
    panelScroll.addView(panelList)
    panel.addView(panelScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    panel.visibility = View.GONE
    addView(panel)
    refresh()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    player.changed.watch(changed)
    refresh()
    // <Modal animationType="slide">: up from the bottom.
    if (!slid) {
      slid = true
      post { translationY = height.toFloat(); animate().translationY(0f).setDuration(300).setInterpolator(DecelerateInterpolator()).start() }
    }
  }

  private var slid = false

  override fun onDetachedFromWindow() {
    player.changed.unwatch(changed)
    super.onDetachedFromWindow()
  }

  // Places

  override fun place(width: Int, height: Int) {
    put(ambient, 0, 0, width, height)
    put(backdrop, 0, 0, width, height)
    val coverSide = Math.round(minOf(width - dp(56f).toFloat(), height * 0.44f, dp(460f).toFloat()))
    val side = maxOf(dp(16f), Math.round((width - coverSide) / 2f))
    val top = edges.top
    put(fold, side, top + dp(4f), dp(44f), dp(44f))
    put(source, width - side - dp(44f), top + dp(4f), dp(44f), dp(44f))
    put(kicker, side + dp(44f), top, width - 2 * (side + dp(44f)), dp(52f))

    val barBottom = height - maxOf(dp(12f), edges.bottom)
    put(bottomBar, side, barBottom - dp(56f), width - 2 * side, dp(56f))
    val inner = width - 2 * side
    var y = barBottom - dp(56f) - dp(14f)
    notice?.let { view ->
      view.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      y -= view.measuredHeight
      put(view, side, y, inner, view.measuredHeight)
      y -= dp(18f)
    }
    y -= dp(72f)
    put(playButton, (width - dp(72f)) / 2, y, dp(72f), dp(72f))
    put(waiting, (width - dp(22f)) / 2, y + dp(25f), dp(22f), dp(22f))
    val gaps = (inner - dp(44f) * 4 - dp(72f)) / 4
    put(shuffleButton, side, y + dp(14f), dp(44f), dp(44f))
    put(backButton, side + dp(44f) + gaps, y + dp(14f), dp(44f), dp(44f))
    put(forwardButton, (width + dp(72f)) / 2 + gaps, y + dp(14f), dp(44f), dp(44f))
    put(repeatButton, width - side - dp(44f), y + dp(14f), dp(44f), dp(44f))
    y -= dp(18f)
    val seekTall = seek.tall()
    y -= seekTall
    put(seek, side, y, inner, seekTall)
    y -= dp(18f) + dp(40f)
    put(chips, 0, y, width, dp(40f))
    chipRow.setPadding(side, 0, side, 0)
    y -= dp(18f)
    heading.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    artist.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val rowTall = maxOf(dp(46f), heading.measuredHeight + dp(4f) + artist.measuredHeight)
    y -= rowTall
    val moreLeft = width - side - dp(46f)
    put(more, moreLeft, y + (rowTall - dp(46f)) / 2, dp(46f), dp(46f))
    put(like, moreLeft - dp(12f) - dp(46f), y + (rowTall - dp(46f)) / 2, dp(46f), dp(46f))
    val wordsTop = y + (rowTall - heading.measuredHeight - dp(4f) - artist.measuredHeight) / 2
    val wordsWidth = moreLeft - dp(12f + 46f + 12f) - side
    put(heading, side, wordsTop, wordsWidth, heading.measuredHeight)
    put(artist, side, wordsTop + heading.measuredHeight + dp(4f), wordsWidth, artist.measuredHeight)
    val coverTop = top + dp(52f)
    put(cover, (width - coverSide) / 2, coverTop + (y - coverTop - coverSide) / 2, coverSide, coverSide)
    coverArea.set(0f, coverTop.toFloat(), width.toFloat(), y.toFloat())
    topArea.set(0f, top.toFloat(), width.toFloat(), (top + dp(52f)).toFloat())

    put(panelDim, 0, 0, width, height)
    if (panelShown != null) {
      panel.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      val tall = minOf(Math.round(height * 0.66f), panel.measuredHeight + edges.bottom + dp(8f))
      panel.setPadding(0, dp(10f), 0, edges.bottom + dp(8f))
      put(panel, 0, height - tall, width, tall)
    }
  }

  private val coverArea = RectF()
  private val topArea = RectF()

  // What is shown

  private fun chip(glyph: String, words: String?, disabled: Boolean = false, action: () -> Unit): View {
    val box = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      background = context.plate(soft, 12f)
      if (words != null) setPadding(dp(14f), 0, dp(14f), 0)
      isClickable = !disabled
      isFocusable = !disabled
      alpha = if (disabled) 0.4f else 1f
      contentDescription = words ?: glyph
      setOnClickListener { action() }
    }
    box.addView(AIIconView(context, "ion:$glyph", 19f, Theme.text), LinearLayout.LayoutParams(dp(19f), dp(19f)))
    if (words != null) box.addView(context.words(words, 15f, Theme.text, 500), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(7f) })
    box.setOnTouchListener { view, event ->
      if (!disabled) when (event.actionMasked) { MotionEvent.ACTION_DOWN -> view.alpha = 0.6f; MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> view.alpha = 1f }
      false
    }
    return box
  }

  private fun refresh() {
    val track = player.current
    if (track == null) {
      if (isAttachedToWindow) post { leave() }
      return
    }
    val favorite = player.isFavorite(track)
    cover.bind(track)
    backdrop.show(track)
    kicker.text = if (track.source == "local") "Мои файлы" else "Сейчас играет"
    source.visibility = if (track.sourceUrl != null) View.VISIBLE else View.INVISIBLE
    if (heading.text.toString() != track.title) heading.text = track.title
    if (artist.text.toString() != track.artist) artist.text = track.artist
    // «в любимое»: 46 round — the text colour with a tick in the page colour, else the soft plate with «add».
    like.plate = if (favorite) Theme.text else soft
    like.glyph = if (favorite) "checkmark" else "add"
    like.glyphSize = 24f
    like.ink = if (favorite) Theme.bg else Theme.text
    like.contentDescription = if (favorite) "Убрать из любимого" else "В любимое"
    more.plate = soft; more.ink = Theme.text

    val mark = "${track.id}|$favorite|${player.shuffle}|${track.downloadable}"
    if (mark != chipMark) {
      chipMark = mark
      chipRow.removeAllViews()
      fun add(view: View, wide: Int) = chipRow.addView(view, LinearLayout.LayoutParams(wide, dp(40f)).apply { if (chipRow.childCount > 0) marginStart = dp(8f) })
      if (track.source != "soundcloud") add(chip(if (track.source == "local") "share-outline" else "download-outline", null, track.source == "audius" && !track.downloadable) { download(track) }, dp(48f))
      add(chip(if (favorite) "heart" else "heart-outline", if (favorite) "В любимом" else "В любимое") { player.toggleFavorite(track) }, LinearLayout.LayoutParams.WRAP_CONTENT)
      add(chip("shuffle", if (player.shuffle) "Перемешано" else "Перемешать") { player.toggleShuffle() }, LinearLayout.LayoutParams.WRAP_CONTENT)
      add(chip("options-outline", "Эквалайзер") { openEqualizer() }, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    seek.show(player.position, player.duration)
    shuffleButton.color = if (player.shuffle) Theme.accent else Theme.muted
    shuffleButton.contentDescription = if (player.shuffle) "Случайный порядок включён" else "Включить случайный порядок"
    repeatButton.color = if (player.repeatMode != "off") Theme.accent else Theme.muted
    repeatButton.contentDescription = (if (player.repeatMode == "one") "Повтор одного трека" else if (player.repeatMode == "all") "Повтор очереди" else "Повтор выключен") + ". Изменить"
    forwardButton.isEnabled = player.queue.size >= 2
    playButton.symbol = if (player.loading) "" else if (player.playing) "ion:pause" else "ion:play"
    playButton.contentDescription = if (player.loading) "Загрузка. Повторить воспроизведение" else if (player.playing) "Приостановить" else "Воспроизвести"
    waiting.visibility = if (player.loading) View.VISIBLE else View.INVISIBLE

    val words = if (player.error.isNotEmpty()) "e" + player.error else if (player.notice.isNotEmpty()) "n" + player.notice else ""
    if (words != noticeMark) {
      noticeMark = words
      notice?.let { removeView(it) }
      notice = null
      if (words.isNotEmpty()) {
        val made = MusicNotice(context, words.substring(1), words.startsWith("e"))
        made.setOnClickListener { if (player.error.isNotEmpty()) player.clearError() else player.clearNotice() }
        addView(made, indexOfChild(panelDim))
        notice = made
      }
    }
    queueCount.text = player.queue.size.toString()
    if (panelShown != null) fillPanel()
    requestLayout()
  }

  // The panel

  private fun showPanel(which: String) {
    panelShown = which
    panelMark = ""
    panelDim.visibility = View.VISIBLE
    panel.visibility = View.VISIBLE
    fillPanel()
    requestLayout()
  }

  private fun closePanel() {
    panelShown = null
    panelDim.visibility = View.GONE
    panel.visibility = View.GONE
  }

  private fun fillPanel() {
    val which = panelShown ?: return
    val track = player.current ?: return
    panelTabs.forEachIndexed { index, tab ->
      val on = (index == 0) == (which == "queue")
      tab.text = if (index == 0) "Очередь · ${player.queue.size}" else "Текст"
      tab.setTextColor(if (on) Theme.text else Theme.muted)
      tab.background = if (on) object : android.graphics.drawable.ColorDrawable(0) {
        private val line = Paint().apply { color = Theme.text }
        override fun draw(canvas: Canvas) { canvas.drawRect(0f, bounds.bottom - 2f * d, bounds.right.toFloat(), bounds.bottom.toFloat(), line) }
      } else null
    }
    val mark = which + "|" + track.id + "|" + player.playing + "|" + player.queue.joinToString(",") { it.id }
    if (mark == panelMark) return
    panelMark = mark
    panelList.removeAllViews()
    if (which == "queue") {
      for (item in player.queue) {
        val on = item.id == track.id
        val row = object : LinearLayout(context) {
          override fun drawableStateChanged() { super.drawableStateChanged(); background = context.plate(if (on || isPressed) ThemeStore.look.accentSoft else 0, 12f) }
        }
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.minimumHeight = dp(56f)
        row.setPadding(dp(8f), 0, dp(8f), 0)
        row.background = context.plate(if (on) ThemeStore.look.accentSoft else 0, 12f)
        row.isClickable = true
        row.contentDescription = "Включить: ${item.title}, ${item.artist}"
        row.setOnClickListener { player.play(item, player.queue) }
        val art = MusicCoverView(context, 12f, artwork = true).also { it.bind(item) }
        row.addView(art, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { marginEnd = dp(11f) })
        val lines = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        lines.addView(context.words(item.title, 15f, Theme.text, 600).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END })
        lines.addView(context.words(item.artist, 13f, Theme.muted).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2f) })
        row.addView(lines, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (on) row.addView(AIIconView(context, if (player.playing) "ion:volume-medium-outline" else "ion:pause-outline", 17f, Theme.accent), LinearLayout.LayoutParams(dp(17f), dp(17f)).apply { marginStart = dp(11f) })
        panelList.addView(row)
      }
    } else {
      val box = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(dp(24f), dp(24f), dp(24f), dp(24f)) }
      box.addView(AIIconView(context, "ion:document-text-outline", 34f, Theme.subtle), LinearLayout.LayoutParams(dp(34f), dp(34f)))
      box.addView(context.words("Текста пока нет", 16f, Theme.text, 600), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
      val words = context.words("Каталог Audius не передаёт тексты песен, поэтому показать текст этого трека нельзя.", 13f, Theme.muted).apply { gravity = Gravity.CENTER }
      if (android.os.Build.VERSION.SDK_INT >= 28) words.lineHeight = dp(19f)
      box.addView(words, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
      panelList.addView(box)
    }
  }

  // What the touches do

  private var shared: java.io.File? = null

  private fun download(track: MusicTrack) {
    if (track.source == "local") {
      val file = player.file(track)?.takeIf { it.isFile } ?: return player.report("Сохранённый файл не найден.")
      shared = com.linea.messenger.ai.AIShare.send(context, file, shared, file.name) ?: run { player.report("Сохранённый файл не найден."); null }
      return
    }
    MusicCatalog.resolveDownload(track) { result ->
      val address = result.getOrNull()
      if (address == null) player.report((result.exceptionOrNull() as? MusicFailure)?.words.orEmpty())
      else {
        openMusicLink(context, address)
        player.say("Скачивание открыто через Audius. Сохранённый файл можно добавить сюда через «Добавить файлы».")
      }
    }
  }

  /** Music: «Эквалайзер» over the player. */
  fun openEqualizer() {
    val stack = pages() ?: return
    if (stack.top is EqualizerScreen) return
    stack.push(EqualizerScreen(context, player))
  }

  /** Slides down, then leaves the stack. */
  private fun leave() {
    val stack = pages() ?: return
    if (stack.top !== this) return
    animate().translationY(height.toFloat()).setDuration(250).setInterpolator(DecelerateInterpolator()).withEndAction { if (stack.top === this) stack.pop(animated = false) }.start()
  }

  // Gestures: down on the top bar or the cover collapses (past 90 dp or at 900 dp/s, no live movement); across the
  // cover the cover follows the finger and changes the track past 0.28 of its size or at 800 dp/s.

  private var startX = 0f
  private var startY = 0f
  private var axis = 0
  private var speed: VelocityTracker? = null
  private val slop = ViewConfiguration.get(context).scaledTouchSlop

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    if (panelShown != null) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        startX = event.x; startY = event.y; axis = 0
        speed?.recycle(); speed = VelocityTracker.obtain(); speed?.addMovement(event)
      }
      MotionEvent.ACTION_MOVE -> {
        speed?.addMovement(event)
        val dx = event.x - startX; val dy = event.y - startY
        val inCover = coverArea.contains(startX, startY); val inTop = topArea.contains(startX, startY)
        if (axis == 0 && inCover && abs(dx) > dp(12f) && abs(dx) > abs(dy)) { axis = 1; return true }
        if (axis == 0 && (inCover || inTop) && dy > dp(30f) && abs(dy) > abs(dx)) { axis = 2; return true }
      }
    }
    return false
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (axis == 0) return super.onTouchEvent(event)
    speed?.addMovement(event)
    val dx = event.x - startX; val dy = event.y - startY
    val size = cover.width.toFloat().coerceAtLeast(1f)
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> if (axis == 1) { cover.translationX = dx; cover.alpha = 1f - minOf(0.5f, abs(dx) / size * 0.6f) }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        speed?.computeCurrentVelocity(1000)
        val vx = (speed?.xVelocity ?: 0f) / d; val vy = (speed?.yVelocity ?: 0f) / d
        if (axis == 1) {
          val go = event.actionMasked == MotionEvent.ACTION_UP && (abs(dx) > size * 0.28f || abs(vx) > 800f) && player.queue.size > 1
          if (go) {
            val direction = if (dx < 0) -1f else 1f
            cover.animate().translationX(direction * size * 1.2f).setDuration(180).setInterpolator(DecelerateInterpolator()).withEndAction {
              performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
              if (direction < 0) player.next() else player.previous()
              cover.translationX = -direction * size * 0.4f
              springCover(18.0, 220.0)
            }.start()
          } else springCover(18.0, 260.0)
        } else if (event.actionMasked == MotionEvent.ACTION_UP && (dy / d > 90f || vy > 900f)) leave()
        axis = 0
      }
    }
    return true
  }

  /** The cover back in place on a spring (mass 1), fading in. */
  private fun springCover(damping: Double, stiffness: Double) {
    var x = (cover.translationX / d).toDouble(); var v = 0.0
    val run = android.animation.ValueAnimator.ofFloat(0f, 1f).setDuration(1500)
    var last = 0L
    run.addUpdateListener { step ->
      val now = step.currentPlayTime
      var left = (now - last).coerceIn(0L, 64L) / 1000.0
      last = now
      while (left > 0) { val dt = minOf(0.001, left); v += (-stiffness * x - damping * v) * dt; x += v * dt; left -= dt }
      cover.translationX = (x * d).toFloat()
      cover.alpha = 1f - minOf(0.5f, abs(cover.translationX) / cover.width.coerceAtLeast(1) * 0.6f)
      if (abs(x) < 0.05 && abs(v) < 1) { cover.translationX = 0f; cover.alpha = 1f; step.cancel() }
    }
    run.start()
  }

  /** The blurred cover (`blurRadius={70}`, `scale 1.3`) under COVER_VEIL (black .68 on dark themes, white .82 on light). */
  private inner class Backdrop(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var blurred: Bitmap? = null
    private var mark = ""
    private val box = RectF()

    fun show(track: MusicTrack) {
      val picture = MusicCovers.image(track)
      val next = track.id + (if (picture == null) "" else "+")
      if (next == mark) return
      mark = next
      blurred = picture?.let { blur(it) }
      ambient.visibility = if (blurred == null) View.VISIBLE else View.GONE
      invalidate()
    }

    private fun blur(picture: Bitmap): Bitmap? = try {
      val side = 160
      val small = Bitmap.createScaledBitmap(picture, side, side, true).copy(Bitmap.Config.ARGB_8888, true)
      val sigma = 70f * side / maxOf(width / d, 320f)
      val boxWidth = maxOf(1, Math.round(Math.sqrt(12.0 * sigma * sigma / 3 + 1)).toInt()) or 1
      val pixels = IntArray(side * side); small.getPixels(pixels, 0, side, 0, 0, side, side)
      val spare = IntArray(side * side)
      repeat(3) { pass(pixels, spare, side, boxWidth / 2, true); pass(spare, pixels, side, boxWidth / 2, false) }
      small.setPixels(pixels, 0, side, 0, 0, side, side)
      small
    } catch (_: Throwable) { null }

    private fun pass(from: IntArray, to: IntArray, n: Int, radius: Int, across: Boolean) {
      val span = radius * 2 + 1
      for (line in 0 until n) {
        var a = 0; var r = 0; var g = 0; var b = 0
        fun at(i: Int): Int { val k = i.coerceIn(0, n - 1); return if (across) from[line * n + k] else from[k * n + line] }
        for (i in -radius..radius) { val p = at(i); a += p ushr 24; r += (p shr 16) and 255; g += (p shr 8) and 255; b += p and 255 }
        for (i in 0 until n) {
          to[if (across) line * n + i else i * n + line] = ((a / span) shl 24) or ((r / span) shl 16) or ((g / span) shl 8) or (b / span)
          val out = at(i - radius); val inn = at(i + radius + 1)
          a += (inn ushr 24) - (out ushr 24); r += ((inn shr 16) and 255) - ((out shr 16) and 255)
          g += ((inn shr 8) and 255) - ((out shr 8) and 255); b += (inn and 255) - (out and 255)
        }
      }
    }

    override fun onDraw(canvas: Canvas) {
      val picture = blurred ?: return
      val w = width.toFloat(); val h = height.toFloat()
      val scale = maxOf(w / picture.width, h / picture.height) * 1.3f
      box.set((w - picture.width * scale) / 2, (h - picture.height * scale) / 2, (w + picture.width * scale) / 2, (h + picture.height * scale) / 2)
      canvas.drawBitmap(picture, null, box, paint)
      canvas.drawColor(if (Theme.dark) 0xAD000000.toInt() else 0xD1FFFFFF.toInt())
    }
  }

  /** A 46 dp round with a glyph: «в любимое» and «ещё» (`opacity: pressed ? .7 : 1`). */
  private class RoundGlyph(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var plate = 0
      set(value) { field = value; invalidate() }
    var glyph = "add"
      set(value) { field = value; invalidate() }
    var glyphSize = 24f
    var ink = Theme.text
      set(value) { field = value; invalidate() }

    init { isClickable = true; isFocusable = true }

    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun drawableStateChanged() { super.drawableStateChanged(); alpha = if (isPressed) 0.7f else 1f }

    override fun onDraw(canvas: Canvas) {
      paint.color = plate
      canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, paint)
      IonIcon.draw(canvas, glyph, width / 2f, height / 2f, glyphSize * d, ink)
    }
  }

  /** The seek line (`SeekBar`): 5 dp (7 while dragged), the border colour with the accent part, a 12 dp knob with a
   *  2 dp `glassOpaque` edge, the times (12, even digits) 4 dp over the lower part of its 44 dp row. */
  private class SeekLine(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = android.text.TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12f * resources.displayMetrics.scaledDensity; typeface = Theme.weight(400); fontFeatureSettings = "tnum" }
    var onSeek: ((Double) -> Unit)? = null
    private var position = 0.0
    private var duration = 0.0
    private var drag: Double? = null

    fun tall(): Int = Math.round(40f * d + (text.fontMetrics.descent - text.fontMetrics.ascent))

    fun show(position: Double, duration: Double) { this.position = position; this.duration = duration; invalidate() }

    override fun onDraw(canvas: Canvas) {
      val w = width.toFloat()
      val shown = drag ?: position
      val ratio = if (duration > 0) (shown / duration).coerceIn(0.0, 1.0).toFloat() else 0f
      val thick = (if (drag != null) 7f else 5f) * d
      val top = 22f * d - thick / 2
      paint.color = ThemeStore.look.border
      canvas.drawRoundRect(0f, top, w, top + thick, 5f * d, 5f * d, paint)
      paint.color = Theme.accent
      canvas.drawRoundRect(0f, top, w * ratio, top + thick, 5f * d, 5f * d, paint)
      val knobX = maxOf(0f, minOf(maxOf(0f, w - 12f * d), ratio * w - 6f * d)) + 6f * d
      paint.alpha = if (duration > 0) 255 else 89
      paint.color = ThemeStore.look.glassOpaque.let { (it and 0x00FFFFFF) or ((if (duration > 0) 255 else 89) shl 24) }
      canvas.drawCircle(knobX, 22f * d, 6f * d, paint)
      paint.color = Theme.accent.let { (it and 0x00FFFFFF) or ((if (duration > 0) 255 else 89) shl 24) }
      canvas.drawCircle(knobX, 22f * d, 4f * d, paint)
      text.color = Theme.muted
      val base = 40f * d - text.fontMetrics.ascent
      text.textAlign = Paint.Align.LEFT
      canvas.drawText(MusicCatalog.time(shown), 0f, base, text)
      text.textAlign = Paint.Align.RIGHT
      canvas.drawText(if (duration > 0) MusicCatalog.time(duration) else "—:—", w, base, text)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (duration <= 0 || width == 0) return false
      val value = (event.x.coerceIn(0f, width.toFloat()) / width) * duration
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> { parent?.requestDisallowInterceptTouchEvent(true); drag = value; invalidate() }
        MotionEvent.ACTION_UP -> { drag = null; onSeek?.invoke(value); invalidate() }
        MotionEvent.ACTION_CANCEL -> { drag = null; invalidate() }
      }
      return true
    }
  }
}

/** The reference's `Notice` for the player (glass radius 18, the danger tint for an error, the glyph 19, 13 on 19). */
@SuppressLint("ViewConstructor")
class MusicNotice(context: Context, words: String, error: Boolean) : LinearLayout(context) {
  init {
    orientation = HORIZONTAL
    val d = resources.displayMetrics.density
    setPadding(Math.round(14 * d), Math.round(14 * d), Math.round(14 * d), Math.round(14 * d))
    background = android.graphics.drawable.LayerDrawable(arrayOf(GlassDrawable(this, 18f * d, clear = false), context.plate(if (error) ThemeStore.look.dangerBg else 0, 18f)))
    addView(AIIconView(context, if (error) "ion:alert-circle-outline" else "ion:information-circle-outline", 19f, if (error) Theme.danger else Theme.accent), LayoutParams(Math.round(19 * d), Math.round(19 * d)).apply { marginEnd = Math.round(10 * d) })
    val text = context.words(words, 13f, if (error) Theme.danger else Theme.text)
    if (android.os.Build.VERSION.SDK_INT >= 28) text.lineHeight = Math.round(19 * d)
    addView(text, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    isClickable = true
  }
}
