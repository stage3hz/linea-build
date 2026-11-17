package expo.modules.lineachatlist

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LineBakeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LineaBake")
    View(BakeView::class) {
      AsyncFunction("snapshot") { view: BakeView -> try { view.snapshot() } catch (_: Throwable) { "" } }
    }
  }
}
