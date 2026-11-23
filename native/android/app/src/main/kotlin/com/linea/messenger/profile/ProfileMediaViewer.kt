package com.linea.messenger.profile

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.drawable.Animatable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import com.linea.messenger.avatars.AvatarMedia
import com.linea.messenger.avatars.LoopVideoView
import com.linea.messenger.design.IconButton
import com.linea.messenger.design.plate
import com.linea.messenger.design.px
import com.linea.messenger.design.words
import com.linea.messenger.people.Person

/** A profile's photo and video full screen (the reference's ProfileMediaViewer.tsx; iOS Profile/ProfileMediaViewer.swift):
 *  swipe sideways between them, «1 из 2» at the top with bars, swipe up or down to close, pinch or double-tap a photo
 *  to zoom (paging and closing pause while it is zoomed), a tap hides the top. The video avatar plays with its sound
 *  here, in a loop. */
class ProfileMediaViewer(context: Context, private val person: Person, private val base: String, start: Int = 0) : Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
  class Item(val video: Boolean, val id: String)

  companion object {
    /** What a person has to show: the video avatar first, then the photo. */
    fun items(person: Person): List<Item> = listOfNotNull(
      if (person.look.avatarVideoId.isNotEmpty()) Item(true, person.look.avatarVideoId) else null,
      if (person.avatarId.isNotEmpty()) Item(false, person.avatarId) else null,
    )
  }

  private val items = items(person)
  private var index = start.coerceIn(0, maxOf(0, items.size - 1))
  private val root = FrameLayout(context)
  private val pager = FrameLayout(context)
  private val pages = ArrayList<View>()
  private val photos = HashMap<Int, ImageView>()
  private val videos = HashMap<Int, LoopVideoView>()
  private val chrome = FrameLayout(context)
  private val count = context.words("", 13f, 0xB3FFFFFF.toInt())
  private val bars = LinearLayout(context)
  /** A sample picture for the debug build's check (no server to ask). */
  var samplePicture: Bitmap? = null
    set(value) { field = value; photos.values.forEach { it.setImageBitmap(value) } }
  private val arrived: (String) -> Unit = { id -> items.forEachIndexed { position, item -> if (item.id == id) fill(position) } }
  private var zoom = 1f
  private val zoomMatrix = Matrix()

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    root.setBackgroundColor(Color.BLACK)
    root.addView(pager, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    items.forEachIndexed { position, item ->
      val page = FrameLayout(context)
      if (item.video) {
        val video = LoopVideoView(context)
        video.sound = true
        page.addView(video, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 0, Gravity.CENTER))
        videos[position] = video
      } else {
        val image = ImageView(context)
        image.scaleType = ImageView.ScaleType.FIT_CENTER
        image.contentDescription = person.displayName
        page.addView(image, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        photos[position] = image
      }
      pager.addView(page, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      pages.add(page)
      com.linea.messenger.effects.MotionBlur.attach(page) // MotionBlur: blurred along its move on screens below 90 Hz (paged sideways, pulled away up or down)
      fill(position)
    }
    val back = IconButton(context, "ion:chevron-back", 24f, Color.WHITE) // «chevron-back» 24
    back.background = context.plate(0x1FFFFFFF, 22f)
    back.contentDescription = "Закрыть"
    back.setOnClickListener { dismiss() }
    chrome.addView(back, FrameLayout.LayoutParams(context.px(44f), context.px(44f)).apply { leftMargin = context.px(12f) })
    // The reference's row (`alignItems: 'center'`): the name, and «n из m» under it when there are several, centred on
    // the 44 dp button as one block, between the button and as much room on the right (`marginRight: 44`).
    val blockTop = (44f - (if (items.size > 1) 38f else 20f)) / 2f
    chrome.addView(context.words(person.displayName, 16f, Color.WHITE, 700).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, context.px(20f)).apply { topMargin = context.px(blockTop); leftMargin = context.px(56f); rightMargin = context.px(56f) })
    count.gravity = Gravity.CENTER
    if (items.size <= 1) count.visibility = View.GONE
    chrome.addView(count, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, context.px(18f)).apply { topMargin = context.px(blockTop + 20f); leftMargin = context.px(56f); rightMargin = context.px(56f) })
    bars.orientation = LinearLayout.HORIZONTAL
    if (items.size > 1) for (i in items.indices) bars.addView(View(context), LinearLayout.LayoutParams(0, context.px(3f), 1f).apply { if (i > 0) leftMargin = context.px(4f) })
    chrome.addView(bars, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, context.px(3f)).apply { topMargin = context.px(52f); leftMargin = context.px(12f); rightMargin = context.px(12f) })
    root.addView(chrome, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, context.px(60f)).apply { topMargin = context.px(40f) })
    setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    window?.apply { setBackgroundDrawable(ColorDrawable(Color.BLACK)); setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT) }
    root.post { root.setOnTouchListener(touch) }
    root.post { placePages(animated = false); showIndex() }
  }

  override fun onStart() { super.onStart(); AvatarMedia.ready.watch(arrived) }
  override fun onStop() { AvatarMedia.ready.unwatch(arrived); videos.values.forEach { it.play(null) }; super.onStop() }

  private fun fill(position: Int) {
    val item = items.getOrNull(position) ?: return
    if (item.video) {
      val video = videos[position] ?: return
      AvatarMedia.video(context, item.id, base)?.let { file ->
        video.layoutParams = (video.layoutParams as FrameLayout.LayoutParams).apply { height = root.width.coerceAtLeast(1) }
        video.play(file)
      }
    } else {
      val image = photos[position] ?: return
      samplePicture?.let { return image.setImageBitmap(it) }
      when (val found = AvatarMedia.drawable(context, item.id, base, 2048, animated = true)) {
        is Bitmap -> image.setImageBitmap(found)
        is Drawable -> { image.setImageDrawable(found); (found as? Animatable)?.start() }
      }
    }
  }

  private fun showIndex() {
    count.text = if (items.size > 1) "${index + 1} из ${items.size}" else ""
    for (i in 0 until bars.childCount) bars.getChildAt(i).background = context.plate(if (i == index) Color.WHITE else 0x59FFFFFF, 1.5f)
    videos.forEach { (position, video) -> if (position == index) video.resume() else video.pause() }
  }

  private fun placePages(animated: Boolean) {
    val w = root.width.toFloat()
    pages.forEachIndexed { position, page ->
      val x = (position - index) * w
      if (animated) page.animate().translationX(x).setDuration(220).start() else page.translationX = x
    }
    videos.forEach { (position, _) -> fill(position) }
  }

  private fun resetZoom() {
    zoom = 1f
    zoomMatrix.reset()
    photos.values.forEach { it.scaleType = ImageView.ScaleType.FIT_CENTER; it.scaleX = 1f; it.scaleY = 1f; it.translationX = 0f; it.translationY = 0f }
  }

  private val scale = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
    override fun onScale(detector: ScaleGestureDetector): Boolean {
      val image = photos[index] ?: return false
      zoom = (zoom * detector.scaleFactor).coerceIn(1f, 4f)
      image.scaleX = zoom; image.scaleY = zoom
      return true
    }
  })

  private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onDoubleTap(e: MotionEvent): Boolean {
      val image = photos[index] ?: return false
      if (zoom > 1.01f) { resetZoom(); return true }
      zoom = 2.5f
      image.pivotX = e.x; image.pivotY = e.y
      image.animate().scaleX(zoom).scaleY(zoom).setDuration(250).start()
      return true
    }

    override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
      chrome.animate().alpha(if (chrome.alpha > 0.5f) 0f else 1f).setDuration(200).start()
      return true
    }
  })

  private var downX = 0f; private var downY = 0f; private var axis = 0; private var downAt = 0L

  private val touch: View.OnTouchListener by lazy { View.OnTouchListener { _, event ->
    scale.onTouchEvent(event)
    gestures.onTouchEvent(event)
    val w = root.width.toFloat(); val h = root.height.toFloat()
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { downX = event.x; downY = event.y; axis = 0; downAt = event.eventTime }
      MotionEvent.ACTION_MOVE -> {
        if (zoom > 1.01f || event.pointerCount > 1) {
          // Zoomed: the finger moves the photo; paging and closing wait.
          photos[index]?.let { it.translationX = event.x - downX; it.translationY = event.y - downY }
          return@OnTouchListener true
        }
        val dx = event.x - downX; val dy = event.y - downY
        if (axis == 0 && (Math.abs(dx) > 16 || Math.abs(dy) > 16)) axis = if (Math.abs(dy) > Math.abs(dx) * 1.5f) 2 else 1
        if (axis == 1) pages.forEachIndexed { position, page -> page.translationX = (position - index) * w + dx }
        if (axis == 2) {
          pager.translationY = dy
          val progress = minOf(1f, Math.abs(dy) / maxOf(1f, h / 2))
          root.background = ColorDrawable(Color.argb(Math.round(255 * (1 - progress)), 0, 0, 0))
          chrome.alpha = 1 - progress
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val dx = event.x - downX; val dy = event.y - downY
        val seconds = maxOf(0.016f, (event.eventTime - downAt) / 1000f)
        if (axis == 1) {
          if (Math.abs(dx) > w * 0.25f || Math.abs(dx / seconds) > 900 * context.resources.displayMetrics.density) {
            val next = (index + if (dx < 0) 1 else -1).coerceIn(0, items.size - 1)
            if (next != index) { index = next; resetZoom() }
          }
          placePages(animated = true)
          showIndex()
        } else if (axis == 2) {
          val progress = Math.abs(dy) / maxOf(1f, h / 2)
          if (progress > 0.3f || Math.abs(dy / seconds) > 900 * context.resources.displayMetrics.density) {
            pager.animate().translationY(if (dy > 0) h else -h).setDuration(200).withEndAction { dismiss() }.start()
          } else {
            pager.animate().translationY(0f).setDuration(250).start()
            root.background = ColorDrawable(Color.BLACK)
            chrome.animate().alpha(1f).setDuration(250).start()
          }
        }
        axis = 0
      }
    }
    true
  } }
}
