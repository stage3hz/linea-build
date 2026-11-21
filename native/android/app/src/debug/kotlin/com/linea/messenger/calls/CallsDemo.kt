package com.linea.messenger.calls

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Launcher
import com.linea.messenger.people.PeopleDemo

/** What the emulator check asks of calls by launch arguments (debug builds only; see `Demo.start`):
 *    --es calldemo outgoing    no account: the call screen of a call being placed — «Вызов…» under the name, the ring
 *                              pulsing around the picture, «Динамик», «Видео», «Убрать звук», «Завершить»
 *    --es calldemo incoming    «Входящий звонок» with «Отклонить» and «Ответить»
 *    --es calldemo active      a running audio call: the key emoji at the top, the clock (from 0:42) under the name
 *    --es calldemo video       a running video call: the other side's picture over the whole screen and this phone's
 *                              own in the small frame (both drawn — nothing is filmed), «Повернуть» among the buttons
 *    --es calldemo ended       «Звонок завершён», no buttons
 *    --es calldemo retry       «Нет соединения» with «Закрыть» and «Повторить»
 *    --es calldemo bar         the same running call minimised: the green bar under the status bar over the chats
 *  One state of a call on made-up data — no account, no server, no microphone, no camera. */
object CallsDemo : Calls.Samples {
  /** The sample call in one of its states; null for a state there is none of. */
  fun sample(state: String, now: Double = CallRules.nowMs): CallState? {
    val peer = PeopleDemo.named("Алиса Воронцова") ?: return null
    val ringing = CallState("demo-call", "demo", peer, incoming = state == "incoming", video = state == "video", status = "ringing", speaker = state == "video")
    return when (state) {
      "outgoing" -> ringing
      "incoming" -> ringing.copy(status = "incoming")
      "active", "bar" -> ringing.copy(status = "active", startedAt = now - 42_000, key = listOf("🦊", "🌵", "🎧", "⭐"), minimized = state == "bar")
      "video" -> ringing.copy(status = "active", startedAt = now - 192_000, key = listOf("🐳", "🍋", "🚀", "🌙"), localVideo = true, remoteVideo = true)
      "ended" -> ringing.copy(status = "ended", endedText = "Звонок завершён")
      "retry" -> ringing.copy(status = "ended", endedText = CallRules.noConnectionText, retry = true)
      else -> null
    }
  }

  fun show(state: String) { sample(state)?.let { Calls.showSample(it, this) } }

  override fun answered(call: CallState): CallState = call.copy(status = "active", startedAt = CallRules.nowMs, key = listOf("🦊", "🌵", "🎧", "⭐"))
  override fun again() = show("outgoing")

  /** `--es calldemo <state>`: the shell with sample chats, and the sample call over it. True when it was asked for. */
  fun start(intent: Intent, launcher: Launcher): Boolean {
    val state = intent.getStringExtra("calldemo") ?: return false
    launcher.showDemo()
    Handler(Looper.getMainLooper()).postDelayed({ show(state) }, 800)
    return true
  }
}
