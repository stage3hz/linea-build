package com.linea.messenger.profile

import android.os.Handler
import android.os.Looper
import com.linea.messenger.app.Messenger
import com.linea.messenger.channels.uploadPlainFile
import com.linea.messenger.core.Core
import com.linea.messenger.net.Server
import com.linea.messenger.net.ServerError
import com.linea.messenger.people.Person
import com.linea.messenger.platina.PlatinaState
import com.linea.messenger.settings.accountCall
import com.linea.messenger.settings.keepOwnProfile
import java.util.concurrent.Executors

// The server calls of the profile screens, Platina and gifts (the reference's api.ts `profile`, `upload`,
// `changeStatusEmoji`, `profileGifts`, `sendGift`, `removeGift`; iOS Profile/ProfileServer.swift). Every answer comes
// back on the main thread.

private val main by lazy { Handler(Looper.getMainLooper()) }
private val uploads = Executors.newSingleThreadExecutor()

/** `PATCH /me` with some fields (null clears one); the fresh profile is kept and the screens are told. */
fun Messenger.patchOwnProfile(fields: Map<String, Any?>, done: (Result<Map<String, Any?>>) -> Unit) {
  accountCall("profile", listOf(fields)) { result ->
    val body = result.getOrNull() ?: return@accountCall done(Result.failure(Server.error(result)))
    val fresh = Core.map(body["user"]) ?: emptyMap()
    if (fresh.isNotEmpty()) keepOwnProfile(fresh)
    done(Result.success(fresh))
  }
}

/** Uploads a profile file (the avatar, a GIF, a video avatar, a banner: `POST /uploads`, no purpose — the small
 *  profile limits) and gives the server's `attachment`. The bytes are already cleaned by the caller. */
fun Messenger.uploadProfileFile(bytes: ByteArray, name: String, mimeType: String, done: (Result<Map<String, Any?>>) -> Unit) {
  val server = server
  uploads.execute {
    val result = try { server.uploadPlainFile(bytes, name, mimeType, null) } catch (_: Throwable) { Result.failure(ServerError.Network("Нет связи с сервером.")) }
    main.post { done(result) }
  }
}

/** The emoji status next to the name; null puts back the Platina gem (or removes the status). */
fun Messenger.changeStatusEmoji(emoji: String?, done: (Result<Map<String, Any?>>) -> Unit) {
  accountCall("changeStatusEmoji", listOf(emoji)) { result ->
    val body = result.getOrNull() ?: return@accountCall done(Result.failure(Server.error(result)))
    val fresh = Core.map(body["user"]) ?: emptyMap()
    val status = Core.map(body["status"]) ?: emptyMap()
    if (fresh["id"] as? String != userId || status["accountId"] as? String != userId) return@accountCall done(Result.failure(ServerError.Network("Сервер вернул настройки другого аккаунта.")))
    keepOwnProfile(fresh)
    PlatinaState.take(status)
    done(Result.success(body))
  }
}

fun Messenger.profileGifts(userId: String, done: (Result<Pair<Boolean, List<ProfileGift>>>) -> Unit) {
  accountCall("profileGifts", listOf(userId)) { result ->
    val body = result.getOrNull() ?: return@accountCall done(Result.failure(Server.error(result)))
    done(Result.success((body["visible"] as? Boolean ?: false) to ProfileGift.list(body["gifts"])))
  }
}

fun Messenger.sendGift(userId: String, gift: String, message: String, done: (ServerError?) -> Unit) {
  accountCall("sendGift", listOf(userId, gift, message)) { result -> done(if (result.isFailure) Server.error(result) else null) }
}

fun Messenger.removeGift(id: String, done: (ServerError?) -> Unit) {
  accountCall("removeGift", listOf(id)) { result -> done(if (result.isFailure) Server.error(result) else null) }
}

/** A gift on a profile (`ProfileGift` of the reference's api.ts). `sender` null when the sender is hidden. */
data class ProfileGift(val id: String, val gift: String, val message: String, val createdAt: String, val sender: Person?) {
  companion object {
    fun from(raw: Any?): ProfileGift? {
      val fields = Core.map(raw as? Map<*, *>) ?: return null
      val id = fields["id"] as? String ?: return null
      if (id.isEmpty()) return null
      return ProfileGift(id, fields["gift"] as? String ?: "", fields["message"] as? String ?: "", fields["createdAt"] as? String ?: "", Person.from(fields["sender"]))
    }

    fun list(raw: Any?): List<ProfileGift> = (raw as? List<*>).orEmpty().mapNotNull { from(it) }
  }
}

/** The gifts the server knows (server/src/cosmetics.js GIFTS, the reference's ProfilePosts.tsx GIFTS). */
object GiftCatalog {
  class Gift(val id: String, val emoji: String, val label: String, val colors: Pair<String, String>)

  val all = listOf(
    Gift("bear", "🧸", "Мишка", "#C98B5A" to "#7A4B2A"), Gift("rose", "🌹", "Роза", "#E0465E" to "#7C1730"),
    Gift("cake", "🎂", "Торт", "#F59BC0" to "#A64D79"), Gift("bouquet", "💐", "Букет", "#F7A8C4" to "#8C3D6B"),
    Gift("rocket", "🚀", "Ракета", "#5B7CFA" to "#20307A"), Gift("trophy", "🏆", "Кубок", "#F2C14E" to "#8A5A12"),
    Gift("diamond", "💎", "Бриллиант", "#7FD6F5" to "#2A6E9E"), Gift("champagne", "🍾", "Шампанское", "#B9D67A" to "#4E6B22"),
    Gift("present", "🎁", "Подарок", "#F26D6D" to "#8E2433"), Gift("ring", "💍", "Кольцо", "#D9D3F5" to "#6B5FA8"),
    Gift("unicorn", "🦄", "Единорог", "#D59BF6" to "#6A3C9E"), Gift("star", "⭐", "Звезда", "#FFD86B" to "#B5761B"),
    Gift("heart", "❤️", "Сердце", "#FF6B81" to "#9E1B3A"), Gift("crown", "👑", "Корона", "#F5CE5A" to "#7E5A10"),
    Gift("fire", "🔥", "Огонь", "#FF9A3D" to "#A1300F"), Gift("balloon", "🎈", "Шарик", "#FF7A7A" to "#A32F4C"),
  )

  fun gift(id: String): Gift = all.firstOrNull { it.id == id } ?: Gift(id, "🎁", "Подарок", "#8E8E93" to "#3A3A3C")
}
