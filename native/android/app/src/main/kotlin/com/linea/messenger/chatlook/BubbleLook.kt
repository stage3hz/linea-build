package com.linea.messenger.chatlook

import android.graphics.Path
import android.graphics.RectF
import com.linea.messenger.chat.MsgPalette
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.settings.DevicePreferences
import com.linea.messenger.settings.ThemeLook
import com.linea.messenger.settings.ThemeStore

/** How a chat shows its messages (iOS: Sources/ChatLook/BubbleLook.swift). The owner's default is the open look:
 *  no bubbles, own words at the right edge, the other side's at the left with a thin line in their colour. Bubbles
 *  (the reference's look with a wallpaper) come with a wallpaper or when the person turns them on in «Оформление» —
 *  then «Углы сообщений» and «Цвет своих сообщений» apply (the reference's MessageRow.tsx `radius`, ColorSettings.tsx). */
object ChatBubbleLook {
  const val BUBBLES_KEY = "invizent.chat-bubbles.v1"

  /** What the list draws now (main thread; set by the open chat before its rows are laid out). */
  var open = true
  /** «Углы сообщений»: 8, 14 or 20 (dp). */
  var radius = 20f
  /** The line by the other side's words in the open look (their colour, ARGB); 0: the accent. */
  var peerLine = 0

  /** The emulator check: bubbles shown without the choice being kept. */
  var demoBubbles: Boolean? = null

  /** «Пузыри сообщений» in «Оформление» (off by default: the open look). */
  var bubblesChosen: Boolean
    get() = demoBubbles ?: (ThemeStore.kept?.get(BUBBLES_KEY) == "1")
    set(value) {
      ThemeStore.kept?.set(BUBBLES_KEY, if (value) "1" else null)
      Wallpapers.changed.post(Unit)
    }

  /** The radius chosen in «Углы сообщений» (the core keeps it among the device preferences: 8, 14 or 20). */
  val chosenRadius: Float
    get() {
      val value = DevicePreferences.number("bubbleRadius") ?: 20.0
      return if (value == 8.0 || value == 14.0 || value == 20.0) value.toFloat() else 20f
    }

  /** Bubbles for this chat: chosen, or a wallpaper is on (words over a picture need their plate). */
  fun bubbles(chatId: String): Boolean = bubblesChosen || Wallpapers.choice(chatId).shown

  /** A key of everything that changes the layout or the drawing of rows: a row lays itself out again when it changes. */
  val key: String get() = (if (open) "open" else "bubbles") + "|" + radius + "|" + peerLine

  private var themed: Pair<String, Map<String, Any?>>? = null

  /** The colours of the messages: the theme's (Theme.messages) in the open look; with bubbles, the bubble of one's
   *  own messages in the colour chosen in «Цвет своих сообщений», and the time and marks on it in colours that read
   *  on it (the core's `ink`, the reference's `ownBubbleInk`). */
  fun palette(bubbles: Boolean): MsgPalette {
    val palette = Theme.messages
    if (!bubbles) return palette
    val own = DevicePreferences.item("bubbleColor")
    val source = ThemeStore.look.id + "|" + (DevicePreferences.word("accentColor") ?: "") + "|" + (DevicePreferences.word("bubbleColor") ?: "")
    val fields = themed?.takeIf { it.first == source }?.second
      ?: (Core.map(Core.view("settingsTheme", listOf(ThemeStore.look.id, DevicePreferences.item("accentColor"), own)) as? Map<*, *>) ?: emptyMap()).also { themed = Pair(source, it) }
    val ink = Core.map(fields["ink"] as? Map<*, *>).orEmpty()
    return palette.copy(
      mine = ThemeLook.color(fields["bubble"] as? String) ?: palette.mine,
      theirs = ThemeLook.color(fields["incoming"] as? String) ?: palette.theirs,
      mineMeta = ThemeLook.color(ink["meta"] as? String) ?: palette.mineMeta,
      mineMark = ThemeLook.color(ink["accent"] as? String) ?: palette.mineMark,
    )
  }

  /** The plate of a message: every corner `radius`, the corner by the sender's edge small (6 at most) on the last
   *  message of a run (the reference's `borderBottomRightRadius: Math.min(6, radius)`). `d`: the density. */
  fun shape(path: Path, box: RectF, mine: Boolean, tail: Boolean, d: Float, radiusDp: Float = radius) {
    val r = minOf(radiusDp * d, box.height() / 2, box.width() / 2)
    val small = if (tail) minOf(6f * d, r) else r
    val br = if (mine) small else r
    val bl = if (mine) r else small
    path.reset()
    path.addRoundRect(box, floatArrayOf(r, r, r, r, br, br, bl, bl), Path.Direction.CW)
  }
}
