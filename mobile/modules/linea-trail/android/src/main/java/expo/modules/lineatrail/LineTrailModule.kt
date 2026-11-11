package expo.modules.lineatrail

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/** «Пиксельный след» (src/PixelTrail.tsx). The light is part of the app's BACKGROUND: it is drawn by
 *  TrailBackgroundView, a native view the app mounts inside its background layers, under all content. Touches are
 *  observed by wrapping the Activity's Window.Callback (observe, then delegate — never consumed), so the light
 *  follows the finger during RecyclerView/ScrollView scrolls and RNGH pans too; they feed one shared model
 *  (TrailHub, window coordinates) that every mounted view draws its part of. Any failure = no light. */
class LineTrailModule : Module() {
  private var callback: TrailCallback? = null
  private var window: WeakReference<Window>? = null
  private var enabled = false
  private val main = Handler(Looper.getMainLooper())

  private fun onMain(block: () -> Unit) { main.post { try { block() } catch (_: Throwable) { /* decorative */ } } }

  private fun parse(hex: String?): Int? = if (hex == null) null else try { Color.parseColor(hex) } catch (_: Throwable) { null }

  override fun definition() = ModuleDefinition {
    Name("LineaTrail")

    Function("setEnabled") { on: Boolean ->
      onMain { enabled = on; TrailHub.enabled = on; if (on) attach() else detach() }
    }

    Function("setColor") { hex: String ->
      val parsed = parse(hex)
      if (parsed != null) onMain { TrailHub.color = parsed }
    }

    View(TrailBackgroundView::class) {
      Prop("color") { view: TrailBackgroundView, hex: String? -> view.tint = parse(hex) }
      Prop("active") { view: TrailBackgroundView, on: Boolean? -> view.active = on ?: true }
    }

    OnActivityEntersForeground { onMain { if (enabled) attach() } }
    OnActivityDestroys { onMain { detach() } }
    OnDestroy { onMain { TrailHub.enabled = false; detach() } }
  }

  /** Wraps the Activity window's callback (once) so touches are shown to the hub. */
  private fun attach() {
    val activity: Activity = appContext.currentActivity ?: return
    val target = activity.window ?: return
    if (window?.get() === target && callback != null) return
    detach()
    val existing = target.callback
    val wrapper = when {
      existing is TrailCallback -> existing
      existing != null -> TrailCallback(existing).also { target.callback = it }
      else -> null
    }
    callback = wrapper
    window = WeakReference(target)
  }

  private fun detach() {
    val target = window?.get()
    val wrapper = callback
    // Unwrap only when nobody wrapped the callback after us; otherwise it stays as a pure pass-through
    // (the hub ignores events while the effect is off).
    if (wrapper != null && target != null && target.callback === wrapper) target.callback = wrapper.inner
    callback = null
    window = null
  }
}
