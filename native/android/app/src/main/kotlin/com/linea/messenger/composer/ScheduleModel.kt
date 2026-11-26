package com.linea.messenger.composer

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

/** «Отправить без звука» / «Отправить позже» — the pure part (iOS: Sources/Composer/ScheduleModel.swift; the
 *  reference's scheduled/model.ts): what a scheduled item is, the presets of the picker, the words of the list, when
 *  an item can be sent again.
 *
 *  The server keeps a scheduled message as the same end-to-end encrypted envelopes a normal send uses (it never sees
 *  the text); the text shown in the list comes from this device's vault. */
object ScheduleModel {
  /** At least a minute ahead, at most a year (seconds). */
  const val MIN_AHEAD = 60L
  const val MAX_AHEAD = 365L * 86_400

  private val months = listOf("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря")

  fun plural(n: Int, one: String, few: String, many: String): String {
    val a = n % 10; val b = n % 100
    if (a == 1 && b != 11) return one
    if (a in 2..4 && (b < 12 || b > 14)) return few
    return many
  }

  private fun two(n: Int) = if (n < 10) "0$n" else "$n"

  /** «20:05». */
  fun timeLabel(at: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
    val local = at.atZone(zone)
    return two(local.hour) + ":" + two(local.minute)
  }

  /** `day` at hour:minute, local time. */
  fun withDayTime(day: Instant, hour: Int, minute: Int, zone: ZoneId = ZoneId.systemDefault()): Instant =
    day.atZone(zone).toLocalDate().atTime(hour, minute).atZone(zone).toInstant()

  private fun date(at: Instant, zone: ZoneId): LocalDate = at.atZone(zone).toLocalDate()

  /** The quick choices: in an hour, tonight (while it is still ahead), tomorrow morning. */
  fun presets(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<Pair<String, Instant>> {
    val out = ArrayList<Pair<String, Instant>>()
    // In an hour, rounded up to five minutes.
    val later = now.plusSeconds(3600).atZone(zone)
    val rounded = Math.ceil(later.minute / 5.0).toInt() * 5
    val hourStart = later.truncatedTo(ChronoUnit.HOURS)
    out.add("Через час" to hourStart.plusMinutes(rounded.toLong()).toInstant())
    val tonight = withDayTime(now, 20, 0, zone)
    if (tonight.epochSecond - now.epochSecond >= 30 * 60) out.add("Сегодня в 20:00" to tonight)
    val tomorrow = now.atZone(zone).plusDays(1).toInstant()
    out.add("Завтра в 09:00" to withDayTime(tomorrow, 9, 0, zone))
    if (out.size < 3) out.add("Завтра в 20:00" to withDayTime(tomorrow, 20, 0, zone))
    return out
  }

  /** Null when the time can be scheduled; otherwise the reason shown under the picker. */
  fun validate(at: Instant, now: Instant = Instant.now()): String? {
    val ahead = at.epochSecond - now.epochSecond
    if (ahead < MIN_AHEAD) return "Время уже прошло — выбери хотя бы минуту вперёд."
    if (ahead > MAX_AHEAD) return "Отложить можно не больше чем на год."
    return null
  }

  /** «Сегодня в 20:00», «Завтра в 09:00», «15 ноября в 09:00», «3 января 2027 в 10:00». */
  fun formatDeliverAt(at: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val time = timeLabel(at, zone)
    val day = date(at, zone); val today = date(now, zone)
    if (day == today) return "Сегодня в $time"
    if (day == today.plusDays(1)) return "Завтра в $time"
    return dayWords(at, now, zone) + " в " + time
  }

  fun formatDeliverAt(iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
    Messenger.date(iso)?.let { formatDeliverAt(it, now, zone) } ?: ""

  private fun dayWords(at: Instant, now: Instant, zone: ZoneId): String {
    val day = date(at, zone)
    val year = if (day.year == date(now, zone).year) "" else " ${day.year}"
    return "${day.dayOfMonth} ${months[day.monthValue - 1]}$year"
  }

  /** The day shown in the custom picker: «Сегодня», «Завтра» or the date. */
  fun dayLabel(day: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val d = date(day, zone); val today = date(now, zone)
    if (d == today) return "Сегодня"
    if (d == today.plusDays(1)) return "Завтра"
    return dayWords(day, now, zone)
  }

  fun countScheduled(n: Int): String = "$n " + plural(n, "отложенное сообщение", "отложенных сообщения", "отложенных сообщений")

  /** What the list says under an item the server could not release. */
  fun failureText(code: String?): String = when (code ?: "") {
    "E2EE_DEVICES_CHANGED" -> "У собеседника изменились устройства. Будет отправлено, когда вы будете в сети."
    "BLOCKED" -> "Переписка с этим пользователем недоступна."
    "CHAT_GONE" -> "Чат удалён."
    "ATTACHMENT_GONE", "ATTACHMENT_USED" -> "Вложение больше недоступно."
    "CLIENT_ID_USED" -> "Это сообщение уже отправлено."
    else -> "Не удалось отправить."
  }

  /** The meta a message goes out with after the long-press menu: `silent: true` rides inside the ciphertext for the
   *  other side's screen (and makes the core ask for a quiet notification). Never on an action. */
  fun withSilent(meta: Map<String, Any?>?, silent: Boolean): Map<String, Any?>? {
    if (!silent || meta?.get("action") != null) return meta
    return (meta ?: emptyMap()) + ("silent" to true)
  }

  /** An ISO time as the server and the encryption take it (milliseconds, UTC). */
  fun iso(at: Instant): String = at.truncatedTo(ChronoUnit.MILLIS).toString().let { if (it.contains('.')) it else it.dropLast(1) + ".000Z" }
}

/** One row of the server's list (`GET /scheduled`) with its text opened from this device's vault. */
data class ScheduledItem(
  val id: String,
  val chatId: String,
  val clientId: String,
  val deliverAt: String,
  /** "scheduled" or "failed". */
  val status: String,
  val failure: String?,
  val createdAt: String,
  var text: String = "",
  var attachment: Map<String, Any?>? = null,
  var meta: Map<String, Any?>? = null,
  /** "decrypted" when this device holds the text (another device scheduled it otherwise). */
  var cryptoState: String = "",
  /** The ciphertext when the server sent it (not in the lean list). */
  var encrypted: Map<String, Any?>? = null,
) {
  val failed: Boolean get() = status == "failed"
  val silent: Boolean get() = meta?.get("silent") == true

  /** Only a device-set failure is sent again by itself: this device encrypts afresh the text it still holds. */
  val canResend: Boolean get() = status == "failed" && failure == "E2EE_DEVICES_CHANGED" && cryptoState == "decrypted"

  /** The words of the item's body in the list. */
  val body: String
    get() {
      if (text.isNotBlank()) return text
      // The file's name, without the reference's «📎» (the owner's rule: no emoji in the app's lines).
      attachment?.let { return it["name"] as? String ?: "Файл" }
      return if (cryptoState == "decrypted") "" else "Отложено с другого устройства"
    }

  companion object {
    fun parse(row: Map<String, Any?>): ScheduledItem? {
      val id = row["id"] as? String ?: return null
      val chatId = row["chatId"] as? String ?: return null
      val clientId = row["clientId"] as? String ?: return null
      return ScheduledItem(id, chatId, clientId, row["deliverAt"] as? String ?: "", row["status"] as? String ?: "scheduled", row["failure"] as? String,
        row["createdAt"] as? String ?: "", encrypted = Core.map(row["encrypted"] as? Map<*, *>))
    }
  }
}
