package com.linea.messenger.video

import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.TextView
import android.widget.VideoView
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.DecryptedFiles
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.design.Theme
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.net.Server
import com.linea.messenger.voice.MediaFetch
import java.io.File

/** The platform's player over the whole screen; when it is closed, the decrypted copy it played goes. */
class PlayerScreen(context: Context, private val file: File, private val onGone: () -> Unit) : Dialog(context, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {
  private val video = VideoView(context)
  private var gone = false

  init {
    val root = FrameLayout(context)
    root.setBackgroundColor(Color.BLACK)
    root.addView(video, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
    setContentView(root)
    window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    val controls = MediaController(context)
    controls.setAnchorView(video)
    video.setMediaController(controls)
    video.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
    video.setOnPreparedListener { video.start() }
    video.setOnErrorListener { _, _, _ ->
      dismiss()
      ChatAttachments.say(context, "Не удалось воспроизвести видео.")
      true
    }
    video.contentDescription = "Видео"
    setOnShowListener {
      if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
      video.setVideoURI(Uri.fromFile(file))
    }
    setOnDismissListener { finish() }
  }

  private fun finish() {
    if (gone) return
    gone = true
    try { video.stopPlayback() } catch (_: Exception) {}
    onGone()
  }
}

/** A video (or a big file of any kind) being brought and then shown: a small card with the name, how much has
 *  arrived and a way to stop; then the full-screen player — or, for a file, the app the person chooses; then the
 *  decrypted copy is deleted. As the reference does, the file is downloaded and decrypted first and played then. */
class MediaOpenController(private val host: View, private val server: Server, private val attachment: Map<String, Any?>, private val video: Boolean) : Dialog(host.context) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val progress = TextView(context)
  private val fetch = MediaFetch()
  private val fileTitle = if (video) "Видео" else attachment["name"] as? String ?: "Файл"

  init {
    requestWindowFeature(Window.FEATURE_NO_TITLE)
    val card = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16f), dp(18f), dp(16f), dp(12f))
      background = GradientDrawable().apply { setColor(Theme.surface2 or 0xFF000000.toInt()); cornerRadius = 22f * d }
    }
    val wide = LinearLayout.LayoutParams.MATCH_PARENT; val wrap = LinearLayout.LayoutParams.WRAP_CONTENT
    card.addView(TextView(context).apply {
      text = fileTitle; textSize = 15f; typeface = Theme.weight(600); setTextColor(Theme.text); gravity = Gravity.CENTER
      maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE
    }, LinearLayout.LayoutParams(wide, wrap))
    progress.text = "Загрузка…"
    progress.textSize = 13f
    progress.setTextColor(Theme.muted)
    progress.gravity = Gravity.CENTER
    card.addView(progress, LinearLayout.LayoutParams(wide, wrap).apply { topMargin = dp(6f) })
    card.addView(TextView(context).apply {
      text = "Отменить загрузку"; textSize = 15f; typeface = Theme.weight(500); setTextColor(Theme.text); gravity = Gravity.CENTER
      isClickable = true; isFocusable = true
      setOnClickListener { cancel() }
    }, LinearLayout.LayoutParams(wide, dp(44f)).apply { topMargin = dp(14f) })
    setContentView(card)
    window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(minOf(context.resources.displayMetrics.widthPixels - dp(48f), dp(320f)), WindowManager.LayoutParams.WRAP_CONTENT)
      setDimAmount(0.4f)
    }
    // Back, a touch outside the card and the button all stop the download.
    setOnCancelListener { fetch.cancel() }
    val size = (attachment["size"] as? Number)?.toLong() ?: 0L
    val whole = FileCore.sizeText(size)
    setOnShowListener {
      // Media: a film kept for watching without the network opens from the phone, nothing is downloaded.
      val kept = if (video) KeptMedia.file(context, attachment) else null
      if (kept != null) {
        dismiss()
        VideoPlayer.open(host.context, kept, null, attachment)
        return@setOnShowListener
      }
      fetch.start(context.applicationContext, server, attachment,
        progress = { part -> progress.text = FileCore.sizeText((size * part).toLong()) + " из " + whole },
        done = { result -> finished(result) })
    }
  }

  private fun finished(result: Result<MediaFetch.Brought>) {
    if (isShowing) dismiss()
    val brought = result.getOrNull() ?: return ChatAttachments.say(host.context, FileCore.words(result))
    if (!host.isAttachedToWindow) { brought.folder.deleteRecursively(); return }
    if (video) {
      // Media: the reference's own player (video/VideoPlayer.kt) — screen lock, speeds, picture in picture, keeping
      // for watching without the network, its own sheet. It removes the decrypted copy when it closes.
      VideoPlayer.open(host.context, brought.file, brought.folder, attachment)
      return
    }
    val written = DecryptedFiles.Written(brought.folder, brought.file)
    val address = DecryptedFiles.address(host.context, written)
    val view = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(address, DecryptedFiles.mimeType(written.file.name))
      // The chosen app may read this one file, and only until it is deleted.
      clipData = ClipData.newRawUri("", address)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    try {
      host.context.startActivity(Intent.createChooser(view, fileTitle).apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) })
    } catch (_: ActivityNotFoundException) {
      DecryptedFiles.remove(written.folder)
      return ChatAttachments.say(host.context, "Не удалось открыть файл.")
    }
    removeOnReturn(written)
  }

  /** The person is back in the app (the chooser was closed, or the other app left): the decrypted copy is gone.
   *  A chat that is closed in between removes it as well (as `FileOpen` does for a small file). */
  private fun removeOnReturn(written: DecryptedFiles.Written) {
    var owner: Context? = host.context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    val activity = owner as? Activity
    val app = activity?.application
    var left = false
    var done = false
    lateinit var onDetach: View.OnAttachStateChangeListener
    lateinit var onLife: Application.ActivityLifecycleCallbacks
    fun finish() {
      if (done) return
      done = true
      DecryptedFiles.remove(written.folder)
      host.removeOnAttachStateChangeListener(onDetach)
      app?.unregisterActivityLifecycleCallbacks(onLife)
    }
    onLife = object : Application.ActivityLifecycleCallbacks {
      override fun onActivityPaused(paused: Activity) { if (paused === activity) left = true }
      override fun onActivityResumed(resumed: Activity) { if (resumed === activity && left) finish() }
      override fun onActivityDestroyed(destroyed: Activity) { if (destroyed === activity) finish() }
      override fun onActivityCreated(created: Activity, state: Bundle?) {}
      override fun onActivityStarted(started: Activity) {}
      override fun onActivityStopped(stopped: Activity) {}
      override fun onActivitySaveInstanceState(saved: Activity, state: Bundle) {}
    }
    onDetach = object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) {}
      override fun onViewDetachedFromWindow(view: View) = finish()
    }
    host.addOnAttachStateChangeListener(onDetach)
    // Without a window to watch, the copy is not left lying: it goes at once.
    if (app == null) finish() else app.registerActivityLifecycleCallbacks(onLife)
  }
}
