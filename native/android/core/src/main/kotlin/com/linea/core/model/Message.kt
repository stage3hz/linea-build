package com.linea.core.model

import com.linea.core.json.JsonNull
import com.linea.core.json.JsonObject
import com.linea.core.json.JsonValue
import com.linea.core.json.asObject
import com.linea.core.json.booleanOrNull
import com.linea.core.json.intOrNull
import com.linea.core.json.long
import com.linea.core.json.longOrNull
import com.linea.core.json.string
import com.linea.core.json.stringOrNull

data class AttachmentMedia(val width: Int? = null, val height: Int? = null, val durationMs: Long? = null, val hdr: String? = null, val waveform: String? = null)

data class AttachmentPreview(val mimeType: String, val base64: String, val width: Int, val height: Int)

/** How a file is sealed. `chunkSize` is present only for the chunked scheme (big files). */
data class FileEncryption(val scheme: String, val key: String, val nonce: String, val fileKeyId: String, val chunkSize: Long? = null) {
    /** Holds the file key: never printed. */
    override fun toString(): String = "FileEncryption(scheme=$scheme, fileKeyId=$fileKeyId)"

    companion object {
        const val SINGLE = "aes-256-gcm-siv"
        const val CHUNKED = "aes-256-gcm-siv-chunked"
    }
}

data class Attachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val encryption: FileEncryption? = null,
    val media: AttachmentMedia? = null,
    val preview: AttachmentPreview? = null,
) {
    companion object {
        /** The attachment as the server lists it. Decrypted message bodies are checked strictly by the encryption core, not here. */
        fun fromJson(json: JsonObject): Attachment {
            val encryption = json["encryption"].asObject()
            val media = json["media"].asObject()
            val preview = json["preview"].asObject()
            return Attachment(
                id = json.string("id"),
                name = json.stringOrNull("name") ?: "",
                mimeType = json.stringOrNull("mimeType") ?: "",
                size = json.longOrNull("size") ?: 0,
                encryption = encryption?.let { FileEncryption(it.string("scheme"), it.string("key"), it.string("nonce"), it.string("fileKeyId"), it.longOrNull("chunkSize")) },
                media = media?.let { AttachmentMedia(it.intOrNull("width"), it.intOrNull("height"), it.longOrNull("durationMs"), it.stringOrNull("hdr"), it.stringOrNull("waveform")) },
                preview = preview?.let { AttachmentPreview(it.string("mimeType"), it.string("base64"), it.intOrNull("width") ?: 0, it.intOrNull("height") ?: 0) },
            )
        }
    }
}

enum class CryptoState { DECRYPTED, UNVERIFIED, NO_KEY, LEGACY, INVALID, FAILED }

data class Message(
    val id: Long,
    val chatId: String,
    val senderId: String,
    val clientId: String,
    /** Empty as the server sends it; the encryption core fills it in after decrypting. */
    val text: String = "",
    val attachment: Attachment? = null,
    val createdAt: String,
    /**
     * The encrypted message exactly as the server sent it. Kept as JSON on purpose: the encryption core refuses
     * a message with any unexpected field and hashes its canonical form, so nothing may be lost or reordered here.
     */
    val encrypted: JsonValue? = null,
    val legacy: Boolean = false,
    val cryptoState: CryptoState? = null,
    /** Decrypted extras (reply, reaction, edit…), as JSON until the screens that use them are built. */
    val meta: JsonValue? = null,
    /** Arrived over Mesh (Bluetooth); replaced by the server copy when the internet is back. */
    val mesh: Boolean = false,
    /** The server left the ciphertext out (lean lists): text comes from this device's decrypted cache. */
    val lean: Boolean = false,
) {
    companion object {
        fun fromJson(json: JsonObject) = Message(
            id = json.long("id"),
            chatId = json.string("chatId"),
            senderId = json.string("senderId"),
            clientId = json.string("clientId"),
            text = json.stringOrNull("text") ?: "",
            attachment = json["attachment"].asObject()?.let(Attachment::fromJson),
            createdAt = json.stringOrNull("createdAt") ?: "",
            encrypted = json["encrypted"]?.takeIf { it != JsonNull },
            legacy = json.booleanOrNull("legacy") ?: false,
            lean = json.booleanOrNull("lean") ?: false,
        )
    }
}

/** `mutedUntil` (ISO) comes only with a mute that ends; `muted` alone is «навсегда». */
data class ChatSettings(val pinnedAt: String?, val archived: Boolean, val muted: Boolean, val mutedUntil: String? = null)

data class Chat(
    val id: String,
    val peer: User,
    val lastMessage: Message?,
    val unreadCount: Int,
    val lastReadMessageId: Long,
    val peerLastReadMessageId: Long,
    val createdAt: String,
    val updatedAt: String,
    val settings: ChatSettings? = null,
) {
    companion object {
        fun fromJson(json: JsonObject): Chat {
            val settings = json["settings"].asObject()
            return Chat(
                id = json.string("id"),
                peer = User.fromJson(json["peer"].asObject() ?: throw com.linea.core.json.MalformedResponseException("The chat has no peer.")),
                lastMessage = json["lastMessage"].asObject()?.let(Message::fromJson),
                unreadCount = json.intOrNull("unreadCount") ?: 0,
                lastReadMessageId = json.longOrNull("lastReadMessageId") ?: 0,
                peerLastReadMessageId = json.longOrNull("peerLastReadMessageId") ?: 0,
                createdAt = json.stringOrNull("createdAt") ?: "",
                updatedAt = json.stringOrNull("updatedAt") ?: "",
                settings = settings?.let { ChatSettings(it.stringOrNull("pinnedAt"), it.booleanOrNull("archived") ?: false, it.booleanOrNull("muted") ?: false, it.stringOrNull("mutedUntil")) },
            )
        }
    }
}

