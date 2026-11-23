package com.linea.messenger.ai

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.TypefaceSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.ThemeStore
import java.io.File
import java.util.UUID

// The pieces the AI screen is made of: the answer's text, one turn of the conversation, round buttons, and the
// sheet used for the consent, the history, the menus and the Platina note. Layout after
// mobile/src/ai/AIScreen.tsx (iOS: AI/AIParts.swift). «Музыка» is built of the same pieces.

object AIText {
  class Block(val text: String, val code: Boolean)

  /** The reference shows an answer as plain selectable text. Here the fenced blocks (``` … ```) of an answer are
   *  additionally set in a monospaced face on a darker ground; everything else stays plain text. Pure: the
   *  pieces of the text in their order. */
  fun blocks(text: String): List<Block> {
    val parts = text.split("```")
    // An unclosed fence is not a block: the text is shown as it is.
    if (parts.size < 3 || parts.size % 2 == 0) return listOf(Block(text, false))
    return parts.mapIndexed { index, part ->
      if (index % 2 == 0) return@mapIndexed Block(part, false)
      var body = part
      // The first line of a block names its language.
      val end = body.indexOf('\n')
      if (end >= 0 && !body.substring(0, end).contains(' ')) body = body.substring(end + 1)
      Block(body.trimEnd('\n'), true)
    }
  }

  /** The text with its blocks of code set apart. `size`: sp. */
  fun styled(context: Context, text: String, size: Float): CharSequence {
    val parts = blocks(text)
    if (parts.size == 1 && !parts[0].code) return text
    val out = SpannableStringBuilder()
    for (part in parts) {
      val start = out.length
      out.append(part.text)
      if (!part.code || part.text.isEmpty()) continue
      out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      out.setSpan(AbsoluteSizeSpan(Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, size - 2f, context.resources.displayMetrics))), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      out.setSpan(ForegroundColorSpan(Theme.text), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      out.setSpan(BackgroundColorSpan(Theme.veil(0.07f)), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    return out
  }
}

/** Hands a file of the app's own folders to the app the person chooses. Those folders are closed to other apps:
 *  a copy goes where the app's own provider (attachments/DecryptedFileProvider.kt) can give this one file, to
 *  read only, to the one app that was chosen. */
object AIShare {
  /** Opens the system's list of apps for `file`. `previous`: the copy made for the share before this one — it is
   *  removed now. Gives the new copy's folder (to pass as `previous` next time), or null when nothing opened. */
  fun send(context: Context, file: File, previous: File?, name: String = file.name): File? {
    previous?.let { DecryptedFiles.remove(it) }
    val folder = File(context.cacheDir, DecryptedFiles.prefix + UUID.randomUUID().toString().lowercase())
    val copy = File(folder, name)
    return try {
      if (!folder.mkdirs()) throw IllegalStateException("folder")
      file.inputStream().use { from -> copy.outputStream().use { to -> from.copyTo(to) } }
      val address = DecryptedFiles.address(context, DecryptedFiles.Written(folder, copy))
      val send = Intent(Intent.ACTION_SEND).setType(DecryptedFiles.mimeType(copy.name)).putExtra(Intent.EXTRA_STREAM, address).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      send.clipData = ClipData.newRawUri("", address)
      context.startActivity(Intent.createChooser(send, null))
      folder
    } catch (_: Exception) {
      folder.deleteRecursively()
      null
    }
  }
}

/** One of `AIIcons`, `size` dp across, in the middle of its place. Not a button. */
@SuppressLint("ViewConstructor")
open class AIIconView(context: Context, symbol: String, private val size: Float, color: Int) : View(context) {
  protected val d = resources.displayMetrics.density
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var color: Int = color
    set(value) { if (field != value) { field = value; invalidate() } }

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val own = Math.round(size * d)
    setMeasuredDimension(resolveSize(own, widthSpec), resolveSize(own, heightSpec))
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    AIIcons.draw(canvas, symbol, width / 2f, height / 2f, size * d, if (isPressed || !isEnabled) Theme.alpha(color, (color ushr 24) / 255f * 0.45f) else color)
  }
}

/** A button that is one picture. Give it a `contentDescription`: that is its name for a screen reader. */
@SuppressLint("ViewConstructor")
open class AIIconButton(context: Context, symbol: String, size: Float, color: Int, words: String = "") : AIIconView(context, symbol, size, color) {
  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    if (words.isNotEmpty()) contentDescription = words
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
}

/** A round button with a symbol on a plate. */
@SuppressLint("ViewConstructor")
class AIRoundButton(context: Context, symbol: String, words: String, active: Boolean = false, private val size: Float = 48f, private val icon: Float = 20f) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  var symbol: String = symbol
    set(value) { if (field != value) { field = value; invalidate() } }
  var active: Boolean = active
    set(value) { if (field != value) { field = value; invalidate() } }
  /** The plate and the picture in other colours than the usual pair (0 = the usual). */
  var fill: Int = 0
    set(value) { if (field != value) { field = value; invalidate() } }
  var ink: Int = Theme.text
    set(value) { if (field != value) { field = value; invalidate() } }
  var bordered = true

  init {
    isClickable = true
    isFocusable = true
    contentDescription = words
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    val own = Math.round(size * d)
    setMeasuredDimension(resolveSize(own, widthSpec), resolveSize(own, heightSpec))
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f; val cy = height / 2f; val radius = minOf(width, height) / 2f
    val dim = if (isPressed || !isEnabled) 0.5f else 1f
    paint.style = Paint.Style.FILL
    paint.color = if (fill != 0) fill else if (active) Theme.veil(0.16f) else Theme.surface2
    paint.alpha = Math.round(paint.alpha * dim)
    canvas.drawCircle(cx, cy, radius, paint)
    if (bordered && fill == 0) {
      paint.style = Paint.Style.STROKE
      paint.strokeWidth = d
      paint.color = Theme.veil((if (active) 0.5f else 0.1f) * dim)
      canvas.drawCircle(cx, cy, radius - d / 2, paint)
    }
    AIIcons.draw(canvas, symbol, cx, cy, icon * d, Theme.alpha(ink, (ink ushr 24) / 255f * dim))
  }
}

/** A wide button: filled (the main action) or quiet; a picture may stand before its words. */
@SuppressLint("ViewConstructor")
/** The reference's `Button` (components.tsx): 54 tall, radius 21, 21 inside, the glyph (20) 10 before the words (16
 *  bold, −0.15), a `Bouncy` press to 0.96, disabled at 0.45. Primary: the accent gradient (0,0 → 0.9,1 at 0.96) with a
 *  white sheen (0.22 → clear, 0,0 → 0.4,0.65) and a 1 dp edge; secondary: regular glass. */
class AIWideButton(context: Context, label: String, symbol: String? = null, private val secondary: Boolean = false) : LinearLayout(context) {
  private val d = resources.displayMetrics.density
  private val text = context.words(label, 16f, if (secondary) Theme.text else Theme.onAccent, 700).apply { letterSpacing = -0.15f / 16f }
  private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
  private val box = android.graphics.RectF()

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER
    setWillNotDraw(false)
    if (secondary) background = com.linea.messenger.design.GlassDrawable(this, 21f * d, clear = false)
    setPadding(context.px(21f), 0, context.px(21f), 0)
    minimumHeight = context.px(54f)
    if (symbol != null) addView(AIIconView(context, symbol, 20f, if (secondary) Theme.text else Theme.onAccent), LayoutParams(context.px(20f), context.px(20f)).apply { marginEnd = context.px(10f) })
    text.gravity = Gravity.CENTER
    addView(text, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    isClickable = true
    isFocusable = true
    contentDescription = label
    com.linea.messenger.chatlook.Bouncy.attach(this, 0.96f)
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) {
    super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(context.px(54f), MeasureSpec.EXACTLY))
  }

  override fun onDraw(canvas: android.graphics.Canvas) {
    super.onDraw(canvas)
    if (secondary) return
    val w = width.toFloat(); val h = height.toFloat(); val r = 21f * d
    box.set(0f, 0f, w, h)
    val colors = com.linea.messenger.settings.ThemeStore.look.accentGradient.takeIf { it.size >= 2 }?.toIntArray() ?: intArrayOf(Theme.accent, Theme.accent)
    paint.style = android.graphics.Paint.Style.FILL
    paint.shader = android.graphics.LinearGradient(0f, 0f, 0.9f * w, h, colors, null, android.graphics.Shader.TileMode.CLAMP)
    paint.alpha = Math.round(0.96f * 255)
    canvas.drawRoundRect(box, r, r, paint)
    paint.alpha = 255
    paint.shader = android.graphics.LinearGradient(0f, 0f, 0.4f * w, 0.65f * h, 0x38FFFFFF, 0x00FFFFFF, android.graphics.Shader.TileMode.CLAMP)
    canvas.drawRoundRect(box, r, r, paint)
    paint.shader = null
    paint.style = android.graphics.Paint.Style.STROKE; paint.strokeWidth = d
    paint.color = if (Theme.dark) 0x94EBF5FF.toInt() else 0x59FFFFFF
    box.inset(d / 2, d / 2)
    canvas.drawRoundRect(box, r, r, paint)
  }

  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"

  override fun setEnabled(enabled: Boolean) {
    super.setEnabled(enabled)
    alpha = if (enabled) 1f else 0.45f
  }
}

object AIKit {
  fun label(context: Context, text: CharSequence, size: Float, weight: Int = 400, color: Int = Theme.text, lines: Int = 0, align: Int = Gravity.START): TextView =
    context.words("", size, color, weight).apply {
      this.text = text
      if (lines > 0) { maxLines = lines; ellipsize = TextUtils.TruncateAt.END }
      gravity = align
    }

  fun spinner(context: Context, color: Int = Theme.accent): ProgressBar = ProgressBar(context).apply {
    isIndeterminate = true
    indeterminateTintList = ColorStateList.valueOf(color)
  }

  /** A few words on a quiet plate. */
  fun notice(context: Context, text: String, error: Boolean): View = LinearLayout(context).apply {
    background = context.plate(Theme.veil(0.06f), 14f)
    setPadding(context.px(14f), context.px(12f), context.px(14f), context.px(12f))
    addView(label(context, text, 13f, color = if (error) Theme.danger else Theme.text), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    if (error) accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
  }

  /** A column's own way of adding a part: as wide as the column, `gap` dp under the part before it. */
  fun add(column: LinearLayout, part: View, gap: Float = 0f, wide: Boolean = true) {
    val params = LinearLayout.LayoutParams(if (wide) LinearLayout.LayoutParams.MATCH_PARENT else LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    if (column.childCount > 0) params.topMargin = column.context.px(gap)
    column.addView(part, params)
  }
}

/** A sheet from below with a heading and whatever rows it is given. The system's Back and a touch outside close it. */
class AISheet(context: Context, heading: String) : Dialog(context) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  val stack = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
  /** Called once, when the sheet is gone — however it was closed. */
  var onClosed: (() -> Unit)? = null

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val scroll = object : ScrollView(context) {
      // The sheet is as tall as its rows need, up to most of the screen.
      override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val most = Math.round(resources.displayMetrics.heightPixels * 0.82f)
        super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(most, MeasureSpec.AT_MOST))
      }
    }
    scroll.isVerticalScrollBarEnabled = false
    scroll.background = GradientDrawable().apply { setColor(Theme.page(0xFF141516.toInt())); cornerRadii = floatArrayOf(24f * d, 24f * d, 24f * d, 24f * d, 0f, 0f, 0f, 0f) }
    stack.setPadding(dp(20f), dp(24f), dp(20f), dp(28f))
    scroll.addView(stack, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    if (heading.isNotEmpty()) stack.addView(AIKit.label(context, heading, 20f, 700))
    setContentView(scroll, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.let { window ->
      window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      window.setGravity(Gravity.BOTTOM)
      window.setDimAmount(0.55f)
      com.linea.messenger.design.sheetWindow(window, scroll) // the sheet's colour to the screen's bottom, under the bar
    }
    setCanceledOnTouchOutside(true)
    setOnDismissListener {
      val closed = onClosed
      onClosed = null
      closed?.invoke()
    }
  }

  /** A part under the ones before it. */
  fun add(part: View, gap: Float = 12f, wide: Boolean = true) = AIKit.add(stack, part, gap, wide)

  fun addText(text: String, size: Float = 13f, weight: Int = 400, color: Int = Theme.muted) = add(AIKit.label(context, text, size, weight, color))

  /** A row to choose: a picture, the words with a quieter line under them, a tick when it is the chosen one. */
  fun addRow(label: String, help: String? = null, symbol: String? = null, checked: Boolean = false, enabled: Boolean = true, danger: Boolean = false, gap: Float = 4f, action: () -> Unit): View {
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = dp(48f)
      setPadding(dp(10f), dp(8f), dp(10f), dp(8f))
      if (checked) background = context.plate(Theme.veil(0.1f), 16f)
      isClickable = true
      isFocusable = true
      isEnabled = enabled
      alpha = if (enabled) 1f else 0.45f
      contentDescription = if (help.isNullOrEmpty()) label else "$label. $help"
    }
    val ink = if (danger) Theme.danger else Theme.text
    if (symbol != null) row.addView(AIIconView(context, symbol, 18f, ink), LinearLayout.LayoutParams(dp(22f), dp(22f)).apply { marginEnd = dp(12f) })
    val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    words.addView(AIKit.label(context, label, 15f, if (checked) 600 else 500, ink, lines = 2))
    if (!help.isNullOrEmpty()) words.addView(AIKit.label(context, help, 12f, color = Theme.muted), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(3f) })
    row.addView(words, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    if (checked) row.addView(AIIconView(context, "check", 16f, Theme.text), LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { marginStart = dp(8f) })
    row.setOnClickListener { action() }
    add(row, gap)
    return row
  }

  /** Shows the sheet; nothing happens when the window is already gone. */
  fun open() { try { show() } catch (_: Exception) { /* the window is gone */ } }
}

/** One question with what came of it: the answer, the progress, or why there is none. */
@SuppressLint("ViewConstructor")
class AITurnView(context: Context, private val turn: AITurn, retryable: Boolean, canRetry: Boolean, private val router: Boolean, details: Boolean, playing: Boolean,
                 private val clock: () -> Long = System::currentTimeMillis) : LinearLayout(context) {
  var onRetry: (() -> Unit)? = null
  var onDetails: (() -> Unit)? = null
  var onShare: ((File) -> Unit)? = null
  var onPlay: ((File) -> Unit)? = null
  var onVideo: ((File) -> Unit)? = null
  private var progress: TextView? = null
  private var firstMark: View? = null
  private var firstSpin: View? = null
  private var slow: View? = null
  private var mediaFile: File? = null
  private fun dp(value: Float) = context.px(value)

  init {
    orientation = VERTICAL
    setPadding(0, 0, 0, dp(8f))
    addView(questionRow())
    val answer = turn.answer
    val under = if (answer != null) answerCard(answer, details, playing) else if (turn.status == "pending") progressRows() else failedRows(retryable, canRetry)
    AIKit.add(this, under, 10f)
  }

  private fun questionRow(): View {
    val code = turn.question.startsWith(AIModel.codeTaskPrefix)
    val row = FrameLayout(context)
    val bubble = LinearLayout(context).apply {
      orientation = VERTICAL
      background = context.plate(ThemeStore.look.bubble, 22f, Theme.veil(0.08f))
      setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
    }
    if (code) bubble.addView(AIKit.label(context, "Задача по коду", 10f, 700))
    val words = AIKit.label(context, if (code) turn.question.substring(AIModel.codeTaskPrefix.length) else turn.question, 15f)
    words.setLineSpacing(dp(2f).toFloat(), 1f)
    AIKit.add(bubble, words, 6f, wide = false)
    row.addView(bubble, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.END).apply { leftMargin = dp(28f) })
    return row
  }

  private fun answerCard(answer: AIReply, details: Boolean, playing: Boolean): View {
    val card = LinearLayout(context).apply {
      orientation = VERTICAL
      background = context.plate(Theme.surface2, 23f, Theme.veil(0.08f))
      setPadding(dp(16f), dp(16f), dp(16f), dp(10f))
    }
    val head = LinearLayout(context).apply {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      isClickable = true
      isFocusable = true
      contentDescription = "Как получен ответ"
      setOnClickListener { onDetails?.invoke() }
    }
    head.addView(AIKit.label(context, AIModel.answerHead(turn.ms), 12f, 700, Theme.accent))
    head.addView(AIIconView(context, if (details) "chevron.up" else "chevron.down", 10f, Theme.accent), LayoutParams(dp(12f), dp(12f)).apply { marginStart = dp(6f) })
    AIKit.add(card, head, wide = false)
    if (details) {
      AIKit.add(card, AIKit.label(context, "Выбор: " + AIModel.modelLabel(turn.model ?: "auto"), 12f, color = Theme.muted), 11f)
      AIKit.add(card, AIKit.label(context, "Ответила модель: " + answer.model, 12f, color = Theme.muted), 11f)
      if (answer.routedVia != null) AIKit.add(card, AIKit.label(context, "Через: " + answer.routedVia, 12f, color = Theme.muted), 11f)
    }
    var hasMedia = false
    val media = turn.media
    val file = media?.let { AIMediaCache.file(it.uri) }
    if (media != null && file != null) {
      hasMedia = true
      mediaFile = file
      if (media.mimeType.startsWith("image/")) {
        val picture = object : ImageView(context) {
          // A square as wide as the card.
          override fun onMeasure(widthSpec: Int, heightSpec: Int) = super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(MeasureSpec.getSize(widthSpec), MeasureSpec.EXACTLY))
        }
        picture.scaleType = ImageView.ScaleType.CENTER_CROP
        picture.setBackgroundColor(Theme.veil(0.05f))
        picture.clipToOutline = true
        picture.outlineProvider = object : ViewOutlineProvider() {
          override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, 16f * resources.displayMetrics.density)
        }
        picture.setImageBitmap(decode(file))
        picture.isClickable = true
        picture.isFocusable = true
        picture.contentDescription = "Сохранить или отправить картинку"
        picture.setOnClickListener { shareMedia() }
        AIKit.add(card, picture, 11f)
      } else {
        val video = media.mimeType == "video/mp4"
        val row = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val play = AIRoundButton(context, if (video) "play.rect" else if (playing) "pause" else "play", if (video) "Смотреть" else if (playing) "Пауза" else "Слушать", active = true, size = 50f)
        play.setOnClickListener { mediaFile?.let { if (video) onVideo?.invoke(it) else onPlay?.invoke(it) } }
        row.addView(play, LayoutParams(dp(50f), dp(50f)))
        row.addView(AIKit.label(context, "Готово", 12f, color = Theme.muted), LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10f) })
        val send = AIIconButton(context, "share", 20f, Theme.accent, "Сохранить или отправить")
        send.setOnClickListener { shareMedia() }
        row.addView(send, LayoutParams(dp(44f), dp(44f)))
        AIKit.add(card, row, 11f)
      }
    }
    val gone = !hasMedia && (turn.kind == "image" || turn.kind == "video" || turn.kind == "speech")
    if (gone) AIKit.add(card, AIKit.label(context, "Файл удалён из кэша", 12f, color = Theme.muted), 11f)
    if (!(gone && turn.kind != "speech")) {
      val small = hasMedia || gone
      val body = AIKit.label(context, "", if (small) 13f else 15f, color = if (small) Theme.muted else Theme.text)
      body.text = AIText.styled(context, answer.text, if (small) 13f else 15f)
      body.setLineSpacing(dp(4f).toFloat(), 1f)
      body.setTextIsSelectable(true)
      AIKit.add(card, body, 11f)
    }
    val copy = AIIconButton(context, "copy", 17f, Theme.accent, "Скопировать ответ AI")
    copy.setOnClickListener {
      (context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("AI", answer.text))
      copy.symbol = "check"
      copy.postDelayed({ copy.symbol = "copy" }, 1500)
    }
    card.addView(copy, LayoutParams(dp(40f), dp(34f)).apply { gravity = Gravity.END; topMargin = dp(6f) })
    return card
  }

  /** A made picture, small enough for the card whatever its own size. */
  private fun decode(file: File) = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1600) sample *= 2
    BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
  } catch (_: Throwable) { null }

  private fun shareMedia() { mediaFile?.let { onShare?.invoke(it) } }

  private fun stepRow(lead: View, text: TextView): LinearLayout = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    addView(lead, LayoutParams(dp(18f), dp(18f)).apply { marginEnd = dp(9f) })
    addView(text, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
  }

  private fun progressRows(): View {
    val column = LinearLayout(context).apply { orientation = VERTICAL; setPadding(dp(6f), dp(4f), dp(6f), dp(4f)) }
    val lead = FrameLayout(context)
    val mark = AIIconView(context, "check.circle", 16f, Theme.accent)
    mark.visibility = View.INVISIBLE
    val spin = AIKit.spinner(context)
    lead.addView(mark, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    lead.addView(spin, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    column.addView(stepRow(lead, AIKit.label(context, "Запрос отправлен на сервер", 13f, color = Theme.muted)))
    val working = AIKit.label(context, "", 13f)
    AIKit.add(column, stepRow(AIKit.spinner(context), working), 8f)
    val waiting = AIKit.label(context, if (router) "Бесплатные модели бывают заняты — сервер может переключиться на другую. Ждём до 2 минут." else "Бесплатные модели иногда отвечают медленно. Ждём до 2 минут.", 11f, color = Theme.muted)
    waiting.visibility = View.GONE
    AIKit.add(column, waiting, 8f)
    progress = working
    firstMark = mark
    firstSpin = spin
    slow = waiting
    tick()
    return column
  }

  /** The honest elapsed time of a pending turn; called twice a second by the screen. */
  fun tick() {
    val progress = progress ?: return
    val now = clock()
    val seconds = maxOf(0L, (now - (turn.startedAt ?: now)) / 1000)
    val words = AIModel.workingWords(turn, router) + " · $seconds с"
    if (progress.text.toString() != words) progress.text = words
    firstMark?.visibility = if (seconds < 1) View.INVISIBLE else View.VISIBLE
    firstSpin?.visibility = if (seconds >= 1) View.INVISIBLE else View.VISIBLE
    slow?.visibility = if (seconds >= 12 && turn.kind != "video") View.VISIBLE else View.GONE
  }

  private fun failedRows(retryable: Boolean, canRetry: Boolean): View {
    val column = LinearLayout(context).apply { orientation = VERTICAL; setPadding(dp(8f), 0, dp(8f), 0) }
    val words = if (turn.status == "cancelled") "Ожидание ответа отменено." else turn.error.orEmpty().ifEmpty { "Ответ не получен." }
    column.addView(AIKit.label(context, words, 12f, color = if (turn.status == "failed") Theme.danger else Theme.muted))
    if (retryable) {
      val again = AIWideButton(context, if (turn.question.startsWith(AIModel.codeTaskPrefix)) "Повторить эту задачу" else "Повторить этот вопрос", "refresh", secondary = true)
      again.isEnabled = canRetry
      again.setOnClickListener { onRetry?.invoke() }
      AIKit.add(column, again, 8f)
    }
    return column
  }
}
