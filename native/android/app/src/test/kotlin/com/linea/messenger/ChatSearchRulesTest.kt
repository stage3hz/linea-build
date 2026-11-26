package com.linea.messenger

import com.linea.messenger.app.Messenger
import com.linea.messenger.chatsearch.ChatSearchScreen
import com.linea.messenger.chatsplus.BarHintView
import com.linea.messenger.people.Person
import org.junit.Assert.assertEquals
import org.junit.Test

/** ChatSearch and Avatars: the search screen's rules (the iPhone's Sources/ChatSearch/ChatSearchScreen.swift, the
 *  reference's ChatSearch.tsx) and the initials of a person without a picture. */
class ChatSearchRulesTest {
  @Test fun scopesAndWords() {
    assertEquals(listOf("Чаты", "Сообщения", "Люди", "Каналы"), ChatSearchScreen.scopes.map { it.second })
    // «Недавние» is kept under the reference's key, per account.
    assertEquals("linea.recent-search.v1:u1", ChatSearchScreen.recentKey("u1"))
    assertEquals("Введи хотя бы 2 буквы @имени.", ChatSearchScreen.emptyWords("м", ChatSearchScreen.Scope.PEOPLE))
    assertEquals("Ничего не нашли.", ChatSearchScreen.emptyWords("мар", ChatSearchScreen.Scope.PEOPLE))
    assertEquals("В сохранённой на этом устройстве переписке такого нет.", ChatSearchScreen.emptyWords("мар", ChatSearchScreen.Scope.MESSAGES))
    assertEquals("Здесь появятся чаты и каналы, которые ты открывал из поиска.", ChatSearchScreen.emptyWords("", ChatSearchScreen.Scope.CHATS))
    assertEquals("Поиск по тексту сообщений и имени отправителя. История хранится только на этом устройстве.", ChatSearchScreen.emptyWords("", ChatSearchScreen.Scope.MESSAGES))
  }

  @Test fun snippets() {
    assertEquals("Привет, как дела?", ChatSearchScreen.snippet("Привет,\n  как   дела?", "как"))
    val long = "а".repeat(40) + " встреча завтра"
    val cut = ChatSearchScreen.snippet(long, "встреча")
    assertEquals('…', cut.first())
    assertEquals(true, cut.contains("встреча завтра"))
    assertEquals(90, ChatSearchScreen.snippet("б".repeat(200), "нет").length)
  }

  @Test fun recentKeepsFifteenNewestFirst() {
    fun user(id: String) = mapOf<String, Any?>("kind" to "user", "user" to mapOf("id" to id))
    fun community(id: String) = mapOf<String, Any?>("kind" to "community", "community" to mapOf("id" to id))
    assertEquals("u:a", ChatSearchScreen.recentId(user("a")))
    assertEquals("c:a", ChatSearchScreen.recentId(community("a")))
    var list: List<Map<String, Any?>> = emptyList()
    for (i in 1..20) list = ChatSearchScreen.remembered(list, user("p$i"))
    assertEquals(15, list.size)
    assertEquals("u:p20", ChatSearchScreen.recentId(list.first()))
    list = ChatSearchScreen.remembered(list, user("p10"))
    assertEquals(listOf("u:p10", "u:p20"), list.take(2).map { ChatSearchScreen.recentId(it) })
    assertEquals(15, list.size)
  }

  @Test fun peopleAreFoundWithTheChats() {
    fun person(id: String, name: String, username: String) = Person(id, username, name, "", "", 0x4B73BB, "")
    val anna = person("a", "Анна Петрова", "anna")
    val boris = person("b", "Борис", "bor1s")
    val me = person("me", "Анна Я", "anna_me")
    // A leading «@» asks for the @имя; the name and the @имя are both looked in, in any case.
    assertEquals(true, ChatSearchScreen.matches(anna, "анна"))
    assertEquals(true, ChatSearchScreen.matches(anna, "@ANNA"))
    assertEquals(true, ChatSearchScreen.matches(boris, "bor"))
    assertEquals(false, ChatSearchScreen.matches(boris, "@"))
    assertEquals(false, ChatSearchScreen.matches(boris, "анна"))
    // Friends first, then what the server found; each once, not those with a chat here, not this account.
    val server = listOf(person("c", "Анна", "annushka"), anna, me)
    assertEquals(listOf("a", "c"), ChatSearchScreen.morePeople("анна", emptySet(), listOf(anna, boris, me), server, "me").map { it.id })
    assertEquals(listOf("c"), ChatSearchScreen.morePeople("анна", setOf("a"), listOf(anna), server, "me").map { it.id })
    // One letter: no server search (as the reference's «Люди»), friends still are.
    assertEquals(listOf("a"), ChatSearchScreen.morePeople("а", emptySet(), listOf(anna), server, "me").map { it.id })
    // The server's answer not here yet: the friends alone.
    assertEquals(listOf("b"), ChatSearchScreen.morePeople("бор", emptySet(), listOf(anna, boris), null, "me").map { it.id })
  }

  @Test fun holdHintShowsOnSixStartsUntilUsed() {
    assertEquals("linea.hint.bar-scrub.v2", BarHintView.KEY)
    assertEquals(true to "1", BarHintView.decide(null))
    assertEquals(true to "1", BarHintView.decide(""))
    assertEquals(true to "6", BarHintView.decide("5"))
    assertEquals(false to null, BarHintView.decide("6"))
    assertEquals(false to null, BarHintView.decide("used"))
  }

  @Test fun initialsSplitOnAnyWhiteSpace() {
    assertEquals("ПК", Messenger.initials("Пётр Козлов"))
    assertEquals("ОС", Messenger.initials("Ольга Смирнова"))
    assertEquals("АБ", Messenger.initials("  анна\tборисова  вторая"))
    assertEquals("", Messenger.initials(""))
  }
}
