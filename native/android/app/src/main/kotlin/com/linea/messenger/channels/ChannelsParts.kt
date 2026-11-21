package com.linea.messenger.channels

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.text.TextPaint
import android.view.Gravity
import android.view.View
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.design.plate
import com.linea.messenger.net.Server
import com.linea.messenger.people.pages
import kotlin.math.ceil

// Small things the screens of «Каналы» share.

private val main = Handler(Looper.getMainLooper())

/** A server operation whose answer (a JSON object) comes on the main thread. A failure is a `ServerError`. */
fun Server.ask(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
  op(name, args) { result ->
    main.post { done(if (result.isSuccess) Result.success(Core.map(result.getOrNull() as? Map<*, *>) ?: emptyMap()) else Result.failure(Server.error(result))) }
  }
}

/** A few words with «Понятно» under them. */
fun channelSay(context: Context, words: String) {
  try { AlertDialog.Builder(context, android.R.style.Theme_DeviceDefault_Dialog_Alert).setMessage(words).setPositiveButton("Понятно", null).show() } catch (_: Exception) { /* the window is gone */ }
}

/** A community's round picture; without one — a cold gradient chosen by its id, its initials, and a small mark
 *  of its kind (reference: parts.tsx CommunityAvatar). One drawn view. */
class CommunityAvatarView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val picture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val letters = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textAlign = Paint.Align.CENTER; typeface = Theme.weight(700) }
  private val matrix = Matrix()
  private var colors = intArrayOf(0, 0)
  private var initials = ""
  private var pictureId = ""
  private var markName = "gamecontroller"
  private val pictureReady: (String) -> Unit = { id -> if (id == pictureId && id.isNotEmpty()) invalidate() }

  init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  fun show(community: CommunitySummary) = show(community.id, community.name, community.avatarId, community.blog)

  fun show(id: String, name: String, avatarId: String, blog: Boolean) {
    val pair = ChannelWords.gradient(id)
    colors = intArrayOf(0xFF000000.toInt() or pair.first, 0xFF000000.toInt() or pair.second)
    initials = ChannelWords.initials(name)
    markName = if (blog) "megaphone" else "gamecontroller"
    pictureId = avatarId
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ChannelImages.ready.watch(pictureReady)
  }

  override fun onDetachedFromWindow() {
    ChannelImages.ready.unwatch(pictureReady)
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat(); val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    val radius = minOf(w, h) / 2
    // Decoded off the main thread at the size shown; `ready` draws this view again when it has come.
    val face = if (pictureId.isEmpty()) null else ChannelImages.image(pictureId, ChannelImages.pixels(w, h))
    if (face != null) {
      val shader = BitmapShader(face, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      val scale = maxOf(w / face.width, h / face.height)
      matrix.reset(); matrix.setScale(scale, scale); matrix.postTranslate((w - face.width * scale) / 2, (h - face.height * scale) / 2)
      shader.setLocalMatrix(matrix)
      picture.shader = shader
      canvas.drawCircle(w / 2, h / 2, radius, picture)
      picture.shader = null
      return
    }
    paint.shader = LinearGradient(0f, 0f, w, h, colors, null, Shader.TileMode.CLAMP)
    canvas.drawCircle(w / 2, h / 2, radius, paint)
    paint.shader = null
    letters.textSize = w * 0.34f
    canvas.drawText(initials, w / 2, h / 2 - (letters.ascent() + letters.descent()) / 2, letters)
    val side = w * 0.3f
    val cx = w - side / 2 - 2f; val cy = h - side / 2 - 2f
    paint.color = 0x59000000
    canvas.drawCircle(cx, cy, side / 2, paint)
    ChannelIcons.draw(canvas, markName, cx, cy, side * 0.74f, 0xFFFFFFFF.toInt())
  }
}

/** A counter on a row: «@» for mentions, a number for what is unread. */
class ChannelBadgeLabel(context: Context) : TextView(context) {
  private val d = resources.displayMetrics.density

  init {
    textSize = 11f
    typeface = Theme.weight(800)
    setTextColor(Theme.onAccent)
    gravity = Gravity.CENTER
    includeFontPadding = false
    maxLines = 1
    background = context.plate(Theme.accent, 10f)
    visibility = GONE
  }

  /** Shows the words (hidden when empty). `quiet`: the grey of a muted community. */
  fun show(words: String, quiet: Boolean = false, spoken: String = "") {
    text = words
    visibility = if (words.isEmpty()) GONE else VISIBLE
    background = context.plate(if (quiet) Theme.subtle else Theme.accent, 10f)
    contentDescription = spoken.ifEmpty { words }
  }

  /** The width the badge takes, px (0 when hidden). */
  val wide: Int
    get() = if (visibility != VISIBLE) 0 else maxOf((20 * d).toInt(), ceil(paint.measureText(text.toString()) + 12 * d).toInt())
}

/** Where the screens of the section lead to one another. */
object ChannelsRoute {
  /** Opens a community over the section's root (whatever form or preview was on top goes away). */
  fun openCommunity(from: View, messenger: Messenger, id: String) {
    val stack = from.pages() ?: return
    val context = from.context
    while (stack.depth > 1) stack.pop(animated = false)
    stack.push(CommunityScreen(context, messenger, id, null))
  }

  /** Back to the section's root (the community is gone, or was left). */
  fun closeCommunity(from: View) {
    val stack = from.pages() ?: return
    while (stack.depth > 2) stack.pop(animated = false)
    stack.pop()
  }

  /** Asks the server what an invitation leads to, and shows it (reference: InviteSheet). */
  fun openInvite(from: View, messenger: Messenger, code: String) {
    from.pages()?.push(InvitePage(from.context, messenger, code))
  }
}

/** The square button with a spinner's place: a small turning ring in the app's quiet colour. */
@SuppressLint("ViewConstructor")
class ChannelSpinner(context: Context, color: Int = Theme.muted) : android.widget.ProgressBar(context) {
  init {
    isIndeterminate = true
    indeterminateTintList = android.content.res.ColorStateList.valueOf(color)
  }
}
