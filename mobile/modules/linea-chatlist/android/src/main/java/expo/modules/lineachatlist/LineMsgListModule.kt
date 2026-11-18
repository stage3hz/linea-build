package expo.modules.lineachatlist

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The experimental native list of one chat's messages (contract in ../index.ts). */
class LineMsgListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LineaMsgList")
    View(MsgListView::class) {
      Events("onMsgPress", "onMsgLongPress", "onNearTop", "onLinkPress", "onReactPress")
      Prop("rows") { view: MsgListView, rows: List<Map<String, Any?>>? -> try { view.setRows(MsgRow.parse(rows)) } catch (_: Throwable) { } }
      Prop("palette") { view: MsgListView, palette: Map<String, Any?>? -> try { view.setPalette(MsgPalette.parse(palette)) } catch (_: Throwable) { } }
      Prop("fontSize") { view: MsgListView, size: Double? -> view.setFontSize((size ?: 17.0).toFloat()) }
      Prop("pad") { view: MsgListView, pad: List<Double>? -> view.setPadding((pad?.getOrNull(0) ?: 0.0).toFloat(), (pad?.getOrNull(1) ?: 0.0).toFloat()) }
    }
  }
}
