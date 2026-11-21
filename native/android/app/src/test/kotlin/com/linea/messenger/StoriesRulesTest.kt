package com.linea.messenger

import com.linea.messenger.design.orbPair
import com.linea.messenger.people.Person
import com.linea.messenger.stories.ProfilePostsData
import com.linea.messenger.stories.StoryBarsView
import com.linea.messenger.stories.StoryGrid
import com.linea.messenger.stories.StoryPost
import com.linea.messenger.stories.StoryPrepare
import com.linea.messenger.stories.StoryQuote
import com.linea.messenger.stories.StoryRingColors
import com.linea.messenger.stories.StoryViewersData
import com.linea.messenger.stories.StripShown
import com.linea.messenger.stories.storyReplyMeta
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stories and profile posts: the rules that need no phone and no core — how the server's answers are read, what
 *  a chosen file is taken for, the size a photo goes up at, the arithmetic of the grid, the bars and the ring. */
class StoriesRulesTest {
  private fun post(id: String, kind: String = "story", video: Boolean = false, extra: Map<String, Any?> = emptyMap()): Map<String, Any?> =
    mapOf("id" to id, "kind" to kind, "caption" to "", "createdAt" to "2026-11-21T06:00:00.000Z",
      "media" to mapOf("id" to "file-$id", "mimeType" to (if (video) "video/mp4" else "image/jpeg"), "isVideo" to video)) + extra

  @Test fun aPostIsReadAsTheServerSendsIt() {
    val story = StoryPost.from(post("s1", extra = mapOf("caption" to "Утро", "views" to 12.0, "seen" to true)))!!
    assertEquals(StoryPost("s1", "story", "Утро", "2026-11-21T06:00:00.000Z", "file-s1", isVideo = false, views = 12, seen = true), story)
    // What the server leaves out: a post, not seen, nobody counted.
    assertEquals(StoryPost("p1", "post", "", "", "", isVideo = false, views = null, seen = false), StoryPost.from(mapOf("id" to "p1")))
    assertTrue(StoryPost.from(post("v1", video = true))!!.isVideo)
    for (bad in listOf<Any?>(null, "s1", emptyMap<String, Any?>(), mapOf("id" to ""), mapOf("id" to 5.0))) assertNull(StoryPost.from(bad))
    assertEquals(listOf("s1", "s2"), StoryPost.list(listOf(post("s1"), "junk", mapOf("kind" to "story"), post("s2"))).map { it.id })
    assertEquals(emptyList<StoryPost>(), StoryPost.list(null))
  }

  @Test fun aProfilesPostsAndAStorysViewers() {
    val data = ProfilePostsData.from(mapOf("visible" to true, "posts" to listOf(post("p1", "post"), post("p2", "post")), "stories" to listOf(post("s1"))))
    assertEquals(listOf(true, listOf("p1", "p2"), listOf("s1")), listOf(data.visible, data.posts.map { it.id }, data.stories.map { it.id }))
    // No word about it: closed.
    assertFalse(ProfilePostsData.from(emptyMap()).visible)

    val alisa = mapOf("id" to "a", "username" to "alisa_v", "displayName" to "Алиса Воронцова", "avatarColor" to "#5E7BFF")
    val watched = StoryViewersData.from(mapOf("count" to 7.0, "viewers" to listOf(mapOf("user" to alisa, "viewedAt" to "2026-11-21T06:05:00.000Z"), mapOf("viewedAt" to "x"), "junk")))
    assertEquals(listOf(7, 1, "Алиса Воронцова", 0x5E7BFF, "2026-11-21T06:05:00.000Z"),
      listOf(watched.count, watched.rows.size, watched.rows[0].person.displayName, watched.rows[0].person.avatarColor, watched.rows[0].viewedAt))
    // Without the count: as many as there are rows.
    assertEquals(1, StoryViewersData.from(mapOf("viewers" to listOf(mapOf("user" to alisa)))).count)
    assertEquals(0, StoryViewersData.from(emptyMap()).count)
  }

  @Test fun theStoryAQuotePointsAt() {
    val data = ProfilePostsData(true, emptyList(), listOf(StoryPost.from(post("s1"))!!, StoryPost.from(post("s2"))!!))
    assertEquals(1, StoryQuote.find(data, "s2"))
    assertNull(StoryQuote.find(data, "s9"))                                   // gone after its 24 hours
    assertNull(StoryQuote.find(ProfilePostsData(false, emptyList(), data.stories), "s2"))   // may not be seen any more
    assertNull(StoryQuote.find(null, "s2"))
  }

  @Test fun anAnswerToAStoryCarriesItsReferenceInsideTheMessage() {
    assertEquals(mapOf("story" to mapOf("id" to "s2", "ownerId" to "a")), storyReplyMeta(authorId = "a", storyId = "s2"))
  }

  @Test fun theStripIsThePeopleTheCoreNamesAndThisPhoneKnows() {
    val known = mapOf("a" to Person("a", "alisa_v", "Алиса Воронцова", "", "", 0x5E7BFF, ""), "l" to Person("l", "lev_m", "Лев", "", "", 0x4FB86A, ""))
    val made = mapOf<String, Any?>("show" to true, "mine" to mapOf("has" to true, "label" to "Моя история", "spoken" to "Моя история"), "people" to listOf(
      mapOf("id" to "a", "name" to "Алиса", "spoken" to "Алиса Воронцова, новых историй: 2", "post" to false, "pending" to false, "fresh" to true, "sub" to ""),
      mapOf("id" to "stranger", "name" to "Кто-то", "spoken" to "Кто-то", "post" to false, "pending" to false, "fresh" to true, "sub" to ""),
      mapOf("id" to "l", "post" to true, "pending" to true, "fresh" to false, "sub" to "запись"),
    ))
    val shown = StripShown.from(made, known)
    assertEquals(listOf(true, true, "Моя история"), listOf(shown.show, shown.mineHas, shown.mineSpoken))
    assertEquals(listOf("a", "l"), shown.people.map { it.person.id })
    assertEquals(listOf("Алиса", "Алиса Воронцова, новых историй: 2", false, false, true, ""), shown.people[0].let { listOf(it.name, it.spoken, it.post, it.pending, it.fresh, it.sub) })
    // Without the core's words: the person's own name.
    assertEquals(listOf("Лев", "Лев", true, true, false, "запись"), shown.people[1].let { listOf(it.name, it.spoken, it.post, it.pending, it.fresh, it.sub) })
    assertEquals(listOf(false, false, "", 0), StripShown.from(emptyMap(), known).let { listOf(it.show, it.mineHas, it.mineSpoken, it.people.size) })
  }

  @Test fun whatAChosenFileIsTakenFor() {
    assertEquals("video", StoryPrepare.kind("video/mp4", picture = false, video = false))
    assertEquals("video", StoryPrepare.kind("video/quicktime", picture = true, video = false))
    assertEquals("photo", StoryPrepare.kind("image/heic", picture = false, video = false))
    // The system does not say: the bytes do.
    assertEquals("photo", StoryPrepare.kind(null, picture = true, video = false))
    assertEquals("video", StoryPrepare.kind("application/octet-stream", picture = false, video = true))
    assertEquals("", StoryPrepare.kind("application/pdf", picture = false, video = false))
    assertEquals("", StoryPrepare.kind(null, picture = false, video = false))
  }

  @Test fun theSizeAPhotoGoesUpAt() {
    assertEquals(Pair(1600, 1200), StoryPrepare.photoSize(4000, 3000, 1600))
    assertEquals(Pair(1600, 2844), StoryPrepare.photoSize(2160, 3840, 1600))
    assertEquals(Pair(1200, 900), StoryPrepare.photoSize(1200, 900, null))
    // The width the core names never makes a picture bigger.
    assertEquals(Pair(800, 600), StoryPrepare.photoSize(800, 600, 1600))
    // Never more than 16 million pixels, however tall.
    val huge = StoryPrepare.photoSize(20000, 20000, null)!!
    assertTrue(huge.first == huge.second && huge.first in 3999..4000)
    val tall = StoryPrepare.photoSize(1600, 20000, null)!!
    assertEquals(Pair(1131, 14142), tall)
    assertTrue(tall.first.toLong() * tall.second <= 16_000_000)
    for ((width, height) in listOf(0 to 10, 10 to 0, -1 to 10, 20001 to 10, 10 to 20001)) assertNull(StoryPrepare.photoSize(width, height, 1600))
  }

  @Test fun threeTilesInARow() {
    assertEquals(356, StoryGrid.side(1080, 3, 6))
    assertEquals(listOf(0, 356, 356, 356, 718, 1080), listOf(0, 1, 2, 3, 4, 8).map { StoryGrid.height(it, 356, 3, 6) })
    assertEquals(listOf(Pair(0, 0), Pair(362, 0), Pair(724, 0), Pair(0, 362), Pair(362, 362)), (0..4).map { StoryGrid.corner(it, 356, 3, 6) })
    // The last tile of a full row ends at the block's edge.
    assertEquals(1080, StoryGrid.corner(2, 356, 3, 6).first + 356)
  }

  @Test fun theBarsOnTopShareTheRow() {
    assertEquals(listOf(Pair(0f, 97f), Pair(101f, 97f), Pair(303f, 97f)), listOf(0, 1, 3).map { StoryBarsView.track(400f, 4, it, 1f) })
    assertEquals(Pair(0f, 400f), StoryBarsView.track(400f, 1, 0, 1f))
    // Many stories: the gaps give way before the bars vanish.
    val many = StoryBarsView.track(310f, 31, 30, 1f)
    assertEquals(310f, many.first + many.second, 0.01f)
    assertEquals((310f - 60f) / 31f, many.second, 0.001f)
    // And a bar is never thinner than a pixel.
    assertEquals(1f, StoryBarsView.track(100f, 200, 0, 1f).second, 0f)
  }

  @Test fun theRingIsLitByThePersonsOwnColour() {
    val blue = StoryRingColors.of(0x5E7BFF, fresh = true, dark = true)
    val pair = orbPair(0x5E7BFF)
    assertArrayEquals(intArrayOf(pair.first, 0xFF5E7BFF.toInt(), pair.second), blue)
    // The theme does not change a lit ring; another person has another light.
    assertArrayEquals(blue, StoryRingColors.of(0x5E7BFF, fresh = true, dark = false))
    assertArrayEquals(blue, StoryRingColors.of(0xFF5E7BFF.toInt(), fresh = true, dark = true))
    val orange = StoryRingColors.of(0xF2A33C, fresh = true, dark = true)
    assertEquals(0xFFF2A33C.toInt(), orange[1])
    for (index in 0..2) assertNotEquals(blue[index], orange[index])
    // Everything watched: one quiet grey of the theme, whoever it is.
    assertArrayEquals(intArrayOf(0x73ABBCD6, 0x73ABBCD6), StoryRingColors.of(0x5E7BFF, fresh = false, dark = true))
    assertArrayEquals(intArrayOf(0x665C6E88, 0x665C6E88), StoryRingColors.of(0xF2A33C, fresh = false, dark = false))
  }
}
