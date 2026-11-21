package com.linea.messenger.chat

/** One row of a chat, ready to draw. kind 0 = a message, 1 = a centred
 *  notice (the day, «N сообщений до входа…», a service line). */
data class MsgRow(
  val key: String, val kind: Int, val mine: Boolean, val text: String, val time: String, val ticks: Int,
  val tail: Boolean, val quoteAuthor: String, val quoteText: String, val forward: String, val label: String,
  val thumb: String, val thumbRound: Boolean, val thumbWide: Double, val checked: Int,
  /** Reactions in one line («👍 2  ❤️ 1»); '' = none. */
  val reactions: String,
  /** Formatting of `text`: triples [flags, offset, length]; the flags are listed in MsgRowView.styled. */
  val fmt: List<Int> = emptyList(),
  /** One address per triple with the link flag (64), in order. */
  val urls: List<String> = emptyList(),
  /** Reactions as chips: triples [emoji, count, "1" if mine]. With them `reactions` is only read aloud. */
  val chips: List<String> = emptyList(),
  /** Voice/Video: "voice" (a row with a waveform), "video" or "note" (a round video); empty for any other row. */
  val media: String = "",
  /** Voice: the letters of the waveform (empty: none came with the message). */
  val wave: String = "",
  /** Voice/Video: the length, «1:05» (empty: not known). */
  val mediaTime: String = "",
  /** LinkPreview: the card of a link under the text (linkpreview/LinkCard.kt); null: none. */
  val linkCard: com.linea.messenger.linkpreview.MsgLinkCard? = null,
) {
  companion object {
    private fun text(value: Any?) = value as? String ?: ""
    private fun flag(value: Any?) = value as? Boolean ?: false
    private fun int(value: Any?, fallback: Int) = (value as? Number)?.toInt() ?: fallback
    fun parse(rows: List<Map<String, Any?>>?): List<MsgRow> = rows.orEmpty().mapNotNull { row ->
      val key = text(row["key"])
      if (key.isEmpty()) null else MsgRow(
        key, int(row["kind"], 0), flag(row["mine"]), text(row["text"]), text(row["time"]), int(row["ticks"], 0).coerceIn(0, 4),
        flag(row["tail"]), text(row["quoteAuthor"]), text(row["quoteText"]), text(row["forward"]), text(row["label"]),
        text(row["thumb"]), flag(row["thumbRound"]), ((row["thumbWide"] as? Number)?.toDouble() ?: 1.0).coerceIn(0.4, 2.5), int(row["checked"], -1).coerceIn(-1, 1), text(row["reactions"]),
        (row["fmt"] as? List<*>)?.mapNotNull { (it as? Number)?.toInt() } ?: emptyList(), (row["urls"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(), (row["chips"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(),
        text(row["media"]), text(row["wave"]), text(row["mediaTime"]), com.linea.messenger.linkpreview.MsgLinkCard.parse(row["card"]),
      )
    }
  }
}

data class MsgPalette(
  val text: Int, val muted: Int, val accent: Int, val onAccent: Int, val mine: Int, val theirs: Int,
  val notice: Int, val noticeText: Int, val danger: Int, val quote: Int, val mineMeta: Int, val mineMark: Int, val subtle: Int,
) {
  companion object {
    val DARK = MsgPalette(0xFFF1F5FF.toInt(), 0xFF8A97B4.toInt(), 0xFFA9C4FF.toInt(), 0xFF0A1430.toInt(), 0xFF2B4A8C.toInt(), 0xFF16213A.toInt(),
      0x33000000, 0xFFDCE4F5.toInt(), 0xFFFF8A8A.toInt(), 0x1FFFFFFF, 0xFFC6D2EE.toInt(), 0xFFDCE8FF.toInt(), 0xFF6B7896.toInt())
    fun parse(map: Map<String, Any?>?): MsgPalette {
      if (map == null) return DARK
      fun c(key: String, fallback: Int) = (map[key] as? Number)?.toInt() ?: fallback
      return MsgPalette(c("text", DARK.text), c("muted", DARK.muted), c("accent", DARK.accent), c("onAccent", DARK.onAccent), c("mine", DARK.mine), c("theirs", DARK.theirs),
        c("notice", DARK.notice), c("noticeText", DARK.noticeText), c("danger", DARK.danger), c("quote", DARK.quote), c("mineMeta", DARK.mineMeta), c("mineMark", DARK.mineMark), c("subtle", DARK.subtle))
    }
  }
}
