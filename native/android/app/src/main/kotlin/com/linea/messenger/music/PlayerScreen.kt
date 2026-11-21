package com.linea.messenger.music

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import com.linea.messenger.ai.AIIconButton
import com.linea.messenger.ai.AIIconView
import com.linea.messenger.ai.AIKit
import com.linea.messenger.ai.AIRoundButton
import com.linea.messenger.ai.AISheet
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen

/** The full player: the cover across the width, the title with «в любимое», the seek line, the controls and
 *  the queue. After mobile/src/music/PlayerControls.tsx (iOS: Music/PlayerViewController.swift). A page of the
 *  app's stack: the system's Back folds it away, and it leaves by itself when the player is closed. */
@SuppressLint("ViewConstructor")
class PlayerScreen(context: Context, private val player: MusicPlayer) : Screen(context) {
  private val scroll = ScrollView(context)
  private val column = LinearLayout(context)
  private val cover = MusicCoverView(context, 16f)
  private val kicker = AIKit.label(context, "", 12f, 600, Theme.muted, lines = 1, align = Gravity.CENTER)
  private val heading = AIKit.label(context, "", 22f, 700, lines = 2)
  private val artist = AIKit.label(context, "", 15f, color = Theme.muted, lines = 1)
  private val origin = AIKit.label(context, "", 10f, 700, Theme.subtle, lines = 1)
  private val heart = AIIconButton(context, "heart", 22f, Theme.muted)
  private val extra = AIIconButton(context, "more", 20f, Theme.text, "Ещё")
  private val shuffleChip = MusicChip(context, "Перемешать", "shuffle", false)
  private val heartChip = MusicChip(context, "В любимое", "heart", false)
  private val slider = SeekBar(context)
  private val elapsed = AIKit.label(context, "0:00", 11f, color = Theme.muted, lines = 1)
  private val total = AIKit.label(context, "—:—", 11f, color = Theme.muted, lines = 1, align = Gravity.END)
  private val repeatButton = AIIconButton(context, "repeat", 22f, Theme.muted)
  private val backButton = AIIconButton(context, "prev", 28f, Theme.text, "Предыдущий трек или начало текущего")
  private val playButton = AIRoundButton(context, "play", "Воспроизвести", size = 72f, icon = 30f)
  private val forwardButton = AIIconButton(context, "next", 28f, Theme.text, "Следующий трек")
  private val waiting = AIKit.spinner(context, Theme.muted)
  private val message = AIKit.label(context, "", 13f, color = Theme.danger)
  private val queueButton = AIKit.label(context, "", 14f, 600, lines = 1, align = Gravity.CENTER)
  private val lyricsButton = AIKit.label(context, "Текст", 14f, 600, lines = 1, align = Gravity.CENTER)
  private val queueList = LinearLayout(context)
  private var showQueue = false
  private var queueMark = ""
  private var dragging = false
  private val changed: () -> Unit = { refresh() }

  init {
    setBackgroundColor(Theme.page(0xFF101112.toInt()))
    isClickable = true
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    scroll.isVerticalScrollBarEnabled = false
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(24f), dp(12f), dp(24f), dp(28f))
    scroll.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    addView(scroll)

    val fold = AIIconButton(context, "chevron.down", 20f, Theme.text, "Свернуть плеер")
    fold.setOnClickListener { leave() }
    val shut = AIIconButton(context, "xmark", 18f, Theme.muted, "Закрыть плеер и остановить музыку")
    shut.setOnClickListener { player.stop() }
    val top = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    top.addView(fold, LinearLayout.LayoutParams(dp(40f), dp(44f)))
    top.addView(kicker, LinearLayout.LayoutParams(0, wrap, 1f))
    top.addView(shut, LinearLayout.LayoutParams(dp(40f), dp(44f)))
    column.addView(top, LinearLayout.LayoutParams(wide, wrap))

    // The cover: a square across the width, 340 at most.
    val coverBox = object : FrameLayout(context) {
      override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val side = minOf(MeasureSpec.getSize(widthSpec), dp(340f))
        cover.measure(MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY))
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), side)
      }
      override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        val side = cover.measuredWidth; val from = (right - left - side) / 2
        cover.layout(from, 0, from + side, side)
      }
    }
    coverBox.addView(cover)
    AIKit.add(column, coverBox, 16f)

    heart.setOnClickListener { like() }
    extra.setOnClickListener { showExtra() }
    val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    words.addView(origin)
    AIKit.add(words, heading, 4f)
    AIKit.add(words, artist, 4f)
    val titleRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    titleRow.addView(words, LinearLayout.LayoutParams(0, wrap, 1f))
    titleRow.addView(heart, LinearLayout.LayoutParams(dp(40f), dp(44f)).apply { marginStart = dp(4f) })
    titleRow.addView(extra, LinearLayout.LayoutParams(dp(40f), dp(44f)).apply { marginStart = dp(4f) })
    AIKit.add(column, titleRow, 16f)

    shuffleChip.setOnClickListener { player.toggleShuffle() }
    heartChip.setOnClickListener { like() }
    val chips = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    chips.addView(shuffleChip, LinearLayout.LayoutParams(wrap, dp(38f)))
    chips.addView(heartChip, LinearLayout.LayoutParams(wrap, dp(38f)).apply { marginStart = dp(8f) })
    AIKit.add(column, chips, 16f)

    slider.progressTintList = ColorStateList.valueOf(Theme.text)
    slider.thumbTintList = ColorStateList.valueOf(Theme.text)
    slider.progressBackgroundTintList = ColorStateList.valueOf(Theme.veil(0.16f))
    slider.contentDescription = "Позиция воспроизведения"
    slider.setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
    slider.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
      override fun onProgressChanged(bar: SeekBar?, progress: Int, fromUser: Boolean) {
        if (!fromUser) return
        elapsed.text = MusicCatalog.time(progress / 10.0)
        // A step made without a finger on the line (a keyboard, a screen reader) is a place to go to at once.
        if (!dragging) player.seek(progress / 10.0)
      }
      override fun onStartTrackingTouch(bar: SeekBar?) { dragging = true }
      override fun onStopTrackingTouch(bar: SeekBar?) {
        dragging = false
        player.seek(slider.progress / 10.0)
      }
    })
    val times = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(8f), 0, dp(8f), 0) }
    times.addView(elapsed, LinearLayout.LayoutParams(0, wrap, 1f))
    times.addView(total, LinearLayout.LayoutParams(0, wrap, 1f))
    column.addView(slider, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(16f); leftMargin = -dp(8f); rightMargin = -dp(8f) })
    column.addView(times, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(2f); leftMargin = -dp(8f); rightMargin = -dp(8f) })

    repeatButton.setOnClickListener { player.toggleRepeat() }
    backButton.setOnClickListener { player.previous() }
    playButton.fill = Theme.onBlack(Color.WHITE, Theme.accent)
    playButton.ink = Theme.onAccent
    playButton.setOnClickListener { player.togglePlayback() }
    forwardButton.setOnClickListener { player.next() }
    val controls = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    fun gap() = controls.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
    controls.addView(repeatButton, LinearLayout.LayoutParams(dp(44f), dp(44f)))
    gap()
    controls.addView(backButton, LinearLayout.LayoutParams(dp(52f), dp(52f)))
    gap()
    controls.addView(playButton, LinearLayout.LayoutParams(dp(72f), dp(72f)))
    gap()
    controls.addView(forwardButton, LinearLayout.LayoutParams(dp(52f), dp(52f)))
    gap()
    val waitingBox = FrameLayout(context)
    waitingBox.addView(waiting, FrameLayout.LayoutParams(dp(22f), dp(22f), Gravity.CENTER))
    controls.addView(waitingBox, LinearLayout.LayoutParams(dp(44f), dp(44f)))
    AIKit.add(column, controls, 16f)
    AIKit.add(column, message, 16f)

    queueButton.setOnClickListener {
      showQueue = !showQueue
      refresh()
    }
    lyricsButton.contentDescription = "Текст"
    lyricsButton.setOnClickListener { lyrics() }
    for (button in listOf(queueButton, lyricsButton)) { button.isClickable = true; button.isFocusable = true }
    val panel = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; background = context.plate(Theme.veil(0.06f), 16f) }
    panel.addView(queueButton, LinearLayout.LayoutParams(0, dp(48f), 1f))
    panel.addView(lyricsButton, LinearLayout.LayoutParams(0, dp(48f), 1f))
    AIKit.add(column, panel, 16f)
    queueList.orientation = LinearLayout.VERTICAL
    AIKit.add(column, queueList, 16f)
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

  override fun place(width: Int, height: Int) {
    put(scroll, 0, edges.top, width, height - edges.top - edges.bottom)
  }

  private fun leave() {
    val stack = pages() ?: return
    if (stack.top === this) stack.pop()
  }

  private fun like() { player.current?.let { player.toggleFavorite(it) } }

  private fun showExtra() {
    val track = player.current ?: return
    val favorite = player.isFavorite(track)
    val sheet = AISheet(context, track.title)
    if (track.sourceUrl?.startsWith("https://", ignoreCase = true) == true) {
      sheet.addRow(if (track.source == "soundcloud") "Открыть в SoundCloud" else "Открыть страницу трека", symbol = "link") { sheet.dismiss(); openMusicLink(context, track.sourceUrl) }
    }
    sheet.addRow(if (favorite) "Убрать из любимого" else "В любимое", symbol = if (favorite) "heart.fill" else "heart") { sheet.dismiss(); player.toggleFavorite(track) }
    sheet.open()
  }

  private fun lyrics() {
    try {
      AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Текста пока нет")
        .setMessage("Каталог Audius не передаёт тексты песен, поэтому показать текст этого трека нельзя.").setPositiveButton("Понятно", null).show()
    } catch (_: Exception) { /* the window is gone */ }
  }

  private fun refresh() {
    val track = player.current
    if (track == null) {
      // The player was closed: its page goes with it.
      if (isAttachedToWindow) post { leave() }
      return
    }
    val favorite = player.isFavorite(track)
    cover.bind(track)
    kicker.text = if (track.source == "local") "Мои файлы" else "Сейчас играет"
    if (heading.text.toString() != track.title) heading.text = track.title
    if (artist.text.toString() != track.artist) artist.text = track.artist
    origin.text = MusicWords.origin(track.source)
    heart.symbol = if (favorite) "heart.fill" else "heart"
    heart.color = if (favorite) Theme.text else Theme.muted
    heart.contentDescription = if (favorite) "Убрать из избранного" else "Добавить в избранное"
    shuffleChip.show(if (player.shuffle) "Перемешано" else "Перемешать", "shuffle", player.shuffle)
    shuffleChip.contentDescription = if (player.shuffle) "Случайный порядок включён" else "Включить случайный порядок"
    heartChip.show(if (favorite) "В любимом" else "В любимое", if (favorite) "heart.fill" else "heart", false)

    val length = player.duration
    if (!dragging) {
      // Tenths of a second: the line moves smoothly on a short track too.
      slider.max = Math.round(maxOf(1.0, length) * 10).toInt()
      slider.progress = Math.round(minOf(player.position, maxOf(1.0, length)) * 10).toInt()
      elapsed.text = MusicCatalog.time(player.position)
    }
    slider.isEnabled = length > 0
    total.text = if (length > 0) MusicCatalog.time(length) else "—:—"
    slider.stateDescriptionCompat(MusicCatalog.time(player.position) + " из " + (if (length > 0) MusicCatalog.time(length) else "неизвестной длительности"))

    repeatButton.symbol = if (player.repeatMode == "one") "repeat.1" else "repeat"
    repeatButton.color = if (player.repeatMode == "off") Theme.muted else Theme.text
    repeatButton.contentDescription = if (player.repeatMode == "one") "Повтор одного трека" else if (player.repeatMode == "all") "Повтор очереди" else "Повтор выключен"
    playButton.symbol = if (player.playing) "pause" else "play"
    playButton.contentDescription = if (player.loading) "Загрузка. Повторить воспроизведение" else if (player.playing) "Приостановить" else "Воспроизвести"
    forwardButton.isEnabled = player.queue.size >= 2
    waiting.visibility = if (player.loading) View.VISIBLE else View.INVISIBLE
    if (message.text.toString() != player.error) message.text = player.error
    message.visibility = if (player.error.isEmpty()) View.GONE else View.VISIBLE

    val words = "Очередь · ${player.queue.size}"
    if (queueButton.text.toString() != words) queueButton.text = words
    queueButton.contentDescription = if (showQueue) "Свернуть очередь" else "Показать очередь"
    val mark = (if (showQueue) "1" else "0") + track.id + player.queue.joinToString(",") { it.id }
    if (mark == queueMark) return
    queueMark = mark
    queueList.removeAllViews()
    if (!showQueue) return
    for (item in player.queue.take(100)) {
      val on = item.id == track.id
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(6f), dp(9f), dp(6f), dp(9f))
        isClickable = true
        isFocusable = true
        contentDescription = "Включить: ${item.title}, ${item.artist}"
        setOnClickListener { player.play(item, player.queue) }
      }
      row.addView(AIIconView(context, if (on) "speaker" else "note", 16f, Theme.text), LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { marginEnd = dp(12f) })
      val lines = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
      lines.addView(AIKit.label(context, item.title, 15f, if (on) 700 else 400, lines = 1))
      AIKit.add(lines, AIKit.label(context, item.artist, 12f, color = Theme.muted, lines = 1), 2f)
      row.addView(lines, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
      AIKit.add(queueList, row, 2f)
    }
  }

  /** What a screen reader says of the line's place (Android 11 and later; before that the bar's own percent). */
  private fun SeekBar.stateDescriptionCompat(words: String) {
    if (android.os.Build.VERSION.SDK_INT >= 30 && stateDescription?.toString() != words) stateDescription = words
  }
}
