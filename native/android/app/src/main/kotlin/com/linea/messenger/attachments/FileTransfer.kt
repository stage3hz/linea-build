package com.linea.messenger.attachments

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

/** One upload or download of a sealed file, with its progress. HTTPS with the system's certificate checks, no
 *  cookies, no cache, no redirects — the same client and the same rules as every other request (see `Server`).
 *  What travels here is ciphertext only; it is kept in memory and never written to disk. */
class FileTransfer {
  /** What ended a transfer without its result. */
  sealed class Failure : Exception() {
    /** The words for the person. */
    class Words(val words: String) : Failure()
    /** The server refused the session's device proof: the request may be repeated once with a fresh one. */
    object Proof : Failure()
    object Cancelled : Failure()
  }

  private val lock = Any()
  private var call: Call? = null
  private var stopped = false
  /** Bytes done and bytes in all; called on a background thread. */
  @Volatile var onProgress: ((Long, Long) -> Unit)? = null

  /** Stops the transfer; the waiting call ends as cancelled. */
  fun cancel() {
    val running = synchronized(lock) { stopped = true; call }
    running?.cancel()
  }

  private val isStopped: Boolean get() = synchronized(lock) { stopped }

  private class Answer(val status: Int, val body: ByteArray)

  /** Runs one request to its end on the calling (background) thread. `limit`: the most bytes the answer may
   *  have. `download`: the core judges the status and the announced size before a byte of the body is taken,
   *  and the progress is that of the answer. */
  private fun run(asked: Asked, limit: Int, download: Boolean): Result<Answer> {
    // The time limit is one of silence, not of the whole transfer: a big file on a slow line takes its time.
    val client = Server.client.newBuilder().readTimeout(asked.timeoutMs, TimeUnit.MILLISECONDS).writeTimeout(asked.timeoutMs, TimeUnit.MILLISECONDS).build()
    val made = client.newCall(asked.request)
    val cancelled = synchronized(lock) { if (!stopped) call = made; stopped }
    if (cancelled) return Result.failure(Failure.Cancelled)
    try {
      made.execute().use { response ->
        val status = response.code
        val body = response.body
        if (download) {
          val claimed = body?.contentLength()?.takeIf { it >= 0 }
          (FileCore.call("received", listOf(status, claimed)) as? String)?.let { return Result.failure(Failure.Words(it)) }
        }
        val received = ByteArrayOutputStream(if (download) limit else 1024)
        val input = body?.byteStream()
        if (input != null) {
          val chunk = ByteArray(64 * 1024)
          while (true) {
            val got = input.read(chunk)
            if (got < 0) break
            // More than the message's file can be: nothing of it is kept.
            if (received.size() + got > limit) return Result.failure(Failure.Words("Размер вложения не совпадает с сообщением."))
            received.write(chunk, 0, got)
            if (download) onProgress?.invoke(received.size().toLong(), maxOf(received.size(), limit).toLong())
          }
        }
        return Result.success(Answer(status, received.toByteArray()))
      }
    } catch (error: IOException) {
      if (isStopped) return Result.failure(Failure.Cancelled)
      if (error is InterruptedIOException) return Result.failure(Failure.Words("Сервер не ответил вовремя. Проверь подключение."))
      return Result.failure(Failure.Words(unreachable))
    } finally {
      synchronized(lock) { call = null }
    }
  }

  private class Asked(val request: Request, val timeoutMs: Long)

  /** The request with the session's headers from the core; null when it cannot be made (not HTTPS, no core). */
  private fun request(server: Server, method: String, path: String, contentType: String?, body: RequestBody?): Asked? {
    if (!server.base.startsWith("https://")) return null
    val made = Core.prepare(method, path, jsonBody = false, token = server.token, proof = server.currentProof) ?: return null
    return try {
      val builder = Request.Builder().url(server.base + path)
      for ((name, value) in made.headers) builder.header(name, value)
      if (contentType != null) builder.header("Content-Type", contentType)
      val request = builder.method(method, body).build()
      if (request.isHttps) Asked(request, made.timeoutMs) else null
    } catch (_: IllegalArgumentException) { null }
  }

  /** The body of an upload: `head`, the sealed bytes, `tail` — written in pieces, each reported as progress.
   *  The content type is the request's own header; the body adds none. */
  private inner class Form(val head: ByteArray, val sealed: ByteArray, val tail: ByteArray) : RequestBody() {
    override fun contentType(): MediaType? = null
    override fun contentLength(): Long = head.size.toLong() + sealed.size + tail.size
    override fun isOneShot(): Boolean = false
    override fun writeTo(sink: BufferedSink) {
      val total = contentLength()
      sink.write(head)
      var sent = 0
      while (sent < sealed.size) {
        val count = minOf(64 * 1024, sealed.size - sent)
        sink.write(sealed, sent, count)
        sent += count
        // What has reached the line, not what waits in the buffer.
        sink.flush()
        onProgress?.invoke(head.size.toLong() + sent, total)
      }
      sink.write(tail)
      onProgress?.invoke(total, total)
    }
  }

  /** `POST /e2ee/files`: one multipart part `file` with the sealed bytes. Gives the id the server keeps it under. */
  fun upload(server: Server, sealed: ByteArray): Result<String> {
    if (server.token == null) return Result.failure(Failure.Words("Нужно войти в аккаунт."))
    val form = Core.map(FileCore.call("uploadForm"))
    val head = (form?.get("head") as? String)?.toByteArray(Charsets.UTF_8); val tail = (form?.get("tail") as? String)?.toByteArray(Charsets.UTF_8)
    val contentType = form?.get("contentType") as? String
    if (head == null || tail == null || contentType == null) return Result.failure(Failure.Words(unreachable))
    val asked = request(server, "POST", "/e2ee/files", contentType, Form(head, sealed, tail)) ?: return Result.failure(Failure.Words(unreachable))
    val answer = run(asked, limit = 64 * 1024, download = false).getOrElse { return Result.failure(it) }
    return Result.runCatching { uploaded(answer.status, String(answer.body, Charsets.UTF_8)) }
  }

  /** `GET /files/<id>`: the sealed bytes of an attachment, exactly `cipherSize` of them or nothing. */
  fun download(server: Server, id: String, cipherSize: Int): Result<ByteArray> {
    if (server.token == null) return Result.failure(Failure.Words("Нужно войти в аккаунт."))
    if (!server.base.startsWith("https://")) return Result.failure(Failure.Words("Файлы загружаются только по защищённому соединению."))
    val asked = request(server, "GET", "/files/" + Messenger.pathPart(id), null, null) ?: return Result.failure(Failure.Words(unreachable))
    val answer = run(asked, limit = cipherSize, download = true).getOrElse { return Result.failure(it) }
    if (answer.status !in 200..299) return Result.failure(Failure.Words("Не удалось загрузить зашифрованный файл."))
    return Result.success(answer.body)
  }

  companion object {
    private const val unreachable = "Нет связи с сервером. Проверь интернет и адрес подключения."

    /** What the server's answer to an upload means: the id of the kept file, or a throw of a `Failure`. */
    fun uploaded(status: Int, body: String): String {
      val read = Core.read(status, body)
      val id = Core.map(read["ok"])?.get("id") as? String
      if (!id.isNullOrEmpty()) return id
      val refused = Core.map(read["refused"])
      if (refused != null) {
        if (status == 401 && refused["code"] as? String == "device_proof") throw Failure.Proof
        throw Failure.Words(refused["message"] as? String ?: "Не удалось выполнить запрос. Попробуй ещё раз.")
      }
      throw Failure.Words("Сервер недоступен.")
    }

    /** The words of a failed transfer for the person. */
    fun words(failure: Throwable?, proof: String): String = when (failure) {
      is Failure.Words -> failure.words
      is Failure.Proof -> proof
      is Failure.Cancelled -> "Загрузка отменена."
      else -> unreachable
    }
  }
}

/** Uploads a sealed file as this session. Uploads are not in the core's table of operations: the request is
 *  made here, with the session's headers from `Core.prepare`. A session bound to this device's key needs a
 *  fresh proof, and an upload cannot repeat itself: a small signed-in request goes first (it renews the
 *  proof when one is due), and an upload refused for lack of the proof is sent once more after another.
 *  Waits on the calling (background) thread. A failure is a `FileTransfer.Failure`. */
fun Server.uploadSealedFile(sealed: ByteArray, transfer: FileTransfer): Result<String> {
  val unproved = Result.failure<String>(FileTransfer.Failure.Words("Не удалось подтвердить устройство. Попробуй ещё раз."))
  for (attempt in 0 until 2) {
    val limits = sendAndWait("GET", "/e2ee/limits")
    if (limits.isFailure) {
      // The limits themselves are not needed here: only no connection or an ended session stops the upload.
      val error = Server.error(limits)
      if (!(error is ServerError.Refused && error.status != 401)) return Result.failure(FileTransfer.Failure.Words(error.words))
    }
    // The same transfer both times, so that stopping it stops whichever attempt is on its way.
    val result = transfer.upload(this, sealed)
    if (result.exceptionOrNull() is FileTransfer.Failure.Proof) { if (attempt == 0) continue else return unproved }
    return result
  }
  return unproved
}

/** Downloads the sealed bytes of an attachment as this session. A failure is a `FileTransfer.Failure`. */
fun Server.downloadSealedFile(id: String, cipherSize: Int, transfer: FileTransfer): Result<ByteArray> = transfer.download(this, id, cipherSize)
