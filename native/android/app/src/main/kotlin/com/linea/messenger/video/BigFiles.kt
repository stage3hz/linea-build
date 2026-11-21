package com.linea.messenger.video

import com.linea.messenger.app.Messenger
import com.linea.messenger.attachments.FileCore
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import okhttp3.Call
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/** Big files: the chunked scheme of the core (native/core/src/e2ee/files.rs — `seal_chunk`, `open_chunk`), the
 *  resumable upload and the ranged download around it.
 *  Reference: mobile/src/e2ee/attachments.ts (`uploadChunks`, `downloadChunked`, `limitError`, `sizeLabel`).
 *  One 4 MiB chunk is in memory at a time. What travels is ciphertext only; keys and bytes are never logged.
 *  The functions on the core's side are in native/core/src/jni.rs (`…_video_ChunkCore_…`). */
object ChunkCore {
  /** `invizent_file_seal_chunk`: the chunk's ciphertext with its tag (`ByteArray`), or the words of the refusal (`String`). */
  @JvmStatic external fun fileSealChunk(plain: ByteArray, encryptionJson: String, index: Long, size: Long): Any?

  /** `invizent_file_open_chunk`: the chunk's bytes (`ByteArray`), or the words of the refusal (`String`). */
  @JvmStatic external fun fileOpenChunk(cipher: ByteArray, attachmentJson: String, index: Long): Any?

  /** The plaintext bytes of every chunk but the last. */
  const val CHUNK = 4L * 1024 * 1024
  const val SCHEME = "aes-256-gcm-siv-chunked"

  private fun finish(answer: Any?, otherwise: String): Result<ByteArray> = when (answer) {
    is ByteArray -> Result.success(answer)
    is String -> Result.failure(FileCore.Failure(answer))
    else -> Result.failure(FileCore.Failure(otherwise))
  }

  /** Seals chunk `index` of a file of `size` bytes with the key `FileCore.call("newChunkedEncryption")` gave. */
  fun seal(plain: ByteArray, encryption: Map<String, Any?>, index: Long, size: Long): Result<ByteArray> {
    val json = (if (Core.loaded) Core.text(encryption) else null) ?: return Result.failure(FileCore.Failure("Не удалось зашифровать файл."))
    return finish(try { fileSealChunk(plain, json, index, size) } catch (_: UnsatisfiedLinkError) { null }, "Не удалось зашифровать файл.")
  }

  /** Opens chunk `index` of a downloaded file with the key of its message. */
  fun open(cipher: ByteArray, attachmentJson: String, index: Long): Result<ByteArray> {
    if (!Core.loaded) return Result.failure(FileCore.Failure("Не удалось открыть файл."))
    return finish(try { fileOpenChunk(cipher, attachmentJson, index) } catch (_: UnsatisfiedLinkError) { null }, "Не удалось открыть файл.")
  }

  /** Whether an attachment uses the chunked scheme. */
  fun isChunked(attachment: Map<String, Any?>): Boolean = Core.map(attachment["encryption"] as? Map<*, *>)?.get("scheme") as? String == SCHEME

  class Place(val start: Long, val end: Long, val plain: Int)

  /** Where chunk `index` of a file of `size` bytes stands on the server, and how long it is. */
  fun chunk(size: Long, index: Long): Place? {
    val made = Core.map(FileCore.call("chunk", listOf(size, index))) ?: return null
    val start = (made["start"] as? Number)?.toLong() ?: return null
    val end = (made["end"] as? Number)?.toLong() ?: return null
    val plain = (made["plain"] as? Number)?.toInt() ?: return null
    return Place(start, end, plain)
  }
}

/** One plain request of a big transfer, waited for on a background thread. The same client and the same rules
 *  as every other request (see `Server`): HTTPS with the system's checks, no cookies, no cache, no redirects. */
class ChunkRequest {
  class Answer(val status: Int, val body: ByteArray)

  private val lock = Any()
  private var call: Call? = null
  private var stopped = false

  fun cancel() {
    val running = synchronized(lock) { stopped = true; call }
    running?.cancel()
  }

  /** Sends the request and waits. Null: no answer (no connection, cancelled, or more bytes than `limit`). */
  fun run(server: Server, method: String, path: String, range: String?, body: ByteArray?, limit: Int): Answer? {
    if (!server.base.startsWith("https://")) return null
    val made = Core.prepare(method, path, jsonBody = false, token = server.token, proof = server.currentProof) ?: return null
    val request = try {
      val builder = Request.Builder().url(server.base + path)
      for ((name, value) in made.headers) builder.header(name, value)
      if (range != null) builder.header("Range", range)
      if (body != null) builder.header("Content-Type", "application/octet-stream")
      builder.method(method, body?.toRequestBody(null)).build()
    } catch (_: IllegalArgumentException) { return null }
    if (!request.isHttps) return null
    // The limit is one of silence, not of the whole chunk: 4 MiB on a slow line takes its time.
    val quiet = maxOf(made.timeoutMs, 120_000L)
    val client = Server.client.newBuilder().readTimeout(quiet, TimeUnit.MILLISECONDS).writeTimeout(quiet, TimeUnit.MILLISECONDS).build()
    val running = client.newCall(request)
    val cancelled = synchronized(lock) { if (!stopped) call = running; stopped }
    if (cancelled) return null
    try {
      running.execute().use { response ->
        val input = response.body?.byteStream()
        val received = java.io.ByteArrayOutputStream(minOf(limit, 64 * 1024))
        if (input != null) {
          val piece = ByteArray(64 * 1024)
          while (true) {
            val got = input.read(piece)
            if (got < 0) break
            // More than was asked for: nothing of it is kept.
            if (received.size() + got > limit) return null
            received.write(piece, 0, got)
          }
        }
        return Answer(response.code, received.toByteArray())
      }
    } catch (_: IOException) {
      return null
    } finally {
      synchronized(lock) { call = null }
    }
  }
}

/** What a big upload needs to go on after a lost connection: the same key and the server's upload id. */
class BigUploadState(val encryption: Map<String, Any?>, val sessionId: String?)

/** A big transfer that can be stopped from another thread. */
class BigTransfer {
  private val lock = Any()
  private var stopped = false
  private var request: ChunkRequest? = null
  /** The upload's state, kept for «повторить» (the main thread reads it after a failure). */
  @Volatile var state: BigUploadState? = null

  val isCancelled: Boolean get() = synchronized(lock) { stopped }

  fun cancel() {
    val running = synchronized(lock) { stopped = true; request }
    running?.cancel()
  }

  internal fun fresh(): ChunkRequest {
    val made = ChunkRequest()
    val cancelled = synchronized(lock) { request = made; stopped }
    if (cancelled) made.cancel()
    return made
  }
}

object BigFiles {
  const val cancelled = "Загрузка отменена."
  private const val platinaFile = 4L * 1024 * 1024 * 1024

  class Uploaded(val id: String, val encryption: Map<String, Any?>, val size: Long)

  /** «1.5 ГБ», «100 МБ» — as the reference's limits are worded. */
  fun sizeLabel(bytes: Long): String {
    val gib = 1024.0 * 1024.0 * 1024.0
    if (bytes >= gib) return String.format(Locale.ROOT, "%.1f", bytes / gib).replace(".0", "") + " ГБ"
    return (bytes / (1024.0 * 1024.0)).roundToLong().toString() + " МБ"
  }

  /** The words for a file the server's limits do not let through; null when it fits. */
  fun limitWords(limits: Map<String, Any?>, video: Boolean, size: Long): String? {
    val file = (limits["maxFileBytes"] as? Number)?.toLong() ?: 0L
    val most = if (video) (limits["maxVideoBytes"] as? Number)?.toLong() ?: file else file
    if (most <= 0 || (size in 1..most)) return null
    if (video) return "Видео больше " + sizeLabel(most) + "."
    val platina = limits["platina"] as? Boolean ?: false
    if (!platina && platinaFile > most) return "Файл больше " + sizeLabel(most) + ". С Platina можно отправлять файлы до " + sizeLabel(platinaFile) + "."
    return "Файл больше " + sizeLabel(most) + "."
  }

  private fun json(body: ByteArray): Map<String, Any?> = Core.map(Core.value(String(body, Charsets.UTF_8))) ?: emptyMap()

  /** What the answer to one chunk of an upload asks for next (the rule alone, for the checks). */
  enum class Step { SENT, BUSY, LOST, PROVE, REFUSED, AGAIN }

  fun step(status: Int, body: Map<String, Any?>, next: Long): Step {
    val code = body["code"] as? String ?: ""
    if (status == 200) return Step.SENT
    // The chunk got through but the reply was lost: the server already has it.
    if (status == 409 && (body["received"] as? Number)?.toLong() == next) return Step.SENT
    if (status == 409 && code == "UPLOAD_BUSY") return Step.BUSY
    if (status == 409 && code == "UPLOAD_LOST") return Step.LOST
    if (status == 401 && code == "device_proof") return Step.PROVE
    if (status in listOf(401, 403, 404, 413, 507)) return Step.REFUSED
    return Step.AGAIN
  }

  /** Encrypts and uploads a file chunk by chunk; an interrupted upload goes on from the last chunk the server
   *  confirmed (`transfer.state` keeps the key and the upload's id). Gives the server's id of the file and the
   *  encryption for the message. Runs on the calling (background) thread. `progress`: plaintext bytes sent, of all. */
  fun upload(server: Server, file: File, video: Boolean, transfer: BigTransfer, restarted: Boolean = false, progress: (Long, Long) -> Unit): Result<Uploaded> {
    fun fail(words: String): Result<Uploaded> = Result.failure(FileCore.Failure(words))
    if (server.token == null) return fail("Нужно войти в аккаунт.")
    val size = file.length()
    val plan = if (size > 0) Core.map(FileCore.call("chunks", listOf(size))) else null
    val count = (plan?.get("count") as? Number)?.toLong()
    val total = (plan?.get("cipherSize") as? Number)?.toLong()
    if (count == null || total == null) return fail("Не удалось определить размер файла.")
    // The limits are asked first; the request also renews the session's device proof when one is due.
    Core.map(server.sendAndWait("GET", "/e2ee/limits").getOrNull())?.let { limits -> limitWords(limits, video, size)?.let { return fail(it) } }

    var state = transfer.state
    var received = 0L
    val known = state?.sessionId
    if (known != null) {
      val got = (Core.map(server.sendAndWait("GET", "/e2ee/uploads/" + Messenger.pathPart(known)).getOrNull())?.get("received") as? Number)?.toLong()
      if (got != null) received = got else state = null
    }
    if (state?.sessionId == null) {
      // From the first byte: a new key — different bytes are never sealed under the same key and nonce.
      val encryption = Core.map(FileCore.call("newChunkedEncryption")) ?: return fail("Шифрование ещё не готово. Попробуй ещё раз.")
      val body = Core.text(mapOf("size" to size, "kind" to (if (video) "video" else "file"))) ?: return fail("Не удалось отправить файл.")
      val made = server.sendAndWait("POST", "/e2ee/uploads", body)
      if (made.isFailure) return fail(Server.error(made).words)
      val id = (Core.map(made.getOrNull())?.get("id") as? String)?.takeIf { it.isNotEmpty() } ?: return fail("Сервер отклонил файл.")
      state = BigUploadState(encryption, id)
      received = 0
    }
    val ready = state ?: return fail("Не удалось отправить файл.")
    val session = Messenger.pathPart(ready.sessionId ?: return fail("Не удалось отправить файл."))
    transfer.state = ready
    val handle = try { RandomAccessFile(file, "r") } catch (_: IOException) { return fail("Не удалось прочитать файл.") }
    try {
      var index = (FileCore.call("chunkAfter", listOf(received)) as? Number)?.toLong() ?: 0L
      while (index < count) {
        if (transfer.isCancelled) return fail(cancelled)
        val place = ChunkCore.chunk(size, index) ?: return fail("Не удалось определить размер файла.")
        val offset = index * ChunkCore.CHUNK
        val plain = ByteArray(place.plain)
        try {
          handle.seek(offset)
          var read = 0
          while (read < plain.size) {
            val got = handle.read(plain, read, plain.size - read)
            if (got < 0) break
            read += got
          }
          if (read != plain.size) return fail("Файл изменился во время отправки.")
        } catch (_: IOException) { return fail("Не удалось прочитать файл.") }
        val sealed = ChunkCore.seal(plain, ready.encryption, index, size).getOrElse { return Result.failure(it) }
        val next = minOf(total, place.start + sealed.size)
        var attempt = 0
        var busyFor = 0
        var sent = false
        while (!sent) {
          if (transfer.isCancelled) return fail(cancelled)
          val answer = transfer.fresh().run(server, "PUT", "/e2ee/uploads/$session?offset=${place.start}", null, sealed, 64 * 1024)
          if (transfer.isCancelled) return fail(cancelled)
          val status = answer?.status ?: 0
          val body = answer?.let { json(it.body) } ?: emptyMap()
          when (step(status, body, next)) {
            Step.SENT -> { sent = true; continue }
            // An earlier request of this upload still runs on the server: wait without spending the retries.
            Step.BUSY -> if (busyFor < 90) { sleep(5000); busyFor += 5; continue }
            // The server lost the part file: drop the session and start over once, with a new key.
            Step.LOST -> if (!restarted) {
              server.sendAndWait("DELETE", "/e2ee/uploads/$session")
              transfer.state = null
              handle.close()
              return upload(server, file, video, transfer, restarted = true, progress = progress)
            }
            // The session's device proof was refused: a small signed-in request renews it, then the chunk goes again.
            Step.PROVE -> if (attempt < 2) { server.sendAndWait("GET", "/e2ee/uploads/$session"); attempt += 1; continue }
            Step.REFUSED -> {}
            Step.AGAIN -> {}
          }
          if (status in listOf(401, 403, 404, 413, 507)) return fail(body["error"] as? String ?: body["message"] as? String ?: "Сервер отклонил файл.")
          if (attempt >= 5) return fail("Связь прервалась. Нажми «повторить» — отправка продолжится с того же места.")
          sleep((800.0 * Math.pow(2.0, attempt.toDouble())).toLong())
          attempt += 1
        }
        progress(minOf(size, offset + place.plain), size)
        index += 1
      }
    } finally {
      try { handle.close() } catch (_: IOException) {}
    }
    if (transfer.isCancelled) return fail(cancelled)
    val completed = server.sendAndWait("POST", "/e2ee/uploads/$session/complete")
    if (completed.isFailure) return fail(Server.error(completed).words)
    val done = Core.map(completed.getOrNull())
    val id = (done?.get("id") as? String)?.takeIf { it.isNotEmpty() } ?: return fail("Сервер отклонил файл.")
    if ((done["size"] as? Number)?.toLong() != total) return fail("Размер загруженного файла не совпадает.")
    transfer.state = null
    return Result.success(Uploaded(id, ready.encryption, size))
  }

  private fun sleep(ms: Long) { try { Thread.sleep(ms) } catch (_: InterruptedException) { Thread.currentThread().interrupt() } }

  /** Drops an unfinished big upload on the server. */
  fun forget(server: Server, state: BigUploadState?) {
    val session = state?.sessionId ?: return
    server.send("DELETE", "/e2ee/uploads/" + Messenger.pathPart(session)) { }
  }

  /** Downloads a chunked file by byte ranges and opens it chunk by chunk straight into `target` (a new file in
   *  the app's private cache). Nothing of a chunk is written before its own check passed — its exact size, its
   *  own nonce, its place and the number of chunks. A failure leaves no file behind.
   *  Runs on the calling (background) thread. `progress`: plaintext bytes written, of all. */
  fun download(server: Server, attachment: Map<String, Any?>, target: File, transfer: BigTransfer, progress: (Long, Long) -> Unit): Result<Unit> {
    fun fail(words: String): Result<Unit> {
      target.delete()
      return Result.failure(FileCore.Failure(words))
    }
    val bare = attachment - "preview"
    val about = Core.map(FileCore.call("chunked", listOf(bare))) ?: return fail("У вложения нет ключа сквозного шифрования.")
    (about["refusal"] as? String)?.let { return fail(it) }
    val size = (about["size"] as? Number)?.toLong(); val count = (about["count"] as? Number)?.toLong()
    val id = attachment["id"] as? String; val message = Core.text(bare)
    if (size == null || count == null || id == null || message == null) return fail("У вложения нет ключа сквозного шифрования.")
    if (server.token == null) return fail("Нужно войти в аккаунт.")
    if (!server.base.startsWith("https://")) return fail("Файлы загружаются только по защищённому соединению.")
    val name = Messenger.pathPart(id)
    if (name.isEmpty()) return fail("Файл недоступен.")
    target.delete()
    val out = try { target.outputStream() } catch (_: IOException) { return fail("Не удалось открыть файл.") }
    var written = 0L
    try {
      for (index in 0 until count) {
        val place = ChunkCore.chunk(size, index) ?: return fail("Размер вложения не совпадает с сообщением.")
        val wanted = (place.end - place.start + 1).toInt()
        var cipher: ByteArray? = null
        var attempt = 0
        while (cipher == null) {
          if (transfer.isCancelled) return fail(cancelled)
          val answer = transfer.fresh().run(server, "GET", "/files/$name", "bytes=${place.start}-${place.end}", null, wanted)
          if (transfer.isCancelled) return fail(cancelled)
          if (answer != null && (answer.status == 206 || (answer.status == 200 && count == 1L)) && answer.body.size == wanted) {
            cipher = answer.body
            continue
          }
          if (answer != null && answer.status in listOf(401, 403, 404)) return fail("Файл недоступен.")
          if (attempt >= 5) return fail("Не удалось загрузить файл. Проверь интернет и попробуй ещё раз.")
          sleep((800.0 * Math.pow(2.0, attempt.toDouble())).toLong())
          attempt += 1
        }
        val plain = ChunkCore.open(cipher, message, index).getOrElse { return fail((it as? FileCore.Failure)?.words ?: "Не удалось открыть файл.") }
        try { out.write(plain) } catch (_: IOException) { return fail("Не удалось открыть файл.") }
        written += plain.size
        progress(written, size)
      }
    } finally {
      try { out.close() } catch (_: IOException) {}
    }
    return Result.success(Unit)
  }
}
