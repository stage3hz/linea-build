package com.linea.messenger.stories

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileRules
import com.linea.messenger.attachments.PhotoPrepare
import com.linea.messenger.attachments.Picks
import com.linea.messenger.channels.uploadPlainFile
import com.linea.messenger.core.Core
import com.linea.messenger.design.BusyButton
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.people.pages
import com.linea.messenger.shell.Screen
import com.linea.messenger.video.VideoPrepare
import java.io.ByteArrayOutputStream
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sqrt

// Publishing a story or a post (the reference's `pickAndUpload` in ProfilePosts.tsx and `Api.publishPost`):
// a photo or a video is chosen, made ready on this phone — drawn or written anew, so nothing of the original
// file's metadata (place, camera, dates, name) is left — shown with a field for the caption, uploaded as a plain
// profile file (`POST /uploads?purpose=post`) and published (`POST /me/posts`).
//
// The media of a story or a post is not end-to-end encrypted in the reference, and is not here: the server keeps
// the file as it is and gives it to whoever may see the person's posts.
//
// The reference publishes at once, without a screen in between; the caption the server takes (up to 300) could
// not be written there. Here the screen with the picture and the caption comes before «Добавить».

/** A photo or a video made ready to go up. */
class StoryPrepared(
  /** A photo's cleaned bytes. */
  val bytes: ByteArray?,
  /** A video's file, written anew by this app in its private cache. */
  val file: File?,
  val name: String,
  val mimeType: String,
  /** What the screen shows: already decoded. */
  val picture: Bitmap?,
  val isVideo: Boolean,
)

object StoryPrepare {
  class Failure(val words: String) : Exception()

  val photoFailed = Failure("Не удалось обработать фото. Файл не отправлен.")
  val tooBig = Failure("Файл слишком большой. Максимум — 20 МБ.")
  private const val maxPixels = 16_000_000.0

  /** The words of a failed preparation. */
  fun words(result: Result<*>): String = (result.exceptionOrNull() as? Failure)?.words ?: photoFailed.words

  /** What was chosen, by what the system says of it and what its bytes are: "video", "photo", or "" for a file
   *  that is neither. */
  fun kind(mimeType: String?, picture: Boolean, video: Boolean): String = when {
    mimeType?.startsWith("video/") == true -> "video"
    mimeType?.startsWith("image/") == true || picture -> "photo"
    video -> "video"
    else -> ""
  }

  /** The size a photo goes up at. `width`, `height`: as it is seen (upright); `resizeWidth`: the width the core
   *  names for a wider one (null: as it is). Never more than 16 million pixels. Null for a size no picture has. */
  fun photoSize(width: Int, height: Int, resizeWidth: Int?): Pair<Int, Int>? {
    if (width <= 0 || height <= 0 || width > 20000 || height > 20000) return null
    var wide = width.toDouble(); var tall = height.toDouble()
    val wanted = resizeWidth?.takeIf { it in 1 until width }
    if (wanted != null) { tall = floor(height.toDouble() * wanted / width); wide = wanted.toDouble() }
    val pixels = wide * tall
    if (pixels > maxPixels) { val scale = sqrt(maxPixels / pixels); wide = floor(wide * scale); tall = floor(tall * scale) }
    return Pair(maxOf(1, wide.toInt()), maxOf(1, tall.toInt()))
  }

  private fun orientation(resolver: ContentResolver, uri: Uri): Int = try {
    resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } ?: ExifInterface.ORIENTATION_NORMAL
  } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }

  /** A photo: decoded upright, scaled to the width the core names (1600 for a wider one), drawn into a fresh
   *  sRGB bitmap and written as a JPEG that then passes the core's gate (the picture only: no EXIF, no GPS, no
   *  thumbnails). Call off the main thread. */
  fun photo(resolver: ContentResolver, uri: Uri): Result<StoryPrepared> {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    try { resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } } catch (_: Throwable) { return Result.failure(photoFailed) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outMimeType?.startsWith("image/") != true) return Result.failure(photoFailed)
    // Orientations 5 … 8 lie on their side: the width seen is the stored height.
    val turn = orientation(resolver, uri)
    val side = turn in ExifInterface.ORIENTATION_TRANSPOSE..ExifInterface.ORIENTATION_ROTATE_270
    val uprightWidth = if (side) bounds.outHeight else bounds.outWidth
    val uprightHeight = if (side) bounds.outWidth else bounds.outHeight
    val plan = Core.map(Core.view("storiesUpload", listOf(mapOf("video" to false, "width" to uprightWidth)))) ?: return Result.failure(photoFailed)
    if ((plan["error"] as? String).orEmpty().isNotEmpty()) return Result.failure(photoFailed)
    val size = photoSize(uprightWidth, uprightHeight, (plan["resizeWidth"] as? Number)?.toInt()) ?: return Result.failure(photoFailed)
    val decoded = try {
      if (Build.VERSION.SDK_INT >= 28) NewDecoder.decode(resolver, uri, maxOf(size.first, size.second)) else decodeOld(resolver, uri, turn, maxOf(size.first, size.second))
    } catch (_: Throwable) { null } ?: return Result.failure(photoFailed)
    return finish(decoded, plan)
  }

  @TargetApi(28)
  private object NewDecoder {
    /** The system's decoder turns the picture upright by itself and scales while it decodes. */
    fun decode(resolver: ContentResolver, uri: Uri, longest: Int): Bitmap =
      ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.isMutableRequired = false
        decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
        val scale = minOf(1.0, longest.toDouble() / maxOf(info.size.width, info.size.height))
        decoder.setTargetSize(maxOf(1, (info.size.width * scale).roundToInt()), maxOf(1, (info.size.height * scale).roundToInt()))
      }
  }

  /** Before Android 9: decoded at the nearest half-size not under the wanted one, then turned as the file asks. */
  private fun decodeOld(resolver: ContentResolver, uri: Uri, turn: Int, longest: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= longest) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
    val raw = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) } ?: return null
    val matrix = Matrix()
    when (turn) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
    }
    val scale = minOf(1f, longest.toFloat() / maxOf(raw.width, raw.height))
    if (scale < 1f) matrix.postScale(scale, scale)
    if (matrix.isIdentity) return raw
    return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
  }

  /** The decoded picture drawn anew and written out. `plan`: the core's `storiesUpload` for it. Only the fresh
   *  bitmap is given to the encoder: no property of the source is passed on. */
  fun finish(decoded: Bitmap, plan: Map<String, Any?>): Result<StoryPrepared> {
    val fresh = try {
      Bitmap.createBitmap(decoded.width, decoded.height, Bitmap.Config.ARGB_8888).also { made ->
        val canvas = Canvas(made)
        canvas.drawColor(Color.WHITE)
        canvas.drawBitmap(decoded, null, Rect(0, 0, made.width, made.height), Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
      }
    } catch (_: Throwable) { return Result.failure(photoFailed) }
    if (fresh !== decoded) decoded.recycle()
    val quality = (((plan["quality"] as? Number)?.toDouble() ?: 0.85) * 100).roundToInt().coerceIn(1, 100)
    val written = try {
      ByteArrayOutputStream().also { out -> if (!fresh.compress(Bitmap.CompressFormat.JPEG, quality, out)) return Result.failure(photoFailed) }.toByteArray()
    } catch (_: Throwable) { return Result.failure(photoFailed) }
    val clean = FileCore.cleanJpeg(written).getOrNull() ?: return Result.failure(photoFailed)
    if (clean.size > StoryRules.number("smallUpload", 20.0 * 1024 * 1024)) return Result.failure(tooBig)
    return Result.success(StoryPrepared(clean, null, plan["name"] as? String ?: "post.jpg", plan["mimeType"] as? String ?: "image/jpeg", fresh, isVideo = false))
  }

  /** The core's word on a video of this length (and, once written, this size): null — it may go up, with the
   *  plan; else the words of the refusal. */
  fun videoPlan(durationMs: Long, size: Long?): Result<Map<String, Any?>> {
    val asked = linkedMapOf<String, Any?>("video" to true, "durationMs" to durationMs, "mimeType" to "video/mp4")
    if (size != null) asked["size"] = size
    val plan = Core.map(Core.view("storiesUpload", listOf(asked))) ?: return Result.failure(Failure(VideoPrepare.failed))
    val refusal = plan["error"] as? String ?: ""
    if (refusal.isNotEmpty()) return Result.failure(Failure(refusal))
    // Above 20 MiB the reference sends a file in resumable chunks; that road is not built for plain files yet.
    if (size != null && (size <= 0 || plan["chunked"] != false)) return Result.failure(if (size <= 0) Failure(VideoPrepare.failed) else tooBig)
    return Result.success(plan)
  }

  private fun durationMs(file: File): Long? {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(file.absolutePath)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.takeIf { it >= 0 }
    } catch (_: Throwable) { null } finally { try { retriever.release() } catch (_: Throwable) {} }
  }

  /** A video: at most a minute (the core's rule and words), written anew as an MP4 with no metadata by the
   *  app's own cleaning (video/VideoPrepare.kt). What the picker handed over is first copied into the app's
   *  cache; the copy is removed here. Call off the main thread; `done` comes on a background thread. */
  fun video(context: Context, resolver: ContentResolver, uri: Uri, job: VideoPrepare.Job, done: (Result<StoryPrepared>) -> Unit) {
    val app = context.applicationContext
    val failed = Failure(VideoPrepare.failed)
    val source = VideoPrepare.copy(app, resolver, uri, job) ?: return done(Result.failure(failed))
    val seen = durationMs(source)
    val first = if (seen == null) Result.failure(failed) else videoPlan(seen, null)
    if (first.isFailure) {
      source.delete()
      return done(Result.failure(first.exceptionOrNull() ?: failed))
    }
    VideoPrepare.prepare(app, source, job) { result ->
      source.delete()
      val prepared = result.getOrNull() ?: return@prepare done(Result.failure(Failure(FileCore.words(result).ifEmpty { VideoPrepare.failed })))
      val plan = videoPlan(prepared.durationMs, prepared.file.length())
      val allowed = plan.getOrNull()
      if (allowed == null) {
        prepared.file.delete()
        return@prepare done(Result.failure(plan.exceptionOrNull() ?: failed))
      }
      val picture = StoryVideoFrames.frame(prepared.file, 1280)
      done(Result.success(StoryPrepared(null, prepared.file, allowed["name"] as? String ?: "post.mp4", allowed["mimeType"] as? String ?: "video/mp4", picture, isVideo = true)))
    }
  }
}

/** Choosing the photo or video and opening the screen that publishes it. Kept by whoever starts it. */
class StoryPublisher(private val messenger: Messenger) {
  /** Called on the main thread after a story or a post was published: "story" or "post". */
  var onPublished: ((String) -> Unit)? = null
  private val main = Handler(Looper.getMainLooper())

  private fun activity(view: View): Activity? {
    var context: Context? = view.context
    while (context is ContextWrapper && context !is Activity) context = context.baseContext
    return context as? Activity
  }

  /** `kind`: "story" or "post". `from`: a view of the page the screen is opened over. */
  fun begin(kind: String, from: View) {
    val activity = activity(from) ?: return
    val origin = WeakReference(from)
    // The system's picker runs outside the app and hands over only what was chosen, readable for this one time:
    // the app asks for no access to the gallery. Where the phone has none, the system's file chooser does the same.
    val asked = Picks.ask(activity, mediaPicker()) { chosen -> picked(kind, origin.get(), chosen.firstOrNull()) }
      || Picks.ask(activity, documentPicker()) { chosen -> picked(kind, origin.get(), chosen.firstOrNull()) }
    if (!asked) ChatAttachments.say(from.context, "Не удалось открыть галерею.")
  }

  private fun picked(kind: String, from: View?, uri: Uri?) {
    if (from == null || uri == null) return
    val stack = from.pages() ?: return
    val screen = StoryComposeScreen(from.context, messenger, kind)
    screen.onPublished = { published -> onPublished?.invoke(published) }
    stack.push(screen)
    val app = from.context.applicationContext
    val resolver = app.contentResolver
    val job = screen.job
    val hand: (Result<StoryPrepared>) -> Unit = { result -> main.post { screen.take(result) } }
    preparing.execute {
      val type = try { resolver.getType(uri) } catch (_: Throwable) { null }
      val head = ByteArray(16)
      try { resolver.openInputStream(uri)?.use { it.read(head) } } catch (_: Throwable) {}
      when (StoryPrepare.kind(type, PhotoPrepare.isPicture(resolver, uri), FileRules.isVideo(type, head))) {
        "video" -> StoryPrepare.video(app, resolver, uri, job, hand)
        "photo" -> hand(StoryPrepare.photo(resolver, uri))
        else -> hand(Result.failure(StoryPrepare.Failure(StoryRules.word("mediaOnly"))))
      }
    }
  }

  companion object {
    private val preparing = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.story-prepare").apply { isDaemon = true } }

    /** The system's photo picker for one photo or video (Android 13, and earlier phones the system update
     *  brought it to); else its file chooser. */
    fun mediaPicker(): Intent {
      val has = Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= 30 && Extensions.photoPicker())
      return if (has) Extensions.pickMedia() else documentPicker()
    }

    /** The system's file chooser showing photos and videos: it hands over what was chosen, to read, for this one time. */
    fun documentPicker(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
    }
  }

  @TargetApi(30)
  private object Extensions {
    fun photoPicker(): Boolean = try { SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2 } catch (_: Throwable) { false }

    /** With no type named the picker shows both photos and videos; one may be chosen. */
    @SuppressLint("InlinedApi")
    fun pickMedia(): Intent = Intent(MediaStore.ACTION_PICK_IMAGES)
  }
}

/** The screen before publishing: the picture, the caption, «Добавить историю» / «Добавить публикацию». */
@SuppressLint("ViewConstructor")
class StoryComposeScreen(context: Context, private val messenger: Messenger?, private val kind: String) : Screen(context) {
  var onPublished: ((String) -> Unit)? = null
  /** Stops the preparation of a video when the screen is left. */
  val job = VideoPrepare.Job()
  private var prepared: StoryPrepared? = null
  private var busy = false
  private var left = false
  private val main = Handler(Looper.getMainLooper())

  private val backButton = StoryIconView(context, "ion:chevron-back", 23f, Theme.text)
  private val heading = TextView(context)
  private val preview = ImageView(context)
  private val playMark = StoryIconView(context, "ion:play", 26f, Color.WHITE, 0x66000000)
  private val spinner = ProgressBar(context)
  private val problemLabel = TextView(context)
  private val bar = View(context)
  private val captionField = EditText(context)
  private val leftLabel = TextView(context)
  private val publishButton = BusyButton(context, addWords(), Theme.accent, Theme.onAccent, 24f, 16f)

  private fun addWords(): String = StoryRules.word(if (kind == "story") "addStory" else "addPost")

  init {
    setBackgroundColor(Theme.bg)
    // A touch on the page puts the keyboard away (and goes no further, to the page under this one).
    isClickable = true
    setOnClickListener { endTyping() }

    backButton.contentDescription = "Назад"
    backButton.setOnClickListener { goBack() }
    addView(backButton)
    heading.text = StoryRules.word(if (kind == "story") "removeStory" else "removePost")
    heading.textSize = 20f
    heading.typeface = Theme.weight(600)
    heading.setTextColor(Theme.text)
    heading.gravity = Gravity.CENTER_VERTICAL
    heading.maxLines = 1
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    addView(heading)

    preview.scaleType = ImageView.ScaleType.FIT_CENTER
    preview.background = context.plate(Theme.surface2 or 0xFF000000.toInt(), 22f)
    preview.clipToOutline = true
    addView(preview)
    playMark.visibility = View.GONE
    addView(playMark)
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.muted)
    addView(spinner)
    problemLabel.textSize = 14f
    problemLabel.setTextColor(Theme.danger)
    problemLabel.gravity = Gravity.CENTER
    addView(problemLabel)

    bar.background = context.plate(Theme.surface2 or 0xFF000000.toInt(), 26f, Theme.veil(0.08f))
    addView(bar)
    captionField.background = null
    captionField.hint = "Подпись"
    captionField.setHintTextColor(Theme.muted)
    captionField.textSize = 16f
    captionField.setTextColor(Theme.text)
    captionField.isSingleLine = true
    captionField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    captionField.imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    captionField.contentDescription = "Подпись"
    captionField.setPadding(0, 0, 0, 0)
    captionField.gravity = Gravity.CENTER_VERTICAL
    captionField.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_DONE) { endTyping(); true } else false }
    captionField.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) = captionEdited()
    })
    addView(captionField)
    leftLabel.textSize = 12f
    leftLabel.typeface = Typeface.MONOSPACE
    leftLabel.setTextColor(Theme.muted)
    leftLabel.gravity = Gravity.END or Gravity.CENTER_VERTICAL
    addView(leftLabel)
    publishButton.onPress = { publish() }
    addView(publishButton)
    refresh()
  }

  override fun onDetachedFromWindow() {
    // The screen was left: what was being made ready is not kept.
    left = true
    job.cancel()
    endTyping()
    // (A video on its way up is removed when the upload is over.)
    if (!busy) prepared?.file?.delete()
    super.onDetachedFromWindow()
  }

  override fun place(width: Int, height: Int) {
    val top = edges.top + dp(4f)
    put(backButton, dp(6f), top, dp(44f), dp(44f))
    put(heading, dp(52f), top, width - dp(52f) - dp(16f), dp(44f))
    // The bar ends where the keyboard begins, so the caption is never under it.
    val barTall = dp(6f + 44f + 4f + 48f + 10f)
    val barTop = height - maxOf(edges.keyboard, edges.bottom) - dp(10f) - barTall
    put(bar, dp(12f), barTop, width - dp(24f), barTall)
    leftLabel.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED), MeasureSpec.makeMeasureSpec(dp(44f), MeasureSpec.EXACTLY))
    val leftWide = leftLabel.measuredWidth
    put(leftLabel, width - dp(12f + 18f) - leftWide, barTop + dp(6f), leftWide, dp(44f))
    put(captionField, dp(12f + 18f), barTop + dp(6f), width - dp(24f + 36f) - leftWide - dp(8f), dp(44f))
    put(publishButton, dp(12f + 10f), barTop + dp(54f), width - dp(24f + 20f), dp(48f))
    problemLabel.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width - dp(40f)), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val problemTall = if (problemLabel.text.isNullOrEmpty()) 0 else problemLabel.measuredHeight
    val problemTop = barTop - dp(8f) - problemTall
    problemLabel.layout(dp(20f), problemTop, width - dp(20f), problemTop + problemTall)
    val previewTop = top + dp(44f + 8f)
    val previewTall = maxOf(0, problemTop - dp(8f) - previewTop)
    put(preview, dp(16f), previewTop, width - dp(32f), previewTall)
    val middle = previewTop + previewTall / 2
    put(playMark, width / 2 - dp(32f), middle - dp(32f), dp(64f), dp(64f))
    put(spinner, width / 2 - dp(14f), middle - dp(14f), dp(28f), dp(28f))
  }

  private fun goBack() {
    if (busy) return
    val stack = pages() ?: return
    if (stack.top === this) { endTyping(); stack.pop() }
  }

  private fun endTyping() {
    captionField.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
  }

  private fun say(words: String) {
    if (problemLabel.text.toString() == words) return
    problemLabel.text = words
    requestLayout()
  }

  /** What was chosen is ready (or could not be made ready). */
  fun take(result: Result<StoryPrepared>) {
    val made = result.getOrNull()
    if (left) {
      made?.file?.delete()
      return
    }
    spinner.visibility = View.GONE
    if (made != null) {
      prepared = made
      preview.setImageBitmap(made.picture)
      preview.contentDescription = StoryRules.word(if (made.isVideo) "video" else "photo")
      playMark.visibility = if (made.isVideo) View.VISIBLE else View.GONE
    } else {
      say(StoryPrepare.words(result))
    }
    refresh()
  }

  private fun refresh() {
    publishButton.label = if (busy) "" else addWords()
    publishButton.loading = busy
    publishButton.isEnabled = prepared != null && !busy
    captionField.isEnabled = !busy
    backButton.isEnabled = !busy
  }

  private class Caption(val caption: String, val error: String, val left: Int)

  private fun checked(): Caption {
    val made = Core.map(Core.view("storiesCaption", listOf(captionField.text.toString()))) ?: emptyMap()
    return Caption(made["caption"] as? String ?: "", made["error"] as? String ?: "", (made["left"] as? Number)?.toInt() ?: 0)
  }

  private fun captionEdited() {
    val state = checked()
    // The count shows up near the limit; past it, it turns red and the server's own words are shown.
    leftLabel.text = if (state.left <= 40) state.left.toString() else ""
    leftLabel.setTextColor(if (state.left < 0) Theme.danger else Theme.muted)
    say(state.error)
    requestLayout()
  }

  private fun publish() {
    val prepared = prepared ?: return
    if (busy) return
    val state = checked()
    if (state.error.isNotEmpty()) return say(state.error)
    // Without an account (the debug build's samples) there is nothing to publish to.
    val messenger = messenger ?: return
    endTyping()
    busy = true
    say("")
    refresh()
    val server = messenger.server
    val kind = kind
    val fallback = StoryRules.word(if (kind == "story") "addStoryFailed" else "addPostFailed")
    uploading.execute {
      val outcome = send(server, prepared, kind, state.caption, fallback)
      main.post {
        busy = false
        if (outcome.isSuccess || left) prepared.file?.delete()
        if (outcome.isSuccess) {
          onPublished?.invoke(kind)
          if (!left) pages()?.let { stack -> if (stack.top === this) stack.pop() }
        } else {
          say(Server.error(outcome).words.ifEmpty { fallback })
        }
        refresh()
      }
    }
  }

  /** For a shot on the emulator: a drawn picture and a caption, as if they had just been chosen. */
  fun emulatorFill(picture: Bitmap, caption: String) {
    val bytes = ByteArrayOutputStream().also { picture.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    take(Result.success(StoryPrepared(bytes, null, "post.jpg", "image/jpeg", picture, isVideo = false)))
    captionField.setText(caption)
  }

  companion object {
    private val uploading = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.story-upload").apply { isDaemon = true } }

    /** Uploads what was made ready as a plain profile file and publishes it. Waits on the calling (background)
     *  thread. A failure is a `ServerError`. */
    fun send(server: Server, prepared: StoryPrepared, kind: String, caption: String, fallback: String): Result<Any?> {
      val bytes = prepared.bytes ?: try { prepared.file?.readBytes() } catch (_: Throwable) { null } ?: return Result.failure(ServerError.Network(fallback))
      val uploaded = server.uploadPlainFile(bytes, prepared.name, prepared.mimeType, "post")
      val file = uploaded.getOrNull() ?: return Result.failure(Server.error(uploaded))
      return server.opAndWait("publishPost", listOf(file["id"] as? String ?: "", kind, caption))
    }
  }
}
