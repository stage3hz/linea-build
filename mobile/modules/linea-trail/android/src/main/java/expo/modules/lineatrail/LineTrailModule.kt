package expo.modules.lineatrail

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/** «Пиксельный след» (src/PixelTrail.tsx). Touches are observed by wrapping the Activity's Window.Callback
 *  (observe, then delegate — never consumed), so the trail follows the finger during RecyclerView/ScrollView
 *  scrolls and RNGH pans too. The cells are drawn on a non-touchable overlay View added to the decor view (inside
 *  the app's own window). Any failure = no trail. */
class LineTrailModule : Module() {
  private var overlay: TrailOverlay? = null
  private var callback: TrailCallback? = null
  private var window: WeakReference<Window>? = null
  private var color = Color.WHITE
  private var enabled = false
  private val main = Handler(Looper.getMainLooper())

  private fun onMain(block: () -> Unit) { main.post { try { block() } catch (_: Throwable) { /* decorative */ } } }

  override fun definition() = ModuleDefinition {
    Name("LineaTrail")

    Function("setEnabled") { on: Boolean ->
      onMain { enabled = on; if (on) attach() else detach() }
    }

    Function("setColor") { hex: String ->
      val parsed = try { Color.parseColor(hex) } catch (_: Throwable) { null }
      if (parsed != null) onMain { color = parsed; overlay?.setColor(parsed) }
    }

    OnActivityEntersForeground { onMain { if (enabled) attach() } }
    OnActivityDestroys { onMain { detach() } }
    OnDestroy { onMain { detach() } }
  }

  private fun attach() {
    val activity: Activity = appContext.currentActivity ?: return
    val target = activity.window ?: return
    val decor = target.decorView as? ViewGroup ?: return
    val current = overlay
    if (current != null && current.parent === decor && window?.get() === target) {
      current.setColor(color)
      if (decor.getChildAt(decor.childCount - 1) !== current) current.bringToFront()
      return
    }
    detach()
    val view = TrailOverlay(activity)
    view.setColor(color)
    decor.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    val existing = target.callback
    val wrapper = when {
      existing is TrailCallback -> existing.also { it.overlay = view }
      existing != null -> TrailCallback(existing, view).also { target.callback = it }
      else -> null
    }
    overlay = view
    callback = wrapper
    window = WeakReference(target)
  }

  private fun detach() {
    val target = window?.get()
    val wrapper = callback
    if (wrapper != null) {
      // Unwrap only when nobody wrapped the callback after us; otherwise stay as a pure pass-through.
      if (target != null && target.callback === wrapper) target.callback = wrapper.inner
      wrapper.overlay = null
    }
    overlay?.let { view -> view.stop(); (view.parent as? ViewGroup)?.removeView(view) }
    overlay = null
    callback = null
    window = null
  }
}
