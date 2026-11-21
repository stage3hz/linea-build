package com.linea.messenger.chatlook

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.linea.messenger.attachments.Picks
import com.linea.messenger.design.Theme
import com.linea.messenger.design.Titles
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.settings.SettingsLook
import com.linea.messenger.settings.SettingsRow
import kotlin.math.abs

/** «Обои чатов» (iOS: Sources/ChatLook/WallpaperPicker.swift; the reference's WallpaperPicker.tsx): «Выбрать из
 *  галереи» and the presets, then a full-screen preview with sample messages — «Размытие», «Движение» and the
 *  dimming for dark themes for a picture, which is fitted with the fingers — and «Установить» for this chat or for
 *  all chats. The system's photo picker is used: it needs no access to the whole gallery.
 *  `chatId`: opened from a chat (then «Для этого чата» is offered); null: from the settings, for all chats. */
class WallpaperPicker(context: Context, private val chatId: String?) : Dialog(context) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val stack = LinearLayout(context)
  private val problem = TextView(context)

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    stack.orientation = LinearLayout.VERTICAL
    stack.setPadding(dp(16f), dp(22f), dp(16f), dp(24f))
    stack.background = GradientDrawable().apply {
      setColor(if (Theme.dark) 0xFF16171A.toInt() else 0xFFF4F5F7.toInt())
      cornerRadii = floatArrayOf(28 * d, 28 * d, 28 * d, 28 * d, 0f, 0f, 0f, 0f)
    }
    setContentView(ScrollView(context).apply { addView(stack); isVerticalScrollBarEnabled = false }, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
    setCanceledOnTouchOutside(true)
    fill()
  }

  private val current: WallpaperChoice get() = Wallpapers.choice(chatId ?: "")

  private fun fill() {
    stack.removeAllViews()
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    val title = context.words("Обои чатов", 19f, Theme.text, 700)
    Titles.title(title, Theme.TypeSize.sheetTitle) // Fonts
    stack.addView(title, LinearLayout.LayoutParams(wide, wrap))

    val gallery = SettingsRow(context, symbol = "photo", label = "Выбрать из галереи")
    gallery.onPress = { pick() }
    gallery.background = context.plate(SettingsLook.card, 14f)
    gallery.clipToOutline = true
    stack.addView(gallery, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })

    problem.textSize = 13f
    problem.setTextColor(Theme.danger)
    problem.visibility = if (problem.text.isNullOrEmpty()) View.GONE else View.VISIBLE
    (problem.parent as? ViewGroup)?.removeView(problem)
    stack.addView(problem, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })

    val tiles = LinearLayout(context)
    tiles.orientation = LinearLayout.HORIZONTAL
    val now = current
    if (now.isImage) tiles.addView(tile("Своё фото", null, Wallpapers.image(context, now.file), true) { preview(now, fresh = false) })
    for (preset in Wallpapers.presets) {
      val chosen = !now.isImage && now.preset == preset.id
      tiles.addView(tile(preset.label, preset.colors, null, chosen) { preview(WallpaperChoice.preset(preset.id), fresh = false) })
    }
    val scroll = HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(tiles) }
    stack.addView(scroll, LinearLayout.LayoutParams(wide, dp(160f)).apply { topMargin = dp(12f) })

    stack.addView(context.words("Обои хранятся только на этом телефоне и никуда не отправляются; собеседник их не видит.", 12f, Theme.muted), LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(12f) })
  }

  private fun tile(label: String, colors: List<Int>?, image: Bitmap?, chosen: Boolean, action: () -> Unit): View {
    val button = FrameLayout(context)
    button.contentDescription = label
    button.isClickable = true; button.isFocusable = true; button.isSelected = chosen
    button.background = GradientDrawable().apply {
      cornerRadius = 14 * d
      if (colors != null && colors.size >= 2) { orientation = GradientDrawable.Orientation.TL_BR; this.colors = colors.map { LookColor.argb(it) }.toIntArray() }
      else setColor(Theme.bg)
      setStroke(dp(3f), if (chosen) Theme.accent else Color.TRANSPARENT)
    }
    button.clipToOutline = true
    if (image != null) {
      button.addView(ImageView(context).apply { setImageBitmap(image); scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      if (chosen) button.foreground = GradientDrawable().apply { cornerRadius = 14 * d; setStroke(dp(3f), Theme.accent) }
    } else if (colors == null) {
      button.addView(context.words("Как фон", 12f, Theme.muted).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }
    button.setOnClickListener { action() }
    return FrameLayout(context).apply {
      addView(button, FrameLayout.LayoutParams(dp(96f), dp(160f)))
      layoutParams = LinearLayout.LayoutParams(dp(96f), dp(160f)).apply { rightMargin = dp(10f) }
    }
  }

  // The gallery

  @SuppressLint("InlinedApi")
  private fun pick() {
    val activity = context as? Activity ?: (context as? android.content.ContextWrapper)?.baseContext as? Activity ?: return
    val intent = if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
    else Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
    Picks.ask(activity, intent) { chosen -> chosen.firstOrNull()?.let { picked(it) } }
  }

  private fun picked(uri: Uri) {
    val app = context.applicationContext
    val main = Handler(Looper.getMainLooper())
    Wallpapers.pool.execute {
      val image = decode(app, uri)
      val kept = image?.let { Wallpapers.keep(app, it) }
      main.post {
        if (image == null || kept == null) {
          problem.text = "Не удалось открыть фото."
          problem.visibility = View.VISIBLE
          return@post
        }
        val aspect = if (image.height > 0) image.width.toDouble() / image.height else 0.0
        preview(WallpaperChoice("image", file = kept, aspect = aspect), fresh = true)
      }
    }
  }

  // The preview

  private fun preview(draft: WallpaperChoice, fresh: Boolean) {
    val screen = WallpaperPreview(context, draft, forChat = chatId != null)
    screen.onCancel = { if (fresh) Wallpapers.discard(context, draft.file) }
    screen.onSet = { choice, forChat ->
      Wallpapers.set(choice, if (forChat) chatId else null)
      if (fresh && choice.file != draft.file) Wallpapers.discard(context, draft.file)
      dismiss()
    }
    screen.show()
  }

  override fun show() {
    try { super.show() } catch (_: Exception) { }
    last = java.lang.ref.WeakReference(this)
  }

  companion object {
    var last: java.lang.ref.WeakReference<WallpaperPicker>? = null

    /** A picked picture, made at most 2400 px on its longer side while reading. */
    fun decode(context: Context, uri: Uri): Bitmap? = try {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      var sample = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2400) sample *= 2
      context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
    } catch (_: Throwable) { null }
  }
}

/** The full-screen preview of a wallpaper with sample messages (the reference's `WallpaperPreview`). */
class WallpaperPreview(context: Context, private var draft: WallpaperChoice, private val forChat: Boolean) : Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
  var onCancel: (() -> Unit)? = null
  var onSet: ((WallpaperChoice, Boolean) -> Unit)? = null

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val root = object : FrameLayout(context) {
    override fun onInterceptTouchEvent(event: MotionEvent): Boolean = gesture(event, intercept = true)
    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean = gesture(event, intercept = false)
  }
  private val paper = WallpaperView(context)
  private val controls = LinearLayout(context)
  private var start = Triple(1.0, 0.0, 0.0)
  private var downX = 0f
  private var downY = 0f
  private var dragging = false
  private val scaler = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    private var startZoom = 1.0
    override fun onScaleBegin(detector: ScaleGestureDetector): Boolean { startZoom = draft.zoom; return draft.isImage }
    override fun onScale(detector: ScaleGestureDetector): Boolean {
      val fitted = WallpaperFit.clamp(draft.zoom * detector.scaleFactor, draft.fx, draft.fy, draft.aspect, root.width.toDouble(), root.height.toDouble())
      draft = draft.copy(zoom = fitted.first, fx = fitted.second, fy = fitted.third)
      paper.fit(draft.zoom, draft.fx, draft.fy)
      return true
    }
  })

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    root.setBackgroundColor(Theme.bg)
    root.addView(paper, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    val column = LinearLayout(context)
    column.orientation = LinearLayout.VERTICAL
    column.setPadding(dp(14f), dp(40f), dp(14f), 0)
    column.addView(capsule("Предпросмотр", 15f, 600), LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(32f)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(38f) })
    val palette = ChatBubbleLook.palette(true)
    column.addView(bubble("Как тебе новые обои?", false, palette.theirs, palette.text))
    column.addView(bubble("Огонь, ставлю 🔥", true, palette.mine, palette.text), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
    column.addView(bubble("Так будет выглядеть чат.", false, palette.theirs, palette.text), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
    root.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
    controls.orientation = LinearLayout.VERTICAL
    root.addView(controls, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply { leftMargin = dp(14f); rightMargin = dp(14f); bottomMargin = dp(28f) })
    setContentView(root)
    fillControls()
    paper.show(draft)
  }

  private fun capsule(text: String, size: Float, weight: Int): TextView = context.words(text, size, Color.WHITE, weight).apply {
    gravity = Gravity.CENTER
    background = context.plate(0x59000000, 16f)
    setPadding(dp(16f), 0, dp(16f), 0)
  }

  private fun bubble(text: String, mine: Boolean, fill: Int, ink: Int): View {
    val row = FrameLayout(context)
    val plate = context.words(text, 16f, ink)
    plate.setPadding(dp(13f), dp(8f), dp(13f), dp(8f))
    plate.background = context.plate(fill, 18f)
    plate.maxWidth = (context.resources.displayMetrics.widthPixels * 0.72f).toInt()
    row.addView(plate, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, if (mine) Gravity.END else Gravity.START))
    row.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    return row
  }

  private fun toggle(label: String, on: Boolean, flip: () -> Unit): View = context.words(label, 15f, Color.WHITE, 500).apply {
    gravity = Gravity.CENTER
    background = context.plate(if (on) 0x47FFFFFF else 0x59000000, 21f)
    isClickable = true; isFocusable = true; isSelected = on
    setOnClickListener { flip() }
  }

  private fun wide(label: String, filled: Boolean, action: () -> Unit): View = context.words(label, 16f, if (filled) Theme.onAccent else Color.WHITE, if (filled) 700 else 600).apply {
    gravity = Gravity.CENTER
    background = context.plate(if (filled) Theme.accent else 0x73000000, 14f)
    isClickable = true; isFocusable = true
    setOnClickListener { action() }
  }

  private fun fillControls() {
    controls.removeAllViews()
    val full = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    if (draft.isImage) {
      controls.addView(capsule("Двигай фото пальцем, масштаб — двумя", 12f, 400).apply { background = context.plate(0x59000000, 14f) },
        LinearLayout.LayoutParams(wrap, dp(26f)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(10f) })
      val pair = LinearLayout(context)
      pair.addView(toggle("Размытие", draft.blur) { change(draft.copy(blur = !draft.blur)) }, LinearLayout.LayoutParams(0, dp(42f), 1f))
      pair.addView(toggle("Движение", draft.motion) { change(draft.copy(motion = !draft.motion)) }, LinearLayout.LayoutParams(0, dp(42f), 1f).apply { leftMargin = dp(8f) })
      controls.addView(pair, LinearLayout.LayoutParams(full, wrap))
      if (Theme.dark) {
        controls.addView(context.words("Затемнение в тёмной теме", 12f, Color.WHITE), LinearLayout.LayoutParams(full, wrap).apply { topMargin = dp(12f) })
        val steps = LinearLayout(context)
        listOf(0.0, 0.2, 0.4, 0.6).forEachIndexed { index, value ->
          val step = context.words(if (value == 0.0) "Нет" else "${(value * 100).toInt()}%", 13f, Color.WHITE, 600).apply {
            gravity = Gravity.CENTER
            background = context.plate(if (draft.dim == value) 0x4DFFFFFF else 0x59000000, 10f)
            isClickable = true
            setOnClickListener { change(draft.copy(dim = value)) }
          }
          steps.addView(step, LinearLayout.LayoutParams(0, dp(34f), 1f).apply { leftMargin = if (index == 0) 0 else dp(6f) })
        }
        controls.addView(steps, LinearLayout.LayoutParams(full, wrap).apply { topMargin = dp(6f) })
      }
    }
    val buttons = LinearLayout(context)
    buttons.addView(wide("Отмена", false) { cancel() }, LinearLayout.LayoutParams(0, dp(48f), 1f))
    buttons.addView(wide("Установить", true) { choose() }, LinearLayout.LayoutParams(0, dp(48f), 1.4f).apply { leftMargin = dp(8f) })
    controls.addView(buttons, LinearLayout.LayoutParams(full, wrap).apply { topMargin = dp(12f) })
  }

  private fun change(next: WallpaperChoice) {
    draft = next
    paper.show(draft)
    fillControls()
  }

  /** A picture: dragged to choose the part that shows, pinched to zoom. A preset: pulled down to cancel. */
  private fun gesture(event: MotionEvent, intercept: Boolean): Boolean {
    if (draft.isImage) scaler.onTouchEvent(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { downX = event.rawX; downY = event.rawY; start = Triple(draft.zoom, draft.fx, draft.fy); dragging = false }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.rawX - downX; val dy = event.rawY - downY
        if (!dragging && (abs(dx) > 10 * d || abs(dy) > 10 * d)) dragging = true
        if (!dragging) return false
        if (draft.isImage) {
          if (event.pointerCount == 1 && !scaler.isInProgress) {
            val fitted = WallpaperFit.clamp(draft.zoom, start.second + dx / root.width, start.third + dy / root.height, draft.aspect, root.width.toDouble(), root.height.toDouble())
            draft = draft.copy(fx = fitted.second, fy = fitted.third)
            paper.fit(draft.zoom, draft.fx, draft.fy)
          }
        } else root.translationY = maxOf(0f, dy)
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val was = dragging
        dragging = false
        if (!draft.isImage && was) {
          if (root.translationY > 120 * d) cancel() else root.animate().translationY(0f).setDuration(250).start()
        }
        return was && !intercept
      }
    }
    return !intercept && draft.isImage
  }

  override fun cancel() {
    onCancel?.invoke()
    onCancel = null
    dismiss()
  }

  private fun choose() {
    if (!forChat) return finish(false)
    val ask = AlertDialog.Builder(context).setTitle("Установить обои")
      .setItems(arrayOf("Для этого чата", "Для всех чатов")) { _, which -> finish(which == 0) }
      .setNegativeButton("Отмена", null)
    try { ask.show() } catch (_: Exception) { }
  }

  private fun finish(forChat: Boolean) {
    val choice = draft
    val done = onSet
    onCancel = null
    dismiss()
    done?.invoke(choice, forChat)
  }
}
