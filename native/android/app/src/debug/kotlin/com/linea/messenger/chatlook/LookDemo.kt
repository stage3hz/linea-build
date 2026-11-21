package com.linea.messenger.chatlook

import android.content.Intent
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.people.pages

/** The emulator check of the chat's look, the composer and the media (iOS: Sources/ChatLook/ChatLookDemo.swift and
 *  the launch arguments of Composer, Attachments and Video), with the sample chat (`--ez demo true --ez chat true`),
 *  no account:
 *    --es chatlook header      the glass header: «назад» with 3 unread, the name in platinum with 🌿, «в сети»,
 *                              «Позвонить» and the teal avatar on the right; the teal light on the left; the open look
 *                              with the thin teal line by the other side's words
 *    --es chatlook peek        the same, then the large avatar card with «Открыть профиль»
 *    --es chatlook bubbles     bubbles (as with «Пузыри сообщений» on), own messages in the theme's bubble colour
 *    --es chatlook wallpaper   the «Аврора» gradient wallpaper (bubbles come with it), the header's edge in its colour
 *    --es chatlook swipe       a message of the other side held half-way in a swipe to the left, the round arrow shown
 *    --es chatlook reply       the swipe done: the bar «Ответ Алиса Воронцова» above the field
 *    --es chatlook arrive      a new message of the other side slides in a moment after the chat opens
 *    --es chatlook picker      «Обои чатов» opened over the chat
 *    --es chatlook preview     the preview of «Аврора» with the sample messages, «Отмена» and «Установить»
 *    --es chatlook bubblecolor «Цвет своих сообщений»
 *    --es chatlookline offline|connecting   the status line says «ожидание сети…» / «соединение…»
 *    --es chatlookframe <id>   the sample person wears that frame (the header still shows the plain avatar)
 *  Nothing of it is kept: the next launch shows the chat as the settings say. This file is in the debug source set;
 *  a release build has the empty `LookDemo` of src/release. */
object LookDemo {
  var chatlook: String? = null
    private set
  var line: String? = null
    private set
  private var frame: String? = null
  /** Composer: `--es composerdemo silent|later|scheduled|list|emoji|format` (composer/ComposerDemo of this file). */
  var composer: String? = null
    private set

  fun read(intent: Intent) {
    chatlook = intent.getStringExtra("chatlook")
    line = intent.getStringExtra("chatlookline")
    frame = intent.getStringExtra("chatlookframe")
    composer = intent.getStringExtra("composerdemo")
  }

  /** The sample person: a calm teal, a leaf as the emoji status, Platina. */
  fun peer(name: String): Map<String, Any?> {
    val peer = linkedMapOf<String, Any?>("id" to "demo-peer", "displayName" to name, "username" to "alisa", "avatarColor" to "#2E9E8F")
    if (chatlook != null) {
      peer["statusEmoji"] = "🌿"
      peer["statusEmojiPermanent"] = true
      peer["statusEmojiExpiresAt"] = null
      peer["seal"] = "platina"
    }
    frame?.let { peer["avatarFrame"] = it }
    return peer
  }

  fun run(screen: ChatScreen) {
    val ask = chatlook ?: return
    when (ask) {
      "bubbles" -> ChatBubbleLook.demoBubbles = true
      "wallpaper" -> Wallpapers.demo = WallpaperChoice.preset("aurora")
    }
    screen.look.apply()
    screen.postDelayed({
      if (!screen.isAttachedToWindow) return@postDelayed
      val list = screen.look.listForDemo
      when (ask) {
        "peek" -> screen.look.showPeek()
        "swipe" -> list?.demoTheirs()?.let { list.demoSwipe(it.second) }
        "reply" -> list?.demoTheirs()?.let { screen.actions.demoReply(it.first) }
        "arrive" -> {
          list?.markFresh("demo-arrive")
          screen.addSampleRow(mapOf("key" to "demo-arrive", "kind" to 0, "mine" to false, "text" to "Кстати, переговорная теперь на пятом", "time" to "09:44", "tail" to true))
        }
        "picker" -> WallpaperPicker(screen.context, "00000000-0000-0000-0000-000000000000").show()
        "preview" -> WallpaperPreview(screen.context, WallpaperChoice.preset("aurora"), forChat = true).show()
        "bubblecolor" -> screen.pages()?.push(BubbleColorPage(screen.context))
      }
    }, 1200)
  }
}
