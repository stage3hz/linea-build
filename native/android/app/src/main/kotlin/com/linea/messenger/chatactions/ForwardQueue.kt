package com.linea.messenger.chatactions

import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.attachments.FileTransfer
import com.linea.messenger.attachments.InlineMedia
import com.linea.messenger.chatsplus.ChatRowLooks
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Live
import com.linea.messenger.video.BigTransfer
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import java.util.concurrent.Executors

/** Stops the transfers of one copy from the main thread (the copy itself runs on a background thread). */
class ForwardStop {
  private val lock = Any()
  private var stopped = false
  private var small: FileTransfer? = null
  private var big: BigTransfer? = null

  val isCancelled: Boolean get() = synchronized(lock) { stopped }

  fun cancel() {
    val (smallNow, bigNow) = synchronized(lock) { stopped = true; small to big }
    smallNow?.cancel()
    bigNow?.cancel()
  }

  /** The transfer that runs now; one started after `cancel()` is stopped at once. */
  fun use(transfer: FileTransfer) {
    val cancelled = synchronized(lock) { small = transfer; stopped }
    if (cancelled) transfer.cancel()
  }

  fun use(transfer: BigTransfer) {
    val cancelled = synchronized(lock) { big = transfer; stopped }
    if (cancelled) transfer.cancel()
  }
}

/** The forwards on their way, for the whole app (the iPhone's Sources/ChatActions/ForwardQueue.swift; the reference
 *  keeps its uploads in a module-level store that outlives the chat screen, mobile/src/videonote/noteOutbox.ts): the
 *  moment «Отправить» is tapped each chosen chat gets a row with the attachment, a ring with the progress and ✕;
 *  leaving the chat does not stop anything. When the copy is done the message is sent (end-to-end encrypted for that
 *  chat like any other) and the row gives way to it; a failure leaves «Не отправлено · повторить» with the reason.
 *  Like the reference's uploads, the jobs live in memory only: once a message is made it is the messenger's own
 *  unsent list that keeps it across a restart. Main thread only. */
object ForwardQueue {
  /** Posted (the chat id) when a job came, went, started or failed. */
  val changed = Live.Signal<String>()
  /** Posted (the chat id) when the percent of a running job moved. */
  val progressed = Live.Signal<String>()

  private class Work(
    val messenger: Messenger?, val chatId: String, val peerId: String, val text: String,
    val attachment: Map<String, Any?>?,
    /** Whose words they are and the formatting; null for the comment of «Выбрать». */
    val meta: Map<String, Any?>?,
    /** Whose words they are; empty for the comment of «Выбрать». */
    val from: String,
  ) {
    val time = Messenger.clock(Instant.now(), ZoneId.systemDefault())
    var stop: ForwardStop? = null
  }

  private val main by lazy { Handler(Looper.getMainLooper()) }
  private val pool = Executors.newFixedThreadPool(ForwardJobs.PARALLEL) { run -> Thread(run, "invizent.forward").apply { isDaemon = true } }
  private val jobs = ForwardJobs()
  private val work = HashMap<String, Work>()

  /** The key of a job's row: it begins as the rows of outgoing attachments do, so the chat redraws it with them. */
  fun rowKey(id: String): String = "attach-$id"

  fun waiting(chatId: String): Boolean = jobs.waiting(chatId)

  /** A message on its way to `chatId`: shown at once, copied and sent in its turn. Gives the job's id. */
  fun add(messenger: Messenger?, chatId: String, peerId: String, text: String, attachment: Map<String, Any?>?, meta: Map<String, Any?>?, from: String): String {
    val id = "fwd-" + UUID.randomUUID().toString().lowercase()
    val what = if (attachment != null) ChatRowLooks.attachmentLine(attachment).first
      else ChatForward.clipped(text.split('\n', '\t').joinToString(" "), 80)
    work[id] = Work(messenger, chatId, peerId, text, attachment, meta, from)
    jobs.add(id, chatId, what)
    shine(id)
    changed.post(chatId)
    pump()
    return id
  }

  /** Starts what may start. */
  private fun pump() { for (id in jobs.startable()) run(id) }

  /** The ring of a job's row (attachments/InlineMedia.kt draws it with ✕ in the middle); none once failed. */
  private fun shine(id: String) {
    val key = rowKey(id)
    val job = jobs.job(id)
    if (job == null || job.state == ForwardJobs.State.FAILED || work[id]?.attachment == null) return InlineMedia.forgetSending(key)
    InlineMedia.showSending(key, job.progress.toFloat(), ForwardJobs.ringWords(job))
  }

  private fun run(id: String) {
    val item = work[id] ?: return
    val messenger = item.messenger ?: return
    if (!jobs.start(id)) return
    shine(id)
    changed.post(item.chatId)
    val stop = ForwardStop()
    item.stop = stop
    val original = item.attachment
    pool.execute {
      var made: Map<String, Any?>? = null
      if (original != null) {
        val copied = ChatForward.copied(original, messenger.server, stop) { fraction -> main.post { moved(id, fraction, stop) } }
        made = copied.getOrNull()
        if (made == null) {
          val words = (copied.exceptionOrNull() as? FileCore.Failure)?.words ?: "Не удалось переслать."
          main.post { failed(id, words, stop) }
          return@execute
        }
      }
      if (stop.isCancelled) return@execute
      val attachment = made
      val clientId = UUID.randomUUID().toString().lowercase()
      messenger.crypto.run({ crypto: CryptoService -> messenger.deliver(crypto, item.chatId, item.peerId, clientId, item.text, attachment, item.meta) }, { result ->
        // Without an answer the message stays among the unsent ones and goes out by itself later, with this very
        // attachment: the row has done its part either way.
        val failure = CryptoService.failure(result)
        if (result.isFailure && failure?.name != "NetworkError") failed(id, failure?.words.orEmpty().ifEmpty { "Не удалось переслать." }, stop)
        else sent(id, stop)
      })
    }
  }

  private fun moved(id: String, fraction: Double, stop: ForwardStop) {
    val item = work[id] ?: return
    if (item.stop !== stop) return
    if (jobs.progress(id, fraction)) {
      shine(id)
      progressed.post(item.chatId)
    }
  }

  private fun failed(id: String, words: String, stop: ForwardStop) {
    val item = work[id] ?: return
    if (item.stop !== stop || !jobs.fail(id, words)) return
    item.stop = null
    shine(id)
    changed.post(item.chatId)
    pump()
  }

  private fun sent(id: String, stop: ForwardStop) {
    val item = work[id] ?: return
    if (item.stop !== stop || !jobs.finish(id)) return
    work.remove(id)
    InlineMedia.forgetSending(rowKey(id))
    item.messenger?.noteChanged(item.chatId)
    changed.post(item.chatId)
    pump()
  }

  /** ✕ on a row, or «Удалить» of a failed one: the copy stops and the row goes. */
  private fun cancel(id: String) {
    val item = work[id] ?: return
    jobs.remove(id)
    item.stop?.cancel()
    item.stop = null
    work.remove(id)
    InlineMedia.forgetSending(rowKey(id))
    changed.post(item.chatId)
    pump()
  }

  /** «Повторить»: the copy is done again from the start, in its turn. */
  private fun retry(id: String) {
    val item = work[id] ?: return
    if (!jobs.retry(id)) return
    shine(id)
    changed.post(item.chatId)
    pump()
  }

  /** A row of a chat was touched. True: it was one of these (✕ stops it; a failed one offers «Повторить» and
   *  «Удалить»). */
  fun pressed(key: String, context: Context): Boolean {
    if (!key.startsWith("attach-fwd-")) return false
    val id = key.removePrefix("attach-")
    val job = jobs.job(id) ?: return false
    if (job.state != ForwardJobs.State.FAILED) {
      cancel(id)
      return true
    }
    try {
      AlertDialog.Builder(context).setMessage(job.failure)
        .setPositiveButton("Повторить отправку") { _, _ -> retry(id) }
        .setNeutralButton("Удалить") { _, _ -> cancel(id) }
        .setNegativeButton("Отмена", null)
        .show()
    } catch (_: Exception) { /* the window is gone */ }
    return true
  }

  /** The line of a chat in the list while something goes there (chatactions/ChatListActions.kt). */
  fun listLine(chatId: String): Pair<String, Int>? = jobs.listLine(chatId)

  /** The rows of the forwards on their way into a chat, to stand after its own (as the outgoing attachments do):
   *  the small picture of a photo or a video under the ring with ✕, or a file's card with the ring; a failed one
   *  says «Не отправлено · повторить» and why. */
  fun rows(chatId: String): List<Map<String, Any?>> = jobs.of(chatId).mapNotNull { job ->
    val item = work[job.id] ?: return@mapNotNull null
    val failed = job.state == ForwardJobs.State.FAILED
    val row = linkedMapOf<String, Any?>("key" to rowKey(job.id), "kind" to 0, "mine" to true, "text" to item.text, "time" to item.time,
      "ticks" to (if (failed) 4 else 3), "tail" to true)
    if (item.from.isNotEmpty()) row["forward"] = "Переслано от " + item.from
    val picture = picture(item.attachment)
    val attachment = item.attachment
    if (failed) {
      row["label"] = "Не отправлено · повторить\n" + (job.failure ?: "")
      if (picture != null) { row["thumb"] = picture.first; row["thumbWide"] = picture.second }
      else if (attachment != null && item.text.isEmpty()) row["text"] = job.what
    } else if (attachment != null) {
      val size = (attachment["size"] as? Number)?.toLong() ?: 0L
      if (picture != null) {
        row["media"] = "photo"
        row["thumb"] = picture.first
        row["thumbWide"] = picture.second
        row["mediaTime"] = if (size > 0) FileCore.sizeText(size) else ""
      } else {
        val name = if (ChatRowLooks.isVoice(attachment)) job.what else attachment["name"] as? String ?: "Файл"
        row["media"] = "file"
        row["label"] = name + "\n" + InlineMedia.sizeLine(attachment, if (size > 0) FileCore.sizeText(size) else "")
      }
    }
    row
  }

  /** The small picture that came with the attachment (checked by the core when the message was opened). */
  private fun picture(attachment: Map<String, Any?>?): Pair<String, Double>? {
    val preview = Core.map(attachment?.get("preview") as? Map<*, *>) ?: return null
    val base64 = preview["base64"] as? String ?: return null
    val width = (preview["width"] as? Number)?.toDouble() ?: return null
    val height = (preview["height"] as? Number)?.toDouble() ?: return null
    if (base64.isEmpty() || width <= 0 || height <= 0) return null
    return base64 to width / height
  }

  /** For the emulator check (src/debug `chatdemo forwardpending`): a forward shown at `progress` without an
   *  account — nothing is copied or sent. */
  fun showDemo(chatId: String, attachment: Map<String, Any?>, from: String, progress: Double) {
    val id = add(null, chatId, "", "", attachment, null, from)
    jobs.start(id)
    jobs.progress(id, progress)
    shine(id)
    changed.post(chatId)
  }
}
