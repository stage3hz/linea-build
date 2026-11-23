package com.linea.messenger.channels

import android.os.Handler
import android.os.Looper
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import java.util.concurrent.Executor
import java.util.concurrent.Executors

// The work behind a channel's chat, all of it OFF the main thread: one worker owns the channel's messages, reads
// what the server answers, takes the live line's events, makes rows and their layouts (kept per message for the
// width they were made at), and hands the main thread small finished patches (ChannelPatch).
// Reference: mobile/src/communities/ChannelChat.tsx (load, older, the socket listener, the merges).

class ChannelEngine(
  /** A server operation whose answer may come on any thread; null: no server behind the channel (samples). */
  private val ask: ((name: String, args: List<Any?>, done: (Result<Any?>) -> Unit) -> Unit)?,
  private val communityId: String,
  private val channelId: String,
  blog: Boolean, meId: String, meUsername: String, ownerId: String,
  /** dp → px. */
  density: Float,
  /** The one thread everything below runs on. */
  private val worker: Executor = shared,
  /** Carries a finished result to the main thread. */
  private val toMain: (() -> Unit) -> Unit = { work -> mainHandler.post(work) },
  private val maker: ChannelRowMaker = ChannelRowMaker(),
) {
  // Everything below is touched on the worker only.
  private val context = ChannelContext().also { it.blog = blog; it.meId = meId; it.meUsername = meUsername; it.ownerId = ownerId }
  /** The worker's own paints: rows are measured with them (the main thread draws with its own). */
  private val paints by lazy { ChannelPaints(density) }
  /** Oldest first. */
  private val messages = ArrayList<CommunityMessage>()
  private val layouts = HashMap<Long, ChannelRowLayout>()
  private var width = 0
  private var hasMore = false
  private var loadingOlder = false
  private var loaded = false
  private val askedInvites = HashSet<String>()
  /** The authors as whole people (the reference's `users`): what the mini profile shows when a name is tapped. */
  private val people = HashMap<String, com.linea.messenger.people.Person>()

  /** Called on the main thread. */
  var onPatch: (ChannelPatch) -> Unit = {}
  /** The first page is here (`error` empty) or could not be read. Main thread. */
  var onLoaded: (error: String, newestId: Long) -> Unit = { _, _ -> }
  /** A message from someone arrived over the live line: it is read at once. Main thread. */
  var onIncoming: (messageId: Long) -> Unit = {}
  /** A page of older messages could not be read. Main thread. */
  var onOlderFailed: () -> Unit = {}

  // Asked from the main thread

  fun setWidth(wide: Int) {
    worker.execute {
      if (wide <= 0 || wide == width) return@execute
      width = wide
      layouts.clear()
      if (loaded) emitReset()
    }
  }

  /** The newest page. */
  fun load() {
    val ask = ask ?: return
    ask("channelMessages", listOf(communityId, channelId)) { result ->
      worker.execute {
        val page = Core.map(result.getOrNull() as? Map<*, *>)
        if (result.isFailure || page == null) {
          val words = Server.error(result).words
          val known = loaded
          toMain { onLoaded(if (known) "" else words, 0) }
          return@execute
        }
        absorb(page["users"])
        val fresh = CommunityMessage.list(page["messages"]).sortedBy { it.id }
        if (loaded) {
          // After the line came back: what arrived meanwhile is merged in, nothing is shown twice — and only
          // the rows that are new or different go to the list.
          val before = messages.map { it.id }
          val byId = HashMap<Long, CommunityMessage>()
          for (message in messages) byId[message.id] = message
          for (message in fresh) byId[message.id] = message
          val merged = byId.values.sortedBy { it.id }
          val after = merged.map { it.id }
          messages.clear(); messages.addAll(merged)
          if (after.size >= before.size && after.subList(0, before.size) == before) {
            emitChanged()
            val patch = ChannelPatch()
            patch.newest = (before.size until merged.size).mapNotNull { layout(it).first }
            emit(patch)
          } else emitReset()
        } else {
          messages.clear(); messages.addAll(fresh)
          hasMore = page["hasMore"] as? Boolean ?: false
          loaded = true
          emitReset()
        }
        val newest = messages.lastOrNull()?.id ?: 0L
        toMain { onLoaded("", newest) }
      }
    }
  }

  /** The page before the oldest message shown. */
  fun loadOlder() {
    worker.execute {
      val ask = ask ?: return@execute
      val oldest = messages.firstOrNull() ?: return@execute
      if (!hasMore || loadingOlder) return@execute
      loadingOlder = true
      ask("channelMessages", listOf(communityId, channelId, oldest.id)) { result ->
        worker.execute {
          loadingOlder = false
          val page = Core.map(result.getOrNull() as? Map<*, *>)
          if (page == null) { toMain { onOlderFailed() }; return@execute }
          absorb(page["users"])
          val known = messages.mapTo(HashSet()) { it.id }
          val older = CommunityMessage.list(page["messages"]).filter { it.id !in known }.sortedBy { it.id }
          hasMore = page["hasMore"] as? Boolean ?: false
          if (older.isEmpty()) return@execute
          val joint = messages.firstOrNull()?.id
          messages.addAll(0, older)
          val patch = ChannelPatch()
          patch.older = older.indices.mapNotNull { layout(it).first }
          // The row that was the oldest now has a message before it (its date line or its header may go).
          if (joint != null) {
            val made = layout(index(joint))
            if (made.second) made.first?.let { patch.updated.add(it) }
          }
          emit(patch)
        }
      }
    }
  }

  /** An event of the live line (already known to be about this community). */
  fun socket(data: Map<String, Any?>) {
    worker.execute {
      if (!loaded) return@execute
      val type = data["type"] as? String ?: return@execute
      if (type == "community.message") {
        val message = CommunityMessage.from(data["message"]) ?: return@execute
        if (message.channelId != channelId) return@execute
        var again = false
        val author = ChannelAuthor.from(data["user"]); val id = Core.map(data["user"] as? Map<*, *>)?.get("id") as? String
        com.linea.messenger.people.Person.from(data["user"])?.let { people[it.id] = it }
        if (author != null && id != null && context.authors[id] != author) { context.authors[id] = author; again = true }
        val edited = data["edited"] as? Boolean ?: false
        merge(message, own = false, everything = again)
        if (!edited) toMain { onIncoming(message.id) }
      } else if (type == "community.message.deleted" && data["channelId"] as? String == channelId) {
        (data["messageId"] as? Number)?.toLong()?.let { remove(it) }
      }
    }
  }

  /** A message the server answered a request of this device with (sent, edited, a reaction put or taken). */
  fun put(raw: Any?, own: Boolean) {
    worker.execute {
      val message = CommunityMessage.from(raw) ?: return@execute
      if (message.channelId != channelId && message.channelId.isNotEmpty()) return@execute
      merge(message, own, everything = false)
    }
  }

  fun removed(id: Long) { worker.execute { remove(id) } }

  /** The members of the community are known: their names, pictures and the colours of their roles. */
  fun setMembers(authors: Map<String, ChannelAuthor>, roleColors: Map<String, Int>, people: Map<String, com.linea.messenger.people.Person> = emptyMap()) {
    worker.execute {
      context.authors.putAll(authors)
      this.people.putAll(people)
      context.roleColors = roleColors
      if (loaded) emitChanged()
    }
  }

  /** The author of a message as a whole person, when known (the reference's `users[senderId]`). `done` on the main thread. */
  fun person(id: String, done: (com.linea.messenger.people.Person?) -> Unit) {
    worker.execute {
      val found = people[id]
      toMain { done(found) }
    }
  }

  /** For the debug build's samples: a channel that is simply there. */
  fun demo(messages: List<CommunityMessage>, authors: Map<String, ChannelAuthor>, roleColors: Map<String, Int>, invites: Map<String, ChannelInviteCard>, meId: String, meUsername: String,
           people: Map<String, com.linea.messenger.people.Person> = emptyMap()) {
    worker.execute {
      this.people.clear(); this.people.putAll(people)
      context.meId = meId
      context.meUsername = meUsername
      context.authors.clear(); context.authors.putAll(authors)
      context.roleColors = roleColors
      context.invites.clear(); context.invites.putAll(invites)
      askedInvites.addAll(invites.keys)
      this.messages.clear(); this.messages.addAll(messages)
      loaded = true
      emitReset()
      val newest = messages.lastOrNull()?.id ?: 0L
      toMain { onLoaded("", newest) }
    }
  }

  // On the worker

  private fun absorb(users: Any?) {
    for (raw in (users as? List<*>).orEmpty()) {
      val id = Core.map(raw as? Map<*, *>)?.get("id") as? String ?: continue
      ChannelAuthor.from(raw)?.let { context.authors[id] = it }
      com.linea.messenger.people.Person.from(raw)?.let { people[it.id] = it }
    }
  }

  private fun index(id: Long): Int {
    // Changes are nearly always about the newest messages.
    var at = messages.size - 1
    while (at >= 0) { if (messages[at].id == id) return at; at -= 1 }
    return -1
  }

  /** The layout of the message at an index, made again only when its row or the width has changed: the layout
   *  and whether it is a new one. */
  private fun layout(index: Int): Pair<ChannelRowLayout?, Boolean> {
    if (width <= 0 || index < 0 || index >= messages.size) return Pair(null, false)
    val message = messages[index]
    val older = if (index > 0) messages[index - 1] else null
    val replied = if (message.replyTo != 0L) index(message.replyTo).takeIf { it >= 0 }?.let { messages[it] } else null
    maker.inviteCode(message)?.let { askInvite(it) }
    val row = maker.row(message, older, replied, context)
    val kept = layouts[message.id]
    if (kept != null && kept.width == width && kept.row == row && kept.message == message) return Pair(kept, false)
    val made = ChannelRowLayout(row, message, width, paints)
    layouts[message.id] = made
    return Pair(made, true)
  }

  private fun emit(patch: ChannelPatch) {
    if (patch.isEmpty) return
    toMain { onPatch(patch) }
  }

  private fun emitReset() {
    if (width <= 0) return
    val patch = ChannelPatch()
    patch.reset = messages.indices.mapNotNull { layout(it).first }
    val kept = messages.mapTo(HashSet()) { it.id }
    layouts.keys.retainAll(kept)
    toMain { onPatch(patch) }
  }

  /** Makes every row again and shows the ones that came out different (names, colours, an invitation known). */
  private fun emitChanged() {
    val patch = ChannelPatch()
    for (index in messages.indices) {
      val made = layout(index)
      if (made.second) made.first?.let { patch.updated.add(it) }
    }
    emit(patch)
  }

  private fun merge(message: CommunityMessage, own: Boolean, everything: Boolean) {
    val patch = ChannelPatch()
    val at = index(message.id)
    if (at >= 0) {
      if (messages[at] == message && !everything) return
      messages[at] = message
      if (everything) return emitChanged()
      val made = layout(at)
      if (made.second) made.first?.let { patch.updated.add(it) }
      // The rows that answer this message show its words.
      for (other in at + 1 until messages.size) {
        if (messages[other].replyTo != message.id) continue
        val again = layout(other)
        if (again.second) again.first?.let { patch.updated.add(it) }
      }
      emit(patch)
    } else if (message.id > (messages.lastOrNull()?.id ?: 0L)) {
      messages.add(message)
      layout(messages.size - 1).first?.let { patch.newest = listOf(it) }
      patch.own = own
      emit(patch)
      if (everything) emitChanged()
    } else {
      // Not the newest and not known: it belongs somewhere in the middle (rare — a merge after a reconnect).
      messages.add(message)
      messages.sortBy { it.id }
      emitReset()
    }
  }

  private fun remove(id: Long) {
    val at = index(id)
    if (at < 0) return
    messages.removeAt(at)
    layouts.remove(id)
    val patch = ChannelPatch()
    patch.removed = listOf(id)
    // The message after it has a new neighbour; the rows that answered it lose the quoted words.
    for (other in at until messages.size) {
      if (other != at && messages[other].replyTo != id) continue
      val made = layout(other)
      if (made.second) made.first?.let { patch.updated.add(it) }
    }
    emit(patch)
  }

  /** Asks the server what an invite link leads to, once per code; the rows that carry it are then made again. */
  private fun askInvite(code: String) {
    val ask = ask ?: return
    if (!askedInvites.add(code)) return
    ask("invite", listOf(code)) { result ->
      worker.execute {
        val preview = InvitePreview.from(result.getOrNull())
        context.invites[code] = if (preview != null) ChannelInviteCard.known(preview, code) else ChannelInviteCard.invalid(code)
        if (loaded) emitChanged()
      }
    }
  }

  companion object {
    /** The single worker of every channel's chat. */
    val shared: Executor = Executors.newSingleThreadExecutor { run -> Thread(run, "invizent.channel").apply { isDaemon = true } }
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
  }
}
