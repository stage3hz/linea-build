package com.linea.messenger.stories

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.ChannelFiles
import com.linea.messenger.channels.ChannelImages
import com.linea.messenger.core.Core
import com.linea.messenger.crypto.CryptoService
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.people.Person
import com.linea.messenger.people.chatWith
import com.linea.messenger.settings.OwnProfile
import com.linea.messenger.settings.ownProfile
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Executors

// Stories and profile posts (the reference's stories/StoriesStrip.tsx, stories/seenPosts.ts and ProfilePosts.tsx;
// the iPhone app's Sources/Stories/StoriesModel.swift).
//
// What is stored where, exactly as the reference has it:
//  - The photo or video of a story or a post is NOT end-to-end encrypted. It is an ordinary profile upload
//    (`POST /uploads?purpose=post`), kept by the server as it is and read back by `GET /files/<id>` by whoever may
//    see the owner's posts — published on purpose, like the avatar. Its metadata is removed on this phone first.
//  - An answer to a story IS end-to-end encrypted: an ordinary message to the author with the story's reference
//    inside the ciphertext (`meta.story`).
//  - Which stories were watched is kept by the server; which posts were opened — on this phone only.
//
// The shared rules (the order of the strip, whose stories the viewer plays, the words, the swipes, the limits) are
// the core's (`native/core/src/stories.rs`), asked by name through `Core.view`.

/** One story or post (`ProfilePost` of the reference's api.ts). */
data class StoryPost(
  val id: String,
  /** "post" or "story". */
  val kind: String,
  val caption: String,
  val createdAt: String,
  /** The id of the uploaded file. */
  val mediaId: String,
  val isVideo: Boolean,
  /** How many people watched it: the person's own stories only. */
  val views: Int?,
  val seen: Boolean,
) {
  companion object {
    /** Null for what is not a post (no id). */
    fun from(raw: Any?): StoryPost? {
      val fields = Core.map(raw as? Map<*, *>) ?: return null
      val id = fields["id"] as? String ?: return null
      if (id.isEmpty()) return null
      val media = Core.map(fields["media"] as? Map<*, *>) ?: emptyMap()
      return StoryPost(
        id, fields["kind"] as? String ?: "post", fields["caption"] as? String ?: "", fields["createdAt"] as? String ?: "",
        media["id"] as? String ?: "", media["isVideo"] as? Boolean ?: false, (fields["views"] as? Number)?.toInt(), fields["seen"] as? Boolean ?: false,
      )
    }

    fun list(raw: Any?): List<StoryPost> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }
  }
}

/** A person's posts and stories as their profile shows them (`ProfilePosts` of the reference). */
class ProfilePostsData(
  /** False: this account may not see them (not a friend, and the person shows them to friends only). */
  val visible: Boolean,
  val posts: List<StoryPost>,
  val stories: List<StoryPost>,
) {
  companion object {
    /** The answer of `profilePosts`. */
    fun from(body: Map<String, Any?>): ProfilePostsData = ProfilePostsData(body["visible"] as? Boolean ?: false, StoryPost.list(body["posts"]), StoryPost.list(body["stories"]))
  }
}

/** Who watched a story and when (`StoryViewers` of the reference). */
class StoryViewersData(val count: Int, val rows: List<Row>) {
  class Row(val person: Person, val viewedAt: String)

  companion object {
    /** The answer of `storyViewers`. */
    fun from(body: Map<String, Any?>): StoryViewersData {
      val rows = (body["viewers"] as? List<*>).orEmpty().mapNotNull { item ->
        val row = Core.map(item as? Map<*, *>) ?: return@mapNotNull null
        Person.from(row["user"])?.let { Row(it, row["viewedAt"] as? String ?: "") }
      }
      return StoryViewersData((body["count"] as? Number)?.toInt() ?: rows.size, rows)
    }
  }
}

/** The core's constants and words of stories, read once. */
object StoryRules {
  private var kept: Map<String, Any?>? = null
  private val all: Map<String, Any?>
    get() = kept ?: (Core.map(Core.view("storiesRules", emptyList()))?.also { kept = it } ?: emptyMap())

  fun word(key: String): String = Core.map(all["words"])?.get(key) as? String ?: ""

  fun number(key: String, otherwise: Double): Double = (all[key] as? Number)?.toDouble() ?: otherwise

  fun text(key: String, otherwise: String): String = all[key] as? String ?: otherwise
}

private val main by lazy { Handler(Looper.getMainLooper()) }

// The server calls of stories and posts. Every answer comes back on the main thread.

private fun Messenger.storiesCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
  server.op(name, args) { result ->
    main.post { done(if (result.isSuccess) Result.success(Core.map(result.getOrNull()) ?: emptyMap()) else Result.failure(Server.error(result))) }
  }
}

/** The strip's feed as the server sends it: `{items, mine}`. */
fun Messenger.storiesFeed(done: (Result<Map<String, Any?>>) -> Unit) = storiesCall("storiesFeed", emptyList(), done)

fun Messenger.profilePosts(userId: String, done: (Result<ProfilePostsData>) -> Unit) {
  storiesCall("profilePosts", listOf(userId)) { result -> done(result.map { ProfilePostsData.from(it) }) }
}

fun Messenger.deletePost(id: String, done: (ServerError?) -> Unit) {
  storiesCall("deletePost", listOf(id)) { result -> done(if (result.isSuccess) null else Server.error(result)) }
}

/** Marks a story watched (the server keeps the first view and ignores the owner's own). */
fun Messenger.viewStory(id: String) {
  server.op("viewStory", listOf(id)) { }
}

/** Who watched a story of this account. */
fun Messenger.storyViewers(id: String, done: (Result<StoryViewersData>) -> Unit) {
  storiesCall("storyViewers", listOf(id)) { result -> done(result.map { StoryViewersData.from(it) }) }
}

/** What an answer to a story carries inside its ciphertext beside the text. */
fun storyReplyMeta(authorId: String, storyId: String): Map<String, Any?> = mapOf("story" to mapOf("id" to storyId, "ownerId" to authorId))

/** Answers a story: an end-to-end encrypted message to its author with the story's reference inside the
 *  ciphertext. The chat with the author is the one there is, or a new one. `done` gets null when the message
 *  went out, else the words for the person. */
fun Messenger.replyToStory(authorId: String, storyId: String, text: String, done: (String?) -> Unit) {
  val messenger = this
  chatWith(authorId) { result ->
    val chat = result.getOrNull() ?: return@chatWith done(StoryRules.word("noChat"))
    val clientId = UUID.randomUUID().toString().lowercase()
    val meta = storyReplyMeta(authorId, storyId)
    crypto.run({ crypto -> messenger.deliver(crypto, chat.chatId, chat.peerId, clientId, text, null, meta) }, { sent ->
      if (sent.isSuccess) {
        messenger.noteChanged(chat.chatId)
        done(null)
      } else {
        done(CryptoService.failure(sent)?.words.orEmpty().ifEmpty { StoryRules.word("replyFailed") })
      }
    })
  }
}

/** Which posts from the strip this account has opened on this phone (the reference's seenPosts.ts): the server
 *  keeps «watched» for stories only. Kept under the reference's own key, as its own JSON text. Main thread only. */
class SeenPosts(private val store: SharedPreferences?, userId: String) {
  constructor(context: Context, userId: String) : this(context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE), userId)

  val key: String = StoryRules.text("seenKey", "linea.seen-posts.v1:") + userId
  var ids: List<String> = (Core.view("storiesSeenParse", listOf(store?.getString(key, null))) as? List<*>).orEmpty().mapNotNull { it as? String }
    private set

  /** Remembers that these posts were opened. True when the list changed. */
  fun add(added: List<String>): Boolean {
    val next = (Core.view("storiesSeenAdd", listOf(ids, added)) as? List<*>)?.mapNotNull { it as? String } ?: return false
    if (next == ids) return false
    ids = next
    Core.text(next)?.let { text -> store?.edit()?.putString(key, text)?.apply() }
    return true
  }

  companion object {
    const val PREFERENCES = "invizent.stories"
  }
}

/** One person of the strip, as the core says they are shown. */
class StripEntry(
  val person: Person,
  /** The first word of the name. */
  val name: String,
  val spoken: String,
  /** Shown for a recent post, not a story. */
  val post: Boolean,
  /** Not a friend yet: this account's request to them is waiting. */
  val pending: Boolean,
  /** Something new to look at: the ring is lit. */
  val fresh: Boolean,
  /** «запись», «заявка» or nothing. */
  val sub: String,
)

/** What the viewer plays, and how. */
class StoryViewerGroup(
  /** Whose these are (a person's id); the viewer asks for the neighbours by it. */
  val key: String,
  val owner: Person?,
  val items: List<StoryPost>,
  val start: Int,
  /** Stories play by the clock with bars on top; posts wait for a tap. */
  val story: Boolean,
  /** The account's own: the count of views instead of the answer field. */
  val own: Boolean,
  val canReply: Boolean,
  /** Past the last one the viewer moves on (to the next person, or closes) instead of staying. */
  val runsOn: Boolean,
)

/** The strip as the core's `storiesStrip` gives it, with the people it names: plain, so it can be checked
 *  without a phone. */
class StripShown(val show: Boolean, val mineHas: Boolean, val mineSpoken: String, val people: List<StripEntry>) {
  companion object {
    val none = StripShown(false, false, "", emptyList())

    fun from(made: Map<String, Any?>, known: Map<String, Person>): StripShown {
      val entries = (made["people"] as? List<*>).orEmpty().mapNotNull { item ->
        val row = Core.map(item as? Map<*, *>) ?: return@mapNotNull null
        val person = known[row["id"] as? String ?: return@mapNotNull null] ?: return@mapNotNull null
        StripEntry(person, row["name"] as? String ?: person.displayName, row["spoken"] as? String ?: person.displayName,
          row["post"] as? Boolean ?: false, row["pending"] as? Boolean ?: false, row["fresh"] as? Boolean ?: false, row["sub"] as? String ?: "")
      }
      val own = Core.map(made["mine"]) ?: emptyMap()
      return StripShown(made["show"] as? Boolean ?: false, own["has"] as? Boolean ?: false, own["spoken"] as? String ?: "", entries)
    }
  }
}

/** The strip's feed and everything computed from it. One for the app; main thread only. */
object StoriesStore {
  /** Posted on the main thread when the strip changed. */
  val changed = Live.Signal<Unit>()

  var show = false
    private set
  var mineHas = false
    private set
  var mineSpoken = ""
    private set
  var people: List<StripEntry> = emptyList()
    private set
  /** The account's own person (for «Моя история»). */
  var me: Person? = null
    private set

  private var messenger = WeakReference<Messenger>(null)
  private var seen: SeenPosts? = null
  private var feed: Map<String, Any?> = mapOf("items" to emptyList<Any?>(), "mine" to emptyList<Any?>())
  private var persons: Map<String, Person> = emptyMap()
  private var posts: Map<String, StoryPost> = emptyMap()
  private var running = false
  private var again = false
  private var turn = 0
  private val work = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.stories").apply { isDaemon = true } }
  private val timer = object : Runnable {
    override fun run() {
      if (messenger.get() == null) return
      refresh()
      main.postDelayed(this, every())
    }
  }

  init {
    Live.storyEvent.watch { refresh() }
    OwnProfile.watch { profileChanged() }
  }

  private fun every(): Long = StoryRules.number("refreshMs", 300_000.0).toLong().coerceAtLeast(10_000L)

  val myId: String get() = messenger.get()?.userId ?: "demo-me"

  /** The signed-in account the strip was started with (null: none, or it is gone). */
  val account: Messenger? get() = messenger.get()

  /** The account whose strip this is; another account starts from nothing. */
  fun start(context: Context, messenger: Messenger?) {
    // The pictures of posts are plain files of the server, kept in the cache folder (channels/ChannelsNet.kt).
    if (ChannelFiles.cache == null) ChannelFiles.cache = context.applicationContext.cacheDir
    if (this.messenger.get() !== messenger || seen == null) {
      this.messenger = WeakReference(messenger)
      seen = messenger?.let { SeenPosts(context, it.userId) }
      me = messenger?.let { Person.from(it.ownProfile) }
      running = false
      again = false
      take(mapOf("items" to emptyList<Any?>(), "mine" to emptyList<Any?>()))
    }
    main.removeCallbacks(timer)
    if (messenger == null) return
    // …and read as this session.
    ChannelImages.server = messenger.server
    main.postDelayed(timer, every())
    refresh()
  }

  private fun profileChanged() {
    val messenger = messenger.get() ?: return
    me = Person.from(messenger.ownProfile)
    changed.post(Unit)
  }

  /** Reads the feed again; several calls at once are one request and one more after it. */
  fun refresh() {
    val messenger = messenger.get() ?: return
    if (running) { again = true; return }
    running = true
    messenger.storiesFeed { result ->
      if (this.messenger.get() !== messenger) return@storiesFeed
      running = false
      result.getOrNull()?.let { take(it) }
      if (again) { again = false; refresh() }
    }
  }

  /** Takes a feed (`{items, mine}`) and works the strip out of it, off the main thread. */
  fun take(next: Map<String, Any?>) {
    val kept = LinkedHashMap(next)
    if (kept["items"] !is List<*>) kept["items"] = emptyList<Any?>()
    if (kept["mine"] !is List<*>) kept["mine"] = emptyList<Any?>()
    feed = kept
    val foundPersons = HashMap<String, Person>()
    val foundPosts = HashMap<String, StoryPost>()
    for (raw in kept["items"] as? List<*> ?: emptyList<Any?>()) {
      val item = Core.map(raw as? Map<*, *>) ?: continue
      Person.from(item["user"])?.let { foundPersons[it.id] = it }
      for (post in StoryPost.list(item["stories"]) + StoryPost.list(item["posts"])) foundPosts[post.id] = post
    }
    for (post in StoryPost.list(kept["mine"])) foundPosts[post.id] = post
    persons = foundPersons
    posts = foundPosts
    recompute()
  }

  private fun recompute() {
    turn += 1
    val wanted = turn
    val given = feed
    val seenIds = seen?.ids ?: emptyList()
    val mine = myId
    val known = persons
    work.execute {
      val shown = StripShown.from(Core.map(Core.view("storiesStrip", listOf(given, seenIds, mine))) ?: emptyMap(), known)
      main.post {
        if (turn != wanted) return@post
        show = shown.show
        mineHas = shown.mineHas
        mineSpoken = shown.mineSpoken
        people = shown.people
        changed.post(Unit)
      }
    }
  }

  private fun plan(viewing: String, entered: Int): Map<String, Any?>? =
    Core.map(Core.view("storiesViewer", listOf(feed, seen?.ids ?: emptyList<String>(), myId, viewing, entered)))

  /** What the viewer plays for a person of the strip (the account's own id: its own stories); null when there
   *  is nothing to show. `entered`: 1 — moving forward, -1 — coming back from the next person. */
  fun group(viewing: String, entered: Int): StoryViewerGroup? {
    val made = plan(viewing, entered) ?: return null
    if (made["open"] != true) return null
    val items = (made["items"] as? List<*>).orEmpty().mapNotNull { id -> posts[id as? String ?: ""] }
    if (items.isEmpty()) return null
    val own = made["own"] as? Boolean ?: false
    val postsShown = made["posts"] as? Boolean ?: false
    val start = (made["start"] as? Number)?.toInt() ?: 0
    return StoryViewerGroup(viewing, if (own) me else persons[viewing], items, start.coerceIn(0, items.size - 1),
      story = !postsShown, own = own, canReply = !own && !postsShown && messenger.get() != null, runsOn = true)
  }

  /** Whose stories come after (`step` 1) or before (-1) a person's, as the strip stands now. */
  fun neighbour(viewing: String, step: Int): StoryViewerGroup? {
    val id = plan(viewing, 1)?.get(if (step > 0) "after" else "before") as? String ?: return null
    return group(id, if (step > 0) 1 else -1)
  }

  /** A friend's story came on the screen: told to the server once, and the strip knows at once. */
  fun watched(userId: String, post: StoryPost) {
    if (post.kind != "story" || post.seen || userId == myId) return
    val next = Core.map(Core.view("storiesViewed", listOf(feed, userId, post.id))) ?: return
    messenger.get()?.viewStory(post.id)
    take(next)
  }

  /** A post from the strip was opened: from now on it is seen on this phone. */
  fun opened(post: StoryPost) {
    val seen = seen ?: return
    if (post.kind != "post") return
    if (seen.add(listOf(post.id))) recompute()
  }

  /** For the debug build's samples: who «Моя история» belongs to. */
  fun sampleMe(person: Person) { me = person }
}
