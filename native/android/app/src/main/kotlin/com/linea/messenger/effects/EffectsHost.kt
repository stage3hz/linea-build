package com.linea.messenger.effects

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ActionMode
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.FrameLayout
import com.linea.messenger.design.Glass
import com.linea.messenger.design.Theme
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.shell.Navigation
import com.linea.messenger.shell.RootScreen
import com.linea.messenger.shell.Screen
import com.linea.messenger.shell.TabBarView
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.min

/** Effects: what the previous app's `SnowPhone.tsx`, `PixelTrail.tsx` and the `IceLayer` / `SnowBackLayer` /
 *  `PixelTrailLayer` of `glass.tsx` did, for this app's screens (iOS Effects/EffectsHost.swift). The drawing itself is
 *  the reference's own Android code (effects/SnowView.kt, effects/SnowModel.kt, effects/TrailBackground.kt,
 *  effects/TrailModel.kt — mobile/modules/linea-snow and linea-trail, nearly verbatim); this file switches it on and off
 *  and tells it where things are:
 *   - «Снег» (`snow`): one front surface above everything in the window (caps, what is knocked off, meltwater); the
 *     falling snow is drawn by a layer at the back of each screen, behind its content; the ledges it lies on are the
 *     camera cutout, the bar at the bottom, the glass plates and the round buttons of the screen's header.
 *   - «Ледяное стекло» (`ice`): rime along the rim of every glass plate. Independent of the snow and of the
 *     animations, as in the reference.
 *   - «Пиксельный след» (`pixelTrail`): a layer at the back of each screen, behind its content.
 *  Snow and the trail run only while animations are allowed (effects/Motion.kt). Nothing here ever takes a touch: the
 *  window's touches are only looked at on their way (the reference's Window.Callback wrapper).
 *
 *  The reference reports the ledges from the components that hold snow (`<SnowLedge id …>`). This app's screens are
 *  looked at as they are: a few times a second while an effect is on, and a rectangle is handed over only once two
 *  looks in a row agree (a control that moves or just appeared carries no snow until it rests). */
object EffectsHost {
  /** Whether the snow also lies on the interface (the previous app's way). Off by the owner's rule. */
  private const val SNOW_LIES = false
  private var window = WeakReference<Activity>(null)
  private var overlay: EffectsOverlay? = null
  private val main = Handler(Looper.getMainLooper())
  private val backs = java.util.WeakHashMap<EffectsBackLayer, Unit>()
  private var seen = HashMap<String, LedgeSpec>()
  private var given: List<LedgeSpec> = emptyList()
  private var settledAt = 0L
  private var snowOn = false
  private var trailOn = false
  private var iceOn = false
  private var backdropOn = false
  private var ticking = false
  private var backdropSource = ""

  /** The emulator check turns the effects on only when a shot asks for them (`--es effects 1`, see Demo.kt): falling
   *  snow in every other screenshot would make them differ from run to run. A phone has them as the person chose. */
  var allowed = true
  /** For the emulator check (`--es snowheat 0.9`): the heat the snow and the rime show. */
  var testHeat = -1f

  private val changed: (Unit) -> Unit = { update() }
  private val tick = object : Runnable {
    override fun run() {
      ticking = false
      look()
      if (wanted) { ticking = true; main.postDelayed(this, 400) }
    }
  }

  /** The switches of «Оформление» as they are now. */
  val wantsSnow: Boolean get() = allowed && (DevicePreferences.flag("snow") ?: true) && Motion.enabled
  val wantsTrail: Boolean get() = allowed && (DevicePreferences.flag("pixelTrail") ?: true) && Motion.enabled
  val wantsIce: Boolean get() = allowed && (DevicePreferences.flag("ice") ?: true)
  private val wanted: Boolean get() = snowOn || trailOn || iceOn || backdropOn

  /** Called once with the app's window (MainActivity). */
  fun attach(activity: Activity) {
    if (Build.FINGERPRINT == "robolectric") return // the JVM page tests: no frame loop, no wrapped window
    window = WeakReference(activity)
    Motion.start(activity)
    Motion.changed.unwatch(changed)
    Motion.changed.watch(changed)
    wrap(activity.window)
    main.post { update() }
  }

  /** The theme was put on again (the shell is rebuilt in its colours): the backs are painted anew. */
  fun restyled() { main.post { update() } }

  /** The window's touches, shown to the snow and the trail first, then handed on unchanged. */
  private fun wrap(target: Window) {
    val existing = target.callback ?: return
    if (existing is EffectsCallback) return
    target.callback = EffectsCallback(existing)
  }

  fun update() {
    val snow = wantsSnow; val trail = wantsTrail; val ice = wantsIce
    val dark = Theme.dark
    // White tiles on dark themes, black on light ones (pixelTrailModel.ts, trailColor).
    TrailHub.color = if (dark) Color.WHITE else Color.BLACK
    if (snow || ice) SnowHub.dark = dark
    val activity = window.get()
    if (snow != snowOn) {
      snowOn = snow
      if (snow) {
        settledAt = SystemClock.uptimeMillis() + 500
        seen = HashMap(); given = emptyList()
        SnowHub.start(activity)
        SnowHub.readCutout(activity?.window?.peekDecorView())
        if (testHeat >= 0) SnowHub.setHeat(testHeat)
      } else SnowHub.stop()
    }
    if (trail != trailOn) { trailOn = trail; TrailHub.enabled = trail }
    iceOn = ice
    val backdrop = PaletteBackdropView.wanted
    val source = com.linea.messenger.settings.ThemeStore.look.source
    if (backdrop != backdropOn || source != backdropSource) {
      backdropOn = backdrop; backdropSource = source
      for (layer in backs.keys.toList()) layer.repaint()
    }
    if (wanted && !ticking) { ticking = true; main.post(tick) }
    else if (!wanted) look()
  }

  // ---- A look at the window ----

  private fun look() {
    val activity = window.get() ?: return
    val decor = activity.window?.peekDecorView() as? ViewGroup ?: return
    placeOverlay(decor)
    placeBacks(decor)
    placeRime(decor)
    if (snowOn) reportLedges(decor)
  }

  /** The front surface (and the rime): the window's last child, above every page. */
  private fun placeOverlay(decor: ViewGroup) {
    val need = snowOn || iceOn
    var layer = overlay
    if (!need) {
      layer?.let { (it.parent as? ViewGroup)?.removeView(it) }
      return
    }
    if (layer == null || layer.context !== decor.context) { layer?.let { (it.parent as? ViewGroup)?.removeView(it) }; layer = EffectsOverlay(decor.context); overlay = layer }
    if (layer.parent !== decor) { (layer.parent as? ViewGroup)?.removeView(layer); decor.addView(layer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) }
    else if (decor.getChildAt(decor.childCount - 1) !== layer) layer.bringToFront()
    layer.front.visibility = if (snowOn) View.VISIBLE else View.GONE
  }

  /** The pages on the screen right now: the top page of the stack, or the section the shell shows. */
  private fun screens(decor: ViewGroup): List<ViewGroup> {
    val stack = find(decor) ?: return emptyList()
    val found = ArrayList<ViewGroup>()
    var top: View? = stack.top
    if (top is RootScreen) top = top.shownSection() ?: top
    (top as? ViewGroup)?.let { found.add(it) }
    return found
  }

  private fun find(view: View, depth: Int = 0): Navigation? {
    if (view is Navigation) return view
    if (depth > 6 || view !is ViewGroup) return null
    for (index in 0 until view.childCount) find(view.getChildAt(index), depth + 1)?.let { return it }
    return null
  }

  /** The falling snow, the trail and a palette's page: at the back of each page, right over its background. */
  private fun placeBacks(decor: ViewGroup) {
    val need = snowOn || trailOn || backdropOn
    val keep = HashSet<EffectsBackLayer>()
    if (need) for (screen in screens(decor)) backLayer(screen)?.let { keep.add(it) }
    for (layer in backs.keys.toList()) if (layer !in keep) {
      (layer.parent as? ViewGroup)?.removeView(layer)
      backs.remove(layer)
    }
    for (layer in keep) layer.show(snowOn, trailOn, backdropOn)
  }

  private fun backLayer(screen: ViewGroup): EffectsBackLayer? {
    // Only pages that lay out a child put in by someone else: the app's own pages and frames.
    if (screen !is Screen && screen !is FrameLayout) return null
    for (index in 0 until screen.childCount) {
      val made = screen.getChildAt(index) as? EffectsBackLayer ?: continue
      if (index != 0) { screen.removeView(made); screen.addView(made, 0) }
      made.fit()
      return made
    }
    val made = EffectsBackLayer(screen.context)
    screen.addView(made, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    made.fit()
    backs[made] = Unit
    return made
  }

  /** «Ледяное стекло»: rime over the rim of every glass plate on the screen. */
  private fun placeRime(decor: ViewGroup) {
    val layer = overlay ?: return
    if (!iceOn) { layer.rime(emptyList()); return }
    val plates = ArrayList<Plate>()
    val size = decor.width
    for (glass in Glass.plates.keys.toList()) {
      val plate = plate(glass) ?: continue
      // A backdrop over the whole screen (a menu's dimming) is not a glass surface.
      if (plate.width > size * 0.98f && plate.height > decor.height * 0.5f) continue
      if (plate.radius <= 0 || plate.width < 24 * density(decor) || plate.height < 24 * density(decor)) continue
      plates.add(plate)
    }
    layer.rime(plates)
  }

  /** A plate of glass where it is now, in window px; null when its owner is off the screen. */
  private class Plate(val key: String, val left: Float, val top: Float, val width: Float, val height: Float, val radius: Float, val owner: View)

  private val spot = IntArray(2)

  private fun plate(glass: Glass): Plate? {
    val owner = glass.owned
    if (!owner.isAttachedToWindow || !owner.isShown || owner.alpha < 0.01f) return null
    val rect = glass.drawn
    if (rect.width() <= 0 || rect.height() <= 0) return null
    owner.getLocationInWindow(spot)
    val radius = min(glass.drawnRadius, min(rect.width(), rect.height()) / 2)
    return Plate("g" + System.identityHashCode(glass), spot[0] + rect.left, spot[1] + rect.top, rect.width(), rect.height(), radius, owner)
  }

  private fun density(view: View) = view.resources.displayMetrics.density

  // ---- Ledges ----

  private fun reportLedges(decor: ViewGroup) {
    if (SystemClock.uptimeMillis() < settledAt) return
    val d = density(decor)
    val current = HashMap<String, LedgeSpec>()
    // The camera cutout (snowModel.ts, islandLedge for Android): a hole or a pill clear of the top edge, no wider than
    // half the screen, portrait only.
    val width = decor.width / d; val height = decor.height / d
    SnowHub.readCutout(decor)
    val cutout = SnowHub.cutout
    if (width > 0 && height > width && cutout != null && cutout[2] >= 8 && cutout[3] >= 8 && cutout[2] <= width / 2 && cutout[1] >= 2) {
      current["island"] = LedgeSpec("island", cutout[0], cutout[1], cutout[2], cutout[3], min(cutout[2], cutout[3]) / 2, 5f, false)
    }
    // The glass plates: the bar at the bottom (7 dp caps), panels and pills (6), round buttons (4).
    for (glass in Glass.plates.keys.toList()) {
      val plate = plate(glass) ?: continue
      val w = plate.width / d; val h = plate.height / d
      if (w < 24 || h < 24 || w >= width * 0.98f) continue
      val bar = plate.owner is TabBarView || plate.owner.parent is TabBarView
      if (!bar && h > 96) continue
      val round = abs(w - h) < 2
      current[plate.key] = LedgeSpec(plate.key, plate.left / d, plate.top / d, w, h, min(plate.radius / d, min(h / 2, w / 2)), if (bar) 7f else if (round) 4f else 6f, true)
    }
    // The round or pill buttons of the header (the upper quarter of the window).
    for (screen in screens(decor)) gatherButtons(screen, 0, decor, d, current)
    // Reported only once two looks in a row agree; a moving or new control is left out until it rests.
    // Owner's rule: the snow only falls at the back of the screens; nothing lies on the buttons and panels, so the
    // engine is given no ledges (no caps, nothing to knock off, no meltwater).
    val steady = if (!SNOW_LIES) emptyList() else current.values.filter { spec -> seen[spec.id]?.let { same(it, spec) } == true }.sortedBy { it.id }
    seen = current
    val moved = steady.size != given.size || steady.zip(given).any { (a, b) -> a.id != b.id || !same(a, b) }
    if (moved) { given = steady; SnowHub.setLedges(steady) }
  }

  private fun same(a: LedgeSpec, b: LedgeSpec): Boolean =
    abs(a.x - b.x) < 0.5f && abs(a.y - b.y) < 0.5f && abs(a.width - b.width) < 0.5f && abs(a.height - b.height) < 0.5f && a.radius == b.radius && a.max == b.max

  private fun gatherButtons(view: View, depth: Int, decor: View, d: Float, into: HashMap<String, LedgeSpec>) {
    if (depth > 40 || view.visibility != View.VISIBLE || view.alpha < 0.01f) return
    if (view is EffectsBackLayer || view is EffectsOverlay) return
    if (view is android.widget.AbsListView || view is android.widget.ScrollView && depth > 3) return
    val w = view.width / d; val h = view.height / d
    if (view.isClickable && h in 28f..64f && w <= 220f && view !is ViewGroup) {
      val background = view.background
      val round = abs(w - h) < 2
      if (round || background is android.graphics.drawable.GradientDrawable) {
        view.getLocationInWindow(spot)
        if (spot[1] < decor.height * 0.25f && spot[1] >= 0) {
          val id = "b" + System.identityHashCode(view)
          into[id] = LedgeSpec(id, spot[0] / d, spot[1] / d, w, h, min(w, h) / 2, if (round) 4f else 6f, true)
          return
        }
      }
    }
    if (view is ViewGroup) for (index in 0 until view.childCount) gatherButtons(view.getChildAt(index), depth + 1, decor, d, into)
  }

  /** Above everything: the front snow, and the rime of each plate at the plate's place. Never takes a touch. */
  @SuppressLint("ViewConstructor")
  private class EffectsOverlay(context: Context) : ViewGroup(context) {
    val front = SnowView(context)
    private val rimes = HashMap<String, Pair<SnowView, Plate>>()
    private val corner = IntArray(2)

    init {
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      isClickable = false; isFocusable = false
      addView(front)
    }

    fun rime(plates: List<Plate>) {
      val keep = plates.map { it.key }.toSet()
      for (key in rimes.keys.toList()) if (key !in keep) { removeView(rimes.getValue(key).first); rimes.remove(key) }
      for (plate in plates) {
        val view = rimes[plate.key]?.first ?: SnowView(context).also { it.layer = "rime"; addView(it) }
        view.radius = plate.radius / resources.displayMetrics.density
        rimes[plate.key] = Pair(view, plate)
      }
      requestLayout()
      layoutRimes()
    }

    private fun layoutRimes() {
      getLocationInWindow(corner)
      for ((view, plate) in rimes.values) {
        val left = (plate.left - corner[0]).toInt(); val top = (plate.top - corner[1]).toInt()
        val w = plate.width.toInt(); val h = plate.height.toInt()
        if (view.left != left || view.top != top || view.width != w || view.height != h) {
          view.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
          view.layout(left, top, left + w, top + h)
        }
      }
    }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
      setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec))
      front.measure(MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      front.layout(0, 0, r - l, b - t)
      layoutRimes()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent?) = false
    override fun dispatchTouchEvent(event: MotionEvent?) = false
    override fun onInterceptTouchEvent(event: MotionEvent?) = false
  }
}

/** The back of one page: a palette theme's page, the trail's surface and the falling snow, under everything else on
 *  the page. A page that places its parts itself (`Screen`) never places this one: it is fitted to the page here. */
@SuppressLint("ViewConstructor")
class EffectsBackLayer(context: Context) : FrameLayout(context) {
  private val page = PaletteBackdropView(context)
  private val trail = TrailBackgroundView(context)
  private val flakes = SnowView(context).also { it.layer = "back" }
  private val fitter = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fit() }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    isClickable = false; isFocusable = false
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); (parent as? View)?.addOnLayoutChangeListener(fitter) }
  override fun onDetachedFromWindow() { (parent as? View)?.removeOnLayoutChangeListener(fitter); super.onDetachedFromWindow() }

  /** Exactly over the page. */
  fun fit() {
    val holder = parent as? View ?: return
    val w = holder.width; val h = holder.height
    if (w <= 0 || h <= 0) return
    // A part put in since (the palette's page, the trail, the snow) asks for a layout that no one else gives: the page
    // that holds this layer places only its own parts. Without it those parts stayed 0 × 0 and nothing showed.
    if (width == w && height == h && left == 0 && top == 0 && !isLayoutRequested) return
    measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    layout(0, 0, w, h)
  }

  fun show(snow: Boolean, trail: Boolean, backdrop: Boolean) {
    fun keep(view: View, on: Boolean, at: Int) {
      if (on && view.parent == null) addView(view, minOf(at, childCount), LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      if (!on && view.parent != null) removeView(view)
    }
    keep(page, backdrop, 0)
    keep(this.trail, trail, if (page.parent != null) 1 else 0)
    keep(flakes, snow, childCount)
    fit()
  }

  /** The theme changed: the page is drawn again in its colours. */
  fun repaint() = page.paint()

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent?) = false
  override fun dispatchTouchEvent(event: MotionEvent?) = false
  override fun onInterceptTouchEvent(event: MotionEvent?) = false
}

/** Wraps the Activity's Window.Callback: every touch is shown to the snow and the trail first, then handed on
 *  unchanged (the reference's SnowCallback and TrailCallback in one). Nothing here can consume or alter an event. */
class EffectsCallback(val inner: Window.Callback) : Window.Callback by inner {
  override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
    if (event != null) {
      try { if (SnowHub.enabled) SnowHub.observe(event) } catch (_: Throwable) { /* decorative: never in the way */ }
      try { if (TrailHub.enabled) TrailHub.observe(event) } catch (_: Throwable) { /* decorative: never in the way */ }
    }
    return inner.dispatchTouchEvent(event)
  }

  // Default interface methods are spelled out so the Activity's own overrides keep working.
  override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) = inner.onProvideKeyboardShortcuts(data, menu, deviceId)
  override fun onPointerCaptureChanged(hasCapture: Boolean) = inner.onPointerCaptureChanged(hasCapture)
  override fun dispatchKeyEvent(event: KeyEvent?) = inner.dispatchKeyEvent(event)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = inner.onWindowStartingActionMode(callback, type)
}
