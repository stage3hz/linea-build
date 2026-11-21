package com.linea.messenger.linkpreview

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import com.linea.messenger.Demo
import com.linea.messenger.chatactions.ChatHistory
import java.io.ByteArrayOutputStream

/** Samples for the emulator's screenshot check, as the iOS simulator check has them. This file is in the debug
 *  source set: a release build is compiled with the empty `LinkDemo` of src/release instead.
 *    --ez demo true --ez chat true --es linkdemo 1          the sample chat with two more rows: an own message with a long link and its
 *                                                           card with a picture, and one from the other side with a card without a picture
 *    --ez demo true --ez chat true --es linkdemo composer   the same, and the card above the field with its cross
 *    --ez openchat true --ez linksend true                  with an account (the local test server only): the first chat of the list
 *                                                           gets a message with a prepared card, sent through the real encryption; the
 *                                                           chat then shows it as the server gave it back */
object LinkDemo {
  const val longLink = "https://journal.example.org/2026/11/kak-my-pereezzhali-v-novyj-ofis-i-nichego-ne-poteryali?utm_source=chat&page=2"
  const val shortLink = "https://docs.example.org/plan"
  private const val site = "Журнал «Пример»"
  private const val title = "Как мы переезжали в новый офис и ничего не потеряли"
  private const val about = "Сорок коробок, три этажа и один лифт. Рассказываем, как спланировать переезд команды за выходные, что подписать на каждой коробке и почему проектор лучше нести в руках."

  /** A drawn picture (no file, no network): a soft sky over hills, at the proportions sites use. */
  fun picture(): ByteArray? = try {
    val width = 480f; val height = 252f
    val bitmap = Bitmap.createBitmap(width.toInt(), height.toInt(), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, 0f, height, intArrayOf(0xFF24345E.toInt(), 0xFF8C6FB5.toInt(), 0xFFF2A97E.toInt()), floatArrayOf(0f, 0.6f, 1f), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width, height, paint)
    paint.shader = null
    paint.color = 0xFFFFE3B0.toInt()
    canvas.drawOval(330f, 96f, 394f, 160f, paint)
    listOf(0xFF3A2F5B.toInt(), 0xFF241D3E.toInt(), 0xFF130F24.toInt()).forEachIndexed { index, tone ->
      val base = 150f + index * 30f
      val hill = Path()
      hill.moveTo(0f, height)
      hill.lineTo(0f, base + 20f)
      hill.cubicTo(150f, base - 50f + index * 24f, 310f, base + 60f - index * 30f, width, base)
      hill.lineTo(width, height)
      hill.close()
      paint.color = tone
      canvas.drawPath(hill, paint)
    }
    ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 70, it) }.toByteArray()
  } catch (_: Throwable) { null }

  /** The card of the long link, made by the core exactly as for a real page. */
  fun card(): Map<String, Any?> =
    LinkCore.wire(longLink, site, title, about, picture()) ?: mapOf("url" to longLink, "site" to site, "title" to title, "description" to "")

  /** `linkdemo composer`: the card that stands above the field. */
  fun composerCard(intent: Intent?): Map<String, Any?>? = if (intent?.getStringExtra("linkdemo") == "composer") card() else null

  /** Rows for the sample chat (`MsgRow.parse`), after its own; none unless asked for. */
  fun rows(intent: Intent?): List<Map<String, Any?>> {
    if (intent?.getStringExtra("linkdemo") == null) return emptyList()
    val plain = LinkCore.wire(shortLink, "docs.example.org", "План встречи: три пункта на полчаса", "Повестка, кто что готовит и таблица с цифрами за квартал.", null)
      ?: mapOf("url" to shortLink, "site" to "docs.example.org", "title" to "План встречи: три пункта на полчаса", "description" to "")
    fun row(key: String, mine: Boolean, text: String, link: String, time: String, card: Map<String, Any?>): Map<String, Any?> {
      val at = text.indexOf(link)
      return mapOf("key" to key, "kind" to 0, "mine" to mine, "text" to text, "time" to time, "ticks" to (if (mine) 2 else 0), "tail" to true,
        "fmt" to (if (at < 0) emptyList() else listOf(64, at, link.length)), "urls" to listOf(link), "card" to card)
    }
    return listOf(
      row("link-demo-1", true, "Смотри, как у них получилось: $longLink", longLink, "09:44", card()),
      row("link-demo-2", false, "Класс! А вот наш план $shortLink", shortLink, "09:46", plain),
    )
  }

  /** `--ez linksend true` with an account on the local test server: sends one message with the prepared card to
   *  the chat that is open, through the real path (the core checks the card, encrypts it inside the message, the
   *  server takes the ciphertext). No page is fetched: the card is the sample above. */
  fun sendSample(intent: Intent?, history: ChatHistory) {
    if (intent?.getBooleanExtra("linksend", false) != true || Demo.testServer == null) return
    history.send("Смотри, как у них получилось: $longLink", null, linkPreview = card())
  }
}
