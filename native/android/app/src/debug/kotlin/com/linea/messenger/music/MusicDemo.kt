package com.linea.messenger.music

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.ai.AIDemo
import com.linea.messenger.ai.AIScreen
import com.linea.messenger.app.Launcher
import com.linea.messenger.shell.RootScreen

/** Made-up tracks for looking at «Музыка» on the emulator without a network (`--es musicdemo 1` / `player`).
 *  No audio is bundled: the sample state only looks like playing. The covers are drawn here, in code.
 *  This file is in the debug source set: a release build is compiled with the empty `MusicDemo` of src/release
 *  instead and contains none of this. */
object MusicDemo {
  /** What the launch arguments asked for: `1`, `player`, or null. */
  var mode: String? = null

  private class Sample(val title: String, val artist: String, val seconds: Double, val colors: IntArray)

  private val samples = listOf(
    Sample("Северное сияние", "Лера Туман", 214.0, intArrayOf(0x0E7C66, 0x2BD4A0, 0x0B3B5C)),
    Sample("Полночь над рекой", "Квартал 9", 187.0, intArrayOf(0xE0562F, 0xF2B544, 0x7A1E48)),
    Sample("Тихий час", "Миша Ветров", 243.0, intArrayOf(0x2F5BE0, 0x58B7F2, 0x241E7A)),
    Sample("Бумажный самолёт", "Ореховый сад", 156.0, intArrayOf(0xC9C9C9, 0x6E6E6E, 0x2A2A2A)),
    Sample("Письма без адреса", "Нина Левада", 201.0, intArrayOf(0x8B2FE0, 0xF25FA8, 0x2E1E7A)),
    Sample("Трамвай до моря", "Дом у маяка", 229.0, intArrayOf(0xE0A52F, 0xF2E26B, 0xD9542B)),
  )

  /** A cover in three vertical bands running into one another, with a soft circle — enough for the bar's light. */
  private fun cover(colors: IntArray): Bitmap {
    val size = 300
    val picture = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(picture)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, size.toFloat(), 0f, colors.map { 0xFF000000.toInt() or it }.toIntArray(), floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), paint)
    paint.shader = null
    paint.color = 0x24FFFFFF
    canvas.drawCircle(150f, 150f, 60f, paint)
    return picture
  }

  val tracks: List<MusicTrack> by lazy {
    samples.mapIndexed { index, sample ->
      val id = "demo:$index"
      MusicCovers.drawn[id] = cover(sample.colors)
      MusicTrack(id = id, source = "audius", title = sample.title, artist = sample.artist, duration = sample.seconds)
    }
  }
}

/** What the emulator check asks of «AI» and «Музыка» by launch arguments (see `Demo.start`), as the iOS
 *  simulator check does:
 *    --es aidemo 1|history     «AI» with a sample conversation (a block of code in it); `history`: the history sheet over it
 *    --es musicdemo 1|player|equalizer   «Музыка» with sample tracks and the strip of the playing one; `player`: the full player over it; `equalizer`: the equalizer over that
 *    --es aidemo photo|quick   a photo in the request; the quick question
 *  With an account (or with --ez demo true) the sections themselves open by `--es tab ai` and `--es tab music`. */
object AIMusicSimulator {
  private fun <T : View> find(view: View, kind: Class<T>): T? {
    if (kind.isInstance(view)) return kind.cast(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index), kind)?.let { return it }
    return null
  }

  /** True when one of the two arguments decided the start. */
  fun start(intent: Intent, launcher: Launcher): Boolean {
    val ai = intent.getStringExtra("aidemo"); val music = intent.getStringExtra("musicdemo")
    AIDemo.mode = ai
    MusicDemo.mode = music
    if (ai == null && music == null) return false
    val root: RootScreen = launcher.showDemo()
    root.show(if (music != null) "music" else "ai")
    if (music == "player" || music == "equalizer") root.postDelayed({ find(root, MusicScreen::class.java)?.openPlayer() }, 1500)
    // Music: `equalizer` — the equalizer over the full player, a custom curve (music/MusicEqualizer.kt).
    // The player is pushed on the page stack beside the shell, not inside it: looked for from the window's top, and
    // tried again until it is there (the shot 313 showed the player alone).
    if (music == "equalizer") {
      var tries = 12
      val open = object : Runnable {
        override fun run() {
          val shown = find(root.rootView, PlayerScreen::class.java)
          if (shown == null) { if (--tries > 0) root.postDelayed(this, 400); return }
          EqualizerSettings.attach(root.context)
          EqualizerSettings.profile = EqualizerSettings.Profile("custom", 4.0, -2.0, 6.0)
          shown.openEqualizer()
        }
      }
      root.postDelayed(open, 2300)
    }
    // AI: `photo` — a photo in the request; `quick` — the quick question over the screen (ai/AIAttachments.kt).
    if (music == null && (ai == "photo" || ai == "quick")) root.postDelayed({ find(root, AIScreen::class.java)?.let { com.linea.messenger.ai.AIParity.demo(it, ai) } }, 1500)
    if (music == null && ai == "history") root.postDelayed({ find(root, AIScreen::class.java)?.showHistory() }, 1500)
    return true
  }
}
