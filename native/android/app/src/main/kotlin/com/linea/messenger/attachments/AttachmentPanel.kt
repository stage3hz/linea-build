package com.linea.messenger.attachments

import android.Manifest
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.text.TextUtils
import android.util.LruCache
import android.util.Size
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.PathInterpolator
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.settings.ThemeStore
import com.linea.messenger.voice.Permits
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/** Media: whether the gallery may be read and how much of it (the reference's useGallery.ts with expo-media-library
 *  on Android): plain rules, so they can be checked without a phone. Android 14 and later let the person allow only
 *  some photos and videos (READ_MEDIA_VISUAL_USER_SELECTED, declared as the reference declares it); Android 13 asks
 *  for photos and videos; earlier phones for the storage. Nothing is asked before the panel opens. */
object GalleryAccess {
  /** What to ask for on this Android version. */
  fun permissions(sdk: Int): List<String> = when {
    sdk >= 34 -> listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    sdk >= 33 -> listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
    else -> listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
  }

  /** full · limited · denied, from what is granted. */
  fun state(sdk: Int, granted: (String) -> Boolean): String = when {
    sdk >= 33 && granted(Manifest.permission.READ_MEDIA_IMAGES) && granted(Manifest.permission.READ_MEDIA_VIDEO) -> "full"
    sdk >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "limited"
    sdk < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> "full"
    else -> "denied"
  }

  /** The reference's `durationLabel`: «0:07», «12:40», «1:02:03»; «Видео» without a length. */
  fun durationText(seconds: Double): String {
    if (!seconds.isFinite() || seconds <= 0) return "Видео"
    val whole = seconds.toInt(); val minutes = whole / 60
    val tail = String.format(java.util.Locale.ROOT, "%02d", whole % 60)
    return if (minutes >= 60) "${minutes / 60}:" + String.format(java.util.Locale.ROOT, "%02d", minutes % 60) + ":" + tail else "$minutes:$tail"
  }

  /** The reference's limit wording when there is no room left. */
  fun limitWords(left: Int): String = if (left > 0) "В этом сообщении осталось мест для вложений: $left. Убери лишнее из выбора."
    else "В сообщении уже максимальное число вложений. Сначала отправь или убери часть файлов."
}

/** Media: the paperclip's own panel (the reference's attachments/AttachmentPanel.tsx, GalleryPane.tsx, useGallery.ts,
 *  gallery.ts and selection.ts; native/ios/Sources/Attachments/AttachmentPanel.swift): a sheet over half the screen
 *  that a pull on its handle raises to almost the whole screen or closes; «Недавние» — the gallery as a grid of four
 *  with the camera first —, «Файл», «Опрос», «Аудио»; what was chosen in a strip with its numbers, «Изменить» on a
 *  photo (the editor), «Добавить · N».
 *
 *  The gallery is read only once the person opens this panel (the system asks then, never earlier), with Android's
 *  own partial access as the reference: «Показаны только разрешённые фото и видео.» and «Добавить доступ». The grid
 *  asks the system for small pictures only; an original is read when it is edited or added. Nothing is sent from
 *  here: what is added goes to `onSend`, and the chat cleans, seals and uploads it as any attachment. */
@SuppressLint("ViewConstructor")
class AttachmentPanel(private val activity: Activity, private val pollAvailable: Boolean) : Dialog(activity, android.R.style.Theme_Translucent_NoTitleBar) {
  /** What the chat receives. A photo is a gallery or camera address, or the edited picture with its format. */
  sealed class Picked {
    class Photo(val uri: Uri?, val edited: Bitmap?, val format: String?, val temporary: java.io.File? = null) : Picked()
    class Video(val uri: Uri) : Picked()
    class File(val uri: Uri, val name: String) : Picked()
  }

  /** One chosen thing (the reference's AttachmentSelection). */
  class Item(val id: String, /** photo · video · audio · file */ val kind: String, val name: String, val uri: Uri?,
    var thumb: Bitmap? = null, val duration: Double = 0.0, /** a copy of the app's own (a camera shot) removed when dropped */ val temporary: File? = null,
    /** a drawn sample (the debug build's check) */ val sample: Bitmap? = null)

  var onSend: ((List<Picked>) -> Unit)? = null
  var onPoll: (() -> Unit)? = null

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = (value * d).roundToInt()
  private val main = Handler(Looper.getMainLooper())
  private var panelTab = "gallery"
  private val selected = ArrayList<Item>()
  /** picking · opening · adding */
  private var phase = ""
  private var errorWords = ""
  private var notice = ""

  // The gallery.
  private var status = "unknown"
  private var asked = false
  private var canAskAgain = true
  private val items = ArrayList<Item>()
  private var nextOffset: Int? = 0
  private var loading = false
  private var galleryFailed = false
  private var samples = false
  private var observer: ContentObserver? = null
  private val thumbs = object : LruCache<String, Bitmap>(8 * 1024 * 1024) { override fun sizeOf(key: String, value: Bitmap) = value.byteCount }

  // The sheet.
  private val backdrop = View(context)
  private val sheet = FrameLayout(context)
  private val handleArea = FrameLayout(context)
  private val closeButton = KitIcon(context, "xmark", 15f, Theme.text)
  private val titleLabel = TextView(context)
  private val content = FrameLayout(context)
  private val limitedRow = LinearLayout(context)
  private val grid = GridView(context)
  private val emptyView = LinearLayout(context)
  private val emptyLabel = TextView(context)
  private val deniedView = ScrollView(context)
  private val deniedColumn = LinearLayout(context)
  private val audioView = ScrollView(context)
  private val audioColumn = LinearLayout(context)
  private val filesView = ScrollView(context)
  private val strip = HorizontalScrollView(context)
  private val stripRow = LinearLayout(context)
  private val errorLabel = TextView(context)
  private val fallbackButton = TextView(context)
  private val phaseRow = LinearLayout(context)
  private val phaseSpinner = ProgressBar(context)
  private val phaseIcon = KitIcon(context, "check.circle", 15f, Theme.accent)
  private val phaseLabel = TextView(context)
  private val addButton = TextView(context)
  private val addSpinner = ProgressBar(context)
  private val addBox = FrameLayout(context)
  private val tabsBar = LinearLayout(context)
  private val tabButtons = ArrayList<Pair<String, LinearLayout>>()
  private val footLabel = TextView(context)
  private var sheetHeight = 0
  private var dragStart = 0
  private var opened = false
  private var closing = false

  private val glassOpaque: Int get() { val look = ThemeStore.look; return if (look.black) 0xFF0F1011.toInt() else if (look.dark) 0xFF17243A.toInt() else 0xFFF6F8FD.toInt() }

  private val root = object : FrameLayout(context) {
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
      super.onLayout(changed, left, top, right, bottom)
      layoutSheet(right - left, bottom - top)
    }
  }

  private val gridAdapter: BaseAdapter by lazy { object : BaseAdapter() {
    val allowed get() = samples || status == "full" || status == "limited"
    override fun getCount(): Int = if (allowed) items.size + 1 else 0
    override fun getItem(position: Int): Any = position
    override fun getItemId(position: Int): Long = position.toLong()
    override fun getViewTypeCount(): Int = 2
    override fun getItemViewType(position: Int): Int = if (position == 0) 0 else 1
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val side = (grid.width / 4).takeIf { it > 0 } ?: dp(90f)
      if (position == 0) {
        val cell = (convertView as? CameraCell) ?: CameraCell()
        cell.layoutParams = AbsListView.LayoutParams(-1, side)
        cell.paint(phase.isEmpty())
        return cell
      }
      val cell = (convertView as? GalleryCell) ?: GalleryCell()
      cell.layoutParams = AbsListView.LayoutParams(-1, side)
      val item = items.getOrNull(position - 1) ?: return cell
      val number = selected.indexOfFirst { it.id == item.id } + 1
      if (cell.requested != item.id) { cell.requested = item.id; cell.missing.visibility = View.GONE; thumbFor(item, cell) }
      cell.show(item, number, phase.isNotEmpty())
      return cell
    }
  } }

  init {
    val look = ThemeStore.look
    backdrop.setBackgroundColor(if (look.black) 0x66000000 else if (look.dark) 0x4D000513 else 0x1F2B3F67)
    backdrop.contentDescription = "Закрыть выбор вложений"
    backdrop.setOnClickListener { closeNow() }
    backdrop.alpha = 0f
    root.addView(backdrop, FrameLayout.LayoutParams(-1, -1))
    sheet.background = GradientDrawable().apply { setColor(glassOpaque); cornerRadius = 28f * d; setStroke(maxOf(1, dp(0.5f)), look.border) }
    sheet.clipToOutline = true
    sheet.isClickable = true
    root.addView(sheet, FrameLayout.LayoutParams(0, 0))
    buildHandle()
    buildContent()
    buildBottom()
    setContentView(root)
    window?.apply {
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      @Suppress("DEPRECATION") setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
    }
    setOnCancelListener { forgetAll() }
    setOnDismissListener { stopObserving() }
    setOnShowListener { slideIn(); startGallery() }
    refreshAll()
  }

  // Building

  private fun label(words: String, size: Float, weight: Int = 400, color: Int = Theme.text): TextView = TextView(context).apply {
    text = words; textSize = size; typeface = Theme.weight(weight); setTextColor(color)
  }

  private fun help(words: String, size: Float = 12f) = label(words, size, color = Theme.muted).apply { setLineSpacing(0f, 1.2f) }

  private fun secondary(words: String, symbol: String? = null, action: () -> Unit): View {
    val row = LinearLayout(context)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER
    row.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 22f * d }
    row.setPadding(dp(16f), dp(12f), dp(16f), dp(12f))
    if (symbol != null) row.addView(KitIcon(context, symbol, 16f, Theme.text).apply { isClickable = false }, LinearLayout.LayoutParams(dp(20f), dp(20f)).apply { rightMargin = dp(8f) })
    row.addView(label(words, 15f, 600))
    row.isClickable = true; row.isFocusable = true
    row.contentDescription = words
    row.setOnClickListener { action() }
    return row
  }

  private fun primary(words: String, action: () -> Unit): View = label(words, 15f, 600, Theme.onAccent).apply {
    gravity = Gravity.CENTER
    background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = 22f * d }
    setPadding(dp(16f), dp(12f), dp(16f), dp(12f))
    isClickable = true; isFocusable = true
    setOnClickListener { action() }
  }

  private fun column(scroll: ScrollView, column: LinearLayout, padding: Float, spacing: Float) {
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(padding), dp(padding), dp(padding), dp(padding))
    column.showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    column.dividerDrawable = GradientDrawable().apply { setSize(1, dp(spacing)); setColor(Color.TRANSPARENT) }
    scroll.addView(column, FrameLayout.LayoutParams(-1, -2))
    scroll.isVerticalScrollBarEnabled = false
  }

  private fun buildHandle() {
    handleArea.addView(View(context).apply { background = GradientDrawable().apply { setColor(Theme.alpha(Theme.subtle, 0.45f)); cornerRadius = 2f * d } },
      FrameLayout.LayoutParams(dp(35f), dp(4f), Gravity.CENTER_HORIZONTAL))
    closeButton.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Theme.surface2) }
    closeButton.contentDescription = "Закрыть выбор вложений"
    closeButton.setOnClickListener { closeNow() }
    handleArea.addView(closeButton, FrameLayout.LayoutParams(dp(36f), dp(36f)).apply { topMargin = dp(10f) })
    titleLabel.textSize = 16f; titleLabel.typeface = Theme.weight(700); titleLabel.setTextColor(Theme.text); titleLabel.gravity = Gravity.CENTER
    handleArea.addView(titleLabel, FrameLayout.LayoutParams(-1, dp(36f)).apply { topMargin = dp(10f); leftMargin = dp(46f); rightMargin = dp(46f) })
    handleArea.setOnTouchListener { _, event -> dragged(event); true }
    sheet.addView(handleArea)
  }

  private fun buildContent() {
    sheet.addView(content)
    limitedRow.orientation = LinearLayout.HORIZONTAL
    limitedRow.gravity = Gravity.CENTER_VERTICAL
    limitedRow.setPadding(dp(7f), 0, 0, 0)
    limitedRow.addView(help("Показаны только разрешённые фото и видео.", 11f).apply { maxLines = 2 }, LinearLayout.LayoutParams(0, -2, 1f))
    limitedRow.addView(label("Добавить доступ", 12f, 600, Theme.accent).apply {
      setPadding(dp(10f), dp(10f), dp(10f), dp(10f)); isClickable = true; isFocusable = true; setOnClickListener { addAccess() }
    })
    limitedRow.visibility = View.GONE
    content.addView(limitedRow, FrameLayout.LayoutParams(-1, dp(40f)))

    grid.numColumns = 4
    grid.stretchMode = GridView.STRETCH_COLUMN_WIDTH
    grid.selector = ColorDrawable(Color.TRANSPARENT)
    grid.isVerticalScrollBarEnabled = false
    grid.clipToPadding = false
    grid.setPadding(0, 0, 0, dp(72f))
    grid.adapter = gridAdapter
    grid.setOnScrollListener(object : AbsListView.OnScrollListener {
      override fun onScrollStateChanged(view: AbsListView, state: Int) {}
      override fun onScroll(view: AbsListView, first: Int, visible: Int, total: Int) { if (total > 0 && first + visible >= total - 8) more() }
    })
    var pullStart = -1f
    grid.setOnTouchListener { _, event ->
      // The reference: the same pull from the grid once it is scrolled to its top — down only.
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> pullStart = if (!grid.canScrollVertically(-1)) event.rawY else -1f
        MotionEvent.ACTION_UP -> {
          if (pullStart >= 0 && !grid.canScrollVertically(-1) && event.rawY - pullStart > dp(64f)) { if (sheetHeight <= halfHeight() + 1) closeNow() else settle(halfHeight()) }
          pullStart = -1f
        }
      }
      false
    }
    content.addView(grid)
    emptyView.orientation = LinearLayout.VERTICAL
    emptyView.gravity = Gravity.CENTER_HORIZONTAL
    emptyView.addView(KitIcon(context, "photo.stack", 32f, Theme.subtle).apply { isClickable = false }, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    emptyLabel.textSize = 12f; emptyLabel.setTextColor(Theme.muted); emptyLabel.gravity = Gravity.CENTER
    emptyView.addView(emptyLabel, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12f) })
    emptyView.visibility = View.GONE
    content.addView(emptyView, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))

    column(deniedView, deniedColumn, 18f, 14f)
    deniedView.visibility = View.GONE
    content.addView(deniedView)
    column(audioView, audioColumn, 7f, 12f)
    audioView.visibility = View.GONE
    content.addView(audioView)
    val files = LinearLayout(context)
    column(filesView, files, 18f, 15f)
    files.addView(KitIcon(context, "folder", 34f, Theme.accent).apply { isClickable = false }, LinearLayout.LayoutParams(dp(40f), dp(40f)))
    files.addView(label("Файлы с устройства", 17f, 700))
    files.addView(help("Можно выбрать несколько документов, фото, видео или аудиофайлов. Файлы больше 20 МБ отправляются частями; фото и видео любого размера тоже очищаются от личных метаданных."))
    files.addView(secondary("Открыть файлы", "doc") { documents(audio = false) })
    files.addView(help("Фото и видео проходят очистку личных метаданных даже без редактора. Если устройство не поддерживает формат или сохранение HDR, приложение объяснит причину и остановит отправку."))
    filesView.visibility = View.GONE
    content.addView(filesView)
  }

  private fun fillDenied() {
    deniedColumn.removeAllViews()
    deniedColumn.addView(KitIcon(context, "photo.stack", 30f, Theme.accent).apply { isClickable = false }, LinearLayout.LayoutParams(dp(36f), dp(36f)))
    deniedColumn.addView(label("Открой доступ к галерее", 16f, 700))
    deniedColumn.addView(help("Можно разрешить только выбранные фото и видео. Остальные файлы останутся недоступны приложению."))
    // The reference: «Разрешить доступ» while the system may still ask, «Открыть настройки» once it may not.
    deniedColumn.addView(primary(if (canAskAgain) "Разрешить доступ" else "Открыть настройки") { if (canAskAgain) askGallery() else openSettings() })
    deniedColumn.addView(secondary("Выбрать через системное окно") { systemGallery() })
  }

  private fun buildBottom() {
    stripRow.orientation = LinearLayout.HORIZONTAL
    stripRow.gravity = Gravity.CENTER_VERTICAL
    strip.isHorizontalScrollBarEnabled = false
    strip.addView(stripRow, FrameLayout.LayoutParams(-2, -1))
    sheet.addView(strip)
    errorLabel.textSize = 13f; errorLabel.setTextColor(Theme.danger); errorLabel.maxLines = 3
    sheet.addView(errorLabel)
    fallbackButton.text = "Системный выбор фото и видео"
    fallbackButton.textSize = 15f; fallbackButton.typeface = Theme.weight(600); fallbackButton.setTextColor(Theme.text); fallbackButton.gravity = Gravity.CENTER
    fallbackButton.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 22f * d }
    fallbackButton.setOnClickListener { systemGallery() }
    sheet.addView(fallbackButton)
    phaseRow.orientation = LinearLayout.HORIZONTAL
    phaseRow.gravity = Gravity.CENTER_VERTICAL
    phaseSpinner.isIndeterminate = true
    phaseSpinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.accent)
    phaseRow.addView(phaseSpinner, LinearLayout.LayoutParams(dp(20f), dp(20f)))
    phaseIcon.isClickable = false
    phaseRow.addView(phaseIcon, LinearLayout.LayoutParams(dp(20f), dp(20f)))
    phaseLabel.textSize = 11f; phaseLabel.setTextColor(Theme.muted); phaseLabel.maxLines = 2
    phaseRow.addView(phaseLabel, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(6f) })
    sheet.addView(phaseRow)
    addButton.textSize = 16f; addButton.typeface = Theme.weight(600); addButton.setTextColor(Theme.onAccent); addButton.gravity = Gravity.CENTER
    addBox.background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = 24f * d }
    addBox.addView(addButton, FrameLayout.LayoutParams(-1, -1))
    addSpinner.isIndeterminate = true
    addSpinner.indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.onAccent)
    addBox.addView(addSpinner, FrameLayout.LayoutParams(dp(24f), dp(24f), Gravity.CENTER))
    addBox.isClickable = true
    addBox.setOnClickListener { addSelected() }
    sheet.addView(addBox)
    tabsBar.orientation = LinearLayout.HORIZONTAL
    tabsBar.setPadding(dp(5f), dp(5f), dp(5f), dp(5f))
    tabsBar.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 30f * d; setStroke(maxOf(1, dp(1f)), ThemeStore.look.border) }
    val tabs = arrayListOf(Triple("gallery", "Галерея", "photo.stack"), Triple("files", "Файл", "doc"))
    if (pollAvailable) tabs.add(Triple("poll", "Опрос", "chart.bar"))
    tabs.add(Triple("audio", "Аудио", "music.list"))
    for ((id, words, symbol) in tabs) {
      val button = LinearLayout(context)
      button.orientation = LinearLayout.VERTICAL
      button.gravity = Gravity.CENTER
      button.addView(KitIcon(context, symbol, 19f, Theme.text).apply { isClickable = false; tag = "icon" }, LinearLayout.LayoutParams(dp(22f), dp(22f)))
      button.addView(label(words, 11f, 600).apply { tag = "words"; gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(3f) })
      button.isClickable = true; button.isFocusable = true
      button.contentDescription = words
      button.setOnClickListener { tabTapped(id) }
      tabsBar.addView(button, LinearLayout.LayoutParams(dp(72f), dp(50f)).apply { rightMargin = dp(2f) })
      tabButtons.add(id to button)
    }
    sheet.addView(tabsBar)
    footLabel.textSize = 10f; footLabel.setTextColor(Theme.muted); footLabel.gravity = Gravity.CENTER
    footLabel.text = "Несколько фото и видео отправятся одним альбомом."
    sheet.addView(footLabel)
  }

  // Showing

  private fun halfHeight(): Int { val h = root.height.takeIf { it > 0 } ?: context.resources.displayMetrics.heightPixels; return minOf(dp(520f), maxOf(dp(360f), (h * 0.56f).roundToInt())) }
  private fun insetsOf(): Pair<Int, Int> {
    val insets = root.rootWindowInsets ?: return 0 to 0
    if (Build.VERSION.SDK_INT >= 30) { val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()); return bars.top to bars.bottom }
    @Suppress("DEPRECATION") return insets.systemWindowInsetTop to insets.systemWindowInsetBottom
  }
  private fun fullHeight(): Int { val (top, bottom) = insetsOf(); return root.height - top - maxOf(dp(8f), bottom) - dp(12f) }

  private fun slideIn() {
    // The reference: the backdrop fades in 160 ms while the sheet slides up 260 ms.
    root.post {
      backdrop.animate().alpha(1f).setDuration(160).start()
      sheet.translationY = (root.height - sheet.top).toFloat()
      sheet.animate().translationY(0f).setDuration(260).setInterpolator(PathInterpolator(0.2f, 0.9f, 0.25f, 1f)).start()
      opened = true
    }
  }

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    if (width <= 0 || height <= 0) { view.layout(0, 0, 0, 0); return }
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
    view.layout(left, top, left + width, top + height)
  }

  private fun heightOf(view: TextView, width: Int): Int {
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    return view.measuredHeight
  }

  private fun layoutSheet(rootWidth: Int, rootHeight: Int) {
    if (sheetHeight == 0) sheetHeight = halfHeight()
    val bottomInset = maxOf(dp(8f), insetsOf().second)
    val width = minOf(dp(600f), rootWidth - dp(16f))
    put(sheet, (rootWidth - width) / 2, rootHeight - bottomInset - sheetHeight, width, sheetHeight)
    val height = sheetHeight
    val inner = width - dp(16f)
    put(handleArea, dp(8f), dp(8f), inner, dp(48f))
    var y = height - dp(8f)
    if (footLabel.visibility == View.VISIBLE) { val h = heightOf(footLabel, inner - dp(10f)); put(footLabel, dp(13f), y - h, inner - dp(10f), h); y -= h + dp(6f) }
    val tabsWidth = tabButtons.size * dp(74f) - dp(2f) + dp(10f)
    put(tabsBar, (width - tabsWidth) / 2, y - dp(60f), tabsWidth, dp(60f))
    y -= dp(66f)
    if (addBox.visibility == View.VISIBLE) { put(addBox, dp(8f), y - dp(48f), inner, dp(48f)); y -= dp(54f) }
    if (phaseRow.visibility == View.VISIBLE) { put(phaseRow, dp(13f), y - dp(30f), inner - dp(10f), dp(30f)); y -= dp(36f) }
    if (fallbackButton.visibility == View.VISIBLE) { put(fallbackButton, dp(13f), y - dp(44f), inner - dp(10f), dp(44f)); y -= dp(50f) }
    if (errorLabel.visibility == View.VISIBLE) { val h = heightOf(errorLabel, inner - dp(10f)); put(errorLabel, dp(13f), y - h, inner - dp(10f), h); y -= h + dp(6f) }
    if (strip.visibility == View.VISIBLE) { put(strip, dp(8f), y - dp(110f), inner, dp(110f)); y -= dp(116f) }
    val top = dp(8f) + dp(48f) + dp(6f)
    put(content, dp(8f), top, inner, maxOf(0, y - top))
    val contentHeight = maxOf(0, y - top)
    var gridTop = 0
    if (limitedRow.visibility == View.VISIBLE) { put(limitedRow, 0, 0, inner, dp(40f)); gridTop = dp(48f) }
    put(grid, 0, gridTop, inner, maxOf(0, contentHeight - gridTop))
    val emptyTop = gridTop + maxOf(0, (contentHeight - gridTop - dp(145f)) / 2) + inner / 4
    put(emptyView, dp(20f), emptyTop, inner - dp(40f), dp(100f))
    for (pane in listOf(deniedView, audioView, filesView)) put(pane, 0, 0, inner, contentHeight)
  }

  /** Everything that follows the state: the title, the panes, the strip, the buttons, the notes. */
  private fun refreshAll() {
    val locked = phase.isNotEmpty()
    titleLabel.text = if (panelTab == "gallery") (if (selected.isEmpty()) "Недавние" else "Выбрано: ${selected.size}") else if (panelTab == "audio") "Аудио" else "Файлы"
    val allowed = samples || status == "full" || status == "limited"
    val denied = !samples && asked && status == "denied"
    fun visible(view: View, on: Boolean) { view.visibility = if (on) View.VISIBLE else View.GONE }
    visible(grid, panelTab == "gallery" && !denied)
    visible(limitedRow, panelTab == "gallery" && status == "limited")
    visible(deniedView, panelTab == "gallery" && denied)
    if (denied) fillDenied()
    emptyLabel.text = if (galleryFailed) "Галерея пока недоступна" else "В разрешённой галерее пока нет фото или видео"
    visible(emptyView, panelTab == "gallery" && !denied && allowed && items.isEmpty() && !loading)
    visible(audioView, panelTab == "audio")
    visible(filesView, panelTab == "files")
    if (panelTab == "audio") fillAudio()
    for ((id, button) in tabButtons) {
      val on = id == panelTab
      button.background = if (on) GradientDrawable().apply { setColor(ThemeStore.look.accentSoft); cornerRadius = 24f * d } else null
      (button.findViewWithTag<View>("icon") as? KitIcon)?.let { it.color = if (on) Theme.accent else Theme.text; it.invalidate() }
      (button.findViewWithTag<View>("words") as? TextView)?.setTextColor(if (on) Theme.accent else Theme.text)
      button.isEnabled = !locked
      button.isSelected = on
    }
    closeButton.isEnabled = phase != "adding"
    closeButton.alpha = if (closeButton.isEnabled) 1f else 0.4f
    errorLabel.text = errorWords
    visible(errorLabel, errorWords.isNotEmpty())
    visible(fallbackButton, errorWords.isNotEmpty() && panelTab == "gallery" && galleryFailed)
    visible(phaseRow, phase.isNotEmpty() || notice.isNotEmpty())
    phaseSpinner.visibility = if (phase.isEmpty()) View.GONE else View.VISIBLE
    phaseIcon.visibility = if (phase.isEmpty()) View.VISIBLE else View.GONE
    phaseLabel.text = if (notice.isNotEmpty()) notice else when (phase) {
      "opening" -> "Открываем оригинал…"
      "picking" -> "Выбери файлы в системном окне…"
      else -> "Обрабатываем, шифруем и добавляем…"
    }
    visible(addBox, selected.isNotEmpty() || phase == "adding")
    addButton.text = if (phase == "adding") "" else "↑  Добавить · ${selected.size}"
    addSpinner.visibility = if (phase == "adding") View.VISIBLE else View.GONE
    addBox.isEnabled = !locked && selected.isNotEmpty()
    addBox.alpha = if (addBox.isEnabled || phase == "adding") 1f else 0.5f
    visible(footLabel, selected.size > 1)
    visible(strip, selected.isNotEmpty())
    buildStrip()
    gridAdapter.notifyDataSetChanged()
    root.requestLayout()
  }

  // The strip of what was chosen

  private fun buildStrip() {
    stripRow.removeAllViews()
    val locked = phase.isNotEmpty()
    selected.forEachIndexed { index, item ->
      val thumb = item.thumb
      if (item.kind == "photo" && thumb != null) {
        val tile = FrameLayout(context)
        tile.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 14f * d; setStroke(maxOf(1, dp(1f)), ThemeStore.look.border) }
        tile.clipToOutline = true
        tile.addView(ImageView(context).apply { setImageBitmap(thumb); scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(-1, -1))
        tile.addView(label("✎ Изменить", 10f, 700, Color.WHITE).apply {
          gravity = Gravity.CENTER; background = GradientDrawable().apply { setColor(0x99000000.toInt()); cornerRadius = 9f * d }
        }, FrameLayout.LayoutParams(dp(70f), dp(20f), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(5f); bottomMargin = dp(5f) })
        tile.addView(numberBadge(index + 1), FrameLayout.LayoutParams(-2, dp(18f)).apply { leftMargin = dp(5f); topMargin = dp(5f) })
        tile.addView(removeButton(item, 20f), FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.END).apply { rightMargin = dp(3f); topMargin = dp(3f) })
        tile.contentDescription = "Редактировать " + item.name
        tile.isEnabled = !locked
        tile.setOnClickListener { edit(item) }
        stripRow.addView(tile, LinearLayout.LayoutParams(dp(104f), dp(104f)).apply { rightMargin = dp(6f) })
      } else {
        val chip = LinearLayout(context)
        chip.orientation = LinearLayout.HORIZONTAL
        chip.gravity = Gravity.CENTER_VERTICAL
        chip.background = GradientDrawable().apply { setColor(ThemeStore.look.accentSoft); cornerRadius = 14f * d; setStroke(maxOf(1, dp(1f)), ThemeStore.look.border) }
        chip.setPadding(dp(9f), 0, 0, 0)
        chip.addView(label("${index + 1}", 10f, 700, Theme.accent))
        val symbol = when (item.kind) { "video" -> "video"; "audio" -> "music.note"; "photo" -> "photo"; else -> "doc" }
        chip.addView(KitIcon(context, symbol, 13f, Theme.accent).apply { isClickable = false }, LinearLayout.LayoutParams(dp(16f), dp(16f)).apply { leftMargin = dp(4f) })
        chip.addView(label(item.name, 11f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE; maxWidth = dp(110f) }, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(5f) })
        chip.addView(removeButton(item, 30f, plain = true), LinearLayout.LayoutParams(dp(30f), dp(30f)))
        stripRow.addView(chip, LinearLayout.LayoutParams(-2, dp(36f)).apply { rightMargin = dp(6f) })
      }
    }
  }

  private fun numberBadge(number: Int): TextView = label("$number", 10f, 800, Theme.onAccent).apply {
    gravity = Gravity.CENTER; minWidth = dp(18f); setPadding(dp(4f), 0, dp(4f), 0)
    background = GradientDrawable().apply { setColor(Theme.accent); cornerRadius = 9f * d }
  }

  private fun removeButton(item: Item, size: Float, plain: Boolean = false): View {
    val button = KitIcon(context, "xmark", if (size > 24) 13f else 10f, if (plain) Theme.text else Color.WHITE)
    if (!plain) button.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x8C000000.toInt()) }
    button.contentDescription = "Убрать " + item.name
    button.isEnabled = phase.isEmpty()
    button.setOnClickListener { choose(item) }
    return button
  }

  // Choosing

  /** The reference's toggleSelection with its limit and wording. */
  private fun choose(item: Item) {
    if (phase.isNotEmpty()) return
    val index = selected.indexOfFirst { it.id == item.id }
    if (index >= 0) forget(selected.removeAt(index))
    else {
      if (selected.size >= LIMIT) { errorWords = GalleryAccess.limitWords(LIMIT - selected.size); refreshAll(); return }
      selected.add(item)
    }
    root.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    errorWords = ""
    notice = ""
    refreshAll()
  }

  private fun add(made: List<Item>) {
    var room = LIMIT - selected.size
    for (item in made) {
      if (selected.any { it.id == item.id }) continue
      if (room <= 0) { errorWords = GalleryAccess.limitWords(0); forget(item); continue }
      selected.add(item)
      room -= 1
    }
    refreshAll()
  }

  /** A copy made for a chosen thing (a camera shot) is removed once it is no longer chosen. */
  private fun forget(item: Item) { item.temporary?.delete() }

  private fun forgetAll() { selected.forEach { forget(it) }; selected.clear() }

  private fun tabTapped(id: String) {
    if (phase.isNotEmpty()) return
    if (id == "poll") {
      // The reference: the selection is dropped and the poll opens once the panel is gone.
      forgetAll()
      val poll = onPoll
      close { main.postDelayed({ poll?.invoke() }, 350) }
      return
    }
    panelTab = id
    errorWords = ""
    refreshAll()
  }

  // «Аудио»

  private fun localTracks() = MusicPlayer.shared.saved.filter { it.source == "local" && MusicPlayer.shared.file(it)?.isFile == true }

  private fun fillAudio() {
    audioColumn.removeAllViews()
    audioColumn.addView(secondary("Выбрать аудио на устройстве", "music.list") { documents(audio = true) }.apply { isEnabled = phase.isEmpty() })
    audioColumn.addView(help("Прикрепи локальный аудиофайл или трек, который ты импортировал в музыку."))
    val tracks = localTracks()
    if (tracks.isEmpty()) {
      val empty = LinearLayout(context)
      empty.orientation = LinearLayout.VERTICAL
      empty.gravity = Gravity.CENTER_HORIZONTAL
      empty.setPadding(0, dp(16f), 0, dp(16f))
      empty.addView(KitIcon(context, "headphones", 34f, Theme.subtle).apply { isClickable = false }, LinearLayout.LayoutParams(dp(40f), dp(40f)))
      empty.addView(help("Импортированных треков пока нет"), LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(10f) })
      audioColumn.addView(empty)
      return
    }
    audioColumn.addView(label("Из моей музыки", 13f, 700))
    for (track in tracks) {
      val id = "music:" + track.id
      val on = selected.any { it.id == id }
      val row = LinearLayout(context)
      row.orientation = LinearLayout.HORIZONTAL
      row.gravity = Gravity.CENTER_VERTICAL
      row.setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
      row.background = GradientDrawable().apply { setColor(if (on) ThemeStore.look.accentSoft else Theme.surface2); cornerRadius = 18f * d; setStroke(maxOf(1, dp(1f)), if (on) Theme.accent else ThemeStore.look.border) }
      row.addView(KitIcon(context, "music.note", 20f, Theme.accent).apply { isClickable = false }, LinearLayout.LayoutParams(dp(24f), dp(24f)))
      val words = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
      words.addView(label(track.title, 13f, 600).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
      words.addView(label(track.artist + (track.fileSize?.let { " · " + FileCore.sizeText(it) } ?: ""), 11f, color = Theme.muted).apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(4f) })
      row.addView(words, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(10f); rightMargin = dp(10f) })
      row.addView(KitIcon(context, if (on) "check.circle" else "circle", 22f, if (on) Theme.accent else Theme.subtle).apply { isClickable = false }, LinearLayout.LayoutParams(dp(24f), dp(24f)))
      row.contentDescription = track.title
      row.isSelected = on
      row.isEnabled = phase.isEmpty()
      row.setOnClickListener {
        val file = MusicPlayer.shared.file(track) ?: return@setOnClickListener
        choose(Item(id, "audio", track.fileName ?: track.title, Uri.fromFile(file)))
      }
      audioColumn.addView(row)
    }
  }

  // The gallery

  private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  /** The reference's `refresh('auto')`: the gallery is asked about only now, when the panel opens. */
  private fun startGallery() {
    if (AttachmentsDemo.panelSamples(this)) return
    status = GalleryAccess.state(Build.VERSION.SDK_INT, ::granted)
    if (status == "denied") { askGallery(); return }
    asked = true
    loadGallery()
  }

  private fun askGallery() {
    Permits.ask(activity, GalleryAccess.permissions(Build.VERSION.SDK_INT)) { _ ->
      asked = true
      status = GalleryAccess.state(Build.VERSION.SDK_INT, ::granted)
      // Refused for good: the system will not ask again — «Открыть настройки».
      canAskAgain = GalleryAccess.permissions(Build.VERSION.SDK_INT).any { activity.shouldShowRequestPermissionRationale(it) }
      loadGallery()
    }
  }

  /** «Добавить доступ»: Android shows its choice of photos and videos again. */
  private fun addAccess() {
    if (phase.isNotEmpty()) return
    Permits.ask(activity, GalleryAccess.permissions(Build.VERSION.SDK_INT)) { _ ->
      status = GalleryAccess.state(Build.VERSION.SDK_INT, ::granted)
      loadGallery()
    }
  }

  private fun openSettings() {
    try { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))) } catch (_: Exception) {}
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Back from the settings or from the system's choice: what may be read is asked again.
    if (!hasFocus || samples || !asked) return
    val now = GalleryAccess.state(Build.VERSION.SDK_INT, ::granted)
    if (now != status) { status = now; loadGallery() }
  }

  private fun loadGallery() {
    if (status != "full" && status != "limited") { items.clear(); nextOffset = null; refreshAll(); return }
    startObserving()
    items.clear()
    nextOffset = 0
    galleryFailed = false
    refreshAll()
    more()
  }

  private fun startObserving() {
    if (observer != null) return
    val watcher = object : ContentObserver(main) { override fun onChange(selfChange: Boolean) { if (isShowing && !samples) { items.clear(); nextOffset = 0; more() } } }
    try { context.contentResolver.registerContentObserver(MediaStore.Files.getContentUri("external"), true, watcher); observer = watcher } catch (_: Exception) {}
  }

  private fun stopObserving() { observer?.let { try { context.contentResolver.unregisterContentObserver(it) } catch (_: Exception) {} }; observer = null }

  /** The next page of 48 (the reference's GALLERY_PAGE_SIZE): names and kinds only, never the files. */
  private fun more() {
    val offset = nextOffset ?: return
    if (loading || samples) return
    loading = true
    val resolver = context.contentResolver
    reading.execute {
      val page = runCatching { GalleryPage.read(resolver, offset, 48) }
      main.post {
        loading = false
        val got = page.getOrNull()
        if (got == null) { galleryFailed = true; errorWords = "Не удалось открыть галерею."; nextOffset = null; refreshAll(); return@post }
        val known = items.map { it.id }.toHashSet()
        items.addAll(got.filter { !known.contains(it.id) })
        nextOffset = if (got.size < 48) null else offset + got.size
        refreshAll()
      }
    }
  }

  private fun thumbFor(item: Item, cell: GalleryCell) {
    item.sample?.let { cell.picture.setImageBitmap(it); return }
    val uri = item.uri ?: return
    thumbs.get(item.id)?.let { cell.picture.setImageBitmap(it); return }
    cell.picture.setImageDrawable(null)
    val resolver = context.contentResolver
    val side = maxOf(96, cell.width.takeIf { it > 0 } ?: dp(90f))
    val id = item.id
    thumbing.execute {
      val made = GalleryPage.thumbnail(resolver, uri, item.kind == "video", side)
      main.post {
        if (made != null) thumbs.put(id, made)
        if (cell.requested != id) return@post
        if (made != null) cell.picture.setImageBitmap(made) else cell.missing.visibility = View.VISIBLE
      }
    }
  }


  /** One tile of the gallery: the small picture, the round mark with its number, a video's length. */
  private inner class GalleryCell : FrameLayout(context) {
    val picture = ImageView(context)
    val missing = TextView(context)
    var requested = ""
    private val frame = FrameLayout(context)
    private val videoBadge = LinearLayout(context)
    private val videoLabel = TextView(context)
    private val check = FrameLayout(context)
    private val ring = TextView(context)
    private var item: Item? = null

    init {
      setPadding(dp(1.5f), dp(1.5f), dp(1.5f), dp(1.5f))
      frame.clipToOutline = true
      addView(frame, LayoutParams(-1, -1))
      picture.scaleType = ImageView.ScaleType.CENTER_CROP
      frame.addView(picture, LayoutParams(-1, -1))
      missing.text = "Нет миниатюры"; missing.textSize = 9f; missing.setTextColor(Theme.muted); missing.gravity = Gravity.CENTER; missing.visibility = View.GONE
      frame.addView(missing, LayoutParams(-1, -1))
      videoBadge.orientation = LinearLayout.HORIZONTAL
      videoBadge.gravity = Gravity.CENTER_VERTICAL
      videoBadge.setPadding(dp(6f), 0, dp(6f), 0)
      videoBadge.background = GradientDrawable().apply { setColor(0x8C000000.toInt()); cornerRadius = 7f * d }
      videoBadge.addView(KitIcon(context, "video.fill", 11f, Color.WHITE).apply { isClickable = false }, LinearLayout.LayoutParams(dp(12f), dp(12f)))
      videoLabel.textSize = 10f; videoLabel.typeface = Theme.weight(600); videoLabel.setTextColor(Color.WHITE)
      videoBadge.addView(videoLabel, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(4f) })
      frame.addView(videoBadge, LayoutParams(-2, dp(18f), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(6f); bottomMargin = dp(6f) })
      ring.textSize = 12f; ring.typeface = Theme.weight(800); ring.setTextColor(Theme.onAccent); ring.gravity = Gravity.CENTER
      check.addView(ring, LayoutParams(dp(22f), dp(22f), Gravity.CENTER))
      check.isClickable = true
      check.setOnClickListener { item?.let { choose(it) } }
      frame.addView(check, LayoutParams(dp(38f), dp(38f), Gravity.END))
      setOnClickListener { val it = item ?: return@setOnClickListener; if (phase.isEmpty()) { if (it.kind == "photo") edit(it) else choose(it) } }
    }

    fun show(item: Item, number: Int, disabled: Boolean) {
      this.item = item
      frame.background = GradientDrawable().apply { setColor(Theme.surface2); cornerRadius = 9f * d; if (number > 0) setStroke(dp(2f), Theme.accent) }
      frame.foreground = if (number > 0) GradientDrawable().apply { setColor(Color.TRANSPARENT); cornerRadius = 9f * d; setStroke(dp(2f), Theme.accent) } else null
      frame.alpha = if (disabled) 0.65f else 1f
      videoBadge.visibility = if (item.kind == "video") View.VISIBLE else View.GONE
      videoLabel.text = GalleryAccess.durationText(item.duration)
      ring.text = if (number > 0) "$number" else ""
      ring.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (number > 0) Theme.accent else 0x47000000); setStroke(dp(1.5f), Color.WHITE) }
      check.isEnabled = !disabled
      check.contentDescription = (if (number > 0) "Убрать из выбора " else "Выбрать ") + item.name + (if (number > 0) ", номер $number" else "")
      contentDescription = if (item.kind == "photo") "Редактировать " + item.name else "Выбрать видео " + item.name
    }
  }

  /** The camera, first in the grid. */
  private inner class CameraCell : FrameLayout(context) {
    private val tile = KitIcon(context, "camera", 24f, Theme.bg)
    init {
      setPadding(dp(1.5f), dp(1.5f), dp(1.5f), dp(1.5f))
      tile.isClickable = false
      addView(tile, LayoutParams(-1, -1))
      contentDescription = "Снять фото или видео"
      setOnClickListener { if (phase.isEmpty()) camera() }
    }
    fun paint(enabled: Boolean) {
      tile.background = GradientDrawable().apply { setColor(if (Theme.dark) Theme.bg else Theme.text); cornerRadius = 9f * d }
      tile.color = if (Theme.dark) Theme.text else Theme.bg
      tile.alpha = if (enabled) 1f else 0.65f
      tile.invalidate()
    }
  }

  // Adding

  /** The reference's `resolveSelection` for every chosen thing, in order: the addresses, read by the chat. */
  private fun resolve(item: Item): Picked? = when (item.kind) {
    "photo" -> item.sample?.let { Picked.Photo(null, it, null) } ?: item.uri?.let { Picked.Photo(it, null, null, item.temporary) }
    "video" -> item.uri?.let { Picked.Video(it) }
    else -> item.uri?.let { Picked.File(it, item.name) }
  }

  private fun addSelected() {
    if (phase.isNotEmpty() || selected.isEmpty()) return
    val batch = ArrayList(selected)
    val made = batch.mapNotNull { resolve(it) }
    if (made.size < batch.size) { errorWords = "Не удалось получить оригинал. Открой его на устройстве или выбери через «Файлы»."; refreshAll(); return }
    // Everything is in hand: the chat takes the lot, so the photos keep their album and order.
    selected.clear()
    val send = onSend
    close { send?.invoke(made) }
  }

  // The editor

  /** «Изменить» / a photo of the grid: the original is read and opened in the editor; what it gives is added to
   *  the message at once (the reference's `addEdited`). */
  private fun edit(item: Item) {
    if (item.kind != "photo" || phase.isNotEmpty()) return
    phase = "opening"
    errorWords = ""
    notice = ""
    refreshAll()
    val resolver = context.contentResolver
    val uri = item.uri
    reading.execute {
      val picture = item.sample ?: uri?.let { GalleryPage.picture(resolver, it, 4096) }
      main.post {
        phase = ""
        if (picture == null) { errorWords = "Не удалось получить оригинал. Открой его на устройстве или выбери через «Файлы»."; refreshAll(); return@post }
        refreshAll()
        val editor = PhotoEditor(context, picture)
        editor.onDone = { output ->
          val picked = if (output != null) Picked.Photo(null, output.image, output.format) else resolve(item)
          if (picked != null) {
            selected.removeAll { it.id == item.id }
            onSend?.invoke(listOf(picked))
            notice = "Фото добавлено в сообщение."
            refreshAll()
            if (selected.isEmpty()) close(null)
          }
        }
        editor.show()
      }
    }
  }

  // The camera, files, the system's picker

  private fun camera() {
    if (phase.isNotEmpty()) return
    phase = "picking"
    refreshAll()
    Permits.ask(activity, listOf(Manifest.permission.CAMERA)) { allowed ->
      if (!allowed) { phase = ""; errorWords = "Разреши доступ к камере в настройках, чтобы снимать прямо из чата."; refreshAll(); return@ask }
      val (file, address) = CaptureProvider.fresh(context)
      val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
        putExtra(MediaStore.EXTRA_OUTPUT, address)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        clipData = android.content.ClipData.newRawUri("", address)
      }
      val asked = Picks.ask(activity, intent) { _ ->
        phase = ""
        if (file.isFile && file.length() > 0) {
          val uri = Uri.fromFile(file)
          val thumb = GalleryPage.picture(context.contentResolver, uri, 320)
          add(listOf(Item("camera:" + file.name, "photo", "photo.jpg", uri, thumb, temporary = file)))
        } else { file.delete(); refreshAll() }
      }
      if (!asked) { phase = ""; errorWords = "Не удалось добавить вложение."; refreshAll() }
    }
  }

  private fun documents(audio: Boolean) {
    if (phase.isNotEmpty()) return
    phase = "picking"
    refreshAll()
    val asked = Picks.ask(activity, ChatAttachments.documentPicker(if (audio) "audio/*" else "*/*")) { chosen ->
      phase = ""
      val resolver = context.contentResolver
      add(chosen.map { uri ->
        val type = try { resolver.getType(uri) } catch (_: Exception) { null } ?: ""
        val name = GalleryPage.name(resolver, uri)
        // A picture picked as a file stays a file in the strip; the chat still cleans it as a photo.
        val kind = if (audio || type.startsWith("audio/")) "audio" else if (type.startsWith("video/")) "video" else "file"
        Item("file:$uri", kind, name, uri)
      })
    }
    if (!asked) { phase = ""; errorWords = "Не удалось открыть файлы."; refreshAll() }
  }

  /** «Системный выбор фото и видео» / «Выбрать через системное окно»: the system's picker, which needs no access. */
  private fun systemGallery() {
    if (phase.isNotEmpty()) return
    phase = "picking"
    refreshAll()
    val intent = ChatAttachments.documentPicker("*/*").apply { putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*")) }
    val asked = Picks.ask(activity, intent) { chosen ->
      phase = ""
      val resolver = context.contentResolver
      add(chosen.map { uri ->
        val type = try { resolver.getType(uri) } catch (_: Exception) { null } ?: ""
        val video = type.startsWith("video/")
        Item("picked:$uri", if (video) "video" else "photo", GalleryPage.name(resolver, uri), uri, if (video) null else GalleryPage.picture(resolver, uri, 320))
      })
    }
    if (!asked) { phase = ""; errorWords = "Не удалось добавить вложение."; refreshAll() }
  }

  // Pulling and closing

  private var dragDownY = 0f
  private var lastY = 0f
  private var lastTime = 0L
  private var velocity = 0f

  private fun dragged(event: MotionEvent) {
    val half = halfHeight(); val full = fullHeight()
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { dragStart = sheetHeight; dragDownY = event.rawY; lastY = event.rawY; lastTime = event.eventTime; velocity = 0f }
      MotionEvent.ACTION_MOVE -> {
        val dt = maxOf(1L, event.eventTime - lastTime)
        velocity = (event.rawY - lastY) / dt * 1000f / d
        lastY = event.rawY; lastTime = event.eventTime
        sheetHeight = (dragStart - (event.rawY - dragDownY)).roundToInt().coerceIn((half * 0.5f).roundToInt(), full)
        root.requestLayout()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val goingUp = velocity < -500; val goingDown = velocity > 500
        if ((goingDown || sheetHeight < half * 0.8f) && dragStart <= half + 1) { closeNow(); return }
        settle(if (goingUp) full else if (goingDown) half else if (sheetHeight > (half + full) / 2) full else half)
      }
    }
  }

  private fun settle(target: Int) {
    val from = sheetHeight
    ValueAnimator.ofInt(from, target).apply {
      duration = 240
      interpolator = PathInterpolator(0.2f, 0.9f, 0.25f, 1f)
      addUpdateListener { sheetHeight = it.animatedValue as Int; root.requestLayout() }
      start()
    }
  }

  private fun closeNow() {
    if (phase == "adding") return
    forgetAll()
    close(null)
  }

  private fun close(then: (() -> Unit)?) {
    if (closing) return
    closing = true
    backdrop.animate().alpha(0f).setDuration(220).start()
    sheet.animate().translationY((root.height - sheet.top).toFloat()).setDuration(220).withEndAction {
      try { dismiss() } catch (_: Exception) {}
      then?.invoke()
    }.start()
  }

  override fun show() {
    try { super.show() } catch (_: Exception) { /* the window is gone */ }
  }

  // The emulator check (debug builds: attachments/AttachmentsDemo.kt)

  /** `attachdemo panel|panellimited|paneldenied|panelselected`: drawn sample tiles instead of the gallery (no photo
   *  of anyone), as the panel shows them. */
  fun demoSamples(demo: String) {
    asked = true
    if (demo == "paneldenied") { status = "denied"; canAskAgain = false; refreshAll(); return }
    samples = true
    status = if (demo == "panellimited") "limited" else "full"
    val colors = listOf(0x1F3B73 to 0xE0803B, 0x2E4A3B to 0xC8B27A, 0x3A3F58 to 0x9FB4C7, 0x5A3825 to 0xE3C08D, 0x203040 to 0x6FA3B8,
      0x3B2F2F to 0xB48A6A, 0x1E2A38 to 0xD9D2C5, 0x34402A to 0xA9B88A, 0x2B2440 to 0x8C9CC9, 0x40302A to 0xD6A77A, 0x223B3B to 0x9CC5B9)
    items.clear()
    colors.forEachIndexed { index, pair ->
      val picture = sample(pair.first, pair.second)
      val video = index % 4 == 2
      items.add(Item("sample:$index", if (video) "video" else "photo", if (video) "IMG_${1200 + index}.MP4" else "IMG_${1200 + index}.JPG", null, picture,
        duration = if (video) (14 + index * 7).toDouble() else 0.0, sample = picture))
    }
    nextOffset = null
    if (demo == "panelselected") { selected.clear(); selected.addAll(listOf(items[0], items[2], items[3])) }
    refreshAll()
  }

  private fun sample(from: Int, to: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, 240f, 240f, 0xFF000000.toInt() or from, 0xFF000000.toInt() or to, Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, 240f, 240f, paint)
    paint.shader = null
    paint.color = 0xCCFFFFFF.toInt()
    canvas.drawCircle(175f, 65f, 25f, paint)
    return bitmap
  }

  companion object {
    /** The reference's MAX_DRAFT_ATTACHMENTS. */
    const val LIMIT = 100
    private val reading = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.gallery").apply { isDaemon = true } }
    private val thumbing = Executors.newFixedThreadPool(2) { run -> Thread(run, "invizent.gallery.thumbs").apply { isDaemon = true } }
  }
}

/** Media: reading the gallery through the system's MediaStore — a page of names and kinds, small pictures, one
 *  original. Only what the person allowed is ever returned by the system. */
object GalleryPage {
  fun read(resolver: android.content.ContentResolver, offset: Int, count: Int): List<AttachmentPanel.Item> {
    val files = MediaStore.Files.getContentUri("external")
    val columns = arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.Files.FileColumns.DISPLAY_NAME, MediaStore.Video.VideoColumns.DURATION)
    val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN (${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE}, ${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
    val out = ArrayList<AttachmentPanel.Item>()
    val cursor = if (Build.VERSION.SDK_INT >= 26) {
      val args = android.os.Bundle().apply {
        putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
        putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.Files.FileColumns.DATE_ADDED))
        putInt(android.content.ContentResolver.QUERY_ARG_SORT_DIRECTION, android.content.ContentResolver.QUERY_SORT_DIRECTION_DESCENDING)
        putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, count)
        putInt(android.content.ContentResolver.QUERY_ARG_OFFSET, offset)
      }
      resolver.query(files, columns, args, null)
    } else null
    cursor?.use {
      val idAt = it.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
      val typeAt = it.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
      val nameAt = it.getColumnIndex(MediaStore.Files.FileColumns.DISPLAY_NAME)
      val lengthAt = it.getColumnIndex(MediaStore.Video.VideoColumns.DURATION)
      while (it.moveToNext()) {
        val id = it.getLong(idAt)
        val video = it.getInt(typeAt) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val uri = android.content.ContentUris.withAppendedId(if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        val name = (if (nameAt >= 0) it.getString(nameAt) else null)?.substringAfterLast('/') ?: (if (video) "video" else "photo")
        val seconds = if (video && lengthAt >= 0 && !it.isNull(lengthAt)) it.getLong(lengthAt) / 1000.0 else 0.0
        out.add(AttachmentPanel.Item("gallery:${if (video) "v" else "i"}$id", if (video) "video" else "photo", name, uri, duration = seconds))
      }
    } ?: throw IllegalStateException("gallery")
    return out
  }

  /** A small picture of a gallery item, about `side` pixels (the system's own thumbnail where it has one). */
  fun thumbnail(resolver: android.content.ContentResolver, uri: Uri, video: Boolean, side: Int): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 29) resolver.loadThumbnail(uri, Size(side, side), null)
    else if (video) {
      @Suppress("DEPRECATION")
      MediaStore.Video.Thumbnails.getThumbnail(resolver, android.content.ContentUris.parseId(uri), MediaStore.Video.Thumbnails.MINI_KIND, null)
    } else picture(resolver, uri, side)
  } catch (_: Throwable) { null }

  /** A picture decoded upright, at most about `edge` pixels a side. */
  fun picture(resolver: android.content.ContentResolver, uri: Uri, edge: Int): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 28) {
      android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        val w = info.size.width; val h = info.size.height
        val scale = minOf(1f, edge.toFloat() / maxOf(w, h))
        decoder.setTargetSize(maxOf(1, (w * scale).roundToInt()), maxOf(1, (h * scale).roundToInt()))
        decoder.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
      }
    } else {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= edge) sample *= 2
      val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
      val turn = try { resolver.openInputStream(uri)?.use { android.media.ExifInterface(it).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1) } ?: 1 } catch (_: Exception) { 1 }
      val degrees = when (turn) { 6 -> 90f; 3 -> 180f; 8 -> 270f; else -> 0f }
      if (decoded == null || degrees == 0f) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, android.graphics.Matrix().apply { postRotate(degrees) }, true)
    }
  } catch (_: Throwable) { null }

  /** The name a chosen file gives, only its last part. */
  fun name(resolver: android.content.ContentResolver, uri: Uri): String {
    var name = ""
    try {
      resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst() && !it.isNull(0)) name = it.getString(0) ?: "" }
    } catch (_: Exception) {}
    if (name.isEmpty()) name = uri.lastPathSegment ?: ""
    return name.substringAfterLast('/').trim().ifEmpty { "file" }
  }
}
