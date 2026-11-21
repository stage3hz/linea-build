package com.linea.messenger

import com.linea.messenger.ai.AIConversation
import com.linea.messenger.ai.AIFailure
import com.linea.messenger.ai.AILimits
import com.linea.messenger.ai.AIMedia
import com.linea.messenger.ai.AIMediaCache
import com.linea.messenger.ai.AIModel
import com.linea.messenger.ai.AIReply
import com.linea.messenger.ai.AITaskResult
import com.linea.messenger.ai.AIText
import com.linea.messenger.ai.AITurn
import com.linea.messenger.ai.AIWork
import com.linea.messenger.core.Core
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId

/** The rules of «AI» that need no phone and no server: what the server's answers must be, what fits into a
 *  question, what a request asks for, the stored history in the reference's JSON, the conversation's steps,
 *  the cache of made files. The samples are written by hand after the files of mobile/src/ai. */
class AIRulesTest {
  private fun json(text: String): Any? = Core.value(text)
  private fun words(work: () -> Unit): String = try { work(); "" } catch (failure: AIFailure) { failure.words }

  private val capabilities = """"text":{"enabled":true},"code":{"enabled":true},"image":{"enabled":true},"video":{"enabled":false,"reason":"нет ключа"},"threeD":{"enabled":false},"social":{"enabled":false}"""

  @Test fun theServersStatus() {
    val router = AIModel.parseStatus(json("""{"configured":true,"provider":"freellmapi","model":"auto","freeOnly":true,"capabilities":{$capabilities,"speech":{"enabled":true},"models":{"enabled":true}}}"""))
    assertTrue(router.configured && router.router && router.platina)
    assertTrue(router.can("text") && router.can("speech") && router.can("models"))
    assertFalse(router.can("video"))
    assertEquals("нет ключа", router.capabilities["video"]?.reason)
    // A tool an older server does not name is simply not there.
    assertFalse(router.can("transcribe"))
    assertEquals("Этот сервер пока не поддерживает инструмент.", router.capabilities["transcribe"]?.reason)
    val plain = AIModel.parseStatus(json("""{"configured":false,"provider":"openrouter","model":"openrouter/free","freeOnly":true,"platina":false,"capabilities":{$capabilities}}"""))
    assertFalse(plain.configured || plain.router || plain.platina)
    val refused = "Этот сервер не подтвердил доступ к бесплатному AI."
    // Not the free route, a paid model, a flag that is not a flag: no access is assumed.
    assertEquals(refused, words { AIModel.parseStatus(json("""{"configured":true,"provider":"openrouter","model":"gpt-5","freeOnly":true,"capabilities":{$capabilities}}""")) })
    assertEquals(refused, words { AIModel.parseStatus(json("""{"configured":true,"provider":"freellmapi","model":"auto","freeOnly":false,"capabilities":{$capabilities}}""")) })
    assertEquals(refused, words { AIModel.parseStatus(json("""{"configured":"yes","provider":"freellmapi","model":"auto","freeOnly":true,"capabilities":{$capabilities}}""")) })
    assertEquals(refused, words { AIModel.parseStatus(json("""{"configured":true,"provider":"freellmapi","model":"bad model","freeOnly":true,"capabilities":{$capabilities}}""")) })
    assertEquals("AI-сервис вернул некорректный ответ.", words { AIModel.parseStatus(json("[]")) })
    assertEquals("AI-сервис вернул некорректный ответ.", words { AIModel.parseStatus(json("""{"configured":true,"provider":"freellmapi","model":"auto","freeOnly":true,"capabilities":{"text":{"enabled":true}}}""")) })
    assertEquals("Сервер не подтвердил доступность AI-инструментов.", words { AIModel.parseStatus(json("""{"configured":true,"provider":"freellmapi","model":"auto","freeOnly":true,"capabilities":{"text":{"enabled":1}}}""")) })
  }

  @Test fun anAnswerOfTheModel() {
    val reply = AIModel.parseReply(json("""{"text":"Привет","model":"meta/llama-3.3-70b","provider":"freellmapi","freeOnly":true,"routedVia":"groq"}"""))
    assertEquals(AIReply("Привет", "meta/llama-3.3-70b", "freellmapi", "groq"), reply)
    assertNull(AIModel.parseReply(json("""{"text":"Привет","model":"m","provider":"openrouter","freeOnly":true,"routedVia":""}""")).routedVia)
    val wrong = "AI-сервис не вернул допустимый ответ бесплатной модели. Попробуй ещё раз."
    assertEquals(wrong, words { AIModel.parseReply(json("""{"text":"  ","model":"m","provider":"freellmapi","freeOnly":true}""")) })
    assertEquals(wrong, words { AIModel.parseReply(json("""{"text":"Привет","model":"m","provider":"other","freeOnly":true}""")) })
    assertEquals(wrong, words { AIModel.parseReply(json("""{"text":"Привет","model":"m","provider":"freellmapi"}""")) })
    assertEquals(wrong, words { AIModel.parseReply(mapOf("text" to "я".repeat(AILimits.answer + 1), "model" to "m", "provider" to "freellmapi", "freeOnly" to true)) })
    assertEquals(listOf("a/b", "c"), AIModel.parseModels(json("""{"strategies":["auto"],"models":["a/b","with space",7,"c"]}""")))
    assertEquals(emptyList<String>(), AIModel.parseModels(json("""{"models":"a"}""")))
  }

  @Test fun aMadeFile() {
    val made = AIModel.parseMedia(json("""{"mimeType":"image/png","base64":"aGVsbG8=","routedVia":"pollinations"}"""), AIModel.imageKinds)
    assertEquals("image/png", made.mimeType)
    assertEquals("hello", String(made.data))
    assertEquals("pollinations", made.routedVia)
    val wrong = "AI-сервис вернул некорректный файл."
    assertEquals(wrong, words { AIModel.parseMedia(json("""{"mimeType":"image/svg+xml","base64":"aGVsbG8="}"""), AIModel.imageKinds) })
    assertEquals(wrong, words { AIModel.parseMedia(json("""{"mimeType":"image/png","base64":""}"""), AIModel.imageKinds) })
    assertEquals(wrong, words { AIModel.parseMedia(json("""{"mimeType":"image/png","base64":"не base64"}"""), AIModel.imageKinds) })
    assertEquals(wrong, words { AIModel.parseMedia(json("""{"mimeType":"text/html","base64":"aGVsbG8="}"""), AIModel.speechKinds) })
    assertEquals("audio/mpeg", AIModel.parseMedia(json("""{"mimeType":"audio/mpeg","base64":"aGVsbG8="}"""), AIModel.speechKinds).mimeType)
  }

  private fun done(id: Int, question: String, answer: String) = AITurn(id = id, question = question, status = "complete", answer = AIReply(answer, "m", "freellmapi"))

  @Test fun whatGoesWithAQuestion() {
    val turns = listOf(done(1, "Раз", "Один"), AITurn(id = 2, question = "Не вышло", status = "failed", error = "x"), done(3, "Два", "Второй"))
    // Only what was answered is context; the question itself is trimmed.
    assertEquals(listOf("user" to "Раз", "assistant" to "Один", "user" to "Два", "assistant" to "Второй", "user" to "Три"),
      AIModel.historyForQuestion(turns, "  Три \n").map { it["role"] to it["content"] })
    assertEquals("Напиши вопрос.", words { AIModel.historyForQuestion(turns, "   ") })
    assertEquals("Вопрос должен быть не длиннее 8000 символов.", words { AIModel.historyForQuestion(emptyList(), "я".repeat(8001)) })
    assertEquals(1, AIModel.historyForQuestion(emptyList(), "я".repeat(8000)).size)
    val limit = "Беседа достигла лимита контекста. Начни новую беседу — предыдущий текст не будет обрезан или отправлен частично."
    // Twenty messages at most: nine answered turns and the question are nineteen, ten are twenty-one.
    assertEquals(19, AIModel.historyForQuestion((1..9).map { done(it, "в", "о") }, "ещё").size)
    assertEquals(limit, words { AIModel.historyForQuestion((1..10).map { done(it, "в", "о") }, "ещё") })
    // 32 000 characters in all, and no single message longer than a question may be.
    assertEquals(limit, words { AIModel.historyForQuestion((1..3).map { done(it, "в".repeat(6000), "о".repeat(6000)) }, "ещё") })
    assertEquals(limit, words { AIModel.historyForQuestion(listOf(done(1, "в", "о".repeat(8001))), "ещё") })
  }

  @Test fun whatARequestAsksFor() {
    assertEquals("text", AIModel.detectIntent(""))
    assertEquals("text", AIModel.detectIntent("Чем отличается val от var?"))
    assertEquals("image", AIModel.detectIntent("Нарисуй кота в шляпе"))
    assertEquals("image", AIModel.detectIntent("нарисуй, пожалуйста, закат"))
    assertEquals("image", AIModel.detectIntent("Сделай мне красивую картинку с морем"))
    assertEquals("image", AIModel.detectIntent("create a logo for a bakery"))
    assertEquals("video", AIModel.detectIntent("Сделай видео про осень"))
    assertEquals("video", AIModel.detectIntent("СГЕНЕРИРУЙ короткий ролик"))
    assertEquals("speech", AIModel.detectIntent("Озвучь: привет"))
    assertEquals("speech", AIModel.detectIntent("прочитай вслух это письмо"))
    // The noun must stand in the same sentence, and «озвучь» must be a word of its own.
    assertEquals("text", AIModel.detectIntent("Сделай вывод. Картинка здесь ни при чём"))
    assertEquals("text", AIModel.detectIntent("озвучьте мне цену"))
    assertEquals("text", AIModel.detectIntent("Расскажи про видео"))
    assertEquals("привет", AIModel.speechText("Озвучь: привет"))
    assertEquals("это письмо", AIModel.speechText("  прочитай вслух это письмо "))
    assertEquals("", AIModel.speechText("озвучь"))
  }

  @Test fun onlyFilesOfTheCacheAreMedia() {
    assertTrue(AIModel.isMediaUri("linea-ai-abc-123.png"))
    assertTrue(AIModel.isMediaUri("file:///data/user/0/app/cache/linea-ai-abc-123.mp4"))
    assertEquals("linea-ai-abc-123.mp4", AIModel.mediaName("file:///data/user/0/app/cache/linea-ai-abc-123.mp4"))
    for (wrong in listOf("/etc/passwd", "cache/linea-ai-abc.png", "linea-ai-abc.png?x=1", "linea-ai-abc.png#x", "file:///a/../linea-ai-abc.png", "other-abc.png", "linea-ai-abc", "linea-ai-abc.PNG", "https://example.com/linea-ai-abc.png?")) {
      assertFalse(wrong, AIModel.isMediaUri(wrong))
    }
    assertEquals("linea-ai-b6f0_x-1111.jpg", AIMediaCache.fileName("b6f0/x", "image/jpeg", "1111"))
    assertEquals("linea-ai-id-1111.bin", AIMediaCache.fileName("id", "application/x-unknown", "1111"))
    assertTrue(AIModel.isMediaUri(AIMediaCache.fileName("b6f0c1d2-0000-4000-8000-000000000001", "video/mp4", "9d3c7a10-0000-4000-8000-00000000000a")))
  }

  /** The history as the previous app writes it (history.ts, `JSON.stringify` of the stored conversations). */
  private val stored = """[
    {"id":"b6f0c1d2-0000-4000-8000-000000000001","title":"Чем отличается let от var?","updatedAt":"2026-11-20T18:04:05.120Z","consent":true,"turns":[
      {"id":1,"question":"Чем отличается let от var?","status":"complete","answer":{"text":"let — константа.","model":"meta/llama-3.3-70b","provider":"freellmapi","freeOnly":true,"routedVia":"groq"},"options":{"model":"auto:smart"},"startedAt":1763661840000,"ms":3200},
      {"id":2,"question":"Нарисуй кота","status":"complete","answer":{"text":"Готово. Нажми на картинку, чтобы сохранить или отправить.","model":"генерация картинок","provider":"freellmapi","freeOnly":true},"ms":9100,"kind":"image","media":{"uri":"linea-ai-b6f0c1d2-0000-4000-8000-000000000001-9d3c7a10-0000-4000-8000-00000000000a.png","mimeType":"image/png"}},
      {"id":3,"question":"А ещё?","status":"failed","error":"Сервер не ответил вовремя. Проверь подключение."}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000002","title":"Новее","updatedAt":"2026-11-21T07:00:00.000Z","consent":false,"turns":[{"id":1,"question":"Привет","status":"cancelled"}]},
    {"id":"short","title":"Плохой id","updatedAt":"2026-11-21T07:00:00.000Z","consent":true,"turns":[{"id":1,"question":"Привет","status":"cancelled"}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000003","title":"Ждёт","updatedAt":"2026-11-21T07:00:00.000Z","consent":true,"turns":[{"id":1,"question":"Привет","status":"pending"}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000004","title":"Чужой файл","updatedAt":"2026-11-21T07:00:00.000Z","consent":true,"turns":[{"id":1,"question":"Привет","status":"complete","media":{"uri":"/sdcard/secret.png","mimeType":"image/png"}}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000005","title":"Дробный номер","updatedAt":"2026-11-21T07:00:00.000Z","consent":true,"turns":[{"id":1.5,"question":"Привет","status":"complete"}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000006","title":"Без согласия","updatedAt":"2026-11-21T07:00:00.000Z","turns":[{"id":1,"question":"Привет","status":"complete"}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000007","title":"Не время","updatedAt":"вчера","consent":true,"turns":[{"id":1,"question":"Привет","status":"complete"}]},
    {"id":"b6f0c1d2-0000-4000-8000-000000000008","title":"Пусто","updatedAt":"2026-11-21T07:00:00.000Z","consent":true,"turns":[]}
  ]"""

  @Test fun theHistoryOfThePreviousAppIsRead() {
    val list = AIModel.parseHistory(stored)
    // Whatever is not wholly valid is left out; the newest stands first.
    assertEquals(listOf("b6f0c1d2-0000-4000-8000-000000000002", "b6f0c1d2-0000-4000-8000-000000000001"), list.map { it.id })
    assertFalse(list[0].consent)
    val turns = list[1].turns
    assertEquals(listOf(1, 2, 3), turns.map { it.id })
    assertEquals("auto:smart", turns[0].model)
    assertEquals(3200.0, turns[0].ms)
    assertEquals(AIReply("let — константа.", "meta/llama-3.3-70b", "freellmapi", "groq"), turns[0].answer)
    assertEquals("image", turns[1].kind)
    assertEquals(AIMedia("linea-ai-b6f0c1d2-0000-4000-8000-000000000001-9d3c7a10-0000-4000-8000-00000000000a.png", "image/png"), turns[1].media)
    assertEquals("Сервер не ответил вовремя. Проверь подключение.", turns[2].error)
    assertEquals(emptyList<Any>(), AIModel.parseHistory(null))
    assertEquals(emptyList<Any>(), AIModel.parseHistory("не JSON"))
    assertEquals(emptyList<Any>(), AIModel.parseHistory("{}"))
  }

  @Test fun theHistoryIsWrittenInTheSameForm() {
    val list = AIModel.parseHistory(stored)
    val written = AIModel.historyJSON(list)
    // What is written is read back the same, by this app and by the previous one's rules.
    assertEquals(list, AIModel.parseHistory(written))
    val first = Core.map((Core.value(written) as List<*>)[1])!!
    val turn = Core.map((first["turns"] as List<*>)[0])!!
    // Whole numbers stay whole in the text (`Number.isSafeInteger` of the reference).
    assertTrue(written.contains("\"id\":1,") && written.contains("\"ms\":3200") && !written.contains("1.0"))
    assertEquals(mapOf("model" to "auto:smart"), turn["options"])
    assertEquals(true, Core.map(turn["answer"])!!["freeOnly"])
    assertEquals("freellmapi", Core.map(turn["answer"])!!["provider"])
    // What is only of the moment is not written.
    assertFalse(written.contains("startedAt") || written.contains("stage") || written.contains("isPrivate"))
    assertEquals("[]", AIModel.historyJSON(emptyList()))
  }

  @Test fun whatIsKeptOfAConversation() {
    val turns = listOf(
      done(1, "Помоги", "Да").copy(startedAt = 5, ms = 1200.4, stage = "x", media = AIMedia("file:///cache/linea-ai-a-1.png", "image/png")),
      done(2, "Тайна", "Секрет").copy(isPrivate = true),
      AITurn(id = 3, question = "Жду", status = "pending", error = ""),
    )
    val kept = AIModel.storedTurns(turns)
    // A private turn is never kept; an unfinished one comes back as cancelled; a file is kept by its name.
    assertEquals(listOf(1, 3), kept.map { it.id })
    assertEquals("cancelled", kept[1].status)
    assertNull(kept[1].error)
    assertEquals(AIMedia("linea-ai-a-1.png", "image/png"), kept[0].media)
    assertNull(kept[0].startedAt)
    assertNull(kept[0].stage)
    assertEquals(1200.0, Core.map(AIModel.turnJSON(kept[0]))!!["ms"])

    val now = "2026-11-21T09:00:00.000Z"
    val list = AIModel.upsert(emptyList(), "conv-0001", turns, true, now)
    assertEquals(1, list.size)
    assertEquals("Помоги", list[0].title)
    // The same conversation again replaces itself; another one stands before it.
    val two = AIModel.upsert(AIModel.upsert(list, "conv-0001", turns + done(4, "Ещё", "Да"), true, now), "conv-0002", listOf(done(1, "Новая", "Да")), false, now)
    assertEquals(listOf("conv-0002", "conv-0001"), two.map { it.id })
    assertEquals(3, two[1].turns.size)
    // A conversation of private turns only is not kept at all — and a kept one goes when it becomes such.
    assertEquals(listOf("conv-0002"), AIModel.upsert(two, "conv-0001", listOf(turns[1]), true, now).map { it.id })
    // Forty turns of a conversation, sixty conversations.
    assertEquals(40, AIModel.upsert(emptyList(), "conv-0003", (1..55).map { done(it, "в$it", "о") }, true, now)[0].turns.size)
    assertEquals(16, AIModel.upsert(emptyList(), "conv-0003", (1..55).map { done(it, "в$it", "о") }, true, now)[0].turns.first().id)
    var many = emptyList<com.linea.messenger.ai.AIStoredConversation>()
    for (index in 1..65) many = AIModel.upsert(many, "conv-%04d".format(index), listOf(done(1, "в", "о")), true, now)
    assertEquals(60, many.size)
    assertEquals("conv-0065", many.first().id)
  }

  @Test fun theTitleOfAConversation() {
    assertEquals("Беседа", AIModel.conversationTitle(emptyList()))
    assertEquals("Как дела сегодня", AIModel.conversationTitle(listOf(done(1, "  Как\n дела\tсегодня ", "x"))))
    assertEquals("Сортировка списка", AIModel.conversationTitle(listOf(done(1, AIModel.codeTaskPrefix + "Сортировка списка", "x"))))
    val long = AIModel.conversationTitle(listOf(done(1, "я".repeat(80), "x")))
    assertEquals(60, long.length)
    assertTrue(long.endsWith("…"))
    assertEquals("я".repeat(60), AIModel.conversationTitle(listOf(done(1, "я".repeat(60), "x"))))
  }

  @Test fun theWordsOfThePage() {
    assertEquals("Авто", AIModel.modelLabel("auto"))
    assertEquals("Умная", AIModel.modelLabel("auto:smart"))
    assertEquals("Консилиум", AIModel.modelLabel("fusion"))
    assertEquals("llama-3.3-70b", AIModel.modelLabel("meta/llama-3.3-70b"))
    assertEquals("x/", AIModel.modelLabel("x/"))
    assertEquals(listOf("вопрос", "вопроса", "вопроса", "вопросов", "вопросов"), listOf(1, 2, 4, 5, 21).map { AIModel.questionsNoun(it) })
    val moscow = ZoneId.of("Europe/Moscow")
    val now = Instant.parse("2026-11-21T09:00:00Z")
    assertEquals("09:05", AIModel.listTime(Instant.parse("2026-11-21T06:05:00Z"), now, moscow))
    assertEquals("вчера", AIModel.listTime(Instant.parse("2026-11-20T18:00:00Z"), now, moscow))
    assertTrue(AIModel.listTime(Instant.parse("2026-11-12T18:00:00Z"), now, moscow).startsWith("12 нояб"))
    assertEquals("Доброй ночи", AIModel.greeting(3, ""))
    assertEquals("Доброе утро, Мария", AIModel.greeting(9, "Мария Орлова"))
    assertEquals("Добрый день", AIModel.greeting(12, ""))
    assertEquals("Добрый вечер, Лев", AIModel.greeting(18, "Лев"))
    assertEquals("AI", AIModel.answerHead(null))
    assertEquals("Ответ за 1 с", AIModel.answerHead(200.0))
    assertEquals("Ответ за 5 с", AIModel.answerHead(5400.0))
    val waiting = AITurn(id = 1, question = "x", status = "pending")
    assertEquals("Бесплатная модель пишет ответ", AIModel.workingWords(waiting, router = false))
    assertEquals("Подбираю свободную модель и пишу ответ", AIModel.workingWords(waiting, router = true))
    assertEquals("Модель «Умная» пишет ответ", AIModel.workingWords(waiting.copy(model = "auto:smart"), router = true))
    assertEquals("Рисую картинку", AIModel.workingWords(waiting.copy(kind = "image"), router = true))
    assertEquals("Создаю видео — это может занять до 5 минут", AIModel.workingWords(waiting.copy(kind = "video"), router = true))
    assertEquals("Озвучиваю текст", AIModel.workingWords(waiting.copy(kind = "speech"), router = false))
    assertEquals("Расшифровываю аудио", AIModel.workingWords(waiting.copy(kind = "transcribe"), router = false))
    assertEquals("Почти готово", AIModel.workingWords(waiting.copy(kind = "image", stage = "Почти готово"), router = true))
    assertEquals("2026-11-21T09:00:00.000Z", AIModel.nowISO(now))
    assertEquals("2026-11-21T09:00:00.120Z", AIModel.nowISO(Instant.parse("2026-11-21T09:00:00.120999Z")))
  }

  @Test fun blocksOfCodeInAnAnswer() {
    val parts = AIText.blocks("Вот пример:\n\n```kotlin\nval a = 1\nprintln(a)\n```\n\nГотово.")
    assertEquals(listOf(false, true, false), parts.map { it.code })
    assertEquals("Вот пример:\n\n", parts[0].text)
    // The line that names the language is not shown; the block has no empty line at its end.
    assertEquals("val a = 1\nprintln(a)", parts[1].text)
    assertEquals("\n\nГотово.", parts[2].text)
    assertEquals("a b\nc", AIText.blocks("```a b\nc```")[1].text)
    // An unclosed fence is not a block.
    assertEquals(listOf(false), AIText.blocks("Начало ```kotlin\nval a = 1").map { it.code })
    assertEquals("Просто текст", AIText.blocks("Просто текст").single().text)
  }

  // The conversation's steps

  private class Line {
    val asked = ArrayList<Pair<List<Map<String, String>>, String?>>()
    var answer: ((Result<AIReply>) -> Unit)? = null
    var time = 1000L
    val conversation = AIConversation({ messages, model, done -> asked.add(messages to model); answer = done }, { time })
    var changes = 0
    init { conversation.onChange = { changes += 1 } }
    fun reply(text: String) = answer!!(Result.success(AIReply(text, "meta/llama", "freellmapi", "groq")))
    fun fail(words: String) = answer!!(Result.failure(AIFailure(words)))
  }

  @Test fun nothingIsAskedWithoutConsent() {
    val line = Line()
    line.conversation.ask("Привет", null)
    assertEquals("Сначала разреши отправлять вопросы внешней AI-службе.", line.conversation.error)
    assertTrue(line.asked.isEmpty() && line.conversation.turns.isEmpty())
    line.conversation.setConsent(true)
    assertEquals("", line.conversation.error)
    line.conversation.ask("   ", null)
    assertEquals("Напиши вопрос.", line.conversation.error)
    assertTrue(line.asked.isEmpty())
  }

  @Test fun aQuestionAndItsAnswer() {
    val line = Line()
    line.conversation.setConsent(true)
    line.conversation.ask("  Привет ", "auto:smart")
    assertTrue(line.conversation.pending)
    assertEquals("pending", line.conversation.turns.single().status)
    assertEquals("Привет", line.conversation.turns.single().question)
    assertEquals(listOf(mapOf("role" to "user", "content" to "Привет")), line.asked.single().first)
    assertEquals("auto:smart", line.asked.single().second)
    // One question at a time.
    line.conversation.ask("Ещё", null)
    assertEquals(1, line.asked.size)
    line.time = 4200
    line.reply("Здравствуй")
    val turn = line.conversation.turns.single()
    assertFalse(line.conversation.pending)
    assertEquals("complete", turn.status)
    assertEquals(AIReply("Здравствуй", "meta/llama", "freellmapi", "groq"), turn.answer)
    assertEquals(3200.0, turn.ms)
    // The next question carries the answered one.
    line.conversation.ask("Как дела?", null)
    assertEquals(listOf("Привет", "Здравствуй", "Как дела?"), line.asked[1].first.map { it["content"] })
    assertNull(line.asked[1].second)
  }

  @Test fun aFailedQuestionIsAskedAgain() {
    val line = Line()
    line.conversation.setConsent(true)
    line.conversation.ask("Привет", "fusion")
    line.fail("Сервер не ответил вовремя. Проверь подключение.")
    assertEquals("failed", line.conversation.turns.single().status)
    assertEquals("Сервер не ответил вовремя. Проверь подключение.", line.conversation.error)
    assertEquals(line.conversation.error, line.conversation.turns.single().error)
    line.conversation.retry()
    assertTrue(line.conversation.pending)
    assertEquals(1, line.conversation.turns.size)
    assertNull(line.conversation.turns.single().error)
    // The same question, the same model, and not twice in the context.
    assertEquals(listOf("Привет"), line.asked[1].first.map { it["content"] })
    assertEquals("fusion", line.asked[1].second)
    line.reply("Да")
    assertEquals("complete", line.conversation.turns.single().status)
    // Nothing to repeat after an answer.
    line.conversation.retry()
    assertEquals(2, line.asked.size)
  }

  @Test fun aLateAnswerOfACancelledQuestionIsDropped() {
    val line = Line()
    line.conversation.setConsent(true)
    line.conversation.ask("Привет", null)
    val late = line.answer!!
    line.conversation.cancel()
    assertFalse(line.conversation.pending)
    assertEquals("cancelled", line.conversation.turns.single().status)
    late(Result.success(AIReply("Поздно", "m", "freellmapi")))
    assertNull(line.conversation.turns.single().answer)
    assertEquals("cancelled", line.conversation.turns.single().status)
    // Taking the consent back stops the waiting too, and a new conversation is empty.
    line.conversation.ask("Ещё", null)
    line.conversation.setConsent(false)
    assertEquals("cancelled", line.conversation.turns.last().status)
    line.conversation.clear()
    assertTrue(line.conversation.turns.isEmpty())
    line.conversation.close()
    line.conversation.setConsent(true)
    assertFalse(line.conversation.consent)
  }

  @Test fun aPictureIsATurnOfTheSameConversation() {
    val line = Line()
    val discarded = ArrayList<AIMedia>()
    line.conversation.discardMedia = { discarded.add(it) }
    line.conversation.setConsent(true)
    var stage: ((String) -> Unit)? = null
    var finish: ((Result<AITaskResult>) -> Unit)? = null
    val work: AIWork = { say, done -> stage = say; finish = done }
    line.conversation.askTask("  ", "image", work)
    assertEquals("Напиши, что сделать.", line.conversation.error)
    line.conversation.askTask("Нарисуй кота", "image", work)
    assertEquals("image", line.conversation.turns.single().kind)
    stage!!("Рисую картинку")
    assertEquals("Рисую картинку", line.conversation.turns.single().stage)
    finish!!(Result.success(AITaskResult("Готово.", "генерация картинок", null, AIMedia("linea-ai-a-1.png", "image/png"))))
    val turn = line.conversation.turns.single()
    assertEquals("complete", turn.status)
    assertEquals(AIMedia("linea-ai-a-1.png", "image/png"), turn.media)
    assertEquals("freellmapi", turn.answer?.provider)
    assertNull(turn.stage)
    // A picture is not a text answer of the model, but its turn is complete and goes as context like any other.
    line.conversation.ask("Что на картинке?", null)
    assertEquals(3, line.asked.single().first.size)
    line.reply("Кот")
    // A file made for a turn that is gone is given back to be deleted.
    line.conversation.askTask("Нарисуй собаку", "image", work)
    val late = finish!!
    line.conversation.cancel()
    late(Result.success(AITaskResult("Готово.", "m", null, AIMedia("linea-ai-a-2.png", "image/png"))))
    assertEquals(listOf(AIMedia("linea-ai-a-2.png", "image/png")), discarded)
    assertNull(line.conversation.turns.last().media)
    // The cancelled picture can be asked again while its work is known…
    line.conversation.retry()
    assertTrue(line.conversation.pending)
    finish!!(Result.failure(AIFailure("Кэш недоступен на этом устройстве.")))
    assertEquals("Кэш недоступен на этом устройстве.", line.conversation.turns.last().error)
    // …and a reopened one (no work any more) is not.
    line.conversation.restore(line.conversation.turns, consent = true)
    line.conversation.retry()
    assertFalse(line.conversation.pending)
  }

  @Test fun aReopenedConversation() {
    val line = Line()
    val kept = listOf(done(4, "Раз", "Один").copy(media = AIMedia("linea-ai-a-1.png", "image/png")), AITurn(id = 7, question = "Жду", status = "pending"))
    line.conversation.restore(kept, consent = true)
    assertTrue(line.conversation.consent)
    assertEquals(listOf("complete", "cancelled"), line.conversation.turns.map { it.status })
    // New turns are numbered after the kept ones.
    line.conversation.ask("Два", null)
    assertEquals(8, line.conversation.turns.last().id)
    line.reply("Второй")
    // A file that is gone from the cache is forgotten.
    line.conversation.dropMedia(listOf("file:///cache/linea-ai-a-1.png"))
    assertNull(line.conversation.turns.first().media)
    // Private turns are marked as such.
    line.conversation.privateTurns = true
    line.conversation.ask("Тайна", null)
    assertTrue(line.conversation.turns.last().isPrivate)
    assertEquals(listOf(4, 7, 8), AIModel.storedTurns(line.conversation.turns).map { it.id })
  }

  // The cache of made files

  @Test fun whichCacheFilesGo() {
    val now = 10_000_000L
    fun file(name: String, size: Long, age: Long) = AIMediaCache.Kept(name, size, now - age)
    val files = listOf(file("linea-ai-a-1.png", 40, 500_000), file("linea-ai-a-2.png", 40, 400_000), file("linea-ai-b-1.mp4", 40, 300_000),
      file("linea-ai-orphan.png", 5, 200_000), file("linea-ai-young.png", 5, 60_000), file("invizent-view-x", 999, 900_000))
    val keep = setOf("linea-ai-a-1.png", "linea-ai-a-2.png", "linea-ai-b-1.mp4")
    // Under the limit: only the orphan older than two minutes goes; other apps' and other parts' files are not touched.
    assertEquals(listOf("linea-ai-orphan.png"), AIMediaCache.plan(files, keep, emptySet(), limit = 1000, now = now))
    // Over the limit: the oldest go first — never those of the conversation on screen.
    assertEquals(listOf("linea-ai-orphan.png", "linea-ai-a-1.png"), AIMediaCache.plan(files, keep, emptySet(), limit = 100, now = now))
    assertEquals(listOf("linea-ai-orphan.png", "linea-ai-b-1.mp4"), AIMediaCache.plan(files, keep, setOf("linea-ai-a-1.png", "linea-ai-a-2.png"), limit = 100, now = now))
    assertEquals(listOf("linea-ai-orphan.png"), AIMediaCache.plan(files, emptySet(), keep, limit = 10, now = now))
  }

  @Test fun madeFilesAreWrittenAndFound() {
    val folder = File(System.getProperty("java.io.tmpdir"), "ai-cache-test-" + System.nanoTime()).apply { mkdirs() }
    val before = AIMediaCache.folder
    try {
      AIMediaCache.folder = folder
      val name = AIMediaCache.write("conv-0001", "картинка".toByteArray(), "image/png")
      assertTrue(AIModel.isMediaUri(name) && name.startsWith("linea-ai-conv-0001-") && name.endsWith(".png"))
      assertEquals("картинка", AIMediaCache.file(name)!!.readText())
      assertNull(AIMediaCache.file("../" + name))
      val turns = listOf(done(1, "в", "о").copy(media = AIMedia(name, "image/png")), done(2, "в", "о").copy(media = AIMedia("linea-ai-gone-1.png", "image/png")), done(3, "в", "о"))
      assertEquals(listOf(name, "linea-ai-gone-1.png"), AIMediaCache.names(turns))
      assertEquals(listOf("linea-ai-gone-1.png"), AIMediaCache.missing(turns))
      // A stranger's file in the same folder is never deleted by a name that is not of the cache.
      val other = File(folder, "other.txt").apply { writeText("x") }
      AIMediaCache.delete(listOf(name, "other.txt", "../other.txt"))
      assertFalse(File(folder, name).exists())
      assertTrue(other.exists())
      AIMediaCache.folder = null
      assertEquals("Кэш недоступен на этом устройстве.", words { AIMediaCache.write("c", ByteArray(1), "image/png") })
    } finally {
      AIMediaCache.folder = before
      folder.deleteRecursively()
    }
  }
}
