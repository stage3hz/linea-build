package expo.modules.lineachatlist

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** The experimental native chat list (contract in ../index.ts). A failure to parse a prop leaves the previous value. */
class LineChatListModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LineaChatList")
    View(ChatListView::class) {
      Events("onRowPress", "onRowLongPress")
      Prop("rows") { view: ChatListView, rows: List<Map<String, Any?>>? -> try { view.setRows(ChatRow.parse(rows)) } catch (_: Throwable) { } }
      Prop("palette") { view: ChatListView, palette: Map<String, Any?>? -> try { view.setPalette(ChatPalette.parse(palette)) } catch (_: Throwable) { } }
      Prop("headers") { view: ChatListView, headers: Map<String, String>? -> view.setHeaders(headers ?: emptyMap()) }
      Prop("plates") { view: ChatListView, plates: Map<String, String>? -> try { view.setPlates(plates ?: emptyMap()) } catch (_: Throwable) { } }
      Prop("pad") { view: ChatListView, pad: List<Double>? -> view.setPadding((pad?.getOrNull(0) ?: 0.0).toFloat(), (pad?.getOrNull(1) ?: 0.0).toFloat()) }
    }
  }
}
