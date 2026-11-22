package com.linea.messenger

import com.linea.messenger.app.Messenger
import com.linea.messenger.chatsearch.ChatSearchScreen
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

  @Test fun initialsSplitOnAnyWhiteSpace() {
    assertEquals("ПК", Messenger.initials("Пётр Козлов"))
    assertEquals("ОС", Messenger.initials("Ольга Смирнова"))
    assertEquals("АБ", Messenger.initials("  анна\tборисова  вторая"))
    assertEquals("", Messenger.initials(""))
  }
}
