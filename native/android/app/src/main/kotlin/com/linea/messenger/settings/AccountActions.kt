package com.linea.messenger.settings

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.auth.Account
import com.linea.messenger.chats.AvatarStore
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError

/** The window, as the settings see it: where they say that the account was left on this device. */
interface AccountHost {
  /** The account was left (signed out, a secret changed, the session ended, the account deleted). The session
   *  is already forgotten; signing in is shown, with a few words why (empty: none). */
  fun closeAccount(notice: String)
}

/** Told on the main thread when the account's own profile changed (a new name, colour, @username…). */
object OwnProfile {
  private val watchers = LinkedHashSet<() -> Unit>()
  fun watch(watcher: () -> Unit) { watchers.add(watcher) }
  fun unwatch(watcher: () -> Unit) { watchers.remove(watcher) }
  fun tell() { for (watcher in watchers.toList()) watcher() }
}

/** What the pages of the settings ask of the signed-in account. The app's own is `MessengerAccount`; the page
 *  tests give one of their own, so that no server is spoken to. Every `done` is called on the main thread; a
 *  failure is a `ServerError`. */
interface SettingsAccount {
  val userId: String
  /** The server's address (pictures of people are asked from it). */
  val base: String
  /** The account's profile as the server last gave it. */
  val ownProfile: Map<String, Any?>
  /** Keeps a fresh copy of the account's profile (the server's `user`) and tells the screens. */
  fun keepOwnProfile(fresh: Map<String, Any?>)
  /** A server operation whose answer is an object. */
  fun accountCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit)
  /** Asks the server for the profile again (it may have been changed on another device). */
  fun refreshOwnProfile()
  /** The headers a person's picture is asked with, if the list of chats has not set them yet. */
  fun prepareSettingsAvatars()
  /** «Выйти из аккаунта»: `done` gets the words for the sign-in screen (empty when all went well), or why leaving
   *  was not finished. */
  fun signOut(done: (Result<String>) -> Unit)
  /** The server has already ended this session: it is forgotten here. Returns the words for the sign-in screen. */
  fun sessionEndedHere(words: String): String
  /** «Уведомления и звуки»: the chats of the account, as the list of chats has them (none unless given). */
  fun chatList(done: (Result<List<Messenger.ChatSummary>>) -> Unit) { done(Result.success(emptyList())) }
  /** «Данные и память»: a GET whose answer is an object (not one of the named operations). */
  fun serverGet(path: String, done: (Result<Map<String, Any?>>) -> Unit) { done(Result.failure(ServerError.Network("Нет связи с сервером."))) }
  /** Profile: the account itself, for what goes beyond these calls (uploading a photo; profile/ProfilePhotoChange.kt). */
  val messenger: Messenger? get() = null
}

// What the settings ask of the signed-in account: its own profile, and leaving it.
//
// Leaving does what the previous app did (`logout` and `credentialsChanged` of `mobile/App.tsx`) and nothing
// more: the session's token and the kept copy of the profile are removed from this device. The encrypted
// storage and the keys of the conversations stay where they are.

private val mainThread by lazy { Handler(Looper.getMainLooper()) }

/** The account's profile as the server last gave it. */
val Messenger.ownProfile: Map<String, Any?>
  get() = Account.cachedUser?.takeIf { it["id"] as? String == userId } ?: user

/** Keeps a fresh copy of the account's profile (the server's `user`) and tells the screens. */
fun Messenger.keepOwnProfile(fresh: Map<String, Any?>) {
  if (fresh["id"] as? String != userId) return
  Account.cachedUser = fresh
  OwnProfile.tell()
}

/** A server operation whose answer is an object; `done` is called on the main thread. */
fun Messenger.accountCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
  server.op(name, args) { result ->
    mainThread.post {
      if (result.isSuccess) done(Result.success(Core.map(result.getOrNull()) ?: emptyMap())) else done(Result.failure(Server.error(result)))
    }
  }
}

/** Asks the server for the profile again (it may have been changed on another device). */
fun Messenger.refreshOwnProfile() {
  accountCall("me", emptyList()) { result ->
    Core.map(result.getOrNull()?.get("user"))?.let { keepOwnProfile(it) }
  }
}

/** The headers a person's picture is asked with, if the list of chats has not set them yet. */
fun Messenger.prepareSettingsAvatars() {
  if (AvatarStore.headers.isNotEmpty()) return
  val made = Core.prepare("GET", "/files/x", jsonBody = false, token = server.token, proof = server.currentProof) ?: return
  AvatarStore.headers = made.headers.reversed().toMap()
}

/** Removes the session from this device: the token, the kept profile, the headers pictures were asked with.
 *  False when the token could not be removed (then nothing else is touched), unless `anyway`. */
private fun Messenger.forgetSession(anyway: Boolean): Boolean {
  Account.token = null
  val gone = Account.token == null
  if (!gone && !anyway) return false
  Account.cachedUser = null
  server.token = null
  AvatarStore.headers = emptyMap()
  return gone
}

/** What the sign-in screen says after leaving, by how the server took the `logout`: nothing when it ended the
 *  session (or had ended it already: 401), else that only this device forgot it. */
fun signOutNotice(failure: ServerError?): String = when (failure) {
  null -> ""
  // 401: the session is already over on the server — exactly what was wanted.
  is ServerError.Refused -> if (failure.status != 401) "Выход выполнен на этом устройстве. Сервер не подтвердил отзыв удалённой сессии." else ""
  else -> "Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось."
}

/** «Выйти из аккаунта»: the server ends this session, then it is forgotten here. `done` (main thread) gets the
 *  words for the sign-in screen (empty when all went well), or why leaving was not finished. */
fun Messenger.signOut(done: (Result<String>) -> Unit) {
  // Push: this device stops receiving pushes first, while the session still works (push.ts `stopPush`).
  com.linea.messenger.push.Push.stop(this) { endSession(done) }
}

private fun Messenger.endSession(done: (Result<String>) -> Unit) {
  server.op("logout", emptyList()) { result ->
    mainThread.post {
      val notice = signOutNotice(if (result.isSuccess) null else Server.error(result))
      if (!forgetSession(anyway = false)) {
        done(Result.failure(ServerError.Network("Не удалось удалить сохранённую сессию с устройства. Выход не завершён. Попробуй ещё раз.")))
      } else {
        done(Result.success(notice))
      }
    }
  }
}

/** The server has already ended this session (a secret was changed, the session was ended from the list, the
 *  account was deleted): it is forgotten here. Returns the words for the sign-in screen. */
fun Messenger.sessionEndedHere(words: String): String =
  if (forgetSession(anyway = true)) words else "$words Сохранённую копию отозванной сессии не удалось удалить с устройства; сервер больше её не принимает."

/** The HTTP status of a refusal; 0 when the server did not answer. */
val Result<*>.refusalStatus: Int get() = (exceptionOrNull() as? ServerError.Refused)?.status ?: 0

/** The words of a failure for the person; `otherwise` when it has none. */
fun Result<*>.failureWords(otherwise: String): String = Server.error(this).words.ifEmpty { otherwise }

/** The signed-in account, as the pages of the settings ask it. */
class MessengerAccount(private val account: Messenger) : SettingsAccount {
  override val messenger: Messenger get() = account
  override val userId: String get() = messenger.userId
  override val base: String get() = messenger.server.endpoint
  override val ownProfile: Map<String, Any?> get() = messenger.ownProfile
  override fun keepOwnProfile(fresh: Map<String, Any?>) = messenger.keepOwnProfile(fresh)
  override fun accountCall(name: String, args: List<Any?>, done: (Result<Map<String, Any?>>) -> Unit) = messenger.accountCall(name, args, done)
  override fun refreshOwnProfile() = messenger.refreshOwnProfile()
  override fun prepareSettingsAvatars() = messenger.prepareSettingsAvatars()
  override fun signOut(done: (Result<String>) -> Unit) = messenger.signOut(done)
  override fun sessionEndedHere(words: String): String = messenger.sessionEndedHere(words)
  override fun chatList(done: (Result<List<Messenger.ChatSummary>>) -> Unit) = messenger.chats { result -> mainThread.post { done(result) } }
  override fun serverGet(path: String, done: (Result<Map<String, Any?>>) -> Unit) = messenger.server.send("GET", path) { result ->
    mainThread.post {
      val body = Core.map(result.getOrNull())
      done(if (body != null) Result.success(body) else Result.failure(if (result.isFailure) Server.error(result) else ServerError.Network("Не удалось выполнить запрос. Попробуй ещё раз.")))
    }
  }
}
