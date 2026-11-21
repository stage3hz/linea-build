package com.linea.messenger.shell

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.ChatTarget
import com.linea.messenger.app.Launcher
import com.linea.messenger.music.MusicDemo
import com.linea.messenger.music.MusicPlayer

/** What the emulator check asks of the shell, with `--ez demo true` (no account), as the iOS simulator check does
 *  (native/ios/Sources/Shell/ShellSimulator.swift):
 *    --es shelldemo mini        a sample track chosen, «Люди» open: the mini-player above the bar outside «Музыка»
 *    --es shelldemo chatstrip   a sample track and the sample chat: the player strip under the chat's header
 *    --es shelldemo swipe       the sample chat held 45 % off by the swipe back: the list moved aside and dimmed under it
 *    --es shelldemo long        two pages pushed, the swipe held past a third: «Отпусти — в чаты»
 *    --es shelldemo home        «Люди» open: the round mark of the edge swipe to «Чаты»
 *    --es updatedemo required | optional    the update screen / window (shell/UpdateGate.kt)
 *  This file is in the debug source set: a release build is compiled with the empty `ShellDemo` of src/release. */
object ShellDemo {
  var shell: String? = null
    private set
  var update: String? = null
    private set

  fun read(intent: Intent) {
    shell = intent.getStringExtra("shelldemo")
    update = intent.getStringExtra("updatedemo")?.takeIf { it == "required" || it == "optional" }
  }

  fun run(root: RootScreen, launcher: Launcher, stack: Navigation?) {
    val demo = shell ?: return
    val main = Handler(Looper.getMainLooper())
    main.postDelayed({
      val tracks = MusicDemo.tracks
      fun sample() { if (tracks.size >= 2) MusicPlayer.shared.showSample(tracks, tracks[1], 74.0, emptyList()) }
      when (demo) {
        "mini" -> { sample(); root.show("people") }
        "chatstrip" -> { sample(); launcher.openChat(ChatTarget("Алиса Воронцова"), animated = false) }
        "swipe" -> {
          launcher.openChat(ChatTarget("Алиса Воронцова"), animated = false)
          main.postDelayed({ stack?.holdSwipe(0.45f) }, 400)
        }
        "long" -> {
          launcher.openChat(ChatTarget("Алиса Воронцова"), animated = false)
          launcher.openChat(ChatTarget("Марк Соловьёв"), animated = false)
          main.postDelayed({ stack?.holdSwipe(0.5f); stack?.showSwipeMarks(long = true) }, 400)
        }
        "home" -> {
          root.show("people")
          main.postDelayed({ stack?.showSwipeMarks(long = false) }, 400)
        }
      }
    }, 600)
  }
}
