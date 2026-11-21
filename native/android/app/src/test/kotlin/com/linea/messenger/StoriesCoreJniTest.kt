package com.linea.messenger

import com.linea.messenger.core.Core
import com.linea.messenger.people.Person
import com.linea.messenger.stories.SeenPosts
import com.linea.messenger.stories.StoryPrepare
import com.linea.messenger.stories.StoryRules
import com.linea.messenger.stories.StoryViewerRow
import com.linea.messenger.stories.StripShown
import com.linea.messenger.video.VideoPrepare
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

/** Stories and profile posts: Kotlin ↔ the core through JNI, for real — the very names the app asks by
 *  (`Core.view("stories…")`), in the core built for this machine (native/android/build-core-host.sh). Skipped
 *  when that library has not been built. The same rules are pinned to the reference's answers in
 *  native/core/tests/stories_vectors.rs. */
class StoriesCoreJniTest {
  /** Saturday 21 November 2026, 12:00 in Moscow. */
  private val now = Instant.parse("2026-11-21T09:00:00Z").toEpochMilli()
  private val me = "me"

  private fun user(id: String, name: String) = mapOf("id" to id, "username" to id, "displayName" to name, "avatarColor" to "#5E7BFF")
  private fun story(id: String, seen: Boolean? = null) = mapOf("id" to id, "kind" to "story", "createdAt" to "2026-11-21T06:00:00.000Z", "media" to mapOf("id" to "f-$id")) + (if (seen == null) emptyMap() else mapOf("seen" to seen))

  /** Four people and the account's own story: unseen stories, a recent post, a waiting request, all seen. */
  private val feed: Map<String, Any?> = mapOf(
    "items" to listOf(
      mapOf("user" to user("m", "Марина Ким"), "unseen" to 0, "latest" to "2026-11-21T07:00:00.000Z", "stories" to listOf(story("m1", true))),
      mapOf("user" to user("i", "Игорь Белов"), "unseen" to 1, "pending" to true, "latest" to "2026-11-21T03:00:00.000Z", "stories" to listOf(story("i1", false))),
      mapOf("user" to user("l", "Лев"), "unseen" to 0, "latest" to "2026-11-21T05:00:00.000Z", "stories" to emptyList<Any?>(), "posts" to listOf(mapOf("id" to "p1", "kind" to "post"))),
      mapOf("user" to user("a", "Алиса Воронцова"), "unseen" to 2, "latest" to "2026-11-21T08:00:00.000Z", "stories" to listOf(story("s1", true), story("s2", false), story("s3", false))),
    ),
    "mine" to listOf(story("me1") + mapOf("views" to 12)),
  )
  private val known = listOf("a" to "Алиса Воронцова", "i" to "Игорь Белов", "l" to "Лев", "m" to "Марина Ким").associate { (id, name) -> id to Person(id, id, name, "", "", 0x5E7BFF, "") }

  private fun strip(seen: List<String>) = StripShown.from(Core.map(Core.view("storiesStrip", listOf(feed, seen, me)))!!, known)
  private fun viewer(viewing: String, entered: Int, seen: List<String> = emptyList()) = Core.map(Core.view("storiesViewer", listOf(feed, seen, me, viewing, entered)))!!

  @Test fun theWordsAndTheLimitsAreTheCores() {
    assumeTrue(Core.loaded)
    assertEquals(listOf("Моя история", "Добавить историю", "Добавить публикацию", "запись", "заявка", "Ответить…", "Ответ отправлен в чат", "Просмотры", "Пока никто не смотрел", "Видео недоступно"),
      listOf("mine", "addStory", "addPost", "post", "pending", "reply", "replySent", "views", "nobodyWatched", "videoGone").map { StoryRules.word(it) })
    assertEquals(listOf("Публикация", "История", "Удалить", "Исчезнет из профиля у всех.", "История недоступна", "Публикация — фото или видео MP4/MOV.", "Публикации и истории видны только друзьям"),
      listOf("removePost", "removeStory", "remove", "removeAbout", "storyGone", "mediaOnly", "hidden").map { StoryRules.word(it) })
    assertEquals("", StoryRules.word("no such word"))
    assertEquals(listOf(5000.0, 1500.0, 300_000.0, 220.0, 4000.0, 3.0, 2.0, 20.0 * 1024 * 1024),
      listOf("photoMs", "videoFailedMs", "refreshMs", "holdMs", "replyMax", "columns", "gap", "smallUpload").map { StoryRules.number(it, -1.0) })
    assertEquals(-1.0, StoryRules.number("no such number", -1.0), 0.0)
    assertEquals("linea.seen-posts.v1:", StoryRules.text("seenKey", ""))
  }

  @Test fun thePostsOpenedOnThisPhone() {
    assumeTrue(Core.loaded)
    val seen = SeenPosts(null, "u1")
    assertEquals("linea.seen-posts.v1:u1", seen.key)
    assertEquals(emptyList<String>(), seen.ids)
    assertTrue(seen.add(listOf("p1", "p1", "", "p2")))
    assertEquals(listOf("p1", "p2"), seen.ids)
    // Nothing new: nothing changes (and nothing is written).
    assertFalse(seen.add(listOf("p2")))
    assertFalse(seen.add(emptyList()))
    // What storage gives back is checked: strings only, each once; anything else is no list.
    assertEquals(listOf("p1", "p2"), Core.view("storiesSeenParse", listOf("[\"p1\",5,\"p1\",\"p2\",null]")))
    for (bad in listOf<Any?>(null, "", "not json", "{\"a\":1}")) assertEquals(emptyList<Any?>(), Core.view("storiesSeenParse", listOf(bad)))
    // The oldest go once there are more than the limit.
    val many = Core.view("storiesSeenAdd", listOf(List(500) { "old-$it" }, listOf("new"))) as List<*>
    assertEquals(listOf(500, "old-1", "new"), listOf(many.size, many.first(), many.last()))
  }

  @Test fun theStripPutsWhatIsNewFirst() {
    assumeTrue(Core.loaded)
    val shown = strip(emptyList())
    assertEquals(listOf(true, true, "Моя история"), listOf(shown.show, shown.mineHas, shown.mineSpoken))
    // Something unseen first, the newest of them leading; then those all seen.
    assertEquals(listOf("a", "l", "i", "m"), shown.people.map { it.person.id })
    assertEquals(listOf("Алиса", "Лев", "Игорь", "Марина"), shown.people.map { it.name })
    assertEquals(listOf("Алиса Воронцова, новых историй: 2", "Лев, запись", "Игорь Белов, новых историй: 1, заявка", "Марина Ким, истории просмотрены"), shown.people.map { it.spoken })
    assertEquals(listOf("", "запись", "заявка", ""), shown.people.map { it.sub })
    assertEquals(listOf(true, true, true, false), shown.people.map { it.fresh })
    assertEquals(listOf(false, true, false, false), shown.people.map { it.post })
    assertEquals(listOf(false, false, true, false), shown.people.map { it.pending })
    // The post was opened on this phone: its ring goes grey and the person moves behind.
    val later = strip(listOf("p1"))
    assertEquals(listOf("a", "i", "m", "l"), later.people.map { it.person.id })
    assertEquals(listOf(true, true, false, false), later.people.map { it.fresh })
    // Nobody has anything: no strip; the account alone is asked to add a story.
    val none = Core.map(Core.view("storiesStrip", listOf(mapOf("items" to emptyList<Any?>(), "mine" to emptyList<Any?>()), emptyList<String>(), me)))!!
    assertEquals(listOf(false, mapOf("has" to false, "label" to "Моя история", "spoken" to "Добавить историю")), listOf(none["show"], none["mine"]))
    // A feed that is not one has no answer.
    assertNull(Core.view("storiesStrip", listOf(mapOf("items" to "x"), emptyList<String>(), me)))
  }

  @Test fun whoseStoriesTheViewerPlaysAndWhereItStarts() {
    assumeTrue(Core.loaded)
    // A friend's stories start at the first one not watched; the neighbours are those of the strip.
    assertEquals(mapOf("open" to true, "own" to false, "posts" to false, "items" to listOf("s1", "s2", "s3"), "start" to 1.0, "before" to "me", "after" to "l"), viewer("a", 1))
    // Coming back from the next person: the last one.
    assertEquals(2.0, viewer("a", -1)["start"])
    assertEquals(mapOf("open" to true, "own" to true, "posts" to false, "items" to listOf("me1"), "start" to 0.0, "before" to null, "after" to "a"), viewer(me, 1))
    // A person shown for a post: their recent posts, from the first.
    assertEquals(listOf(true, true, listOf("p1"), 0.0, "a", "i"), viewer("l", 1).let { listOf(it["open"], it["posts"], it["items"], it["start"], it["before"], it["after"]) })
    assertEquals(listOf("i", null), viewer("m", 1).let { listOf(it["before"], it["after"]) })
    assertEquals(false, viewer("nobody", 1)["open"])

    // A watched story: seen, and one unseen less — once.
    val watched = Core.map(Core.view("storiesViewed", listOf(feed, "a", "s2")))!!
    val alisa = (watched["items"] as List<*>).mapNotNull { Core.map(it) }.first { Core.map(it["user"])!!["id"] == "a" }
    assertEquals(listOf(1.0, listOf(true, true, false)), listOf(alisa["unseen"], (alisa["stories"] as List<*>).map { Core.map(it)!!["seen"] }))
    assertNull(Core.view("storiesViewed", listOf(watched, "a", "s2")))
    assertNull(Core.view("storiesViewed", listOf(feed, "a", "s1")))
    assertNull(Core.view("storiesViewed", listOf(feed, "nobody", "s2")))
    assertEquals(2.0, Core.map(Core.view("storiesViewer", listOf(watched, emptyList<String>(), me, "a", 1)))!!["start"])
  }

  @Test fun theViewersWordsAndSwipes() {
    assumeTrue(Core.loaded)
    fun headline(created: String, story: Boolean, index: Int, count: Int) = Core.view("storiesHeadline", listOf(created, now, story, index, count))
    assertEquals(listOf("3 ч назад", "только что", "2 из 7"),
      listOf(headline("2026-11-21T06:00:00.000Z", true, 0, 3), headline("2026-11-21T08:40:00.000Z", true, 0, 3), headline("2026-11-21T06:00:00.000Z", false, 1, 7)))

    // The finger's way is given in dp, as the iPhone gives points.
    assertEquals(listOf("x", "y"), listOf(Core.view("storiesAxis", listOf(30f, -10f)), Core.view("storiesAxis", listOf(4f, 12f))))
    fun swipe(axis: String, tx: Float, ty: Float, vx: Float = 0f, vy: Float = 0f) = Core.view("storiesSwipe", listOf(axis, tx, ty, vx, vy, 400f))
    assertEquals(listOf("next", "previous", "cancel", "cancel"), listOf(swipe("x", -120f, 0f, vx = -100f), swipe("x", 150f, 0f), swipe("x", -40f, 0f), swipe("x", -150f, 0f, vx = 500f)))
    assertEquals(listOf("close", "up", "cancel", "next"), listOf(swipe("y", 0f, 130f), swipe("y", 0f, -70f), swipe("y", 0f, 20f), swipe("x", -20f, 0f, vx = -700f)))
    assertNull(swipe("z", 0f, 0f))
    // While it is dragged: down it follows and shrinks, sideways past the edge it gives a third.
    assertEquals(mapOf("x" to 0.0, "y" to 200.0, "progress" to 0.5), Core.view("storiesDrag", listOf("y", 0f, 200f, true, false, 800f)))
    assertEquals(mapOf("x" to 30.0, "y" to 0.0, "progress" to 0.0), Core.view("storiesDrag", listOf("x", 90f, 0f, true, false, 800f)))
    assertEquals(mapOf("x" to -90.0, "y" to 0.0, "progress" to 0.0), Core.view("storiesDrag", listOf("x", -90f, 0f, true, false, 800f)))

    assertEquals(mapOf("count" to 5.0, "spoken" to "Просмотры: 5", "heading" to "Просмотров: 5"), Core.view("storiesViews", listOf(5)))
    assertEquals(0.0, Core.map(Core.view("storiesViews", listOf(null)))!!["count"])
    // When a person watched, by this phone's clock.
    val moscow = TimeZone.getTimeZone("Europe/Moscow")
    assertEquals(listOf("09:05", "вчера", "3 нояб."),
      listOf("2026-11-21T06:05:00.000Z", "2026-11-20T10:00:00.000Z", "2026-11-03T10:00:00.000Z").map { StoryViewerRow.time(it, now, moscow) })
    // Past midnight in Moscow it is already today there.
    assertEquals("00:30", StoryViewerRow.time("2026-11-20T21:30:00.000Z", now, moscow))
    assertEquals("вчера", StoryViewerRow.time("2026-11-20T21:30:00.000Z", now, TimeZone.getTimeZone("UTC")))
  }

  @Test fun whatMayBePublishedAndHow() {
    assumeTrue(Core.loaded)
    assertEquals(mapOf("caption" to "Утро", "error" to "", "left" to 292.0), Core.view("storiesCaption", listOf("  Утро  ")))
    assertEquals(listOf("Подпись — до 300 символов.", -1.0), Core.map(Core.view("storiesCaption", listOf("я".repeat(301))))!!.let { listOf(it["error"], it["left"]) })
    assertEquals(listOf("", 0.0), Core.map(Core.view("storiesCaption", listOf("я".repeat(300))))!!.let { listOf(it["error"], it["left"]) })

    // A photo: a JPEG at 0.85, scaled to 1600 when it is wider — as a plain profile file.
    assertEquals(mapOf("error" to "", "name" to "post.jpg", "mimeType" to "image/jpeg", "resizeWidth" to 1600.0, "quality" to 0.85, "purpose" to "post", "chunked" to false),
      Core.view("storiesUpload", listOf(mapOf("video" to false, "width" to 4000))))
    assertNull(Core.map(Core.view("storiesUpload", listOf(mapOf("video" to false, "width" to 1600))))!!["resizeWidth"])

    // A video: a minute at most (the core's words), and in one request — up to 20 MiB.
    val plan = StoryPrepare.videoPlan(60_000, 5_000_000).getOrThrow()
    assertEquals(listOf("post.mp4", "video/mp4", "post", false), listOf(plan["name"], plan["mimeType"], plan["purpose"], plan["chunked"]))
    assertTrue(StoryPrepare.videoPlan(60_500, null).isSuccess)
    fun refused(result: Result<*>) = (result.exceptionOrNull() as StoryPrepare.Failure).words
    assertEquals("Видео — не длиннее минуты.", refused(StoryPrepare.videoPlan(60_501, null)))
    assertEquals("Видео — не длиннее минуты.", refused(StoryPrepare.videoPlan(61_000, 1000)))
    assertEquals("Файл слишком большой. Максимум — 20 МБ.", refused(StoryPrepare.videoPlan(30_000, 20L * 1024 * 1024 + 1)))
    assertTrue(StoryPrepare.videoPlan(30_000, 20L * 1024 * 1024).isSuccess)
    assertEquals(VideoPrepare.failed, refused(StoryPrepare.videoPlan(30_000, 0)))
  }

  @Test fun theTabsOfAProfile() {
    assumeTrue(Core.loaded)
    assertEquals(listOf(listOf("Публикации 3", "Истории"), listOf("Публикации", "Истории 2")), listOf(Core.view("storiesTabs", listOf(3, 0)), Core.view("storiesTabs", listOf(0, 2))))
    assertEquals(mapOf("emoji" to "🖼️", "heading" to "Публикаций пока нет…", "hint" to "Публикуй фото и видео в своём профиле — их увидят друзья.", "button" to "Добавить публикацию"),
      Core.view("storiesEmpty", listOf("post", true)))
    assertEquals(mapOf("emoji" to "✨", "heading" to "Историй пока нет…", "hint" to "Сейчас историй нет.", "button" to null), Core.view("storiesEmpty", listOf("story", false)))
    assertEquals("История видна друзьям 24 часа, потом исчезает.", Core.map(Core.view("storiesEmpty", listOf("story", true)))!!["hint"])
    assertNull(Core.view("storiesEmpty", listOf("gift", true)))
  }

  @Test fun theServerCallsOfStoriesAreTheCores() {
    assumeTrue(Core.loaded)
    fun call(name: String, vararg args: Any?) = Core.call(name, args.toList())!!.let { listOf(it.method, it.path, it.body) }
    assertEquals(listOf("GET", "/stories/feed?posts=1", null), call("storiesFeed"))
    assertEquals(listOf("GET", "/users/u%2F1/posts", null), call("profilePosts", "u/1"))
    assertEquals(listOf("DELETE", "/me/posts/p1", null), call("deletePost", "p1"))
    assertEquals(listOf("GET", "/stories/s1/viewers", null), call("storyViewers", "s1"))
    assertEquals(listOf("POST", "/stories/s1/view"), call("viewStory", "s1").take(2))
    val publish = Core.call("publishPost", listOf("file-1", "story", "Утро"))!!
    assertEquals(listOf("POST", "/me/posts", mapOf("uploadId" to "file-1", "kind" to "story", "caption" to "Утро")), listOf(publish.method, publish.path, Core.value(publish.body)))
  }
}
