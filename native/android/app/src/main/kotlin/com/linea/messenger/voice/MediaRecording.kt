package com.linea.messenger.voice

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.FrameLayout
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.chatlook.Haptic
import com.linea.messenger.design.GlassSource
import com.linea.messenger.music.MusicPlayer
import com.linea.messenger.video.NoteRecorder
import java.io.File

/** Recording voice and round video messages from a composer: the record button and its take (voice/RecordControl.kt),
 *  the microphone (VoiceRecorder), the stopped take waiting to be sent (VoiceDraft), the round camera (NoteRecorder in
 *  its composer-driven form). What is finally sent goes to the owner through `sendVoice` / `sendNote`, which seal
 *  and upload it as before. Permissions are asked when the button is first held; the person then holds it again.
 *  The iPhone's Sources/Voice/MediaRecording.swift. Main thread only. */
class MediaRecording(private val context: Context) {
  val control = RecordControl(context)
  private val recorder = VoiceRecorder(context)
  private val draft = VoiceDraft(context)
  private val main = Handler(Looper.getMainLooper())
  private var note: NoteRecorder? = null
  /** The parts of a stopped round video («record more» adds one), the file the circle plays, the kept part. */
  private val noteParts = ArrayList<File>()
  private var noteShown: File? = null
  private var noteTrim = Pair(0.0, 1.0)
  private var noteMs = 0L
  private val work = java.util.concurrent.Executors.newSingleThreadExecutor()
  private var host: ViewGroup? = null
  private var composer: FrameLayout? = null
  private var lastTrim = Pair(0.0, 1.0)

  /** Before a take: null when it may start, otherwise the words to say ("" to refuse silently). */
  var canStart: ((RecordControl.Mode) -> String?)? = null
  var willStart: (() -> Unit)? = null
  var say: ((String) -> Unit)? = null
  var sendVoice: ((File, Long, String?) -> Unit)? = null
  var sendNote: ((File) -> Unit)? = null
  var brokenWords = "Микрофон записал тишину — голосовое не отправлено. Запиши ещё раз."

  val isBusy: Boolean get() = recorder.isRecording || note != null || control.isBusy
  val isRecording: Boolean get() = recorder.isRecording || note != null

  fun install(composer: FrameLayout, host: ViewGroup, source: GlassSource?) {
    this.host = host
    this.composer = composer
    control.install(composer, host, source)
    control.timeWords = {
      val ms = note?.elapsedMs ?: (draft.durationMs + recorder.elapsedMs)
      FileCore.call("voiceTimeFine", listOf(ms)) as? String ?: "0:00,00"
    }
    control.onHoldStart = { mode -> if (mode == RecordControl.Mode.VOICE) startVoice() else startNote() }
    control.onFinish = { ending -> finished(ending) }
    control.onPreviewSend = { sendPreview() }
    control.onPreviewDelete = { deletePreview() }
    control.onRecordMore = { recordMore() }
    control.previewToggle = {
      val shown = note
      if (shown != null) control.setPreviewPlayback(0.0, shown.togglePlayback()) else draft.toggle()
    }
    control.previewSeek = { draft.seek(it) }
    control.previewTrim = trim@{ start, end, done ->
      val shown = note
      if (shown != null) { noteTrim = Pair(start, end); shown.setTrim(start, end, done); return@trim }
      val endMoved = Math.abs(end - lastTrim.second) > Math.abs(start - lastTrim.first)
      if (done) lastTrim = Pair(start, end)
      draft.trimmed(start, end, endMoved, done)
    }
    draft.onPlayback = { fraction, playing -> control.setPreviewPlayback(fraction, playing) }
    recorder.onPeak = { level -> control.setLevel(level) }
    recorder.onLimit = { control.end(RecordControl.Ending.SEND) }
  }

  private fun activity(): Activity? {
    var owner: Context? = context
    while (owner is ContextWrapper && owner !is Activity) owner = owner.baseContext
    return owner as? Activity
  }

  // Starting

  private fun startVoice(): Boolean {
    canStart?.invoke(RecordControl.Mode.VOICE)?.let { words -> if (words.isNotEmpty()) say?.invoke(words); return false }
    if (!VoiceRecorder.allowed(context)) {
      // The system asks; the finger has left the button by then, so the person holds it again.
      val activity = activity() ?: return false
      Permits.ask(activity, listOf(Manifest.permission.RECORD_AUDIO)) { granted -> if (!granted) say?.invoke(VoiceRecorder.noAccess) }
      return false
    }
    willStart?.invoke()
    if (MusicPlayer.shared.current != null) MusicPlayer.shared.stop()
    draft.stopPlaying()
    recorder.start()?.let { words -> say?.invoke(words); return false }
    return true
  }

  private fun startNote(): Boolean {
    canStart?.invoke(RecordControl.Mode.VIDEO)?.let { words -> if (words.isNotEmpty()) say?.invoke(words); return false }
    val activity = activity() ?: return false
    val wanted = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
    if (!wanted.all { Permits.has(context, it) }) {
      Permits.ask(activity, wanted) { granted -> if (!granted) say?.invoke(NoteRecorder.noAccess) }
      return false
    }
    val composer = composer ?: return false
    willStart?.invoke()
    val place = IntArray(2)
    composer.getLocationInWindow(place)
    val made = NoteRecorder(activity, startAtOnce = true, panelTop = maxOf(1, place[1]))
    made.onLimit = { control.end(RecordControl.Ending.SEND) }
    // Back calls the take off, as «Отмена» does.
    made.setOnCancelListener { if (note === made) control.end(RecordControl.Ending.CANCEL) }
    note = made
    try { made.show() } catch (_: Exception) { note = null; return false }
    main.post(levels)
    return true
  }

  private val levels = object : Runnable {
    override fun run() {
      val shown = note ?: return
      control.setLevel(shown.level())
      main.postDelayed(this, 25)
    }
  }

  // Ending

  private fun finished(ending: RecordControl.Ending) {
    main.removeCallbacks(levels)
    val shown = note
    if (shown != null) finishNote(shown, ending) else finishVoice(ending)
  }

  private fun checked(take: VoiceRecorder.Take): VoiceRecorder.Take? {
    if (take.durationMs < 500 && draft.isEmpty) {
      Haptic.error(control.button)
      take.file.delete()
      say?.invoke("Слишком короткое голосовое — держи запись хотя бы секунду.")
      return null
    }
    if (take.broken) {
      Haptic.error(control.button)
      take.file.delete()
      say?.invoke(brokenWords)
      return null
    }
    if (take.silent) say?.invoke("Микрофон записал тишину. Если в голосовом нет звука — запиши ещё раз.")
    return take
  }

  private fun finishVoice(ending: RecordControl.Ending) {
    when (ending) {
      RecordControl.Ending.CANCEL -> { recorder.finish(keep = false); draft.discard() }
      RecordControl.Ending.SEND -> {
        val raw = recorder.finish(keep = true) ?: return
        val take = checked(raw)
        if (take == null) { if (!draft.isEmpty) sendDraft(); return }
        if (draft.isEmpty) {
          Haptic.tap(control.button)
          sendVoice?.invoke(take.file, take.durationMs, take.waveform)
        } else {
          draft.add(take)
          sendDraft()
        }
      }
      RecordControl.Ending.PREVIEW -> {
        val raw = recorder.finish(keep = true) ?: return
        checked(raw)?.let { draft.add(it) }
        if (draft.isEmpty) return
        lastTrim = Pair(0.0, 1.0)
        control.showPreview(draft.levels, draft.durationMs, video = false)
      }
    }
  }

  private fun sendDraft() {
    draft.build { file, ms, waveform ->
      if (file == null) { say?.invoke("Не удалось подготовить голосовое. Запиши ещё раз."); return@build }
      Haptic.tap(control.button)
      sendVoice?.invoke(file, ms, waveform)
    }
  }

  private fun finishNote(shown: NoteRecorder, ending: RecordControl.Ending) {
    when (ending) {
      RecordControl.Ending.CANCEL -> {
        shown.stopTake(keep = false) { _, _ -> }
        shown.close()
        note = null
        dropNoteParts()
      }
      RecordControl.Ending.SEND -> shown.stopTake(keep = true) { file, ms ->
        shown.close()
        note = null
        if (file != null) noteParts.add(file)
        if (noteParts.isEmpty()) { if (ms in 1L..999L) Haptic.error(control.button); return@stopTake }
        sendNoteParts()
      }
      RecordControl.Ending.PREVIEW -> shown.stopTake(keep = true) { file, _ ->
        if (file != null) noteParts.add(file)
        if (noteParts.isEmpty()) {
          Haptic.error(control.button)
          shown.close()
          note = null
          return@stopTake
        }
        noteMs = shown.elapsedMs
        noteTrim = Pair(0.0, 1.0)
        val parts = ArrayList(noteParts)
        val count = control.videoFrameCount
        val side = Math.round(33f * context.resources.displayMetrics.density)
        // The circle plays the parts joined; the field shows their frames.
        work.execute {
          val joined = NoteRecorder.join(context, parts, 0.0, 1.0)
          val frames = joined?.let { NoteRecorder.frames(it, count, side) } ?: emptyList()
          main.post {
            if (note !== shown || joined == null) return@post
            if (parts.size > 1) noteShown = joined
            shown.showResult(joined)
            control.showPreview(emptyList(), noteMs, video = true)
            control.setPreviewPlayback(0.0, true)
            control.setVideoFrames(frames)
          }
        }
      }
    }
  }

  /** The parts joined and cut to the kept part go out as one round video. */
  private fun sendNoteParts() {
    val parts = ArrayList(noteParts)
    val trim = noteTrim
    noteParts.clear()
    noteTrim = Pair(0.0, 1.0)
    noteShown?.delete()
    noteShown = null
    work.execute {
      val file = NoteRecorder.join(context, parts, trim.first, trim.second)
      for (part in parts) if (part != file) part.delete()
      main.post {
        if (file == null) say?.invoke("Не удалось подготовить видеосообщение.") else sendNote?.invoke(file)
      }
    }
  }

  private fun dropNoteParts() {
    for (part in noteParts) part.delete()
    noteParts.clear()
    noteShown?.delete()
    noteShown = null
    noteTrim = Pair(0.0, 1.0)
  }

  // The preview

  private fun sendPreview() {
    val shown = note
    if (shown != null) {
      shown.close()
      note = null
      control.endPreview(deleted = false)
      sendNoteParts()
      return
    }
    control.endPreview(deleted = false)
    sendDraft()
  }

  private fun deletePreview() {
    val shown = note
    if (shown != null) {
      shown.close()
      note = null
      dropNoteParts()
    } else draft.discard()
    control.endPreview(deleted = true)
  }

  private fun recordMore() {
    val shown = note
    if (shown != null) {
      // A round video: the camera records the next part after the ones before.
      noteShown?.delete()
      noteShown = null
      noteTrim = Pair(0.0, 1.0)
      shown.resume(noteMs)
      control.resumeLocked()
      main.post(levels)
      return
    }
    if (!startVoice()) return
    control.resumeLocked()
  }

  /** The screen is left: a take is called off, a preview thrown away, the camera closed. */
  fun left() {
    main.removeCallbacks(levels)
    if (recorder.isRecording) recorder.finish(keep = false)
    note?.let { shown -> shown.stopTake(keep = false) { _, _ -> }; shown.close() }
    note = null
    dropNoteParts()
    draft.discard()
    if (control.isBusy) control.reset()
    control.detached()
  }
}
