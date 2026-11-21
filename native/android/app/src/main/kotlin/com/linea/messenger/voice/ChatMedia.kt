package com.linea.messenger.voice

import android.annotation.TargetApi
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.TextView
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.AttachmentStore
import com.linea.messenger.attachments.ChatAttachments
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileTransfer
import com.linea.messenger.attachments.Picks
import com.linea.messenger.attachments.uploadSealedFile
import com.linea.messenger.chat.MsgListView
import com.linea.messenger.chatactions.ChatScreenActions
import com.linea.messenger.chatactions.ComposerField
import com.linea.messenger.chatactions.SendButton
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.video.BigFiles
import com.linea.messenger.video.BigTransfer
import com.linea.messenger.video.ChunkCore
import com.linea.messenger.video.MediaOpenController
import com.linea.messenger.video.NotePlayback
import com.linea.messenger.video.NoteRecorder
import com.linea.messenger.video.VideoPrepare
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Executors

/** How a voice message, a video or a round video looks in the list (`MsgRow`: `media`, `wave`, `mediaTime`,
 *  `thumb`, `thumbRound`, `thumbWide`). Reference: mobile/src/MessageRow.tsx with mobile/src/voice/voice.ts
 *  (`isVoice`, `isVideoNote` — both decided by the core here, `mediaKind`). */
object MediaRows {
  fun kind(attachment: Map<String, Any?>): String = FileCore.call("mediaKind", listOf(attachment - "preview")) as? String ?: "file"

  private fun time(ms: Double): String = FileCore.call("voiceTime", listOf(ms)) as? String ?: ""

  /** The fields to put over a message's row; null for an attachment that is none of the three. */
  fun fields(attachment: Map<String, Any?>): Map<String, Any?>? = fields(attachment, kind(attachment), ::time)

  /** The same with the core's words given (so the rule can be checked without the core). */
  fun fields(attachment: Map<String, Any?>, kind: String, time: (Double) -> String): Map<String, Any?>? {
    if (kind != "voice" && kind != "note" && kind != "video") return null
    val media = Core.map(attachment["media"] as? Map<*, *>) ?: emptyMap()
    val fields = LinkedHashMap<String, Any?>()
    fields["media"] = kind
    (media["durationMs"] as? Number)?.toDouble()?.takeIf { it > 0 }?.let { fields["mediaTime"] = time(it) }
    if (kind == "voice") {
      fields["wave"] = media["waveform"] as? String ?: ""
      return fields
    }
    // The small picture was checked by the core when the message was opened (`photo::valid_preview`).
    val preview = Core.map(attachment["preview"] as? Map<*, *>)
    val picture = preview?.get("base64") as? String
    val width = (preview?.get("width") as? Number)?.toDouble(); val height = (preview?.get("height") as? Number)?.toDouble()
    val mediaWidth = (media["width"] as? Number)?.toDouble(); val mediaHeight = (media["height"] as? Number)?.toDouble()
    if (picture != null && width != null && height != null && width > 0 && height > 0) {
      fields["thumb"] = picture
      fields["thumbWide"] = if (kind == "note") 1.0 else width / height
    } else if (mediaWidth != null && mediaHeight != null && mediaWidth > 0 && mediaHeight > 0) {
      fields["thumbWide"] = if (kind == "note") 1.0 else mediaWidth / mediaHeight
    } else {
      fields["thumbWide"] = if (kind == "note") 1.0 else 1.5
    }
    if (kind == "note") fields["thumbRound"] = true
    return fields
  }

  /** One row of a voice message, a video or a round video on its way out (`MsgRow`'s fields). */
  fun pendingRow(key: String, time: String, kind: String, note: String, failed: String?, wave: String, mediaTime: String, thumb: String, wide: Double): Map<String, Any?> {
    val label = if (failed != null) "Не отправлено · повторить\n$failed" else note
    val row = linkedMapOf<String, Any?>("key" to key, "kind" to 0, "mine" to true, "text" to "", "time" to time, "ticks" to (if (failed == null) 3 else 4), "tail" to true,
      "label" to label, "media" to kind, "wave" to wave, "mediaTime" to mediaTime, "thumbWide" to wide)
    if (thumb.isNotEmpty()) row["thumb"] = thumb
    if (kind == "note") row["thumbRound"] = true
    return row
  }

  /** The words about a finished voice take that is not sent, or null (the rule alone, for the checks). */
  fun takeRefusal(durationMs: Long, broken: Boolean): String? =
    if (durationMs < 500) "Слишком короткое голосовое — держи запись хотя бы секунду."
    else if (broken) "Микрофон записал тишину — голосовое не отправлено. Запиши ещё раз."
    else null

  const val silentTake = "Микрофон записал тишину. Если в голосовом нет звука — запиши ещё раз."
  const val hintVoice = "Звук — удерживайте. Видео — нажмите."
  const val hintVideo = "Видео — удерживайте. Звук — нажмите."
}

/** Voice messages, videos and round videos of one chat: the record button of the composer, recording, getting a
 *  video ready, sealing and uploading (a big file in chunks, going on after a lost connection), the rows of what
 *  is on its way out, and playing what the messages on screen carry.
 *
 *  All three are attachments of ordinary end-to-end encrypted messages: the file's key exists only in memory and
 *  inside the encrypted message. Reference: mobile/src/ChatScreen.tsx (`finishVoice`, the record hints),
 *  mobile/src/videonote/noteSender.ts, mobile/src/e2ee/attachments.ts. */
class ChatMedia(private val host: ViewGroup, private val messenger: Messenger?, private val chatId: String, private val peerId: String) {
  /** What is sealed and sent, and how the message describes it. */
  private class Payload(
    val file: File, val name: String, val mimeType: String, val media: Map<String, Any?>, val preview: Map<String, Any?>?,
    /** Counted against the server's limit for videos (a big upload says which). */
    val video: Boolean,
  )

  /** A voice message, a video or a round video on its way out, shown as a row until the server has the message. */
  private class Outgoing(val kind: String) {
    val key = "media-" + UUID.randomUUID().toString().lowercase()
    val time = Messenger.clock(Instant.now(), ZoneId.systemDefault())
    var wave = ""
    var mediaTime = ""
    var thumb = ""
    var wide = 1.0
    var note = ""
    var failed: String? = null
    var payload: Payload? = null
    /** What the picker handed over, not yet copied into the app's own cache. */
    var picked: Uri? = null
    /** A recorded round video or a chosen video that still has to be written anew (kept for another try). */
    var source: File? = null
    var export: VideoPrepare.Job? = null
    var small: FileTransfer? = null
    val big = BigTransfer()
    var removed = false
    var percent = -1
    /** What goes with the message inside the ciphertext: the answer it is, or null. */
    var meta: Map<String, Any?>? = null
  }

  private val context: Context = host.context
  private val d = context.resources.displayMetrics.density
  private fun dp(value: Float) = Math.round(value * d)
  private val main = Handler(Looper.getMainLooper())
  private var list: MsgListView? = null
  private var field: ComposerField? = null
  private var sendButton: SendButton? = null
  private var actions: ChatScreenActions? = null
  private val control = RecordControl(context)
  private val recorder = VoiceRecorder(context)
  private val voice = VoicePlayer(context, messenger?.server)
  private var notes: NotePlayback? = null
  private var outgoing: List<Outgoing> = emptyList()
  private val toast = TextView(context)
  private var noteScreen: NoteRecorder? = null
  private var sampleRows: List<Map<String, Any?>> = emptyList()
  private var watching = false
  /** Called on the main thread when the rows of what is on its way out changed. */
  var onPendingChanged: (() -> Unit)? = null

  private val toastHide = Runnable { toast.visibility = View.GONE }
  private val hintBack = Runnable { field?.hint = "Сообщение" }
  private val watch = object : Runnable {
    override fun run() {
      if (!watching) return
      notes?.refresh()
      main.postDelayed(this, 500)
    }
  }

  // The screen

  fun install(list: MsgListView, composer: FrameLayout, field: ComposerField, send: SendButton, attachments: ChatAttachments, actions: ChatScreenActions) {
    this.list = list
    this.field = field
    this.actions = actions
    sendButton = send
    control.install(composer, host)
    val notes = NotePlayback(context, messenger?.server, list)
    this.notes = notes

    toast.textSize = 14f
    toast.setTextColor(0xFFFFFFFF.toInt())
    toast.gravity = Gravity.CENTER
    toast.background = GradientDrawable().apply { setColor(0xEB141824.toInt()); cornerRadius = 14f * d }
    toast.setPadding(dp(14f), dp(10f), dp(14f), dp(10f))
    toast.visibility = View.GONE
    toast.isClickable = false
    // The screen reader says the words when they appear.
    toast.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    host.addView(toast)

    // A touch on a row: an unsent one offers to try again; a voice message, a video or a round video plays;
    // a big file of any kind opens.
    attachments.mediaPressed = { key -> pressed(key) }
    attachments.onVideo = { pickVideo() }
    attachments.onVideoFile = { uri, meta -> takeVideoFile(uri, meta) }
    attachments.takeReply = { this.actions?.takeReply() }
    list.onMediaPress = { key, part, fraction -> partPressed(key, part, fraction) }
    list.onRowsMoved = { notes.follow() }

    voice.onState = { state -> list.setMediaState(state) }
    voice.onProblem = { words -> say(words) }
    voice.onWillPlay = { notes.quiet() }
    notes.onState = { state -> list.setMediaState(state) }
    notes.onProblem = { words -> say(words) }
    notes.onWillPlay = { voice.pause() }
    // Also while the round video recorder stands over the chat (it uses the microphone).
    notes.holdsSilence = { recorder.isRecording || voice.isPlaying || noteScreen != null }

    control.timeWords = { FileCore.call("voiceTimeFine", listOf(recorder.elapsedMs)) as? String ?: "0:00,00" }
    control.onModeChanged = { mode -> modeChanged(mode) }
    control.onHoldStart = { startVoice() }
    control.onFinish = { send -> finishVoice(send) }
    control.onPause = {
      recorder.togglePause()
      control.setPaused(recorder.isPaused)
    }
    control.onVideo = { recordNote() }
    control.onChanged = { relayout() }
    recorder.onLevel = { level -> control.setLevel(level) }
    recorder.onLimit = {
      control.reset()
      finishVoice(send = true)
    }
    val app = context.applicationContext
    sweeping.execute { VideoPrepare.sweep(app, 86_400_000L) }
    if (messenger == null) demo()
  }

  /** Places the lock and the words over the chat (after the screen placed the composer) and decides between the
   *  microphone and the send button: the microphone stands in the send button's place while there is nothing to
   *  send. `safeTop`: what the system covers at the top, px. */
  fun place(width: Int, safeTop: Int, composerLeft: Int, composerTop: Int, composerWidth: Int) {
    val field = field ?: return
    val sendButton = sendButton ?: return
    val empty = field.text.isNullOrBlank()
    val microphone = (messenger != null || MediaDemo.sample) && empty && actions?.wantsSendButton != true
    if (control.isBusy) {
      sendButton.visibility = View.INVISIBLE
    } else {
      control.setVisible(microphone)
      sendButton.visibility = if (microphone) View.INVISIBLE else View.VISIBLE
    }
    control.place(composerLeft, composerTop, composerWidth)
    if (toast.visibility == View.VISIBLE) placeToast(width, safeTop)
    lastWidth = width
    lastTop = safeTop
  }

  private var lastWidth = 0
  private var lastTop = 0

  private fun placeToast(width: Int, safeTop: Int) {
    val most = width - dp(24f)
    toast.measure(View.MeasureSpec.makeMeasureSpec(maxOf(0, most), View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val left = (width - toast.measuredWidth) / 2
    val top = safeTop + dp(64f)
    toast.layout(left, top, left + toast.measuredWidth, top + toast.measuredHeight)
  }

  private fun say(words: String) {
    toast.text = words
    toast.visibility = View.VISIBLE
    toast.bringToFront()
    placeToast(if (lastWidth > 0) lastWidth else host.width, lastTop)
    main.removeCallbacks(toastHide)
    main.postDelayed(toastHide, 2600)
  }

  private fun relayout() {
    host.requestLayout()
  }

  private fun activity(): Activity? {
    var owner: Context? = context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    return owner as? Activity
  }

  private fun hideKeyboard() {
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(host.windowToken, 0)
  }

  private fun refuse() {
    host.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
  }

  /** The chat is on screen: round videos in view start their silent loop. */
  fun appeared() {
    if (watching) return
    watching = true
    main.postDelayed(watch, 500)
  }

  /** The chat is left: whatever plays stops, a take in progress is called off, the decrypted copies go. */
  fun left() {
    watching = false
    main.removeCallbacks(watch)
    main.removeCallbacks(toastHide)
    main.removeCallbacks(hintBack)
    toast.visibility = View.GONE
    if (recorder.isRecording) recorder.finish(keep = false)
    if (control.isBusy) control.reset()
    control.detached()
    voice.left()
    notes?.left()
  }

  // Recording a voice message

  private fun modeChanged(mode: RecordControl.Mode) {
    // As the reference: the hint stands right in the field for a moment.
    field?.hint = if (mode == RecordControl.Mode.VIDEO) MediaRows.hintVideo else MediaRows.hintVoice
    main.removeCallbacks(hintBack)
    main.postDelayed(hintBack, 2200)
  }

  private fun startVoice(): Boolean {
    if (messenger == null) return false
    if (!VoiceRecorder.allowed(context)) {
      // The system asks; the finger has left the button by then, so the person holds it again.
      val activity = activity() ?: return false
      Permits.ask(activity, listOf(android.Manifest.permission.RECORD_AUDIO)) { granted -> if (!granted) say(VoiceRecorder.noAccess) }
      return false
    }
    voice.pause()
    notes?.rest()
    if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
    hideKeyboard()
    recorder.start()?.let { words ->
      say(words)
      return false
    }
    return true
  }

  private fun finishVoice(send: Boolean) {
    relayout()
    val take = recorder.finish(keep = send) ?: return
    MediaRows.takeRefusal(take.durationMs, take.broken)?.let { words ->
      refuse()
      take.file.delete()
      say(words)
      return
    }
    if (take.silent) say(MediaRows.silentTake)
    val name = FileCore.call("voiceName", listOf(System.currentTimeMillis())) as? String
    if (name == null) { take.file.delete(); return }
    val media = LinkedHashMap<String, Any?>()
    media["durationMs"] = take.durationMs
    take.waveform?.let { media["waveform"] = it }
    val item = Outgoing("voice")
    item.meta = actions?.takeReply()
    item.wave = take.waveform ?: ""
    item.mediaTime = FileCore.call("voiceTime", listOf(take.durationMs)) as? String ?: ""
    item.payload = Payload(take.file, name, "audio/mp4", media, null, video = false)
    add(item)
    run(item)
  }

  // A round video

  private fun recordNote() {
    if (messenger == null || noteScreen != null) return
    val activity = activity() ?: return
    voice.pause()
    notes?.rest()
    hideKeyboard()
    val screen = NoteRecorder(activity, startAtOnce = true)
    screen.onDone = { file ->
      val item = Outgoing("note")
      item.meta = actions?.takeReply()
      item.source = file
      add(item)
      run(item)
    }
    noteScreen = screen
    screen.setOnDismissListener { if (noteScreen === screen) noteScreen = null }
    try { screen.show() } catch (_: Exception) { noteScreen = null }
  }

  // A video from the gallery

  /** The system's picker: it runs outside the app and hands over only what was chosen, so no permission to the
   *  gallery is asked. */
  fun pickVideo() {
    if (messenger == null) return
    val activity = activity() ?: return
    val asked = Picks.ask(activity, videoPicker()) { chosen -> videosPicked(chosen.take(MAX_VIDEOS)) }
      || Picks.ask(activity, ChatAttachments.documentPicker("video/*")) { chosen -> videosPicked(chosen.take(MAX_VIDEOS)) }
    if (!asked) ChatAttachments.say(context, "Не удалось открыть галерею.")
  }

  private fun videosPicked(chosen: List<Uri>) {
    for (uri in chosen) {
      val item = Outgoing("video")
      item.meta = actions?.takeReply()
      item.picked = uri
      add(item)
      run(item)
    }
  }

  /** A video chosen in «Файл»: it is copied and written anew without its metadata, as one from the gallery.
   *  False: there is no account to send it with. */
  fun takeVideoFile(uri: Uri, meta: Map<String, Any?>?): Boolean {
    if (messenger == null) return false
    val item = Outgoing("video")
    item.meta = meta
    item.picked = uri
    add(item)
    run(item)
    return true
  }

  // On the way out

  private fun add(item: Outgoing) {
    outgoing = outgoing + item
    onPendingChanged?.invoke()
  }

  private fun fail(item: Outgoing, words: String) {
    item.failed = words
    item.small = null
    item.export = null
    onPendingChanged?.invoke()
  }

  private fun remove(item: Outgoing, forget: Boolean) {
    item.removed = true
    item.small?.cancel()
    item.export?.cancel()
    if (forget) {
      item.big.cancel()
      messenger?.let { BigFiles.forget(it.server, item.big.state) }
      item.payload?.file?.delete()
      item.source?.delete()
    }
    outgoing = outgoing.filter { it !== item }
    onPendingChanged?.invoke()
  }

  /** Gets the item ready when it is not yet (a video is written anew without its metadata), then seals,
   *  uploads and sends it. From the main thread; also «Повторить отправку». */
  private fun run(item: Outgoing) {
    val messenger = messenger ?: return
    if (item.removed) return
    item.failed = null
    if (item.payload == null) return prepare(item)
    val payload = item.payload ?: return
    val size = payload.file.length()
    val whole = FileCore.sizeText(size)
    item.percent = -1
    item.note = whole
    onPendingChanged?.invoke()
    val report: (Long, Long) -> Unit = { sent, total ->
      val percent = if (total > 0) (sent * 100 / total).toInt() else 0
      main.post {
        if (!item.removed && item.failed == null && percent != item.percent) {
          item.percent = percent
          item.note = FileCore.sizeText(size / 100 * percent) + " из " + whole
          onPendingChanged?.invoke()
        }
      }
    }
    val transfer = FileTransfer()
    transfer.onProgress = report
    item.small = transfer
    val chatId = chatId; val peerId = peerId
    // The upload and the message do not depend on this screen: a take sent just before the chat is left still
    // goes out. Only the row's looks do.
    work.execute {
      fun failed(words: String) { main.post { if (!item.removed) fail(item, words) } }
      val id: String
      val encryption: Map<String, Any?>
      if (size <= 0) return@execute failed("Не удалось прочитать файл.")
      if (size <= SMALL_LIMIT) {
        val bytes = try { payload.file.readBytes() } catch (_: Exception) { null }
        if (bytes == null || bytes.size.toLong() != size) return@execute failed("Не удалось прочитать файл.")
        // A new key, nonce and key id for every attempt: the same key never seals two uploads.
        val fresh = Core.map(FileCore.call("newEncryption")) ?: return@execute failed("Шифрование ещё не готово. Попробуй ещё раз.")
        val sealed = FileCore.seal(bytes, fresh)
        val cipher = sealed.getOrNull() ?: return@execute failed(FileCore.words(sealed))
        val uploaded = messenger.server.uploadSealedFile(cipher, transfer)
        val made = uploaded.getOrNull()
        if (made == null) {
          if (uploaded.exceptionOrNull() !is FileTransfer.Failure.Cancelled) failed(FileTransfer.words(uploaded.exceptionOrNull(), proof = "Не удалось подтвердить устройство. Попробуй ещё раз."))
          return@execute
        }
        id = made
        encryption = fresh
      } else {
        val uploaded = BigFiles.upload(messenger.server, payload.file, payload.video, item.big, progress = report)
        val done = uploaded.getOrNull()
        if (done == null) {
          if (!item.big.isCancelled) failed(FileCore.words(uploaded))
          return@execute
        }
        id = done.id
        encryption = done.encryption
      }
      val attachment = Core.map(FileCore.call("attachment", listOf(id, payload.name, payload.mimeType, size, encryption, payload.media, payload.preview)))
        ?: return@execute failed("Не удалось отправить файл.")
      main.post {
        if (item.removed) return@post
        messenger.send(chatId, peerId, "", attachment, item.meta) { result ->
          // Without an answer the message stays among the unsent ones and goes out by itself later, with this
          // very attachment: the row has done its part either way.
          val failure = CryptoService.failure(result)
          if (failure != null && failure.name != "NetworkError") return@send fail(item, failure.words)
          payload.file.delete()
          item.payload = null
          remove(item, forget = false)
          messenger.noteChanged(chatId)
        }
      }
    }
  }

  /** A video or a round video is written anew before it leaves: what the picker gave is first copied into the
   *  app's own cache, then cleaned (`VideoPrepare`). */
  private fun prepare(item: Outgoing) {
    val note = item.kind == "note"
    item.note = "Обработка…"
    onPendingChanged?.invoke()
    val job = VideoPrepare.Job()
    item.export = job
    val app = context.applicationContext
    val picked = item.picked
    val kept = item.source
    if (kept == null && picked == null) return fail(item, VideoPrepare.failed)
    copying.execute {
      // The picker's copy is read once; the app's own copy is what is worked on (and kept for another try).
      val source = kept ?: picked?.let { VideoPrepare.copy(app, app.contentResolver, it, job) }
      if (source == null) {
        main.post { if (!item.removed) fail(item, if (job.stopped) BigFiles.cancelled else VideoPrepare.failed) }
        return@execute
      }
      main.post {
        if (item.removed) { source.delete(); return@post }
        item.source = source
        item.picked = null
      }
      VideoPrepare.prepare(app, source, job) { result ->
        val noteName = FileCore.call("noteName", listOf(System.currentTimeMillis())) as? String ?: "video.mp4"
        main.post {
          item.export = null
          val prepared = result.getOrNull()
          if (item.removed) {
            prepared?.file?.delete()
            source.delete()
            return@post
          }
          if (prepared == null) return@post fail(item, FileCore.words(result))
          // The copy that was written anew is what leaves; the original copy is not kept.
          source.delete()
          item.source = null
          item.payload = Payload(prepared.file, if (note) noteName else "video.mp4", "video/mp4", prepared.media, prepared.preview, video = true)
          item.mediaTime = FileCore.call("voiceTime", listOf(prepared.durationMs)) as? String ?: ""
          val picture = prepared.preview?.get("base64") as? String
          val width = (prepared.preview?.get("width") as? Number)?.toDouble(); val height = (prepared.preview?.get("height") as? Number)?.toDouble()
          if (picture != null && width != null && height != null && height > 0) {
            item.thumb = picture
            item.wide = if (note) 1.0 else width / height
          }
          run(item)
        }
      }
    }
  }

  /** The rows of what is on its way out, to stand after the chat's own. */
  val pendingRows: List<Map<String, Any?>>
    get() = outgoing.map { item -> MediaRows.pendingRow(item.key, item.time, item.kind, item.note, item.failed, item.wave, item.mediaTime, item.thumb, item.wide) }

  /** The chat's rows were read: gives the rows to add after them. */
  @Suppress("UNUSED_PARAMETER")
  fun loaded(rows: List<Map<String, Any?>>): List<Map<String, Any?>> = pendingRows + sampleRows

  // Touches

  /** A row was touched. True: it was one of this object's (an unsent one, a voice message, a video, a round
   *  video, a big file). */
  private fun pressed(key: String): Boolean {
    val item = outgoing.firstOrNull { it.key == key }
    if (item != null) {
      val failed = item.failed ?: return true
      try {
        AlertDialog.Builder(context).setMessage(failed)
          .setPositiveButton("Повторить отправку") { _, _ -> run(item) }
          .setNeutralButton("Удалить") { _, _ -> remove(item, forget = true) }
          .setNegativeButton("Отмена", null)
          .show()
      } catch (_: Exception) { /* the window is gone */ }
      return true
    }
    val attachment = AttachmentStore.attachment(key) ?: return false
    when (MediaRows.kind(attachment)) {
      "voice" -> voice.toggle(key, attachment)
      "note" -> notes?.toggle(key, attachment)
      "video" -> open(attachment, video = true)
      else -> {
        // A big file of any other kind: brought chunk by chunk and handed to the app the person chooses.
        if (!ChunkCore.isChunked(attachment)) return false
        open(attachment, video = false)
      }
    }
    return true
  }

  private fun open(attachment: Map<String, Any?>, video: Boolean) {
    val messenger = messenger ?: return
    hideKeyboard()
    voice.pause()
    notes?.quiet()
    try { MediaOpenController(host, messenger.server, attachment, video).show() } catch (_: Exception) { /* the window is gone */ }
  }

  /** A part of a media row was touched: the play button, the waveform, the speed, the picture. */
  private fun partPressed(key: String, part: String, fraction: Float) {
    if (part == "rate") {
      say(voice.cycleRate())
      return
    }
    if (part == "wave" && voice.seek(key, fraction)) return
    pressed(key)
  }

  // The emulator check (debug builds; the release build's `MediaDemo` gives nothing)

  /** `--es voicedemo 1`: an incoming and an outgoing voice row, the first playing at 0:07 of 0:23 at 1,5×.
   *  `--es voicedemo recording`: the strip of a take being recorded. `--es videodemo 1`: a video row and a round one. */
  private fun demo() {
    val activity = activity() ?: return
    sampleRows = MediaDemo.rows(activity.intent)
    MediaDemo.state(activity.intent)?.let { state -> host.postDelayed({ list?.setMediaState(state) }, 600) }
    if (MediaDemo.recording(activity.intent)) {
      control.timeWords = { "0:04,63" }
      host.postDelayed({
        control.demoHolding()
        relayout()
      }, 600)
    }
  }

  companion object {
    private const val SMALL_LIMIT = 20L * 1024 * 1024
    private const val MAX_VIDEOS = 5
    /** One file at a time is sealed and uploaded. */
    private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.media").apply { isDaemon = true } }
    private val copying = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.media.copy").apply { isDaemon = true } }
    private val sweeping = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.media.sweep").apply { isDaemon = true } }

    /** The system's photo picker showing videos only (Android 13, and earlier phones the system update brought
     *  it to); elsewhere the system's file chooser shows videos the same way. */
    fun videoPicker(): Intent {
      val has = Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= 30 && Extensions.photoPicker())
      if (!has) return ChatAttachments.documentPicker("video/*")
      return Extensions.pickVideos(MAX_VIDEOS)
    }
  }

  @TargetApi(30)
  private object Extensions {
    fun photoPicker(): Boolean = try { SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2 } catch (_: Throwable) { false }

    @android.annotation.SuppressLint("InlinedApi")
    fun pickVideos(most: Int): Intent = Intent(MediaStore.ACTION_PICK_IMAGES).apply {
      type = "video/*"
      putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, most)
    }
  }
}
