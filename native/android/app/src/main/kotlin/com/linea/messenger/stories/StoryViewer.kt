package com.linea.messenger.stories

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.ChannelImages
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonAvatarView
import com.linea.messenger.shell.Screen
import java.util.TimeZone
import kotlin.math.abs

// The viewer of stories and posts on the whole screen (the reference's `PostViewer` in ProfilePosts.tsx).
// Stories play in turn — five seconds a photo, a video to its end — with bars on top. A tap on the right is the
// next one, on the left third the previous; a swipe left / right does the same and, past the edge, moves to the
// next / previous person; a swipe down closes; a swipe up is the answer (the owner: who watched); holding pauses
// and hides everything but the picture. What a finished drag means, where the page is while it is dragged and
// the words are the core's (`stories…` by name).

/** The thin bars on top: one a story, the current one filling up. */
class StoryBarsView(context: Context) : View(context) {
  private val d = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  var count = 0
    set(value) { if (field != value) { field = maxOf(0, value); invalidate() } }
  private var current = 0
  private var filled = 0.0

  /** The bars before `index` are full, the one at `index` is filled to `progress` (0 … 1). */
  fun set(index: Int, progress: Double) {
    current = index
    filled = progress.coerceIn(0.0, 1.0)
    invalidate()
  }

  /** How much of the bar at `position` is filled, 0 … 1. */
  fun part(position: Int): Float = if (position < current) 1f else if (position == current) filled.toFloat() else 0f

  override fun onDraw(canvas: Canvas) {
    if (count <= 0) return
    for (position in 0 until count) {
      val (left, wide) = track(width.toFloat(), count, position, d)
      val radius = height / 2f
      paint.color = 0x4DFFFFFF
      canvas.drawRoundRect(left, 0f, left + wide, height.toFloat(), radius, radius, paint)
      val part = part(position)
      if (part <= 0f) continue
      paint.color = Color.WHITE
      canvas.drawRoundRect(left, 0f, left + wide * part, height.toFloat(), radius, radius, paint)
    }
  }

  companion object {
    /** Where the bar at `position` of `count` lies in a row `width` px wide: its left edge and its width.
     *  Many stories: the gaps give way before the bars vanish. */
    fun track(width: Float, count: Int, position: Int, density: Float): Pair<Float, Float> {
      val gap = (if (count > 30) 2f else 4f) * density
      val wide = maxOf(1f, (width - gap * (count - 1)) / count)
      return Pair(position * (wide + gap), wide)
    }
  }
}

class StoryViewer(context: Context, private var group: StoryViewerGroup) : Dialog(context, android.R.style.Theme_Translucent_NoTitleBar) {
  /** Whose stories come before (-1) or after (1) those of the person with this key; null: nobody. */
  var neighbour: ((String, Int) -> StoryViewerGroup?)? = null
  /** A story of somebody else came on the screen: the person's key and the story. */
  var onWatched: ((String, StoryPost) -> Unit)? = null
  /** Anything came on the screen, a story or a post. */
  var onOpened: ((StoryPost) -> Unit)? = null
  /** An answer to a story: the author's id, the story, the text; the callback gets null or the words of the failure. */
  var onReply: ((String, StoryPost, String, (String?) -> Unit) -> Unit)? = null
  /** Who watched a story of this account. */
  var loadViewers: ((StoryPost, (StoryViewersData?) -> Unit) -> Unit)? = null
  /** The address of a person's picture. */
  var avatarAddress: ((Person) -> String)? = null
  /** Called once the viewer has gone. */
  var onClosed: (() -> Unit)? = null
  /** For a shot on the emulator: the clock stands at this part of the story on the screen. */
  var frozenAt: Double? = null

  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val main = Handler(Looper.getMainLooper())
  private var index = group.start.coerceIn(0, maxOf(0, group.items.size - 1))

  private val backdrop = ColorDrawable(Color.BLACK)
  private val root = FrameLayout(context)
  private val page = Page(context)
  private val picture = StoryPictureView(context)
  private val video = StoryVideoView(context)
  private val spinner = ProgressBar(context)
  private val goneIcon = StoryIconView(context, "ion:videocam-off-outline", 34f, Color.WHITE)
  private val goneLabel = label(15f, Color.WHITE)
  private val bars = StoryBarsView(context)
  private val avatar = PersonAvatarView(context)
  private val nameLabel = label(15f, Color.WHITE, 700)
  private val lineLabel = label(13f, 0xD9FFFFFF.toInt())
  private val closeButton = StoryIconView(context, "ion:close", 22f, Color.WHITE, GLASS)
  private val captionLabel = label(16f, Color.WHITE)
  private val problemLabel = label(14f, Theme.danger)
  private val viewsButton = LinearLayout(context)
  private val viewsCount = label(14f, Color.WHITE, 600)
  private val replyBox = FrameLayout(context)
  private val replyField = EditText(context)
  private val sendButton = StoryIconView(context, "ion:arrow-up", 22f, Color.WHITE, GLASS)
  private val sendSpinner = ProgressBar(context)
  private val sentLabel = label(13f, 0xD9FFFFFF.toInt())
  /** Everything but the picture: hidden while a finger holds the story. */
  private val chrome: List<View> = listOf(bars, avatar, nameLabel, lineLabel, closeButton, captionLabel, problemLabel, viewsButton, replyBox, sendButton, sendSpinner, sentLabel)

  private var lastTick = 0L
  private var progress = 0.0
  private var brokenFor = 0.0
  private var started = false
  private var closing = false
  private var held = false
  private var dragging = false
  private var typing = false
  private var sending = false
  private var viewersOpen = false
  private var dragAxis = "y"
  private var dragHasPrevious = false
  private var problem = ""
  private var viewCount: Int? = null
  private var viewers: StoryViewersData? = null
  private var sheet: StoryViewersSheet? = null
  private var sentTurn = 0
  private val photoMs = StoryRules.number("photoMs", 5000.0)
  private val brokenMs = StoryRules.number("videoFailedMs", 1500.0)
  private val replyMax = StoryRules.number("replyMax", 4000.0).toInt()
  private val holdMs = StoryRules.number("holdMs", 220.0).toLong()
  private val clock = object : Runnable { override fun run() { tick(); main.postDelayed(this, 16) } }

  private val post: StoryPost? get() = group.items.getOrNull(index)

  /** What is on the screen now (for whoever opened the viewer, and for a check). */
  val shownPost: StoryPost? get() = post
  val shownGroup: StoryViewerGroup get() = group

  // Building

  private fun label(size: Float, color: Int, weight: Int = 400): TextView = TextView(context).apply {
    textSize = size
    typeface = Theme.weight(weight)
    setTextColor(color)
    includeFontPadding = false
  }

  private fun glass(radius: Float) = GradientDrawable().apply {
    setColor(GLASS)
    cornerRadius = radius * d
    setStroke(maxOf(1, dp(0.5f)), 0x33FFFFFF)
  }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    root.background = backdrop
    root.addView(page, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    com.linea.messenger.effects.MotionBlur.attach(page) // MotionBlur: the story's slide to the next person and its pull away, below 90 Hz
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    page.setBackgroundColor(Color.BLACK)
    page.clipChildren = true

    picture.scaleType = ImageView.ScaleType.FIT_CENTER
    picture.onSettled = { settle() }
    page.addView(picture)
    video.contentDescription = StoryRules.word("video")
    video.onSettled = { settle() }
    video.onEnded = { if (group.story) step(1, slide = false) }
    page.addView(video)
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
    spinner.visibility = View.GONE
    page.addView(spinner)
    goneIcon.visibility = View.GONE
    page.addView(goneIcon)
    goneLabel.text = StoryRules.word("videoGone")
    goneLabel.gravity = Gravity.CENTER
    goneLabel.visibility = View.GONE
    page.addView(goneLabel)

    page.addView(bars)
    page.addView(avatar)
    for (line in listOf(nameLabel, lineLabel)) { line.maxLines = 1; line.ellipsize = TextUtils.TruncateAt.END; page.addView(line) }
    closeButton.contentDescription = StoryRules.word("close")
    closeButton.setOnClickListener { closeNow() }
    page.addView(closeButton)

    captionLabel.gravity = Gravity.CENTER
    captionLabel.setShadowLayer(3f * d, 0f, 0f, 0x99000000.toInt())
    page.addView(captionLabel)
    problemLabel.gravity = Gravity.CENTER
    page.addView(problemLabel)

    viewsButton.orientation = LinearLayout.HORIZONTAL
    viewsButton.gravity = Gravity.CENTER
    viewsButton.background = glass(17f)
    viewsButton.setPadding(dp(12f), 0, dp(14f), 0)
    viewsButton.addView(StoryIconView(context, "ion:eye-outline", 18f, Color.WHITE), LinearLayout.LayoutParams(dp(18f), dp(18f)).apply { rightMargin = dp(6f) })
    viewsButton.addView(viewsCount)
    viewsButton.isClickable = true
    viewsButton.isFocusable = true
    viewsButton.setOnClickListener { showViewers() }
    page.addView(viewsButton)

    replyBox.background = glass(22f)
    replyField.background = null
    replyField.hint = StoryRules.word("reply")
    replyField.setHintTextColor(0x99FFFFFF.toInt())
    replyField.textSize = 16f
    replyField.setTextColor(Color.WHITE)
    replyField.isSingleLine = true
    replyField.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    replyField.imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
    replyField.filters = arrayOf(InputFilter.LengthFilter(replyMax))
    replyField.contentDescription = StoryRules.word("replyLabel")
    replyField.setPadding(dp(16f), 0, dp(16f), 0)
    replyField.gravity = Gravity.CENTER_VERTICAL
    replyField.setOnFocusChangeListener { _, focused -> typing = focused; applyPause() }
    replyField.setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_SEND) { sendReply(); true } else false }
    replyField.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(text: Editable?) = refreshSend()
    })
    replyBox.addView(replyField, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    page.addView(replyBox)
    sendButton.contentDescription = StoryRules.word("sendReply")
    sendButton.setOnClickListener { sendReply() }
    page.addView(sendButton)
    sendSpinner.isIndeterminate = true
    sendSpinner.indeterminateTintList = ColorStateList.valueOf(Color.WHITE)
    sendSpinner.visibility = View.GONE
    page.addView(sendSpinner)
    sentLabel.text = StoryRules.word("replySent")
    sentLabel.gravity = Gravity.CENTER
    sentLabel.visibility = View.GONE
    page.addView(sentLabel)

    bars.count = group.items.size
    // Without sight: «Следующее» and «Предыдущее» as actions of the picture; the system's Back closes.
    for (media in listOf<View>(picture, video)) {
      media.isFocusable = true
      media.accessibilityDelegate = object : View.AccessibilityDelegate() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
          super.onInitializeAccessibilityNodeInfo(host, info)
          info.addAction(AccessibilityNodeInfo.AccessibilityAction(FORWARD, StoryRules.word("next")))
          info.addAction(AccessibilityNodeInfo.AccessibilityAction(BACKWARD, StoryRules.word("previous")))
        }
        override fun performAccessibilityAction(host: View, action: Int, args: Bundle?): Boolean {
          if (action == FORWARD) { step(1, slide = false); return true }
          if (action == BACKWARD) { step(-1, slide = false); return true }
          return super.performAccessibilityAction(host, action, args)
        }
      }
    }

    window?.apply {
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setDimAmount(0f)
      // Drawn under the system's bars; the page keeps its own parts clear of them and of the keyboard.
      statusBarColor = Color.TRANSPARENT
      navigationBarColor = Color.TRANSPARENT
      @Suppress("DEPRECATION")
      if (Build.VERSION.SDK_INT >= 30) setDecorFitsSystemWindows(false)
      else decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
      @Suppress("DEPRECATION")
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN)
      if (Build.VERSION.SDK_INT >= 28) attributes = attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
    }
    setOnDismissListener {
      main.removeCallbacks(clock)
      video.setPlaying(false)
      sheet?.dismiss()
      onClosed?.invoke()
    }
  }

  override fun onStart() {
    super.onStart()
    lastTick = 0
    main.removeCallbacks(clock)
    main.post(clock)
  }

  override fun onStop() {
    main.removeCallbacks(clock)
    video.setPlaying(false)
    super.onStop()
  }

  /** The page: the picture or the video in the middle, everything else over it. It moves with the finger. */
  @SuppressLint("ViewConstructor")
  private inner class Page(context: Context) : Screen(context) {
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var tracker: VelocityTracker? = null
    private var downX = 0f
    private var downY = 0f
    private var down = false
    private val holding = Runnable { if (down && !dragging) setHeld(true) }

    override fun place(width: Int, height: Int) {
      val mediaHeight = Math.round(height * 0.82f)
      val mediaTop = (height - mediaHeight) / 2
      put(picture, 0, mediaTop, width, mediaHeight)
      put(video, 0, mediaTop, width, mediaHeight)
      put(spinner, width / 2 - dp(14f), height / 2 - dp(14f), dp(28f), dp(28f))
      put(goneIcon, 0, height / 2 - dp(40f), width, dp(40f))
      put(goneLabel, dp(16f), height / 2 + dp(8f), width - dp(32f), dp(22f))

      var top = edges.top + dp(8f)
      put(bars, dp(10f), top, width - dp(20f), dp(3f))
      if (bars.visibility == View.VISIBLE) top += dp(13f)
      val hasOwner = group.owner != null
      put(avatar, dp(10f), top + dp(3f), dp(34f), dp(34f))
      val textLeft = if (hasOwner) dp(54f) else dp(12f)
      val textWidth = maxOf(0, width - textLeft - dp(60f))
      if (hasOwner) {
        val nameHeight = putText(nameLabel, textLeft, top + dp(2f), textWidth)
        putText(lineLabel, textLeft, top + dp(3f) + nameHeight, textWidth)
      } else {
        putText(lineLabel, textLeft, top + dp(11f), textWidth)
      }
      put(closeButton, width - dp(50f), top, dp(40f), dp(40f))

      var bottom = height - maxOf(edges.bottom + dp(12f), edges.keyboard + dp(12f))
      val side = dp(16f)
      val inner = width - side * 2
      if (sentLabel.visibility == View.VISIBLE) {
        bottom -= dp(18f)
        put(sentLabel, side, bottom, inner, dp(18f))
        bottom -= dp(12f)
      }
      if (replyBox.visibility == View.VISIBLE) {
        bottom -= dp(44f)
        put(replyBox, side, bottom, inner - dp(52f), dp(44f))
        put(sendButton, width - side - dp(44f), bottom, dp(44f), dp(44f))
        put(sendSpinner, width - side - dp(33f), bottom + dp(11f), dp(22f), dp(22f))
        bottom -= dp(12f)
      }
      if (viewsButton.visibility == View.VISIBLE) {
        bottom -= dp(34f)
        viewsButton.measure(MeasureSpec.makeMeasureSpec(dp(200f), MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(dp(34f), MeasureSpec.EXACTLY))
        put(viewsButton, side, bottom, maxOf(dp(60f), viewsButton.measuredWidth), dp(34f))
        bottom -= dp(12f)
      }
      for ((part, most) in listOf(problemLabel to dp(200f), captionLabel to Math.round(height * 0.4f))) {
        if (part.visibility != View.VISIBLE) continue
        part.measure(MeasureSpec.makeMeasureSpec(inner, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(most, MeasureSpec.AT_MOST))
        bottom -= part.measuredHeight
        part.layout(side, bottom, side + inner, bottom + part.measuredHeight)
        bottom -= dp(12f)
      }
      if (!started && width > 0) {
        started = true
        showCurrent(0)
      }
    }

    private fun setHeld(on: Boolean) {
      if (held == on) return
      held = on
      for (part in chrome) part.animate().alpha(if (on) 0f else 1f).setDuration(120).start()
      applyPause()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
      // The page itself moves under the finger: the screen's own coordinates are the steady ones.
      val steady = MotionEvent.obtain(event)
      steady.setLocation(event.rawX, event.rawY)
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          down = true
          downX = event.rawX; downY = event.rawY
          tracker?.recycle()
          tracker = VelocityTracker.obtain().also { it.addMovement(steady) }
          removeCallbacks(holding)
          postDelayed(holding, holdMs)
        }
        MotionEvent.ACTION_MOVE -> if (down) {
          tracker?.addMovement(steady)
          val dx = event.rawX - downX; val dy = event.rawY - downY
          if (!dragging && !closing && (abs(dx) > slop || abs(dy) > slop)) dragBegan(dx / d, dy / d)
          if (dragging) dragMoved(dx / d, dy / d)
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (down) {
          down = false
          removeCallbacks(holding)
          tracker?.addMovement(steady)
          val finished = event.actionMasked == MotionEvent.ACTION_UP
          val wasHeld = held
          setHeld(false)
          if (dragging) {
            tracker?.computeCurrentVelocity(1000)
            dragEnded((event.rawX - downX) / d, (event.rawY - downY) / d, (tracker?.xVelocity ?: 0f) / d, (tracker?.yVelocity ?: 0f) / d, finished)
          } else if (finished && !wasHeld) {
            tapped(event.rawX)
          }
          tracker?.recycle()
          tracker = null
        }
      }
      steady.recycle()
      return true
    }
  }

  // What is on the screen

  private val pixels: Int get() = maxOf(root.width, root.height).coerceIn(640, 2048)

  /** Animations are off on this phone (the system's setting): nothing slides. */
  private val calm: Boolean
    get() = try { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f } catch (_: Exception) { false }

  private fun shown(view: View, on: Boolean) { view.visibility = if (on) View.VISIBLE else View.GONE }

  private fun rest() {
    page.animate().cancel()
    page.translationX = 0f; page.translationY = 0f; page.scaleX = 1f; page.scaleY = 1f
    backdrop.alpha = 255
  }

  /** Shows the item at `index`. `from`: 1 — it comes in from the right, -1 — from the left, 0 — in place. */
  private fun showCurrent(from: Int) {
    val post = post ?: return
    progress = 0.0
    brokenFor = 0.0
    problem = ""
    viewers = null
    viewCount = post.views
    sentTurn += 1
    shown(sentLabel, false)
    replyField.setText("")
    if (post.isVideo) {
      picture.show(null, 0)
      shown(picture, false)
      shown(video, true)
      video.show(post.mediaId, loop = !group.story)
    } else {
      video.show("", loop = false)
      shown(video, false)
      shown(picture, true)
      picture.contentDescription = StoryRules.word("photo")
      picture.show(post, pixels)
    }
    // The next photo is asked for now, so it is there when its turn comes.
    group.items.getOrNull(index + 1)?.takeIf { !it.isVideo }?.let { ChannelImages.image(it.mediaId, pixels) }

    shown(bars, group.story || group.items.size > 1)
    bars.count = group.items.size
    bars.set(index, if (group.story) 0.0 else 1.0)
    val owner = group.owner
    shown(avatar, owner != null)
    shown(nameLabel, owner != null)
    if (owner != null) {
      avatar.show(owner, avatarAddress?.invoke(owner) ?: "")
      nameLabel.text = owner.displayName
    }
    lineLabel.text = Core.view("storiesHeadline", listOf(post.createdAt, System.currentTimeMillis(), group.story, index, group.items.size)) as? String ?: ""
    captionLabel.text = post.caption
    shown(captionLabel, post.caption.isNotEmpty())
    shown(viewsButton, group.own && group.story)
    val replies = group.canReply && group.story && !group.own && onReply != null
    shown(replyBox, replies)
    shown(sendButton, replies)
    refreshViews()
    refreshProblem()
    refreshSend()

    onOpened?.invoke(post)
    if (group.story && !group.own) onWatched?.invoke(group.key, post)
    if (group.own && group.story) {
      val asked = post.id
      loadViewers?.invoke(post) { found ->
        if (this.post?.id != asked || found == null) return@invoke
        viewers = found
        viewCount = found.count
        refreshViews()
      }
    }

    rest()
    if (from != 0 && !calm && root.width > 0) {
      page.translationX = from * root.width.toFloat()
      page.animate().translationX(0f).setDuration(200).withEndAction(null).start()
    }
    page.requestLayout()
    settle()
  }

  private fun refreshViews() {
    val words = Core.map(Core.view("storiesViews", listOf(viewCount)))
    viewsCount.text = (viewCount ?: 0).toString()
    viewsButton.contentDescription = words?.get("spoken") as? String ?: StoryRules.word("views")
    page.requestLayout()
  }

  private fun refreshProblem() {
    problemLabel.text = problem
    shown(problemLabel, problem.isNotEmpty())
    page.requestLayout()
  }

  private fun refreshSend() {
    val has = replyField.text.toString().trim().isNotEmpty()
    val replies = replyBox.visibility == View.VISIBLE
    sendButton.isEnabled = has && !sending
    sendButton.symbol = if (sending) "" else "arrow.up"
    sendButton.disc = if (has) Theme.accent else GLASS
    sendButton.color = if (has) Theme.onAccent else Color.WHITE
    shown(sendSpinner, sending && replies)
  }

  /** The picture or the video has come (or given up): the spinner, «Видео недоступно», the clock. */
  private fun settle() {
    val post = post ?: return
    val waiting = if (post.isVideo) !(video.ready || video.gaveUp) else !picture.settled
    shown(spinner, waiting)
    val gone = post.isVideo && video.gaveUp
    shown(goneIcon, gone)
    shown(goneLabel, gone)
    applyPause()
  }

  private val paused: Boolean get() = frozenAt != null || held || dragging || typing || sending || viewersOpen || closing

  private fun applyPause() {
    val post = post ?: return
    video.setPlaying(post.isVideo && !paused && isShowing)
  }

  private fun tick() {
    val now = SystemClock.uptimeMillis()
    val passed = if (lastTick == 0L) 0L else minOf(100L, now - lastTick)
    lastTick = now
    val post = post ?: return
    if (!started || !group.story) return
    frozenAt?.let { return bars.set(index, it) }
    if (paused) return
    if (post.isVideo) {
      if (video.gaveUp) {
        // «Видео недоступно» stays a moment, then the story moves on instead of hanging.
        brokenFor += passed
        if (brokenFor >= brokenMs) step(1, slide = false)
        return
      }
      bars.set(index, video.played)
      return
    }
    // A photo's five seconds run once it is on the screen.
    if (!picture.settled) return
    progress += passed / maxOf(1.0, photoMs)
    bars.set(index, progress)
    if (progress >= 1) step(1, slide = false)
  }

  // Moving

  private val hasNext: Boolean get() = index + 1 < group.items.size || group.runsOn

  private fun step(direction: Int, slide: Boolean) {
    if (closing) return
    if (direction > 0) {
      if (index + 1 < group.items.size) {
        index += 1
        showCurrent(if (slide) 1 else 0)
      } else if (group.runsOn) {
        val after = neighbour?.invoke(group.key, 1)
        if (after != null) change(after, 1) else closeNow()
      } else {
        springBack()
      }
      return
    }
    if (index > 0) {
      index -= 1
      showCurrent(if (slide) -1 else 0)
    } else {
      val before = neighbour?.invoke(group.key, -1)
      if (before != null) change(before, -1) else springBack()
    }
  }

  /** Another person's stories, in place: the page comes in from the side it was pushed towards. */
  private fun change(next: StoryViewerGroup, from: Int) {
    group = next
    index = next.start.coerceIn(0, maxOf(0, next.items.size - 1))
    showCurrent(from)
  }

  private fun fade(to: Int, duration: Long) {
    val from = backdrop.alpha
    if (from == to) return
    ValueAnimator.ofInt(from, to).apply {
      this.duration = duration
      addUpdateListener { backdrop.alpha = it.animatedValue as Int }
      start()
    }
  }

  private fun springBack() {
    page.animate().translationX(0f).translationY(0f).scaleX(1f).scaleY(1f).setDuration(if (calm) 0 else 300).withEndAction(null).start()
    fade(255, if (calm) 0 else 300)
  }

  private fun hideKeyboard() {
    replyField.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(replyField.windowToken, 0)
  }

  fun closeNow() {
    if (closing) return
    closing = true
    hideKeyboard()
    video.setPlaying(false)
    dismiss()
  }

  // Touches

  private fun tapped(x: Float) {
    if (typing) return hideKeyboard()
    // The left third goes back, the rest forward.
    step(if (x < root.width / 3f) -1 else 1, slide = false)
  }

  private fun dragBegan(dx: Float, dy: Float) {
    dragAxis = Core.view("storiesAxis", listOf(dx, dy)) as? String ?: "y"
    dragHasPrevious = index > 0 || neighbour?.invoke(group.key, -1) != null
    dragging = true
    page.animate().cancel()
    applyPause()
  }

  private fun dragMoved(dx: Float, dy: Float) {
    val at = Core.map(Core.view("storiesDrag", listOf(dragAxis, dx, dy, hasNext, dragHasPrevious, root.height / d))) ?: emptyMap()
    val x = (at["x"] as? Number)?.toFloat() ?: 0f; val y = (at["y"] as? Number)?.toFloat() ?: 0f
    val pulled = (at["progress"] as? Number)?.toFloat() ?: 0f
    // Pulled down, the page shrinks to 0.86 and the black behind it fades to 0.15 (the reference's numbers).
    page.translationX = x * d
    page.translationY = y * d
    page.scaleX = 1f - 0.14f * pulled
    page.scaleY = 1f - 0.14f * pulled
    backdrop.alpha = Math.round(255 * (1f - 0.85f * pulled))
  }

  private fun dragEnded(dx: Float, dy: Float, vx: Float, vy: Float, finished: Boolean) {
    dragging = false
    val action = if (!finished) "cancel" else Core.view("storiesSwipe", listOf(dragAxis, dx, dy, vx, vy, root.width / d)) as? String ?: "cancel"
    finishDrag(action)
    applyPause()
  }

  private fun finishDrag(action: String) {
    val width = root.width.toFloat(); val height = root.height.toFloat()
    if (action == "next" && hasNext) {
      if (calm) return step(1, slide = false)
      page.animate().translationX(-width).setDuration(170).withEndAction { step(1, slide = true) }.start()
    } else if (action == "previous" && dragHasPrevious) {
      if (calm) return step(-1, slide = false)
      page.animate().translationX(width).setDuration(170).withEndAction { step(-1, slide = true) }.start()
    } else if (action == "close" && typing) {
      // The first pull down only puts the keyboard away.
      hideKeyboard()
      springBack()
    } else if (action == "close") {
      if (closing) return
      closing = true
      video.setPlaying(false)
      fade(0, if (calm) 0 else 180)
      page.animate().translationY(height).setDuration(if (calm) 0 else 180).withEndAction { dismiss() }.start()
    } else {
      if (action == "up") swipedUp()
      springBack()
    }
  }

  private fun swipedUp() {
    if (!group.story) return
    if (group.own) return showViewers()
    if (replyBox.visibility != View.VISIBLE) return
    replyField.requestFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(replyField, 0)
  }

  // The answer

  private fun sendReply() {
    val text = replyField.text.toString().trim()
    val post = post ?: return
    val onReply = onReply ?: return
    if (text.isEmpty() || sending || !group.story || group.own) return
    sending = true
    problem = ""
    refreshProblem()
    refreshSend()
    applyPause()
    val asked = post.id
    onReply(group.key, post, text) { failure ->
      sending = false
      if (this.post?.id == asked) {
        if (failure != null) {
          problem = failure
          refreshProblem()
        } else {
          replyField.setText("")
          shown(sentLabel, true)
          sentTurn += 1
          val turn = sentTurn
          page.requestLayout()
          main.postDelayed({
            if (sentTurn == turn) { shown(sentLabel, false); page.requestLayout() }
          }, 1600)
        }
      }
      refreshSend()
      applyPause()
    }
  }

  // Who watched

  private fun showViewers() {
    val post = post ?: return
    if (!group.own || !group.story || viewersOpen) return
    val made = StoryViewersSheet(context, viewers)
    made.avatarAddress = avatarAddress
    made.setOnDismissListener {
      viewersOpen = false
      sheet = null
      applyPause()
    }
    viewersOpen = true
    sheet = made
    applyPause()
    val loadViewers = loadViewers
    if (viewers == null && loadViewers != null) {
      val asked = post.id
      loadViewers(post) { found ->
        if (this.post?.id != asked) return@loadViewers
        if (found != null) {
          viewers = found
          viewCount = found.count
          refreshViews()
        }
        if (sheet === made) made.take(found ?: StoryViewersData(0, emptyList()))
      }
    }
    made.show()
  }

  /** For a shot on the emulator: the list of who watched, over the story. */
  fun emulatorShowViewers(found: StoryViewersData) {
    viewers = found
    viewCount = found.count
    refreshViews()
    showViewers()
  }

  companion object {
    /** The dark glass the buttons over a picture stand on. */
    const val GLASS = 0x66000000
    private val FORWARD = View.generateViewId()
    private val BACKWARD = View.generateViewId()
  }
}

/** «Просмотры»: who watched a story of this account, newest first. A sheet over the lower half of the screen. */
class StoryViewersSheet(context: Context, private var found: StoryViewersData?) : Dialog(context) {
  var avatarAddress: ((Person) -> String)? = null
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val heading = TextView(context)
  private val countLabel = TextView(context)
  private val table = ListView(context)
  private val spinner = ProgressBar(context)
  private val empty = LinearLayout(context)
  private val rows = object : BaseAdapter() {
    override fun getCount() = found?.rows?.size ?: 0
    override fun getItem(position: Int) = found?.rows?.getOrNull(position)
    override fun getItemId(position: Int) = position.toLong()
    override fun isEnabled(position: Int) = false
    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
      val row = convertView as? StoryViewerRow ?: StoryViewerRow(context)
      found?.rows?.getOrNull(position)?.let { row.show(it.person, avatarAddress?.invoke(it.person) ?: "", it.viewedAt) }
      return row
    }
  }

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val column = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, dp(22f), 0, 0)
      background = GradientDrawable().apply { setColor(Theme.bg or 0xFF000000.toInt()); cornerRadii = floatArrayOf(28f * d, 28f * d, 28f * d, 28f * d, 0f, 0f, 0f, 0f) }
    }
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    heading.text = StoryRules.word("views")
    heading.textSize = 20f
    heading.typeface = Theme.weight(600)
    heading.setTextColor(Theme.text)
    if (Build.VERSION.SDK_INT >= 28) heading.isAccessibilityHeading = true
    column.addView(heading, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(20f); rightMargin = dp(20f) })
    countLabel.textSize = 13f
    countLabel.setTextColor(Theme.muted)
    column.addView(countLabel, LinearLayout.LayoutParams(wide, wrap).apply { leftMargin = dp(20f); rightMargin = dp(20f); topMargin = dp(4f) })
    val body = FrameLayout(context)
    table.divider = null
    table.dividerHeight = 0
    table.selector = ColorDrawable(Color.TRANSPARENT)
    table.cacheColorHint = Color.TRANSPARENT
    table.isVerticalScrollBarEnabled = false
    table.adapter = rows
    body.addView(table, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    spinner.isIndeterminate = true
    spinner.indeterminateTintList = ColorStateList.valueOf(Theme.muted)
    body.addView(spinner, FrameLayout.LayoutParams(dp(26f), dp(26f), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = dp(30f) })
    empty.orientation = LinearLayout.VERTICAL
    empty.gravity = Gravity.CENTER_HORIZONTAL
    empty.addView(StoryIconView(context, "ion:eye-outline", 26f, Theme.muted), LinearLayout.LayoutParams(dp(30f), dp(30f)))
    empty.addView(TextView(context).apply { text = StoryRules.word("nobodyWatched"); textSize = 14f; setTextColor(Theme.muted); gravity = Gravity.CENTER },
      LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(6f) })
    body.addView(empty, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply { topMargin = dp(16f); leftMargin = dp(20f); rightMargin = dp(20f) })
    column.addView(body, LinearLayout.LayoutParams(wide, 0, 1f).apply { topMargin = dp(8f) })
    val tall = Math.round(context.resources.displayMetrics.heightPixels * 0.55f)
    setContentView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, tall))
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, tall)
      setGravity(Gravity.BOTTOM)
      setDimAmount(0.5f)
    }
    refresh()
  }

  fun take(next: StoryViewersData) {
    found = next
    refresh()
  }

  private fun refresh() {
    val found = found
    val none = found?.rows.isNullOrEmpty()
    spinner.visibility = if (found == null) View.VISIBLE else View.GONE
    empty.visibility = if (found != null && none) View.VISIBLE else View.GONE
    countLabel.visibility = if (none) View.GONE else View.VISIBLE
    if (found != null) countLabel.text = Core.map(Core.view("storiesViews", listOf(found.count)))?.get("heading") as? String ?: ""
    rows.notifyDataSetChanged()
  }
}

class StoryViewerRow(context: Context) : ViewGroup(context) {
  private val d = resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val avatar = PersonAvatarView(context)
  private val nameLabel = line(15f, Theme.text, 600)
  private val handleLabel = line(12f, Theme.muted, 400)
  private val timeLabel = line(13f, Theme.muted, 400)

  private fun line(size: Float, color: Int, weight: Int) = TextView(context).apply {
    textSize = size
    typeface = Theme.weight(weight)
    setTextColor(color)
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    includeFontPadding = false
  }

  init {
    addView(avatar)
    addView(nameLabel)
    addView(handleLabel)
    timeLabel.gravity = Gravity.END
    addView(timeLabel)
  }

  fun show(person: Person, address: String, viewedAt: String) {
    avatar.show(person, address)
    nameLabel.text = person.displayName
    handleLabel.text = if (person.username.isEmpty()) "" else "@" + person.username
    timeLabel.text = time(viewedAt, System.currentTimeMillis(), TimeZone.getDefault())
    contentDescription = person.displayName
  }

  override fun onMeasure(widthSpec: Int, heightSpec: Int) = setMeasuredDimension(MeasureSpec.getSize(widthSpec), dp(54f))

  private fun put(view: View, left: Int, top: Int, width: Int, height: Int) {
    view.measure(MeasureSpec.makeMeasureSpec(maxOf(0, width), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    view.layout(left, top, left + maxOf(0, width), top + height)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    put(avatar, dp(20f), dp(6f), dp(42f), dp(42f))
    put(timeLabel, width - dp(90f), dp(17f), dp(70f), dp(20f))
    val textWidth = width - dp(74f) - dp(100f)
    put(nameLabel, dp(74f), dp(8f), textWidth, dp(20f))
    put(handleLabel, dp(74f), dp(29f), textWidth, dp(16f))
  }

  companion object {
    /** When a person watched: the clock today, «вчера», else the day — the core's words, by this phone's clock. */
    fun time(viewedAt: String, nowMs: Long, zone: TimeZone): String {
      val at = Messenger.date(viewedAt)?.toEpochMilli() ?: nowMs
      return Core.view("storiesViewedAt", listOf(viewedAt, nowMs, zone.getOffset(at) / 60_000, zone.getOffset(nowMs) / 60_000)) as? String ?: ""
    }
  }
}
