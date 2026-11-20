package com.linea.core.api

import com.linea.core.json.JsonObject
import com.linea.core.json.JsonValue
import com.linea.core.json.array
import com.linea.core.json.asObject
import com.linea.core.json.boolean
import com.linea.core.json.booleanOrNull
import com.linea.core.json.int
import com.linea.core.json.json
import com.linea.core.json.jsonObject
import com.linea.core.json.long
import com.linea.core.json.obj
import com.linea.core.json.requireObject
import com.linea.core.json.string
import com.linea.core.model.Chat
import com.linea.core.model.ClaimedBundle
import com.linea.core.model.CryptoDevice
import com.linea.core.model.DeviceSession
import com.linea.core.model.EncryptedMessage
import com.linea.core.model.Message
import com.linea.core.model.PublicBundle
import com.linea.core.model.Session
import com.linea.core.model.User
import com.linea.core.network.NetworkTier

/** The server's routes, typed. One instance per session token (or without one, before sign-in). */
class Api(runtime: ApiRuntime, base: String, token: String? = null) : ApiClient(runtime, base, token), CryptoTransport {

    // ---- account ----

    suspend fun me(): MeAnswer {
        val answer = get("/me")
        return MeAnswer(User.fromJson(answer.obj("user")), answer.booleanOrNull("securitySetupRequired") ?: false)
    }

    suspend fun login(username: String, password: String, confirmationWord: String): Session {
        val body = jsonObject("username" to username.json(), "password" to password.json(), "confirmationWord" to confirmationWord.json(), *runtime.device.loginFields().toTypedArray())
        val answer = post("/auth/login", body)
        return Session(answer.string("token"), User.fromJson(answer.obj("user")), answer.booleanOrNull("securitySetupRequired") ?: false)
    }

    suspend fun logout() {
        request("/auth/logout", "POST")
        token?.let(runtime::forgetProof)
    }

    /** Current device first; each with model, OS, app version and the sign-in address as text. */
    suspend fun sessions(): List<DeviceSession> = get("/auth/sessions").array("sessions").map { DeviceSession.fromJson(it.requireObject()) }

    suspend fun revokeSession(sessionId: String) { post("/auth/sessions/revoke", jsonObject("sessionId" to sessionId.json())) }

    suspend fun revokeOtherSessions() { post("/auth/sessions/revoke-others", JsonObject.EMPTY) }

    // ---- chats and messages ----

    suspend fun chats(): List<Chat> = get("/chats?lean=1").array("chats").map { Chat.fromJson(it.requireObject()) }

    /** A page of a chat's messages, newest last; [before] is the id of the oldest message already shown. */
    suspend fun messages(chatId: String, before: Long? = null): MessagesPage {
        val limit = when (runtime.quality.tier) { NetworkTier.SLOW -> 15; NetworkTier.MEDIUM -> 30; NetworkTier.FAST -> 50 }
        val older = if (before != null && before != 0L) "&before=$before" else ""
        val answer = get("/chats/${encodeUriComponent(chatId)}/messages?lean=1&limit=$limit$older")
        return MessagesPage(messagesOf(answer), answer.booleanOrNull("hasMore") ?: false)
    }

    // An older server refuses the `push` field: remembered for this client, the message then goes without it.
    @Volatile private var pushField = true

    /**
     * Sends an already encrypted message. The server drops duplicates by [clientId], so sending again is safe.
     * `lean=1`: the server does not echo our own (large) ciphertext back; it is put in from here.
     */
    suspend fun sendEncrypted(chatId: String, clientId: String, encrypted: EncryptedMessage, push: PushKind? = null): Message {
        val encryptedJson = encrypted.toJson()
        suspend fun send(kind: PushKind?): Message {
            val body = jsonObject("clientId" to clientId.json(), "encrypted" to encryptedJson, "push" to kind?.wire?.json())
            val message = Message.fromJson(post("/chats/${encodeUriComponent(chatId)}/messages?lean=1", body).obj("message"))
            return if (message.encrypted == null) message.copy(encrypted = encryptedJson) else message
        }
        if (push == null || !pushField) return send(null)
        try {
            return send(push)
        } catch (error: ApiError) {
            val unknownKind = error.status == 400 && error.message.orEmpty().contains("вид уведомления")
            return when {
                error.status == 400 && error.message.orEmpty().contains("неизвестные поля") -> { pushField = false; send(null) }
                // An older server knows no quiet push: the message still goes, with an ordinary notification.
                unknownKind && push == PushKind.SILENT -> send(null)
                // …and no «missed call» push: the end of the call goes as before, without a notification.
                unknownKind && push == PushKind.MISSED -> send(PushKind.NONE)
                else -> throw error
            }
        }
    }

    suspend fun read(chatId: String, messageId: Long): ReadAnswer {
        val answer = post("/chats/${encodeUriComponent(chatId)}/read", jsonObject("messageId" to messageId.json()))
        return ReadAnswer(answer.boolean("ok"), answer.long("lastReadMessageId"))
    }

    // ---- end-to-end encryption: public keys and the encrypted inbox ----

    override suspend fun registerCryptoDevice(deviceId: String, bundle: PublicBundle): RegisteredDevice {
        val fields = LinkedHashMap<String, JsonValue>()
        fields["deviceId"] = deviceId.json()
        fields["deviceName"] = runtime.device.deviceName.json()
        fields.putAll(bundle.toJson().fields)
        val answer = post("/e2ee/devices", JsonObject(fields))
        return RegisteredDevice(CryptoDevice.fromJson(answer.obj("device")), answer.int("preKeyCount"))
    }

    override suspend fun cryptoDevices(userId: String): List<CryptoDevice> = devicesOf(get("/e2ee/devices?userId=${encodeUriComponent(userId)}"))

    suspend fun ownCryptoDevices(): List<CryptoDevice> = devicesOf(get("/e2ee/devices/self"))

    override suspend fun claimPreKey(userId: String, deviceId: String): ClaimedPreKey {
        val answer = post("/e2ee/prekeys/claim", jsonObject("userId" to userId.json(), "deviceId" to deviceId.json()))
        return ClaimedPreKey(CryptoDevice.fromJson(answer.obj("device")), ClaimedBundle.fromJson(answer.obj("bundle")))
    }

    suspend fun revokeCryptoDevice(deviceId: String) { post("/e2ee/devices/revoke", jsonObject("deviceId" to deviceId.json())) }

    /** The device's encrypted inbox for a chat, straight from the server. */
    suspend fun inboxPage(deviceId: String, chatId: String, after: Long): InboxPage {
        val answer = get("/e2ee/inbox?lean=1&deviceId=${encodeUriComponent(deviceId)}&chatId=${encodeUriComponent(chatId)}&after=$after&limit=100")
        return InboxPage(messagesOf(answer), answer.long("nextCursor"), answer.boolean("hasMore"))
    }

    override suspend fun cryptoInbox(deviceId: String, chatId: String, after: Long): InboxPage = inboxPage(deviceId, chatId, after)

    private suspend fun get(path: String): JsonObject = request(path).requireObject()
    private suspend fun post(path: String, body: JsonValue): JsonObject = request(path, "POST", body).requireObject()
    private fun messagesOf(answer: JsonObject): List<Message> = answer.array("messages").map { Message.fromJson(it.requireObject()) }
    private fun devicesOf(answer: JsonObject): List<CryptoDevice> = answer.array("devices").map { CryptoDevice.fromJson(it.requireObject()) }
}
