package com.linea.messenger.chatactions

/** The rules of the forwards on their way (the iPhone's `ForwardJobs` in Sources/ChatActions/ForwardQueue.swift):
 *  every forwarded message that carries a file is one job; a job waits («в очереди»), runs (the file is brought,
 *  opened, sealed under a new key and uploaded again, then the message is sent), and either goes (the job is gone,
 *  the message is in the chat) or fails (the row says why, «Повторить» puts it back in the queue, «Удалить» drops
 *  it). At most `limit` jobs run at once, and in one chat only one at a time, in their order — a failed one does not
 *  hold back those after it. Values only: no threads, no server (the JVM checks run it as it is). */
class ForwardJobs(limit: Int = PARALLEL) {
  enum class State { QUEUED, RUNNING, FAILED }

  data class Job(
    val id: String,
    val chatId: String,
    /** What it is, for the line of the chat in the list: «Видео», «📎 отчёт.pdf», a text. */
    val what: String,
    val state: State = State.QUEUED,
    /** How much of the copy is done, 0…1 (while running). */
    val progress: Double = 0.0,
    /** Why it failed: the words for the person. */
    val failure: String? = null,
  )

  val limit = limit.coerceAtLeast(1)
  var jobs: List<Job> = emptyList()
    private set

  fun add(id: String, chatId: String, what: String) { jobs = jobs + Job(id, chatId, what) }

  fun job(id: String): Job? = jobs.firstOrNull { it.id == id }

  private fun change(id: String, change: (Job) -> Job?): Boolean {
    val at = jobs.indexOfFirst { it.id == id }
    if (at < 0) return false
    val made = change(jobs[at]) ?: return false
    jobs = jobs.toMutableList().also { it[at] = made }
    return true
  }

  /** The jobs that may start now, in their order: within the limit, and only the first waiting or running job of
   *  each chat (a failed one is passed over). */
  fun startable(): List<String> {
    var running = jobs.count { it.state == State.RUNNING }
    val busy = HashSet<String>()
    val out = ArrayList<String>()
    for (job in jobs) {
      if (job.state == State.FAILED) continue
      if (!busy.add(job.chatId)) continue
      if (job.state == State.QUEUED && running < limit) {
        out.add(job.id)
        running++
      }
    }
    return out
  }

  /** queued → running, from nothing. */
  fun start(id: String): Boolean = change(id) { if (it.state == State.QUEUED) it.copy(state = State.RUNNING, progress = 0.0, failure = null) else null }

  /** The copy moved on. Only while running, and only forward (a late report changes nothing). True when the whole
   *  percent changed (the row and the list are drawn again). */
  fun progress(id: String, fraction: Double): Boolean {
    val job = job(id) ?: return false
    if (job.state != State.RUNNING || fraction.isNaN() || fraction.isInfinite()) return false
    val value = fraction.coerceIn(0.0, 1.0)
    if (value <= job.progress) return false
    change(id) { it.copy(progress = value) }
    return percent(value) != percent(job.progress)
  }

  /** running → failed, with the words for the person. */
  fun fail(id: String, words: String): Boolean =
    change(id) { if (it.state == State.RUNNING) it.copy(state = State.FAILED, progress = 0.0, failure = words.ifEmpty { "Не удалось переслать." }) else null }

  /** «Повторить»: failed → queued; the copy is done again from the start. */
  fun retry(id: String): Boolean = change(id) { if (it.state == State.FAILED) it.copy(state = State.QUEUED, progress = 0.0, failure = null) else null }

  /** The message went: the job is gone (its row gives way to the message itself). */
  fun finish(id: String): Boolean {
    val job = job(id) ?: return false
    if (job.state != State.RUNNING) return false
    jobs = jobs.filter { it.id != id }
    return true
  }

  /** ✕ or «Удалить»: the job is gone whatever its state; gives the state it had (null: there was none). */
  fun remove(id: String): State? {
    val job = job(id) ?: return null
    jobs = jobs.filter { it.id != id }
    return job.state
  }

  /** Whether something of this chat waits or runs (a text forwarded after it waits too, so the order stays). */
  fun waiting(chatId: String): Boolean = jobs.any { it.chatId == chatId && it.state != State.FAILED }

  fun of(chatId: String): List<Job> = jobs.filter { it.chatId == chatId }

  /** The line of the chat in the list: «Отправка: Видео · 40%» while something goes, else «Не отправлено: Видео»
   *  (the first word red: `second` UTF-16 units). Null: nothing of this chat. */
  fun listLine(chatId: String): Pair<String, Int>? {
    val mine = of(chatId)
    val going = mine.firstOrNull { it.state != State.FAILED }
    if (going != null) {
      val percent = percent(going.progress)
      val tail = if (going.state == State.RUNNING && percent > 0) " · $percent%" else ""
      return ("$SENDING_WORD ${going.what}$tail") to 0
    }
    val failed = mine.firstOrNull { it.state == State.FAILED } ?: return null
    return ("$FAILED_WORD ${failed.what}") to FAILED_WORD.length
  }

  companion object {
    /** The reference copies one forward at a time; here two may run at once (in different chats). */
    const val PARALLEL = 2
    const val SENDING_WORD = "Отправка:"
    const val FAILED_WORD = "Не отправлено:"

    /** The words on the ring of a row: «В очереди», «Пересылка · 40%». */
    fun ringWords(job: Job): String = if (job.state == State.RUNNING) "Пересылка · ${percent(job.progress)}%" else "В очереди"

    fun percent(value: Double): Int = (value.coerceIn(0.0, 1.0) * 100).toInt()
  }
}
