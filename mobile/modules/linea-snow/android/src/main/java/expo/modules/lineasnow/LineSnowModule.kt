package expo.modules.lineasnow

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/** «Снег» on the phone (src/SnowPhone.tsx, contract in ../index.ts). The snow is drawn by SnowView, one transparent
 *  surface the app mounts above everything; it never takes a touch. Touches are observed by wrapping the Activity's
 *  Window.Callback (observe, then delegate — never consumed), as in modules/linea-trail; they sweep and knock the
 *  snow in one shared model (SnowHub, window dp). The device's thermal state melts it. Any failure = no snow. */
class LineSnowModule : Module() {
  private var callback: SnowCallback? = null
  private var window: WeakReference<Window>? = null
  private var enabled = false
  private val main = Handler(Looper.getMainLooper())

  private fun onMain(block: () -> Unit) { main.post { try { block() } catch (_: Throwable) { /* decorative */ } } }

  override fun definition() = ModuleDefinition {
    Name("LineaSnow")

    Function("setEnabled") { on: Boolean ->
      onMain {
        enabled = on
        if (on) { attach(); SnowHub.start(appContext.reactContext); SnowHub.readCutout(decor()) } else { detach(); SnowHub.stop() }
      }
    }

    Function("setLedges") { ledges: List<Map<String, Any?>> ->
      val specs = try { parse(ledges) } catch (_: Throwable) { null }
      // A re-measure usually follows a layout change (rotation too): a good moment to refresh the cutout.
      if (specs != null) onMain { SnowHub.setLedges(specs); SnowHub.readCutout(decor()) }
    }

    Function("setDark") { dark: Boolean -> onMain { SnowHub.dark = dark } }

    Function("setHeat") { heat: Double -> onMain { SnowHub.setHeat(heat.toFloat()) } }

    // Synchronous for JS, so it answers from the value the main thread keeps fresh; only when nothing was read
    // yet it reads the insets itself (plain getters).
    Function("cutout") {
      try {
        if (!SnowHub.cutoutKnown) SnowHub.readCutout(decor())
        SnowHub.cutout?.let { mapOf("x" to it[0].toDouble(), "y" to it[1].toDouble(), "width" to it[2].toDouble(), "height" to it[3].toDouble()) }
      } catch (_: Throwable) { null }
    }

    View(SnowView::class) {
      Prop("active") { view: SnowView, on: Boolean? -> view.active = on ?: true }
    }

    OnActivityEntersForeground { onMain { SnowHub.foreground = true; if (enabled) { attach(); SnowHub.readCutout(decor()) } } }
    OnActivityEntersBackground { onMain { SnowHub.foreground = false } }
    OnActivityDestroys { onMain { detach() } }
    OnDestroy { onMain { SnowHub.stop(); detach() } }
  }

  private fun decor() = appContext.currentActivity?.window?.peekDecorView()

  private fun number(value: Any?, fallback: Float): Float {
    val parsed = (value as? Number)?.toFloat() ?: return fallback
    return if (parsed.isNaN() || parsed.isInfinite()) fallback else parsed
  }

  /** JS ledges → specs; anything malformed is skipped. */
  private fun parse(ledges: List<Map<String, Any?>>): List<LedgeSpec> {
    val specs = ArrayList<LedgeSpec>(ledges.size)
    for (item in ledges) {
      val id = item["id"] as? String ?: continue
      val width = number(item["width"], 0f); val height = number(item["height"], 0f)
      if (width <= 0f || height <= 0f) continue
      specs.add(LedgeSpec(
        id, number(item["x"], 0f), number(item["y"], 0f), width, height,
        number(item["radius"], 0f).coerceAtLeast(0f), number(item["max"], 6f).coerceIn(0f, 40f), item["kind"] != "island",
      ))
    }
    return specs
  }

  /** Wraps the Activity window's callback (once) so touches are shown to the hub. */
  private fun attach() {
    val activity: Activity = appContext.currentActivity ?: return
    val target = activity.window ?: return
    if (window?.get() === target && callback != null) return
    detach()
    val existing = target.callback
    val wrapper = when {
      existing is SnowCallback -> existing
      existing != null -> SnowCallback(existing).also { target.callback = it }
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
