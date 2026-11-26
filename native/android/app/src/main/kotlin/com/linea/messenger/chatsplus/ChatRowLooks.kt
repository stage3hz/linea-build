package com.linea.messenger.chatsplus

import com.linea.messenger.core.Core

/** ChatsPlus: what a chat row shows beyond its words — the reference's ChatListScreen.tsx `nativeThumb` and
 *  `listAttachment` (voice/voice.ts): the small picture of a photo, a video or a round video before the preview,
 *  and the microphone of a voice message (native/ios/Sources/ChatsPlus/ChatRowLooks.swift, its attachment part; the
 *  person's decorations are the avatars' business). */
object ChatRowLooks {
  private val voiceName = Regex("^voice-[0-9]{1,16}\\.m4a$")
  private val noteName = Regex("^circle-[0-9]{1,16}\\.mp4$")

  // The owner's rule: the app's own lines carry no emoji, and no icon takes its place. The core words its lines
  // without them now (chat_view.rs), but older messages keep the reference's marks in their stored text
  // («📞 Звонок · 0:04», «🖼 Фотография», «🧹 История очищена», chat_view.rs `APP_MARKS`), as does an older server's
  // push («📞 Входящий звонок»). A mark is dropped only at the start of a line or of a quote «…», and only before
  // the app's own words that follow it, so an emoji someone typed stays theirs.
  private const val FILE = "[^\\s«»][^\\n«»]*\\.[A-Za-z0-9]{1,8}(?:$|[\\n»]| ·)"
  private val appMark = Regex("(^|«|\n)(?:" + listOf(
    "(?:\uD83D\uDCDE|\uD83D\uDCF9) (?=Звонок|Видеозвонок|Пропущенный|Отклонённый|Восстановление связи|Входящий звонок)",
    "\uD83C\uDFA4\uFE0F? (?=Голосовое сообщение)",
    "\uD83D\uDDBC\uFE0F? (?=Фотография)",
    "\uD83C\uDFAC\uFE0F? (?=Видео)",
    "\uD83D\uDCCE\uFE0F? (?=Файл|$FILE)",
    "\uD83C\uDFB5\uFE0F? (?=Аудио|$FILE)",
    "\u270F\uFE0F? (?=Изменено:)",
    "\uD83D\uDDD1\uFE0F? (?=Сообщение удалено)",
    "\uD83D\uDDF3\uFE0F? (?=Голос в опросе)",
    "\u23F1\uFE0F? (?=Автоудаление)",
    "\uD83D\uDEAB (?=Копирование запрещено)",
    "\uD83E\uDDF9 (?=История очищена)",
  ).joinToString("|") + ")")

  /** A line the app shows (a chat row, a quote, a bar above the composer, a search hit, a notification): the
   *  app's emoji marks dropped. */
  fun withoutAppMark(text: String): String = if (text.isEmpty()) text else appMark.replace(text, "$1")

  /** voice.ts `isVoice`: `audio/mp4` named `voice-<digits>.m4a`. */
  fun isVoice(attachment: Map<String, Any?>): Boolean =
    attachment["mimeType"] == "audio/mp4" && voiceName.matches(attachment["name"] as? String ?: "")

  /** voice.ts `isVideoNote`: `video/mp4` named `circle-<digits>.mp4`. */
  fun isVideoNote(attachment: Map<String, Any?>): Boolean =
    attachment["mimeType"] == "video/mp4" && noteName.matches(attachment["name"] as? String ?: "")

  /** voice.ts `listAttachment`: the words of a file-only message in the list, and "mic" for a voice message. */
  fun attachmentLine(attachment: Map<String, Any?>): Pair<String, String> {
    val type = attachment["mimeType"] as? String ?: ""
    return when {
      isVoice(attachment) -> "Голосовое сообщение" to "mic"
      isVideoNote(attachment) -> "Видеосообщение" to ""
      type.startsWith("image/") -> "Фотография" to ""
      type.startsWith("video/") -> "Видео" to ""
      // The file's own name, without the reference's «🎵»/«📎» (the owner's rule: no emoji in the app's lines).
      type.startsWith("audio/") -> (attachment["name"] as? String ?: "Аудио") to ""
      else -> (attachment["name"] as? String ?: "Файл") to ""
    }
  }

  /** The line of a chat whose last message is shown as it is (no typing, no draft, no line found elsewhere): a
   *  message with only a photo, a video or a round video gets its small picture and «Фотография» / «Видео» /
   *  «Видеосообщение»; a voice message the microphone; any other file its name. `words`: the core's own words of the
   *  message (`chatListText`). */
  fun applyMedia(row: MutableMap<String, Any?>, last: Map<String, Any?>, words: String? = Core.view("chatListText", listOf(last)) as? String) {
    val attachment = Core.map(last["attachment"]) ?: return
    // A message with words, or a finished call, keeps its own line (and no picture), as in the reference.
    if (!words.isNullOrBlank()) return
    if (Core.map(last["meta"])?.get("action") != null) return
    val (text, icon) = attachmentLine(attachment)
    row["preview"] = text
    row["previewIcon"] = icon
    val type = attachment["mimeType"] as? String ?: ""
    val round = isVideoNote(attachment)
    val base64 = Core.map(attachment["preview"])?.get("base64") as? String
    if (!base64.isNullOrEmpty() && (round || type.startsWith("image/") || type.startsWith("video/"))) {
      row["thumb"] = base64
      row["thumbRound"] = round
    }
  }
}
