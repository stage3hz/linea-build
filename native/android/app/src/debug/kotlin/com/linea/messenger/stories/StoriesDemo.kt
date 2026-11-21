package com.linea.messenger.stories

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.view.View
import android.view.ViewGroup
import com.linea.messenger.app.Launcher
import com.linea.messenger.channels.ChannelImages
import com.linea.messenger.people.PeopleDemo
import com.linea.messenger.people.Person
import com.linea.messenger.people.PersonProfileScreen
import com.linea.messenger.people.pages
import com.linea.messenger.shell.RootScreen
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Made-up stories and posts with drawn pictures, for looking at the strip, the viewer, the screen that publishes
 *  and a profile's tabs on the emulator while there is no account behind them. This file is in the debug source
 *  set: a release build is compiled with the empty `StoriesDemo` of src/release instead and contains none of this. */
object StoriesDemo {
  const val present = true
  val me = Person("demo-me", "maria", "Мария Орлова", "", "", 0x34C3A0, "")

  private val palettes = listOf(
    Triple(0x16316A, 0x2EE6C8, 0xFFF4C2), Triple(0xB0401E, 0xF2A33C, 0xFFE9B0), Triple(0x1E5D3A, 0xB8E07A, 0xFDF6D8),
    Triple(0x0E2A47, 0x3CA7F2, 0xE8F6FF), Triple(0x3A2A1A, 0xE8C27A, 0xFFF1D6), Triple(0x10363A, 0x7FD6F5, 0xF2FFFB),
    Triple(0x243B1E, 0xE0B84A, 0xFFF7E0), Triple(0x1B2B5A, 0xF26B5E, 0xFFE3D6),
  )

  private fun solid(rgb: Int, alpha: Float = 1f): Int = (Math.round(alpha * 255) shl 24) or (rgb and 0xFFFFFF)

  /** A drawn picture (no photo of anyone): a sky, a sun, two hills. */
  fun picture(number: Int, tall: Boolean): Bitmap {
    val width = if (tall) 540 else 600; val height = if (tall) 960 else 600
    val colors = palettes[((number % palettes.size) + palettes.size) % palettes.size]
    val made = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(made)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, 0f, width * 0.3f, height.toFloat(), solid(colors.first), solid(colors.second), Shader.TileMode.CLAMP)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    paint.shader = null
    paint.color = solid(colors.third, 0.9f)
    val sun = width * (0.2f + 0.04f * (number % 3))
    val sunLeft = width * (0.55f - 0.1f * (number % 4))
    canvas.drawOval(sunLeft, height * 0.16f, sunLeft + sun, height * 0.16f + sun, paint)
    paint.color = solid(colors.first, 0.55f)
    canvas.drawOval(-width * 0.3f, height * 0.68f, width * 0.8f, height * 1.38f, paint)
    paint.color = solid(colors.first, 0.8f)
    canvas.drawOval(width * 0.35f, height * 0.76f, width * 1.35f, height * 1.36f, paint)
    return made
  }

  private var drawn = false

  /** Puts the drawn pictures where the loaders look first. */
  fun draw() {
    if (drawn) return
    drawn = true
    for (number in 0 until 12) ChannelImages.putSample(picture(number, tall = true), "demo-story-$number")
    for (number in 0 until 9) ChannelImages.putSample(picture(number + 3, tall = false), "demo-post-$number")
    StoryVideoFrames.putSample(picture(5, tall = false), "demo-video-0")
  }

  private val stamps = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC)

  fun stamp(hoursAgo: Double): String = stamps.format(Instant.now().minusMillis(Math.round(hoursAgo * 3_600_000)))

  private fun user(person: Person): Map<String, Any?> =
    mapOf("id" to person.id, "username" to person.username, "displayName" to person.displayName, "avatarColor" to String.format(Locale.ROOT, "#%06X", person.avatarColor and 0xFFFFFF))

  private fun item(id: String, kind: String, media: String, hoursAgo: Double, caption: String = "", seen: Boolean? = null, views: Int? = null, video: Boolean = false): Map<String, Any?> {
    val made = linkedMapOf<String, Any?>("id" to id, "kind" to kind, "caption" to caption, "createdAt" to stamp(hoursAgo),
      "media" to mapOf("id" to media, "mimeType" to (if (video) "video/mp4" else "image/jpeg"), "isImage" to !video, "isVideo" to video, "size" to 240_000))
    made["expiresAt"] = if (kind == "story") stamp(hoursAgo - 24) else null
    if (seen != null) made["seen"] = seen
    if (views != null) made["views"] = views
    return made
  }

  /** The strip's feed, as the server would send it. */
  fun feed(): Map<String, Any?> {
    val friends = PeopleDemo.friends
    val waiting = PeopleDemo.outgoing[0]
    val items = ArrayList<Map<String, Any?>>()
    items.add(mapOf("user" to user(friends[0]), "unseen" to 2, "latest" to stamp(1.0), "stories" to listOf(
      item("demo-s-a1", "story", "demo-story-0", 9.0, seen = true),
      item("demo-s-a2", "story", "demo-story-1", 3.0, caption = "Вид с перевала. Дальше — только пешком.", seen = false),
      item("demo-s-a3", "story", "demo-story-2", 1.0, seen = false),
    )))
    items.add(mapOf("user" to user(friends[1]), "unseen" to 2, "latest" to stamp(2.0), "stories" to listOf(
      item("demo-s-d1", "story", "demo-story-3", 5.0, seen = false),
      item("demo-s-d2", "story", "demo-story-4", 2.0, seen = false),
    )))
    // No live story, a post from four hours ago: «запись».
    items.add(mapOf("user" to user(friends[2]), "unseen" to 0, "latest" to stamp(4.0), "stories" to emptyList<Any?>(),
      "posts" to listOf(item("demo-p-l1", "post", "demo-post-0", 4.0, caption = "Новая запись"))))
    // A request to this person is waiting, and they show their stories to everyone: a clock and «заявка».
    items.add(mapOf("user" to user(waiting), "unseen" to 1, "pending" to true, "latest" to stamp(6.0), "stories" to listOf(item("demo-s-i1", "story", "demo-story-5", 6.0, seen = false))))
    items.add(mapOf("user" to user(friends[3]), "unseen" to 0, "latest" to stamp(11.0), "stories" to listOf(
      item("demo-s-m1", "story", "demo-story-6", 14.0, seen = true),
      item("demo-s-m2", "story", "demo-story-7", 11.0, seen = true),
    )))
    val mine = listOf(
      item("demo-s-me1", "story", "demo-story-8", 7.0, caption = "Утро", views = 12),
      item("demo-s-me2", "story", "demo-story-9", 2.0, views = 5),
    )
    return mapOf("items" to items, "mine" to mine)
  }

  fun fillStrip() {
    draw()
    StoriesStore.sampleMe(me)
    StoriesStore.take(feed())
  }

  /** A profile's posts and stories. */
  fun profile(own: Boolean): ProfilePostsData? {
    draw()
    val posts = (0 until 8).mapNotNull { number ->
      if (number == 2) StoryPost.from(item("demo-pp-video", "post", "demo-video-0", 30.0, video = true))
      else StoryPost.from(item("demo-pp-$number", "post", "demo-post-$number", 20.0 + number * 26, caption = if (number == 0) "Собрали гербарий за лето" else ""))
    }
    val stories = (0 until 2).mapNotNull { number ->
      StoryPost.from(item("demo-ps-$number", "story", "demo-story-${number + 10}", 2.0 + number * 5, seen = if (own) null else false, views = if (own) 7 - number else null))
    }
    return ProfilePostsData(visible = true, posts = posts, stories = stories)
  }

  fun viewers(): StoryViewersData {
    val friends = PeopleDemo.friends
    return StoryViewersData(5, listOf(0 to 0.2, 1 to 0.6, 3 to 1.1, 4 to 1.4, 2 to 1.9).map { (who, hoursAgo) -> StoryViewersData.Row(friends[who], stamp(hoursAgo)) })
  }

  /** The launch arguments asked for a look at stories. */
  var asked = false

  /** A viewer opened during an emulator check stands still, so the shot does not depend on its timing. */
  fun dress(viewer: StoryViewer) {
    if (asked) viewer.frozenAt = 0.4
  }
}

/** What the emulator check asks of stories by launch arguments (see `Demo.start`), as the iOS simulator check does:
 *    --es storiesdemo strip      the chats with the strip: «Моя история», two people with unseen stories, one shown for
 *                                a post («запись»), one whose request is waiting (a clock, «заявка»), one all seen (grey ring)
 *    --es storiesdemo viewer     the first person's story open (the clock stands still at 40% of the second bar)
 *    --es storiesdemo viewers    the account's own story with «Просмотры» open over it
 *    --es storiesdemo compose    the screen before publishing: a drawn picture, a caption, «Добавить историю»
 *    --es storiesdemo posts      a person's profile with the ring around the avatar and the «Публикации» grid
 *    --es storiesdemo own        «Публикации и истории» of the account itself (with «Добавить публикацию»)
 *  With an account (after --es login … on the local test server):
 *    --es stories viewer         opens the first person of the strip as soon as the feed has one
 *    --es stories own            «Настройки» → «Публикации и истории»; --es stories ownstories: its «Истории» tab
 *    --es stories compose        the screen before publishing with a drawn picture (nothing is sent by itself) */
object StoriesSimulator {
  /** `storiesdemo …` (no account) decides the start. */
  fun demo(intent: Intent, launcher: Launcher): Boolean {
    StoriesDemo.asked = intent.getStringExtra("storiesdemo") != null || intent.getStringExtra("stories") != null
    val demo = intent.getStringExtra("storiesdemo") ?: return false
    val root = launcher.showDemo()
    StoriesDemo.fillStrip()
    val context = root.context
    when (demo) {
      "viewer" -> root.postDelayed({ StoriesStrip.current.get()?.emulatorOpenFirst() }, 1200)
      "viewers" -> root.postDelayed({
        val viewer = StoriesStrip.current.get()?.open(StoriesDemo.me.id)
        root.postDelayed({ viewer?.emulatorShowViewers(StoriesDemo.viewers()) }, 1000)
      }, 1200)
      "compose" -> {
        val screen = StoryComposeScreen(context, null, "story")
        root.pages()?.push(screen, animated = false)
        screen.emulatorFill(StoriesDemo.picture(1, tall = true), "Вид с перевала")
      }
      "posts" -> {
        val friend = PeopleDemo.friends[0]
        root.pages()?.push(PersonProfileScreen(context, null, friend.id, friend.displayName, friend), animated = false)
      }
      "own" -> root.pages()?.push(OwnPostsScreen(context, null), animated = false)
    }
    return true
  }

  private fun find(view: View): RootScreen? {
    if (view is RootScreen) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) find(view.getChildAt(index))?.let { return it }
    return null
  }

  /** `stories …` (with an account): waits for the shell (the sign-in of the same launch may still be going), then opens. */
  fun later(intent: Intent, launcher: Launcher) {
    val wanted = intent.getStringExtra("stories") ?: return
    val page = (launcher as? Activity)?.window?.decorView ?: return
    var tries = 0
    val look = object : Runnable {
      override fun run() {
        tries += 1
        val root = find(page)
        val messenger = StoriesStore.account
        if (root == null || messenger == null) { if (tries < 60) page.postDelayed(this, 1000); return }
        val context = root.context
        when (wanted) {
          // The feed is read from the server: tried until somebody is in it.
          "viewer" -> if (StoriesStrip.current.get()?.emulatorOpenFirst() != true && tries < 60) page.postDelayed(this, 1000)
          "own", "ownstories" -> {
            val screen = OwnPostsScreen(context, messenger)
            root.pages()?.push(screen, animated = false)
            if (wanted == "ownstories") screen.block.emulatorShow("story")
          }
          "compose" -> {
            val screen = StoryComposeScreen(context, messenger, "story")
            root.pages()?.push(screen, animated = false)
            screen.emulatorFill(StoriesDemo.picture(1, tall = true), "Вид с перевала")
          }
        }
      }
    }
    page.postDelayed(look, 1000)
  }
}
