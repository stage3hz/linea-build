package com.linea.messenger.ai

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Base64
import java.util.Locale

// The AI section's rules and forms, ported from mobile/src/ai/conversation.ts, history.ts, intent.ts and
// client.ts (iOS: AI/AIModel.swift). Lengths are counted the way the reference counts them (UTF-16 units — a
// Kotlin String's own length), so both apps agree on what fits and read each other's stored history.

object AILimits {
  const val message = 8000
  const val history = 32000
  const val count = 20
  const val answer = 16000
  const val historyMax = 60
  const val storedTurns = 40
}

/** Why something of the AI did not work: the words for the person. */
class AIFailure(val words: String) : Exception(words)

data class AIReply(val text: String, val model: String, val provider: String, val routedVia: String? = null) {
  val json: Map<String, Any?>
    get() = LinkedHashMap<String, Any?>().also { out ->
      out["text"] = text; out["model"] = model; out["provider"] = provider; out["freeOnly"] = true
      if (routedVia != null) out["routedVia"] = routedVia
    }
}

/** `uri`: the cache file's name (the stored form) or a file URI of the cache. */
data class AIMedia(val uri: String, val mimeType: String)

data class AITurn(
  val id: Int,
  val question: String,
  /** pending · complete · failed · cancelled */
  val status: String,
  val answer: AIReply? = null,
  val error: String? = null,
  /** The model chosen for this question (`options.model` of the reference), null = «Авто». */
  val model: String? = null,
  /** When the waiting began, ms. */
  val startedAt: Long? = null,
  val ms: Double? = null,
  /** image · video · speech · transcribe — a result that is not a text answer. */
  val kind: String? = null,
  val media: AIMedia? = null,
  val stage: String? = null,
  /** Asked while «Приватная беседа» was on: never written to the history. */
  val isPrivate: Boolean = false,
  /** AI: the pictures (cleaned JPEG data URLs) and documents' text sent with this question (`options.image`,
   *  `options.documents` of the reference). Memory only, for «Повторить»; never stored in the history. */
  val images: List<String> = emptyList(),
  val documents: List<AIDocumentText> = emptyList(),
)

/** A document read into text by the server (`AIDocument` of ai/client.ts). */
data class AIDocumentText(val name: String, val text: String, val truncated: Boolean = false, val pages: Int? = null)

class AICapability(val enabled: Boolean, val reason: String? = null)

class AIStatus(val configured: Boolean, val model: String, val provider: String, val platina: Boolean, val capabilities: Map<String, AICapability>) {
  val router: Boolean get() = provider == "freellmapi"
  fun can(name: String): Boolean = capabilities[name]?.enabled == true
}

data class AIStoredConversation(val id: String, val title: String, val updatedAt: String, val consent: Boolean, val turns: List<AITurn>)

/** A picture or speech as the server gave it. */
class AIMade(val mimeType: String, val data: ByteArray, val routedVia: String?)

object AIModel {
  const val codeTaskPrefix = "Помоги с задачей по коду. Подготовь код или объяснение в виде текста; запуск кода и изменение файлов не запрашиваются.\n\nЗадача пользователя:\n"

  private val modelName = Regex("^[A-Za-z0-9_./:@+-]{1,200}$")

  fun validModel(value: Any?): Boolean = value is String && modelName.matches(value)

  // Server answers

  fun parseStatus(value: Any?): AIStatus {
    val status = Core.map(value as? Map<*, *>) ?: throw AIFailure("AI-сервис вернул некорректный ответ.")
    val provider = status["provider"] as? String ?: ""
    val model = status["model"] as? String ?: ""
    val providerOk = (provider == "openrouter" && model == "openrouter/free") || (provider == "freellmapi" && validModel(model))
    if (status["configured"] !is Boolean || !providerOk || status["freeOnly"] != true) throw AIFailure("Этот сервер не подтвердил доступ к бесплатному AI.")
    val source = Core.map(status["capabilities"] as? Map<*, *>) ?: throw AIFailure("AI-сервис вернул некорректный ответ.")
    val capabilities = LinkedHashMap<String, AICapability>()
    // Newer tools are optional, so an older server simply reports them as unavailable.
    val optional = listOf("speech", "transcribe", "vision", "models", "documents")
    for (name in listOf("text", "code", "image", "video", "threeD", "social", "speech", "transcribe", "vision", "models", "documents")) {
      if (name in optional && !source.containsKey(name)) {
        capabilities[name] = AICapability(false, "Этот сервер пока не поддерживает инструмент.")
        continue
      }
      val entry = Core.map(source[name] as? Map<*, *>) ?: throw AIFailure("AI-сервис вернул некорректный ответ.")
      val enabled = entry["enabled"] as? Boolean
      if (enabled == null || (entry.containsKey("reason") && entry["reason"] !is String)) throw AIFailure("Сервер не подтвердил доступность AI-инструментов.")
      capabilities[name] = AICapability(enabled, entry["reason"] as? String)
    }
    return AIStatus(status["configured"] == true, model, provider, platina = status["platina"] != false, capabilities = capabilities)
  }

  fun parseReply(value: Any?): AIReply {
    val reply = Core.map(value as? Map<*, *>) ?: throw AIFailure("AI-сервис вернул некорректный ответ.")
    val text = reply["text"] as? String ?: ""
    val model = reply["model"] as? String ?: ""
    val provider = reply["provider"] as? String ?: ""
    if (text.isBlank() || model.isBlank() || text.length > AILimits.answer || model.length > 240 || (provider != "openrouter" && provider != "freellmapi") || reply["freeOnly"] != true) {
      throw AIFailure("AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз.")
    }
    val routed = (reply["routedVia"] as? String)?.takeIf { it.length <= 200 && it.isNotEmpty() }
    return AIReply(text, model, provider, routed)
  }

  fun parseModels(value: Any?): List<String> {
    val list = Core.map(value as? Map<*, *>)?.get("models") as? List<*> ?: return emptyList()
    return list.mapNotNull { it as? String }.filter { validModel(it) }.take(300)
  }

  /** The kinds of a made picture and of made speech that are taken. */
  val imageKinds = Regex("^image/(png|jpeg|webp)$")
  val speechKinds = Regex("^audio/[a-z0-9.+-]+$")

  private val base64Text = Regex("^[A-Za-z0-9+/]+={0,2}$")

  /** `{mimeType, base64, routedVia?}` of a picture or speech. `kinds`: the pattern of the kinds that are taken. */
  fun parseMedia(value: Any?, kinds: Regex): AIMade {
    val wrong = AIFailure("AI-сервис вернул некорректный файл.")
    val data = Core.map(value as? Map<*, *>) ?: throw wrong
    val mime = data["mimeType"] as? String ?: throw wrong
    val text = data["base64"] as? String ?: throw wrong
    if (!kinds.matches(mime) || text.isEmpty() || !base64Text.matches(text)) throw wrong
    val bytes = try { Base64.getDecoder().decode(text) } catch (_: IllegalArgumentException) { throw wrong }
    return AIMade(mime, bytes, (data["routedVia"] as? String)?.takeIf { it.length <= 200 })
  }

  // Context

  /** Only successful turns of this conversation are eligible as context. */
  fun historyForQuestion(turns: List<AITurn>, question: String): List<Map<String, String>> {
    val text = question.trim()
    if (text.isEmpty()) throw AIFailure("Напиши вопрос.")
    if (text.length > AILimits.message) throw AIFailure("Вопрос должен быть не длиннее ${AILimits.message} символов.")
    val messages = ArrayList<Map<String, String>>()
    for (turn in turns) {
      val answer = turn.answer
      if (turn.status != "complete" || answer == null) continue
      messages.add(linkedMapOf("role" to "user", "content" to turn.question))
      messages.add(linkedMapOf("role" to "assistant", "content" to answer.text))
    }
    messages.add(linkedMapOf("role" to "user", "content" to text))
    val lengths = messages.map { (it["content"] ?: "").length }
    if (messages.size > AILimits.count || lengths.any { it > AILimits.message } || lengths.sum() > AILimits.history) {
      throw AIFailure("Беседа достигла лимита контекста. Начни новую беседу — предыдущий текст не будет обрезан или отправлен частично.")
    }
    return messages
  }

  // Intent («нарисуй…», «сделай видео…», «озвучь: …»)

  private const val imageNoun = "(картин\\p{L}*|изображени\\p{L}*|рисун\\p{L}*|арт\\p{L}*|иллюстраци\\p{L}*|аватар\\p{L}*|аву|авку|логотип\\p{L}*|лого|обои|обоину|постер\\p{L}*|стикер\\p{L}*|фото\\p{L}*|пикч\\p{L}*|image|picture|art|logo|wallpaper)"
  private const val make = "(сгенериру\\p{L}*|генериру\\p{L}*|создай\\p{L}*|сделай\\p{L}*|нарисуй\\p{L}*|изобрази\\p{L}*|покажи|придумай|draw|generate|create|make)"
  private const val videoNoun = "(видео\\p{L}*|ролик\\p{L}*|клип\\p{L}*|анимаци\\p{L}*|video|clip|animation)"
  // Kotlin's IGNORE_CASE compares letters the Unicode way (Cyrillic too).
  private val speechRequest = Regex("^\\s*(озвучь|озвучи|прочитай вслух|скажи голосом|read aloud|say)(?=[\\s:,.!?]|$)\\s*:?", RegexOption.IGNORE_CASE)
  private val videoRequest = Regex("$make[^.!?\\n]{0,40}?$videoNoun", RegexOption.IGNORE_CASE)
  private val startsWithDraw = Regex("^\\s*(нарису\\p{L}*|изобрази\\p{L}*|draw|paint)(?=[\\s:,.!?]|$)", RegexOption.IGNORE_CASE)
  private val imageRequest = Regex("$make[^.!?\\n]{0,40}?$imageNoun", RegexOption.IGNORE_CASE)

  /** With a photo: a request to change it («сделай фон…», «перерисуй», «в стиле аниме»). */
  private val editRequest = Regex("(перерису\\p{L}*|переделай|отредактиру\\p{L}*|измени\\p{L}*|замени\\p{L}*|убери|добавь|сделай (из|его|её|ее|фон|в стиле|как)|в стиле|стилизу\\p{L}*|edit|restyle|make it)", RegexOption.IGNORE_CASE)

  /** text · image · video · speech */
  fun detectIntent(text: String, hasPhoto: Boolean = false): String {
    val value = text.trim()
    if (value.isEmpty()) return "text"
    if (speechRequest.containsMatchIn(value)) return "speech"
    if (videoRequest.containsMatchIn(value)) return "video"
    if (startsWithDraw.containsMatchIn(value) || imageRequest.containsMatchIn(value)) return "image"
    if (hasPhoto && editRequest.containsMatchIn(value)) return "image"
    return "text"
  }

  /** The text to speak for «озвучь: привет» → «привет». */
  fun speechText(text: String): String = speechRequest.replaceFirst(text.trim(), "").trim()

  // Media names

  const val mediaPrefix = "linea-ai-"
  private val mediaFile = Regex("^linea-ai-[A-Za-z0-9_-]+\\.[a-z0-9]{1,5}$")

  fun mediaName(uri: String): String = uri.substringAfterLast('/')

  /** Only files of the AI cache are stored and shown again: a bare name or a file: URI, never `..`, `?`, `#`. */
  fun isMediaUri(uri: String): Boolean {
    if (uri.contains('?') || uri.contains('#') || uri.contains("..")) return false
    if (!uri.startsWith("file:") && uri.contains('/')) return false
    return mediaFile.matches(mediaName(uri))
  }

  // Stored history (the reference's JSON form, vault entry `ai:v1`)

  fun storedTurns(turns: List<AITurn>): List<AITurn> = turns.filter { !it.isPrivate }.map { turn ->
    AITurn(
      id = turn.id, question = turn.question, status = if (turn.status == "pending") "cancelled" else turn.status,
      answer = turn.answer, error = turn.error?.takeIf { it.isNotEmpty() }, model = turn.model,
      ms = turn.ms?.takeIf { it.isFinite() }, kind = turn.kind,
      media = turn.media?.takeIf { isMediaUri(it.uri) }?.let { AIMedia(mediaName(it.uri), it.mimeType) },
    )
  }

  fun turnJSON(turn: AITurn): Map<String, Any?> = LinkedHashMap<String, Any?>().also { out ->
    out["id"] = turn.id; out["question"] = turn.question; out["status"] = turn.status
    turn.answer?.let { out["answer"] = it.json }
    turn.error?.let { out["error"] = it }
    turn.model?.let { out["options"] = mapOf("model" to it) }
    turn.ms?.let { out["ms"] = Math.rint(it) }
    turn.kind?.let { out["kind"] = it }
    turn.media?.let { out["media"] = linkedMapOf("uri" to it.uri, "mimeType" to it.mimeType) }
  }

  private const val safeInteger = 9_007_199_254_740_991.0
  private val storedStatus = listOf("complete", "failed", "cancelled")

  private fun turn(value: Any?): AITurn? {
    val item = Core.map(value as? Map<*, *>) ?: return null
    val number = (item["id"] as? Number)?.toDouble() ?: return null
    if (number != Math.rint(number) || Math.abs(number) > safeInteger) return null
    val question = (item["question"] as? String)?.takeIf { it.length <= AILimits.message } ?: return null
    val status = (item["status"] as? String)?.takeIf { it in storedStatus } ?: return null
    var out = AITurn(id = number.toInt(), question = question, status = status)
    if (item.containsKey("answer")) {
      val answer = Core.map(item["answer"] as? Map<*, *>) ?: return null
      val text = (answer["text"] as? String)?.takeIf { it.length <= AILimits.answer } ?: return null
      val model = answer["model"] as? String ?: return null
      out = out.copy(answer = AIReply(text, model, answer["provider"] as? String ?: "freellmapi", answer["routedVia"] as? String))
    }
    if (item.containsKey("media")) {
      val media = Core.map(item["media"] as? Map<*, *>) ?: return null
      val uri = (media["uri"] as? String)?.takeIf { it.length <= 1024 && isMediaUri(it) } ?: return null
      val mime = (media["mimeType"] as? String)?.takeIf { it.length <= 80 } ?: return null
      out = out.copy(media = AIMedia(uri, mime))
    }
    if (item.containsKey("error")) out = out.copy(error = item["error"] as? String ?: return null)
    (Core.map(item["options"] as? Map<*, *>)?.get("model") as? String)?.let { out = out.copy(model = it) }
    (item["ms"] as? Number)?.let { out = out.copy(ms = it.toDouble()) }
    (item["kind"] as? String)?.let { out = out.copy(kind = it) }
    return out
  }

  fun updated(conversation: AIStoredConversation): Instant = Messenger.date(conversation.updatedAt) ?: Instant.now()

  private val conversationId = Regex("^[A-Za-z0-9-]{8,64}$")

  fun parseHistory(raw: String?): List<AIStoredConversation> {
    val list = Core.value(raw) as? List<*> ?: return emptyList()
    val out = ArrayList<AIStoredConversation>()
    for (value in list) {
      val item = Core.map(value as? Map<*, *>) ?: continue
      val id = (item["id"] as? String)?.takeIf { conversationId.matches(it) } ?: continue
      val title = (item["title"] as? String)?.takeIf { it.length <= 120 } ?: continue
      val updatedAt = (item["updatedAt"] as? String)?.takeIf { Messenger.date(it) != null } ?: continue
      val consent = item["consent"] as? Boolean ?: continue
      val rawTurns = (item["turns"] as? List<*>)?.takeIf { it.isNotEmpty() && it.size <= 40 } ?: continue
      val turns = rawTurns.mapNotNull { turn(it) }
      if (turns.size != rawTurns.size) continue
      out.add(AIStoredConversation(id, title, updatedAt, consent, turns))
    }
    return out.sortedByDescending { it.updatedAt }.take(AILimits.historyMax)
  }

  fun historyJSON(list: List<AIStoredConversation>): String =
    Core.text(list.map { item ->
      linkedMapOf("id" to item.id, "title" to item.title, "updatedAt" to item.updatedAt, "consent" to item.consent, "turns" to item.turns.map { turnJSON(it) })
    }) ?: "[]"

  private val codeTaskHead = Regex("^Помоги с задачей по коду\\.[\\s\\S]*?Задача пользователя:\\n")

  fun conversationTitle(turns: List<AITurn>): String {
    val first = (turns.firstOrNull()?.question ?: "").replaceFirst(codeTaskHead, "").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { "Беседа" }
    return if (first.length > 60) first.substring(0, 59) + "…" else first
  }

  /** Inserts or replaces a conversation, newest first. Empty (or fully private) conversations are not stored. */
  fun upsert(list: List<AIStoredConversation>, id: String, turns: List<AITurn>, consent: Boolean, now: String): List<AIStoredConversation> {
    val rest = list.filter { it.id != id }
    val stored = storedTurns(turns)
    if (stored.isEmpty()) return rest
    val entry = AIStoredConversation(id, conversationTitle(stored), now, consent, stored.takeLast(AILimits.storedTurns))
    return (listOf(entry) + rest).take(AILimits.historyMax)
  }

  /** `2026-11-21T07:00:00.000Z`: the moment as the reference writes it (`toISOString`). */
  fun nowISO(now: Instant = Instant.now()): String = DateTimeFormatter.ISO_INSTANT.format(now.truncatedTo(ChronoUnit.MILLIS)).let { text ->
    // ISO_INSTANT leaves the fraction out when it is zero; the reference always writes three digits.
    if (text.contains('.')) text else text.dropLast(1) + ".000Z"
  }

  private val modelNames = mapOf("auto" to "Авто", "auto:smart" to "Умная", "auto:fast" to "Быстрая", "auto:reliable" to "Надёжная", "auto:balanced" to "Сбалансированная", "fusion" to "Консилиум")

  fun modelLabel(id: String): String = modelNames[id] ?: id.substringAfterLast('/').ifEmpty { id }

  /** The ways of choosing a model, each with a line about it. */
  val strategies: List<Pair<String, String>> = listOf(
    "auto:smart" to "Для сложных вопросов и кода. Отвечает дольше",
    "auto" to "Сама выбирает свободную модель",
    "auto:fast" to "Быстрые ответы на простые вопросы",
    "auto:reliable" to "Модели, которые реже бывают заняты",
    "fusion" to "Отвечают несколько моделей, выбирается лучший ответ",
  )

  // Words of the page: plain functions, so they can be checked without a phone.

  /** «вопрос / вопроса / вопросов» as the history's list counts them. */
  fun questionsNoun(count: Int): String = if (count == 1) "вопрос" else if (count < 5) "вопроса" else "вопросов"

  private val shortDay = DateTimeFormatter.ofPattern("d MMM", Locale("ru", "RU"))

  /** When a conversation of the history was last changed: the clock today, «вчера», else the day. */
  fun listTime(moment: Instant, now: Instant, zone: ZoneId): String {
    val day = moment.atZone(zone).toLocalDate()
    return when (ChronoUnit.DAYS.between(day, now.atZone(zone).toLocalDate())) {
      0L -> Messenger.clock(moment, zone)
      1L -> "вчера"
      else -> shortDay.format(day)
    }
  }

  fun greeting(hour: Int, displayName: String): String {
    val words = if (hour < 5) "Доброй ночи" else if (hour < 12) "Доброе утро" else if (hour < 18) "Добрый день" else "Добрый вечер"
    val name = displayName.split(' ').firstOrNull().orEmpty()
    return if (name.isEmpty()) words else "$words, $name"
  }

  /** What stands in the head of an answer: how long it took. */
  fun answerHead(ms: Double?): String = if (ms == null) "AI" else "Ответ за ${maxOf(1, Math.round(ms / 1000).toInt())} с"

  /** The honest line of a pending turn (without the seconds). */
  fun workingWords(turn: AITurn, router: Boolean): String {
    val stage = turn.stage
    return when {
      !stage.isNullOrEmpty() -> stage
      turn.kind == "image" -> "Рисую картинку"
      turn.kind == "video" -> "Создаю видео — это может занять до 5 минут"
      turn.kind == "speech" -> "Озвучиваю текст"
      turn.kind == "transcribe" -> "Расшифровываю аудио"
      router -> if (turn.model != null) "Модель «${modelLabel(turn.model)}» пишет ответ" else "Подбираю свободную модель и пишу ответ"
      else -> "Бесплатная модель пишет ответ"
    }
  }
}
