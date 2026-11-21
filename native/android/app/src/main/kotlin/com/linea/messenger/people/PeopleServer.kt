package com.linea.messenger.people

import android.os.Handler
import android.os.Looper
import android.view.View
import com.linea.messenger.app.Messenger
import com.linea.messenger.chat.ChatScreen
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.core.Core
import com.linea.messenger.net.Live
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.shell.Navigation
import java.lang.ref.WeakReference

/** What a person's profile says about them and this account (`UserProfile` of the reference's types.ts). */
class PersonProfile(
  val person: Person,
  val isFriend: Boolean,
  /** "incoming", "outgoing" or null. */
  val request: String?,
  val chatId: String?,
  val blocked: Boolean,
)

/** A chat opened with a person: what `ChatScreen` needs. */
class PersonChat(val chatId: String, val peerId: String, val name: String, val peerLastRead: Long)

private val main = Handler(Looper.getMainLooper())

/** The stack of pages a view stands in (every page of the app is somewhere inside it). */
fun View.pages(): Navigation? {
  var above = parent
  while (above != null) {
    if (above is Navigation) return above
    above = above.parent
  }
  return null
}

// The server calls of «Люди» and of a person's profile. Every answer comes back on the main thread.

private fun Messenger.peopleCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
  server.op(name, args) { result ->
    main.post { done(if (result.isSuccess) Result.success(Core.map(result.getOrNull()) ?: emptyMap()) else Result.failure(Server.error(result))) }
  }
}

private fun Messenger.peopleDone(name: String, args: List<Any?>, done: (ServerError?) -> Unit) {
  peopleCall(name, args) { result -> done(if (result.isSuccess) null else Server.error(result)) }
}

/** The address of a person's picture (pictures are fetched as this session: see `preparePersonAvatars`). */
fun Messenger.personAvatarAddress(avatarId: String): String =
  if (avatarId.isEmpty()) "" else server.endpoint + "/files/" + Messenger.pathPart(avatarId)

/** The headers pictures of people are asked with. Main thread only. */
fun Messenger.preparePersonAvatars() {
  val made = Core.prepare("GET", "/files/x", jsonBody = false, token = server.token, proof = server.currentProof) ?: return
  AvatarStore.headers = made.headers.reversed().toMap()
}

/** The friends of this account, by name. */
fun Messenger.friends(done: (Result<List<Person>>) -> Unit) {
  peopleCall("contacts", emptyList()) { result -> done(result.map { Person.list(it["users"]) }) }
}

class FriendRequestLists(val incoming: List<Person>, val outgoing: List<Person>)

/** Requests to be friends: those that came and those this account sent. */
fun Messenger.friendRequests(done: (Result<FriendRequestLists>) -> Unit) {
  peopleCall("friendRequests", emptyList()) { result -> done(result.map { FriendRequestLists(Person.requests(it["incoming"]), Person.requests(it["outgoing"])) }) }
}

/** People by @username or name. */
fun Messenger.findPeople(query: String, done: (Result<List<Person>>) -> Unit) {
  peopleCall("users", listOf(query)) { result -> done(result.map { Person.list(it["users"]) }) }
}

fun Messenger.personProfile(userId: String, done: (Result<PersonProfile>) -> Unit) {
  peopleCall("userProfile", listOf(userId)) { result ->
    val body = result.getOrNull() ?: return@peopleCall done(Result.failure(Server.error(result)))
    done(PeopleRules.profile(body)?.let { Result.success(it) } ?: Result.failure(ServerError.Network("Не удалось загрузить профиль.")))
  }
}

/** «В друзья»: sends a request, or accepts the one the other person already sent. True when they are friends now. */
fun Messenger.addFriend(userId: String, done: (Result<Boolean>) -> Unit) {
  peopleCall("addContact", listOf(userId)) { result -> done(result.map { it["status"] as? String != "requested" }) }
}

fun Messenger.acceptFriend(userId: String, done: (ServerError?) -> Unit) = peopleDone("acceptFriend", listOf(userId), done)

/** Declines a request that came, or takes back one this account sent. */
fun Messenger.dropFriendRequest(userId: String, done: (ServerError?) -> Unit) = peopleDone("dropFriendRequest", listOf(userId), done)

fun Messenger.removeFriend(userId: String, done: (ServerError?) -> Unit) = peopleDone("removeContact", listOf(userId), done)

fun Messenger.setPersonBlocked(userId: String, blocked: Boolean, done: (ServerError?) -> Unit) =
  peopleDone(if (blocked) "block" else "unblock", listOf(userId), done)

/** A complaint about a person; `reason` is one of the reference's `ReportReason`. */
fun Messenger.reportPerson(userId: String, reason: String, done: (ServerError?) -> Unit) =
  peopleDone("report", listOf(mapOf("userId" to userId), reason), done)

/** The chat with a person: the one there is, or a new one. */
fun Messenger.chatWith(userId: String, done: (Result<PersonChat>) -> Unit) {
  peopleCall("createChat", listOf(userId)) { result ->
    val body = result.getOrNull() ?: return@peopleCall done(Result.failure(Server.error(result)))
    done(PeopleRules.chat(body, userId)?.let { Result.success(it) } ?: Result.failure(ServerError.Network("Не удалось создать чат.")))
  }
}

/** Opens the chat with a person on top of the page `from` stands in. */
fun Messenger.openChat(person: Person, from: View, done: (ServerError?) -> Unit) {
  val messenger = this
  val origin = WeakReference(from)
  chatWith(person.id) { result ->
    val chat = result.getOrNull() ?: return@chatWith done(Server.error(result))
    done(null)
    val view = origin.get() ?: return@chatWith
    val stack = view.pages() ?: return@chatWith
    stack.push(ChatScreen(view.context, chat.name.ifEmpty { person.displayName }, messenger, chat.chatId, chat.peerId, chat.peerLastRead) { stack.pop() })
  }
}

/** What the answers of the server mean: plain functions, so they can be checked without a phone. */
object PeopleRules {
  /** The answer of `userProfile`; null when it names no person. */
  fun profile(body: Map<String, Any?>): PersonProfile? {
    val person = Person.from(body["user"]) ?: return null
    val request = body["friendRequest"] as? String
    return PersonProfile(person, body["isContact"] as? Boolean ?: false, request.takeIf { it == "incoming" || it == "outgoing" }, body["chatId"] as? String, body["blocked"] as? Boolean ?: false)
  }

  /** The answer of `createChat`; null when it has no chat. */
  fun chat(body: Map<String, Any?>, userId: String): PersonChat? {
    val chat = Core.map(body["chat"]) ?: return null
    val chatId = chat["id"] as? String ?: return null
    val peer = Core.map(chat["peer"])
    return PersonChat(chatId, peer?.get("id") as? String ?: userId, peer?.get("displayName") as? String ?: "", (chat["peerLastReadMessageId"] as? Number)?.toLong() ?: 0L)
  }
}

/** The requests to be friends, shared by the «Люди» section, its badge in the list of sections and profiles
 *  (the reference's friendRequests.ts). Read at the start, on every «friends» event of the live line and after
 *  the account's own actions. Main thread only. */
object FriendRequests {
  /** Posted on the main thread when the lists were read again. */
  val changed = Live.Signal<Unit>()

  var incoming: List<Person> = emptyList()
    private set
  var outgoing: List<Person> = emptyList()
    private set
  private var messenger = WeakReference<Messenger>(null)
  private var running = false
  private var again = false

  init { Live.friendsChanged.watch { refresh() } }

  /** The account whose requests these are; another account starts from nothing. */
  fun start(messenger: Messenger?) {
    if (this.messenger.get() !== messenger) {
      this.messenger = WeakReference(messenger)
      incoming = emptyList()
      outgoing = emptyList()
      running = false
      again = false
      changed.post(Unit)
    }
    refresh()
  }

  /** Reads the lists again; several calls at once are one request and one more after it. */
  fun refresh() {
    val messenger = messenger.get() ?: return
    if (running) { again = true; return }
    running = true
    messenger.friendRequests { result ->
      if (this.messenger.get() !== messenger) return@friendRequests
      running = false
      result.getOrNull()?.let { lists ->
        incoming = lists.incoming
        outgoing = lists.outgoing
        changed.post(Unit)
      }
      if (again) { again = false; refresh() }
    }
  }
}
