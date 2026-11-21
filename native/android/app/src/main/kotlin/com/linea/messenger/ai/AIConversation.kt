package com.linea.messenger.ai

import android.os.Handler
import android.os.Looper
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Server
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit

// The AI conversation in memory, the requests it makes, its history in the encrypted vault and the cache of
// made pictures / speech / video. Ported from mobile/src/ai/conversation.ts (class AIConversation), client.ts,
// history.ts (useAIHistory) and mediaCache.ts (iOS: AI/AIConversation.swift). Everything here lives on the
// main thread, but for the requests themselves.

/** The AI requests. Plain ones go through `Server.send` (the core gives the long AI time limits by path);
 *  the answers come back on the main thread. */
object AIClient {
  private val main: Handler by lazy { Handler(Looper.getMainLooper()) }

  private fun post(server: Server, path: String, body: Map<String, Any?>, done: (Result<Any?>) -> Unit) {
    val text = Core.text(body) ?: return done(Result.failure(AIFailure("Не удалось получить ответ. Попробуй ещё раз.")))
    server.send("POST", path, text) { result ->
      main.post { done(if (result.isSuccess) result else Result.failure(AIFailure(Server.error(result).words))) }
    }
  }

  /** What a parser made of an answer; a parser's own failure keeps its words. */
  private fun <T> read(fallback: String, parse: () -> T): Result<T> =
    try { Result.success(parse()) } catch (failure: AIFailure) { Result.failure(failure) } catch (_: Exception) { Result.failure(AIFailure(fallback)) }

  fun status(server: Server, done: (Result<AIStatus>) -> Unit) {
    server.send("GET", "/ai/status") { result ->
      main.post {
        if (result.isFailure) done(Result.failure(AIFailure(Server.error(result).words)))
        else done(read("Не удалось проверить доступность AI.") { AIModel.parseStatus(result.getOrNull()) })
      }
    }
  }

  fun models(server: Server, done: (List<String>) -> Unit) {
    server.send("GET", "/ai/models") { result -> main.post { done(if (result.isSuccess) AIModel.parseModels(result.getOrNull()) else emptyList()) } }
  }

  fun chat(server: Server, messages: List<Map<String, String>>, model: String?, images: List<String> = emptyList(), documents: List<AIDocumentText> = emptyList(), done: (Result<AIReply>) -> Unit) {
    val body = linkedMapOf<String, Any?>("messages" to messages, "consent" to true)
    if (model != null) body["model"] = model
    // AI: one picture goes as a string, several as a list (aiQuestion); the documents' text goes with every question.
    if (images.size == 1) body["image"] = images[0] else if (images.size > 1) body["image"] = images
    if (documents.isNotEmpty()) body["documents"] = documents.map { mapOf("name" to it.name, "text" to it.text) }
    post(server, "/ai/chat", body) { result ->
      if (result.isFailure) done(Result.failure(result.exceptionOrNull()!!))
      else done(read("Не удалось получить ответ. Попробуй ещё раз.") { AIModel.parseReply(result.getOrNull()) })
    }
  }

  private fun media(server: Server, path: String, body: Map<String, Any?>, kinds: Regex, done: (Result<AIMade>) -> Unit) {
    post(server, path, body) { result ->
      if (result.isFailure) done(Result.failure(result.exceptionOrNull()!!))
      else done(read("AI-сервис вернул некорректный файл.") { AIModel.parseMedia(result.getOrNull(), kinds) })
    }
  }

  /** AI: the server reads a document into text (nothing is stored there); the text then goes with the questions. */
  fun document(server: Server, name: String, data: ByteArray, done: (Result<AIDocumentText>) -> Unit) {
    post(server, "/ai/document", linkedMapOf("name" to name, "data" to android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP), "consent" to true)) { result ->
      if (result.isFailure) return@post done(Result.failure(result.exceptionOrNull()!!))
      val fields = Core.map(result.getOrNull())
      val text = fields?.get("text") as? String
      if (fields == null || text.isNullOrBlank()) return@post done(Result.failure(AIFailure("Сервер не вернул текст документа.")))
      done(Result.success(AIDocumentText(name, text, fields["truncated"] == true, (fields["pages"] as? Number)?.toInt())))
    }
  }

  fun image(server: Server, prompt: String, done: (Result<AIMade>) -> Unit) =
    media(server, "/ai/image", linkedMapOf("prompt" to prompt, "consent" to true), AIModel.imageKinds, done)

  fun speech(server: Server, text: String, voice: String, done: (Result<AIMade>) -> Unit) =
    media(server, "/ai/speech", linkedMapOf("text" to text, "voice" to voice, "consent" to true), AIModel.speechKinds, done)

  fun transcribe(server: Server, audio: ByteArray, done: (Result<String>) -> Unit) {
    post(server, "/ai/transcribe", linkedMapOf("audio" to Base64.getEncoder().encodeToString(audio), "consent" to true)) { result ->
      if (result.isFailure) return@post done(Result.failure(result.exceptionOrNull()!!))
      val text = Core.map(result.getOrNull() as? Map<*, *>)?.get("text") as? String ?: ""
      done(if (text.isBlank()) Result.failure(AIFailure("AI-сервис не вернул текст расшифровки.")) else Result.success(text))
    }
  }

  /** The most a made video may weigh; more than this is not kept. */
  private const val videoLimit = 64 * 1024 * 1024

  /** Video comes back as MP4 bytes, not JSON: it is not in the core's table of operations, so the request is
   *  made here with the session's headers from `Core.prepare` (as attachments/FileTransfer.kt does) and the
   *  app's one client: HTTPS with the system's certificate checks, no cookies, no cache, no redirects. A small
   *  signed-in request goes first: it renews the device proof when one is due. */
  fun video(server: Server, prompt: String, duration: Int, done: (Result<ByteArray>) -> Unit) {
    val finish: (Result<ByteArray>) -> Unit = { result -> main.post { done(result) } }
    Thread({
      val checked = server.sendAndWait("GET", "/ai/status")
      if (checked.isFailure) return@Thread finish(Result.failure(AIFailure(Server.error(checked).words)))
      val unreachable = AIFailure("Нет связи с сервером. Проверь интернет и адрес подключения.")
      val made = (if (server.endpoint.startsWith("https://")) Core.prepare("POST", "/ai/video", jsonBody = true, token = server.token, proof = server.currentProof) else null)
        ?: return@Thread finish(Result.failure(unreachable))
      val body = Core.text(linkedMapOf<String, Any?>("prompt" to prompt, "duration" to duration, "consent" to true)) ?: return@Thread finish(Result.failure(unreachable))
      val request = try {
        val builder = Request.Builder().url(server.endpoint + "/ai/video")
        for ((name, value) in made.headers) builder.header(name, value)
        builder.header("Accept", "video/mp4").post(body.toByteArray(Charsets.UTF_8).toRequestBody(null)).build()
      } catch (_: IllegalArgumentException) { return@Thread finish(Result.failure(unreachable)) }
      if (!request.isHttps) return@Thread finish(Result.failure(unreachable))
      try {
        Server.client.newBuilder().callTimeout(made.timeoutMs, TimeUnit.MILLISECONDS).build().newCall(request).execute().use { response ->
          val input = response.body?.byteStream()
          val ok = response.code in 200..299
          // A refusal's words are in a short JSON body; a video is taken whole, up to its limit.
          val limit = if (ok) videoLimit else 64 * 1024
          val received = ByteArrayOutputStream()
          if (input != null) {
            val chunk = ByteArray(64 * 1024)
            while (true) {
              val got = input.read(chunk)
              if (got < 0) break
              if (received.size() + got > limit) {
                if (ok) return@Thread finish(Result.failure(AIFailure("AI-сервис вернул некорректный файл.")))
                received.write(chunk, 0, limit - received.size())
                break
              }
              received.write(chunk, 0, got)
            }
          }
          if (!ok) {
            val words = Core.map(Core.read(response.code, received.toString("UTF-8"))["refused"] as? Map<*, *>)?.get("message") as? String
            return@Thread finish(Result.failure(AIFailure(words ?: "Не удалось выполнить запрос. Попробуй ещё раз.")))
          }
          val type = (response.header("Content-Type") ?: "").lowercase()
          if (!type.startsWith("video/mp4") || received.size() == 0) return@Thread finish(Result.failure(AIFailure("AI-сервис вернул некорректный файл.")))
          finish(Result.success(received.toByteArray()))
        }
      } catch (error: IOException) {
        finish(Result.failure(if (error is InterruptedIOException) AIFailure("Сервер не ответил вовремя. Проверь подключение.") else unreachable))
      }
    }, "invizent.ai.video").apply { isDaemon = true }.start()
  }
}

/** What a picture, a video, speech or a transcription came to. */
class AITaskResult(val text: String, val model: String, val routedVia: String? = null, val media: AIMedia? = null)

/** How a chat question travels: `done` is called once, on the main thread. */
typealias AITransport = (messages: List<Map<String, String>>, model: String?, images: List<String>, documents: List<AIDocumentText>, done: (Result<AIReply>) -> Unit) -> Unit
/** The work of a task: `stage` says what is going on, `done` is called once, on the main thread. */
typealias AIWork = (stage: (String) -> Unit, done: (Result<AITaskResult>) -> Unit) -> Unit

/** One conversation. Memory only; the screen owns one. `clock`: the time in ms (a test gives its own). */
class AIConversation(private val transport: AITransport, private val clock: () -> Long = System::currentTimeMillis) {
  var consent = false
    private set
  var pending = false
    private set
  var turns: List<AITurn> = emptyList()
    private set
  var error = ""
    private set
  var onChange: (() -> Unit)? = null
  /** A file was produced for a turn that is gone (cancelled, consent revoked, screen closed). */
  var discardMedia: ((AIMedia) -> Unit)? = null
  /** While on, new turns are marked private and stay out of the stored history. */
  var privateTurns = false

  private class Running(val revision: Int, val turnId: Int)

  private var revision = 0
  private var nextId = 0
  private var closed = false
  private var active: Running? = null
  private val tasks = HashMap<Int, AIWork>()

  private fun publish() { onChange?.invoke() }

  /** Changes one turn by its id. */
  private fun change(turnId: Int, edit: (AITurn) -> AITurn) { turns = turns.map { if (it.id == turnId) edit(it) else it } }

  fun setConsent(value: Boolean) {
    if (closed) return
    if (!value) cancel()
    consent = value
    error = ""
    publish()
  }

  private fun canStart(): Boolean {
    if (closed || pending) return false
    if (consent) return true
    error = "Сначала разреши отправлять вопросы внешней AI-службе."
    publish()
    return false
  }

  private fun failed(failure: Throwable): Boolean {
    error = (failure as? AIFailure)?.words ?: "Не удалось получить ответ. Попробуй ещё раз."
    publish()
    return false
  }

  fun ask(question: String, model: String?, images: List<String> = emptyList(), documents: List<AIDocumentText> = emptyList()) {
    if (!canStart()) return
    val messages = try { AIModel.historyForQuestion(turns, question) } catch (failure: AIFailure) { failed(failure); return }
    nextId += 1
    val turn = AITurn(id = nextId, question = question.trim(), status = "pending", startedAt = clock(), model = model, isPrivate = privateTurns, images = images, documents = documents)
    turns = turns + turn
    pending = true
    error = ""
    publish()
    run(turn.id, messages, model, null)
  }

  /** Picture, video, speech or transcription as a turn of the same conversation. */
  fun askTask(question: String, kind: String, work: AIWork) {
    if (!canStart()) return
    val text = question.trim()
    if (text.isEmpty()) {
      error = "Напиши, что сделать."
      publish()
      return
    }
    nextId += 1
    val turn = AITurn(id = nextId, question = text, status = "pending", startedAt = clock(), kind = kind, isPrivate = privateTurns)
    tasks[turn.id] = work
    turns = turns + turn
    pending = true
    error = ""
    publish()
    run(turn.id, emptyList(), null, work)
  }

  fun retry() {
    if (!canStart()) return
    val turn = turns.lastOrNull() ?: return
    if (turn.status != "failed" && turn.status != "cancelled") return
    // A stored picture request has no work any more: it is asked again by hand.
    if (turn.kind != null && tasks[turn.id] == null) return
    val messages = try { AIModel.historyForQuestion(turns.dropLast(1), turn.question) } catch (failure: AIFailure) { failed(failure); return }
    change(turn.id) { it.copy(status = "pending", startedAt = clock(), ms = null, error = null, stage = null) }
    pending = true
    error = ""
    publish()
    run(turn.id, messages, turn.model, if (turn.kind != null) tasks[turn.id] else null)
  }

  fun cancel() {
    val running = active ?: return
    active = null
    revision += 1
    change(running.turnId) { it.copy(status = "cancelled", error = null) }
    pending = false
    error = ""
    publish()
  }

  /** Reopens a stored conversation. Unfinished turns come back as cancelled. */
  fun restore(stored: List<AITurn>, consent: Boolean) {
    if (closed) return
    cancel()
    nextId = stored.maxOfOrNull { it.id }?.coerceAtLeast(0) ?: 0
    this.consent = consent
    pending = false
    error = ""
    // The works of the conversation that was open belong to its turns, not to these (which may bear the same numbers).
    tasks.clear()
    turns = AIModel.storedTurns(stored)
    publish()
  }

  /** Forgets media whose cache files are gone, so no broken picture is shown or stored. */
  fun dropMedia(names: List<String>) {
    if (closed || names.isEmpty()) return
    val gone = names.map { AIModel.mediaName(it) }.toSet()
    if (turns.none { it.media != null && AIModel.mediaName(it.media.uri) in gone }) return
    turns = turns.map { if (it.media != null && AIModel.mediaName(it.media.uri) in gone) it.copy(media = null) else it }
    publish()
  }

  fun clear() {
    if (closed) return
    cancel()
    pending = false
    turns = emptyList()
    error = ""
    tasks.clear()
    publish()
  }

  fun close() {
    if (closed) return
    cancel()
    closed = true
    onChange = null
  }

  private fun run(turnId: Int, messages: List<Map<String, String>>, model: String?, work: AIWork?) {
    revision += 1
    val mine = revision
    active = Running(mine, turnId)
    val current = { !closed && consent && active?.revision == mine }
    val finish: (Result<AITaskResult>, String) -> Unit = finish@{ result, provider ->
      val made = result.getOrNull()
      if (made != null) {
        // The turn is gone while the work went on: nothing shows the file any more.
        if (!current()) { made.media?.let { discardMedia?.invoke(it) }; return@finish }
        active = null
        pending = false
        error = ""
        change(turnId) { turn ->
          turn.copy(status = "complete", answer = AIReply(made.text, made.model, provider, made.routedVia), error = null, stage = null,
            media = made.media ?: turn.media, ms = turn.startedAt?.let { (clock() - it).toDouble() } ?: turn.ms)
        }
        publish()
      } else {
        if (!current()) return@finish
        val words = (result.exceptionOrNull() as? AIFailure)?.words ?: "Не удалось получить ответ. Попробуй ещё раз."
        active = null
        pending = false
        error = words
        change(turnId) { it.copy(status = "failed", error = words) }
        publish()
      }
    }
    if (work != null) {
      val stage: (String) -> Unit = { text -> if (current() && turns.any { it.id == turnId }) { change(turnId) { it.copy(stage = text) }; publish() } }
      work(stage) { result -> finish(result, "freellmapi") }
    } else {
      val asked = turns.firstOrNull { it.id == turnId }
      transport(messages, model, asked?.images.orEmpty(), asked?.documents.orEmpty()) { result ->
        val reply = result.getOrNull()
        if (reply != null) finish(Result.success(AITaskResult(reply.text, reply.model, reply.routedVia)), reply.provider)
        else finish(Result.failure(result.exceptionOrNull() ?: AIFailure("Не удалось получить ответ. Попробуй ещё раз.")), "")
      }
    }
  }
}

/** The AI chat history: kept only on this device, inside the encrypted vault (entry `ai:v1`, the reference's
 *  JSON), so this app and the previous one read each other's history. */
class AIHistory(private val crypto: CryptoService?) {
  var items: List<AIStoredConversation> = emptyList()
    private set
  var loaded = false
    private set
  var onChange: (() -> Unit)? = null

  fun load() {
    val crypto = crypto
    if (crypto == null) {
      loaded = true
      onChange?.invoke()
      return
    }
    crypto.call("loadLocal", listOf("ai:v1")) { result ->
      if (result.isSuccess) items = AIModel.parseHistory(result.getOrNull() as? String)
      loaded = true
      onChange?.invoke()
    }
  }

  private fun persist(next: List<AIStoredConversation>) {
    items = next
    onChange?.invoke()
    // The encryption service's own thread keeps the writes in order.
    crypto?.call("storeLocal", listOf("ai:v1", AIModel.historyJSON(next))) { }
  }

  fun save(id: String, turns: List<AITurn>, consent: Boolean) {
    if (!loaded) return
    val stored = AIModel.storedTurns(turns)
    val existing = items.firstOrNull { it.id == id }
    if (existing != null && existing.consent == consent && existing.turns == stored.takeLast(AILimits.storedTurns)) return
    persist(AIModel.upsert(items, id, turns, consent, AIModel.nowISO()))
  }

  fun remove(id: String) = persist(items.filter { it.id != id })

  /** For a look without an account (the debug build's samples): the list as given, nothing is written. */
  fun show(list: List<AIStoredConversation>) {
    items = list
    loaded = true
  }
}

/** Pictures, video and speech made by the AI: files of the app's own cache folder under the `linea-ai-` prefix,
 *  identified by name only. No other app can read that folder. */
object AIMediaCache {
  const val limitBytes = 150L * 1024 * 1024
  private val extensions = mapOf("image/png" to "png", "image/jpeg" to "jpg", "image/webp" to "webp", "audio/mpeg" to "mp3", "audio/wav" to "wav", "audio/ogg" to "ogg",
    "audio/flac" to "flac", "audio/mp4" to "m4a", "audio/webm" to "webm", "video/mp4" to "mp4")

  /** The app's cache folder; given by the screen (a test gives its own). */
  @Volatile var folder: File? = null

  /** Where the file is right now. */
  fun file(uri: String): File? {
    val folder = folder ?: return null
    return if (AIModel.isMediaUri(uri)) File(folder, AIModel.mediaName(uri)) else null
  }

  fun names(turns: List<AITurn>): List<String> = turns.mapNotNull { turn -> turn.media?.takeIf { AIModel.isMediaUri(it.uri) }?.let { AIModel.mediaName(it.uri) } }

  /** `linea-ai-<conversation>-<uuid>.<ext>`: the conversation's id is in the name, so orphans can be told apart. */
  fun fileName(conversationId: String, mimeType: String, uuid: String): String =
    AIModel.mediaPrefix + conversationId.map { if (it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-') it else '_' }.joinToString("").take(64) + "-" + uuid + "." + (extensions[mimeType] ?: "bin")

  /** Writes AI output to the cache and gives the file's name. */
  fun write(conversationId: String, data: ByteArray, mimeType: String): String {
    val folder = folder ?: throw AIFailure("Кэш недоступен на этом устройстве.")
    val name = fileName(conversationId, mimeType, UUID.randomUUID().toString().lowercase())
    val part = File(folder, "$name.part")
    try {
      part.outputStream().use { it.write(data) }
      if (!part.renameTo(File(folder, name))) throw IOException("rename")
    } catch (_: Exception) {
      part.delete()
      throw AIFailure("Кэш недоступен на этом устройстве.")
    }
    return name
  }

  fun delete(uris: List<String>) { for (uri in uris) file(uri)?.delete() }

  /** Media of a reopened conversation whose files are no longer on disk. */
  fun missing(turns: List<AITurn>): List<String> = names(turns).filter { name -> file(name)?.isFile != true }

  class Kept(val name: String, val size: Long, val modifiedAt: Long)

  /** Which cache files to delete. Pure: files that no stored or open conversation shows are orphans and go (once
   *  older than two minutes: a younger one may belong to a turn still being completed); then, while the rest is
   *  over the limit, the oldest go — never those of the conversation on screen (`protect`). */
  fun plan(files: List<Kept>, keep: Set<String>, protect: Set<String>, limit: Long = limitBytes, now: Long = System.currentTimeMillis()): List<String> {
    val remove = ArrayList<String>()
    val held = ArrayList<Kept>()
    for (file in files) {
      if (!file.name.startsWith(AIModel.mediaPrefix)) continue
      if (file.name in keep || file.name in protect) held.add(file)
      else if (now - file.modifiedAt >= 120_000) remove.add(file.name)
    }
    var total = held.sumOf { it.size }
    for (file in held.sortedBy { it.modifiedAt }) {
      if (total <= limit) break
      if (file.name in protect) continue
      remove.add(file.name)
      total -= file.size
    }
    return remove
  }

  /** Removes orphans and keeps the cache under the limit. Runs off the main thread. */
  fun prune(keep: List<String>, protect: List<String>) {
    val folder = folder ?: return
    val found = folder.listFiles { file -> file.isFile && file.name.startsWith(AIModel.mediaPrefix) } ?: return
    val remove = plan(found.map { Kept(it.name, it.length(), it.lastModified()) }, keep.map { AIModel.mediaName(it) }.toSet(), protect.map { AIModel.mediaName(it) }.toSet())
    for (name in remove) File(folder, name).delete()
  }
}
