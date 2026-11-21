package com.linea.messenger

import com.linea.messenger.people.PeopleList
import com.linea.messenger.people.PeopleRules
import com.linea.messenger.people.Person
import com.linea.messenger.people.PresenceWords
import com.linea.messenger.people.ProfileWords
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The rules and the words of «Люди» and of a person's profile, as the iPhone app has them (native/ios/Sources/People). */
class PeopleRulesTest {
  private val moscow = ZoneId.of("Europe/Moscow")
  /** 10:00 in Moscow. */
  private val now = Instant.parse("2026-11-21T07:00:00Z")

  private fun person(id: String, name: String = "Имя $id", username: String = "user_$id") = Person(id, username, name, "", "", 0x5E7BFF, "")

  @Test fun aPersonAsTheServerDescribesThem() {
    val full = Person.from(mapOf("id" to "u1", "username" to "alisa_v", "displayName" to "Алиса Воронцова", "bio" to "о себе", "birthday" to "1999-03-02",
      "avatarColor" to "#F2A33C", "avatarId" to "файл 1", "extra" to 5.0))!!
    assertEquals(Person("u1", "alisa_v", "Алиса Воронцова", "о себе", "1999-03-02", 0xF2A33C, "файл 1"), full)
    // What is missing is empty; a colour that is not one is the app's blue.
    assertEquals(Person("u2", "", "", "", "", 0x5E7BFF, ""), Person.from(mapOf("id" to "u2", "avatarColor" to "red")))
    assertNull(Person.from(mapOf("username" to "nobody")))
    assertNull(Person.from(mapOf("id" to "")))
    assertNull(Person.from("u1"))
    assertNull(Person.from(null))
    assertEquals(listOf("u1", "u3"), Person.list(listOf(mapOf("id" to "u1"), mapOf("name" to "x"), "text", mapOf("id" to "u3"))).map { it.id })
    assertEquals(emptyList<Person>(), Person.list(mapOf("id" to "u1")))
    // A request to be friends is `{user, createdAt}`.
    assertEquals(listOf("u5"), Person.requests(listOf(mapOf("user" to mapOf("id" to "u5"), "createdAt" to "2026-11-21T07:00:00.000Z"), mapOf("createdAt" to "x"), mapOf("user" to "u6"))).map { it.id })
  }

  @Test fun theBirthdayAsItIsShown() {
    fun words(birthday: String) = person("u").copy(birthday = birthday).birthdayWords
    assertEquals("2 мар", words("03-02"))
    assertEquals("2 мар 1999", words("1999-03-02"))
    assertEquals("31 дек", words("0000-12-31"))
    assertEquals("9 мая", words("05-09"))
    for (wrong in listOf("", "3-2", "13-01", "00-10", "1999-3-2", "99-03-02", "03-02-1999-1", "ab-cd", "03-0٢", "03")) assertEquals(wrong, "", words(wrong))
  }

  @Test fun whenAPersonWasInTheLine() {
    fun text(presence: Map<String, Any?>?) = PresenceWords.text(presence, now, moscow)
    fun seen(at: String) = text(mapOf("userId" to "u", "online" to false, "lastSeenAt" to at))
    assertNull(text(null))
    assertEquals("в сети", text(mapOf("online" to true, "lastSeenAt" to "2026-11-20T07:00:00.000Z")))
    // A person who hides the time shows only roughly when.
    assertEquals("был(а) недавно", text(mapOf("hidden" to true, "approx" to "recently", "online" to true)))
    assertEquals("был(а) на этой неделе", text(mapOf("hidden" to true, "approx" to "week")))
    assertEquals("был(а) в этом месяце", text(mapOf("hidden" to true, "approx" to "month")))
    assertEquals("был(а) давно", text(mapOf("hidden" to true, "approx" to "long")))
    assertEquals("был(а) недавно", text(mapOf("hidden" to true)))
    assertEquals("был(а) недавно", text(mapOf("online" to false)))
    assertEquals("был(а) недавно", text(mapOf("online" to false, "lastSeenAt" to "не время")))
    assertEquals("был(а) только что", seen("2026-11-21T06:59:30.000Z"))
    assertEquals("был(а) только что", seen("2026-11-21T07:00:20.000Z"))
    assertEquals("был(а) 1 минуту назад", seen("2026-11-21T06:59:00.000Z"))
    assertEquals("был(а) 3 минуты назад", seen("2026-11-21T06:57:00Z"))
    assertEquals("был(а) 5 минут назад", seen("2026-11-21T06:55:00.000Z"))
    assertEquals("был(а) 11 минут назад", seen("2026-11-21T06:49:00.000Z"))
    assertEquals("был(а) 21 минуту назад", seen("2026-11-21T06:39:00.000Z"))
    assertEquals("был(а) 59 минут назад", seen("2026-11-21T06:00:01.000Z"))
    assertEquals("был(а) 1 час назад", seen("2026-11-21T06:00:00.000Z"))
    assertEquals("был(а) 2 часа назад", seen("2026-11-21T04:30:00.000Z"))
    // Three hours and more, but still today in Moscow: the clock.
    assertEquals("был(а) сегодня в 06:59", seen("2026-11-21T03:59:00.000Z"))
    assertEquals("был(а) сегодня в 00:00", seen("2026-11-20T21:00:00.000Z"))
    assertEquals("был(а) вчера в 23:59", seen("2026-11-20T20:59:00.000Z"))
    assertEquals("был(а) вчера в 00:05", seen("2026-11-19T21:05:00.000Z"))
    assertEquals("был(а) 19.11.26", seen("2026-11-19T20:59:00.000Z"))
    assertEquals("был(а) 02.03.25", seen("2025-03-02T10:00:00.000Z"))
  }

  @Test fun theListOfPeople() {
    val friends = listOf(person("f1"), person("f2"))
    val incoming = listOf(person("i1"))
    val outgoing = listOf(person("o1"), person("o2"))
    fun kinds(items: List<PeopleList.Item>) = items.map { item ->
      when (item) {
        is PeopleList.Item.Label -> item.words
        is PeopleList.Item.Notice -> "! " + item.words
        is PeopleList.Item.Request -> (if (item.incoming) "< " else "> ") + item.person.id
        is PeopleList.Item.Friend -> item.person.id
        is PeopleList.Item.Empty -> item.heading + " | " + item.words
      }
    }
    // No search: the requests that came, those that were sent, then the friends.
    assertEquals(listOf("ЗАЯВКИ В ДРУЗЬЯ  1", "< i1", "ОТПРАВЛЕННЫЕ  2", "> o1", "> o2", "ДРУЗЬЯ  2", "f1", "f2"),
      kinds(PeopleList.items("", "", false, incoming, outgoing, friends, emptyList())))
    // One character is not a search yet.
    assertEquals(listOf("ДРУЗЬЯ  2", "f1", "f2"), kinds(PeopleList.items("@", "", false, emptyList(), emptyList(), friends, listOf(person("x")))))
    assertEquals(listOf("Кому напишем? | Введи @имя целиком или его первые 4 символа, либо имя полностью."),
      kinds(PeopleList.items("", "", false, emptyList(), emptyList(), emptyList(), emptyList())))
    // Requests stay above the empty words.
    assertEquals(listOf("ЗАЯВКИ В ДРУЗЬЯ  1", "< i1", "Кому напишем? | Введи @имя целиком или его первые 4 символа, либо имя полностью."),
      kinds(PeopleList.items("", "", false, incoming, emptyList(), emptyList(), emptyList())))
    // A search shows what was found and nothing of the requests or the friends.
    assertEquals(listOf("РЕЗУЛЬТАТЫ ПОИСКА", "x"), kinds(PeopleList.items("@al", "", false, incoming, outgoing, friends, listOf(person("x")))))
    // While the answer is awaited nothing is said of an empty list.
    assertEquals(emptyList<String>(), kinds(PeopleList.items("alisa", "", true, incoming, outgoing, friends, emptyList())))
    assertEquals(listOf("Пока никого | По началу @имени ищется с 4 символов. Введи ещё или напиши @имя целиком."),
      kinds(PeopleList.items("@ali", "", false, incoming, outgoing, friends, emptyList())))
    assertEquals(listOf("Пока никого | По этому запросу никого нет. Проверь написание @имени."),
      kinds(PeopleList.items("@alis", "", false, incoming, outgoing, friends, emptyList())))
    assertEquals(listOf("Пока никого | По началу @имени ищется с 4 символов. Введи ещё или напиши @имя целиком."),
      kinds(PeopleList.items("али", "", false, incoming, outgoing, friends, emptyList())))
    // What did not work is said first.
    assertEquals(listOf("! Нет связи с сервером.", "ДРУЗЬЯ  2", "f1", "f2"), kinds(PeopleList.items("", "Нет связи с сервером.", false, emptyList(), emptyList(), friends, emptyList())))
    assertEquals("@user_i1", PeopleList.requestHandle(person("i1"), incoming = true))
    assertEquals("@user_o1 · Ждёт ответа", PeopleList.requestHandle(person("o1"), incoming = false))
    assertTrue(PeopleList.isSearch("ab") && !PeopleList.isSearch("a"))
  }

  @Test fun theAnswersOfTheServer() {
    val profile = PeopleRules.profile(mapOf("user" to mapOf("id" to "u1", "displayName" to "Алиса"), "isContact" to true, "friendRequest" to null, "chatId" to "c1", "blocked" to false))!!
    assertEquals(listOf("u1", true, null, "c1", false), listOf(profile.person.id, profile.isFriend, profile.request, profile.chatId, profile.blocked))
    val asked = PeopleRules.profile(mapOf("user" to mapOf("id" to "u2"), "friendRequest" to "incoming", "blocked" to true))!!
    assertEquals(listOf(false, "incoming", null, true), listOf(asked.isFriend, asked.request, asked.chatId, asked.blocked))
    assertEquals("outgoing", PeopleRules.profile(mapOf("user" to mapOf("id" to "u2"), "friendRequest" to "outgoing"))!!.request)
    // Any other word about a request is no request.
    assertNull(PeopleRules.profile(mapOf("user" to mapOf("id" to "u2"), "friendRequest" to "friends"))!!.request)
    assertNull(PeopleRules.profile(mapOf("isContact" to true)))

    val chat = PeopleRules.chat(mapOf("chat" to mapOf("id" to "c7", "peer" to mapOf("id" to "u9", "displayName" to "Лев"), "peerLastReadMessageId" to 41.0)), "u1")!!
    assertEquals(listOf("c7", "u9", "Лев", 41L), listOf(chat.chatId, chat.peerId, chat.name, chat.peerLastRead))
    // Without the other side in the answer the chat is with the person it was asked for.
    val bare = PeopleRules.chat(mapOf("chat" to mapOf("id" to "c8")), "u1")!!
    assertEquals(listOf("c8", "u1", "", 0L), listOf(bare.chatId, bare.peerId, bare.name, bare.peerLastRead))
    assertNull(PeopleRules.chat(mapOf("chat" to mapOf("peer" to mapOf("id" to "u9"))), "u1"))
    assertNull(PeopleRules.chat(emptyMap(), "u1"))
  }

  @Test fun theWordsOfAProfile() {
    assertEquals("person.plus" to "В друзья", ProfileWords.friendTile(false, null))
    assertEquals("person.plus" to "В друзья", ProfileWords.friendTile(null, null))
    assertEquals("person.minus" to "В друзьях", ProfileWords.friendTile(true, null))
    assertEquals("clock" to "Заявка", ProfileWords.friendTile(false, "outgoing"))
    assertEquals("person.plus" to "Принять", ProfileWords.friendTile(false, "incoming"))
    assertEquals("Удалить из друзей", ProfileWords.friendMenu(true, null))
    assertEquals("Отменить заявку", ProfileWords.friendMenu(false, "outgoing"))
    assertEquals("Принять в друзья", ProfileWords.friendMenu(false, "incoming"))
    assertEquals("Добавить в друзья", ProfileWords.friendMenu(false, null))
    assertEquals("Заблокирован: он не сможет тебе писать и звонить", ProfileWords.blocked(true))
    assertEquals("Разблокирован", ProfileWords.blocked(false))
    assertEquals(listOf("spam", "scam", "abuse", "violence", "sexual", "illegal", "other"), ProfileWords.reasons.map { it.first })
    assertEquals(listOf("Спам", "Мошенничество", "Оскорбления и травля", "Насилие", "Откровенный контент", "Незаконное", "Другое"), ProfileWords.reasons.map { it.second })
  }
}
