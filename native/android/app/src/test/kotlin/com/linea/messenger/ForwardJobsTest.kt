package com.linea.messenger

import com.linea.messenger.chatactions.ChatListActions
import com.linea.messenger.chatactions.ForwardJobs
import com.linea.messenger.chatactions.ForwardJobs.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The forwards on their way (chatactions/ForwardJobs.kt, the rules of chatactions/ForwardQueue.kt and of the
 *  iPhone's Sources/ChatActions/ForwardQueue.swift): queued → progress → sent, queued → failed → retry → sent,
 *  ✕ at any moment, one job per chat at a time and at most two at once, and the line of the chat in the list. */
class ForwardJobsTest {
  @Test fun aJobGoesFromTheQueueToTheChat() {
    val jobs = ForwardJobs()
    jobs.add("a", "chat-1", "Видео")
    assertEquals(State.QUEUED, jobs.job("a")?.state)
    assertTrue(jobs.waiting("chat-1"))
    assertEquals(listOf("a"), jobs.startable())
    assertEquals("В очереди", ForwardJobs.ringWords(jobs.job("a")!!))
    assertEquals("Отправка: Видео" to 0, jobs.listLine("chat-1"))

    assertTrue(jobs.start("a"))
    assertFalse(jobs.start("a")) // only once
    assertEquals(State.RUNNING, jobs.job("a")?.state)
    assertEquals(emptyList<String>(), jobs.startable())

    // The progress moves only forward; a whole percent more is a change to draw.
    assertTrue(jobs.progress("a", 0.4))
    assertEquals(0.4, jobs.job("a")!!.progress, 1e-9)
    assertFalse(jobs.progress("a", 0.3)) // a late report
    assertFalse(jobs.progress("a", 0.4041)) // the same percent
    assertEquals(0.4041, jobs.job("a")!!.progress, 1e-9)
    assertFalse(jobs.progress("a", Double.NaN))
    assertEquals("Пересылка · 40%", ForwardJobs.ringWords(jobs.job("a")!!))
    assertEquals("Отправка: Видео · 40%" to 0, jobs.listLine("chat-1"))
    assertTrue(jobs.progress("a", 7.0)) // never past the end
    assertEquals(1.0, jobs.job("a")!!.progress, 1e-9)

    assertTrue(jobs.finish("a"))
    assertNull(jobs.job("a"))
    assertFalse(jobs.waiting("chat-1"))
    assertNull(jobs.listLine("chat-1"))
    assertFalse(jobs.finish("a"))
  }

  @Test fun aFailedJobSaysWhyAndGoesAgain() {
    val jobs = ForwardJobs()
    jobs.add("a", "chat-1", "📎 отчёт.pdf")
    assertFalse(jobs.fail("a", "Сеть недоступна.")) // not before it runs
    assertFalse(jobs.progress("a", 0.5)) // nor progress
    jobs.start("a")
    jobs.progress("a", 0.7)
    assertTrue(jobs.fail("a", "Сеть недоступна."))
    val failed = jobs.job("a")!!
    assertEquals(State.FAILED, failed.state)
    assertEquals("Сеть недоступна.", failed.failure)
    assertEquals(0.0, failed.progress, 0.0)
    assertFalse(jobs.waiting("chat-1")) // a text sent on now need not wait behind it
    assertFalse(jobs.progress("a", 0.9)) // a late report after the failure changes nothing
    assertEquals(emptyList<String>(), jobs.startable())
    assertEquals("Не отправлено: 📎 отчёт.pdf" to "Не отправлено:".length, jobs.listLine("chat-1"))
    assertEquals(14, ForwardJobs.FAILED_WORD.length)

    // «Повторить»: back in the queue, the copy from the start.
    assertFalse(jobs.retry("missing"))
    assertTrue(jobs.retry("a"))
    assertFalse(jobs.retry("a"))
    assertEquals(State.QUEUED, jobs.job("a")?.state)
    assertNull(jobs.job("a")?.failure)
    assertEquals(listOf("a"), jobs.startable())
    assertTrue(jobs.start("a"))
    assertTrue(jobs.finish("a"))
    assertNull(jobs.listLine("chat-1"))

    // No words from the failure: the general ones.
    jobs.add("b", "chat-1", "Видео")
    jobs.start("b")
    jobs.fail("b", "")
    assertEquals("Не удалось переслать.", jobs.job("b")?.failure)
  }

  @Test fun theCrossStopsAJobInAnyState() {
    val jobs = ForwardJobs()
    jobs.add("a", "chat-1", "Видео")
    jobs.add("b", "chat-1", "Фотография")
    jobs.add("c", "chat-1", "Голосовое сообщение")
    assertEquals(State.QUEUED, jobs.remove("b"))
    jobs.start("a")
    assertEquals(State.RUNNING, jobs.remove("a"))
    assertEquals(listOf("c"), jobs.startable()) // the next of that chat starts
    jobs.start("c")
    jobs.fail("c", "Файл недоступен.")
    assertEquals(State.FAILED, jobs.remove("c")) // «Удалить»
    assertNull(jobs.remove("c"))
    assertEquals(emptyList<ForwardJobs.Job>(), jobs.jobs)
    assertFalse(jobs.finish("a")) // a copy that ends after ✕ sends nothing
  }

  @Test fun oneJobPerChatAtATimeAndTwoAtOnce() {
    val jobs = ForwardJobs()
    assertEquals(2, jobs.limit)
    jobs.add("a1", "chat-a", "Видео")
    jobs.add("a2", "chat-a", "Текст после видео")
    jobs.add("b1", "chat-b", "Видео")
    jobs.add("c1", "chat-c", "Видео")
    // The first of each chat, at most two: a1 and b1; a2 waits behind a1, c1 for a free place.
    assertEquals(listOf("a1", "b1"), jobs.startable())
    jobs.start("a1"); jobs.start("b1")
    assertEquals(emptyList<String>(), jobs.startable())
    jobs.finish("b1")
    assertEquals(listOf("c1"), jobs.startable())
    jobs.start("c1")
    jobs.fail("a1", "Нет сети.")
    // A failed job does not hold back the ones after it in its chat.
    assertEquals(listOf("a2"), jobs.startable())
    assertTrue(jobs.waiting("chat-a"))
    // The list shows what goes there first, the failure once nothing goes.
    assertEquals("Отправка: Текст после видео" to 0, jobs.listLine("chat-a"))
    jobs.start("a2"); jobs.finish("a2")
    assertEquals("Не отправлено: Видео" to 14, jobs.listLine("chat-a"))
    assertEquals(listOf("a1"), jobs.of("chat-a").map { it.id })
    assertEquals(1, ForwardJobs(limit = 0).limit)
  }

  @Test fun theListShowsTheForwardOnItsWay() {
    val now = Instant.parse("2026-11-22T09:00:00Z")
    val chat = ChatListActions.Chat("1", "peer-1", "Алиса", 0, mapOf("id" to "1", "title" to "Алиса", "preview" to "Привет", "time" to "09:00"),
      mapOf("id" to "1", "peer" to mapOf("id" to "peer-1")), mapOf("id" to 9L, "senderId" to "peer-1", "text" to "Привет", "createdAt" to "2026-11-22T08:00:00Z"))
    fun row(sending: Pair<String, Int>?, draft: String = "") = ChatListActions.rows(ChatListActions.State(listOf(chat), "me", draft = { draft }, now = now,
      zone = ZoneId.of("Europe/Moscow"), sending = { sending })).rows.last()
    val going = row("Отправка: Видео · 40%" to 0)
    assertEquals("Отправка: Видео · 40%", going["preview"])
    assertEquals(true, going["accentPreview"])
    assertEquals(false, going["quietPreview"])
    val failed = row("Не отправлено: Видео" to 14)
    assertEquals("Не отправлено: Видео", failed["preview"])
    assertEquals(14, failed["previewRed"])
    // A draft stays first.
    assertEquals("Черновик: Ещё", row("Отправка: Видео" to 0, draft = "Ещё")["preview"])
  }
}
