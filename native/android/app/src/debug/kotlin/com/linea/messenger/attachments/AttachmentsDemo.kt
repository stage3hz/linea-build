package com.linea.messenger.attachments

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.util.Base64
import android.view.View
import java.io.ByteArrayOutputStream

/** Sample rows with attachments and the launch arguments of the emulator check (see `Demo.start`), as the iOS
 *  simulator check has them. This file is in the debug source set: a release build is compiled with the empty
 *  `AttachmentsDemo` of src/release instead.
 *    --es attachdemo 1         with `--ez demo true --ez chat true`: sample rows with a photo, a file, a big
 *                              file and an upload on its way
 *    --es attachdemo viewer    the same, and the photo viewer with a drawn picture over them
 *    --es openattachment photo|file    with an account and `--ez openchat true`: once the chat is on screen,
 *                              opens its newest photo or file by itself */
object AttachmentsDemo {
  private var sample: String? = null
  private var wanted: String? = null
  private var done = false

  fun read(intent: Intent) {
    sample = intent.getStringExtra("attachdemo")
    wanted = intent.getStringExtra("openattachment")
    done = false
  }

  /** The sample rows to stand after the sample chat's own; none unless asked for. */
  fun rows(): List<Map<String, Any?>> {
    if (sample == null) return emptyList()
    val bytes = ByteArrayOutputStream().also { picture(240, 160).compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
    val picture = Base64.encodeToString(bytes, Base64.NO_WRAP)
    return listOf(
      mapOf("key" to "sample-attach-1", "kind" to 0, "mine" to false, "text" to "", "time" to "09:38", "tail" to false, "thumb" to picture, "thumbWide" to 1.5),
      mapOf("key" to "sample-attach-2", "kind" to 0, "mine" to false, "text" to "Договор и приложение к нему", "time" to "09:39", "tail" to false, "label" to "📎 Договор № 7.pdf\n" + FileCore.sizeText(1_258_291)),
      mapOf("key" to "sample-attach-3", "kind" to 0, "mine" to false, "text" to "", "time" to "09:39", "tail" to true, "label" to "🎬 Видео\n" + FileCore.sizeText(3_221_225_472)),
      mapOf("key" to "sample-attach-4", "kind" to 0, "mine" to true, "text" to "", "time" to "09:41", "ticks" to 3, "tail" to true, "thumb" to picture, "thumbWide" to 1.5,
        "label" to FileCore.sizeText(2_202_009) + " из " + FileCore.sizeText(5_505_024)),
    )
  }

  /** A drawn picture for the sample rows and the sample viewer (no photo of anyone). */
  fun picture(width: Int, height: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), 0xFF1F3B73.toInt(), 0xFFE0803B.toInt(), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    paint.shader = null
    paint.color = 0xD9FFFFFF.toInt()
    canvas.drawOval(width * 0.62f, height * 0.16f, width * 0.62f + height * 0.3f, height * 0.16f + height * 0.3f, paint)
    return bitmap
  }

  /** `attachdemo viewer`: the photo viewer with the drawn picture. */
  fun viewer(host: View) {
    if (sample != "viewer") return
    host.postDelayed({ if (host.isAttachedToWindow) PhotoViewer(host.context, picture(1200, 800), null).show() }, 1000)
  }

  /** `openattachment photo|file`: the chat's rows were read — its newest photo or file is opened, once. */
  fun opened(rows: List<Map<String, Any?>>, host: View, press: (String) -> Unit) {
    val wanted = wanted ?: return
    if (done) return
    for (row in rows.asReversed()) {
      val key = row["key"] as? String ?: continue
      val attachment = AttachmentStore.attachment(key) ?: continue
      val photo = FileCore.describe(attachment).kind == "photo"
      if (photo != (wanted == "photo")) continue
      done = true
      host.postDelayed({ press(key) }, 1000)
      return
    }
  }
}
