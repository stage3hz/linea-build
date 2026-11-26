package com.linea.messenger.chats

/** One line of the chat list, ready to draw: every text and colour is already chosen by the owner of the list. */
data class ChatRow(
  val id: String, val title: String, val preview: String, val time: String, val unread: Int,
  val muted: Boolean, val pinned: Boolean, val accentPreview: Boolean, val ticks: Int, val checked: Int,
  val selected: Boolean, val avatarColor: Int, val initials: String,
  /** The letter avatar as a lit ball: its lighter and deeper corner colours (0 = a flat circle). */
  val orbA: Int, val orbB: Int,
  /** A quiet heading drawn above this row (the first chat of a part of the list); empty = none. */
  val section: String,
  /** Picture avatar: where to get it and the key it is cached under; empty = the letter avatar. */
  val avatarUrl: String, val avatarKey: String,
  /** A small JPEG/PNG (base64) shown before the preview text: the photo or video of the last message. */
  val thumb: String, val thumbRound: Boolean,
  /** Avatar frame: a ring of these colours (ARGB) around the photo; empty = none. */
  val ring: List<Int>,
  /** Avatar decoration: the art's drawable name or file path, drawn `decoScale` times the photo; '' = none. */
  val deco: String, val decoScale: Double,
  /** Nameplate behind the row: an id of DecorStore.plates; '' = none. */
  val plate: String,
  /** Swipe buttons as "action:Label", the outermost first: `lead` opens from the left edge, `trail` from the right. */
  val lead: List<String>, val trail: List<String>,
  /** A Platina name: the first `nameLen` characters of the title are drawn in this metal (ARGB); empty = plain. */
  val metal: List<Int>, val nameLen: Int,
  /** A small grey icon before the preview text: "mic" for a voice message, "phone" / "video" for a call; '' = none. */
  val previewIcon: String = "",
  /** The first N characters of the preview are drawn in the danger colour («Черновик:»). */
  val previewRed: Int = 0,
  /** Offline: the last message cannot be opened on this device — the line is said quietly (subtle, italic, a lock). */
  val quietPreview: Boolean = false,
) {
  companion object {
    private fun int(value: Any?, fallback: Int) = (value as? Number)?.toInt() ?: fallback
    private fun text(value: Any?) = value as? String ?: ""
    private fun flag(value: Any?) = value as? Boolean ?: false

    /** Rows without an id are dropped: a row the app cannot name cannot be tapped. */
    fun parse(rows: List<Map<String, Any?>>?): List<ChatRow> = rows.orEmpty().mapNotNull { row ->
      val id = text(row["id"])
      // A call's line draws a phone or a camera before its words instead of the emoji (chatsplus/ChatRowLooks.kt).
      val (preview, previewIcon) = com.linea.messenger.chatsplus.ChatRowLooks.callIcon(text(row["preview"]), text(row["previewIcon"]), text(row["thumb"]))
      if (id.isEmpty()) null else ChatRow(
        id, text(row["title"]), preview, text(row["time"]), int(row["unread"], 0).coerceAtLeast(0),
        flag(row["muted"]), flag(row["pinned"]), flag(row["accentPreview"]), int(row["ticks"], 0).coerceIn(0, 2),
        int(row["checked"], -1).coerceIn(-1, 1), flag(row["selected"]), int(row["avatarColor"], 0xFF5E7BFF.toInt()), text(row["initials"]).take(2), int(row["orbA"], 0), int(row["orbB"], 0), text(row["section"]).take(24),
        text(row["avatarUrl"]), text(row["avatarKey"]), text(row["thumb"]), flag(row["thumbRound"]),
        (row["ring"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() } ?: emptyList(),
        text(row["deco"]), ((row["decoScale"] as? Number)?.toDouble() ?: 1.0).coerceIn(1.0, 2.0), text(row["plate"]),
        (row["lead"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(), (row["trail"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(),
        (row["metal"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() } ?: emptyList(), int(row["nameLen"], 0).coerceAtLeast(0),
        previewIcon, int(row["previewRed"], 0).coerceAtLeast(0), flag(row["quietPreview"]),
      )
    }
  }
}

/** Theme colours as ARGB ints. */
data class ChatPalette(
  val text: Int, val muted: Int, val subtle: Int, val accent: Int, val onAccent: Int,
  val border: Int, val pressed: Int, val selected: Int, val badgeMuted: Int, val bg: Int,
  /** The fill of a pinned row. */
  val pinned: Int = 0x0EFFFFFF,
  val danger: Int = 0xFFFF6B6B.toInt(),
) {
  companion object {
    val DARK = ChatPalette(0xFFF1F5FF.toInt(), 0xFF8A97B4.toInt(), 0xFF6B7896.toInt(), 0xFFA9C4FF.toInt(), 0xFF0A1430.toInt(), 0x12FFFFFF, 0x12FFFFFF, 0x1FA9C4FF, 0xFF34415F.toInt(), 0xFF070B16.toInt())
    fun parse(map: Map<String, Any?>?): ChatPalette {
      if (map == null) return DARK
      fun c(key: String, fallback: Int) = (map[key] as? Number)?.toInt() ?: fallback
      return ChatPalette(c("text", DARK.text), c("muted", DARK.muted), c("subtle", DARK.subtle), c("accent", DARK.accent), c("onAccent", DARK.onAccent),
        c("border", DARK.border), c("pressed", DARK.pressed), c("selected", DARK.selected), c("badgeMuted", DARK.badgeMuted), c("bg", DARK.bg), c("pinned", DARK.pinned), c("danger", DARK.danger))
    }
  }
}
