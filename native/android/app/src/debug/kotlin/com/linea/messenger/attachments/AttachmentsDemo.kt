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
 *    --es attachdemo 1         with `--ez demo true --ez chat true`: sample rows with a photo that is here, a photo
 *                              and a file on their way, a file to bring, a big file and an upload on its way
 *    --es attachdemo viewer    the same, and the photo viewer with a drawn picture over them
 *    --es openattachment photo|file    with an account and `--ez openchat true`: once the chat is on screen,
 *                              opens its newest photo or file by itself
 *  Media (the same names as the iPhone's launch arguments), with `--ez demo true --ez chat true`:
 *    --es attachdemo panel|panelselected|panellimited|paneldenied   the paperclip's panel with drawn tiles
 *    --es photoeditor crop|draw|size|remove|background|enhance       the photo editor on that tab, a drawn picture
 *    --es videodemo player|sheet|speed|locked|seek                   the video player over a drawn sample film
 *    --es notedemo 1                                                 the round video recorder (opened by the composer's
 *                                                                    own path: voice/ChatMedia.kt `demo`) */
object AttachmentsDemo {
  private var sample: String? = null
  private var wanted: String? = null
  private var done = false
  private var editor: String? = null
  private var video: String? = null
  private var mediaDone = false

  fun read(intent: Intent) {
    sample = intent.getStringExtra("attachdemo")
    wanted = intent.getStringExtra("openattachment")
    done = false
    editor = intent.getStringExtra("photoeditor")
    video = intent.getStringExtra("videodemo")
    mediaDone = false
  }

  /** Media: the panel opened by `attachdemo panel…` shows drawn tiles instead of the gallery. True: it does. */
  fun panelSamples(panel: AttachmentPanel): Boolean {
    val demo = sample ?: return false
    if (!demo.startsWith("panel")) return false
    panel.demoSamples(demo)
    return true
  }

  /** Media: once the chat is on screen, the editor, the player, the round video recorder or the panel, once. */
  fun media(attachments: ChatAttachments, host: View) {
    if (mediaDone) return
    val activity = host.context as? android.app.Activity ?: (host.context as? android.content.ContextWrapper)?.baseContext as? android.app.Activity ?: return
    val tool = editor
    val state = video
    val panel = sample?.takeIf { it.startsWith("panel") }
    if (tool == null && state == null && panel == null) return
    mediaDone = true
    host.postDelayed({
      if (!host.isAttachedToWindow) return@postDelayed
      when {
        tool != null -> PhotoEditor(activity, picture(1200, 800)).also { it.show(); it.demoShow(tool) }
        state != null -> {
          val folder = java.io.File(activity.cacheDir, "invizent-view-" + java.util.UUID.randomUUID().toString().lowercase())
          val file = java.io.File(folder, "sample.mp4")
          Thread {
            val made = folder.mkdirs() && SampleMovie.write(file)
            host.post {
              if (!made || !host.isAttachedToWindow) { folder.deleteRecursively(); return@post }
              com.linea.messenger.video.VideoPlayer.open(activity, file, folder, mapOf("id" to "sample-video", "encryption" to mapOf("fileKeyId" to "sample")))?.demoState(state)
            }
          }.start()
        }
        panel != null -> attachments.openPanel()
      }
    }, 1000)
  }

  /** The sample rows to stand after the sample chat's own; none unless asked for. */
  fun rows(): List<Map<String, Any?>> {
    if (sample == null) return emptyList()
    val bytes = ByteArrayOutputStream().also { picture(240, 160).compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
    val picture = Base64.encodeToString(bytes, Base64.NO_WRAP)
    // Attachments: a photo that is here, a photo and a file on their way, a file to bring (attachments/InlineMedia.kt).
    val smallBytes = ByteArrayOutputStream().also { picture(24, 16).compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
    val small = Base64.encodeToString(smallBytes, Base64.NO_WRAP)
    InlineMedia.showReady("sample-attach-1", picture(900, 600))
    InlineMedia.showLoading("sample-attach-5", 0.4f, 2_202_009, photo = true)
    InlineMedia.showLoading("sample-attach-6", 0.35f, 1_258_291, photo = false)
    InlineMedia.showSending("sample-attach-4", 0.4f, FileCore.sizeText(2_202_009) + " / " + FileCore.sizeText(5_505_024))
    return listOf(
      mapOf("key" to "sample-attach-1", "kind" to 0, "mine" to false, "text" to "", "time" to "09:38", "tail" to false, "media" to "photo", "thumb" to small, "thumbWide" to 1.5, "mediaTime" to FileCore.sizeText(184_320)),
      mapOf("key" to "sample-attach-5", "kind" to 0, "mine" to false, "text" to "", "time" to "09:38", "tail" to false, "media" to "photo", "thumb" to small, "thumbWide" to 0.75, "mediaTime" to FileCore.sizeText(2_202_009)),
      mapOf("key" to "sample-attach-2", "kind" to 0, "mine" to false, "text" to "Договор и приложение к нему", "time" to "09:39", "tail" to false, "media" to "file", "label" to "Договор № 7.pdf\n" + FileCore.sizeText(1_258_291) + " · PDF"),
      mapOf("key" to "sample-attach-6", "kind" to 0, "mine" to false, "text" to "", "time" to "09:39", "tail" to false, "media" to "file", "label" to "Смета.xlsx\n" + FileCore.sizeText(1_258_291) + " · XLSX"),
      mapOf("key" to "sample-attach-3", "kind" to 0, "mine" to false, "text" to "", "time" to "09:39", "tail" to true, "label" to "🎬 Видео\n" + FileCore.sizeText(3_221_225_472)),
      // An outgoing photo on its way: the ring with ✕ and «2,1 МБ / 5,3 МБ», as the pending rows draw it
      // (ChatAttachments.pendingRow; iOS Attachments/ChatAttachments.swift).
      mapOf("key" to "sample-attach-4", "kind" to 0, "mine" to true, "text" to "", "time" to "09:41", "ticks" to 3, "tail" to true, "media" to "photo", "thumb" to picture, "thumbWide" to 1.5,
        "mediaTime" to FileCore.sizeText(5_505_024)),
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

/** Media: a few seconds of drawn colour written as a film, for the player check (no film of anyone). */
object SampleMovie {
  fun write(file: java.io.File): Boolean {
    val width = 640; val height = 360
    var codec: android.media.MediaCodec? = null
    var muxer: android.media.MediaMuxer? = null
    var input: android.view.Surface? = null
    return try {
      val format = android.media.MediaFormat.createVideoFormat(android.media.MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
        setInteger(android.media.MediaFormat.KEY_COLOR_FORMAT, android.media.MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        setInteger(android.media.MediaFormat.KEY_BIT_RATE, 1_000_000)
        setInteger(android.media.MediaFormat.KEY_FRAME_RATE, 30)
        setInteger(android.media.MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      }
      val encoder = android.media.MediaCodec.createEncoderByType(android.media.MediaFormat.MIMETYPE_VIDEO_AVC)
      codec = encoder
      encoder.configure(format, null, null, android.media.MediaCodec.CONFIGURE_FLAG_ENCODE)
      val surface = encoder.createInputSurface()
      input = surface
      encoder.start()
      val writer = android.media.MediaMuxer(file.path, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = writer
      var track = -1
      val info = android.media.MediaCodec.BufferInfo()
      val paint = Paint(Paint.ANTI_ALIAS_FLAG)
      fun drain(end: Boolean) {
        while (true) {
          val index = encoder.dequeueOutputBuffer(info, if (end) 10_000 else 0)
          if (index == android.media.MediaCodec.INFO_TRY_AGAIN_LATER) { if (!end) return else continue }
          if (index == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = writer.addTrack(encoder.outputFormat); writer.start(); continue }
          if (index < 0) continue
          val buffer = encoder.getOutputBuffer(index)
          if (buffer != null && info.size > 0 && track >= 0 && info.flags and android.media.MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) writer.writeSampleData(track, buffer, info)
          encoder.releaseOutputBuffer(index, false)
          if (info.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
        }
      }
      for (index in 0 until 90) {
        val canvas = surface.lockHardwareCanvas()
        val t = index / 90f
        canvas.drawColor(android.graphics.Color.HSVToColor(floatArrayOf(209f + 29f * t, 0.5f, 0.45f)))
        paint.color = 0xD9FFFFFF.toInt()
        canvas.drawCircle(130f + 400f * t, 180f, 50f, paint)
        surface.unlockCanvasAndPost(canvas)
        Thread.sleep(33)
        drain(false)
      }
      encoder.signalEndOfInputStream()
      drain(true)
      true
    } catch (_: Throwable) {
      file.delete()
      false
    } finally {
      try { codec?.stop() } catch (_: Throwable) {}
      try { codec?.release() } catch (_: Throwable) {}
      input?.release()
      try { muxer?.stop() } catch (_: Throwable) {}
      try { muxer?.release() } catch (_: Throwable) {}
    }
  }
}
