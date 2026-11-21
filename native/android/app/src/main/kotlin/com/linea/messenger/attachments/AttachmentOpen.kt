package com.linea.messenger.attachments

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
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.widget.LinearLayout
import android.widget.TextView
import com.linea.messenger.core.Core
import com.linea.messenger.design.Theme
import com.linea.messenger.net.Server
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** The attachments of the messages on screen, by the key of their row: the list itself only knows what to draw. */
object AttachmentStore {
  private val held = HashMap<String, Map<String, Any?>>()

  @Synchronized fun remember(key: String, attachment: Map<String, Any?>) {
    // The keys of a session's messages never repeat; the map is kept from growing without end all the same.
    if (held.size > 4000) held.clear()
    held[key] = attachment
  }

  @Synchronized fun attachment(key: String): Map<String, Any?>? = held[key]
}

/** How a message with an attachment looks in the list (`MsgRow`: `thumb`, `thumbWide`, `label`). */
object AttachmentRows {
  /** The fields to put over a message's row; empty for a message without an attachment. `key`: the row's key. */
  fun fields(message: Map<String, Any?>, key: String): Map<String, Any?> = fields(message, key, { com.linea.messenger.voice.MediaRows.fields(it) }, FileCore::describe)

  /** The same with the core's word about the attachment given (so the rule can be checked without the core). */
  fun fields(message: Map<String, Any?>, key: String, describe: (Map<String, Any?>) -> FileCore.Description): Map<String, Any?> = fields(message, key, { null }, describe)

  /** Voice/Video: `media` gives the row of a voice message, a video or a round video (null: the attachment is
   *  none of them, and is shown as a photo or a file). */
  fun fields(message: Map<String, Any?>, key: String, media: (Map<String, Any?>) -> Map<String, Any?>?, describe: (Map<String, Any?>) -> FileCore.Description): Map<String, Any?> {
    val attachment = Core.map(message["attachment"] as? Map<*, *>) ?: return emptyMap()
    AttachmentStore.remember(key, attachment)
    val fields = LinkedHashMap<String, Any?>()
    // A message that is only an attachment has no words of its own.
    if ((message["text"] as? String ?: "").isEmpty()) {
      fields["text"] = ""
      fields["fmt"] = emptyList<Int>()
      fields["urls"] = emptyList<String>()
    }
    // Voice/Video: a voice message, a video and a round video have rows of their own (voice/ChatMedia.kt).
    media(attachment)?.let { return fields + it }
    val about = describe(attachment)
    val name = attachment["name"] as? String ?: "Файл"
    // The small picture was checked by the core when the message was opened (`photo::valid_preview`).
    val preview = Core.map(attachment["preview"] as? Map<*, *>)
    val picture = preview?.get("base64") as? String
    val width = (preview?.get("width") as? Number)?.toDouble(); val height = (preview?.get("height") as? Number)?.toDouble()
    if (about.kind == "photo" && about.refusal == null && picture != null && width != null && height != null && width > 0 && height > 0) {
      fields["thumb"] = picture
      fields["thumbWide"] = width / height
      return fields
    }
    val heading = if (about.kind == "photo") "🖼 Фотография" else if (about.kind == "video") "🎬 Видео" else "📎 $name"
    fields["label"] = if (about.sizeText.isEmpty()) heading else heading + "\n" + about.sizeText
    return fields
  }
}

/** Brings one attachment: downloads the sealed bytes, has the core check and open them, and hands the file over
 *  on the main thread. The decrypted bytes stay in memory; nothing is written and nothing is logged here. */
class AttachmentLoad(private val server: Server, private val attachment: Map<String, Any?>, private val cipherSize: Int) {
  private val main = Handler(Looper.getMainLooper())
  private var transfer: FileTransfer? = null
  private var cancelled = false
  private var shownPercent = -1
  /** «1.2 МБ из 3.4 МБ», on the main thread. */
  var onProgress: ((String) -> Unit)? = null

  /** A failure is a `FileCore.Failure`. Main thread. */
  fun start(done: (Result<ByteArray>) -> Unit) {
    val id = attachment["id"] as? String ?: return done(Result.failure(FileCore.Failure("Не удалось загрузить зашифрованный файл.")))
    cancelled = false
    val transfer = FileTransfer()
    this.transfer = transfer
    val size = maxOf(0, cipherSize - 16).toLong()
    val whole = FileCore.sizeText(size)
    shownPercent = -1
    transfer.onProgress = { got, all ->
      val percent = if (all > 0) (got * 100 / all).toInt() else 0
      main.post {
        if (cancelled || transfer !== this.transfer || percent == shownPercent) return@post
        shownPercent = percent
        onProgress?.invoke(FileCore.sizeText(size * percent / 100) + " из " + whole)
      }
    }
    work.execute {
      val sealed = server.downloadSealedFile(id, cipherSize, transfer)
      val result: Result<ByteArray> = sealed.fold(
        onSuccess = { bytes -> FileCore.open(bytes, attachment) },
        onFailure = { failure -> Result.failure(FileCore.Failure(FileTransfer.words(failure, proof = "Не удалось загрузить зашифрованный файл."))) },
      )
      main.post { if (!cancelled && transfer === this.transfer) done(result) }
    }
  }

  /** Stops the download; nothing more is reported. */
  fun cancel() {
    cancelled = true
    transfer?.cancel()
  }

  private companion object {
    val work = Executors.newCachedThreadPool { run -> Thread(run, "invizent.attachment").apply { isDaemon = true } }
  }
}

/** Decrypted files while another app shows them: a folder per file under the app's own private cache directory
 *  (no other app can read it; the one app the person chooses is given this one file through `DecryptedFileProvider`,
 *  to read only), removed as soon as the person is back in the chat (and swept at the next start of a chat,
 *  should the app have been stopped in between). */
object DecryptedFiles {
  const val prefix = "invizent-view-"
  /** A folder's name: the prefix and a random id. */
  val folderName = Regex("^invizent-view-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

  class Written(val folder: File, val file: File)

  /** Writes the file under its safe name; gives the folder (to remove) and the file (to show). */
  fun write(context: Context, data: ByteArray, name: String): Written? {
    val folder = File(context.cacheDir, prefix + UUID.randomUUID().toString().lowercase())
    // The core's safe name has no path in it; a name that would leave the folder is not used all the same.
    val safe = name.takeIf { it.isNotEmpty() && it != "." && it != ".." && !it.contains('/') && !it.contains('\u0000') } ?: "file"
    val file = File(folder, safe)
    return try {
      if (!folder.mkdirs()) throw IllegalStateException("folder")
      file.outputStream().use { it.write(data) }
      Written(folder, file)
    } catch (_: Exception) {
      folder.deleteRecursively()
      null
    }
  }

  fun remove(folder: File) { folder.deleteRecursively() }

  /** Removes whatever an interrupted viewing left behind. */
  fun sweep(context: Context) {
    val folders = context.cacheDir.listFiles { file -> file.name.startsWith(prefix) } ?: return
    for (folder in folders) folder.deleteRecursively()
  }

  /** The address another app is given for a written file (see `DecryptedFileProvider`). */
  fun address(context: Context, written: Written): Uri =
    Uri.Builder().scheme("content").authority(context.packageName + ".files").appendPath(written.folder.name).appendPath(written.file.name).build()

  /** The kind of a file by its name, for the system to choose the apps that can show it. */
  fun mimeType(fileName: String): String {
    val extension = fileName.substringAfterLast('.', "").lowercase()
    return (if (extension.isEmpty()) null else MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)) ?: "application/octet-stream"
  }
}

/** A file being brought and then handed to the app the person chooses (the system's own list of apps that can
 *  show it): a small card with the name, how much has arrived and a way to stop; then the chooser; then, when
 *  the person is back, the decrypted copy is deleted. */
class FileOpen(
  private val host: View,
  /** The file's name as the message gives it. */
  private val fileTitle: String,
  /** The safe name of the temporary copy. */
  private val fileName: String,
  private val loader: AttachmentLoad,
) : Dialog(host.context) {
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val progress = TextView(context)

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
    setOnCancelListener { loader.cancel() }
    loader.onProgress = { words -> progress.text = words }
    setOnShowListener { loader.start { result -> finished(result) } }
  }

  private fun finished(result: Result<ByteArray>) {
    if (isShowing) dismiss()
    val data = result.getOrNull() ?: return ChatAttachments.say(host.context, FileCore.words(result))
    if (!host.isAttachedToWindow) return
    val written = DecryptedFiles.write(host.context, data, fileName) ?: return ChatAttachments.say(host.context, "Не удалось открыть файл.")
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
   *  A chat that is closed in between removes it as well. */
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
