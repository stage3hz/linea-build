package com.linea.messenger.people

import com.linea.messenger.app.Messenger
import com.linea.messenger.core.Core
import java.time.Instant
import java.time.ZoneId

/** A person as the server describes them to this account (`User` of the reference's types.ts — the part the
 *  native screens show so far). */
data class Person(
  val id: String,
  val username: String,
  val displayName: String,
  val bio: String,
  /** «MM-DD» or «YYYY-MM-DD»; empty when not set. */
  val birthday: String,
  /** 0xRRGGBB. */
  val avatarColor: Int,
  /** Empty when there is no picture (or the person does not show it to this account). */
  val avatarId: String,
) {
  /** The birthday as the reference shows it (birthday.ts `formatBirthday`): «2 мар» or «2 мар 1999». */
  val birthdayWords: String
    get() {
      val parts = birthday.split('-').filter { it.isNotEmpty() }
      if (parts.size != 2 && parts.size != 3) return ""
      if (!parts.all { part -> part.all { it in '0'..'9' } }) return ""
      val monthText = parts[parts.size - 2]; val dayText = parts[parts.size - 1]
      if (monthText.length != 2 || dayText.length != 2) return ""
      val month = monthText.toInt(); val day = dayText.toInt()
      if (month < 1 || month > 12) return ""
      if (parts.size == 3) {
        if (parts[0].length != 4) return ""
        val year = parts[0].toInt()
        return if (year == 0) "$day ${months[month - 1]}" else "$day ${months[month - 1]} $year"
      }
      return "$day ${months[month - 1]}"
    }

  companion object {
    private val months = listOf("янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек")

    /** Null for what is not a person (no id). */
    fun from(raw: Any?): Person? {
      val fields = Core.map(raw as? Map<*, *>) ?: return null
      val id = fields["id"] as? String ?: return null
      if (id.isEmpty()) return null
      return Person(
        id, fields["username"] as? String ?: "", fields["displayName"] as? String ?: "", fields["bio"] as? String ?: "",
        fields["birthday"] as? String ?: "", Messenger.color(fields["avatarColor"] as? String), fields["avatarId"] as? String ?: "",
      )
    }

    fun list(raw: Any?): List<Person> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }

    /** The people of a list of friend requests (`FriendRequest` of the reference: `{user, createdAt}`). */
    fun requests(raw: Any?): List<Person> = (raw as? List<*>).orEmpty().mapNotNull { from(Core.map(it as? Map<*, *>)?.get("user")) }
  }
}

/** «в сети», «был(а) 5 минут назад», «был(а) вчера в 21:04», «был(а) недавно» — the reference's presence.ts
 *  `presenceText`, word for word. The item is the server's `presence` as the live line delivers it. */
object PresenceWords {
  private val approx = mapOf(
    "recently" to "был(а) недавно",
    "week" to "был(а) на этой неделе",
    "month" to "был(а) в этом месяце",
    "long" to "был(а) давно",
  )

  private fun plural(n: Long, one: String, few: String, many: String): String {
    if (n % 10 == 1L && n % 100 != 11L) return one
    if (n % 10 in 2..4 && (n % 100 < 10 || n % 100 >= 20)) return few
    return many
  }

  private fun pad(n: Int): String = if (n < 10) "0$n" else "$n"

  fun text(presence: Map<String, Any?>?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
    if (presence == null) return null
    if (presence["hidden"] == true) return approx[presence["approx"] as? String ?: ""] ?: "был(а) недавно"
    if (presence["online"] == true) return "в сети"
    val stamp = presence["lastSeenAt"] as? String
    val seen = (if (stamp.isNullOrEmpty()) null else Messenger.date(stamp)) ?: return "был(а) недавно"
    val diff = now.toEpochMilli() - seen.toEpochMilli()
    if (diff < 60_000) return "был(а) только что"
    if (diff < 3_600_000) {
      val minutes = diff / 60_000
      return "был(а) $minutes ${plural(minutes, "минуту", "минуты", "минут")} назад"
    }
    val parts = seen.atZone(zone)
    val time = "${pad(parts.hour)}:${pad(parts.minute)}"
    val today = now.atZone(zone).toLocalDate().atStartOfDay(zone).toInstant()
    if (!seen.isBefore(today)) {
      val hours = diff / 3_600_000
      return if (hours < 3) "был(а) $hours ${plural(hours, "час", "часа", "часов")} назад" else "был(а) сегодня в $time"
    }
    if (!seen.isBefore(today.minusSeconds(86_400))) return "был(а) вчера в $time"
    return "был(а) ${pad(parts.dayOfMonth)}.${pad(parts.monthValue)}.${pad(parts.year % 100)}"
  }
}
