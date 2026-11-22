package com.linea.messenger.attachments

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.attachments.PhotoEditModel.Box
import com.linea.messenger.attachments.PhotoEditModel.Edit
import com.linea.messenger.attachments.PhotoEditModel.Mask
import com.linea.messenger.attachments.PhotoEditModel.Point
import com.linea.messenger.attachments.PhotoEditModel.Stroke
import com.linea.messenger.design.Theme
import java.util.concurrent.Executors
import kotlin.math.hypot
import kotlin.math.roundToInt

/** Media: the photo editor before sending (the reference's photo/editor/PhotoEditorScreen.tsx with EditorPanels.tsx,
 *  EditorCanvas.tsx, useEffectPreview.ts and editorHistory.ts; native/ios/Sources/Attachments/PhotoEditor.swift):
 *  «Обрезка» (free or 1:1, 4:3, 3:4, 16:9 by dragging a frame; «Повернуть на 90°», «Отразить»), «Рисование» (eight
 *  colours, three widths), «Убрать объект» (paint over it: the area is filled from its neighbours), «Фон»
 *  («Исходный», «Без фона», «Белый» — ML Kit on the phone, as the reference's Android side), «Улучшить» (photo or a
 *  black-and-white / colour document, ×1 ×2 ×4) and «Размер и формат» (full or half, JPEG or PNG), with undo, redo
 *  and «Сбросить». The edited picture is then cleaned like any photo (`PhotoPrepare`): nothing of the original's
 *  metadata survives. */
class PhotoEditor(context: Context, private val original: Bitmap) : Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
  /** What «Готово» gives: the edited bitmap and the chosen format. */
  class Output(val image: Bitmap, val format: String)

  /** The finished picture (null when nothing was changed: the original goes as it is). */
  var onDone: ((Output?) -> Unit)? = null
  var onCancel: (() -> Unit)? = null

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = (value * d).roundToInt()
  private val main = Handler(Looper.getMainLooper())
  private val history = PhotoEditModel.History()
  private val shown: Edit get() = history.shown
  private var editorTab = "crop"
  private var aspect: Double? = null
  private var penColor = 0xFF3B30
  private var penWidth = 0.012
  private var brushRadius = 0.02
  private var busy = false
  private var errorWords = ""
  private var finished = false
  // «Фон»: what ML Kit can do here (asked once «Фон» is first opened, never before) and «Готовим…».
  private var abilities: PhotoBackground.Abilities? = null
  private var asking = false
  private var preparing = false
  // The deferred preview of the effects (the reference's useEffectPreview: 400 ms, four kept).
  private val previews = ArrayList<Pair<String, Bitmap>>()
  private var previewRevision = 0

  private val canvas = EditorCanvas(context)
  private val closeButton = KitIcon(context, "xmark", 19f, Color.WHITE)
  private val undoButton = KitIcon(context, "undo", 19f, Color.WHITE)
  private val redoButton = KitIcon(context, "redo", 19f, Color.WHITE)
  private val resetButton = TextView(context)
  private val busyPill = LinearLayout(context)
  private val errorLabel = TextView(context)
  private val tools = HorizontalScrollView(context)
  private val toolsRow = LinearLayout(context)
  private val tools2 = HorizontalScrollView(context)
  private val tools2Row = LinearLayout(context)
  private val hint = TextView(context)
  private val hint2 = TextView(context)
  private val tabsRow = HorizontalScrollView(context)
  private val tabsLine = LinearLayout(context)
  private val tabButtons = ArrayList<TabButton>()
  private val sendButton = KitIcon(context, "check", 24f, Color.WHITE)
  private val sendSpinner = ProgressBar(context)

  /** A tab of the editor: its icon over its name. */
  @SuppressLint("ViewConstructor")
  private inner class TabButton(val tab: PhotoEditModel.Tab) : View(context) {
    private val words = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10.5f * d; textAlign = Paint.Align.CENTER; typeface = Theme.weight(400) }
    var on = false
    init { isClickable = true; isFocusable = true; contentDescription = tab.label }
    override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
    override fun onDraw(canvas: Canvas) {
      val color = if (on) ACCENT else 0xFFD8DCE4.toInt()
      if (on) { words.color = 0x330A84FF; canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), 12f * d, 12f * d, words) }
      KitIcons.draw(canvas, tab.symbol, width / 2f, height / 2f - 8f * d, 21f * d, color)
      words.color = color
      var label = tab.label
      while (label.length > 3 && words.measureText(label) > width - 8f * d) label = label.dropLast(2) + "…"
      canvas.drawText(label, width / 2f, height / 2f + 18f * d, words)
    }
    fun measuredWidth(): Int = minOf(dp(110f), maxOf(dp(62f), (words.measureText(tab.label) + 20f * d).roundToInt()))
  }

  /** The page: its parts placed by hand, from the bottom up, as the iOS editor lays them out. */
  private val root = object : ViewGroup(context) {
    override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
    private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
      if (width <= 0 || height <= 0) { view.layout(0, 0, 0, 0); return }
      view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
      view.layout(left, top, left + width, top + height)
    }
    private fun textHeight(view: TextView, width: Int): Int {
      view.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
      return view.measuredHeight
    }
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val width = r - l; val height = b - t
      val insets = rootWindowInsets
      val top = (if (Build.VERSION.SDK_INT >= 30) insets?.getInsets(android.view.WindowInsets.Type.systemBars())?.top else null) ?: 0
      val low = (if (Build.VERSION.SDK_INT >= 30) insets?.getInsets(android.view.WindowInsets.Type.systemBars())?.bottom else null) ?: 0
      put(closeButton, dp(8f), top + dp(4f), dp(44f), dp(44f))
      put(undoButton, dp(56f), top + dp(4f), dp(44f), dp(44f))
      put(redoButton, dp(100f), top + dp(4f), dp(44f), dp(44f))
      put(resetButton, width - dp(104f), top + dp(4f), dp(96f), dp(44f))
      var y = height - low
      if (busy) { put(hint2, dp(16f), y - dp(18f), width - dp(32f), dp(16f)); y -= dp(22f) }
      val tabY = y - dp(62f)
      put(sendButton, width - dp(66f), tabY + dp(1f), dp(54f), dp(54f))
      put(sendSpinner, width - dp(66f) + dp(15f), tabY + dp(16f), dp(24f), dp(24f))
      var x = dp(8f)
      for (button in tabButtons) { val w = button.measuredWidth(); (button.layoutParams as LinearLayout.LayoutParams).width = w; x += w + dp(2f) }
      put(tabsRow, 0, tabY, maxOf(0, width - dp(72f)), dp(58f))
      y = tabY - dp(10f)
      for (label in listOf(hint2, hint)) {
        if (label.text.isNullOrEmpty() || (label === hint2 && busy)) { if (!(label === hint2 && busy)) put(label, 0, 0, 0, 0); continue }
        val h = textHeight(label, width - dp(32f))
        put(label, dp(16f), y - h, width - dp(32f), h)
        y -= h + dp(8f)
      }
      if (toolsRow2Empty()) put(tools2, 0, 0, 0, 0) else { put(tools2, 0, y - dp(40f), width, dp(40f)); y -= dp(49f) }
      put(tools, 0, y - dp(40f), width, dp(40f))
      y -= dp(46f)
      if (errorWords.isEmpty()) put(errorLabel, 0, 0, 0, 0) else {
        val h = textHeight(errorLabel, width - dp(32f))
        put(errorLabel, dp(16f), y - h, width - dp(32f), h)
        y -= h + dp(6f)
      }
      put(canvas, 0, top + dp(52f), width, maxOf(0, y - top - dp(52f)))
      busyPill.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(dp(34f), MeasureSpec.EXACTLY))
      val pill = busyPill.measuredWidth
      put(busyPill, (width - pill) / 2, top + dp(52f) + dp(12f), pill, dp(34f))
    }
  }

  private fun toolsRow2Empty() = tools2Row.childCount == 0

  init {
    root.setBackgroundColor(Color.BLACK)
    closeButton.contentDescription = "Отменить редактирование фото"
    closeButton.setOnClickListener { cancelNow() }
    undoButton.contentDescription = "Отменить действие"
    undoButton.setOnClickListener { if (!busy && history.undo()) { undoButton.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); refresh() } }
    redoButton.contentDescription = "Повторить действие"
    redoButton.setOnClickListener { if (!busy && history.redo()) { redoButton.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); refresh() } }
    resetButton.text = "Сбросить"
    resetButton.textSize = 15f
    resetButton.setTextColor(Color.WHITE)
    resetButton.gravity = Gravity.CENTER
    resetButton.contentDescription = "Сбросить все изменения"
    resetButton.setOnClickListener { if (!busy) { aspect = null; commit(Edit()) } }
    for (view in listOf(closeButton, undoButton, redoButton, resetButton)) root.addView(view)
    canvas.onCrop = { crop -> commit(shown.copy(crop = crop)) }
    canvas.onStroke = { stroke -> commit(shown.copy(strokes = shown.strokes + stroke)) }
    canvas.onMask = { mask ->
      if (!PhotoEditModel.maskFits(shown, mask)) showError(PhotoBitmap.words(PhotoFailure("MASK_TOO_COMPLEX")))
      else commit(shown.copy(masks = shown.masks + mask))
    }
    root.addView(canvas)
    busyPill.orientation = LinearLayout.HORIZONTAL
    busyPill.gravity = Gravity.CENTER_VERTICAL
    busyPill.setPadding(dp(14f), 0, dp(14f), 0)
    busyPill.background = GradientDrawable().apply { setColor(0x99000000.toInt()); cornerRadius = 16f * d }
    busyPill.addView(ProgressBar(context).apply { isIndeterminate = true; indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE) }, LinearLayout.LayoutParams(dp(20f), dp(20f)))
    busyPill.addView(TextView(context).apply { text = "Обрабатываем…"; textSize = 13f; setTextColor(Color.WHITE) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(8f) })
    busyPill.visibility = View.GONE
    root.addView(busyPill)
    errorLabel.textSize = 12.5f
    errorLabel.setTextColor(0xFFFF8A80.toInt())
    errorLabel.gravity = Gravity.CENTER_HORIZONTAL
    errorLabel.maxLines = 2
    root.addView(errorLabel)
    for ((scroll, row) in listOf(tools to toolsRow, tools2 to tools2Row)) {
      scroll.isHorizontalScrollBarEnabled = false
      row.orientation = LinearLayout.HORIZONTAL
      row.gravity = Gravity.CENTER_VERTICAL
      row.setPadding(dp(14f), 0, dp(6f), 0)
      scroll.addView(row, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
      root.addView(scroll)
    }
    for (label in listOf(hint, hint2)) {
      label.textSize = 12f
      label.setTextColor(MUTED)
      label.maxLines = 3
      root.addView(label)
    }
    tabsRow.isHorizontalScrollBarEnabled = false
    tabsLine.orientation = LinearLayout.HORIZONTAL
    tabsLine.setPadding(dp(8f), dp(1f), dp(8f), dp(1f))
    tabsRow.addView(tabsLine, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
    for (tab in PhotoEditModel.tabs) {
      val button = TabButton(tab)
      button.setOnClickListener { if (!busy) { editorTab = tab.id; refresh() } }
      tabsLine.addView(button, LinearLayout.LayoutParams(dp(62f), dp(56f)).apply { rightMargin = dp(2f) })
      tabButtons.add(button)
    }
    root.addView(tabsRow)
    sendButton.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF0A84FF.toInt()) }
    sendButton.contentDescription = "Отправить фото"
    sendButton.setOnClickListener { sendNow() }
    root.addView(sendButton)
    sendSpinner.isIndeterminate = true
    sendSpinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
    sendSpinner.visibility = View.GONE
    root.addView(sendSpinner)
    canvas.image = original
    setContentView(root)
    window?.apply {
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      statusBarColor = Color.BLACK
      navigationBarColor = Color.BLACK
    }
    setOnCancelListener { finishCancel() }
    refresh()
  }

  // The history

  private fun commit(next: Edit) {
    if (!history.commit(next)) return
    errorWords = ""
    refresh()
  }

  private fun showError(words: String) {
    errorWords = words
    errorLabel.text = words
    root.requestLayout()
  }

  // The tools

  private fun chip(label: String, spoken: String? = null, badge: String? = null, selected: Boolean, enabled: Boolean = true, action: () -> Unit): TextView {
    val chip = TextView(context)
    val words = SpannableStringBuilder(label)
    words.setSpan(ForegroundColorSpan(if (selected) ACCENT else 0xFFF2F4F8.toInt()), 0, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    if (badge != null) {
      val start = words.length
      words.append("  ").append(badge)
      words.setSpan(ForegroundColorSpan(0xFFFFB340.toInt()), start, words.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      words.setSpan(AbsoluteSizeSpan(10, true), start, words.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    chip.text = words
    chip.textSize = 13f
    chip.typeface = Theme.weight(600)
    chip.gravity = Gravity.CENTER
    chip.setPadding(dp(13f), 0, dp(13f), 0)
    chip.background = GradientDrawable().apply { setColor(if (selected) 0x470A84FF else 0x17FFFFFF); cornerRadius = 16f * d }
    val base = spoken ?: label
    chip.contentDescription = if (badge != null) "$base, $badge" else base
    chip.isSelected = selected
    val on = enabled && !busy
    chip.isEnabled = on
    chip.alpha = if (on) 1f else 0.35f
    chip.setOnClickListener { action() }
    return chip
  }

  private fun dot(index: Int): View {
    val color = PhotoEditModel.penColors[index]
    val on = penColor == color
    val dot = View(context)
    dot.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFF000000.toInt() or color); setStroke(dp(if (on) 3f else 1f), if (on) ACCENT else 0x73FFFFFF) }
    dot.contentDescription = "Цвет: " + PhotoEditModel.colorNames[index]
    dot.isSelected = on
    dot.isClickable = true
    dot.setOnClickListener { penColor = color; refresh() }
    return dot
  }

  private fun fill(row: LinearLayout, items: List<View>) {
    row.removeAllViews()
    for (item in items) {
      val round = item !is TextView
      row.addView(item, LinearLayout.LayoutParams(if (round) dp(30f) else LinearLayout.LayoutParams.WRAP_CONTENT, dp(if (round) 30f else 34f)).apply { rightMargin = dp(8f) })
    }
  }

  private fun refresh() {
    val canEdit = !busy
    fun enable(view: View, on: Boolean) { view.isEnabled = on; view.alpha = if (on) 1f else 0.4f }
    enable(undoButton, history.canUndo && canEdit)
    enable(redoButton, history.canRedo && canEdit)
    enable(resetButton, shown != Edit() && canEdit)
    closeButton.isEnabled = canEdit
    canvas.edit = shown
    canvas.tool = if (editorTab in listOf("crop", "draw", "remove") && canEdit) editorTab else "view"
    canvas.aspect = aspect
    canvas.penColor = penColor
    canvas.penWidth = penWidth
    canvas.brushRadius = brushRadius
    canvas.showMask = editorTab == "remove"
    canvas.transparent = shown.background == "transparent"
    refreshPreview()
    canvas.invalidate()
    for (button in tabButtons) { button.on = button.tab.id == editorTab; button.isSelected = button.on; button.alpha = if (canEdit) 1f else 0.4f; button.invalidate() }
    // The active tab is scrolled into view (EditorPanels.tsx): the row ends before the confirm disc.
    tabButtons.firstOrNull { it.on }?.let { active ->
      tabsRow.post {
        val left = active.left - dp(8f); val right = active.right + dp(8f)
        if (left < tabsRow.scrollX) tabsRow.scrollTo(maxOf(0, left), 0)
        else if (right > tabsRow.scrollX + tabsRow.width) tabsRow.scrollTo(right - tabsRow.width, 0)
      }
    }
    hint.text = ""; hint2.text = ""
    val edit = shown
    when (editorTab) {
      "crop" -> {
        fill(toolsRow, PhotoEditModel.aspects.map { item -> chip(item.label, item.spoken, selected = aspect == item.value) { aspectChosen(item.value) } })
        fill(tools2Row, listOf(chip("↺  Повернуть на 90°", "Повернуть на 90°", selected = false) { commitTurn(true) },
          chip("⇋  Отразить", "Отразить", selected = false) { commitTurn(false) }))
      }
      "draw" -> {
        fill(toolsRow, PhotoEditModel.penColors.indices.map { dot(it) })
        fill(tools2Row, PhotoEditModel.penWidths.map { item -> chip(item.label, "Толщина: " + item.label.lowercase(), selected = penWidth == item.value) { penWidth = item.value; refresh() } })
      }
      "remove" -> {
        fill(toolsRow, PhotoEditModel.brushRadii.map { item -> chip(item.label, "Кисть: " + item.label.lowercase(), selected = brushRadius == item.value) { brushRadius = item.value; refresh() } })
        fill(tools2Row, emptyList())
        hint.text = "Закрась объект — область заполнится соседними цветами. Маска — до 20% кадра."
        if (edit.crop != null) hint2.text = "Предпросмотр считается по всему фото, а при отправке — по обрезанному кадру: у края кадра заполнение может немного отличаться."
      }
      "background" -> {
        // The reference's Android panel: «Без фона» and «Белый» only once Play services has the model.
        askAbilities()
        val able = abilities
        val usable = able?.removal == true && able.ready
        val chips = arrayListOf<View>(
          chip("Исходный", selected = edit.background == "keep") { commit(PhotoEditModel.withBackground(shown, "keep")) },
          chip("Без фона", "Без фона, PNG", badge = "PNG", selected = edit.background == "transparent", enabled = usable) { commit(PhotoEditModel.withBackground(shown, "transparent")) },
          chip("Белый", selected = edit.background == "white", enabled = usable) { commit(PhotoEditModel.withBackground(shown, "white")) },
        )
        if (able != null && able.removal && !able.ready) chips.add(chip(if (preparing) "Готовим…" else "⤓  Подготовить удаление фона", "Подготовить удаление фона", selected = false, enabled = !preparing) { prepareBackground() })
        fill(toolsRow, chips)
        fill(tools2Row, emptyList())
        if (able != null && !able.removal) hint.text = able.reason ?: "Удаление фона недоступно на этом устройстве."
        if (able != null && able.removal) hint2.text = "Удаление фона использует Google ML Kit на устройстве: фото не передаётся Google."
      }
      "enhance" -> {
        fill(toolsRow, listOf(chip("Фото", selected = edit.document == "none") { commit(PhotoEditModel.withDocument(shown, "none")) },
          chip("Ч/б документ", selected = edit.document == "bw") { commit(PhotoEditModel.withDocument(shown, "bw")) },
          chip("Цветной документ", selected = edit.document == "color") { commit(PhotoEditModel.withDocument(shown, "color")) }))
        fill(tools2Row, listOf(1, 2, 4).map { scale -> chip("×$scale", if (scale == 1) "Без увеличения" else "Увеличить в $scale раза", selected = edit.scale == scale) { commit(shown.copy(scale = scale)) } })
      }
      else -> {
        fill(toolsRow, listOf(chip("Полное", "Полный размер", selected = edit.resolution == 1.0) { commit(shown.copy(resolution = 1.0)) },
          chip("50 %", "Половина размера", selected = edit.resolution == 0.5) { commit(shown.copy(resolution = 0.5)) },
          chip("JPEG", selected = edit.format == "jpeg", enabled = edit.background != "transparent") { PhotoEditModel.withFormat(shown, "jpeg")?.let { commit(it) } },
          chip("PNG", selected = edit.format == "png") { PhotoEditModel.withFormat(shown, "png")?.let { commit(it) } }))
        fill(tools2Row, emptyList())
        val turned = canvas.turnedSize
        hint.text = PhotoEditModel.resultWords(PhotoEditModel.plan(turned.first, turned.second, edit), edit)
      }
    }
    if (busy) hint2.text = "Готовим фото…"
    errorLabel.text = errorWords
    root.requestLayout()
  }

  private fun aspectChosen(value: Double?) {
    aspect = value
    if (value != null) {
      val turned = canvas.turnedSize
      commit(shown.copy(crop = PhotoEditModel.centered(value, turned.first.toDouble(), turned.second.toDouble())))
    }
    refresh()
  }

  private fun commitTurn(rotate: Boolean) {
    if (rotate) { aspect?.let { aspect = 1 / it }; commit(PhotoEditModel.rotated(shown)) } else commit(PhotoEditModel.flipped(shown))
  }

  // «Фон»: ML Kit

  private fun askAbilities() {
    if (abilities != null || asking) return
    asking = true
    val app = context.applicationContext
    work.execute {
      val made = try { PhotoBackground(app).capabilities() } catch (_: Throwable) { PhotoBackground.Abilities(false, false, "Для удаления фона нужны доступные сервисы Google Play.") }
      main.post { asking = false; abilities = made; if (isShowing && editorTab == "background") refresh() }
    }
  }

  private fun prepareBackground() {
    if (busy || preparing) return
    preparing = true
    errorWords = ""
    refresh()
    val app = context.applicationContext
    work.execute {
      val made = runCatching { PhotoBackground(app).prepare() }
      main.post {
        preparing = false
        made.getOrNull()?.let { abilities = it } ?: showError(PhotoBitmap.words(made.exceptionOrNull()))
        if (isShowing) refresh()
      }
    }
  }

  // The preview of the effects

  /** Shows the cached preview of the shown effects, or renders it after 400 ms on a thread of its own. */
  private fun refreshPreview() {
    previewRevision += 1
    val key = PhotoEditModel.effectKey(shown)
    if (key == null) { canvas.effectImage = null; setPreviewBusy(false); return }
    val index = previews.indexOfFirst { it.first == key }
    if (index >= 0) {
      val kept = previews.removeAt(index)
      previews.add(kept)
      canvas.effectImage = kept.second
      setPreviewBusy(false)
      return
    }
    setPreviewBusy(true)
    val revision = previewRevision
    val edit = shown
    val metrics = context.resources.displayMetrics
    val maxPixels = maxOf(65_536, minOf(2_000_000, metrics.widthPixels * metrics.heightPixels))
    val app = context.applicationContext
    main.postDelayed({
      if (revision != previewRevision || !isShowing) return@postDelayed
      work.execute {
        val made = runCatching { effectPreview(app, original, edit, maxPixels) }
        main.post {
          if (revision != previewRevision) return@post
          setPreviewBusy(false)
          val image = made.getOrNull()
          if (image != null) {
            previews.add(key to image)
            while (previews.size > 4) previews.removeAt(0)
            canvas.effectImage = image
            canvas.invalidate()
          } else showError(PhotoBitmap.words(made.exceptionOrNull()))
        }
      }
    }, 400)
  }

  private fun setPreviewBusy(on: Boolean) { busyPill.visibility = if (on) View.VISIBLE else View.GONE }

  // The result

  private fun cancelNow() {
    if (busy) return
    finishCancel()
    dismiss()
  }

  private fun finishCancel() {
    if (finished) return
    finished = true
    onCancel?.invoke()
  }

  private fun sendNow() {
    if (busy) return
    val edit = shown
    // Nothing changed: the same path as sending without the editor.
    if (edit == Edit()) { finished = true; dismiss(); onDone?.invoke(null); return }
    val turned = canvas.turnedSize
    val plan = PhotoEditModel.plan(turned.first, turned.second, edit)
    if (plan.downsampled) {
      AlertDialog.Builder(context).setTitle("Фото будет уменьшено")
        .setMessage("Фото будет уменьшено до ${plan.width} × ${plan.height}, чтобы обработка поместилась в память устройства.")
        .setNegativeButton("Отмена", null)
        .setPositiveButton("Отправить") { _, _ -> renderAndSend(edit) }
        .show()
      return
    }
    renderAndSend(edit)
  }

  private fun renderAndSend(edit: Edit) {
    busy = true
    errorWords = ""
    sendButton.symbol = ""
    sendButton.contentDescription = "Готовим фото"
    sendSpinner.visibility = View.VISIBLE
    refresh()
    val app = context.applicationContext
    work.execute {
      val made = runCatching { render(app, original, edit) }
      main.post {
        val image = made.getOrNull()
        if (image != null) {
          finished = true
          if (isShowing) dismiss()
          onDone?.invoke(Output(image, edit.format))
        } else {
          busy = false
          sendSpinner.visibility = View.GONE
          sendButton.symbol = "check"
          sendButton.contentDescription = "Отправить фото"
          errorWords = PhotoBitmap.words(made.exceptionOrNull())
          refresh()
        }
      }
    }
  }

  /** `photoeditor crop|draw|size|remove|background|enhance` (debug builds): the editor on a tab, with a square
   *  frame, a line, a painted area, «Белый» or «Ч/б документ». */
  fun demoShow(tool: String) {
    editorTab = if (PhotoEditModel.tabs.any { it.id == tool }) tool else "crop"
    var next = shown
    when (editorTab) {
      "crop" -> {
        aspect = 1.0
        val turned = canvas.turnedSize
        val sourceAspect = turned.first.toDouble() / maxOf(1, turned.second)
        next = next.copy(crop = Box((1 - 1 / sourceAspect) / 2, 0.0, 1 / sourceAspect, 1.0))
      }
      "draw" -> next = next.copy(strokes = next.strokes + Stroke(0xFF3B30, 0.012, listOf(Point(0.2, 0.6), Point(0.35, 0.45), Point(0.5, 0.62), Point(0.7, 0.4))))
      // Over the drawn sun of the sample picture.
      "remove" -> next = next.copy(masks = next.masks + Mask(0.05, listOf(Point(0.68, 0.25), Point(0.72, 0.3), Point(0.76, 0.25))))
      "background" -> next = next.copy(background = "white")
      "enhance" -> next = next.copy(document = "bw")
      else -> next = next.copy(format = "jpeg")
    }
    commit(next)
    refresh()
  }

  override fun show() {
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  companion object {
    private const val ACCENT = 0xFF4DA3FF.toInt()
    private const val MUTED = 0xFF9AA3B2.toInt()
    private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.photo-editor").apply { isDaemon = true } }

    /** The reference's transform: the picture turned clockwise by `rotation`, then mirrored on screen. */
    fun turned(image: Bitmap, rotation: Int, flip: Boolean): Bitmap {
      if (rotation == 0 && !flip) return image
      val matrix = Matrix()
      matrix.postRotate(rotation.toFloat())
      if (flip) matrix.postScale(-1f, 1f)
      return Bitmap.createBitmap(image, 0, 0, image.width, image.height, matrix, true)
    }

    /** A part of a bitmap drawn into a fresh bitmap of the given size (keeps transparency). */
    fun redraw(image: Bitmap, left: Int, top: Int, width: Int, height: Int, outWidth: Int, outHeight: Int): Bitmap {
      val out = try { Bitmap.createBitmap(outWidth, outHeight, Bitmap.Config.ARGB_8888) } catch (_: OutOfMemoryError) { throw PhotoFailure("OUT_OF_MEMORY") }
      Canvas(out).drawBitmap(image, Rect(left, top, left + width, top + height), Rect(0, 0, outWidth, outHeight), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
      return out
    }

    fun drawStrokes(strokes: List<Stroke>, canvas: Canvas, width: Float, height: Float) {
      val side = minOf(width, height)
      val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
      for (stroke in strokes) {
        if (stroke.points.isEmpty()) continue
        paint.color = 0xFF000000.toInt() or stroke.color
        paint.strokeWidth = maxOf(1f, (stroke.width * side).toFloat())
        canvas.drawPath(line(stroke.points, width, height), paint)
      }
    }

    /** The painted areas as the reference shows them: a translucent band twice the brush radius wide. */
    fun drawMasks(masks: List<Mask>, canvas: Canvas, width: Float, height: Float) {
      val side = minOf(width, height)
      val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = 0x80EA377A.toInt() }
      for (mask in masks) {
        if (mask.points.isEmpty()) continue
        paint.strokeWidth = maxOf(1f, (2 * mask.radius * side).toFloat())
        canvas.drawPath(line(mask.points, width, height), paint)
      }
    }

    private fun line(points: List<Point>, width: Float, height: Float): Path {
      val path = Path()
      val first = points[0]
      path.moveTo((first.x * width).toFloat(), (first.y * height).toFloat())
      if (points.size == 1) path.lineTo((first.x * width).toFloat() + 0.1f, (first.y * height).toFloat())
      for (point in points.drop(1)) path.lineTo((point.x * width).toFloat(), (point.y * height).toFloat())
      return path
    }

    /** The reference's render order (LinePhotoModule.render): removal, background, white/document, enlargement. */
    private fun effects(context: Context, start: Bitmap, masks: List<PhotoStroke>, background: String, document: String, scale: Int): Bitmap {
      var current = start
      if (masks.isNotEmpty()) {
        try { current = PhotoBitmap.bitmap(PhotoPixels.inpaint(PhotoBitmap.pixels(current), masks)) }
        catch (failure: PhotoFailure) { if (failure.reason != "EMPTY_MASK") throw failure /* every painted area lies outside the frame */ }
      }
      if (background != "keep") current = PhotoBackground(context).foreground(current)
      if (background == "white" || document != "none" || scale > 1) {
        var pixels = PhotoBitmap.pixels(current)
        if (background == "white") pixels = PhotoPixels.whiteBackground(pixels)
        if (document != "none") pixels = PhotoPixels.document(pixels, document == "bw")
        if (scale > 1) pixels = PhotoPixels.upscale(pixels, scale)
        current = PhotoBitmap.bitmap(pixels)
      }
      return current
    }

    /** The effects on the whole turned picture at screen size (no crop, no lines, no enlargement). */
    fun effectPreview(context: Context, image: Bitmap, edit: Edit, maxPixels: Int): Bitmap {
      val whole = turned(image, edit.rotation, edit.flip)
      val (width, height) = PhotoEditModel.fit(whole.width, whole.height, maxPixels)
      val small = redraw(whole, 0, 0, whole.width, whole.height, width, height)
      val masks = edit.masks.map { mask -> PhotoStroke(mask.radius, mask.points.map { PhotoPoint(it.x, it.y) }) }
      return effects(context, small, masks, edit.background, edit.document, 1)
    }

    /** The picture as edited: turned and mirrored, cut out and sized, the effects applied, the lines drawn on. */
    fun render(context: Context, image: Bitmap, edit: Edit): Bitmap {
      val whole = turned(image, edit.rotation, edit.flip)
      val width = whole.width.toDouble(); val height = whole.height.toDouble()
      val plan = PhotoEditModel.plan(whole.width, whole.height, edit)
      var current = redraw(whole, plan.cropLeft, plan.cropTop, plan.cropWidth, plan.cropHeight, plan.baseWidth, plan.baseHeight)
      // The painted areas and the lines are normalized to the whole turned picture: into the frame's own units.
      val crop = Box(plan.cropLeft / width, plan.cropTop / height, plan.cropWidth / width, plan.cropHeight / height)
      val unit = minOf(width, height) / maxOf(1, minOf(plan.cropWidth, plan.cropHeight))
      val inFrame = { point: Point -> PhotoPoint((point.x - crop.x) / crop.width, (point.y - crop.y) / crop.height) }
      val masks = edit.masks.map { mask -> PhotoStroke((mask.radius * unit).coerceIn(0.0005, 2.0), mask.points.map(inFrame)) }
      current = effects(context, current, masks, edit.background, edit.document, edit.scale)
      if (edit.strokes.isNotEmpty()) {
        val lines = edit.strokes.map { stroke -> Stroke(stroke.color, minOf(2.0, stroke.width * unit), stroke.points.map { inFrame(it).let { mapped -> Point(mapped.x, mapped.y) } }) }
        if (!current.isMutable) current = current.copy(Bitmap.Config.ARGB_8888, true) ?: throw PhotoFailure("OUT_OF_MEMORY")
        drawStrokes(lines, Canvas(current), current.width.toFloat(), current.height.toFloat())
      }
      return current
    }
  }

  /** The picture being edited, with the frame of the crop, the painted areas and the drawing on it. A drag makes
   *  the frame («Обрезка»), draws («Рисование») or paints what to remove («Убрать объект»). */
  private inner class EditorCanvas(context: Context) : View(context) {
    var image: Bitmap? = null
      set(value) { field = value; cachedTurn = null }
    var edit = Edit()
    /** crop · draw · remove · view */
    var tool = "crop"
    var aspect: Double? = null
    var penColor = 0xFF3B30
    var penWidth = 0.012
    var brushRadius = 0.02
    var showMask = false
    var transparent = false
    /** The effects as rendered for the screen (already turned); null: the plain picture. */
    var effectImage: Bitmap? = null
    var onCrop: ((Box) -> Unit)? = null
    var onStroke: ((Stroke) -> Unit)? = null
    var onMask: ((Mask) -> Unit)? = null
    private var dragStart: Point? = null
    private var dragging: Box? = null
    private var drawing: Stroke? = null
    private var painting: Mask? = null
    private var cachedTurn: Triple<Int, Boolean, Bitmap>? = null
    private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    init { setBackgroundColor(Color.BLACK); contentDescription = "Редактируемое фото" }

    private val turnedImage: Bitmap?
      get() {
        val image = image ?: return null
        cachedTurn?.let { if (it.first == edit.rotation && it.second == edit.flip) return it.third }
        val made = turned(image, edit.rotation, edit.flip)
        cachedTurn = Triple(edit.rotation, edit.flip, made)
        return made
      }

    val turnedSize: Pair<Int, Int>
      get() {
        val image = image ?: return 1 to 1
        return if (edit.rotation % 180 == 0) image.width to image.height else image.height to image.width
      }

    /** Where the turned picture stands in the view (the reference's `containRect`). */
    private fun pictureRect(): RectF {
      val (w, h) = turnedSize
      val scale = minOf(width / w.toFloat(), height / h.toFloat())
      val pw = w * scale; val ph = h * scale
      return RectF((width - pw) / 2, (height - ph) / 2, (width + pw) / 2, (height + ph) / 2)
    }

    private fun normalized(x: Float, y: Float): Point {
      val rect = pictureRect()
      return Point(((x - rect.left) / rect.width()).toDouble().coerceIn(0.0, 1.0), ((y - rect.top) / rect.height()).toDouble().coerceIn(0.0, 1.0))
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (tool == "view") return false
      val point = normalized(event.x, event.y)
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          parent?.requestDisallowInterceptTouchEvent(true)
          when (tool) {
            "draw" -> drawing = Stroke(penColor, penWidth, listOf(point))
            "remove" -> painting = Mask(brushRadius, listOf(point))
            "crop" -> dragStart = point
          }
        }
        MotionEvent.ACTION_MOVE -> {
          val stroke = drawing; val mask = painting; val start = dragStart
          if (tool == "draw" && stroke != null) {
            // A new point only once the finger moved a third of the line's width (the reference's appendBrushPoint).
            val last = stroke.points.last()
            if (hypot(point.x - last.x, point.y - last.y) >= penWidth / 3 && stroke.points.size < 2000) drawing = stroke.copy(points = stroke.points + point)
          } else if (tool == "remove" && mask != null) {
            val last = mask.points.last()
            if (hypot(point.x - last.x, point.y - last.y) >= brushRadius / 3 && mask.points.size < PhotoEditModel.maxMaskPoints) painting = mask.copy(points = mask.points + point)
          } else if (tool == "crop" && start != null) {
            val (w, h) = turnedSize
            dragging = PhotoEditModel.frame(start, point, aspect, w.toDouble(), h.toDouble())
          }
          invalidate()
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          drawing?.let { if (tool == "draw") onStroke?.invoke(it) }
          painting?.let { if (tool == "remove") onMask?.invoke(it) }
          dragging?.let { if (tool == "crop") onCrop?.invoke(it) }
          drawing = null; painting = null; dragging = null; dragStart = null
          invalidate()
        }
      }
      return true
    }

    /** The reference's Checkerboard: 20 pt squares of two light greys. */
    private fun drawChecker(canvas: Canvas, box: RectF) {
      canvas.save()
      canvas.clipRect(box)
      paint.style = Paint.Style.FILL
      paint.color = 0xFFE3E6EB.toInt()
      canvas.drawRect(box, paint)
      paint.color = 0xFFF8F9FC.toInt()
      val step = 10f * d
      var y = box.top
      while (y < box.bottom) {
        var x = box.left
        while (x < box.right) { canvas.drawRect(x, y, x + step, y + step, paint); canvas.drawRect(x + step, y + step, x + 2 * step, y + 2 * step, paint); x += 2 * step }
        y += 2 * step
      }
      canvas.restore()
    }

    override fun onDraw(canvas: Canvas) {
      val plain = turnedImage ?: return
      val box = pictureRect()
      if (transparent) drawChecker(canvas, box)
      canvas.drawBitmap(effectImage ?: plain, null, box, bitmapPaint)
      canvas.save()
      canvas.translate(box.left, box.top)
      val masks = (if (showMask) edit.masks else emptyList()) + listOfNotNull(painting)
      drawMasks(masks, canvas, box.width(), box.height())
      drawStrokes(edit.strokes + listOfNotNull(drawing), canvas, box.width(), box.height())
      canvas.restore()
      // The crop: outside the frame dimmed, the frame itself with its thirds and corners.
      val crop = dragging ?: edit.crop ?: return
      val frame = RectF(box.left + (crop.x * box.width()).toFloat(), box.top + (crop.y * box.height()).toFloat(),
        box.left + (crop.right * box.width()).toFloat(), box.top + (crop.bottom * box.height()).toFloat())
      paint.style = Paint.Style.FILL
      paint.color = 0x8C000000.toInt()
      val outside = Path().apply { fillType = Path.FillType.EVEN_ODD; addRect(box, Path.Direction.CW); addRect(frame, Path.Direction.CW) }
      canvas.drawPath(outside, paint)
      paint.style = Paint.Style.STROKE
      paint.color = Color.WHITE
      paint.strokeWidth = 1.5f * d
      canvas.drawRect(frame, paint)
      paint.color = 0x8CFFFFFF.toInt()
      paint.strokeWidth = 0.5f * d
      for (third in listOf(1f / 3f, 2f / 3f)) {
        canvas.drawLine(frame.left + frame.width() * third, frame.top, frame.left + frame.width() * third, frame.bottom, paint)
        canvas.drawLine(frame.left, frame.top + frame.height() * third, frame.right, frame.top + frame.height() * third, paint)
      }
      // The reference's corner marks: 22 pt, 4 pt thick, just outside the frame.
      paint.color = Color.WHITE
      paint.strokeWidth = 4f * d
      val o = 1f * d; val l = 22f * d
      for ((cx, cy, dx, dy) in listOf(floatArrayOf(frame.left - o, frame.top - o, 1f, 1f), floatArrayOf(frame.right + o, frame.top - o, -1f, 1f),
        floatArrayOf(frame.left - o, frame.bottom + o, 1f, -1f), floatArrayOf(frame.right + o, frame.bottom + o, -1f, -1f)).map { listOf(it[0], it[1], it[2], it[3]) }) {
        canvas.drawLine(cx + dx * l, cy, cx, cy, paint)
        canvas.drawLine(cx, cy, cx, cy + dy * l, paint)
      }
    }
  }
}
