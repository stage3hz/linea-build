package com.linea.messenger.chatactions

import android.graphics.Bitmap
import android.util.Base64
import com.linea.messenger.attachments.AttachmentsDemo
import java.io.ByteArrayOutputStream

/** `--ez demo true --ez chat true --es chatdemo forwardpending`: a video forwarded into the sample chat, its copy at
 *  40 % — the ring with ✕ over its small picture (chatactions/ForwardQueue.kt; the iPhone's `-chatdemo forwardpending`).
 *  Nothing is copied or sent: there is no account. */
object ForwardPendingDemo {
  private var seeded = false

  fun seed(chatId: String) {
    if (seeded || ChatActionsDemo.chatdemo != "forwardpending") return
    seeded = true
    val bytes = ByteArrayOutputStream().also { AttachmentsDemo.picture(240, 135).compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
    val picture = Base64.encodeToString(bytes, Base64.NO_WRAP)
    val attachment = mapOf<String, Any?>(
      "id" to "sample-forward-video", "name" to "video.mp4", "mimeType" to "video/mp4", "size" to 48_200_000L,
      "media" to mapOf("durationMs" to 42_000, "width" to 1920, "height" to 1080),
      "preview" to mapOf("base64" to picture, "width" to 240, "height" to 135, "mimeType" to "image/jpeg"),
    )
    ForwardQueue.showDemo(chatId, attachment, "Дмитрий Орлов", 0.4)
  }
}
