package expo.modules.lineachatlist

/** One line of the chat list, ready to draw: JS has already chosen every text and colour (see ../index.ts). */
data class ChatRow(
  val id: String, val title: String, val preview: String, val time: String, val unread: Int,
  val muted: Boolean, val pinned: Boolean, val accentPreview: Boolean, val ticks: Int, val checked: Int,
  val selected: Boolean, val avatarColor: Int, val initials: String,
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
) {
  companion object {
    private fun int(value: Any?, fallback: Int) = (value as? Number)?.toInt() ?: fallback
    private fun text(value: Any?) = value as? String ?: ""
    private fun flag(value: Any?) = value as? Boolean ?: false

    /** Rows without an id are dropped: a row the app cannot name cannot be tapped. */
    fun parse(rows: List<Map<String, Any?>>?): List<ChatRow> = rows.orEmpty().mapNotNull { row ->
      val id = text(row["id"])
      if (id.isEmpty()) null else ChatRow(
        id, text(row["title"]), text(row["preview"]), text(row["time"]), int(row["unread"], 0).coerceAtLeast(0),
        flag(row["muted"]), flag(row["pinned"]), flag(row["accentPreview"]), int(row["ticks"], 0).coerceIn(0, 2),
        int(row["checked"], -1).coerceIn(-1, 1), flag(row["selected"]), int(row["avatarColor"], 0xFF5E7BFF.toInt()), text(row["initials"]).take(2),
        text(row["avatarUrl"]), text(row["avatarKey"]), text(row["thumb"]), flag(row["thumbRound"]),
        (row["ring"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() } ?: emptyList(),
        text(row["deco"]), ((row["decoScale"] as? Number)?.toDouble() ?: 1.0).coerceIn(1.0, 2.0), text(row["plate"]),
        (row["lead"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(), (row["trail"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(),
      )
    }
  }
}

/** Theme colours as ARGB ints (processColor on the JS side). */
data class ChatPalette(
  val text: Int, val muted: Int, val subtle: Int, val accent: Int, val onAccent: Int,
  val border: Int, val pressed: Int, val selected: Int, val badgeMuted: Int, val bg: Int,
) {
  companion object {
    val DARK = ChatPalette(0xFFF1F5FF.toInt(), 0xFF8A97B4.toInt(), 0xFF6B7896.toInt(), 0xFFA9C4FF.toInt(), 0xFF0A1430.toInt(), 0x12FFFFFF, 0x12FFFFFF, 0x1FA9C4FF, 0xFF34415F.toInt(), 0xFF070B16.toInt())
    fun parse(map: Map<String, Any?>?): ChatPalette {
      if (map == null) return DARK
      fun c(key: String, fallback: Int) = (map[key] as? Number)?.toInt() ?: fallback
      return ChatPalette(c("text", DARK.text), c("muted", DARK.muted), c("subtle", DARK.subtle), c("accent", DARK.accent), c("onAccent", DARK.onAccent),
        c("border", DARK.border), c("pressed", DARK.pressed), c("selected", DARK.selected), c("badgeMuted", DARK.badgeMuted), c("bg", DARK.bg))
    }
  }
}
