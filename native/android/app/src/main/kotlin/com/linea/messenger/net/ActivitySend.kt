package com.linea.messenger.net

import android.os.Handler
import android.os.Looper

/** What the person is doing in each chat, as the other side is told it: typing, recording a voice message or a
 *  round video, sending a video, a photo, a file, a voice message or a round video. Only the kind leaves the phone
 *  (with an upload's percent), never anything of the message.
 *
 *  Every action is a `Token`, begun when it starts and ended when it stops (sent, called off, failed). While any
 *  token of a chat lives, the newest one is said, and said again every `REPEAT` ms (the other side drops a mark it
 *  does not hear again). When the last one ends, the other side is told the person stopped: an explicit stop
 *  clears everything that person was doing there. Main thread only. */
class ActivitySend(
  private val tell: (chatId: String, on: Boolean, kind: String, progress: Int?) -> Unit,
  private val allowed: () -> Boolean = { true },
  /** Tests: where the repeats are timed; null — the main thread. */
  private val timer: Handler? = null,
) {
  companion object {
    /** How often an action that lasts is said again, ms. */
    const val REPEAT = 4000L
    /** The kinds that send something; they may carry a percent. */
    val uploads = setOf("video", "photo", "file", "voice-upload", "round-upload")
  }

  inner class Token internal constructor(val chatId: String, val kind: String) {
    var ended = false
      internal set
    var progress: Int? = null
      private set

    /** An upload's percent (0…100): carried the next time the action is said. */
    fun progress(percent: Int) {
      if (ended || kind !in uploads) return
      progress = percent.coerceIn(0, 100)
    }

    /** The action stopped (done, called off, failed). Twice is the same as once. */
    fun end() {
      if (ended) return
      ended = true
      val list = active[chatId] ?: return
      list.remove(this)
      if (list.isEmpty()) {
        active.remove(chatId)
        stop(chatId)
      } else say(chatId)
    }
  }

  private val handler: Handler by lazy { timer ?: Handler(Looper.getMainLooper()) }
  private val active = LinkedHashMap<String, MutableList<Token>>()
  private val repeats = HashMap<String, Runnable>()
  private var paused = false

  /** An action starts in a chat. */
  fun begin(chatId: String, kind: String): Token {
    val token = Token(chatId, kind)
    active.getOrPut(chatId) { ArrayList() }.add(token)
    say(chatId)
    return token
  }

  /** What is said for a chat now: the newest action that lives; null — nothing. */
  fun current(chatId: String): String? = active[chatId]?.lastOrNull()?.kind

  /** The chat is left: everything in it ends, and the other side is told. */
  fun endChat(chatId: String) {
    val list = active.remove(chatId) ?: return
    // Marked ended without a word each: the stop below is said once for all of them.
    for (token in list) token.ended = true
    stop(chatId)
  }

  /** The app left the screen: the other side is told the person stopped; what still goes on is said again on
   *  `resume`. */
  fun pause() {
    if (paused) return
    paused = true
    for (chatId in active.keys.toList()) stop(chatId)
  }

  /** The line is up again: what goes on is said again. */
  fun resume() {
    paused = false
    for (chatId in active.keys.toList()) say(chatId)
  }

  private fun say(chatId: String) {
    repeats.remove(chatId)?.let { handler.removeCallbacks(it) }
    val token = active[chatId]?.lastOrNull() ?: return
    if (paused) return
    if (allowed()) tell(chatId, true, token.kind, token.progress)
    val again = Runnable { say(chatId) }
    repeats[chatId] = again
    handler.postDelayed(again, REPEAT)
  }

  private fun stop(chatId: String) {
    repeats.remove(chatId)?.let { handler.removeCallbacks(it) }
    tell(chatId, false, "typing", null)
  }
}
