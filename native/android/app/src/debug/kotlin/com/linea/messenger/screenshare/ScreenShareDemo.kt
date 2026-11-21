package com.linea.messenger.screenshare

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.view.View
import android.view.ViewGroup
import android.widget.ListView
import com.linea.messenger.app.Launcher
import com.linea.messenger.channels.ChannelsDemo
import com.linea.messenger.channels.CommunityScreen
import com.linea.messenger.profile.pages
import com.linea.messenger.rooms.RoomVoice
import com.linea.messenger.rooms.RoomVoicePeer

/** The emulator check's samples of screen sharing (no account, no server, no media; the pictures are drawn here), the
 *  same names as the iOS simulator's (ScreenShare/ScreenShareSimulator.swift):
 *    --es screendemo panel      the sample server's voice channel «Общий», this phone inside: «Демонстрация экрана» with
 *                               «720p · 60 FPS» and «1080p · 60 FPS», the warning, and Марина Ким's screen
 *    --es screendemo viewer     the same screen on the whole phone: «Марина Ким · 1080p · 60 FPS», «Закрыть», «Повернуть»
 *    --es screendemo starting   the buttons dimmed while the system's question is up, «Отменить запуск»
 *    --es screendemo sharing    this phone shares: the red «Остановить демонстрацию», «Твой экран» with its drawn picture
 *    --es screendemo error      the notice of a share that did not start
 *    --es screendemo room       inside the room «Походники»: the strip «Лариса · показывает экран» under the room's bar
 *    --es screendemo bar        the voice channel's bar over the chats while sharing: the red stop button left of the microphone */
object ScreenShareDemo {
  fun start(intent: Intent, launcher: Launcher): Boolean {
    val demo = intent.getStringExtra("screendemo") ?: return false
    val root = launcher.showDemo()
    val frames = mapOf("peer-3" to frame(true), "peer-1" to frame(true), "self" to frame(false))
    if (demo == "room") {
      root.show("channels")
      com.linea.messenger.rooms.RoomsSimulator.screenDemo(root)
      ScreenShare.showDemo(listOf(Triple("peer-1", "demo-r1", ScreenQuality.P1080)), null, false, "", frames)
      return true
    }
    val peers = listOf(RoomVoicePeer("peer-2", "demo-u2", muted = true, connected = true), RoomVoicePeer("peer-3", "demo-u3", muted = false, connected = true))
    RoomVoice.showDemo("demo-server-voice", "Общий", peers, muted = false, speaking = emptySet(), community = "demo-server" to "Клан «Север»")
    val marina = listOf(Triple("peer-3", "demo-u3", ScreenQuality.P1080))
    when (demo) {
      "starting" -> ScreenShare.showDemo(marina, null, true, "", frames)
      "sharing", "bar" -> ScreenShare.showDemo(if (demo == "bar") emptyList() else marina, ScreenQuality.P1080, false, "", frames)
      "error" -> ScreenShare.showDemo(emptyList(), null, false, "Запуск демонстрации отменён или не подтверждён.", frames)
      else -> ScreenShare.showDemo(marina, null, false, "", frames)
    }
    if (demo == "bar") { root.show("chats"); return true }
    root.show("channels")
    val stack = root.pages() ?: return true
    val screen = CommunityScreen(root.context, null, "demo-server", ChannelsDemo.summaries().firstOrNull { it.id == "demo-server" })
    stack.push(screen, animated = false)
    if (demo == "viewer") root.postDelayed({ stack.push(ScreenViewerScreen(root.context, "peer-3") { id -> if (id == "demo-u3") "Марина Ким" else null }, animated = false) }, 1200)
    // The panel is at the bottom of the community's list.
    else root.postDelayed({ list(screen)?.let { it.setSelection(it.count - 1) } }, 1000)
    return true
  }

  private fun list(view: View): ListView? {
    if (view is ListView) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) list(view.getChildAt(index))?.let { return it }
    return null
  }

  /** A drawn sample frame: a computer's desktop with an editor and a chart, or a phone's chats. Calm colours. */
  fun frame(desktop: Boolean): Bitmap {
    val w = if (desktop) 1280 else 720; val h = if (desktop) 720 else 405
    val made = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val g = Canvas(made)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, w.toFloat(), h.toFloat(), 0xFF1C2430.toInt(), 0xFF2A3442.toInt(), Shader.TileMode.CLAMP)
    g.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
    paint.shader = null
    fun round(x: Float, y: Float, width: Float, height: Float, r: Float, color: Int) { paint.color = color; g.drawRoundRect(RectF(x, y, x + width, y + height), r, r, paint) }
    if (!desktop) {
      val tints = intArrayOf(0x4F8FD9, 0x4FB86A, 0xD9A24F, 0x8A7FD0, 0x5FA8A8)
      for (row in 0 until 5) {
        val y = 40f + row * 70
        paint.color = 0xFF000000.toInt() or tints[row]; g.drawOval(RectF(40f, y, 84f, y + 44), paint)
        round(100f, y + 6, 220f, 12f, 6f, 0xBFFFFFFF.toInt())
        round(100f, y + 26, 380f, 10f, 5f, 0x59FFFFFF)
      }
      return made
    }
    round(70f, 60f, 720f, 540f, 14f, 0xFF121820.toInt())
    round(70f, 60f, 720f, 40f, 14f, 0xFF232C38.toInt())
    for ((index, hex) in intArrayOf(0xE06C5F, 0xE0B65F, 0x6FBF73).withIndex()) { paint.color = 0xFF000000.toInt() or hex; g.drawOval(RectF(88f + index * 22, 73f, 102f + index * 22, 87f), paint) }
    val palette = intArrayOf(0x7FA7D9, 0xC9D1D9, 0x8CC48F, 0xD9B07F, 0xC9D1D9, 0x9A8FD0)
    val indents = intArrayOf(0, 1, 2, 2, 1, 2, 3, 3, 2, 1, 0, 1, 2, 2, 1, 0, 1, 1)
    for (line in 0 until 18) {
      val y = 124f + line * 27
      round(88f, y, 24f, 10f, 3f, 0x2EFFFFFF)
      var x = 130f + indents[line] * 28
      for (word in 0 until 2 + line % 4) {
        val width = 40f + ((line * 37 + word * 53) % 120)
        round(x, y, width, 10f, 3f, 0xD9000000.toInt() or palette[(line + word) % palette.size])
        x += width + 12
      }
    }
    round(830f, 120f, 380f, 300f, 14f, 0xFF18202A.toInt())
    for ((index, value) in floatArrayOf(0.35f, 0.55f, 0.42f, 0.7f, 0.62f, 0.85f, 0.74f).withIndex()) {
      val height = 220f * value
      round(860f + index * 48, 390f - height, 30f, height, 5f, (((0.55f + 0.06f * index) * 255).toInt() shl 24) or 0x5FA8A8)
    }
    paint.color = 0x59000000; g.drawRect(0f, h - 48f, w.toFloat(), h.toFloat(), paint)
    for (index in 0 until 6) round(w / 2f - 165 + index * 56, h - 38f, 30f, 28f, 7f, if (index == 1) 0xCCFFFFFF.toInt() else 0x66FFFFFF)
    return made
  }
}
